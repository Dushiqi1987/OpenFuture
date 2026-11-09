/**
 * Phase 4: Deep — structured adjudication validation.
 *
 * The model only SUGGESTS ops. This module decides whether each op is
 * admissible. Rejections are per-op: one fabricated evidence id cannot poison
 * the rest of the batch, and the plan records exactly what was refused.
 *
 * Plan-wide gates (in checkEntries): readable assertions, unique subjects,
 * delete ratio, L3 triple budget, injection, conflict retention.
 */

import { DreamError } from './errors.mjs'
import { detectInjection, toEvidenceRef } from './evidence.mjs'
import { basisFromRefs, ENTRY_TYPE_ORDER, NOTE_TYPES, verifyEntry } from './l1.mjs'
import { normalizeKey, normalizeSpace, shortId } from './util.mjs'

export const OP_TYPES = ['keep', 'fix', 'merge', 'drop', 'promote']

const BASIS_ALLOWED = {
  fact: new Set(['user-confirmed', 'tool-result']),
  preference: new Set(['user-confirmed']),
  decision: new Set(['user-confirmed']),
  rule: new Set(['user-confirmed']),
  lesson: new Set(['user-confirmed']),
  'open-question': new Set(['user-confirmed'])
}

function textIsSafe(text) {
  return detectInjection(text).length === 0
}

function normalizedType(value) {
  return String(value ?? '').replace(/_/g, '-')
}

