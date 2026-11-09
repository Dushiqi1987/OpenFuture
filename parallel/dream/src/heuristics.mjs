/**
 * Deterministic local model stand-in used by the prototype and by tests.
 *
 * This is deliberately NOT an LLM: it recognises a small set of memory-bearing
 * sentence forms, so the whole five-phase loop can be exercised offline with
 * synthetic data and a fake credential. The interfaces (`extract`,
 * `adjudicate`, `health`) match the HTTP model contract in model-client.mjs;
 * a real provider can replace this class without touching the pipeline.
 */

import { contentHash, normalizeKey, normalizeSpace, shortId } from './util.mjs'
import { detectInjection } from './evidence.mjs'

const PATTERNS = [
  {
    type: 'correction',
    re: /^correction:\s*(.+?)\s+should be\s+(.+?),\s*not\s+(.+?)[.!]?$/i,
    map: (match) => ({ subject: match[1], value: match[2], previousValue: match[3] })
  },
  {
    type: 'decision',
    re: /^(?:we\s+)?decided (?:that )?(.+?)\s+(?:is|will be|shall be)\s+(.+?)[.!]?$/i,
    map: (match) => ({ subject: match[1], value: match[2] })
  },
  {
    type: 'preference',
    re: /^i prefer\s+(.+?)\s+to be\s+(?:in\s+)?(.+?)[.!]?$/i,
    map: (match) => ({ subject: match[1], value: match[2] })
  },
  {
    type: 'fact',
    re: /^i'?ll remember (?:that )?(.+?)\s*(?:=|is)\s*(.+?)[.!]?$/i,
    map: (match) => ({ subject: match[1], value: match[2] })
  },
  {
    type: 'open-question',
    re: /^open question:\s*(.+?)[.!]?$/i,
    map: (match) => ({ subject: match[1], value: match[1] })
  }
]

const TOOL_PATTERN = /^check result:\s*(.+?)\s*=\s*(.+?)[.!]?$/i

