/**
 * L1 memory entries: deterministic state transitions and read-side validity.
 *
 * `evidenceRefs`    full provenance (may include superseded/conflicting sides)
 * `assertionRefs`   evidence that supports the CURRENT value; the entry is
 *                   unreadable unless EVERY one still verifies
 *                   (same project, active source, latest revision,
 *                   authorized+completed, exact quote).
 *
 * Read-side validity is what prevents a revoked fact from resurfacing through a
 * cached L3, a rollback, or an answer that cites stale evidence.
 */

import { DreamError } from './errors.mjs'
import { normalizeKey, shortId, sortByKey } from './util.mjs'

export const NOTE_TYPES = ['fact', 'preference', 'decision', 'rule', 'lesson', 'open-question']
export const ENTRY_TYPE_ORDER = ['fact', 'preference', 'decision', 'rule', 'lesson', 'open-question']

export function entryIdFor({ projectId, type, subject, salt = null }) {
  return shortId('mem', { projectId, type, subjectKey: normalizeKey(subject), salt })
}

export function basisFromRefs(registry, refs) {
  const roles = refs
    .map((ref) => registry.getEvidence(ref.evidenceId)?.role ?? null)
    .filter((role) => role !== null)
  if (roles.includes('user')) return 'user-confirmed'
  if (roles.includes('tool')) return 'tool-result'
  return 'model-statement'
}

function refIdSet(refs) {
  return new Set((refs ?? []).map((ref) => ref.evidenceId))
}

/** Union refs, preserving first occurrence order. */
export function unionRefs(...lists) {
  const seen = new Set()
  const out = []
  for (const list of lists) {
    for (const ref of list ?? []) {
      if (!ref || seen.has(ref.evidenceId)) continue
      seen.add(ref.evidenceId)
      out.push(structuredClone(ref))
    }
  }
  return out
}

export function normalizeEntry(entry) {
  return {
    id: entry.id,
    projectId: entry.projectId,
    type: entry.type,
    subject: entry.subject,
    value: entry.value,
    title: entry.title ?? entry.subject,
    body: entry.body ?? '',
    basis: entry.basis,
    confidence: entry.confidence ?? null,
    evidenceRefs: unionRefs(entry.evidenceRefs ?? []),
    assertionRefs: unionRefs(entry.assertionRefs ?? []),
    promoted: entry.promoted === true,
    revision: entry.revision ?? 1,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    provenance: Array.isArray(entry.provenance) ? structuredClone(entry.provenance) : []
  }
}

/**
 * Apply already-validated ops to base entries. Never mutates its inputs.
 *
 * @param {{projectId:string, baseEntries:any[], ops:any[], now:number, planId:string, registry:any}} input
 */
