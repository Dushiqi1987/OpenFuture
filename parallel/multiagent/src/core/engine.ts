/**
 * Team runtime: the M0 scheduler/worker/inbox/integration orchestration.
 *
 * The runtime is deliberately persistence-first. Every state transition is
 * written to the run snapshot before a task is allowed to do more work, which
 * keeps stop/cancel/restart behaviour inspectable. Workers only see the
 * `WorkerContext` boundary; swapping the simulated workers for Pi workers in
 * M1 does not touch this file.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { ArtifactStore, validateFileChanges } from './artifacts.ts'
import { TaskFailureError, TeamError, abortError, errorMessage, toTaskFailure } from './errors.ts'
import { Inbox } from './inbox.ts'
import type { InboxSendResult } from './inbox.ts'
import { IntegrationRunner } from './integration.ts'
import { ensureValidPlan } from './plan.ts'
import { DEFAULT_ROLE_CARDS, canWritePath, matchesScope, resolveAllPermissions } from './roles.ts'
import { Scheduler } from './scheduler.ts'
import { RunStore } from './store.ts'
import {
  MAX_PARALLEL_WORKERS,
  isTerminalTaskState,
  type ArtifactDraft,
  type ArtifactRef,
  type AttemptRecord,
  type CheckResult,
  type EffectivePermissions,
  type FileChange,
  type InboxMessage,
  type IntegrationReport,
  type Plan,
  type ProjectPolicy,
  type RoleCard,
  type RoleId,
  type RunEvent,
  type RunStatus,
  type TaskError,
  type TaskRecord,
  type TaskResult,
  type TaskState
} from './types.ts'
import {
  Deferred,
  createIdFactory,
  normalizePosixPath,
  sleep,
  systemClock,
  type Clock,
  type IdFactory
} from './util.ts'
import type { Worker, WorkerContext, WorkerFactory, WorkerWaitOptions } from './worker.ts'

export interface TeamRuntimeOptions {
  project: ProjectPolicy
  cards?: Record<RoleId, RoleCard>
  workerFactory?: WorkerFactory
  clock?: Clock
  idFactory?: IdFactory
  artifactDir?: string
  /** Hard-capped at MAX_PARALLEL_WORKERS. Defaults to the plan/project value. */
  maxConcurrency?: number
}

export interface CreateTeamRuntimeOptions extends TeamRuntimeOptions {
  plan: Plan
}

export interface ResumeTeamRuntimeOptions extends TeamRuntimeOptions {
  runId: string
}

export interface RunResult {
  runId: string
  projectId: string
  status: RunStatus
  stopReason?: string
  startedAt?: number
  finishedAt?: number
  durationMs: number
  maxConcurrency: number
  plan: Plan
  tasks: TaskRecord[]
  artifacts: ArtifactRef[]
  messages: InboxMessage[]
  events: RunEvent[]
  integration: IntegrationReport | undefined
}

type AttemptAbortKind = 'run-stop' | 'task-cancel' | 'timeout'

class AttemptAbortedError extends Error {
  readonly kind: AttemptAbortKind

  constructor(kind: AttemptAbortKind, message: string) {
    super(message)
    this.name = 'AttemptAbortedError'
    this.kind = kind
  }
}

interface AttemptContext {
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
  attempt: number
}

