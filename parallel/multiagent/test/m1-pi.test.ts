import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { defaultProjectPolicy } from '../src/core/plan.ts'
import type { Intent, IntentKind, Plan, RoleId, TaskRecord, TaskSpec } from '../src/core/types.ts'
import { TeamRuntime } from '../src/core/engine.ts'
import { piWorkerFactory } from '../src/pi/worker.ts'
import { startMockPiServer, type MockPiServer } from '../scripts/mock-pi-server.ts'
import { makeTempRoot, waitFor } from './helpers.ts'

interface PiTaskDefinition {
  id: string
  role: RoleId
  title: string
  scenario: string
  maxAttempts?: number
  timeoutMs?: number
}

interface PiFixture {
  root: string
  runtime: TeamRuntime
  cleanup: () => Promise<void>
}

const kindByRole: Record<RoleId, IntentKind> = {
  researcher: 'research',
  backend: 'backend',
  frontend: 'frontend',
  tester: 'test-integration'
}

function makePiPlan(definitions: PiTaskDefinition[], root: string): Plan {
  const project = defaultProjectPolicy({
    projectId: 'm1-pi-project',
    name: 'M1 Pi Adapter Acceptance',
    rootPath: root,
    maxConcurrency: 2
  })
  const sourceQuestions = definitions.map((definition, index) => ({
    id: `q-${definition.id}`,
    index,
    text: definition.title
  }))
  const intents: Intent[] = definitions.map((definition) => ({
    id: `intent-${definition.id}`,
    kind: kindByRole[definition.role],
    text: definition.title,
    sourceQuestionIds: [`q-${definition.id}`],
    taskIds: [definition.id]
  }))
  const tasks: TaskSpec[] = definitions.map((definition) => ({
    id: definition.id,
    intentId: `intent-${definition.id}`,
    title: definition.title,
    role: definition.role,
    dependsOn: [],
    inputArtifacts: [],
    outputs: [],
    acceptance: [`Pi session scenario ${definition.scenario} completes`],
    memoryView: 'off',
    writeScope: [],
    budget: {
      maxTurns: 5,
      maxTokens: 10_000,
      timeoutMs: definition.timeoutMs ?? 8_000,
      maxAttempts: definition.maxAttempts ?? 2,
      requestTimeoutMs: 2_000
    },
    baseRevision: project.baseRevision
  }))

  return {
    schemaVersion: '1.0',
    planId: 'm1-pi-plan',
    projectId: project.projectId,
    runId: 'm1-pi-run',
    mainGoal: 'Validate the Pi adapter lifecycle against the local mock on port 19734',
    confidence: 1,
    createdAt: Date.now(),
    sourceQuestions,
    intents,
    tasks,
    budget: {
      maxTokens: 60_000,
      maxTurns: 40,
      maxConcurrency: 2
    }
  }
}