function validateOne({ raw, index, projectId, registry, baseMap, conflictIds, conflicts, planId }) {
  if (!raw || typeof raw !== 'object') {
    throw new DreamError('OP_INVALID', 'Op must be an object')
  }
  const type = String(raw.type ?? '')
  if (!OP_TYPES.includes(type)) throw new DreamError('OP_INVALID', `Unsupported op type: ${type}`)
  const reason = typeof raw.reason === 'string' ? normalizeSpace(raw.reason) : ''
  if (reason.length === 0) throw new DreamError('OP_INVALID', 'Every op needs a human-readable reason')
  if (reason.length > 2000) throw new DreamError('OP_INVALID', 'Op reason is too long')
  if (!textIsSafe(reason)) throw new DreamError('INJECTION_BLOCKED', 'Op reason looks like an instruction')

  const targetIds = Array.isArray(raw.targetIds) ? [...new Set(raw.targetIds.filter((id) => typeof id === 'string'))] : []
  const evidenceIdsRaw = Array.isArray(raw.evidenceIds)
    ? [...new Set(raw.evidenceIds.filter((id) => typeof id === 'string'))]
    : []
  const meta = raw.meta && typeof raw.meta === 'object' ? structuredClone(raw.meta) : {}
  const payload = raw.payload && typeof raw.payload === 'object' ? structuredClone(raw.payload) : {}

  if (type === 'promote') {
    if (targetIds.length !== 0) throw new DreamError('OP_INVALID', 'promote must not target existing entries')
  } else if (type === 'merge') {
    if (targetIds.length < 2) throw new DreamError('OP_INVALID', 'merge needs at least two target entries')
  } else if (type === 'drop') {
    if (targetIds.length < 1) throw new DreamError('OP_INVALID', 'drop needs at least one target entry')
  } else if (targetIds.length !== 1) {
    throw new DreamError('OP_INVALID', `${type} needs exactly one target entry`)
  }

  for (const id of targetIds) {
    if (!baseMap.has(id)) throw new DreamError('TARGET_UNKNOWN', `Unknown target entry: ${id}`)
  }

  const expected = raw.expectedRevision
  const expectedMap = meta.expectedRevisions && typeof meta.expectedRevisions === 'object' ? meta.expectedRevisions : null
  if (expected !== undefined) {
    if (!Number.isInteger(expected) || expected < 1) {
      throw new DreamError('OP_INVALID', 'expectedRevision must be a positive integer')
    }
    for (const id of targetIds) {
      const entry = baseMap.get(id)
      if (entry.revision !== expected) {
        throw new DreamError('REVISION_CONFLICT', 'Op was written against a different entry revision', {
          details: { entryId: id, expected, actual: entry.revision }
        })
      }
    }
  }
  if (expectedMap) {
    for (const id of targetIds) {
      const entry = baseMap.get(id)
      if (expectedMap[id] !== undefined && expectedMap[id] !== entry.revision) {
        throw new DreamError('REVISION_CONFLICT', 'Op was written against a different entry revision', {
          details: { entryId: id, expected: expectedMap[id], actual: entry.revision }
        })
      }
    }
  }

  const evidenceRefs = []
  for (const evidenceId of evidenceIdsRaw) {
    const record = registry.getEvidence(evidenceId)
    if (!record) throw new DreamError('EVIDENCE_UNKNOWN', `Fabricated evidence id: ${evidenceId}`)
    if (record.projectId !== projectId) throw new DreamError('PROJECT_MISMATCH', 'Evidence belongs to another project')
    const check = registry.verifyRef(toEvidenceRef(record), { requireQuote: true })
    if (!check.ok) throw new DreamError(check.code, check.message, { details: { evidenceId } })
    if (record.quarantined || record.injectionFlags?.length > 0) {
      throw new DreamError('INJECTION_BLOCKED', 'Op cites quarantined instruction-like evidence', {
        details: { evidenceId }
      })
    }
    evidenceRefs.push(toEvidenceRef(record))
  }
  if (type !== 'drop' && type !== 'keep' && evidenceIdsRaw.length === 0) {
    throw new DreamError('EVIDENCE_UNKNOWN', `${type} needs at least one evidence reference`)
  }
  if (type === 'drop' && reason.length < 8) {
    throw new DreamError('OP_INVALID', 'drop needs a substantive reason')
  }

  const assertionIds = Array.isArray(meta.assertionEvidenceIds)
    ? [...new Set(meta.assertionEvidenceIds.filter((id) => typeof id === 'string'))]
    : evidenceIdsRaw
  for (const id of assertionIds) {
    if (!evidenceIdsRaw.includes(id)) {
      throw new DreamError('OP_INVALID', 'assertionEvidenceIds must be a subset of evidenceIds')
    }
  }
  const assertionRefs = assertionIds.map((id) => evidenceRefs.find((ref) => ref.evidenceId === id))

  if (payload.subject !== undefined && (typeof payload.subject !== 'string' || payload.subject.trim().length === 0)) {
    throw new DreamError('OP_INVALID', 'payload.subject must be a non-empty string')
  }
  if (payload.value !== undefined && (typeof payload.value !== 'string' || payload.value.trim().length === 0)) {
    throw new DreamError('OP_INVALID', 'payload.value must be a non-empty string')
  }
  if (payload.type !== undefined && !NOTE_TYPES.includes(normalizedType(payload.type))) {
    throw new DreamError('OP_INVALID', 'payload.type is not a memory note type')
  }
  if (
    !textIsSafe(
      [payload.subject ?? '', payload.value ?? '', payload.title ?? '', payload.body ?? '', JSON.stringify(meta)].join('\n')
    )
  ) {
    throw new DreamError('INJECTION_BLOCKED', 'Op payload looks like an instruction')
  }

  const targets = targetIds.map((id) => baseMap.get(id))
  const subjectKey =
    type === 'promote'
      ? normalizeKey(payload.subject ?? '')
      : type === 'merge'
        ? normalizeKey(targets[0].subject)
        : normalizeKey(targets[0].subject)
  if (type === 'merge') {
    if (targets.some((entry) => normalizeKey(entry.subject) !== subjectKey)) {
      throw new DreamError('OP_INVALID', 'merge targets must share the same subject')
    }
    if (payload.subject && normalizeKey(payload.subject) !== subjectKey) {
      throw new DreamError('OP_INVALID', 'merge cannot rename the subject')
    }
  }
  if (type === 'promote' && subjectKey.length === 0) {
    throw new DreamError('OP_INVALID', 'promote needs payload.subject')
  }
  if (type === 'promote' && payload.value === undefined) {
    throw new DreamError('OP_INVALID', 'promote needs payload.value')
  }
  if (type === 'promote') {
    const duplicate = [...baseMap.values()].find((entry) => normalizeKey(entry.subject) === subjectKey)
    if (duplicate) {
      throw new DreamError('DUPLICATE_ENTRY', 'An entry with this subject already exists; use fix/merge', {
        details: { existingEntryId: duplicate.id }
      })
    }
  }
  if (type === 'fix') {
    if (payload.value === undefined) throw new DreamError('OP_INVALID', 'fix needs payload.value')
    const target = targets[0]
    if (payload.subject !== undefined && normalizeKey(payload.subject) !== normalizeKey(target.subject)) {
      throw new DreamError('OP_INVALID', 'fix cannot rename the subject; drop and promote instead')
    }
    const nextType = payload.type ? normalizedType(payload.type) : target.type
    if (nextType !== target.type && !(target.type === 'open-question' && nextType !== 'open-question')) {
      throw new DreamError('OP_INVALID', 'fix cannot change the note type')
    }
  }
  if (type === 'keep' && Object.keys(payload).length > 0) {
    throw new DreamError('OP_INVALID', 'keep does not accept a payload')
  }

  const basis = basisFromRefs(registry, assertionRefs)
  if (['fix', 'merge', 'promote'].includes(type) && basis === 'model-statement') {
    throw new DreamError(
      'EVIDENCE_BASIS_MISMATCH',
      'A model statement alone cannot change memory; user confirmation or a tool result is required'
    )
  }
  if (['fix', 'merge', 'promote'].includes(type)) {
    const noteType =
      type === 'promote' ? normalizedType(payload.type ?? 'fact') : payload.type ? normalizedType(payload.type) : targets[0].type
    const allowed = BASIS_ALLOWED[noteType]
    if (allowed && !allowed.has(basis)) {
      throw new DreamError('EVIDENCE_BASIS_MISMATCH', `A ${noteType} needs a stronger evidence basis than ${basis}`, {
        details: { noteType, basis }
      })
    }
  }

  const knownConflictIds = new Map(conflicts.map((conflict) => [conflict.id, conflict]))
  const declaredConflictIds = Array.isArray(meta.conflictIds) ? [...new Set(meta.conflictIds)] : []
  for (const id of declaredConflictIds) {
    const conflict = knownConflictIds.get(id)
    if (!conflict) throw new DreamError('OP_INVALID', `Unknown conflict id: ${id}`)
    if (conflict.subjectKey !== subjectKey) {
      throw new DreamError('OP_INVALID', 'Declared conflict belongs to a different subject', {
        details: { conflictId: id, conflictSubject: conflict.subject, opSubject: subjectKey }
      })
    }
  }
  const warnings = []
  const applicableConflicts = conflicts.filter((conflict) => conflict.subjectKey === subjectKey)
  if (applicableConflicts.length > 0 && declaredConflictIds.length === 0) {
    throw new DreamError('CONFLICT_UNRESOLVED', 'This op touches a subject with a recorded conflict', {
      details: { conflictIds: applicableConflicts.map((conflict) => conflict.id) }
    })
  }
  for (const conflict of applicableConflicts) {
    if (!declaredConflictIds.includes(conflict.id)) {
      throw new DreamError('CONFLICT_UNRESOLVED', 'Every applicable conflict must be declared by the op', {
        details: { conflictId: conflict.id }
      })
    }
    for (const side of conflict.sides) {
      if (!side.evidenceIds.some((id) => evidenceIdsRaw.includes(id))) {
        throw new DreamError('CONFLICT_UNRESOLVED', 'Conflict provenance must cite both sides', {
          details: { conflictId: conflict.id, side: side.value, needAnyOf: side.evidenceIds }
        })
      }
    }
    if (conflict.status === 'resolved-by-correction') {
      const proposed = payload.value ?? targets[0]?.value ?? null
      if (type !== 'drop' && proposed !== null && normalizeKey(proposed) !== normalizeKey(conflict.resolvedValue)) {
        throw new DreamError('CONFLICT_UNRESOLVED', 'Op contradicts the correction that resolved this conflict', {
          details: { conflictId: conflict.id, resolvedValue: conflict.resolvedValue, proposed }
        })
      }
      if (type === 'keep' && normalizeKey(targets[0].value) !== normalizeKey(conflict.resolvedValue)) {
        throw new DreamError('CONFLICT_UNRESOLVED', 'keep would preserve the superseded side of a resolved conflict', {
          details: { conflictId: conflict.id }
        })
      }
    } else if (conflict.status === 'unresolved') {
      warnings.push({
        code: 'UNRESOLVED_CONFLICT_PROVENANCE',
        conflictId: conflict.id,
        message: 'Plan keeps both sides but chooses one value; publisher approval is required'
      })
    }
  }

  const op = {
    id: shortId('op', { planId, index, type, targetIds, evidenceIds: evidenceIdsRaw.sort() }),
    type,
    targetIds,
    evidenceIds: [...evidenceIdsRaw].sort(),
    evidenceRefs,
    assertionRefs,
    reason,
    confidence:
      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
        ? Math.min(1, Math.max(0, raw.confidence))
        : null,
    expectedRevision: expected ?? null,
    payload: {
      ...(payload.type !== undefined ? { type: normalizedType(payload.type) } : {}),
      ...(payload.subject !== undefined ? { subject: normalizeSpace(payload.subject) } : {}),
      ...(payload.value !== undefined ? { value: normalizeSpace(payload.value) } : {}),
      ...(payload.title !== undefined ? { title: normalizeSpace(payload.title) } : {}),
      ...(payload.body !== undefined ? { body: String(payload.body) } : {}),
      ...(payload.promoted !== undefined ? { promoted: payload.promoted === true } : {})
    },
    meta: { ...meta, conflictIds: declaredConflictIds },
    basis,
    warnings
  }

  // Fill the default promote note type/promotion flag after validation.
  if (type === 'promote') {
    op.payload.type = op.payload.type ?? 'fact'
    op.payload.promoted = op.payload.promoted ?? op.payload.type !== 'open-question'
    op.payload.title = op.payload.title ?? op.payload.subject
    op.payload.body = op.payload.body ?? `${op.payload.subject}: ${op.payload.value}`
  }
  return op
}

