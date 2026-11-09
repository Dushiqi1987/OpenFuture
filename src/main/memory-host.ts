import { utilityProcess } from 'electron'
import type {
  CorrectNoteInput,
  CreateNoteInput,
  DecideProposalInput,
  DreamApplyInput,
  DreamJob,
  DreamQuality,
  DreamRevokeInput,
  DreamScheduleInput,
  DreamScheduleState,
  DreamRollbackInput,
  DreamState,
  DreamVersion,
  GenerateWikiInput,
  IpcErrorCode,
  L3Context,
  MemoryDiagnostics,
  MemoryNote,
  MemoryProposal,
  MemorySearchResult,
  MemorySource,
  MemoryWorkspaceState,
  UpdateNoteInput,
  WikiPage
} from '../shared/protocol'
import { AppError, toErrorMessage } from './errors'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: AppError) => void
  timer: NodeJS.Timeout
}

interface MemoryHostOptions {
  modulePath: string
  environment: () => NodeJS.ProcessEnv
  onLog: (line: string) => void
}

const DIAGNOSTICS_TIMEOUT_MS = 30_000
const RPC_TIMEOUT_MS = 30_000

/**
 * Owns the memory utilityProcess. Only this process writes the SQLite facts;
 * the agent host and renderer can merely ask for typed memory operations.
 */
export class MemoryHost {
  private child: Electron.UtilityProcess | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 0
  private readonly options: MemoryHostOptions

  constructor(options: MemoryHostOptions) {
    this.options = options
  }

  async diagnostics(): Promise<MemoryDiagnostics> {
    return this.call<MemoryDiagnostics>('diagnostics', {}, DIAGNOSTICS_TIMEOUT_MS)
  }

  async state(workspace: string): Promise<MemoryWorkspaceState> {
    return this.call<MemoryWorkspaceState>('state', { workspace })
  }

  async setMode(workspace: string, mode: string): Promise<MemoryWorkspaceState> {
    return this.call<MemoryWorkspaceState>('setMode', { workspace, mode })
  }

  async importSource(input: {
    workspace: string
    title?: string
    origin: string
    kind?: string
  } & ({ content: string } | { pdfBase64: string })): Promise<MemorySource> {
    return this.call<MemorySource>('importSource', input)
  }

  async listSources(workspace: string): Promise<MemorySource[]> {
    return this.call<MemorySource[]>('listSources', { workspace })
  }

  async revokeSource(workspace: string, id: string): Promise<void> {
    await this.call<void>('revokeSource', { workspace, id })
  }

  async search(workspace: string, query: string, limit = 10): Promise<MemorySearchResult> {
    return this.call<MemorySearchResult>('search', { workspace, query, limit })
  }

  async get(workspace: string, id: string): Promise<unknown> {
    return this.call<unknown>('get', { workspace, id })
  }

  async listNotes(workspace: string): Promise<MemoryNote[]> {
    return this.call<MemoryNote[]>('listNotes', { workspace })
  }

  async createNote(workspace: string, input: CreateNoteInput): Promise<MemoryNote> {
    return this.call<MemoryNote>('createNote', { workspace, ...input })
  }

  async updateNote(workspace: string, input: UpdateNoteInput): Promise<MemoryNote> {
    return this.call<MemoryNote>('updateNote', { workspace, ...input })
  }

  async correctNote(workspace: string, input: CorrectNoteInput): Promise<MemoryProposal> {
    return this.call<MemoryProposal>('correctNote', { workspace, ...input })
  }

  async revokeNote(workspace: string, id: string): Promise<void> {
    await this.call<void>('revokeNote', { workspace, id })
  }

  async generateWiki(workspace: string, input?: GenerateWikiInput): Promise<WikiPage[]> {
    return this.call<WikiPage[]>('generateWiki', { workspace, ...(input ?? {}) })
  }

  async listWiki(workspace: string): Promise<WikiPage[]> {
    return this.call<WikiPage[]>('listWiki', { workspace })
  }

  async publishWiki(workspace: string, id: string): Promise<WikiPage> {
    return this.call<WikiPage>('publishWiki', { workspace, id })
  }

  async revokeWiki(workspace: string, id: string): Promise<void> {
    await this.call<void>('revokeWiki', { workspace, id })
  }

  async listProposals(workspace: string): Promise<MemoryProposal[]> {
    return this.call<MemoryProposal[]>('listProposals', { workspace })
  }

