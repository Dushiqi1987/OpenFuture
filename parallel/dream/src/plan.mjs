/**
 * Plan construction: deterministic, JSON-serializable proposal handed to the
 * publisher for review. The plan is NOT the commit; `publishing.mjs` owns the
 * atomic switch after an explicit approval token is supplied.
 */

import { DreamError } from './errors.mjs'
import { readEntries, applyOps, diffEntries } from './l1.mjs'
import { renderL3 } from './l3.mjs'
import { checkEntries, validateOps } from './ops.mjs'
import { contentHash, shortId } from './util.mjs'

function opFingerprint(op) {
  return {
    type: op.type,
    targetIds: [...op.targetIds].sort(),
    evidenceIds: [...op.evidenceIds].sort(),
    payload: op.payload,
    meta: op.meta,
    expectedRevision: op.expectedRevision
  }
}

export function planFingerprint({ projectId, baseVersionId, baseRevision, ops, entries, conflicts, budget }) {
  return contentHash({
    projectId,
    baseVersionId,
    baseRevision,
    budget,
    ops: ops.map(opFingerprint),
    entries: entries.map((entry) => ({
      id: entry.id,
      type: entry.type,
      subject: entry.subject,
      value: entry.value,
      title: entry.title,
      body: entry.body,
      basis: entry.basis,
      promoted: entry.promoted,
      revision: entry.revision,
      assertionEvidenceIds: entry.assertionRefs.map((ref) => ref.evidenceId).sort(),
      evidenceIds: entry.evidenceRefs.map((ref) => ref.evidenceId).sort()
    })),
    conflicts: conflicts.map((conflict) => ({
      id: conflict.id,
      subjectKey: conflict.subjectKey,
      status: conflict.status,
      resolution: conflict.resolution
        ? {
            valueKey: conflict.resolution.valueKey ?? null,
            evidenceIds: [...(conflict.resolution.evidenceIds ?? [])].sort()
          }
        : null,
      sides: conflict.sides.map((side) => ({
        valueKey: side.valueKey,
        evidenceIds: [...side.evidenceIds].sort()
      }))
    }))
  })
}

/**
 * @param {{
 *   projectId:string, jobId:string, baseVersion:any, registry:any,
 *   proposal:any, rem:any, candidates:any[], budget:any, now:number,
 *   model?:any, maxDeleteRatio?:number
 * }} input
 */