/**
 * Validate a model proposal. Ops are independent; rejected ops are reported
 * with stable codes and the rest can still form a plan.
 */
export function validateOps({
  projectId,
  registry,
  proposal,
  baseEntries,
  conflicts = [],
  planId = 'plan'
}) {
  if (!registry || registry.projectId !== projectId) {
    throw new DreamError('PROJECT_MISMATCH', 'Registry belongs to another project')
  }
  const rawOps = Array.isArray(proposal?.ops) ? proposal.ops : []
  if (!Array.isArray(proposal?.ops)) throw new DreamError('MODEL_OUTPUT_INVALID', 'Proposal must contain ops[]')
  const baseMap = new Map(baseEntries.map((entry) => [entry.id, entry]))
  const validated = []
  const rejected = []
  const conflictIds = conflicts.map((conflict) => conflict.id)

  rawOps.forEach((raw, index) => {
    try {
      const op = validateOne({
        raw,
        index,
        projectId,
        registry,
        baseMap,
        conflictIds,
        conflicts,
        planId
      })
      validated.push({ op, index })
    } catch (error) {
      if (error instanceof DreamError) {
        rejected.push({
          index,
          type: raw?.type ?? null,
          targetIds: Array.isArray(raw?.targetIds) ? raw.targetIds : [],
          evidenceIds: Array.isArray(raw?.evidenceIds) ? raw.evidenceIds : [],
          code: error.code,
          message: error.message,
          details: error.details ?? null
        })
      } else {
        rejected.push({
          index,
          type: raw?.type ?? null,
          code: 'OP_INVALID',
          message: 'Op could not be validated',
          details: null
        })
      }
    }
  })

  // A plan must be unambiguous: one op per target entry, one promote per subject.
  const ops = []
  const usedTargets = new Map()
  const usedPromoteSubjects = new Map()
  for (const { op, index } of validated) {
    let duplicate = null
    for (const targetId of op.targetIds) {
      if (usedTargets.has(targetId)) {
        duplicate = {
          code: 'OP_TARGET_DUPLICATE',
          message: 'Two ops target the same entry',
          details: { entryId: targetId, firstOpId: usedTargets.get(targetId) }
        }
        break
      }
    }
    if (!duplicate && op.type === 'promote') {
      const subjectKey = normalizeKey(op.payload.subject)
      if (usedPromoteSubjects.has(subjectKey)) {
        duplicate = {
          code: 'DUPLICATE_ENTRY',
          message: 'Two ops promote the same subject',
          details: { subject: op.payload.subject, firstOpId: usedPromoteSubjects.get(subjectKey) }
        }
      }
    }
    if (duplicate) {
      rejected.push({
        index,
        type: op.type,
        targetIds: op.targetIds,
        evidenceIds: op.evidenceIds,
        code: duplicate.code,
        message: duplicate.message,
        details: duplicate.details
      })
      continue
    }
    for (const targetId of op.targetIds) usedTargets.set(targetId, op.id)
    if (op.type === 'promote') usedPromoteSubjects.set(normalizeKey(op.payload.subject), op.id)
    ops.push(op)
  }

  return {
    planId,
    ops,
    rejected,
    notes: Array.isArray(proposal?.notes) ? proposal.notes.slice(0, 50) : [],
    stats: {
      proposed: rawOps.length,
      accepted: ops.length,
      rejected: rejected.length,
      warnings: ops.reduce((count, op) => count + op.warnings.length, 0)
    },
    conflictIds
  }
}

