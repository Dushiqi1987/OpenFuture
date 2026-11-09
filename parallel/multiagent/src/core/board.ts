/**
 * Observable projections for a run. The CLI and the acceptance runner consume
 * these structures instead of reaching into RunStore internals.
 */

import type { RunResult } from './engine.ts'
import {
  BOARD_SCHEMA_VERSION,
  TERMINAL_TASK_STATES,
  type IntegrationReport,
  type RunEvent,
  type RunStatus,
  type TaskError,
  type TaskRecord,
  type TaskState
} from './types.ts'

export interface BoardArtifact {
  id: string
  name: string
  version: string
  kind: string
  bytes: number
  sha256: string
}

export interface BoardTask {
  id: string
  title: string
  role: string
  intentId: string
  agentId: string
  state: TaskState
  dependsOn: string[]
  attempt: number
  maxAttempts: number
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  integratedAt?: number
  waiting?: { correlationId: string; since: number; timeoutAt: number }
  error?: TaskError
  artifacts: BoardArtifact[]
  files: string[]
  checks: { id: string; status: string; detail?: string }[]
  progress: { at: number; message: string; fraction?: number }[]
  recovered?: boolean
}

export interface BoardLane {
  role: string
  tasks: BoardTask[]
}

export interface BoardIntent {
  id: string
  kind: string
  text: string
  questionIds: string[]
  taskIds: string[]
}

export interface BoardTrace {
  questionId: string
  index: number
  text: string
  intentIds: string[]
  taskIds: string[]
}

export interface BoardSummary {
  total: number
  byState: Record<string, number>
  succeeded: number
  integrated: number
  failed: number
  cancelled: number
  running: number
  waiting: number
  artifacts: number
  messages: number
  events: number
}

export interface BoardEvent {
  seq: number
  type: string
  at: number
  taskId?: string
  payload: Record<string, unknown>
}

export interface RunBoard {
  schemaVersion: string
  runId: string
  projectId: string
  planId: string
  mainGoal: string
  status: RunStatus
  stopReason?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  durationMs: number
  maxConcurrency: number
  lanes: BoardLane[]
  intents: BoardIntent[]
  traceability: BoardTrace[]
  summary: BoardSummary
  integration?: IntegrationReport
  events: BoardEvent[]
}

const STATES: TaskState[] = [
  'planned',
  'ready',
  'running',
  'needs_input',
  'succeeded',
  'failed',
  'cancelled',
  'reviewed',
  'integrated'
]

function durationOf(task: TaskRecord, now: number): number | undefined {
  if (task.startedAt === undefined) return undefined
  return Math.max(0, (task.finishedAt ?? now) - task.startedAt)
}

function projectTask(task: TaskRecord, now: number): BoardTask {
  return {
    id: task.id,
    title: task.title,
    role: task.role,
    intentId: task.intentId,
    agentId: task.agentId,
    state: task.state,
    dependsOn: [...task.dependsOn],
    attempt: task.attempt,
    maxAttempts: task.budget.maxAttempts,
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
    ...(durationOf(task, now) !== undefined ? { durationMs: durationOf(task, now) } : {}),
    ...(task.integratedAt !== undefined ? { integratedAt: task.integratedAt } : {}),
    ...(task.waiting ? { waiting: { ...task.waiting } } : {}),
    ...(task.error ? { error: { ...task.error } } : {}),
    artifacts: task.producedArtifacts.map((ref) => ({
      id: ref.id,
      name: ref.name,
      version: ref.version,
      kind: ref.kind,
      bytes: ref.bytes,
      sha256: ref.sha256
    })),
    files: task.fileChanges.map((change) => change.path),
    checks: task.checks.map((check) => ({
      id: check.id,
      status: check.status,
      ...(check.detail !== undefined ? { detail: check.detail } : {})
    })),
    progress: task.progress.map((entry) => ({
      at: entry.at,
      message: entry.message,
      ...(entry.fraction !== undefined ? { fraction: entry.fraction } : {})
    })),
    ...(task.recovered ? { recovered: true } : {})
  }
}

function summarize(result: RunResult, now: number): BoardSummary {
  const byState: Record<string, number> = {}
  for (const state of STATES) byState[state] = 0
  for (const task of result.tasks) {
    byState[task.state] = (byState[task.state] ?? 0) + 1
  }
  return {
    total: result.tasks.length,
    byState,
    succeeded: result.tasks.filter(
      (task) => task.state === 'succeeded' || task.state === 'reviewed' || task.state === 'integrated'
    ).length,
    integrated: result.tasks.filter((task) => task.state === 'integrated').length,
    failed: result.tasks.filter((task) => task.state === 'failed').length,
    cancelled: result.tasks.filter((task) => task.state === 'cancelled').length,
    running: result.tasks.filter((task) => task.state === 'running').length,
    waiting: result.tasks.filter((task) => task.state === 'needs_input').length,
    artifacts: result.artifacts.length,
    messages: result.messages.length,
    events: result.events.length
  }
}

