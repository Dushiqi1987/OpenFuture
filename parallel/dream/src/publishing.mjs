/**
 * Promote / publish / rollback.
 *
 * Model and plan are untrusted until this commit path re-validates:
 *   - explicit publisher approval bound to the plan hash
 *   - active revision is still the plan base
 *   - every op's target revision still exists
 *   - every evidence ref still verifies (authorized, latest, not revoked, quote)
 *   - final entries are readable, unique, safe, within L3 budget
 *
 * The store then performs the atomic version switch. Rollback builds a NEW
 * version from the target version's entries filtered through CURRENT
 * revocations, so a rollback cannot resurrect a revoked fact.
 */

import { DreamError } from './errors.mjs'
import { readEntries, verifyEntry } from './l1.mjs'
import { buildL3Snapshot } from './l3.mjs'
import { checkEntries } from './ops.mjs'
import { planFingerprint } from './plan.mjs'
import { versionIdFor } from './store.mjs'
import { contentHash, deepClone, normalizeSpace } from './util.mjs'

function approvalCheck(plan, approval) {
  if (!approval || typeof approval !== 'object') {
    throw new DreamError('APPROVAL_REQUIRED', 'Publisher approval is required')
  }
  const approvedBy = typeof approval.approvedBy === 'string' ? normalizeSpace(approval.approvedBy) : ''
  if (approvedBy.length === 0) throw new DreamError('APPROVAL_REQUIRED', 'approvedBy is required')
  if (approval.approvalToken !== plan.planHash) {
    throw new DreamError('APPROVAL_REQUIRED', 'Approval token does not match the plan hash', {
      details: { expectedToken: plan.planHash }
    })
  }
  return approvedBy
}

function verifyPlanAgainstCurrent({ registry, active, plan, budget, maxDeleteRatio }) {
  const blocking = []
  if (!active || active.versionId !== plan.baseVersionId || active.revision !== plan.baseRevision) {
    throw new DreamError('PLAN_STALE', 'The active version changed after the plan was built', {
      details: {
        activeRevision: active?.revision ?? null,
        planBaseRevision: plan.baseRevision
      }
    })
  }
  const activeEntryMap = new Map(active.entries.map((entry) => [entry.id, entry]))
  for (const op of plan.ops) {
    for (const evidenceId of op.evidenceIds) {
      const record = registry.getEvidence(evidenceId)
      if (!record) {
        blocking.push({ code: 'EVIDENCE_UNKNOWN', message: 'Op evidence disappeared', evidenceId })
        continue
      }
      const check = registry.verifyRef(
        {
          projectId: record.projectId,
          sourceId: record.sourceId,
          sourceRevision: record.sourceRevision,
          evidenceId: record.evidenceId,
          locator: record.locator,
          quote: record.text,
          quoteHash: record.contentHash
        },
        { requireQuote: true }
      )
      if (!check.ok) blocking.push({ code: check.code, message: check.message, evidenceId })
    }
    for (const targetId of op.targetIds) {
      const current = activeEntryMap.get(targetId)
      if (!current) {
        blocking.push({ code: 'TARGET_UNKNOWN', message: 'Target entry disappeared', entryId: targetId })
        continue
      }
      if (op.expectedRevision !== null && current.revision !== op.expectedRevision) {
        blocking.push({
          code: 'REVISION_CONFLICT',
          message: 'Target entry revision changed',
          entryId: targetId,
          expected: op.expectedRevision,
          actual: current.revision
        })
      }
    }
  }
  for (const entry of plan.entries) {
    const check = verifyEntry(registry, entry, { projectId: plan.projectId })
    if (!check.ok) blocking.push({ code: check.code, message: check.message, entryId: entry.id })
  }
  const structural = checkEntries({
    projectId: plan.projectId,
    registry,
    entries: plan.entries,
    conflicts: plan.conflicts,
    budget: { ...budget, maxDeleteRatio },
    baseEntries: active.entries
  })
  blocking.push(...structural.blocking)
  if (blocking.length > 0) {
    throw new DreamError('PLAN_CHECK_FAILED', 'Plan no longer passes pre-publish checks', { details: { blocking } })
  }
  const recomputed = planFingerprint({
    projectId: plan.projectId,
    baseVersionId: plan.baseVersionId,
    baseRevision: plan.baseRevision,
    ops: plan.ops,
    entries: plan.entries,
    conflicts: plan.conflicts,
    budget
  })
  if (recomputed !== plan.planHash) {
    throw new DreamError('PLAN_CHECK_FAILED', 'Plan hash does not match its contents (tampered or rebuilt)')
  }
  const readable = readEntries(registry, plan.entries, { projectId: plan.projectId })
  if (readable.excluded.length > 0) {
    throw new DreamError('PLAN_CHECK_FAILED', 'Some entries are not readable against current evidence', {
      details: { excluded: readable.excluded }
    })
  }
  return { readable, warnings: structural.warnings }
}

