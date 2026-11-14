/**
 * In-process subagent runtime.
 *
 * Every delegated task becomes a real Pi `AgentSession` created with
 * `createAgentSession`, its own `SessionManager` (linked to the parent session
 * file through `parentSession`), its own context window and its own abort
 * path. Child sessions share the process, the model runtime, the workspace
 * tool definitions and the event channel, so a three-way fan-out costs no
 * extra process, credential handling or Pi bootstrap.
 *
 * Children never receive the delegate tool, so recursion is structurally
 * impossible rather than prompt-enforced.
 *
 * This module deliberately imports Pi types only (`import type`), which keeps
 * it runnable under Node's native type stripping for offline smoke tests.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  ToolDefinition
} from '@earendil-works/pi-coding-agent'
import type { SubagentTaskState } from '../shared/protocol'

type PiModule = typeof import('@earendil-works/pi-coding-agent')
type RuntimeModel = NonNullable<ReturnType<ModelRuntime['getModel']>>

export interface SubagentTaskInput {
  title: string
  prompt: string
}

export interface SubagentRuntimeOptions {
  pi: PiModule
  modelRuntime: ModelRuntime
  model: RuntimeModel
  cwd: string
  agentDir: string
  /** Directory for child session files, normally `<sessionDir>/subagents`. */
  sessionDir: string
  /** Parent session file; children are linked as a branch of this session. */
  parentSessionFile?: string
  customTools: Array<ToolDefinition<any, any, any>>
  /** Same allowlist the parent uses, minus the delegate tool itself. */
  tools: string[]
  settingsManager: SettingsManager
  /** System-prompt extensions the parent uses (date/role only, no memory). */
  extensionFactories?: ExtensionFactory[]
  maxConcurrency?: number
  timeoutMs?: number
  maxResultChars?: number
  onUpdate?: (task: SubagentTaskState) => void
}

export type SubagentOutcome = 'done' | 'failed' | 'aborted' | 'timeout'

export interface SubagentTaskResult {
  taskId: string
  title: string
  outcome: SubagentOutcome
  /** Final assistant text, trimmed and truncated. Empty on hard failures. */
  text: string
  error?: string
  sessionId?: string
  sessionFile?: string
  assistantMessages: number
  durationMs: number
}

export const SUBAGENT_MAX_TASKS = 4
const DEFAULT_CONCURRENCY = 3
const MAX_CONCURRENCY = 4
const DEFAULT_TIMEOUT_MS = 180_000
const MIN_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_MAX_RESULT_CHARS = 12_000

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const typed = part as { type?: unknown; text?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
  }
  return parts.join('\n\n')
}

/** Last non-empty assistant text: the child's answer, or its partial draft. */
function extractAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | undefined
    if (!message || message.role !== 'assistant') continue
    const text = contentText(message.content).trim()
    if (text !== '') return text
  }
  return ''
}

