/**
 * Verify: read-side consistency checks for a published version.
 *
 * Two uses:
 *  - post-publish, immediately after a commit (must be clean);
 *  - on demand, after revocations/rollbacks (may report invalidated entries,
 *    but must never report a revoked fact as readable).
 *
 * Answers/citations are checked against the freshly filtered entries, not
 * against the stored L3 snapshot.
 */

import { DreamError } from './errors.mjs'
import { detectInjection } from './evidence.mjs'
import { NOTE_TYPES, readEntries } from './l1.mjs'
import { renderL3, validateBudget } from './l3.mjs'
import { normalizeKey, normalizeSpace } from './util.mjs'

const SEVERITY = { error: 'error', warning: 'warning' }

function refLabel(ref) {
  return `${ref.sourceId}@${ref.sourceRevision}/${ref.evidenceId}`
}

/**
 * @param {{projectId:string, registry:any, version:any, budget?:any}} input
 */
export function verifyPublishedVersion({ projectId, registry, version, budget = {} }) {
  if (!projectId) throw new DreamError('VALIDATION', 'verifyPublishedVersion needs projectId')
  if (!version) throw new DreamError('VALIDATION', 'verifyPublishedVersion needs a version')
  if (version.projectId !== projectId) {
    throw new DreamError('PROJECT_MISMATCH', 'Version belongs to another project')
  }
  const issues = []
  const warnings = []
  const invalidated = []
  const budgetValue = validateBudget(budget)

  const readable = readEntries(registry, version.entries ?? [], { projectId })
  const readableById = new Map(readable.entries.map((entry) => [entry.id, entry]))
  const ids = new Set()
  const seenSubjects = new Map()
  const seenSignatures = new Map()

  for (const entry of version.entries ?? []) {
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      issues.push({ code: 'ENTRY_ID_INVALID', severity: SEVERITY.error, message: 'Entry has no id' })
      continue
    }
    if (ids.has(entry.id)) {
      issues.push({ code: 'DUPLICATE_ENTRY', severity: SEVERITY.error, entryId: entry.id, message: 'Duplicate entry id' })
    }
    ids.add(entry.id)
    if (!NOTE_TYPES.includes(entry.type)) {
      issues.push({ code: 'ENTRY_TYPE_INVALID', severity: SEVERITY.error, entryId: entry.id, message: `Unknown type ${entry.type}` })
    }
    if (!Number.isInteger(entry.revision) || entry.revision < 1) {
      issues.push({ code: 'ENTRY_REVISION_INVALID', severity: SEVERITY.error, entryId: entry.id, message: 'Revision must be a positive integer' })
    }
    if (typeof entry.subject !== 'string' || entry.subject.trim().length === 0) {
      issues.push({ code: 'ENTRY_SUBJECT_INVALID', severity: SEVERITY.error, entryId: entry.id, message: 'Subject is empty' })
    }
    if (typeof entry.value !== 'string' || entry.value.trim().length === 0) {
      issues.push({ code: 'ENTRY_VALUE_INVALID', severity: SEVERITY.error, entryId: entry.id, message: 'Value is empty' })
    }
    const injection = detectInjection(`${entry.subject ?? ''} ${entry.value ?? ''}`)
    if (injection.length > 0) {
      issues.push({
        code: 'INJECTION_BLOCKED',
        severity: SEVERITY.error,
        entryId: entry.id,
        message: 'Entry contains instruction-like content',
        details: injection
      })
    }

    const subjectKey = normalizeKey(entry.subject)
    if (subjectKey) {
      const signature = `${subjectKey}\u0000${normalizeKey(entry.value)}`
      if (seenSubjects.has(subjectKey) && seenSubjects.get(subjectKey) !== entry.id) {
        warnings.push({
          code: 'DUPLICATE_SUBJECT',
          severity: SEVERITY.warning,
          entryId: entry.id,
          message: `Subject is also used by ${seenSubjects.get(subjectKey)}`
        })
      } else {
        seenSubjects.set(subjectKey, entry.id)
      }
      if (seenSignatures.has(signature)) {
        warnings.push({
          code: 'DUPLICATE_ENTRY',
          severity: SEVERITY.warning,
          entryId: entry.id,
          message: 'Same subject and value as another entry'
        })
      } else {
        seenSignatures.set(signature, entry.id)
      }
    }

    const assertionRefs = Array.isArray(entry.assertionRefs) ? entry.assertionRefs : []
    if (assertionRefs.length === 0) {
      issues.push({
        code: 'EVIDENCE_REQUIRED',
        severity: SEVERITY.error,
        entryId: entry.id,
        message: 'Entry has no assertion evidence'
      })
    }
    const evidenceIds = new Set((entry.evidenceRefs ?? []).map((ref) => ref.evidenceId))
    for (const ref of assertionRefs) {
      if (!evidenceIds.has(ref.evidenceId)) {
        issues.push({
          code: 'PROVENANCE_INCOMPLETE',
          severity: SEVERITY.error,
          entryId: entry.id,
          message: `Assertion ${ref.evidenceId} is not part of evidenceRefs`
        })
      }
    }

    if (!readableById.has(entry.id)) {
      const reasons = []
      for (const ref of assertionRefs) {
        const check = registry.verifyRef(ref, { requireQuote: true, requireActive: true })
        if (check.ok) continue
        reasons.push({ code: check.code, evidenceId: ref.evidenceId, message: check.message })
        if (check.code === 'EVIDENCE_REVOKED' || check.code === 'EVIDENCE_REQUIRED') {
          issues.push({
            code: check.code,
            severity: SEVERITY.error,
            entryId: entry.id,
            message: `Entry assertion was invalidated: ${check.message}`,
            details: { evidenceId: ref.evidenceId }
          })
        } else {
          issues.push({
            code: check.code,
            severity: SEVERITY.error,
            entryId: entry.id,
            message: `Entry assertion does not verify: ${check.message}`,
            details: { evidenceId: ref.evidenceId }
          })
        }
      }
      invalidated.push({
        entryId: entry.id,
        subject: entry.subject,
        value: entry.value,
        reasons: reasons.length > 0 ? reasons : [{ code: 'ENTRY_EXCLUDED', message: 'Entry filtered by read-side validation' }]
      })
      continue
    }

    for (const ref of entry.evidenceRefs ?? []) {
      const check = registry.verifyRef(ref, { requireQuote: true, requireActive: false })
      if (check.ok) continue
      if (check.code === 'EVIDENCE_REVOKED') {
        warnings.push({
          code: 'PROVENANCE_REVOKED',
          severity: SEVERITY.warning,
          entryId: entry.id,
          message: `A provenance reference was revoked (${refLabel(ref)})`
        })
      } else {
        issues.push({
          code: check.code,
          severity: SEVERITY.error,
          entryId: entry.id,
          message: `Provenance does not verify (${refLabel(ref)}): ${check.message}`
        })
      }
    }

    if (entry.promoted === true && entry.basis === 'model-statement') {
      issues.push({
        code: 'MODEL_STATEMENT_PROMOTED',
        severity: SEVERITY.error,
        entryId: entry.id,
        message: 'Model statements cannot be the sole basis of promoted memory'
      })
    }
  }

  const rendered = renderL3(readable.entries, budgetValue)
  const snapshot = version.l3 ?? { text: '', stats: null, hash: null }
  const snapshotMatches = normalizeSpace(snapshot.text ?? '') === normalizeSpace(rendered.text)
  const drifted = !snapshotMatches
  if (drifted) {
    warnings.push({
      code: 'L3_SNAPSHOT_DRIFT',
      severity: SEVERITY.warning,
      message: 'The stored L3 snapshot differs from the current readable memory'
    })
  }

  const conflictChecks = []
  for (const conflict of version.conflicts ?? []) {
    const sideChecks = []
    for (const side of conflict.sides ?? []) {
      const checks = (side.evidenceIds ?? []).map((evidenceId) => {
        const record = registry.getEvidence(evidenceId)
        if (!record) return { evidenceId, ok: false, code: 'UNKNOWN_EVIDENCE' }
        const check = registry.verifyRef(
          {
            projectId,
            sourceId: record.sourceId,
            sourceRevision: record.sourceRevision,
            evidenceId: record.evidenceId,
            locator: record.locator
          },
          { requireQuote: true, requireActive: false }
        )
        return { evidenceId, ok: check.ok, code: check.ok ? null : check.code }
      })
      sideChecks.push({ value: side.value, checks })
      for (const check of checks) {
        if (check.ok) continue
        if (check.code === 'EVIDENCE_REVOKED') {
          warnings.push({
            code: 'CONFLICT_SIDE_REVOKED',
            severity: SEVERITY.warning,
            message: `Conflict side lost its provenance (${check.evidenceId})`
          })
        } else {
          warnings.push({
            code: 'CONFLICT_SIDE_INVALID',
            severity: SEVERITY.warning,
            message: `Conflict side has invalid provenance (${check.evidenceId}, ${check.code})`
          })
        }
      }
    }
    conflictChecks.push({ subject: conflict.subject, status: conflict.status, sides: sideChecks })
  }

  const errorCount = issues.filter((issue) => issue.severity === SEVERITY.error).length
  return {
    ok: errorCount === 0,
    projectId,
    versionId: version.versionId,
    revision: version.revision,
    checkedAt: Date.now(),
    entries: {
      total: (version.entries ?? []).length,
      readable: readable.entries.length,
      excluded: readable.excluded.length,
      promoted: readable.entries.filter((entry) => entry.promoted === true).length
    },
    invalidated,
    issues,
    warnings,
    l3: {
      text: rendered.text,
      stats: rendered.stats,
      truncated: rendered.truncated,
      snapshotMatches,
      drifted,
      hash: rendered.hash ?? null
    },
    conflicts: conflictChecks,
    counts: { errors: errorCount, warnings: warnings.length, invalidated: invalidated.length }
  }
}

