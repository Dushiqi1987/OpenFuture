import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { buildBoard, formatBoard } from '../src/core/board.ts'
import { TeamRuntime } from '../src/core/engine.ts'
import { errorCode, TaskFailureError } from '../src/core/errors.ts'
import { SuperAgent, defaultProjectPolicy } from '../src/core/plan.ts'
import { simulatedWorkerFactory } from '../src/core/simulated-worker.ts'
import type { Plan, ProjectPolicy } from '../src/core/types.ts'
import { createSequentialIdFactory, sleep, type Clock } from '../src/core/util.ts'
import { makeSyntheticFixture, makeTempRoot, waitFor } from './helpers.ts'

const clock: Clock = { now: () => 1_700_000_000_000 }

function singleResearchPlan(project: ProjectPolicy): Plan {
  const agent = new SuperAgent({ idFactory: createSequentialIdFactory('failure'), clock })
  const decision = agent.plan({
    project,
    mode: 'team',
    questions: [{ id: 'q1', index: 0, text: '调研本地优先 Agent 的竞品并给出处' }]
  })
  assert.ok(decision.plan, decision.reason)
  return decision.plan
}

test('a retryable model 429 is scheduled and the second attempt succeeds', async (t) => {
  let attempts = 0
  const realResearcher = simulatedWorkerFactory()({ role: 'researcher' })
  const flakyResearcher = {
    id: 'flaky-researcher',
    async run(ctx: Parameters<typeof realResearcher.run>[0]) {
      attempts += 1
      if (attempts === 1) {
        throw new TaskFailureError('rate-limited', '429 provider overloaded', {
          retryable: true,
          retryAfterMs: 30
        })
      }
      return await realResearcher.run(ctx)
    }
  }
  const fixture = await makeSyntheticFixture({
    workerFactory: simulatedWorkerFactory({ overrides: { researcher: flakyResearcher } })
  })
  t.after(async () => await fixture.cleanup())

  const result = await fixture.runtime.run()

  assert.equal(result.status, 'completed')
  const research = result.tasks.find((task) => task.role === 'researcher')
  assert.ok(research)
  assert.equal(research.state, 'succeeded')
  assert.equal(research.attempt, 2)
  assert.equal(research.attempts.length, 2)
  assert.equal(research.attempts[0]?.status, 'failed')
  assert.equal(research.attempts[0]?.error?.code, 'rate-limited')
  assert.equal(research.attempts[1]?.status, 'succeeded')
  const retry = result.events.find((event) => event.type === 'task.retry_scheduled')
  assert.ok(retry)
  assert.equal(retry.taskId, research.id)
  assert.equal(retry.payload.code, 'rate-limited')
  assert.equal(retry.payload.delayMs, 30)
  assert.equal(result.status, 'completed')
})

test('a hung worker is stopped by the task timeout and reported as retryable failure', async (t) => {
  const root = await makeTempRoot('openfuture-timeout-')
  t.after(async () => await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })))
  const project = defaultProjectPolicy({ rootPath: root })
  const plan = singleResearchPlan(project)
  const task = plan.tasks[0]
  assert.ok(task)
  task.budget = { ...task.budget, timeoutMs: 120, maxAttempts: 1 }

  const runtime = await TeamRuntime.create({
    project,
    plan,
    workerFactory: () => ({
      id: 'hung-researcher',
      async run(ctx) {
        await sleep(5_000, ctx.signal)
        return { summary: 'unreachable' }
      }
    })
  })

  const startedAt = Date.now()
  const result = await runtime.run()
  const elapsed = Date.now() - startedAt

  assert.equal(result.status, 'failed')
  assert.ok(elapsed < 1500, `timeout should fire promptly, took ${elapsed}ms`)
  const research = result.tasks[0]
  assert.ok(research)
  assert.equal(research.state, 'failed')
  assert.equal(research.error?.code, 'task-timeout')
  assert.equal(research.error?.retryable, true)
  assert.equal(research.error?.escalatedToSuperAgent, true)
  assert.equal(research.attempts[0]?.status, 'failed')
  assert.ok(result.events.some((event) => event.type === 'task.state' && event.taskId === research.id && event.payload.code === 'task-timeout'))
})