function cleanValue(value) {
  return normalizeSpace(value).replace(/^["'“”]+|["'“”]+$/g, '').replace(/[.。!！]+$/g, '')
}

/** @param {{text:string, role:string, speaker?:string|null}} message */
export function parseMemorySentence(text, role) {
  const value = normalizeSpace(text)
  if (role === 'tool') {
    const match = TOOL_PATTERN.exec(value)
    if (!match) return null
    return { type: 'fact', subject: cleanValue(match[1]), value: cleanValue(match[2]) }
  }
  if (role !== 'user') return null
  for (const pattern of PATTERNS) {
    const match = pattern.re.exec(value)
    if (!match) continue
    const parsed = pattern.map(match)
    const result = { type: pattern.type, subject: cleanValue(parsed.subject), value: cleanValue(parsed.value) }
    if (parsed.previousValue) result.previousValue = cleanValue(parsed.previousValue)
    return result
  }
  return null
}

export function basisForRoles(roles) {
  if (roles.includes('user')) return 'user-confirmed'
  if (roles.includes('tool')) return 'tool-result'
  return 'model-statement'
}

/**
 * Extract candidate memories from evidence records.
 * @param {any[]} evidence
 * @param {{projectId:string}} options
 */
export function extractCandidates(evidence, { projectId }) {
  const candidates = []
  for (const record of evidence) {
    if (record.projectId !== projectId) continue
    if (record.quarantined) continue
    if (record.sourceKind !== 'session') continue
    if (!['user', 'tool'].includes(record.role)) continue
    const parsed = parseMemorySentence(record.text, record.role)
    if (!parsed) continue
    const subjectKey = normalizeKey(parsed.subject)
    if (subjectKey.length === 0 || subjectKey.length > 160) continue
    if (detectInjection(parsed.subject).length > 0 || detectInjection(parsed.value).length > 0) continue
    candidates.push({
      type: parsed.type,
      subject: parsed.subject,
      subjectKey,
      value: parsed.value,
      previousValue: parsed.previousValue ?? null,
      basis: basisForRoles([record.role]),
      sessionId: record.sessionId,
      confidence: record.role === 'user' ? 0.82 : 0.65,
      evidenceIds: [record.evidenceId],
      messageId: record.messageId,
      at: record.timestamp ?? record.createdAt
    })
  }
  return { candidates, notes: [] }
}

function entryKey(entry) {
  return normalizeKey(entry.subject ?? entry.title ?? '')
}

/**
 * Suggest structured ops mirroring the validation contract. The pipeline never
 * trusts these ops: they are re-validated against the evidence registry and the
 * current version before they can enter a plan.
 */
export function adjudicateCandidates({ projectId, candidates, entries, conflicts }) {
  const ops = []
  const notes = []
  const bySubject = new Map()
  for (const entry of entries) {
    const key = entryKey(entry)
    if (!bySubject.has(key)) bySubject.set(key, [])
    bySubject.get(key).push(entry)
  }
  const conflictBySubject = new Map()
  for (const conflict of conflicts) conflictBySubject.set(conflict.subjectKey, conflict)
  const handledSubjects = new Set()

  // A resolved correction must win even when the losing candidate happens to be
  // visited first (candidates are ordered by id, not by time). Without this
  // pre-pass the "target value already equals this candidate" keep branch could
  // reinforce the superseded value.
  for (const conflict of conflicts) {
    if (conflict.status !== 'resolved-by-correction') continue
    const existing = bySubject.get(conflict.subjectKey) ?? []
    if (existing.length === 0) continue
    const target = existing[0]
    if (normalizeKey(target.value) === normalizeKey(conflict.resolvedValue)) continue
    const resolutionEvidenceIds = [...new Set(conflict.resolution?.evidenceIds ?? [])].filter(Boolean).sort()
    if (resolutionEvidenceIds.length === 0) continue
    const conflictEvidenceIds = [...new Set(conflict.sides.flatMap((side) => side.evidenceIds))].filter(Boolean)
    ops.push({
      type: 'fix',
      targetIds: [target.id],
      evidenceIds: [...new Set([...conflictEvidenceIds, ...resolutionEvidenceIds])].sort(),
      confidence: 0.9,
      reason: 'A correction resolves a conflicting preference; both sides are retained as provenance',
      expectedRevision: target.revision,
      payload: { subject: target.subject, value: conflict.resolvedValue, title: target.title ?? target.subject },
      meta: {
        conflictIds: [conflict.id],
        assertionEvidenceIds: resolutionEvidenceIds
      }
    })
    handledSubjects.add(conflict.subjectKey)
  }

  for (const rawCandidate of candidates) {
    const candidate = {
      ...rawCandidate,
      subjectKey: rawCandidate.subjectKey ?? normalizeKey(rawCandidate.subject)
    }
    if (handledSubjects.has(candidate.subjectKey)) continue
    const existing = bySubject.get(candidate.subjectKey) ?? []
    const conflict = conflictBySubject.get(candidate.subjectKey)
    const conflictEvidenceIds = conflict
      ? [...new Set(conflict.sides.flatMap((side) => side.evidenceIds))]
      : []
    const evidenceIds = [...new Set([...(candidate.evidenceIds ?? []), ...conflictEvidenceIds])].sort()
    // When a correction resolves the conflict, the correction evidence is what
    // asserts the chosen value. The candidate that merely lost the conflict must
    // not become the assertion for the winning value.
    const resolutionEvidenceIds =
      conflict?.status === 'resolved-by-correction'
        ? [...new Set(conflict.resolution?.evidenceIds ?? [])].sort()
        : null
    const assertionEvidenceIds =
      resolutionEvidenceIds && resolutionEvidenceIds.length > 0
        ? resolutionEvidenceIds
        : [...new Set(candidate.evidenceIds ?? [])].sort()
    const base = {
      evidenceIds,
      confidence: candidate.confidence,
      reason: `Detected ${candidate.type} in an authorized completed session`,
      meta: conflict
        ? {
            conflictIds: [conflict.id],
            // The whole conflict stays as provenance; only valid evidence asserts the value.
            assertionEvidenceIds
          }
        : {}
    }

    if (existing.length === 0) {
      const chosenValue =
        conflict?.status === 'resolved-by-correction' ? conflict.resolvedValue : candidate.value
      ops.push({
        ...base,
        type: 'promote',
        targetIds: [],
        payload: {
          type: candidate.type === 'correction' ? 'preference' : candidate.type,
          subject: candidate.subject,
          value: chosenValue,
          title: candidate.subject,
          body: `${candidate.subject}: ${chosenValue}`,
          promoted: candidate.type !== 'open-question'
        }
      })
      handledSubjects.add(candidate.subjectKey)
      continue
    }

    const target = existing[0]
    if (
      conflict?.status === 'resolved-by-correction' &&
      normalizeKey(target.value) === normalizeKey(conflict.resolvedValue)
    ) {
      ops.push({
        ...base,
        type: 'keep',
        targetIds: [target.id],
        expectedRevision: target.revision,
        meta: {
          ...base.meta,
          reinforce: true,
          assertionEvidenceIds: [...new Set(conflict.resolution?.evidenceIds ?? [])].sort()
        }
      })
      handledSubjects.add(candidate.subjectKey)
      continue
    }
    if (candidate.type === 'correction') {
      const matchesPrior = candidate.previousValue
        ? normalizeKey(candidate.previousValue) === normalizeKey(target.value)
        : true
      if (!matchesPrior) {
        notes.push({
          code: 'CORRECTION_TARGET_MISMATCH',
          subject: candidate.subject,
          expected: target.value,
          claimed: candidate.previousValue
        })
        continue
      }
      ops.push({
        ...base,
        type: 'fix',
        targetIds: [target.id],
        expectedRevision: target.revision,
        payload: { subject: candidate.subject, value: candidate.value, title: target.title ?? candidate.subject },
        meta: {
          correctionOf: target.value,
          conflictIds: conflict ? [conflict.id] : [],
          assertionEvidenceIds: [...new Set(candidate.evidenceIds ?? [])].sort()
        }
      })
      handledSubjects.add(candidate.subjectKey)
      continue
    }

    if (normalizeKey(target.value) === normalizeKey(candidate.value)) {
      ops.push({
        ...base,
        type: 'keep',
        targetIds: [target.id],
        expectedRevision: target.revision,
        meta: { reinforce: true, ...(conflict ? { conflictIds: [conflict.id] } : {}) }
      })
      handledSubjects.add(candidate.subjectKey)
      continue
    }

    if (conflict) {
      const chosenValue =
        conflict.status === 'resolved-by-correction' ? conflict.resolvedValue : candidate.value
      ops.push({
        ...base,
        type: 'fix',
        targetIds: [target.id],
        expectedRevision: target.revision,
        payload: { subject: candidate.subject, value: chosenValue },
        meta: { conflictIds: [conflict.id], assertionEvidenceIds }
      })
      handledSubjects.add(candidate.subjectKey)
      continue
    }

    ops.push({
      ...base,
      type: 'fix',
      targetIds: [target.id],
      expectedRevision: target.revision,
      payload: { subject: candidate.subject, value: candidate.value }
    })
    handledSubjects.add(candidate.subjectKey)
  }

  return { ops, notes }
}

export class HeuristicModel {
  constructor({ name = 'heuristic-local', degraded = false } = {}) {
    this.name = name
    this.degraded = degraded
  }

  async health() {
    return { ok: true, provider: this.name, degraded: this.degraded }
  }

  async extract({ projectId, evidence }) {
    return extractCandidates(evidence, { projectId })
  }

  async adjudicate({ projectId, candidates, entries, conflicts }) {
    return adjudicateCandidates({ projectId, candidates, entries, conflicts })
  }
}

/** Candidate id is content-addressed so repeated runs produce stable plans. */
export function candidateId(candidate) {
  return shortId('cand', {
    type: candidate.type,
    subjectKey: normalizeKey(candidate.subject),
    valueKey: normalizeKey(candidate.value),
    previousValueKey: candidate.previousValue ? normalizeKey(candidate.previousValue) : null,
    evidenceIds: [...candidate.evidenceIds].sort(),
    sessionId: candidate.sessionId
  })
}

export function candidateDigest(candidates) {
  return contentHash(
    candidates.map((candidate) => ({
      id: candidate.id,
      type: candidate.type,
      subject: candidate.subject,
      value: candidate.value,
      previousValue: candidate.previousValue ?? null,
      evidenceIds: [...candidate.evidenceIds].sort()
    }))
  )
}