export function buildBoard(result: RunResult, options: { eventLimit?: number; now?: number } = {}): RunBoard {
  const now = options.now ?? Date.now()
  const eventLimit = options.eventLimit ?? 500
  const events: BoardEvent[] = result.events.slice(-eventLimit).map((event: RunEvent) => ({
    seq: event.seq,
    type: event.type,
    at: event.at,
    ...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
    payload: event.payload
  }))

  const roles: string[] = []
  for (const task of result.tasks) {
    if (!roles.includes(task.role)) roles.push(task.role)
  }

  return {
    schemaVersion: BOARD_SCHEMA_VERSION,
    runId: result.runId,
    projectId: result.projectId,
    planId: result.plan.planId,
    mainGoal: result.plan.mainGoal,
    status: result.status,
    ...(result.stopReason ? { stopReason: result.stopReason } : {}),
    createdAt: result.plan.createdAt,
    ...(result.startedAt !== undefined ? { startedAt: result.startedAt } : {}),
    ...(result.finishedAt !== undefined ? { finishedAt: result.finishedAt } : {}),
    durationMs: result.durationMs,
    maxConcurrency: result.maxConcurrency,
    lanes: roles.map((role) => ({
      role,
      tasks: result.tasks.filter((task) => task.role === role).map((task) => projectTask(task, now))
    })),
    intents: result.plan.intents.map((intent) => ({
      id: intent.id,
      kind: intent.kind,
      text: intent.text,
      questionIds: [...intent.sourceQuestionIds],
      taskIds: [...intent.taskIds]
    })),
    traceability: result.plan.sourceQuestions.map((question) => {
      const intents = result.plan.intents.filter((intent) => intent.sourceQuestionIds.includes(question.id))
      const taskIds = intents.flatMap((intent) => intent.taskIds)
      return {
        questionId: question.id,
        index: question.index,
        text: question.text,
        intentIds: intents.map((intent) => intent.id),
        taskIds
      }
    }),
    summary: summarize(result, now),
    ...(result.integration ? { integration: result.integration } : {}),
    events
  }
}

function iso(timestamp: number | undefined): string {
  return timestamp === undefined ? '-' : new Date(timestamp).toISOString()
}

function label(status: RunStatus): string {
  switch (status) {
    case 'completed':
      return 'COMPLETED'
    case 'failed':
      return 'FAILED'
    case 'cancelled':
      return 'CANCELLED'
    case 'running':
      return 'RUNNING'
    case 'created':
      return 'CREATED'
  }
}

export function formatBoard(board: RunBoard): string {
  const lines: string[] = []
  lines.push(`OpenFuture run ${board.runId}  [${label(board.status)}]`)
  lines.push(`goal: ${board.mainGoal}`)
  lines.push(
    `plan: ${board.planId}  concurrency: ${board.maxConcurrency}  duration: ${board.durationMs}ms  ` +
      `tasks: ${board.summary.total}  failed: ${board.summary.failed}  cancelled: ${board.summary.cancelled}`
  )
  lines.push(`started: ${iso(board.startedAt)}  finished: ${iso(board.finishedAt)}`)
  if (board.stopReason) lines.push(`stop: ${board.stopReason}`)
  lines.push('')

  for (const lane of board.lanes) {
    lines.push(`[${lane.role}]`)
    for (const task of lane.tasks) {
      const timing =
        task.durationMs !== undefined ? `${task.durationMs}ms` : task.startedAt !== undefined ? 'running' : '-'
      const attempt = `attempt ${task.attempt}/${task.maxAttempts}`
      const deps = task.dependsOn.length > 0 ? ` deps=${task.dependsOn.join(',')}` : ''
      lines.push(`  ${task.state.padEnd(11)} ${task.id}  (${timing}, ${attempt})${deps}`)
      if (task.files.length > 0) lines.push(`    files: ${task.files.join(', ')}`)
      if (task.artifacts.length > 0) {
        lines.push(`    artifacts: ${task.artifacts.map((artifact) => `${artifact.name}@${artifact.version}`).join(', ')}`)
      }
      if (task.waiting) lines.push(`    waiting for ${task.waiting.correlationId}`)
      if (task.error) lines.push(`    error: ${task.error.code}: ${task.error.message}`)
    }
    lines.push('')
  }

  if (board.integration) {
    const integration = board.integration
    lines.push(`[integration] ${integration.status}  revision: ${integration.evidence.integrationRevision.slice(0, 12)}`)
    if (integration.conflicts.length > 0) {
      for (const conflict of integration.conflicts) {
        lines.push(`  conflict ${conflict.path}: ${conflict.firstTaskId} vs ${conflict.secondTaskId} (${conflict.reason})`)
      }
    }
    for (const blocker of integration.blockers) lines.push(`  blocker: ${blocker}`)
    lines.push('')
  }

  lines.push('[traceability]')
  for (const trace of board.traceability) {
    lines.push(`  ${trace.questionId}: ${trace.taskIds.join(', ') || '(no task)'}`)
  }
  lines.push('')

  const terminal = board.summary.byState
  lines.push(
    `states: planned=${terminal.planned ?? 0} ready=${terminal.ready ?? 0} running=${terminal.running ?? 0} ` +
      `waiting=${terminal.needs_input ?? 0} succeeded=${terminal.succeeded ?? 0} failed=${terminal.failed ?? 0} ` +
      `cancelled=${terminal.cancelled ?? 0} integrated=${terminal.integrated ?? 0}`
  )
  lines.push(`messages: ${board.summary.messages}  artifacts: ${board.summary.artifacts}  events: ${board.summary.events}`)

  const failed = board.lanes.flatMap((lane) => lane.tasks).filter((task) => task.state === 'failed')
  if (failed.length > 0) {
    lines.push('')
    lines.push('failed tasks (owner preserved for follow-up):')
    for (const task of failed) {
      lines.push(`  ${task.role}/${task.id}: ${task.error?.code ?? 'unknown'} - ${task.error?.message ?? ''}`)
    }
  }

  return lines.join('\n')
}

export function boardJson(board: RunBoard): string {
  return JSON.stringify(board, null, 2)
}

export function terminalTaskCount(board: RunBoard): number {
  return TERMINAL_TASK_STATES.reduce((count, state) => count + (board.summary.byState[state] ?? 0), 0)
}
