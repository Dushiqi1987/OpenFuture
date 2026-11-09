/**
 * Pi-backed worker for M1.
 *
 * Each task gets its own Pi session. The adapter never reuses a session across
 * tasks or attempts: identity is (projectId, runId, taskId, agentId, attempt,
 * baseRevision), and a resumable disconnect continues the same session rather
 * than silently reusing another task's context.
 */
import { TaskFailureError, abortError, errorCode, errorMessage, isTeamError } from '../core/errors.ts'
import { matchesScope } from '../core/roles.ts'
import type {
  ArtifactDraft,
  ArtifactRef,
  InboxMessage,
  TaskRecord,
  TaskResult,
  ToolName
} from '../core/types.ts'
import type { Worker, WorkerContext, WorkerFactory } from '../core/worker.ts'
import { PiSessionClient } from './client.ts'
import type { PiClientOptions, PiSessionEvent, PiSessionSpec } from './types.ts'

export interface PiWorkerOptions {
  endpoint?: string
  client?: PiSessionClient
  clientOptions?: Omit<PiClientOptions, 'baseUrl'>
  scenarioFor?: (task: TaskRecord) => string | undefined
  promptFor?: (context: WorkerContext) => string
  model?: string
  requestTimeoutMs?: number
  resume?: boolean
}

interface PiRunState {
  result?: TaskResult
  failure?: { code: string; message: string; retryable?: boolean; retryAfterMs?: number }
  cancelled?: boolean
  terminal: boolean
  lastSeq: number
}

export class PiWorker implements Worker {
  readonly id: string
  readonly task: TaskRecord
  private readonly options: PiWorkerOptions
  private readonly client: PiSessionClient

  constructor(task: TaskRecord, options: PiWorkerOptions) {
    this.task = task
    this.id = `pi:${task.role}:${task.id}`
    this.options = options
    if (options.client) {
      this.client = options.client
    } else if (options.endpoint) {
      this.client = new PiSessionClient({ baseUrl: options.endpoint, ...options.clientOptions })
    } else {
      throw new TaskFailureError('pi-endpoint-missing', 'PiWorker requires endpoint or client', { retryable: false })
    }
  }

  async run(context: WorkerContext): Promise<TaskResult> {
    const spec = this.buildSpec(context)
    const previous = this.options.resume === false ? undefined : findPreviousSession(context)
    let sessionId: string | undefined
    let resumed = false

    if (previous) {
      try {
        const response = await this.client.resumeSession(previous)
        sessionId = response.sessionId ?? previous
        resumed = true
        context.log(`pi-resumed:${sessionId}`)
      } catch (error) {
        // A session that already reached failed/completed cannot be resumed;
        // start a fresh session for the new attempt instead of losing the task.
        context.log(`pi-resume-skipped:${errorCode(error)}`)
      }
    }

    if (!sessionId) {
      const created = await this.client.createSession(spec)
      sessionId = created.sessionId
      context.log(`pi-session:${sessionId}`)
    }

    const state: PiRunState = { terminal: false, lastSeq: 0 }
    const streamController = new AbortController()
    const onAbort = (): void => {
      streamController.abort(context.signal.reason)
    }
    if (context.signal.aborted) {
      onAbort()
    } else {
      context.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      await this.client.stream(sessionId, {
        signal: streamController.signal,
        onEvent: async (event) => {
          state.lastSeq = event.seq
          await this.handleEvent(context, sessionId as string, event, state)
        }
      })
    } catch (error) {
      if (context.signal.aborted) {
        await this.cancelQuietly(sessionId, 'task-aborted')
        throw abortError(context.signal)
      }
      if (error instanceof TaskFailureError) {
        await this.cancelQuietly(sessionId, error.code)
        throw error
      }
      if (isTeamError(error)) {
        await this.cancelQuietly(sessionId, error.code)
        throw new TaskFailureError(error.code, error.message, { retryable: false, details: error.details })
      }
      await this.cancelQuietly(sessionId, 'stream-error')
      throw new TaskFailureError('pi-stream-failed', errorMessage(error), {
        retryable: true,
        retryAfterMs: 50,
        details: { sessionId, resumed }
      })
    } finally {
      context.signal.removeEventListener('abort', onAbort)
    }

    if (context.signal.aborted) {
      await this.cancelQuietly(sessionId, 'task-aborted')
      throw abortError(context.signal)
    }
    if (state.failure) {
      throw new TaskFailureError(state.failure.code, state.failure.message, {
        retryable: state.failure.retryable ?? false,
        retryAfterMs: state.failure.retryAfterMs
      })
    }
    if (state.cancelled) {
      throw new TaskFailureError('pi-session-cancelled', 'Pi session was cancelled', { retryable: false })
    }
    if (!state.result) {
      // Do not cancel a disconnected session: the next attempt resumes it.
      throw new TaskFailureError('pi-stream-disconnected', `Pi session ${sessionId} closed before a terminal event`, {
        retryable: true,
        retryAfterMs: 50,
        details: { sessionId, lastSeq: state.lastSeq, resumed }
      })
    }
    context.log(`pi-session-finished:${sessionId}`, 1)
    return state.result
  }