export function applyOps({ projectId, baseEntries, ops, now = Date.now(), planId = 'plan', registry }) {
  const entries = new Map(baseEntries.map((entry) => [entry.id, normalizeEntry(entry)]))
  const changes = { added: [], updated: [], removed: [], kept: [] }
  const operationLog = []

  for (const op of ops) {
    const at = now
    const provenanceEntry = {
      planId,
      opId: op.id,
      type: op.type,
      reason: op.reason,
      at,
      conflictIds: [...(op.meta?.conflictIds ?? [])]
    }
    if (op.type === 'promote') {
      const entry = {
        id: entryIdFor({ projectId, type: op.payload.type, subject: op.payload.subject }),
        projectId,
        type: op.payload.type,
        subject: op.payload.subject,
        value: op.payload.value,
        title: op.payload.title ?? op.payload.subject,
        body: op.payload.body ?? `${op.payload.subject}: ${op.payload.value}`,
        basis: basisFromRefs(registry, op.assertionRefs),
        confidence: op.confidence ?? null,
        evidenceRefs: unionRefs(op.evidenceRefs),
        assertionRefs: unionRefs(op.assertionRefs),
        promoted: op.payload.promoted === true,
        revision: 1,
        createdAt: at,
        updatedAt: at,
        provenance: [provenanceEntry]
      }
      if (entries.has(entry.id)) throw new DreamError('DUPLICATE_ENTRY', `Entry already exists: ${entry.id}`)
      entries.set(entry.id, entry)
      changes.added.push(entry.id)
      operationLog.push({ opId: op.id, type: op.type, entryId: entry.id, effect: 'created' })
      continue
    }

    if (op.type === 'merge') {
      const targets = op.targetIds.map((id) => entries.get(id))
      const type = op.payload?.type ?? targets[0].type
      const subject = op.payload?.subject ?? targets[0].subject
      const values = [...new Set(targets.map((target) => target.value))]
      const entry = {
        id: entryIdFor({
          projectId,
          type,
          subject,
          salt: [...op.targetIds].sort().join(',')
        }),
        projectId,
        type,
        subject,
        value: op.payload?.value ?? values.join(' | '),
        title: op.payload?.title ?? subject,
        body: op.payload?.body ?? values.map((value) => `- ${value}`).join('\n'),
        basis: basisFromRefs(registry, op.assertionRefs),
        confidence: op.confidence ?? null,
        evidenceRefs: unionRefs(
          ...targets.map((target) => target.evidenceRefs),
          op.evidenceRefs
        ),
        assertionRefs: unionRefs(op.assertionRefs),
        promoted: op.payload?.promoted === true || targets.every((target) => target.promoted === true),
        revision: 1,
        createdAt: at,
        updatedAt: at,
        provenance: [...targets.flatMap((target) => target.provenance ?? []), { ...provenanceEntry, mergedFrom: op.targetIds }]
      }
      for (const id of op.targetIds) {
        entries.delete(id)
        changes.removed.push(id)
      }
      if (entries.has(entry.id)) throw new DreamError('DUPLICATE_ENTRY', `Merged entry collides: ${entry.id}`)
      entries.set(entry.id, entry)
      changes.added.push(entry.id)
      operationLog.push({ opId: op.id, type: op.type, entryId: entry.id, effect: 'merged', from: op.targetIds })
      continue
    }

    if (op.type === 'drop') {
      for (const id of op.targetIds) {
        entries.delete(id)
        changes.removed.push(id)
      }
      operationLog.push({ opId: op.id, type: op.type, removed: op.targetIds })
      continue
    }

    const target = entries.get(op.targetIds[0])
    if (!target) throw new DreamError('TARGET_UNKNOWN', `Unknown target entry: ${op.targetIds[0]}`)
    if (op.type === 'keep') {
      target.evidenceRefs = unionRefs(target.evidenceRefs, op.evidenceRefs)
      if (op.assertionRefs.length > 0) target.assertionRefs = unionRefs(target.assertionRefs, op.assertionRefs)
      target.updatedAt = at
      target.provenance = [...(target.provenance ?? []), provenanceEntry]
      changes.kept.push(target.id)
      operationLog.push({ opId: op.id, type: op.type, entryId: target.id, effect: 'reaffirmed' })
      continue
    }

    if (op.type === 'fix') {
      const type = op.payload?.type ?? target.type
      target.type = type
      target.value = op.payload.value
      if (op.payload.subject) target.subject = op.payload.subject
      target.title = op.payload.title ?? target.title
      target.body = op.payload.body ?? `${target.subject}: ${target.value}`
      target.evidenceRefs = unionRefs(target.evidenceRefs, op.evidenceRefs)
      target.assertionRefs = unionRefs(op.assertionRefs)
      target.basis = basisFromRefs(registry, target.assertionRefs)
      if (op.payload.promoted !== undefined) target.promoted = op.payload.promoted === true
      target.revision = (target.revision ?? 1) + 1
      target.updatedAt = at
      target.provenance = [...(target.provenance ?? []), provenanceEntry]
      changes.updated.push(target.id)
      operationLog.push({ opId: op.id, type: op.type, entryId: target.id, effect: 'updated', revision: target.revision })
      continue
    }

    throw new DreamError('OP_INVALID', `Unsupported op type: ${String(op.type)}`)
  }

  const ordered = sortByKey(
    [...entries.values()],
    (entry) => `${String(ENTRY_TYPE_ORDER.indexOf(entry.type)).padStart(2, '0')}:${normalizeKey(entry.subject)}:${entry.id}`
  )
  return { entries: ordered, changes, operationLog }
}