test('user stop cancels running work and records a cancelled run', async (t) => {
  const fixture = await makeSyntheticFixture({
    workerFactory: simulatedWorkerFactory({
      overrides: {
        researcher: {
          id: 'long-researcher',
          async run(ctx) {
            await sleep(5_000, ctx.signal)
            return { summary: 'never reached' }
          }
        }
      }
    })
  })
  t.after(async () => await fixture.cleanup())

  const runPromise = fixture.runtime.run()
  const research = fixture.runtime.store.tasks.find((task) => task.role === 'researcher')
  assert.ok(research)
  await waitFor(() => fixture.runtime.store.task(research.id).state === 'running', 2000, 'researcher running')

  const startedAt = Date.now()
  const result = await fixture.runtime.stop('acceptance-stop')
  const elapsed = Date.now() - startedAt
  assert.equal(await runPromise, result)

  assert.equal(result.status, 'cancelled')
  assert.equal(result.stopReason, 'acceptance-stop')
  assert.ok(elapsed < 3000, `stop should settle promptly, took ${elapsed}ms`)
  assert.equal(result.tasks.find((task) => task.id === research.id)?.state, 'cancelled')
  assert.ok(result.tasks.every((task) => ['cancelled', 'succeeded', 'integrated', 'failed'].includes(task.state)))
  assert.ok(result.events.some((event) => event.type === 'run.cancelled'))
  assert.ok(result.events.some((event) => event.type === 'task.cancelled' && event.taskId === research.id))
})

test('tester failure keeps integrated code and evidence and names the responsible role', async (t) => {
  const fixture = await makeSyntheticFixture({
    workerFactory: simulatedWorkerFactory({
      overrides: {
        tester: {
          id: 'failing-tester',
          async run() {
            throw new TaskFailureError('assertion-failed', 'settings endpoint returned 500 during regression', {
              retryable: false
            })
          }
        }
      }
    })
  })
  t.after(async () => await fixture.cleanup())

  const result = await fixture.runtime.run()

  assert.equal(result.status, 'failed')
  assert.equal(result.integration?.status, 'passed')
  const backend = result.tasks.find((task) => task.role === 'backend')
  const frontend = result.tasks.find((task) => task.role === 'frontend')
  const tester = result.tasks.find((task) => task.role === 'tester')
  assert.ok(backend && frontend && tester)
  assert.equal(backend.state, 'integrated')
  assert.equal(frontend.state, 'integrated')
  assert.equal(tester.state, 'failed')
  assert.equal(tester.error?.code, 'assertion-failed')
  assert.equal(tester.error?.escalatedToSuperAgent, true)
  assert.equal(tester.attempts.length, 1)

  for (const applied of result.integration?.applied ?? []) {
    for (const file of applied.files) {
      const content = await readFile(
        path.join(fixture.root, '.scratch/multiagent/integration', fixture.runtime.runId, file),
        'utf8'
      )
      assert.ok(content.length > 0, `${file} remains available as failure evidence`)
    }
  }

  const board = buildBoard(result)
  const rendered = formatBoard(board)
  assert.match(rendered, /tester/)
  assert.match(rendered, /assertion-failed|settings endpoint returned 500/)
  assert.equal(board.summary.failed, 1)
})

test('resume recovers an interrupted attempt and completes the run', async (t) => {
  const fixture = await makeSyntheticFixture()
  t.after(async () => await fixture.cleanup())

  const research = fixture.runtime.store.tasks.find((task) => task.role === 'researcher')
  assert.ok(research)
  const now = Date.now()
  fixture.runtime.store.updateTask(research.id, {
    state: 'running',
    attempt: 1,
    startedAt: now,
    attempts: [{ attempt: 1, startedAt: now, status: 'running', progress: [] }],
    progress: []
  })
  fixture.runtime.store.emit('task.state', research.id, { state: 'running', attempt: 1 })
  await fixture.runtime.store.flush()

  const resumed = await TeamRuntime.resume({
    project: fixture.project,
    runId: fixture.runtime.runId,
    workerFactory: simulatedWorkerFactory()
  })
  const result = await resumed.run()

  assert.equal(result.status, 'completed')
  assert.ok(result.events.some((event) => event.type === 'run.recovered'))
  const recovered = result.tasks.find((task) => task.id === research.id)
  assert.ok(recovered)
  assert.equal(recovered.recovered, true)
  assert.equal(recovered.attempts[0]?.status, 'failed')
  assert.equal(recovered.attempts[0]?.error?.code, 'run-recovered')
  assert.equal(recovered.attempts.length, 2)
  assert.equal(recovered.state, 'succeeded')
})

test('starting a duplicate run is rejected with run-exists', async (t) => {
  const fixture = await makeSyntheticFixture()
  t.after(async () => await fixture.cleanup())

  await assert.rejects(
    TeamRuntime.create({
      project: fixture.project,
      plan: fixture.plan,
      workerFactory: simulatedWorkerFactory()
    }),
    (error) => errorCode(error) === 'run-exists'
  )
})