export function buildPlan({
  projectId,
  jobId,
  baseVersion,
  registry,
  proposal,
  rem,
  candidates,
  budget,
  now = Date.now(),
  model = null,
  maxDeleteRatio = 0.5
}) {
  const baseEntries = Array.isArray(baseVersion.entries) ? structuredClone(baseVersion.entries) : []
  const planIdBase = shortId('plan', { projectId, jobId, baseRevision: baseVersion.revision })
  const validated = validateOps({
    projectId,
    registry,
    proposal,
    baseEntries,
    conflicts: rem.conflicts,
    planId: planIdBase
  })

  let applied
  let applyError = null
  try {
    applied = applyOps({
      projectId,
      baseEntries,
      ops: validated.ops,
      now,
      planId: planIdBase,
      registry
    })
  } catch (error) {
    applyError = error instanceof DreamError ? error : new DreamError('OP_INVALID', 'Plan application failed')
    applied = {
      entries: baseEntries,
      changes: { added: [], updated: [], removed: [], kept: [] },
      operationLog: []
    }
  }

  const conflicts = mergeConflicts(baseVersion.conflicts ?? [], rem.conflicts ?? [])
  const checks = checkEntries({
    projectId,
    registry,
    entries: applied.entries,
    conflicts,
    budget: { ...budget, maxDeleteRatio },
    baseEntries
  })
  const blocking = [...checks.blocking]
  const warnings = [...checks.warnings]
  if (applyError) blocking.push({ code: applyError.code, message: applyError.message })
  if (validated.ops.length === 0 && candidates.length > 0) {
    blocking.push({
      code: 'NO_EFFECTIVE_OPS',
      message: 'The model proposed no admissible op for the extracted candidates'
    })
  }
  for (const rejected of validated.rejected) {
    warnings.push({
      code: 'OP_REJECTED',
      rejectionCode: rejected.code,
      message: rejected.message,
      index: rejected.index
    })
  }
  for (const op of validated.ops) {
    for (const warning of op.warnings ?? []) warnings.push({ ...warning, opId: op.id })
  }

  const readable = readEntries(registry, applied.entries, { projectId })
  for (const excluded of readable.excluded) {
    blocking.push({
      code: excluded.code,
      message: excluded.message,
      entryId: excluded.entryId
    })
  }
  const l3Preview = renderL3(readable.entries, budget)
  if (!l3Preview.ok) {
    blocking.push({
      code: 'L3_BUDGET',
      message: 'L3 preview would exceed its lines/bytes/token budget',
      details: l3Preview.stats
    })
  }

  const diff = diffEntries(baseEntries, applied.entries)
  const conflictsChanged =
    contentHash(conflicts.map((conflict) => [conflict.id, conflict.status])) !==
    contentHash((baseVersion.conflicts ?? []).map((conflict) => [conflict.id, conflict.status]))

  let status
  if (blocking.length > 0) status = 'blocked'
  else if (validated.ops.length === 0 && candidates.length === 0) status = 'no-changes'
  else if (diff.counts.added + diff.counts.updated + diff.counts.removed === 0 && !conflictsChanged) status = 'no-changes'
  else status = 'pending-approval'

  const planHash = planFingerprint({
    projectId,
    baseVersionId: baseVersion.versionId,
    baseRevision: baseVersion.revision,
    ops: validated.ops,
    entries: applied.entries,
    conflicts,
    budget
  })

  return {
    planId: shortId('plan', planHash),
    planHash,
    projectId,
    jobId,
    createdAt: now,
    baseVersionId: baseVersion.versionId,
    baseRevision: baseVersion.revision,
    budget,
    status,
    ops: validated.ops,
    rejectedOps: validated.rejected,
    proposalNotes: validated.notes.filter((note) => note?.code !== 'CORRECTION_TARGET_MISMATCH'),
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      type: candidate.type,
      subject: candidate.subject,
      value: candidate.value,
      previousValue: candidate.previousValue,
      basis: candidate.basis,
      sessionId: candidate.sessionId,
      evidenceIds: candidate.evidenceIds,
      confidence: candidate.confidence
    })),
    rem: {
      stats: rem.stats,
      clusters: rem.clusters,
      conflicts: rem.conflicts
    },
    entries: applied.entries,
    changes: applied.changes,
    operationLog: applied.operationLog,
    diff,
    l3Preview: {
      text: l3Preview.text,
      stats: l3Preview.stats,
      truncated: l3Preview.truncated,
      hash: l3Preview.hash ?? null
    },
    conflicts,
    checks: {
      blocking,
      warnings,
      deleteRatio: checks.deleteRatio,
      removedEntryIds: checks.removed,
      maxDeleteRatio
    },
    approval: {
      required: true,
      approvedBy: null,
      token: planHash,
      note: 'The approval token is the plan hash. Publisher UI must show the diff and L3 preview first.'
    },
    model: model ?? null,
    publishId: `publish:${planHash}`
  }
}

function mergeConflicts(baseConflicts, nextConflicts) {
  const map = new Map()
  for (const conflict of baseConflicts) map.set(conflict.id, structuredClone(conflict))
  for (const conflict of nextConflicts) map.set(conflict.id, structuredClone(conflict))
  return [...map.values()].sort((a, b) => (a.subjectKey < b.subjectKey ? -1 : a.subjectKey > b.subjectKey ? 1 : 0))
}
