import test from 'node:test'
import assert from 'node:assert/strict'

import { PROJECT_ID, checkEntries, validateOps } from '../src/index.mjs'
import { makeEnv, runJob, publishJob } from './helpers.mjs'

async function publishedEnv() {
  const env = await makeEnv()
  const job = await runJob(env, { sessions: [env.fixture.sessions[0]], materials: [] })
  await publishJob(env, job)
  return env
}

test('ops reject fabricated evidence, duplicate targets and subject renames', async (t) => {
  const env = await publishedEnv()
  t.after(() => env.cleanup())
  const active = await env.active()
  const target = active.entries.find((entry) => entry.subject === 'review queue')
  assert.ok(target)
  const evidenceId = target.assertionRefs[0].evidenceId

  const rejected = (ops) =>
    validateOps({
      projectId: PROJECT_ID,
      registry: env.registry,
      proposal: { ops },
      baseEntries: active.entries,
      conflicts: active.conflicts,
      planId: 'plan:ops-test'
    })

  const fabricated = rejected([
    {
      type: 'fix',
      targetIds: [target.id],
      evidenceIds: ['ev_does_not_exist'],
      expectedRevision: target.revision,
      reason: 'fabricated evidence must be rejected',
      payload: { value: 'remote-first' }
    }
  ])
  assert.equal(fabricated.ops.length, 0)
  assert.equal(fabricated.rejected[0].code, 'EVIDENCE_UNKNOWN')

  const duplicate = rejected([
    {
      type: 'keep',
      targetIds: [target.id],
      evidenceIds: [evidenceId],
      expectedRevision: target.revision,
      reason: 'keep review queue preference'
    },
    {
      type: 'keep',
      targetIds: [target.id],
      evidenceIds: [evidenceId],
      expectedRevision: target.revision,
      reason: 'second keep for the same target'
    }
  ])
  assert.equal(duplicate.ops.length, 1)
  assert.equal(duplicate.rejected.length, 1)
  assert.equal(duplicate.rejected[0].code, 'OP_TARGET_DUPLICATE')

  const rename = rejected([
    {
      type: 'fix',
      targetIds: [target.id],
      evidenceIds: [evidenceId],
      expectedRevision: target.revision,
      reason: 'renaming a subject via fix must be rejected',
      payload: { subject: 'different subject', value: 'remote-first' }
    }
  ])
  assert.equal(rename.ops.length, 0)
  assert.equal(rename.rejected[0].code, 'OP_INVALID')

  const typeChange = rejected([
    {
      type: 'fix',
      targetIds: [target.id],
      evidenceIds: [evidenceId],
      expectedRevision: target.revision,
      reason: 'changing note type via fix must be rejected',
      payload: { type: 'rule', value: 'remote-first' }
    }
  ])
  assert.equal(typeChange.ops.length, 0)
  assert.equal(typeChange.rejected[0].code, 'OP_INVALID')
})

test('entry checks block excessive deletion and unknown evidence provenance', async (t) => {
  const env = await publishedEnv()
  t.after(() => env.cleanup())
  const active = await env.active()
  assert.ok(active.entries.length >= 5)
  const keep = active.entries.slice(0, 2)

  const ratio = checkEntries({
    projectId: PROJECT_ID,
    registry: env.registry,
    entries: keep,
    conflicts: [],
    baseEntries: active.entries,
    budget: { maxLines: 40, maxBytes: 4096, maxTokens: 800, maxDeleteRatio: 0.5 }
  })
  assert.ok(ratio.blocking.some((check) => check.code === 'DELETE_RATIO'))

  const corrupted = structuredClone(keep)
  corrupted[0].assertionRefs = [
    { ...corrupted[0].assertionRefs[0], evidenceId: 'ev_fabricated' }
  ]
  const invalid = checkEntries({
    projectId: PROJECT_ID,
    registry: env.registry,
    entries: corrupted,
    conflicts: [],
    baseEntries: active.entries,
    budget: { maxLines: 40, maxBytes: 4096, maxTokens: 800, maxDeleteRatio: 1 }
  })
  assert.ok(invalid.blocking.some((check) => check.code === 'EVIDENCE_UNKNOWN' || check.code === 'EVIDENCE_INVALID'))
})

test('conflicted subjects cannot be changed without declared provenance', async (t) => {
  const env = await makeEnv()
  t.after(() => env.cleanup())
  const first = await runJob(env, { sessions: [env.fixture.sessions[0]], materials: [] })
  await publishJob(env, first)
  const second = await runJob(env, {
    sessions: [env.fixture.sessions[0], env.fixture.sessions[1]],
    materials: []
  })
  await publishJob(env, second)
  const active = await env.active()
  const conflict = active.conflicts.find((candidate) => candidate.subjectKey === 'export format')
  assert.ok(conflict)
  const target = active.entries.find((entry) => entry.subject === 'export format')
  assert.ok(target)

  const result = validateOps({
    projectId: PROJECT_ID,
    registry: env.registry,
    proposal: {
      ops: [
        {
          type: 'drop',
          targetIds: [target.id],
          evidenceIds: [],
          expectedRevision: target.revision,
          reason: 'drop one side without declaring the conflict provenance'
        }
      ]
    },
    baseEntries: active.entries,
    conflicts: active.conflicts,
    planId: 'plan:conflict-test'
  })
  assert.equal(result.ops.length, 0)
  assert.equal(result.rejected[0].code, 'CONFLICT_UNRESOLVED')

  const sideEvidence = conflict.sides.map((side) => side.evidenceIds[0])
  const covered = validateOps({
    projectId: PROJECT_ID,
    registry: env.registry,
    proposal: {
      ops: [
        {
          type: 'drop',
          targetIds: [target.id],
          evidenceIds: sideEvidence,
          expectedRevision: target.revision,
          reason: 'drop with both conflict provenances declared',
          meta: { conflictIds: [conflict.id] }
        }
      ]
    },
    baseEntries: active.entries,
    conflicts: active.conflicts,
    planId: 'plan:conflict-test'
  })
  assert.equal(covered.ops.length, 1)
  assert.equal(covered.rejected.length, 0)
})