/**
 * Publish an approved plan. Re-validates and then atomically switches active.
 *
 * @param {{store:any, registry:any, plan:any, approval:{approvedBy:string, approvalToken:string, note?:string}, now?:number, maxDeleteRatio?:number}} input
 */
export async function publishPlan({ store, registry, plan, approval, now = Date.now(), maxDeleteRatio = 0.5 }) {
  if (!plan || plan.projectId !== registry.projectId) {
    throw new DreamError('PROJECT_MISMATCH', 'Plan belongs to another project')
  }
  if (plan.status === 'blocked') {
    throw new DreamError('PLAN_CHECK_FAILED', 'Blocked plans cannot be published', {
      details: { blocking: plan.checks?.blocking ?? [] }
    })
  }
  if (plan.status === 'no-changes') {
    throw new DreamError('NO_EFFECTIVE_OPS', 'A no-changes plan has nothing to publish')
  }
  const approvedBy = approvalCheck(plan, approval)

  const active = await store.getActive(plan.projectId)
  // Idempotent replay: already published by this exact plan.
  if (
    active.publishId === plan.publishId &&
    active.planHash === plan.planHash &&
    active.revision === plan.baseRevision + 1
  ) {
    return {
      status: 'idempotent',
      planId: plan.planId,
      publishId: plan.publishId,
      version: deepClone(active),
      postPublish: { ok: true, excluded: [], replay: true }
    }
  }
  if (active.revision !== plan.baseRevision) {
    throw new DreamError('PLAN_STALE', 'The active version changed after the plan was built', {
      details: { activeRevision: active.revision, planBaseRevision: plan.baseRevision }
    })
  }

  const budget = plan.budget
  const { readable, warnings } = verifyPlanAgainstCurrent({ registry, active, plan, budget, maxDeleteRatio })
  const l3 = buildL3Snapshot(readable.entries, budget)
  const revision = active.revision + 1
  const version = {
    versionId: versionIdFor(plan.projectId, revision),
    projectId: plan.projectId,
    revision,
    parentVersionId: active.versionId,
    parentRevision: active.revision,
    createdAt: now,
    createdBy: approvedBy,
    kind: 'publish',
    publishId: plan.publishId,
    planId: plan.planId,
    planHash: plan.planHash,
    jobId: plan.jobId,
    entries: deepClone(plan.entries),
    conflicts: deepClone(plan.conflicts),
    l3: { text: l3.text, stats: l3.stats, hash: l3.hash },
    approval: {
      approvedBy,
      approvalToken: approval.approvalToken,
      approvedAt: now,
      note: typeof approval.note === 'string' ? approval.note.slice(0, 1000) : null
    },
    model: plan.model ?? null,
    reason: typeof approval.note === 'string' ? approval.note : null,
    checks: {
      warnings,
      deleteRatio: plan.checks?.deleteRatio ?? 0
    }
  }

  const result = await store.commit(plan.projectId, {
    expectedRevision: active.revision,
    version,
    approval
  })

  const published = result.version
  const postCheck = readEntries(registry, published.entries, { projectId: plan.projectId })
  return {
    status: result.kind === 'idempotent' ? 'idempotent' : 'applied',
    planId: plan.planId,
    publishId: plan.publishId,
    version: deepClone(published),
    postPublish: {
      ok: postCheck.excluded.length === 0,
      excluded: postCheck.excluded,
      l3Hash: published.l3?.hash ?? null
    }
  }
}

