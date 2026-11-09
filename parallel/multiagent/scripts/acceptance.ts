#!/usr/bin/env node
/**
 * Independent M0 acceptance runner.
 *
 * This script does not import the test harness. It creates a disposable project
 * root, runs the four-role synthetic scenario through the public runtime API,
 * and checks the acceptance invariants that matter for the hand-off:
 * traceability, dependency barriers, inbox correlation, immutable artifacts,
 * integration evidence and a terminal run state.
 *
 * Usage:
 *   node scripts/acceptance.ts
 *   node scripts/acceptance.ts --json
 *   node scripts/acceptance.ts --keep
 */
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { buildBoard, formatBoard } from '../src/core/board.ts'
import { TeamRuntime } from '../src/core/engine.ts'
import { createSyntheticPlan } from '../src/core/plan.ts'
import { simulatedWorkerFactory } from '../src/core/simulated-worker.ts'
import { isTerminalTaskState } from '../src/core/types.ts'

interface Check {
  id: string
  ok: boolean
  detail: string
}

const args = new Set(process.argv.slice(2))
const jsonOnly = args.has('--json')
const keep = args.has('--keep')

const root = await import('node:fs/promises').then(({ mkdtemp }) =>
  mkdtemp(path.join(os.tmpdir(), 'openfuture-acceptance-'))
)
const synthetic = createSyntheticPlan({ project: { rootPath: root } })
const runtime = await TeamRuntime.create({
  project: synthetic.project,
  plan: synthetic.plan,
  workerFactory: simulatedWorkerFactory(),
  maxConcurrency: 3
})

try {
  const result = await runtime.run()
  const board = buildBoard(result)
  const checks: Check[] = []
  const add = (id: string, ok: boolean, detail: string): void => {
    checks.push({ id, ok, detail })
  }

  add('run-terminal-completed', result.status === 'completed', `status=${result.status}`)
  add('four-tasks-executed', result.tasks.length === 4, `tasks=${result.tasks.length}`)
  add('all-tasks-terminal', result.tasks.every((task) => isTerminalTaskState(task.state)), result.tasks.map((task) => `${task.role}:${task.state}`).join(', '))

  const research = result.tasks.find((task) => task.role === 'researcher')
  const backend = result.tasks.find((task) => task.role === 'backend')
  const frontend = result.tasks.find((task) => task.role === 'frontend')
  const tester = result.tasks.find((task) => task.role === 'tester')
  add('researcher-succeeded', research?.state === 'succeeded', `state=${research?.state}`)
  add('backend-integrated', backend?.state === 'integrated', `state=${backend?.state}`)
  add('frontend-integrated', frontend?.state === 'integrated', `state=${frontend?.state}`)
  add('tester-succeeded', tester?.state === 'succeeded', `state=${tester?.state}`)

  const traceable = board.traceability.every((row) => row.intentIds.length > 0 && row.taskIds.length > 0)
  add('question-to-task-traceability', board.traceability.length === 4 && traceable, `${board.traceability.length} questions traced`)

  add(
    'research-overlaps-backend',
    Boolean(backend?.startedAt !== undefined && research?.finishedAt !== undefined && backend.startedAt <= research.finishedAt),
    `research=${research?.startedAt}-${research?.finishedAt}, backend=${backend?.startedAt}-${backend?.finishedAt}`
  )
  add(
    'frontend-after-backend',
    Boolean(frontend?.startedAt !== undefined && backend?.finishedAt !== undefined && frontend.startedAt >= backend.finishedAt),
    `backendFinished=${backend?.finishedAt}, frontendStarted=${frontend?.startedAt}`
  )
  add(
    'tester-after-integration-gate',
    Boolean(tester?.startedAt !== undefined && result.integration?.finishedAt !== undefined && tester.startedAt >= result.integration.finishedAt),
    `integrationFinished=${result.integration?.finishedAt}, testerStarted=${tester?.startedAt}`
  )

  add('integration-passed', result.integration?.status === 'passed', `status=${result.integration?.status}`)
  add('integration-six-files', result.integration?.evidence.files === 6, `files=${result.integration?.evidence.files}`)
  add('integration-revision-present', Boolean(result.integration?.evidence.integrationRevision), result.integration?.evidence.integrationRevision ?? 'missing')

  const request = result.messages.find((message) => message.type === 'request' && message.fromRole === 'backend' && message.toRole === 'researcher')
  const reply = result.messages.find((message) => message.type === 'reply' && message.fromRole === 'researcher' && message.toRole === 'backend')
  add('research-request-observed', Boolean(request), `request=${request?.id ?? 'missing'}`)
  add('research-reply-correlated', Boolean(request && reply && reply.correlationId === request.correlationId), `requestCorrelation=${request?.correlationId}, replyCorrelation=${reply?.correlationId}`)
  const researchArtifact = research?.producedArtifacts.find((artifact) => artifact.name === 'research-report')
  add('reply-carries-artifact', Boolean(reply && researchArtifact && reply.artifactRefs.includes(researchArtifact.id)), `artifact=${researchArtifact?.id ?? 'missing'}`)

  const artifactsValid: string[] = []
  for (const task of result.tasks) {
    for (const artifact of task.producedArtifacts) {
      const ok = await runtime.artifacts.verify(artifact)
      if (!ok) artifactsValid.push(`${artifact.id}:invalid`)
    }
  }
  add('artifact-hashes-valid', artifactsValid.length === 0, artifactsValid.length === 0 ? 'all artifacts verified' : artifactsValid.join(', '))

  const sequenceOk = result.events.every((event, index) => event.seq === index + 1)
  add('event-sequence-contiguous', sequenceOk, `events=${result.events.length}`)
  add('no-failed-tasks', board.summary.failed === 0, `failed=${board.summary.failed}`)
  add('concurrency-capped', result.maxConcurrency <= 3, `maxConcurrency=${result.maxConcurrency}`)

  const passed = checks.every((check) => check.ok)
  if (!jsonOnly) {
    console.log('OpenFuture M0 independent acceptance')
    console.log(`root: ${root}`)
    console.log('')
    console.log(formatBoard(board))
    console.log('')
    console.log('Acceptance checks:')
    for (const check of checks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.id} — ${check.detail}`)
    console.log('')
    console.log(passed ? 'RESULT: PASS' : 'RESULT: FAIL')
  }

  if (jsonOnly) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: '1.0',
          result: passed ? 'passed' : 'failed',
          root,
          runId: result.runId,
          projectId: result.projectId,
          planId: result.plan.planId,
          status: result.status,
          durationMs: result.durationMs,
          maxConcurrency: result.maxConcurrency,
          checks,
          summary: board.summary,
          traceability: board.traceability,
          integration: result.integration,
          events: result.events.length,
          messages: result.messages.length,
          artifacts: result.artifacts.map((artifact) => ({ id: artifact.id, name: artifact.name, version: artifact.version, sha256: artifact.sha256, bytes: artifact.bytes }))
        },
        null,
        2
      )
    )
  }

  if (!passed) process.exitCode = 1
} catch (error) {
  if (jsonOnly) {
    console.log(JSON.stringify({ schemaVersion: '1.0', result: 'failed', error: error instanceof Error ? error.stack ?? error.message : String(error) }, null, 2))
  } else {
    console.error('acceptance run crashed:', error)
  }
  process.exitCode = 1
} finally {
  if (keep) {
    if (!jsonOnly) console.log(`\nkept run root: ${root}`)
  } else {
    await rm(root, { recursive: true, force: true })
  }
}