/**
 * Plan-wide gates. Returns blocking errors and warnings; any blocking error
 * prevents a publishable plan.
 */
export function checkEntries({ projectId, registry, entries, conflicts = [], budget, baseEntries = [] }) {
  const blocking = []
  const warnings = []
  const seen = new Map()
  let promotedCount = 0
  for (const entry of entries) {
    const checked = verifyEntry(registry, entry, { projectId })
    if (!checked.ok) {
      blocking.push({ code: checked.code, message: checked.message, entryId: entry.id })
      continue
    }
    const key = normalizeKey(entry.subject)
    if (seen.has(key)) {
      blocking.push({
        code: 'DUPLICATE_ENTRY',
        message: 'Two entries share the same subject',
        entryIds: [seen.get(key), entry.id],
        subject: entry.subject
      })
    } else {
      seen.set(key, entry.id)
    }
    if (!ENTRY_TYPE_ORDER.includes(entry.type)) {
      blocking.push({ code: 'VALIDATION', message: `Unknown note type: ${entry.type}`, entryId: entry.id })
    }
    const text = [entry.subject, entry.value, entry.title, entry.body].join('\n')
    if (detectInjection(text).length > 0) {
      blocking.push({ code: 'INJECTION_BLOCKED', message: 'Entry text looks like an instruction', entryId: entry.id })
    }
    if (entry.promoted) promotedCount += 1
  }

  const baseIds = new Set(baseEntries.map((entry) => entry.id))
  const keptIds = new Set(entries.map((entry) => entry.id))
  const removed = [...baseIds].filter((id) => !keptIds.has(id))
  const deleteRatio = baseIds.size === 0 ? 0 : removed.length / baseIds.size
  const maxDeleteRatio = budget?.maxDeleteRatio ?? 0.5
  if (deleteRatio > maxDeleteRatio) {
    blocking.push({
      code: 'DELETE_RATIO',
      message: `Deleting ${removed.length}/${baseIds.size} entries exceeds the allowed ratio`,
      details: { deleteRatio, maxDeleteRatio, removed }
    })
  }

  if (promotedCount === 0 && entries.length > 0) {
    warnings.push({ code: 'NO_PROMOTED_ENTRIES', message: 'No entry is eligible for L3' })
  }
  if (conflicts.length > 0) {
    warnings.push({
      code: 'CONFLICTS_RETAINED',
      message: `${conflicts.length} conflict(s) retained with both provenances`,
      conflictIds: conflicts.map((conflict) => conflict.id)
    })
  }
  return { blocking, warnings, deleteRatio, removed, promotedCount }
}