function verifiableEvidenceIds(registry, ids) {
  const valid = []
  const revoked = []
  for (const id of ids ?? []) {
    const record = registry.getEvidence(id)
    if (!record) {
      revoked.push(id)
      continue
    }
    const check = registry.verifyRef(
      {
        projectId: record.projectId,
        sourceId: record.sourceId,
        sourceRevision: record.sourceRevision,
        evidenceId: record.evidenceId,
        locator: record.locator,
        quote: record.text,
        quoteHash: record.contentHash
      },
      { requireQuote: true }
    )
    if (check.ok) valid.push(id)
    else revoked.push(id)
  }
  return { valid, revoked }
}

/**
 * Roll back to a previous version by creating a NEW version. Current
 * revocations are applied first: entries whose assertion evidence is revoked
 * are excluded, and revoked conflict provenance is recorded but not restored.
 */
export async function rollbackMemory({
  store,
  registry,
  projectId,
  toRevision,
  approvedBy,
  reason,
  now = Date.now(),
  publishId = null,
  budget = undefined
}) {
  if (!Number.isInteger(toRevision) || toRevision < 1) {
    throw new DreamError('VALIDATION', 'toRevision must be a positive integer')
  }
  const actor = typeof approvedBy === 'string' ? normalizeSpace(approvedBy) : ''
  if (actor.length === 0) throw new DreamError('APPROVAL_REQUIRED', 'Rollback needs approvedBy')
  const why = typeof reason === 'string' ? normalizeSpace(reason) : ''
  if (why.length < 8) throw new DreamError('APPROVAL_REQUIRED', 'Rollback needs a substantive reason')

  const active = await store.getActive(projectId)
  if (toRevision === active.revision) throw new DreamError('VERSION_ALREADY_ACTIVE', 'That version is already active')
  const target = await store.getVersion(projectId, toRevision)
  if (!target) throw new DreamError('VERSION_NOT_FOUND', `Version ${toRevision} does not exist`)

  const readable = readEntries(registry, target.entries, { projectId })
  const entries = readable.entries
  const conflicts = (target.conflicts ?? []).map((conflict) => {
    const sides = conflict.sides.map((side) => {
      const { valid, revoked } = verifiableEvidenceIds(registry, side.evidenceIds)
      return { ...side, evidenceIds: valid, revokedEvidenceIds: revoked }
    })
    const droppedSides = sides.filter((side) => side.evidenceIds.length === 0)
    return {
      ...conflict,
      sides,
      status: droppedSides.length > 0 ? 'historical-after-revocation' : conflict.status,
      rollback: { at: now, fromVersionId: active.versionId, revokedSides: droppedSides.map((side) => side.value) }
    }
  })
  const l3 = buildL3Snapshot(entries, budget)
  const revision = active.revision + 1
  const planHash = contentHash({
    kind: 'rollback',
    projectId,
    toRevision,
    targetVersionId: target.versionId,
    fromVersionId: active.versionId,
    entryIds: entries.map((entry) => [entry.id, entry.revision]),
    approvedBy: actor,
    reason: why
  })
  const version = {
    versionId: versionIdFor(projectId, revision),
    projectId,
    revision,
    parentVersionId: active.versionId,
    parentRevision: active.revision,
    createdAt: now,
    createdBy: actor,
    kind: 'rollback',
    publishId: publishId ?? `rollback:${projectId}:${target.versionId}:${active.revision}`,
    planHash,
    entries,
    conflicts,
    l3: { text: l3.text, stats: l3.stats, hash: l3.hash },
    approval: { approvedBy: actor, approvedAt: now, note: why },
    rollback: {
      toRevision,
      targetVersionId: target.versionId,
      fromVersionId: active.versionId,
      excludedEntryIds: readable.excluded.map((excluded) => excluded.entryId),
      restoredEntryIds: entries.map((entry) => entry.id)
    },
    reason: why
  }
  const result = await store.commit(projectId, {
    expectedRevision: active.revision,
    version,
    approval: { approvedBy: actor, approvalToken: planHash, note: why }
  })
  return {
    status: result.kind === 'idempotent' ? 'idempotent' : 'applied',
    version: deepClone(result.version),
    toRevision,
    entries: entries.map((entry) => ({
      id: entry.id,
      subject: entry.subject,
      value: entry.value,
      promoted: entry.promoted
    })),
    excluded: readable.excluded,
    conflicts: conflicts.map((conflict) => ({ id: conflict.id, status: conflict.status })),
    postPublish: {
      ok: readEntries(registry, result.version.entries, { projectId }).excluded.length === 0,
      l3Hash: result.version.l3.hash
    }
  }
}
