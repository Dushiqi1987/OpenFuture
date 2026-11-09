import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FileDreamStore,
  PROJECT_ID,
  publishPlan,
  versionIdFor
} from '../src/index.mjs'
import { makeEnv, runJob, publishJob } from './helpers.mjs'

test('publish requires an explicit approval token bound to the plan', async (t) => {
  const env = await makeEnv()
  t.after(() => env.cleanup())
  const job = await runJob(env, { sessions: [env.fixture.sessions[0]], materials: [] })
  assert.equal(job.plan.status, 'pending-approval')

  await assert.rejects(
    env.pipeline.publish(job.id, { approvedBy: 'publisher@test.invalid' }),
    (error) => error.code === 'APPROVAL_REQUIRED'
  )
  await assert.rejects(
    env.pipeline.publish(job.id, { approvedBy: '', approvalToken: job.plan.planHash }),
    (error) => error.code === 'APPROVAL_REQUIRED'
  )
  await assert.rejects(
    env.pipeline.publish(job.id, { approvedBy: 'publisher@test.invalid', approvalToken: 'tampered' }),
    (error) => error.code === 'APPROVAL_REQUIRED'
  )
  assert.equal((await env.active()).revision, 1)

  const published = await publishJob(env, job)
  assert.equal(published.status, 'applied')
  const active = await env.active()
  assert.equal(active.revision, 2)
  assert.equal(active.publishId, job.plan.publishId)
  assert.equal(active.planHash, job.plan.planHash)
  assert.equal(active.approval.approvedBy, 'publisher@test.invalid')
  const audit = await env.store.readAudit(PROJECT_ID)
  assert.equal(audit.filter((event) => event.action === 'publish').length, 1)
  assert.equal(audit.at(-1).revision, 2)
})

test('duplicate publish is idempotent and cannot create a second version', async (t) => {
  const env = await makeEnv()
  t.after(() => env.cleanup())
  const job = await runJob(env, { sessions: [env.fixture.sessions[0]], materials: [] })
  await publishJob(env, job)
  const versionCount = (await env.store.listVersions(PROJECT_ID)).length

  const replay = await publishPlan({
    store: env.store,
    registry: env.registry,
    plan: job.plan,
    approval: { approvedBy: 'publisher@test.invalid', approvalToken: job.plan.planHash },
    now: Date.now()
  })
  assert.equal(replay.status, 'idempotent')
  assert.equal(replay.version.revision, 2)
  assert.equal((await env.store.listVersions(PROJECT_ID)).length, versionCount)
  assert.equal((await env.store.readAudit(PROJECT_ID)).filter((event) => event.action === 'publish').length, 1)
})

test('a plan built on an old active revision is rejected as stale', async (t) => {
  const env = await makeEnv()
  t.after(() => env.cleanup())
  const stale = await runJob(env, { sessions: [env.fixture.sessions[0]], materials: [] })
  const newer = await runJob(env, {
    sessions: [env.fixture.sessions[0], env.fixture.sessions[1]],
    materials: []
  })
  assert.equal(stale.plan.baseRevision, 1)
  assert.equal(newer.plan.baseRevision, 1)
  await publishJob(env, newer)
  assert.equal((await env.active()).revision, 2)

  await assert.rejects(
    env.pipeline.publish(stale.id, {
      approvedBy: 'publisher@test.invalid',
      approvalToken: stale.plan.planHash
    }),
    (error) => error.code === 'PLAN_STALE'
  )
  assert.equal((await env.active()).revision, 2)
})

test('the file store keeps the active version across a reload and recovers an orphaned version', async (t) => {
  const env = await makeEnv()
  t.after(() => env.cleanup())
  const job = await runJob(env, { sessions: [env.fixture.sessions[0]], materials: [] })
  await publishJob(env, job)

  const reloaded = new FileDreamStore({ root: env.root })
  const active = await reloaded.getActive(PROJECT_ID)
  assert.equal(active.revision, 2)
  assert.equal(active.planHash, job.plan.planHash)

  const revision = active.revision + 1
  const orphan = {
    ...structuredClone(active),
    versionId: versionIdFor(PROJECT_ID, revision),
    revision,
    parentVersionId: active.versionId,
    parentRevision: active.revision,
    createdAt: Date.now(),
    createdBy: 'publisher@test.invalid',
    kind: 'publish',
    publishId: 'publish:crash-recovery-test',
    planHash: 'plan-hash:crash-recovery-test',
    jobId: 'job:crash-recovery-test'
  }
  await assert.rejects(
    reloaded.simulateCrashAfterVersion(PROJECT_ID, orphan),
    /simulated crash after version write/
  )
  assert.equal((await reloaded.getActive(PROJECT_ID)).revision, 2)
  const recovered = await reloaded.commit(PROJECT_ID, {
    expectedRevision: 2,
    version: orphan,
    approval: { approvedBy: 'publisher@test.invalid' }
  })
  assert.equal(recovered.kind, 'idempotent')
  assert.equal((await reloaded.getActive(PROJECT_ID)).revision, 3)
  assert.equal((await reloaded.getActive(PROJECT_ID)).publishId, orphan.publishId)
})
