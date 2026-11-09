import test from 'node:test'
import assert from 'node:assert/strict'

import { BudgetMeter, DreamError, PROJECT_ID } from '../src/index.mjs'
import { makeEnv } from './helpers.mjs'

test('BudgetMeter enforces per-run and shared daily call/token limits', () => {
  const clock = () => Date.UTC(2026, 0, 15, 12, 0, 0)
  const ledger = new Map()
  const meter = new BudgetMeter({
    clock,
    dailyLedger: ledger,
    limits: { maxCallsPerRun: 2, maxTokensPerRun: 100, maxCallsPerDay: 3, maxTokensPerDay: 150 }
  })
  meter.beginRun()
  meter.begin({ calls: 1, tokens: 20 })
  meter.begin({ calls: 1, tokens: 20 })
  assert.throws(
    () => meter.begin({ calls: 1, tokens: 1 }),
    (error) => error.code === 'BUDGET_EXCEEDED'
  )
  assert.equal(meter.snapshot().daily.calls, 2)

  meter.beginRun()
  meter.begin({ calls: 1, tokens: 10 })
  assert.throws(
    () => meter.begin({ calls: 1, tokens: 1 }),
    (error) => error.code === 'BUDGET_EXCEEDED'
  )
  assert.throws(
    () => meter.finish({ tokens: 200 }),
    (error) => error.code === 'BUDGET_EXCEEDED'
  )
})

test('a run that exceeds its model-call budget fails with BUDGET_EXCEEDED and stops', async (t) => {
  const env = await makeEnv()
  t.after(() => env.cleanup())
  const job = await env.pipeline.start({
    projectId: PROJECT_ID,
    sessions: [env.fixture.sessions[0]],
    materials: [],
    budgetLimits: {
      maxCallsPerRun: 1,
      maxTokensPerRun: 100000,
      maxCallsPerDay: 100,
      maxTokensPerDay: 100000
    }
  })
  assert.equal(job.status, 'failed')
  assert.equal(job.error.code, 'BUDGET_EXCEEDED')
  assert.ok(['light', 'deep'].includes(job.phase))
  assert.ok(job.budget.run.calls <= 1)
  assert.equal((await env.active()).revision, 1)
})

test('retryable model failures stop after maxAttempts with the last model error', async (t) => {
  const calls = { extract: 0, adjudicate: 0 }
  const failing = {
    name: 'always-failing',
    async health() {
      return { ok: false }
    },
    async extract() {
      calls.extract += 1
      throw new DreamError('MODEL_UNAVAILABLE', 'synthetic upstream failure', { retryable: true })
    },
    async adjudicate() {
      calls.adjudicate += 1
      throw new DreamError('MODEL_UNAVAILABLE', 'synthetic upstream failure', { retryable: true })
    }
  }
  const env = await makeEnv({ model: failing })
  t.after(() => env.cleanup())
  const job = await env.pipeline.start({
    projectId: PROJECT_ID,
    sessions: [env.fixture.sessions[0]],
    materials: []
  })
  assert.equal(job.status, 'failed')
  assert.equal(job.error.code, 'RETRY_EXHAUSTED')
  assert.equal(calls.extract, 2)
  assert.equal(job.attempts, 2)
  assert.equal((await env.active()).revision, 1)
})

test('an aborted signal prevents a queued job from starting', async (t) => {
  const env = await makeEnv()
  t.after(() => env.cleanup())
  const job = await env.pipeline.createJob({
    projectId: PROJECT_ID,
    sessions: [env.fixture.sessions[0]],
    materials: []
  })
  const controller = new AbortController()
  controller.abort()
  const result = await env.pipeline.run(job.id, { signal: controller.signal })
  assert.equal(result.status, 'cancelled')
  assert.equal(env.state.policyCalls, 0)
  assert.equal((await env.store.listVersions(PROJECT_ID)).length, 1)
})
