import { utilityProcess } from 'electron'
import type {
  AgentEventPayload,
  AgentStreamEvent,
  ComputerToolInfo,
  IpcErrorCode,
  OpenSessionResult,
  SessionSummary
} from '../shared/protocol'
import { AppError, toErrorCode, toErrorMessage } from './errors'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: AppError) => void
  timer: NodeJS.Timeout
}

interface HostResponse {
  kind: 'response'
  id: number
  ok: boolean
  value?: unknown
  error?: { code?: IpcErrorCode; message?: string }
}

interface HostEventMessage {
  kind: 'event'
  event: AgentStreamEvent
}

interface HostToolRequest {
  kind: 'tool-request'
  id: number
  tool: string
  params: unknown
}

interface HostContextRequest {
  kind: 'context-request'
  id: number
  mode: string
  validateIds?: string[]
}

interface ContextRequestPayload {
  mode: string
  validateIds?: string[]
}

type HostMessage = HostResponse | HostEventMessage | HostToolRequest | HostContextRequest

interface AgentHostOptions {
  modulePath: string
  environment: () => NodeJS.ProcessEnv
  onEvent: (payload: AgentEventPayload) => void
  onLog: (line: string) => void
  /** Purpose-limited bridge used by memory_search/wiki_search/etc. */
  onToolRequest?: (tool: string, params: unknown) => Promise<unknown>
  /** Purpose-limited bridge used to build L3 context or validate history ids. */
  onContextRequest?: (request: ContextRequestPayload) => Promise<unknown>
  /** Returns Computer Use tool definitions only after the user enables them. */
  getComputerTools?: () => Promise<ComputerToolInfo[]>
}

const OPEN_TIMEOUT_MS = 60_000
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_LOG_LINE = 4_000
const MAX_PENDING_LOGS = 200

/**
 * Owns the agent utilityProcess. The host process is disposable: if it crashes
 * or the model configuration changes we kill it and fork a fresh one, so stale
 * credentials or a broken Pi session can never leak into the next request.
 */
export class AgentHost {
  private child: Electron.UtilityProcess | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private readonly logs: string[] = []
  private nextId = 0
  private sessionId: string | null = null
  private readonly options: AgentHostOptions

  constructor(options: AgentHostOptions) {
    this.options = options
  }

  currentSessionId(): string | null {
    return this.sessionId
  }

  requireSessionId(): string {
    if (!this.sessionId) throw new AppError('SESSION_NOT_FOUND', '当前没有打开的会话')
    return this.sessionId
  }

  async list(workspace: string): Promise<SessionSummary[]> {
    return this.rpc<SessionSummary[]>('list', { cwd: workspace }, OPEN_TIMEOUT_MS)
  }

  async open(
    workspace: string,
    sessionId?: string,
    memoryMode?: string,
    computerUse = false
  ): Promise<OpenSessionResult> {
    const computerTools = computerUse && this.options.getComputerTools
      ? await this.options.getComputerTools()
      : undefined
    const result = await this.rpc<OpenSessionResult>(
      'open',
      { cwd: workspace, sessionId, memoryMode, computerTools },
      OPEN_TIMEOUT_MS
    )
    this.sessionId = result.sessionId
    return result
  }

  async setCredential(providerId: string, apiKey: string): Promise<void> {
    await this.rpc('setCredential', { providerId, apiKey }, DEFAULT_TIMEOUT_MS)
  }

  async send(text: string): Promise<void> {
    await this.rpc('send', { sessionId: this.requireSessionId(), text }, DEFAULT_TIMEOUT_MS)
  }

  async stop(): Promise<void> {
    await this.rpc('stop', { sessionId: this.requireSessionId() }, DEFAULT_TIMEOUT_MS)
  }

  async close(): Promise<void> {
    const sessionId = this.sessionId
    if (!sessionId) return
    try {
      await this.rpc('close', { sessionId }, DEFAULT_TIMEOUT_MS)
    } finally {
      this.sessionId = null
    }
  }

  /** Restart the host, e.g. after model settings or credentials changed. */
  restart(): void {
    this.kill()
  }

  dispose(): void {
    this.kill()
  }

  private ensureChild(): Electron.UtilityProcess {
    if (this.child) return this.child

    const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.environment() }
    // Never let a launcher or a stale process leak a key through the regular
    // environment; credentials go over the purpose-limited setCredential RPC.
    delete env.OPENFUTURE_MODEL_API_KEY
    delete env.OPENFUTURE_MODEL_CREDENTIAL