  private async handleEvent(
    context: WorkerContext,
    sessionId: string,
    event: PiSessionEvent,
    state: PiRunState
  ): Promise<void> {
    switch (event.type) {
      case 'session.started':
        context.log(`pi-started:${sessionId}`)
        return
      case 'session.resumed':
        context.log(`pi-resumed:${sessionId}`)
        return
      case 'message.delta':
        if (event.text.trim()) context.log(`pi:${event.text.trim().slice(0, 500)}`)
        return
      case 'progress':
        context.log(event.message, event.fraction)
        return
      case 'tool.request':
        await this.handleToolRequest(context, sessionId, event.requestId, event.tool, event.args)
        return
      case 'inbox.send':
        await this.handleInboxSend(context, sessionId, event.requestId, event.input)
        return
      case 'inbox.wait':
        await this.handleInboxWait(context, sessionId, event)
        return
      case 'artifact.publish':
        await this.handleArtifactPublish(context, sessionId, event.requestId, event.draft)
        return
      case 'session.completed':
        state.result = event.result
        state.terminal = true
        return
      case 'session.failed':
        state.failure = event.error
        state.terminal = true
        return
      case 'session.cancelled':
        state.cancelled = true
        state.terminal = true
        return
      default:
        return
    }
  }

  private async handleToolRequest(
    context: WorkerContext,
    sessionId: string,
    requestId: string,
    tool: ToolName,
    args: Record<string, unknown>
  ): Promise<void> {
    const denied = (code: string, message: string): Promise<never> => {
      return this.postInput(sessionId, {
        type: 'tool.result',
        requestId,
        ok: false,
        error: code
      }).then(() => {
        throw new TaskFailureError(code, message, { retryable: false, details: { tool, args } })
      })
    }

    if (!context.permissions.tools.includes(tool)) {
      await denied('pi-tool-denied', `tool ${tool} is outside the ${context.role} permission boundary`)
    }

    const target = typeof args.path === 'string' ? args.path : typeof args.target === 'string' ? args.target : undefined
    if (tool === 'write') {
      if (!target) await denied('pi-tool-argument', 'write tool request has no path argument')
      if (!context.canWrite(target as string)) {
        await denied('pi-write-denied', `write to ${target} is outside the task write scope`)
      }
    }
    if (tool === 'read' && target && !context.project.allowedReadPaths.some((scope) => matchesScope(scope, target))) {
      await denied('pi-read-denied', `read from ${target} is outside the project read policy`)
    }

    if (tool === 'read' && target) {
      const content = await context.readRepoFile(target)
      await this.postInput(sessionId, {
        type: 'tool.result',
        requestId,
        ok: content !== null,
        result: content === null ? undefined : { path: target, content },
        error: content === null ? 'not-found' : undefined
      })
      return
    }

    // The M1 prototype validates and acknowledges tool requests, but actual
    // shell/git/network/test execution belongs to the Pi workspace runtime.
    // File mutations are still checked from TaskResult.fileChanges by the engine.
    await this.postInput(sessionId, {
      type: 'tool.result',
      requestId,
      ok: true,
      result: { accepted: true, tool, note: 'executed by the Pi session workspace' }
    })
  }

  private async handleInboxSend(
    context: WorkerContext,
    sessionId: string,
    requestId: string,
    input: Parameters<WorkerContext['send']>[0]
  ): Promise<void> {
    const sent = context.send(input)
    await this.postInput(sessionId, {
      type: 'inbox.result',
      requestId,
      messageId: sent.message.id,
      duplicate: sent.duplicate === true
    })
  }