/**
 * Verify one entry against the live registry.
 * @returns {{ok:true, entry:any}|{ok:false, code:string, message:string}}
 */
export function verifyEntry(registry, entry, { projectId } = {}) {
  const expectedProject = projectId ?? registry.projectId
  if (entry?.projectId !== expectedProject) {
    return { ok: false, code: 'PROJECT_MISMATCH', message: 'Entry belongs to another project' }
  }
  if (!Array.isArray(entry.assertionRefs) || entry.assertionRefs.length === 0) {
    return { ok: false, code: 'CANDIDATE_INVALID', message: 'Entry has no assertion evidence' }
  }
  for (const ref of entry.assertionRefs) {
    const check = registry.verifyRef(ref, { requireQuote: true })
    if (!check.ok) {
      return { ok: false, code: check.code, message: check.message }
    }
  }
  const evidenceRefs = []
  for (const ref of entry.evidenceRefs ?? []) {
    const check = registry.verifyRef(ref, { requireQuote: true })
    if (!check.ok) continue
    evidenceRefs.push(structuredClone(ref))
  }
  const assertionRefs = []
  for (const ref of entry.assertionRefs) {
    const check = registry.verifyRef(ref, { requireQuote: true })
    if (!check.ok) {
      return { ok: false, code: check.code, message: check.message }
    }
    assertionRefs.push(structuredClone(ref))
  }
  return {
    ok: true,
    entry: {
      ...normalizeEntry(entry),
      evidenceRefs,
      assertionRefs,
      basis: basisFromRefs(registry, assertionRefs)
    }
  }
}

/**
 * Filter entries through the registry. Returns readable entries plus exclusion
 * diagnostics. This is the ONLY way entries may reach L3, answers or plans.
 */
export function readEntries(registry, entries, { projectId } = {}) {
  const readable = []
  const excluded = []
  for (const entry of entries ?? []) {
    const check = verifyEntry(registry, entry, { projectId })
    if (check.ok) readable.push(check.entry)
    else excluded.push({ entryId: entry.id, code: check.code, message: check.message })
  }
  return { entries: readable, excluded }
}

export function diffEntries(before, after) {
  const beforeMap = new Map((before ?? []).map((entry) => [entry.id, entry]))
  const afterMap = new Map((after ?? []).map((entry) => [entry.id, entry]))
  const added = []
  const updated = []
  const removed = []
  for (const [id, entry] of afterMap) {
    const prior = beforeMap.get(id)
    if (!prior) {
      added.push(describe(entry))
      continue
    }
    if (
      prior.value !== entry.value ||
      prior.type !== entry.type ||
      prior.promoted !== entry.promoted ||
      normalizeKey(prior.title) !== normalizeKey(entry.title)
    ) {
      updated.push({ ...describe(entry), before: describe(prior) })
    }
  }
  for (const [id, entry] of beforeMap) {
    if (!afterMap.has(id)) removed.push(describe(entry))
  }
  return {
    added,
    updated,
    removed,
    counts: { added: added.length, updated: updated.length, removed: removed.length }
  }
}

function describe(entry) {
  return {
    id: entry.id,
    type: entry.type,
    subject: entry.subject,
    value: entry.value,
    promoted: entry.promoted === true,
    revision: entry.revision
  }
}

export function refIdsOf(entry) {
  return new Set(refIdSet(entry.evidenceRefs))
}
