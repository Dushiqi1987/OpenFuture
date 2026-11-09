import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MOCK_MODEL_PORT,
  ModelClient,
  PROJECT_ID,
  startMockModelServer
} from '../src/index.mjs'
import { makeEnv, runJob, publishJob } from './helpers.mjs'

test('the loopback mock model on port 19733 authenticates and drives the pipeline', async (t) => {
  let server
  try {
    server = await startMockModelServer()
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      t.skip(`port ${MOCK_MODEL_PORT} is already in use; loopback check skipped`)
      return
    }
    throw error
  }
  const env = await makeEnv({
    model: new ModelClient({
      baseUrl: server.url,
      token: server.token,
      timeoutMs: 5000,
      name: 'http-heuristic'
    })
  })
  t.after(async () => {
    await env.cleanup()
    await server.close()
  })

  assert.equal(server.port, MOCK_MODEL_PORT)
  assert.ok(server.url.startsWith(`http://127.0.0.1:${MOCK_MODEL_PORT}`))
  assert.ok(server.token.length >= 16)

  const unauthorized = await fetch(`${server.url}/health`, {
    headers: { authorization: 'Bearer wrong-token' }
  })
  assert.equal(unauthorized.status, 401)
  assert.equal((await unauthorized.json()).error, 'invalid_token')

  const client = env.model
  const health = await client.health()
  assert.equal(health.ok, true)
  assert.equal(health.degraded, false)

  const extracted = await client.extract({ projectId: PROJECT_ID, evidence: [] })
  assert.deepEqual(extracted.candidates, [])

  const job = await runJob(env, { sessions: [env.fixture.sessions[0]], materials: [] })
  assert.equal(job.status, 'review')
  assert.equal(job.plan.status, 'pending-approval')
  assert.equal(job.degraded, false)
  assert.ok(job.plan.ops.length >= 4)

  const published = await publishJob(env, job)
  assert.equal(published.status, 'applied')
  const active = await env.active()
  assert.equal(active.revision, 2)
  const answer = await env.pipeline.answer({ projectId: PROJECT_ID, query: 'review queue' })
  assert.equal(answer.matched, true)
  assert.equal(answer.citationCheck.ok, true)
  assert.match(answer.answer, /local-first/)
  assert.equal(job.plan.model.provider, 'heuristic-mock-http')
})