  private async handleInboxWait(
    context: WorkerContext,
    sessionId: string,
    event: Extract<PiSessionEvent, { type: 'inbox.wait' }>
  ): Promise<void> {
    try {
      const messages: InboxMessage[] = await context.wait({
        correlationId: event.correlationId,
        consumes: event.consumes,
        issues: event.issues,
        timeoutMs: event.timeoutMs ?? this.options.requestTimeoutMs ?? 3_000
      })
      await this.postInput(sessionId, { type: 'inbox.messages', requestId: event.requestId, messages })
    } catch (error) {
      await this.postInput(sessionId, {
        type: 'inbox.error',
        requestId: event.requestId,
        code: errorCode(error),
        message: errorMessage(error),
        retryable: error instanceof TaskFailureError ? error.retryable : false
      })
      throw error
    }
  }

  private async handleArtifactPublish(
    context: WorkerContext,
    sessionId: string,
    requestId: string,
    draft: ArtifactDraft
  ): Promise<void> {
    try {
      const artifact: ArtifactRef = await context.publish(draft)
      await this.postInput(sessionId, { type: 'artifact.result', requestId, artifact })
    } catch (error) {
      await this.postInput(sessionId, {
        type: 'artifact.error',
        requestId,
        code: errorCode(error),
        message: errorMessage(error)
      })
      throw error
    }
  }

  private async postInput(sessionId: string, input: Parameters<PiSessionClient['sendInput']>[1]): Promise<void> {
    try {
      await this.client.sendInput(sessionId, input)
    } catch (error) {
      if (isTeamError(error) && error.code === 'pi-http-error' && (error.details?.status === 404 || error.details?.status === 409)) {
        return
      }
      throw error
    }
  }

  private async cancelQuietly(sessionId: string, reason: string): Promise<void> {
    try {
      await this.client.cancelSession(sessionId, reason)
    } catch {
      // Cancellation is best effort; the engine's abort path is authoritative.
    }
  }

  private buildSpec(context: WorkerContext): PiSessionSpec {
    const prompt = this.options.promptFor
      ? this.options.promptFor(context)
      : defaultPrompt(context)
    const scenario = this.options.scenarioFor?.(this.task)
    const cardModel = context.card.model
    const model =
      this.options.model ??
      (typeof cardModel === 'string'
        ? cardModel
        : cardModel
          ? `${cardModel.providerId}/${cardModel.modelId}`
          : undefined)
    const spec: PiSessionSpec = {
      protocolVersion: '1.0',
      projectId: context.project.projectId,
      runId: context.runId,
      taskId: context.task.id,
      agentId: context.agentId,
      role: context.role,
      attempt: context.task.attempt,
      baseRevision: context.project.baseRevision,
      prompt,
      tools: [...context.permissions.tools],
      writeScopes: [...context.permissions.writeScopes],
      memoryView: context.permissions.memoryView,
      model,
      maxTurns: context.task.budget.maxTurns,
      maxTokens: context.task.budget.maxTokens,
      timeoutMs: context.task.budget.timeoutMs
    }
    if (scenario) spec.scenario = scenario
    return spec
  }
}

export function piWorkerFactory(options: PiWorkerOptions): WorkerFactory {
  const client = options.client ?? (options.endpoint ? new PiSessionClient({ baseUrl: options.endpoint, ...options.clientOptions }) : undefined)
  if (!client) {
    throw new TaskFailureError('pi-endpoint-missing', 'piWorkerFactory requires endpoint or client', { retryable: false })
  }
  return (task: TaskRecord): Worker => new PiWorker(task, { ...options, client })
}

function findPreviousSession(context: WorkerContext): string | undefined {
  if (context.task.attempt < 1) return undefined
  for (let index = context.task.progress.length - 1; index >= 0; index -= 1) {
    const entry = context.task.progress[index]
    if (!entry) continue
    if (entry.message.startsWith('pi-session:')) return entry.message.slice('pi-session:'.length)
  }
  return undefined
}

function defaultPrompt(context: WorkerContext): string {
  const lines = [
    `You are the ${context.role} role in OpenFuture run ${context.runId}.`,
    `Task: ${context.task.title}`,
    `Acceptance: ${context.task.acceptance.join('; ') || 'none stated'}`,
    `Workspace: ${context.project.rootPath}`,
    `Base revision: ${context.project.baseRevision}`,
    `Allowed write scopes: ${context.permissions.writeScopes.join(', ') || 'none'}`,
    'Use the inbox for requests and replies. Publish only versioned artifacts.'
  ]
  return lines.join('\n')
}