const missingWorkerFactory: WorkerFactory = (task) => {
  throw new TeamError(
    'worker-factory-missing',
    `no worker factory configured for ${task.role} task ${task.id}; pass SimulatedWorkerFactory in M0 or a Pi factory in M1`
  )
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function isAttemptAborted(value: unknown): value is AttemptAbortedError {
  return value instanceof AttemptAbortedError
}

function cloneTaskSpec(spec: Plan['tasks'][number]): Plan['tasks'][number] {
  return {
    ...spec,
    dependsOn: [...spec.dependsOn],
    inputArtifacts: spec.inputArtifacts.map((input) => ({ ...input })),
    outputs: spec.outputs.map((output) => ({ ...output })),
    acceptance: [...spec.acceptance],
    writeScope: [...spec.writeScope],
    budget: { ...spec.budget }
  }
}

export class TeamRuntime {
  readonly project: ProjectPolicy
  readonly store: RunStore
  readonly inbox: Inbox
  readonly artifacts: ArtifactStore
  readonly scheduler: Scheduler
  readonly cards: Record<RoleId, RoleCard>
  readonly permissions: Record<RoleId, EffectivePermissions>
  readonly maxConcurrency: number

  private readonly clock: Clock
  private readonly ids: IdFactory
  private readonly workerFactory: WorkerFactory
  private readonly integrationRunner: IntegrationRunner
  private readonly attemptContexts = new Map<string, AttemptContext>()
  private readonly taskPromises = new Map<string, Promise<void>>()
  private readonly resumeWaiters = new Map<string, Deferred<void>>()
  private readonly readyEmitted = new Set<string>()

  private flushChain: Promise<void> = Promise.resolve()
  private persistenceError: unknown
  private wake: Deferred<void> | undefined
  private loopPromise: Promise<RunResult> | undefined
  private result: RunResult | undefined
  private stopReason: string | undefined
  private fatalError: unknown
  private integrationPromise: Promise<IntegrationReport | undefined> | undefined
  private integrationError: unknown
  private finalizing = false

  private constructor(
    project: ProjectPolicy,
    store: RunStore,
    options: TeamRuntimeOptions,
    cards: Record<RoleId, RoleCard>,
    permissions: Record<RoleId, EffectivePermissions>
  ) {
    this.project = project
    this.store = store
    this.cards = cards
    this.permissions = permissions
    this.clock = options.clock ?? systemClock
    this.ids = options.idFactory ?? createIdFactory()
    this.workerFactory = options.workerFactory ?? missingWorkerFactory

    const requested = options.maxConcurrency ?? store.plan.budget.maxConcurrency ?? project.maxConcurrency
    this.maxConcurrency = Math.max(1, Math.min(requested, MAX_PARALLEL_WORKERS))

    const finished = store.tasks.filter((task) => isTerminalTaskState(task.state)).map((task) => task.id)
    this.scheduler = new Scheduler(store.tasks, this.maxConcurrency, finished)

    this.inbox = new Inbox({
      runId: store.run.runId,
      projectId: project.projectId,
      clock: this.clock,
      idFactory: this.ids,
      initialMessages: store.snapshot.messages
    })
    for (const task of store.tasks) {
      this.inbox.register({ agentId: task.agentId, taskId: task.id, role: task.role })
    }

    this.artifacts = new ArtifactStore(project, {
      artifactDir: options.artifactDir,
      clock: this.clock,
      idFactory: this.ids
    })
    this.integrationRunner = new IntegrationRunner(project, store, this.artifacts, { clock: this.clock })
  }

  static async create(options: CreateTeamRuntimeOptions): Promise<TeamRuntime> {
    const project = options.project
    const cards = options.cards ?? DEFAULT_ROLE_CARDS
    ensureValidPlan(options.plan, project, cards)

    const statePath = RunStore.statePath(project, options.plan.runId)
    if (existsSync(statePath)) {
      throw new TeamError(
        'run-exists',
        `run ${options.plan.runId} already has a snapshot; open it with TeamRuntime.resume instead of starting a duplicate`
      )
    }

    const clock = options.clock ?? systemClock
    const ids = options.idFactory ?? createIdFactory()
    const tasks: TaskRecord[] = options.plan.tasks.map((spec) => {
      const taskSpec = cloneTaskSpec(spec)
      return {
        ...taskSpec,
        projectId: project.projectId,
        runId: options.plan.runId,
        agentId: ids.agent(taskSpec.id),
        state: 'planned',
        attempt: 0,
        attempts: [],
        producedArtifacts: [],
        resolvedInputs: [],
        fileChanges: [],
        checks: [],
        progress: []
      }
    })

    const store = await RunStore.create(project, options.plan, tasks, { clock })
    store.emit('plan.received', undefined, {
      planId: options.plan.planId,
      questions: options.plan.sourceQuestions.length,
      intents: options.plan.intents.length,
      tasks: options.plan.tasks.length
    })
    store.emit('plan.accepted', undefined, {
      planId: options.plan.planId,
      confidence: options.plan.confidence
    })
    await store.flush()

    return new TeamRuntime(
      project,
      store,
      { ...options, clock, idFactory: ids },
      cards,
      resolveAllPermissions(project, cards)
    )
  }

  static async resume(options: ResumeTeamRuntimeOptions): Promise<TeamRuntime> {
    const project = options.project
    const cards = options.cards ?? DEFAULT_ROLE_CARDS
    const clock = options.clock ?? systemClock
    const store = await RunStore.open(project, options.runId, { clock })
    ensureValidPlan(store.plan, project, cards)

    const runtime = new TeamRuntime(
      project,
      store,
      { ...options, clock, idFactory: options.idFactory ?? createIdFactory() },
      cards,
      resolveAllPermissions(project, cards)
    )
    const recovered = runtime.recoverInterruptedTasks()
    if (recovered.length > 0) {
      store.emit('run.recovered', undefined, {
        tasks: recovered,
        message: 'interrupted attempts were reset to planned state for a controlled retry'
      })
    }
    await store.flush()
    return runtime
  }

  get runId(): string {
    return this.store.run.runId
  }

  get runStatus(): RunStatus {
    return this.store.run.status
  }

  get tasks(): TaskRecord[] {
    return this.store.tasks
  }

  get events(): RunEvent[] {
    return this.store.events
  }

  get integrationReport(): IntegrationReport | undefined {
    return this.store.snapshot.integration
  }

  async run(): Promise<RunResult> {
    if (this.result) return this.result
    if (this.loopPromise) return this.loopPromise
    this.loopPromise = this.runLoop()
    return this.loopPromise
  }

  requestStop(reason = 'user-stop'): void {
    if (this.result || this.stopReason) return
    this.stopReason = reason
    this.cancelAllUnfinished('run-stopped', `用户停止运行：${reason}`)
    this.notify()
  }

  async stop(reason = 'user-stop'): Promise<RunResult> {
    if (this.result) return this.result
    this.requestStop(reason)
    return await this.run()
  }

  async cancelTask(taskId: string, reason = 'user-cancelled'): Promise<TaskRecord> {
    const task = this.store.task(taskId)
    if (isTerminalTaskState(task.state)) {
      throw new TeamError('task-terminal', `task ${taskId} is already ${task.state}`)
    }
    if (this.attemptContexts.has(taskId)) {
      this.abortAttempt(taskId, 'task-cancel', `任务取消：${reason}`)
      await this.waitForTaskTerminal(taskId, 5000)
    } else {
      this.cancelRecord(taskId, 'task-cancelled', `任务取消：${reason}`, true)
    }
    await this.persist()
    return this.store.task(taskId)
  }

  // ---------------------------------------------------------------------
  // Main scheduling loop
  // ---------------------------------------------------------------------

  private async runLoop(): Promise<RunResult> {
    if (isTerminalRunStatus(this.store.run.status)) {
      this.result = this.buildResult()
      return this.result
    }

    if (this.store.run.status === 'created') {
      this.store.setRunStatus('running', { startedAt: this.clock.now() })
      this.store.emit('run.started', undefined, {
        tasks: this.store.tasks.length,
        maxConcurrency: this.maxConcurrency,
        planId: this.store.plan.planId
      })
      await this.persist()
    } else {
      this.store.setRunStatus('running')
    }

    try {
      while (true) {
        if (this.stopReason) {
          this.cancelAllUnfinished('run-stopped', `用户停止运行：${this.stopReason}`)
          await this.settleActiveAttempts(2000)
          break
        }

        this.recoverRetries()
        this.promoteQueued()
        this.cancelBlockedTasks()

        const ready = this.readyTaskIds()
        if (ready.length > 0) {
          for (const taskId of ready) {
            const task = this.store.task(taskId)
            if (!this.readyEmitted.has(taskId) && task.state === 'ready') {
              this.readyEmitted.add(taskId)
              this.store.emit('task.ready', taskId, { dependsOn: [...task.dependsOn] })
            }
          }
          await this.dispatchReady(ready)
        }

        if (this.allTasksTerminal()) break
        if (!this.hasWork()) {
          const delay = this.nextRetryDelay()
          if (delay === undefined) break
          await this.waitForWake(delay)
          continue
        }
        await this.waitForWake(this.nextRetryDelay())
      }
    } catch (error) {
      this.fatalError = error
      this.cancelAllUnfinished('internal-error', errorMessage(error))
      await this.settleActiveAttempts(1000)
    }

    return await this.finalize()
  }

  private stateMap(): Map<string, TaskState> {
    return new Map(this.store.tasks.map((task) => [task.id, task.state]))
  }

  private allTasksTerminal(): boolean {
    return this.store.tasks.every((task) => isTerminalTaskState(task.state))
  }

  private hasWork(): boolean {
    if (this.scheduler.activeCount > 0 || this.scheduler.parkedIds.length > 0) return true
    if (this.scheduler.queuedResumeIds.length > 0) return true
    return this.store.tasks.some((task) => !isTerminalTaskState(task.state))
  }

  private readyTaskIds(): string[] {
    const now = this.clock.now()
    return this.scheduler.readyIds(this.stateMap()).filter((taskId) => {
      const task = this.store.task(taskId)
      return task.retryNotBefore === undefined || task.retryNotBefore <= now
    })
  }

  private nextRetryDelay(): number | undefined {
    const now = this.clock.now()
    let minimum: number | undefined
    for (const task of this.store.tasks) {
      if (task.state !== 'planned' || task.retryNotBefore === undefined) continue
      const delay = Math.max(0, task.retryNotBefore - now)
      if (minimum === undefined || delay < minimum) minimum = delay
    }
    return minimum
  }

  private recoverRetries(): void {
    const now = this.clock.now()
    for (const task of this.store.tasks) {
      if (task.state !== 'planned' || task.retryNotBefore === undefined) continue
      if (task.retryNotBefore > now) continue
      this.store.updateTask(task.id, {
        state: 'ready',
        retryNotBefore: undefined
      })
      this.store.emit('task.ready', task.id, { retry: true })
      this.readyEmitted.add(task.id)
    }
  }

  private promoteQueued(): void {
    const promoted = this.scheduler.takePromotable()
    if (promoted.length > 0) this.handlePromoted(promoted)
  }

  private cancelBlockedTasks(): void {
    const blocked = this.scheduler.blockedIds(this.stateMap())
    for (const taskId of blocked) {
      const task = this.store.task(taskId)
      const failedDeps = task.dependsOn.filter((dependency) => {
        const state = this.store.findTask(dependency)?.state
        return state === 'failed' || state === 'cancelled'
      })
      this.cancelRecord(
        taskId,
        'dependency-failed',
        `依赖任务未成功：${failedDeps.join(', ') || 'unknown'}`,
        true
      )
    }
  }

  private async dispatchReady(ready: string[]): Promise<void> {
    for (const taskId of ready) {
      if (this.stopReason) break
      if (this.scheduler.freeSlots <= 0) break
      const task = this.store.task(taskId)
      if (task.state !== 'planned' && task.state !== 'ready') continue
      if (this.scheduler.isRunning(taskId) || this.scheduler.isParked(taskId) || this.scheduler.isFinished(taskId)) {
        continue
      }
      if (task.role === 'tester') {
        const report = await this.ensureIntegration()
        if (!report || report.status !== 'passed') {
          this.failTaskForIntegration(taskId, report)
          continue
        }
      }
      this.startTask(taskId)
    }
  }

  private waitForWake(delayMs?: number): Promise<void> {
    const wake = new Deferred<void>()
    this.wake = wake
    const wait = delayMs === undefined ? wake.promise : Promise.race([wake.promise, sleep(Math.max(0, delayMs))])
    return wait.finally(() => {
      if (this.wake === wake) this.wake = undefined
    })
  }

  private notify(): void {
    this.wake?.resolve()
  }

  // ---------------------------------------------------------------------
  // Attempts
  // ---------------------------------------------------------------------

  private startTask(taskId: string): void {
    const task = this.store.task(taskId)
    this.scheduler.start(taskId)

    const attemptNumber = task.attempt + 1
    const startedAt = this.clock.now()
    const controller = new AbortController()
    const timeoutMs = Math.max(1, task.budget.timeoutMs)
    const timer = setTimeout(() => {
      controller.abort(new AttemptAbortedError('timeout', `任务 ${taskId} 超过 ${timeoutMs}ms 预算`))
    }, timeoutMs)

    const attempt: AttemptRecord = {
      attempt: attemptNumber,
      startedAt,
      status: 'running',
      progress: []
    }
    task.attempts.push(attempt)
    this.store.updateTask(taskId, {
      attempt: attemptNumber,
      state: 'running',
      startedAt: task.startedAt ?? startedAt,
      finishedAt: undefined,
      error: undefined,
      retryNotBefore: undefined,
      waiting: undefined
    })
    this.store.emit('task.attempt', taskId, { attempt: attemptNumber, timeoutMs })
    this.store.emit('task.state', taskId, { state: 'running', attempt: attemptNumber })

    const context: AttemptContext = { controller, timer, attempt: attemptNumber }
    this.attemptContexts.set(taskId, context)
    const promise = this.executeAttempt(taskId, attemptNumber, controller)
      .catch((error: unknown) => {
        // executeAttempt is expected to contain errors; this is a last-resort
        // guard so one broken worker cannot take down the scheduler loop.
        this.fatalError ??= error
        this.store.emit('run.failed', taskId, { error: errorMessage(error) })
      })
      .finally(() => {
        clearTimeout(timer)
        if (this.attemptContexts.get(taskId) === context) this.attemptContexts.delete(taskId)
        if (this.taskPromises.get(taskId) === promise) this.taskPromises.delete(taskId)
        this.notify()
        this.persistSoon()
      })
    this.taskPromises.set(taskId, promise)
    this.persistSoon()
  }

  private async executeAttempt(
    taskId: string,
    attemptNumber: number,
    controller: AbortController
  ): Promise<void> {
    const task = this.store.task(taskId)
    const attempt = task.attempts[task.attempts.length - 1]
    if (!attempt) throw new TeamError('attempt-missing', `task ${taskId} has no active attempt record`)

    let failure: TaskFailureError | undefined
    let summary = ''
    try {
      const resolvedInputs = this.resolveInputs(task)
      this.store.updateTask(taskId, { resolvedInputs })

      const worker: Worker = this.workerFactory(task)
      const result: TaskResult = await worker.run(this.createWorkerContext(task, controller.signal))
      if (controller.signal.aborted) throw abortError(controller.signal)
      summary = result.summary

      const validated = validateFileChanges(this.project, task, result.fileChanges ?? [])
      const checks: CheckResult[] = Array.isArray(result.checks) ? result.checks : []
      this.store.updateTask(taskId, { fileChanges: validated.changes, checks })
      this.assertRequiredOutputs(task)

      const failedCheck = checks.find((check) => check.status === 'failed')
      if (failedCheck) {
        throw new TaskFailureError('task-check-failed', `任务检查失败：${failedCheck.id}`, {
          retryable: false,
          details: { checkId: failedCheck.id, detail: failedCheck.detail ?? null }
        })
      }

      attempt.status = 'succeeded'
      attempt.finishedAt = this.clock.now()
      const finishedAt = this.clock.now()
      this.store.updateTask(taskId, {
        state: 'succeeded',
        finishedAt,
        waiting: undefined,
        error: undefined
      })
      this.recordProgress(taskId, `完成：${summary}`, 1)
      this.store.emit('task.state', taskId, {
        state: 'succeeded',
        attempt: attemptNumber,
        summary,
        artifacts: task.producedArtifacts.map((ref) => ref.id),
        fileChanges: task.fileChanges.map((change) => change.path)
      })
      this.handlePromoted(this.scheduler.finish(taskId))
      await this.persist()
      return
    } catch (error) {
      failure = this.classifyFailure(error, controller.signal)
    }

    attempt.finishedAt = this.clock.now()
    const taskError = this.toTaskError(failure, true)
    const cancelled = failure.code === 'run-stopped' || failure.code === 'task-cancelled'

    if (cancelled) {
      attempt.status = 'cancelled'
      attempt.error = taskError
      this.store.updateTask(taskId, {
        state: 'cancelled',
        finishedAt: this.clock.now(),
        waiting: undefined,
        error: taskError
      })
      this.store.emit('task.cancelled', taskId, { code: failure.code, message: failure.message })
      this.store.emit('task.state', taskId, { state: 'cancelled', code: failure.code })
      this.handlePromoted(this.scheduler.finish(taskId))
      if (!this.stopReason) this.cancelDownstream(taskId, failure.code)
      this.notify()
      await this.persist()
      return
    }

    const maxAttempts = Math.max(1, task.budget.maxAttempts)
    if (failure.retryable && attemptNumber < maxAttempts && !this.stopReason) {
      attempt.status = 'failed'
      attempt.error = taskError
      const delayMs = failure.retryAfterMs ?? Math.min(250 * 2 ** (attemptNumber - 1), 5000)
      this.store.updateTask(taskId, {
        state: 'planned',
        retryNotBefore: this.clock.now() + delayMs,
        finishedAt: undefined,
        waiting: undefined,
        error: taskError
      })
      this.store.emit('task.retry_scheduled', taskId, {
        attempt: attemptNumber,
        nextAttempt: attemptNumber + 1,
        delayMs,
        code: failure.code
      })
      this.store.emit('task.state', taskId, { state: 'planned', retry: true, code: failure.code })
      this.handlePromoted(this.scheduler.release(taskId))
      this.notify()
      await this.persist()
      return
    }

    attempt.status = 'failed'
    attempt.error = taskError
    this.store.updateTask(taskId, {
      state: 'failed',
      finishedAt: this.clock.now(),
      waiting: undefined,
      error: { ...taskError, escalatedToSuperAgent: true }
    })
    this.store.emit('task.state', taskId, {
      state: 'failed',
      code: failure.code,
      message: failure.message,
      role: task.role,
      attempt: attemptNumber
    })
    this.handlePromoted(this.scheduler.finish(taskId))
    this.cancelDownstream(taskId, failure.code)
    this.notify()
    await this.persist()
  }

  private classifyFailure(error: unknown, signal: AbortSignal): TaskFailureError {
    const reason = signal.reason
    if (isAttemptAborted(reason)) {
      if (reason.kind === 'timeout') {
        return new TaskFailureError('task-timeout', reason.message, { retryable: true, retryAfterMs: 0 })
      }
      if (reason.kind === 'task-cancel') {
        return new TaskFailureError('task-cancelled', reason.message, { retryable: false })
      }
      return new TaskFailureError('run-stopped', reason.message, { retryable: false })
    }
    if (signal.aborted) {
      return toTaskFailure(abortError(signal))
    }
    return toTaskFailure(error)
  }

  private toTaskError(failure: TaskFailureError, escalated: boolean): TaskError {
    return {
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
      ...(escalated ? { escalatedToSuperAgent: true } : {})
    }
  }

  private resolveInputs(task: TaskRecord): ArtifactRef[] {
    const resolved: ArtifactRef[] = []
    const seen = new Set<string>()
    for (const input of task.inputArtifacts) {
      const candidates = this.store.snapshot.artifacts
        .filter((ref) => ref.runId === this.store.run.runId)
        .filter((ref) => ref.name === input.name)
        .filter((ref) => !input.version || ref.version === input.version)
        .filter((ref) => !input.kind || ref.kind === input.kind)
        .sort((left, right) => right.createdAt - left.createdAt)
      const selected = candidates[0]
      if (!selected) {
        if (input.required === false) continue
        throw new TaskFailureError(
          'input-artifact-missing',
          `${task.role} 缺少必需输入产物 ${input.name}${input.version ? `@${input.version}` : ''}`,
          { retryable: false, details: { taskId: task.id, input: input.name } }
        )
      }
      if (!seen.has(selected.id)) {
        seen.add(selected.id)
        resolved.push(selected)
      }
    }
    return resolved
  }

  private assertRequiredOutputs(task: TaskRecord): void {
    for (const output of task.outputs) {
      if (output.required === false) continue
      const found = task.producedArtifacts.some((ref) => {
        if (ref.name !== output.name) return false
        if (output.version && ref.version !== output.version) return false
        if (output.kind && ref.kind !== output.kind) return false
        return true
      })
      if (!found) {
        throw new TaskFailureError(
          'output-missing',
          `${task.role} 未产出必需产物 ${output.name}${output.version ? `@${output.version}` : ''}`,
          { retryable: false, details: { taskId: task.id, output: output.name } }
        )
      }
    }
  }

  private cancelDownstream(taskId: string, code: string): void {
    for (const downstream of this.scheduler.downstreamOf(taskId)) {
      const task = this.store.findTask(downstream)
      if (!task || isTerminalTaskState(task.state)) continue
      if (this.attemptContexts.has(downstream) || task.state === 'running' || task.state === 'needs_input') {
        // A dependent cannot normally be active while its dependency fails, but
        // abort defensively so the run can still settle.
        this.abortAttempt(downstream, 'task-cancel', `上游任务 ${taskId} 失败 (${code})`)
        continue
      }
      this.cancelRecord(downstream, 'dependency-failed', `上游任务 ${taskId} 失败 (${code})`, true)
    }
  }

  private cancelBlockedDirectly(): void {
    // Reserved for future recovery paths; blocked ids are handled in the loop.
  }

  // ---------------------------------------------------------------------
  // Inbox operations exposed to workers
  // ---------------------------------------------------------------------

  private sendFrom(taskId: string, input: Parameters<Inbox['send']>[1]): InboxSendResult {
    const task = this.store.task(taskId)
    const result = this.inbox.send(task.agentId, input)
    if (result.duplicate) {
      this.store.emit('inbox.duplicate', taskId, {
        messageId: result.message.id,
        clientMessageId: result.message.clientMessageId,
        correlationId: result.message.correlationId
      })
    } else {
      this.store.addMessage(result.message)
      this.store.emit('inbox.message', taskId, {
        messageId: result.message.id,
        fromAgentId: result.message.fromAgentId,
        toAgentId: result.message.toAgentId,
        fromRole: result.message.fromRole,
        toRole: result.message.toRole,
        type: result.message.type,
        correlationId: result.message.correlationId,
        clientMessageId: result.message.clientMessageId,
        artifactRefs: result.message.artifactRefs
      })
    }
    this.notify()
    this.persistSoon()
    return result
  }

  private async waitForInput(taskId: string, options: WorkerWaitOptions = {}): Promise<InboxMessage[]> {
    const task = this.store.task(taskId)
    const context = this.attemptContexts.get(taskId)
    if (!context) throw new TeamError('task-not-active', `task ${taskId} has no active attempt`)
    const signal = context.controller.signal
    if (signal.aborted) throw abortError(signal)

    const timeoutMs = Math.max(1, options.timeoutMs ?? task.budget.requestTimeoutMs)
    const correlationId = options.correlationId
    const waiting = {
      correlationId: correlationId ?? '*',
      since: this.clock.now(),
      timeoutAt: this.clock.now() + timeoutMs
    }
    this.scheduler.park(taskId)
    this.store.updateTask(taskId, { state: 'needs_input', waiting })
    this.store.emit('task.waiting', taskId, {
      correlationId: waiting.correlationId,
      timeoutAt: waiting.timeoutAt
    })
    this.store.emit('inbox.wait_registered', taskId, {
      correlationId: waiting.correlationId,
      agentId: task.agentId
    })
    this.notify()
    await this.persist()

    let outcome
    try {
      outcome = await this.inbox.waitForMessages(task.agentId, {
        timeoutMs,
        ...(correlationId ? { correlationId } : {}),
        ...(options.consumes ? { consumes: options.consumes } : {}),
        ...(options.issues ? { issues: options.issues } : {}),
        signal
      })
    } catch (error) {
      if (signal.aborted) throw abortError(signal)
      if (this.scheduler.isParked(taskId)) {
        await this.reacquireSlot(taskId, signal)
      }
      if (error instanceof TaskFailureError && error.code === 'inbox-timeout') {
        this.store.emit('inbox.wait_timeout', taskId, {
          correlationId: waiting.correlationId,
          timeoutMs
        })
      } else if (error instanceof TeamError && error.code === 'inbox-wait-cycle') {
        this.store.emit('inbox.wait_cycle_rejected', taskId, {
          correlationId: waiting.correlationId,
          details: error.details ?? {}
        })
      }
      throw error
    }

    for (const message of outcome.messages) {
      this.syncInboxMessage(message)
      this.store.emit('inbox.delivered', taskId, {
        messageId: message.id,
        correlationId: message.correlationId,
        fromRole: message.fromRole,
        type: message.type,
        waitedMs: outcome.waitedMs
      })
    }

    await this.reacquireSlot(taskId, signal)
    for (const message of outcome.messages) {
      const acked = this.inbox.ack(task.agentId, message.id)
      this.syncInboxMessage(acked)
      this.store.emit('inbox.acked', taskId, {
        messageId: acked.id,
        correlationId: acked.correlationId
      })
    }
    this.persistSoon()
    return outcome.messages
  }

  private async reacquireSlot(taskId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError(signal)
    const task = this.store.task(taskId)
    if (this.scheduler.isRunning(taskId)) {
      this.markResumed(taskId)
      return
    }
    if (!this.scheduler.isParked(taskId)) {
      if (isTerminalTaskState(task.state)) {
        throw new TeamError('task-terminal', `task ${taskId} became ${task.state} while waiting`)
      }
      throw new TeamError('task-not-parked', `task ${taskId} lost its parked slot`)
    }
    if (this.scheduler.requestResume(taskId)) {
      this.markResumed(taskId)
      return
    }
    const deferred = new Deferred<void>()
    this.resumeWaiters.set(taskId, deferred)
    await deferred.promise
    if (signal.aborted) throw abortError(signal)
  }

  private markResumed(taskId: string): void {
    const task = this.store.task(taskId)
    if (isTerminalTaskState(task.state)) return
    this.store.updateTask(taskId, { state: 'running', waiting: undefined })
    this.store.emit('task.wait_resolved', taskId, { state: 'running' })
    this.store.emit('task.state', taskId, { state: 'running', resumed: true })
    this.notify()
  }

  private handlePromoted(promoted: string[]): void {
    if (promoted.length === 0) return
    for (const taskId of promoted) {
      const waiter = this.resumeWaiters.get(taskId)
      if (waiter) {
        this.resumeWaiters.delete(taskId)
        waiter.resolve()
      }
      if (this.scheduler.isRunning(taskId)) this.markResumed(taskId)
    }
    this.notify()
  }

  private syncInboxMessage(message: InboxMessage): void {
    const stored = this.store.snapshot.messages.find((candidate) => candidate.id === message.id)
    if (!stored) return
    stored.deliveredAt = message.deliveredAt
    stored.ackedAt = message.ackedAt
  }

  private recordProgress(taskId: string, message: string, fraction?: number): void {
    const task = this.store.task(taskId)
    const at = this.clock.now()
    task.progress.push({ at, message, ...(fraction !== undefined ? { fraction } : {}) })
    const attempt = task.attempts[task.attempts.length - 1]
    if (attempt) attempt.progress.push({ at, message, ...(fraction !== undefined ? { fraction } : {}) })
    this.store.updateTask(taskId, {})
    this.store.emit('task.progress', taskId, {
      message,
      ...(fraction !== undefined ? { fraction } : {})
    })
    this.notify()
    this.persistSoon()
  }

  private async publishArtifact(taskId: string, draft: ArtifactDraft): Promise<ArtifactRef> {
    const task = this.store.task(taskId)
    const previousContracts = this.store.snapshot.artifacts.filter((ref) => ref.kind === 'contract')
    const ref = await this.artifacts.publish({
      runId: this.store.run.runId,
      projectId: this.project.projectId,
      taskId,
      draft
    })
    this.store.addArtifact(ref)
    task.producedArtifacts.push(ref)
    this.store.updateTask(taskId, { producedArtifacts: task.producedArtifacts })

    this.store.emit('artifact.published', taskId, {
      artifactId: ref.id,
      name: ref.name,
      version: ref.version,
      kind: ref.kind,
      sha256: ref.sha256,
      bytes: ref.bytes,
      uri: ref.uri
    })

    if (ref.kind === 'contract') {
      const previous = previousContracts.sort((left, right) => left.createdAt - right.createdAt).at(-1)
      if (previous && (previous.sha256 !== ref.sha256 || previous.version !== ref.version)) {
        this.store.emit('artifact.contract_changed', taskId, {
          previous: { id: previous.id, version: previous.version, sha256: previous.sha256 },
          next: { id: ref.id, version: ref.version, sha256: ref.sha256 }
        })
      }
    }
    await this.persist()
    return ref
  }

  private findArtifact(name: string, version?: string): ArtifactRef | undefined {
    return this.store.snapshot.artifacts
      .filter((ref) => ref.name === name)
      .filter((ref) => !version || ref.version === version)
      .sort((left, right) => right.createdAt - left.createdAt)[0]
  }

  private findArtifactById(artifactId: string): ArtifactRef | undefined {
    return this.store.snapshot.artifacts.find((ref) => ref.id === artifactId)
  }

  // ---------------------------------------------------------------------
  // WorkerContext
  // ---------------------------------------------------------------------

  private createWorkerContext(task: TaskRecord, signal: AbortSignal): WorkerContext {
    const card = this.cards[task.role]
    const permissions = this.permissions[task.role]
    const self = this
    return {
      runId: this.store.run.runId,
      project: this.project,
      task,
      agentId: task.agentId,
      role: task.role,
      card,
      permissions,
      resolvedInputs: [...task.resolvedInputs],
      signal,
      inbox: this.inbox,
      artifacts: this.artifacts,
      log(message: string, fraction?: number): void {
        self.recordProgress(task.id, message, fraction)
      },
      publish(draft: ArtifactDraft): Promise<ArtifactRef> {
        return self.publishArtifact(task.id, draft)
      },
      findArtifact(name: string, version?: string): ArtifactRef | undefined {
        return self.findArtifact(name, version)
      },
      findArtifactById(artifactId: string): ArtifactRef | undefined {
        return self.findArtifactById(artifactId)
      },
      async readArtifactText(refOrName: ArtifactRef | string, version?: string): Promise<string> {
        const ref =
          typeof refOrName === 'string' ? self.findArtifact(refOrName, version) : refOrName
        if (!ref) {
          throw new TeamError('artifact-unknown', `artifact ${String(refOrName)} is not available`)
        }
        return await self.artifacts.readText(ref)
      },
      verifyArtifact(ref: ArtifactRef): Promise<boolean> {
        return self.artifacts.verify(ref)
      },
      send(input): InboxSendResult {
        return self.sendFrom(task.id, input)
      },
      wait(options?: WorkerWaitOptions): Promise<InboxMessage[]> {
        return self.waitForInput(task.id, options)
      },
      readRepoFile(relativePath: string): Promise<string | null> {
        return self.readRepoFile(relativePath)
      },
      readIntegrationFile(relativePath: string): Promise<string | null> {
        return self.readIntegrationFile(relativePath)
      },
      listTaskSnapshots(): readonly TaskRecord[] {
        return self.store.tasks
      },
      integrationReport(): IntegrationReport | undefined {
        return self.store.snapshot.integration
      },
      canWrite(relativePath: string): boolean {
        return self.canTaskWrite(task, permissions, relativePath)
      }
    }
  }

  private canTaskWrite(task: TaskRecord, permissions: EffectivePermissions, relativePath: string): boolean {
    let normalized: string
    try {
      normalized = normalizePosixPath(relativePath)
    } catch {
      return false
    }
    if (!canWritePath(permissions, normalized)) return false
    return task.writeScope.some((scope) => matchesScope(scope, normalized))
  }

  private safeRepoPath(relativePath: string): string {
    const normalized = normalizePosixPath(relativePath)
    if (
      normalized === '..' ||
      normalized.startsWith('../') ||
      normalized === '.git' ||
      normalized.startsWith('.git/') ||
      path.isAbsolute(relativePath)
    ) {
      throw new TeamError('path-denied', `path ${relativePath} is outside the readable repository`)
    }
    const root = path.resolve(this.project.rootPath)
    const absolute = path.resolve(root, ...normalized.split('/'))
    const relative = path.relative(root, absolute)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new TeamError('path-denied', `path ${relativePath} escapes the project root`)
    }
    return absolute
  }

  private async readRepoFile(relativePath: string): Promise<string | null> {
    const normalized = normalizePosixPath(relativePath)
    if (!this.project.allowedReadPaths.some((scope) => matchesScope(scope, normalized))) {
      throw new TeamError('read-denied', `${relativePath} is not inside the project read policy`)
    }
    const absolute = this.safeRepoPath(relativePath)
    try {
      return await readFile(absolute, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async readIntegrationFile(relativePath: string): Promise<string | null> {
    const root = this.integrationRunner.integrationRoot
    const normalized = normalizePosixPath(relativePath)
    if (normalized.startsWith('../') || path.isAbsolute(relativePath)) {
      throw new TeamError('path-denied', `${relativePath} escapes the integration root`)
    }
    const absolute = path.resolve(root, ...normalized.split('/'))
    const relative = path.relative(root, absolute)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new TeamError('path-denied', `${relativePath} escapes the integration root`)
    }
    try {
      return await readFile(absolute, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  // ---------------------------------------------------------------------
  // Integration gate
  // ---------------------------------------------------------------------

  private async ensureIntegration(): Promise<IntegrationReport | undefined> {
    if (this.integrationPromise) return await this.integrationPromise
    const existing = this.store.snapshot.integration
    if (existing) {
      this.integrationPromise = Promise.resolve(existing)
      return existing
    }

    this.integrationPromise = (async (): Promise<IntegrationReport | undefined> => {
      try {
        const report = await this.integrationRunner.run()
        if (report.status === 'passed') {
          this.markIntegrated()
          await this.persist()
        }
        return report
      } catch (error) {
        this.integrationError = error
        this.store.emit('integration.failed', undefined, { error: errorMessage(error) })
        await this.persist()
        return undefined
      }
    })()
    return await this.integrationPromise
  }

  private markIntegrated(): void {
    const now = this.clock.now()
    for (const task of this.store.tasks) {
      if (task.role === 'tester') continue
      if (task.fileChanges.length === 0) continue
      if (task.state !== 'succeeded' && task.state !== 'reviewed') continue
      this.store.updateTask(task.id, {
        state: 'integrated',
        integratedAt: now
      })
      this.store.emit('task.state', task.id, { state: 'integrated', integrationRevision: this.store.snapshot.integration?.evidence.integrationRevision ?? null })
    }
  }

  private failTaskForIntegration(taskId: string, report: IntegrationReport | undefined): void {
    const task = this.store.task(taskId)
    if (isTerminalTaskState(task.state)) return
    const blockers = report?.blockers ?? []
    const owners = report?.conflicts.map(
      (conflict) => `${conflict.path}: ${conflict.firstTaskId} vs ${conflict.secondTaskId} (${conflict.reason})`
    ) ?? []
    const error: TaskError = {
      code: report ? 'integration-blocked' : 'integration-failed',
      message: report
        ? `独立集成门 ${report.status}，测试无法启动：${[...owners, ...blockers].join('; ') || 'unknown blocker'}`
        : `独立集成门执行失败：${errorMessage(this.integrationError)}`,
      retryable: false,
      escalatedToSuperAgent: true
    }
    this.store.updateTask(taskId, {
      state: 'failed',
      finishedAt: this.clock.now(),
      error
    })
    this.store.emit('task.state', taskId, {
      state: 'failed',
      code: error.code,
      role: task.role,
      integrationStatus: report?.status ?? null,
      conflicts: report?.conflicts ?? [],
      blockers
    })
    this.handlePromoted(this.scheduler.finish(taskId))
    this.notify()
    this.persistSoon()
  }

  // ---------------------------------------------------------------------
  // Cancellation / recovery / finalisation
  // ---------------------------------------------------------------------

  private abortAttempt(taskId: string, kind: AttemptAbortKind, message: string): void {
    const context = this.attemptContexts.get(taskId)
    if (context && !context.controller.signal.aborted) {
      context.controller.abort(new AttemptAbortedError(kind, message))
    }
    const waiter = this.resumeWaiters.get(taskId)
    if (waiter) {
      this.resumeWaiters.delete(taskId)
      waiter.resolve()
    }
    this.notify()
  }

  private cancelRecord(taskId: string, code: string, message: string, cascade: boolean): void {
    const task = this.store.findTask(taskId)
    if (!task || isTerminalTaskState(task.state)) return
    if (this.attemptContexts.has(taskId)) {
      this.abortAttempt(taskId, 'task-cancel', message)
      return
    }
    this.scheduler.cancelQueuedResume(taskId)
    this.store.updateTask(taskId, {
      state: 'cancelled',
      finishedAt: this.clock.now(),
      waiting: undefined,
      error: { code, message, retryable: false, escalatedToSuperAgent: true }
    })
    this.store.emit('task.cancelled', taskId, { code, message })
    this.store.emit('task.state', taskId, { state: 'cancelled', code })
    const waiter = this.resumeWaiters.get(taskId)
    if (waiter) {
      this.resumeWaiters.delete(taskId)
      waiter.resolve()
    }
    this.handlePromoted(this.scheduler.finish(taskId))
    if (cascade) this.cancelDownstream(taskId, code)
    this.notify()
    this.persistSoon()
  }

  private cancelAllUnfinished(code: string, message: string): void {
    for (const task of this.store.tasks) {
      if (isTerminalTaskState(task.state)) continue
      if (this.attemptContexts.has(task.id)) {
        this.abortAttempt(task.id, code === 'run-stopped' ? 'run-stop' : 'task-cancel', message)
      } else {
        this.cancelRecord(task.id, code, message, false)
      }
    }
  }

  private async settleActiveAttempts(timeoutMs: number): Promise<void> {
    const pending = [...this.taskPromises.values()]
    if (pending.length === 0) return
    await Promise.race([Promise.allSettled(pending), sleep(timeoutMs)])
    for (const taskId of [...this.attemptContexts.keys()]) {
      const context = this.attemptContexts.get(taskId)
      if (context) clearTimeout(context.timer)
      this.attemptContexts.delete(taskId)
      const task = this.store.findTask(taskId)
      if (task && !isTerminalTaskState(task.state)) {
        this.store.updateTask(taskId, {
          state: 'cancelled',
          finishedAt: this.clock.now(),
          waiting: undefined,
          error: {
            code: 'run-stopped',
            message: '运行停止时任务未能及时收敛，已强制标记取消',
            retryable: false,
            escalatedToSuperAgent: true
          }
        })
        this.store.emit('task.cancelled', taskId, { code: 'run-stopped', message: 'forced stop' })
        this.handlePromoted(this.scheduler.finish(taskId))
      }
    }
  }

  private recoverInterruptedTasks(): string[] {
    if (isTerminalRunStatus(this.store.run.status)) return []
    const recovered: string[] = []
    const now = this.clock.now()
    for (const task of this.store.tasks) {
      if (task.state !== 'running' && task.state !== 'needs_input') continue
      const activeAttempt = [...task.attempts].reverse().find((attempt) => attempt.status === 'running')
      if (activeAttempt) {
        activeAttempt.status = 'failed'
        activeAttempt.finishedAt = now
        activeAttempt.error = {
          code: 'run-recovered',
          message: '进程重启中断了该尝试，运行时已重置任务',
          retryable: true
        }
      }
      task.recovered = true
      task.waiting = undefined
      const exhausted = task.attempt >= Math.max(1, task.budget.maxAttempts)
      this.store.updateTask(task.id, {
        state: exhausted ? 'failed' : 'planned',
        retryNotBefore: exhausted ? undefined : now,
        finishedAt: exhausted ? now : undefined,
        error: exhausted
          ? {
              code: 'run-recovered',
              message: '进程重启后重试次数已耗尽',
              retryable: false,
              escalatedToSuperAgent: true
            }
          : {
              code: 'run-recovered',
              message: '进程重启，任务将以新的尝试重跑',
              retryable: true
            }
      })
      this.store.emit('task.state', task.id, {
        state: exhausted ? 'failed' : 'planned',
        recovered: true,
        attempt: task.attempt
      })
      recovered.push(task.id)
    }
    return recovered
  }

  private async finalize(): Promise<RunResult> {
    if (this.result) return this.result
    if (this.finalizing) {
      // A second caller should only observe the finished result. The loop is
      // single-owner, so this branch is defensive.
      while (!this.result) await sleep(5)
      return this.result
    }
    this.finalizing = true

    if (this.stopReason) {
      this.cancelAllUnfinished('run-stopped', `用户停止运行：${this.stopReason}`)
      await this.settleActiveAttempts(1000)
    } else if (
      !this.store.snapshot.integration &&
      this.store.tasks.some(
        (task) =>
          task.role !== 'tester' &&
          task.fileChanges.length > 0 &&
          (task.state === 'succeeded' || task.state === 'reviewed')
      )
    ) {
      await this.ensureIntegration()
    }

    const report = this.store.snapshot.integration
    if (report?.status === 'passed') this.markIntegrated()

    let status: RunStatus
    if (this.stopReason) {
      status = 'cancelled'
    } else if (
      this.fatalError !== undefined ||
      this.persistenceError !== undefined ||
      this.store.tasks.some((task) => task.state === 'failed')
    ) {
      status = 'failed'
    } else if (this.store.tasks.some((task) => task.state === 'cancelled')) {
      status = 'cancelled'
    } else if (report && report.status !== 'passed') {
      status = 'failed'
    } else if (!this.allTasksTerminal()) {
      status = 'failed'
    } else {
      status = 'completed'
    }

    const finishedAt = this.clock.now()
    this.store.setRunStatus(status, {
      finishedAt,
      ...(this.stopReason ? { stopReason: this.stopReason } : {})
    })

    if (status === 'completed') {
      this.store.emit('run.completed', undefined, {
        tasks: this.store.tasks.length,
        integrated: this.store.tasks.filter((task) => task.state === 'integrated').length,
        artifacts: this.store.snapshot.artifacts.length,
        durationMs: finishedAt - (this.store.run.startedAt ?? this.store.run.createdAt)
      })
    } else if (status === 'cancelled') {
      this.store.emit('run.cancelled', undefined, {
        reason: this.stopReason ?? 'task-cancelled',
        cancelledTasks: this.store.tasks.filter((task) => task.state === 'cancelled').map((task) => task.id)
      })
    } else {
      this.store.emit('run.failed', undefined, {
        failedTasks: this.store.tasks
          .filter((task) => task.state === 'failed')
          .map((task) => ({ id: task.id, role: task.role, code: task.error?.code ?? 'unknown' })),
        fatal: this.fatalError ? errorMessage(this.fatalError) : undefined,
        persistence: this.persistenceError ? errorMessage(this.persistenceError) : undefined,
        integration: report?.status ?? null
      })
    }

    await this.persist()
    this.result = this.buildResult()
    return this.result
  }

  private buildResult(): RunResult {
    const run = this.store.run
    const finishedAt = run.finishedAt ?? this.clock.now()
    return {
      runId: run.runId,
      projectId: run.projectId,
      status: run.status,
      ...(run.stopReason ? { stopReason: run.stopReason } : {}),
      ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
      durationMs: Math.max(0, finishedAt - (run.startedAt ?? run.createdAt)),
      maxConcurrency: this.maxConcurrency,
      plan: this.store.plan,
      tasks: this.store.tasks.map((task) => ({ ...task })),
      artifacts: [...this.store.snapshot.artifacts],
      messages: [...this.store.snapshot.messages],
      events: [...this.store.events],
      integration: this.store.snapshot.integration
    }
  }

  private async waitForTaskTerminal(taskId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const task = this.store.findTask(taskId)
      if (!task || isTerminalTaskState(task.state)) return
      await sleep(10)
    }
  }

  private persist(): Promise<void> {
    const next = this.flushChain
      .then(() => this.store.flush())
      .catch((error: unknown) => {
        this.persistenceError = error
        this.notify()
      })
    this.flushChain = next
    return next
  }

  private persistSoon(): void {
    void this.persist()
  }
}