/**
 * Check an answer's citations against current readable memory.
 * A revoked citation must fail verification, so callers cannot serve stale facts.
 */
export function verifyAnswerCitations({ projectId, registry, version, citations }) {
  const issues = []
  if (version.projectId !== projectId) throw new DreamError('PROJECT_MISMATCH', 'Version belongs to another project')
  const readable = readEntries(registry, version.entries ?? [], { projectId })
  const byId = new Map(readable.entries.map((entry) => [entry.id, entry]))
  for (const citation of citations ?? []) {
    const entry = byId.get(citation.entryId)
    if (!entry) {
      issues.push({ code: 'CITATION_ENTRY_INVALID', entryId: citation.entryId, message: 'Cited entry is not readable' })
      continue
    }
    const assertionIds = new Set((entry.assertionRefs ?? []).map((ref) => ref.evidenceId))
    for (const evidenceId of citation.evidenceIds ?? []) {
      if (!assertionIds.has(evidenceId)) {
        issues.push({ code: 'CITATION_EVIDENCE_INVALID', entryId: entry.id, message: `Evidence ${evidenceId} is not an assertion` })
        continue
      }
      const record = registry.getEvidence(evidenceId)
      if (!record) {
        issues.push({ code: 'CITATION_EVIDENCE_INVALID', entryId: entry.id, message: `Evidence ${evidenceId} is unknown` })
        continue
      }
      const check = registry.verifyRef(
        {
          projectId,
          sourceId: record.sourceId,
          sourceRevision: record.sourceRevision,
          evidenceId,
          locator: record.locator,
          quote: record.text,
          quoteHash: record.quoteHash
        },
        { requireQuote: true, requireActive: true }
      )
      if (!check.ok) {
        issues.push({ code: check.code, entryId: entry.id, message: `Citation ${evidenceId}: ${check.message}` })
      }
    }
  }
  return { ok: issues.length === 0, issues }
}