function countAssistantMessages(messages: readonly unknown[]): number {
  let count = 0
  for (const message of messages) {
    if ((message as { role?: unknown } | undefined)?.role === 'assistant') count += 1
  }
  return count
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…（已截断，原文 ${text.length} 字符）`
}

/** AbortController-compatible composition without relying on AbortSignal.any. */
function combineSignals(signals: AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const listeners: Array<() => void> = []
  const onAbort = (): void => controller.abort()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', onAbort, { once: true })
    listeners.push(() => signal.removeEventListener('abort', onAbort))
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const remove of listeners) remove()
    }
  }
}

interface QueueItem {
  task: SubagentTaskInput
  index: number
}

export class SubagentRuntime {
  private readonly options: SubagentRuntimeOptions
  private readonly concurrencyValue: number
  private readonly timeoutMs: number
  private readonly maxResultChars: number
  /** Sessions currently streaming; `abortAll` reaches each of them. */
  private readonly active = new Set<AgentSession>()
  /** Runtime-wide cancellation (parent stop, session close, host shutdown). */
  private readonly controller = new AbortController()
  private closed = false

  constructor(options: SubagentRuntimeOptions) {
    this.options = options
    this.concurrencyValue = clampInt(options.maxConcurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY)
    this.timeoutMs = clampInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
    this.maxResultChars = clampInt(options.maxResultChars, DEFAULT_MAX_RESULT_CHARS, 1_000, 60_000)
  }

  get maxTasks(): number {
    return SUBAGENT_MAX_TASKS
  }

  /** Effective parallelism after clamping `maxConcurrency`. */
  get concurrency(): number {
    return this.concurrencyValue
  }

  /** Cancel every running child. Safe to call when idle. */
  abortAll(): void {
    this.controller.abort()
    for (const session of this.active) {
      void session.abort().catch(() => undefined)
    }
  }

  dispose(): void {
    this.closed = true
    this.abortAll()
    this.active.clear()
  }

  async run(
    tasks: SubagentTaskInput[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<SubagentTaskResult[]> {
    const limited = tasks.slice(0, SUBAGENT_MAX_TASKS)
    const taskIds = limited.map(() => `sa-${randomUUID().slice(0, 8)}`)
    limited.forEach((task, index) => {
      this.emit({ taskId: taskIds[index] ?? '', title: task.title, status: 'queued' })
    })

    const sources = [this.controller.signal]
    if (options.signal) sources.push(options.signal)
    const combined = combineSignals(sources)
    const queue: QueueItem[] = limited.map((task, index) => ({ task, index }))
    const results = new Array<SubagentTaskResult | undefined>(limited.length)

    try {
      const workers = Math.min(this.concurrencyValue, Math.max(1, limited.length))
      await Promise.all(
        Array.from({ length: workers }, () =>
          this.work(queue, results, taskIds, combined.signal, options.timeoutMs)
        )
      )
    } finally {
      combined.dispose()
    }

    return results.map((result, index) => {
      if (result) return result
      const task = limited[index]
      const taskId = taskIds[index] ?? ''
      return {
        taskId,
        title: task?.title ?? '',
        outcome: 'aborted' as const,
        text: '',
        error: '子任务未执行',
        assistantMessages: 0,
        durationMs: 0
      }
    })
  }

  private async work(
    queue: QueueItem[],
    results: Array<SubagentTaskResult | undefined>,
    taskIds: string[],
    signal: AbortSignal,
    timeoutMs: number | undefined
  ): Promise<void> {
    for (;;) {
      const next = queue.shift()
      if (!next) return
      const taskId = taskIds[next.index] ?? `sa-${next.index}`
      results[next.index] = await this.runOne(taskId, next.task, signal, timeoutMs)
    }
  }

  private async runOne(
    taskId: string,
    task: SubagentTaskInput,
    signal: AbortSignal,
    timeoutMs: number | undefined
  ): Promise<SubagentTaskResult> {
    const startedAt = Date.now()
    const finish = (outcome: SubagentOutcome, extra: Partial<SubagentTaskResult> = {}): SubagentTaskResult => {
      const result: SubagentTaskResult = {
        taskId,
        title: task.title,
        outcome,
        text: extra.text ?? '',
        assistantMessages: extra.assistantMessages ?? 0,
        durationMs: Date.now() - startedAt
      }
      if (extra.error) result.error = extra.error
      if (extra.sessionId) result.sessionId = extra.sessionId
      if (extra.sessionFile) result.sessionFile = extra.sessionFile
      this.emit({
        taskId,
        title: task.title,
        status: outcome === 'done' ? 'done' : outcome,
        ...(result.error ? { detail: result.error } : {}),
        durationMs: result.durationMs
      })
      return result
    }

    if (this.closed) return finish('aborted', { error: '子 Agent 运行时已关闭' })
    if (signal.aborted) return finish('aborted', { error: '已取消' })

    this.emit({ taskId, title: task.title, status: 'running' })

    let session: AgentSession | null = null
    let unsubscribe: (() => void) | null = null
    try {
      const manager = this.createSessionManager()
      const loader = new this.options.pi.DefaultResourceLoader({
        cwd: this.options.cwd,
        agentDir: this.options.agentDir,
        settingsManager: this.options.settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: this.options.extensionFactories ?? []
      })
      await loader.reload()

      const created = await this.options.pi.createAgentSession({
        cwd: this.options.cwd,
        agentDir: this.options.agentDir,
        modelRuntime: this.options.modelRuntime,
        model: this.options.model,
        thinkingLevel: 'medium',
        tools: this.options.tools,
        customTools: this.options.customTools,
        sessionManager: manager,
        settingsManager: this.options.settingsManager,
        resourceLoader: loader
      })
      session = created.session
      this.active.add(session)

      unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        if (event.type === 'tool_execution_start') {
          this.emit({ taskId, title: task.title, status: 'tool', detail: event.toolName })
        }
      })

      const onAbort = (): void => {
        void session?.abort().catch(() => undefined)
      }
      if (signal.aborted) onAbort()
      signal.addEventListener('abort', onAbort, { once: true })

      const budget = clampInt(timeoutMs ?? this.timeoutMs, this.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        void session?.abort().catch(() => undefined)
      }, budget)

      let failure: unknown = null
      try {
        await session.prompt(task.prompt, { expandPromptTemplates: false })
      } catch (error) {
        failure = error
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }

      const messages = session.messages
      const text = truncate(extractAssistantText(messages), this.maxResultChars)
      const meta = {
        text,
        assistantMessages: countAssistantMessages(messages),
        sessionId: session.sessionId,
        ...(session.sessionFile ? { sessionFile: session.sessionFile } : {})
      }

      if (signal.aborted || this.closed) return finish('aborted', { ...meta, error: '已取消' })
      if (timedOut) return finish('timeout', { ...meta, error: `子任务超时（${Math.round(budget / 1000)} 秒）` })
      if (failure) return finish('failed', { ...meta, error: errorMessage(failure) })
      if (text === '') return finish('failed', { ...meta, error: '子 Agent 没有返回文本结果' })
      return finish('done', meta)
    } catch (error) {
      return finish('failed', { error: errorMessage(error) })
    } finally {
      if (unsubscribe) {
        try {
          unsubscribe()
        } catch {
          // Ignore: the session is being disposed anyway.
        }
      }
      if (session) {
        this.active.delete(session)
        try {
          session.dispose()
        } catch {
          // Ignore dispose failures; the host may be shutting down.
        }
      }
    }
  }

  private createSessionManager(): SessionManager {
    const { pi, cwd, sessionDir, parentSessionFile } = this.options
    mkdirSync(sessionDir, { recursive: true })
    return parentSessionFile
      ? pi.SessionManager.create(cwd, sessionDir, { parentSession: parentSessionFile })
      : pi.SessionManager.create(cwd, sessionDir)
  }

  private emit(task: SubagentTaskState): void {
    if (!this.options.onUpdate) return
    try {
      this.options.onUpdate(task)
    } catch {
      // UI callbacks must never break a child run.
    }
  }
}