  async decideProposal(workspace: string, input: DecideProposalInput): Promise<MemoryProposal> {
    return this.call<MemoryProposal>('decideProposal', { workspace, ...input })
  }

  async createProposal(
    workspace: string,
    input: { type: string; title: string; body: string; evidenceIds: string[] }
  ): Promise<MemoryProposal> {
    return this.call<MemoryProposal>('createProposal', { workspace, ...input })
  }

  async dreamStart(workspace: string): Promise<DreamJob> {
    return this.call<DreamJob>('dreamStart', { workspace })
  }

  async dreamInspect(workspace: string, jobId: string): Promise<DreamJob | null> {
    return this.call<DreamJob | null>('dreamInspect', { workspace, jobId })
  }

  async dreamApply(workspace: string, input: DreamApplyInput): Promise<DreamVersion> {
    return this.call<DreamVersion>('dreamApply', { workspace, ...input })
  }

  async dreamReject(workspace: string, jobId: string): Promise<DreamJob> {
    return this.call<DreamJob>('dreamReject', { workspace, jobId })
  }

  async dreamState(workspace: string): Promise<DreamState> {
    return this.call<DreamState>('dreamState', { workspace })
  }

  async dreamRollback(workspace: string, input?: DreamRollbackInput): Promise<DreamVersion | null> {
    return this.call<DreamVersion | null>('dreamRollback', { workspace, ...(input ?? {}) })
  }

  async dreamRevoke(workspace: string, input: DreamRevokeInput): Promise<DreamVersion> {
    return this.call<DreamVersion>('dreamRevoke', { workspace, ...input })
  }

  async dreamQuality(workspace: string): Promise<DreamQuality> {
    return this.call<DreamQuality>('dreamQuality', { workspace })
  }

  async dreamSchedule(workspace: string): Promise<DreamScheduleState> {
    return this.call<DreamScheduleState>('dreamSchedule', { workspace })
  }

  async dreamSetSchedule(workspace: string, input: DreamScheduleInput): Promise<DreamScheduleState> {
    return this.call<DreamScheduleState>('dreamSetSchedule', { workspace, ...input })
  }

  async l3Context(workspace: string, mode: string): Promise<L3Context> {
    return this.call<L3Context>('l3Context', { workspace, mode })
  }

  async validateIds(workspace: string, ids: string[]): Promise<{ valid: string[] }> {
    return this.call<{ valid: string[] }>('validateIds', { workspace, ids })
  }

  /** Generic RPC used by the agent-tool bridge and UI IPC handlers. */
  async call<T>(method: string, params: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
    let child: Electron.UtilityProcess
    try {
      child = this.ensureChild()
    } catch (error) {
      throw new AppError('HOST_UNAVAILABLE', `无法启动记忆进程：${toErrorMessage(error)}`)
    }

    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AppError('HOST_UNAVAILABLE', `记忆进程响应超时（${method}）`))
      }, timeoutMs)

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })

      try {
        child.postMessage({ kind: 'request', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new AppError('HOST_UNAVAILABLE', `向记忆进程发送请求失败：${toErrorMessage(error)}`))
      }
    })
  }

  dispose(): void {
    this.kill()
  }

  private ensureChild(): Electron.UtilityProcess {
    if (this.child) return this.child

    const child = utilityProcess.fork(this.options.modulePath, [], {
      env: { ...process.env, ...this.options.environment() },
      stdio: 'pipe',
      serviceName: 'OpenFuture Memory Host'
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
      this.failPending(new AppError('HOST_UNAVAILABLE', `记忆进程已退出（code ${code}）`))
      this.options.onLog(`[memory-host] exited with code ${code}`)
    })

    this.child = child
    this.options.onLog('[memory-host] started')
    return child
  }

  private handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const message = raw as {
      kind?: string
      id?: number
      ok?: boolean
      value?: unknown
      error?: { code?: IpcErrorCode; message?: string }
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
    const code = message.error?.code ?? 'INTERNAL'
    const text = message.error?.message || '记忆主机返回未知错误'
    pending.reject(new AppError(code, text))
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
      if (trimmed) this.options.onLog(`[memory-host] ${trimmed.slice(0, 4_000)}`)
    }
  }

  private kill(): void {
    const child = this.child
    this.child = null
    this.failPending(new AppError('HOST_UNAVAILABLE', '记忆进程已停止'))
    if (child) child.kill()
  }
}
