/**
 * Phase 2: Light — validate candidate memories returned by the model.
 *
 * Nothing the model says is trusted. Each candidate must cite evidence ids that
 * exist in the project registry, belong to an authorized completed source, are
 * not quarantined as injected content, have not been revoked or superseded, and
 * support the claimed basis. Fabricated ids, stale revisions, revoked evidence,
 * cross-session blends and instruction-like content are rejected individually;
 * the rest of the batch continues.
 */

import { DreamError } from './errors.mjs'
import { toEvidenceRef } from './evidence.mjs'
import { detectInjection } from './evidence.mjs'
import { candidateId } from './heuristics.mjs'
import { basisFromRefs } from './l1.mjs'
import { normalizeKey, normalizeSpace, sortByKey } from './util.mjs'

export const CANDIDATE_TYPES = ['preference', 'decision', 'correction', 'fact', 'rule', 'lesson', 'open-question']

function timestampOf(record) {
  if (typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)) return record.timestamp
  if (typeof record.timestamp === 'string') {
    const parsed = Date.parse(record.timestamp)
    if (Number.isFinite(parsed)) return parsed
  }
  return record.createdAt ?? 0
}

function reject(index, raw, code, message, details) {
  return {
    index,
    code,
    message,
    candidate: {
      type: raw?.type ?? null,
      subject: typeof raw?.subject === 'string' ? raw.subject.slice(0, 120) : null,
      evidenceIds: Array.isArray(raw?.evidenceIds) ? raw.evidenceIds.slice(0, 8) : []
    },
    details: details ?? null
  }
}

/**
 * @param {{projectId:string, registry:any, rawCandidates:any[], now?:number}} input
 */
