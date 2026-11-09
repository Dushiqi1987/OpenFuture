import test from 'node:test'
import assert from 'node:assert/strict'

import { PROJECT_ID, SESSION_1_ID } from '../src/index.mjs'
import { makeEnv, publishJob, runJob } from './helpers.mjs'

test('B3: authorized discovery, approval, correction, revocation and rollback', async (t) => {
  const env = await makeEnv()
  t.after(() => env.cleanup())

  // --- First run: one authorized completed session; old version stays active ---
  const first = await runJob(env, { sessions: [env.fixture.sessions[0]], materials: [] })
  assert.equal(first.status, 'review')
  assert.equal(first.plan.status, 'pending-approval')
  assert.equal((await env.active()).revision, 1, 'nothing is published before approval')
  const l3BeforeApproval = await env.pipeline.getL3(PROJECT_ID)
  assert.equal(l3BeforeApproval.text.includes('local-first'), false, 'the old version remains usable')
  assert.match(first.plan.l3Preview.text, /local-first/, 'the pending plan previews the new L3')

  // A wrong approval token must not mutate the store.
  await assert.rejects(
    () =>
      env.pipeline.publish(first.id, {
        approvedBy: 'publisher@test.invalid',
        approvalToken: 'not-the-plan-hash'
      }),
    (error) => error.code === 'APPROVAL_REQUIRED'
  )
  assert.equal((await env.active()).revision, 1)

  const published1 = await publishJob(env, first)
  assert.equal(published1.version.revision, 2)
  assert.equal(published1.verification.ok, true)

  const l3v2 = await env.pipeline.getL3(PROJECT_ID)
  assert.match(l3v2.text, /review queue: local-first/)
  const answerLocal = await env.pipeline.answer({ projectId: PROJECT_ID, query: 'review queue' })
  assert.equal(answerLocal.matched, true)
  assert.equal(answerLocal.citationCheck.ok, true)
  assert.match(answerLocal.answer, /local-first/)

  // --- Second run: a correction arrives, plus a real conflicting decision ---
  const second = await runJob(env, { sessions: env.fixture.sessions, materials: [] })
  assert.equal(second.status, 'review')
  assert.equal(second.plan.baseRevision, 2)
  assert.equal(second.plan.status, 'pending-approval')

  const reviewConflict = second.plan.conflicts.find((conflict) =>
    String(conflict.subject).toLowerCase().includes('review queue')
  )
  assert.ok(reviewConflict, 'review queue conflict must be retained')
  assert.equal(reviewConflict.status, 'resolved-by-correction')
  assert.ok(reviewConflict.resolution?.evidenceIds?.length > 0)

  const exportConflict = second.plan.conflicts.find((conflict) =>
    String(conflict.subject).toLowerCase().includes('export format')
  )
  assert.ok(exportConflict, 'export format conflict must be retained with both values')
  assert.equal(exportConflict.status, 'unresolved')
  assert.equal(new Set(exportConflict.sides.map((side) => side.value)).size, 2)

  const published2 = await publishJob(env, second)
  assert.equal(published2.version.revision, 3)
  assert.equal(published2.verification.ok, true)

  const answerCloud = await env.pipeline.answer({ projectId: PROJECT_ID, query: 'review queue' })
  assert.equal(answerCloud.matched, true)
  assert.equal(answerCloud.citationCheck.ok, true)
  assert.match(answerCloud.answer, /cloud-first/)
  const l3v3 = await env.pipeline.getL3(PROJECT_ID)
  assert.match(l3v3.text, /review queue: cloud-first/)
  assert.equal(l3v3.text.includes('local-first'), false, 'superseded value must not stay in L3')

  // --- Revocation: old evidence must never be served again ---
  env.registry.revokeSource(`session:${SESSION_1_ID}`, { reason: 'authorization withdrawn by publisher' })
  const verification = await env.pipeline.verifyProject(PROJECT_ID)
  assert.equal(verification.ok, false)
  assert.ok(verification.invalidated.length > 0, 'entries asserted by the revoked session are invalidated')
  assert.ok(verification.counts.invalidated >= 1)

  const l3AfterRevoke = await env.pipeline.getL3(PROJECT_ID)
  assert.equal(l3AfterRevoke.text.includes('local-first'), false)
  assert.equal(l3AfterRevoke.text.includes('42 passing'), false)
  assert.match(l3AfterRevoke.text, /review queue: cloud-first/, 'S2-backed correction survives')

  const answerAfterRevoke = await env.pipeline.answer({ projectId: PROJECT_ID, query: 'test suite' })
  assert.equal(answerAfterRevoke.matched, false)
  assert.equal(answerAfterRevoke.citationCheck.ok, true)

  // --- Rollback must not resurrect revoked facts ---
  const beforeRollback = await env.active()
  const rolled = await env.pipeline.rollback({
    projectId: PROJECT_ID,
    toRevision: 2,
    approvedBy: 'publisher@test.invalid',
    reason: 'rollback acceptance test after source revocation'
  })
  assert.equal(rolled.version.revision, beforeRollback.revision + 1)
  assert.equal(rolled.version.kind, 'rollback')
  assert.ok(rolled.excluded.length > 0, 'revoked entries are reported as excluded by rollback')
  assert.equal(JSON.stringify(rolled.version.entries).includes('local-first'), false)
  const l3Rolled = await env.pipeline.getL3(PROJECT_ID)
  assert.equal(l3Rolled.text.includes('local-first'), false)
  assert.equal(l3Rolled.text.includes('cloud-first'), false)

  const audit = await env.store.readAudit(PROJECT_ID, { limit: 50 })
  const actions = audit.map((event) => event.action)
  assert.ok(actions.includes('publish'))
  assert.ok(actions.includes('rollback'))
  assert.ok(audit.every((event) => event.projectId === PROJECT_ID))
})
