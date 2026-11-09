import test from 'node:test'
import assert from 'node:assert/strict'

import { DreamingScheduler, PROJECT_ID } from '../src/index.mjs'
import { makeEnv } from './helpers.mjs'

function schedulerFor(env, options = {}, topLevelEnabled = true) {
  return new DreamingScheduler({
    pipeline: env.pipeline,
    enabled: topLevelEnabled,
    projects: {
      [PROJECT_ID]: {
        enabled: true,
        authorized: true,
        minIntervalMs: 0,
        maxConcurrentTasks: 1,
        maxTasksPerDay: 4,
        ...options
      }
    },
    sourcesProvider: async () => ({ sessions: [env.fixture.sessions[0]], materials: [] }),
    intervalMs: 60_000
  })
}

test('scheduler is disabled by default and performs no work', async () => {
  const env = await makeEnv()
  try {
    const scheduler = new DreamingScheduler({
      pipeline: env.pipeline,
      enabled: false,
      projects: { [PROJECT_ID]: { enabled: true, authorized: true } },
      sourcesProvider: async () => ({ sessions: [env.fixture.sessions[0]], materials: [] })
    })
    assert.equal(scheduler.enabled, false)
    const result = await scheduler.tick()
    assert.equal(result.skipped, 'disabled')
    assert.equal(env.pipeline.listJobs().length, 0)
    assert.equal((await env.active()).revision, 1)
  } finally {
    await env.cleanup()
  }
})

test('scheduler skips projects that were not explicitly authorized', async () => {
  const env = await makeEnv()
  try {
    const scheduler = schedulerFor(env, { authorized: false })
    const result = await scheduler.tick()
    assert.ok(result.skipped.some((item) => item.projectId === PROJECT_ID && item.reason === 'not-authorized'))
    assert.equal(env.pipeline.listJobs().length, 0)
    assert.equal(result.status.running, 0)
  } finally {
    await env.cleanup()
  }
})

test('scheduler enforces interval and daily task limits', async () => {
  const env = await makeEnv()
  try {
    const scheduler = schedulerFor(env, { minIntervalMs: 60_000, maxTasksPerDay: 4 })
    const first = await scheduler.tick()
    assert.equal(first.started.length, 1)
    assert.equal(env.pipeline.listJobs().length, 1)
    const second = await scheduler.tick()
    assert.ok(second.skipped.some((item) => item.reason === 'interval'))
    assert.equal(env.pipeline.listJobs().length, 1)

    scheduler.projects.get(PROJECT_ID).minIntervalMs = 0
    scheduler.projects.get(PROJECT_ID).maxTasksPerDay = 1
    const third = await scheduler.tick()
    assert.ok(third.skipped.some((item) => item.reason === 'daily-task-limit'))
    assert.equal(env.pipeline.listJobs().length, 1)
  } finally {
    await env.cleanup()
  }
})

test('an enabled round stops at review and never publishes on its own', async () => {
  const env = await makeEnv()
  try {
    const scheduler = schedulerFor(env, {})
    const result = await scheduler.tick()
    assert.equal(result.started.length, 1)
    const jobs = env.pipeline.listJobs()
    assert.equal(jobs.length, 1)
    const job = env.pipeline.getJob(jobs[0].id)
    assert.equal(job.status, 'review')
    assert.equal(job.plan.status, 'pending-approval')
    assert.equal(job.trigger, 'scheduled')
    assert.equal((await env.active()).revision, 1)
    assert.equal(scheduler.status().rounds, 1)
  } finally {
    await env.cleanup()
  }
})