export function validateCandidates({ projectId, registry, rawCandidates, now = Date.now() }) {
  if (!Array.isArray(rawCandidates)) {
    throw new DreamError('MODEL_OUTPUT_INVALID', 'candidates must be an array')
  }
  const candidates = []
  const rejected = []
  const merged = new Map()

  rawCandidates.forEach((raw, index) => {
    try {
      if (!raw || typeof raw !== 'object') {
        rejected.push(reject(index, raw, 'CANDIDATE_INVALID', 'Candidate must be an object'))
        return
      }
      const type = String(raw.type ?? '')
      if (!CANDIDATE_TYPES.includes(type)) {
        rejected.push(reject(index, raw, 'CANDIDATE_INVALID', `Unsupported candidate type: ${type}`))
        return
      }
      if (typeof raw.subject !== 'string' || normalizeSpace(raw.subject).length === 0) {
        rejected.push(reject(index, raw, 'CANDIDATE_INVALID', 'Candidate subject is required'))
        return
      }
      if (typeof raw.value !== 'string' || normalizeSpace(raw.value).length === 0) {
        rejected.push(reject(index, raw, 'CANDIDATE_INVALID', 'Candidate value is required'))
        return
      }
      const subject = normalizeSpace(raw.subject)
      const value = normalizeSpace(raw.value)
      const previousValue =
        typeof raw.previousValue === 'string' && normalizeSpace(raw.previousValue).length > 0
          ? normalizeSpace(raw.previousValue)
          : null
      if (subject.length > 200 || value.length > 2000) {
        rejected.push(reject(index, raw, 'CANDIDATE_INVALID', 'Candidate text is too long'))
        return
      }
      if (type === 'correction' && !previousValue) {
        rejected.push(reject(index, raw, 'CANDIDATE_INVALID', 'Corrections must name the previous value'))
        return
      }
      if (detectInjection(`${subject}\n${value}\n${previousValue ?? ''}`).length > 0) {
        rejected.push(reject(index, raw, 'INJECTION_BLOCKED', 'Candidate text looks like an instruction'))
        return
      }
      const evidenceIds = Array.isArray(raw.evidenceIds)
        ? [...new Set(raw.evidenceIds.filter((id) => typeof id === 'string' && id.length > 0))]
        : []
      if (evidenceIds.length === 0) {
        rejected.push(reject(index, raw, 'EVIDENCE_UNKNOWN', 'Candidate cites no evidence'))
        return
      }
      const refs = []
      for (const evidenceId of evidenceIds) {
        const record = registry.getEvidence(evidenceId)
        if (!record) {
          rejected.push(reject(index, raw, 'EVIDENCE_UNKNOWN', `Fabricated evidence id: ${evidenceId}`))
          return
        }
        if (record.projectId !== projectId) {
          rejected.push(reject(index, raw, 'PROJECT_MISMATCH', 'Evidence belongs to another project'))
          return
        }
        const check = registry.verifyRef(toEvidenceRef(record), { requireQuote: true })
        if (!check.ok) {
          rejected.push(reject(index, raw, check.code, check.message))
          return
        }
        if (record.quarantined || record.injectionFlags?.length > 0) {
          rejected.push(
            reject(index, raw, 'INJECTION_BLOCKED', 'Evidence contains instruction-like content', {
              evidenceId
            })
          )
          return
        }
        refs.push(toEvidenceRef(record))
      }

      const sessionIds = [...new Set(refs.map((ref) => registry.getEvidence(ref.evidenceId)?.sessionId).filter(Boolean))]
      if (sessionIds.length > 1) {
        rejected.push(
          reject(index, raw, 'CANDIDATE_INVALID', 'One candidate cannot blend evidence across sessions', {
            sessionIds
          })
        )
        return
      }
      const sessionId = sessionIds[0] ?? null
      if (raw.sessionId && sessionId && raw.sessionId !== sessionId) {
        rejected.push(reject(index, raw, 'CANDIDATE_INVALID', 'Candidate session does not match evidence'))
        return
      }
      const basis = basisFromRefs(registry, refs)
      if (raw.basis && raw.basis !== basis) {
        rejected.push(
          reject(index, raw, 'EVIDENCE_BASIS_MISMATCH', `Claimed basis ${raw.basis} but evidence is ${basis}`, {
            claimed: raw.basis,
            actual: basis
          })
        )
        return
      }
      const timestamps = refs.map((ref) => timestampOf(registry.getEvidence(ref.evidenceId))).filter((at) => at > 0)
      const confidence =
        typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
          ? Math.min(1, Math.max(0, raw.confidence))
          : basis === 'user-confirmed'
            ? 0.8
            : basis === 'tool-result'
              ? 0.6
              : 0.3
      const candidate = {
        projectId,
        type,
        subject,
        subjectKey: normalizeKey(subject),
        value,
        previousValue,
        basis,
        confidence,
        sessionId,
        messageId: registry.getEvidence(refs[0].evidenceId)?.messageId ?? null,
        evidenceIds: refs.map((ref) => ref.evidenceId).sort(),
        evidenceRefs: refs.sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : 1)),
        at: timestamps.length ? Math.max(...timestamps) : now,
        counterexample: raw.counterexample === true,
        notes: Array.isArray(raw.notes) ? raw.notes.slice(0, 5).map(String) : [],
        id: null
      }
      candidate.id = candidateId(candidate)
      const mergeKey = [type, candidate.subjectKey, normalizeKey(value), previousValue ? normalizeKey(previousValue) : '', sessionId ?? ''].join('|')
      const prior = merged.get(mergeKey)
      if (prior) {
        const priorIds = new Set(prior.evidenceIds)
        for (const ref of candidate.evidenceRefs) {
          if (!priorIds.has(ref.evidenceId)) {
            prior.evidenceRefs.push(ref)
            prior.evidenceIds.push(ref.evidenceId)
          }
        }
        prior.evidenceIds.sort()
        prior.evidenceRefs.sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : 1))
        prior.confidence = Math.max(prior.confidence, candidate.confidence)
        prior.id = candidateId(prior)
        return
      }
      merged.set(mergeKey, candidate)
      candidates.push(candidate)
    } catch (error) {
      if (error instanceof DreamError) {
        rejected.push(reject(index, raw, error.code, error.message, error.details))
      } else {
        rejected.push(reject(index, raw, 'CANDIDATE_INVALID', 'Candidate could not be validated'))
      }
    }
  })

  return {
    projectId,
    candidates: sortByKey(candidates, (candidate) => `${candidate.subjectKey}:${candidate.id}`),
    rejected,
    stats: {
      received: rawCandidates.length,
      accepted: candidates.length,
      rejected: rejected.length
    }
  }
}