async function makePiFixture(definitions: PiTaskDefinition[]): Promise<PiFixture> {
  const root = await makeTempRoot('openfuture-m1-')
  try {
    const project = defaultProjectPolicy({
      projectId: 'm1-pi-project',
      name: 'M1 Pi Adapter Acceptance',
      rootPath: root,
      maxConcurrency: 2
    })
    const plan = makePiPlan(definitions, root)
    const scenarios = new Map(definitions.map((definition) => [definition.id, definition.scenario]))
    const runtime = await TeamRuntime.create({
      project,
      plan,
      maxConcurrency: 2,
      workerFactory: piWorkerFactory({
        endpoint: 'http://127.0.0.1:19734',
        requestTimeoutMs: 2_000,
        scenarioFor: (task) => scenarios.get(task.id)
      })
    })
    return {
      root,
      runtime,
      cleanup: async () => {
        const { rm } = await import('node:fs/promises')
        await rm(root, { recursive: true, force: true })
      }
    }
  } catch (error) {
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

function taskOf(result: Awaited<ReturnType<TeamRuntime['run']>>, id: string): TaskRecord {
  const task = result.tasks.find((candidate) => candidate.id === id)
  if (!task) throw new Error(`run has no task ${id}`)
  return task
}

describe('M1 Pi adapter over the port 19734 mock', () => {
  let mock: MockPiServer

  before(async () => {
    mock = await startMockPiServer({ port: 19734 })
  })

  after(async () => {
    await mock.close()
  })

  it('runs two independent Pi sessions in parallel and bridges cross-role inbox messages', async () => {
    const fixture = await makePiFixture([
      { id: 'pi-research', role: 'researcher', title: 'Pi research session', scenario: 'message-researcher' },
      { id: 'pi-backend', role: 'backend', title: 'Pi backend session', scenario: 'message-backend' }
    ])
    try {
      const result = await fixture.runtime.run()
      assert.equal(result.status, 'completed')
      assert.equal(result.tasks.length, 2)
      const research = taskOf(result, 'pi-research')
      const backend = taskOf(result, 'pi-backend')
      assert.equal(research.state, 'succeeded')
      assert.equal(backend.state, 'succeeded')

      assert.ok(research.startedAt !== undefined && research.finishedAt !== undefined)
      assert.ok(backend.startedAt !== undefined && backend.finishedAt !== undefined)
      assert.ok(research.startedAt! < backend.finishedAt!, 'research starts before backend finishes')
      assert.ok(backend.startedAt! < research.finishedAt!, 'backend starts before research finishes')

      const researchMessages = result.messages.filter((message) => message.correlationId === 'pi:research')
      assert.ok(
        researchMessages.some((message) => message.type === 'request' && message.fromRole === 'backend'),
        'backend request is recorded'
      )
      assert.ok(
        researchMessages.some((message) => message.type === 'reply' && message.fromRole === 'researcher'),
        'researcher reply is correlated'
      )
      assert.ok(
        research.progress.some((entry) => entry.message.startsWith('pi-session:')),
        'the adapter records its session id for resumability'
      )
      assert.ok(backend.progress.some((entry) => entry.message.startsWith('pi-session:')))

      const stats = mock.stats
      assert.ok(stats.maxActive >= 2, `expected parallel sessions, got maxActive=${stats.maxActive}`)
      const sessions = stats.sessions.filter((session) => session.taskId === 'pi-research' || session.taskId === 'pi-backend')
      assert.ok(sessions.some((session) => session.taskId === 'pi-research' && session.deltas >= 1))
      assert.ok(sessions.some((session) => session.taskId === 'pi-backend' && session.deltas >= 1))
    } finally {
      await fixture.cleanup()
    }
  })

  it('rejects an out-of-scope write tool request and fails the task without retrying', async () => {
    const fixture = await makePiFixture([
      {
        id: 'pi-tool',
        role: 'researcher',
        title: 'Pi tool boundary',
        scenario: 'tool-denied',
        maxAttempts: 1
      }
    ])
    try {
      const result = await fixture.runtime.run()
      assert.equal(result.status, 'failed')
      const task = taskOf(result, 'pi-tool')
      assert.equal(task.state, 'failed')
      assert.equal(task.error?.code, 'pi-tool-denied')
      assert.equal(task.attempt, 1)
      assert.equal(task.attempts.length, 1)
      assert.equal(task.fileChanges.length, 0)
      assert.equal(mock.stats.sessions.filter((session) => session.taskId === 'pi-tool').length, 1)
    } finally {
      await fixture.cleanup()
    }
  })

  it('retries a rate-limited Pi session and starts a fresh session after resume is refused', async () => {
    const fixture = await makePiFixture([
      {
        id: 'pi-retry',
        role: 'researcher',
        title: 'Pi retry session',
        scenario: 'fail-once',
        maxAttempts: 2
      }
    ])
    try {
      const before = mock.stats
      const result = await fixture.runtime.run()
      assert.equal(result.status, 'completed')
      const task = taskOf(result, 'pi-retry')
      assert.equal(task.state, 'succeeded')
      assert.equal(task.attempt, 2)
      assert.equal(task.attempts.length, 2)
      assert.equal(task.attempts[0]?.error?.code, 'rate-limited')
      const retryEvent = result.events.find(
        (event) => event.type === 'task.retry_scheduled' && event.taskId === 'pi-retry'
      )
      assert.ok(retryEvent, 'retry is visible in the event log')
      assert.equal(retryEvent?.payload.code, 'rate-limited')
      assert.equal(mock.stats.failed - before.failed, 1)
      assert.equal(mock.stats.completed - before.completed, 1)
    } finally {
      await fixture.cleanup()
    }
  })

  it('cancels a long-running Pi session when the user stops the run', async () => {
    const fixture = await makePiFixture([
      {
        id: 'pi-long',
        role: 'researcher',
        title: 'Pi long stream',
        scenario: 'long',
        maxAttempts: 1,
        timeoutMs: 10_000
      }
    ])
    try {
      const running = fixture.runtime.run()
      await waitFor(() => mock.stats.active >= 1, 2_000, 'a running Pi session')
      const stopped = await fixture.runtime.stop('pi-test-stop')
      const result = await running
      assert.equal(result.status, 'cancelled')
      assert.equal(result.stopReason, 'pi-test-stop')
      assert.equal(stopped.runId, result.runId)
      const task = taskOf(result, 'pi-long')
      assert.equal(task.state, 'cancelled')
      await waitFor(() => mock.stats.cancelled >= 1, 2_000, 'the mock session to be cancelled')
    } finally {
      await fixture.cleanup()
    }
  })

  it('resumes the same Pi session after a stream disconnect without creating a new session', async () => {
    const fixture = await makePiFixture([
      {
        id: 'pi-resume',
        role: 'researcher',
        title: 'Pi resumable session',
        scenario: 'disconnect-once',
        maxAttempts: 2
      }
    ])
    try {
      const result = await fixture.runtime.run()
      assert.equal(result.status, 'completed')
      const task = taskOf(result, 'pi-resume')
      assert.equal(task.state, 'succeeded')
      assert.equal(task.attempt, 2)
      assert.equal(task.attempts.length, 2)
      assert.equal(task.attempts[0]?.error?.code, 'pi-stream-disconnected')
      assert.ok(task.progress.some((entry) => entry.message.startsWith('pi-resumed:')), 'resume is recorded')

      const sessions = mock.stats.sessions.filter((session) => session.taskId === 'pi-resume')
      assert.equal(sessions.length, 1, 'the same session is reused rather than silently recreated')
      assert.equal(sessions[0]?.status, 'completed')
      assert.ok(mock.stats.resumes >= 1)
    } finally {
      await fixture.cleanup()
    }
  })
})