    const child = utilityProcess.fork(this.options.modulePath, [], {
      env,
      stdio: 'pipe',
      serviceName: 'OpenFuture Agent Host'
    })

    child.stdout?.on('data', (chunk: Buffer) => this.captureLog(chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => this.captureLog(chunk.toString('utf8')))

    child.on('message', (message: unknown) => {
      if (this.child !== child) return
      this.handleMessage(message)
    })

    child.on('exit', (code: number) => {
      if (this.child !== child) return
      this.child = null
      const sessionId = this.sessionId
      this.sessionId = null
      this.failPending(new AppError('HOST_UNAVAILABLE', `Agent 进程已退出（code ${code}）`))
      if (sessionId) {
        this.options.onEvent({
          sessionId,
          event: { type: 'error', message: `Agent 进程已退出（code ${code}），请重新打开会话` }
        })
        this.options.onEvent({ sessionId, event: { type: 'status', state: 'idle' } })
        this.options.onEvent({ sessionId, event: { type: 'settled', aborted: false } })
      }
      this.options.onLog(`[agent-host] exited with code ${code}`)
    })

    this.child = child
    this.options.onLog('[agent-host] started')
    return child
  }

  private rpc<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    let child: Electron.UtilityProcess
    try {
      child = this.ensureChild()
    } catch (error) {
      return Promise.reject(new AppError('HOST_UNAVAILABLE', `无法启动 Agent 进程：${toErrorMessage(error)}`))
    }

    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AppError('HOST_UNAVAILABLE', `Agent 进程响应超时（${method}）`))
      }, timeoutMs)

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })

      try {
        child.postMessage({ kind: 'request', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new AppError('HOST_UNAVAILABLE', `向 Agent 进程发送请求失败：${toErrorMessage(error)}`))
      }
    })
  }

  private handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const message = raw as HostMessage
    if (message.kind === 'tool-request') {
      void this.answerToolRequest(message)
      return
    }
    if (message.kind === 'context-request') {
      void this.answerContextRequest(message)
      return
    }
    if (message.kind === 'event') {
      if (this.sessionId) {
        this.options.onEvent({ sessionId: this.sessionId, event: message.event })
      }
      return
    }
    if (message.kind !== 'response' || typeof message.id !== 'number') return

    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)

    if (message.ok) {
      pending.resolve(message.value)
      return
    }
    const code = message.error?.code ?? 'PI_ERROR'
    const text = message.error?.message || 'Agent 主机返回未知错误'
    pending.reject(new AppError(code, text))
  }

  private async answerToolRequest(request: HostToolRequest): Promise<void> {
    const child = this.child
    if (!child) return
    try {
      if (!this.options.onToolRequest) {
        throw new AppError('HOST_UNAVAILABLE', 'Agent 工具请求没有主进程处理器')
      }
      const value = await this.options.onToolRequest(request.tool, request.params)
      child.postMessage({ kind: 'tool-response', id: request.id, ok: true, value })
    } catch (error) {
      child.postMessage({
        kind: 'tool-response',
        id: request.id,
        ok: false,
        error: { code: toErrorCode(error), message: toErrorMessage(error) }
      })
    }
  }

  private async answerContextRequest(request: HostContextRequest): Promise<void> {
    const child = this.child
    if (!child) return
    try {
      if (!this.options.onContextRequest) {
        throw new AppError('HOST_UNAVAILABLE', '记忆上下文请求没有主进程处理器')
      }
      const value = await this.options.onContextRequest({
        mode: request.mode,
        ...(Array.isArray(request.validateIds) ? { validateIds: request.validateIds } : {})
      })
      child.postMessage({ kind: 'context-response', id: request.id, ok: true, value })
    } catch (error) {
      child.postMessage({
        kind: 'context-response',
        id: request.id,
        ok: false,
        error: { code: toErrorCode(error), message: toErrorMessage(error) }
      })
    }
  }

  private failPending(error: AppError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private captureLog(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const clipped = trimmed.length > MAX_LOG_LINE ? `${trimmed.slice(0, MAX_LOG_LINE)}…` : trimmed
      this.logs.push(clipped)
      if (this.logs.length > MAX_PENDING_LOGS) this.logs.shift()
      this.options.onLog(clipped)
    }
  }

  private kill(): void {
    const child = this.child
    this.child = null
    this.sessionId = null
    this.failPending(new AppError('HOST_UNAVAILABLE', 'Agent 进程已重启'))
    if (!child) return
    try {
      child.kill()
    } catch {
      // The process may already be gone.
    }
    this.options.onLog('[agent-host] stopped')
  }
}
