import type {
  AgentRole,
  OpenSessionResult,
  SessionSummary,
  StartGroupChatInput,
  StartGroupChatResult,
  UserPromptAnswerInput
} from '../shared/protocol'
import type { AgentHost } from './agent-host'
import { AppError } from './errors'

/**
 * Conversations run in parallel, one utility process per conversation. Keeping
 * them separate means a long turn in one conversation never blocks another:
 * each host owns its own Pi session, its own tool registry and its own queue.
 * The default cap keeps memory bounded; conversations that are not streaming
 * are evicted first when the cap is reached.
 */
const MAX_LIVE_HOSTS = Math.max(2, Number(process.env.OPENFUTURE_MAX_CONVERSATIONS ?? '3') || 3)

export class HostRegistry {
  private readonly hosts = new Map<string, AgentHost>()
  /** A host without a session, used for session listing and plugin adaptation. */
  private spareHost: AgentHost | null = null
  private activeId: string | null = null
  private readonly factory: () => AgentHost

  constructor(factory: () => AgentHost) {
    this.factory = factory
  }

  /** Conversation whose events the renderer is currently showing. */
  currentSessionId(): string | null {
    return this.activeId
  }

  liveSessionIds(): string[] {
    return [...this.hosts.keys()]
  }

  runningSessionIds(): string[] {
    return [...this.hosts.entries()].filter(([, host]) => host.isStreaming()).map(([id]) => id)
  }

  private spare(): AgentHost {
    if (!this.spareHost) this.spareHost = this.factory()
    return this.spareHost
  }

  /**
   * Evict finished conversations before refusing a new one. A streaming host
   * is never evicted: the user asked for it to keep running.
   */
  private evictIdle(): void {
    for (const [id, host] of this.hosts) {
      if (this.hosts.size < MAX_LIVE_HOSTS) return
      if (host.isStreaming()) continue
      try {
        host.dispose()
      } catch {
        // The child is already gone; dropping the entry is enough.
      }
      this.hosts.delete(id)
      if (this.activeId === id) this.activeId = null
    }
  }

  async open(
    workspace: string,
    sessionId?: string,
    memoryMode?: string,
    computerUse = false,
    automationTools = true,
    agentRole?: AgentRole,
    pluginExtensions?: string[]
  ): Promise<OpenSessionResult> {
    // Switching back to a conversation that is still live: read from the
    // running session instead of opening a second writer on the same JSONL.
    if (sessionId && this.hosts.has(sessionId)) {
      const host = this.hosts.get(sessionId) as AgentHost
      try {
        const live = await host.history()
        this.activeId = sessionId
        return { ...live }
      } catch {
        host.dispose()
        this.hosts.delete(sessionId)
        if (this.activeId === sessionId) this.activeId = null
      }
    }

    this.evictIdle()
    if (this.hosts.size >= MAX_LIVE_HOSTS) {
      throw new AppError('VALIDATION', `最多同时运行 ${MAX_LIVE_HOSTS} 个对话，请先停止一个再打开新的对话`)
    }

    const host = this.factory()
    try {
      const result = await host.open(
        workspace,
        sessionId,
        memoryMode,
        computerUse,
        automationTools,
        agentRole,
        pluginExtensions
      )
      this.hosts.set(result.sessionId, host)
      this.activeId = result.sessionId
      return result
    } catch (error) {
      host.dispose()
      throw error
    }
  }

  private require(sessionId?: string): { sessionId: string; host: AgentHost } {
    const id = sessionId ?? this.activeId
    if (!id) throw new AppError('SESSION_NOT_FOUND', '当前没有打开的会话')
    const host = this.hosts.get(id)
    if (!host || !host.hasSession()) {
      throw new AppError('SESSION_NOT_FOUND', '该对话已关闭，请重新打开')
    }
    this.activeId = id
    return { sessionId: id, host }
  }

  async send(
    text: string,
    mode: 'prompt' | 'steer' | 'followUp' = 'prompt',
    sessionId?: string
  ): Promise<void> {
    const target = this.require(sessionId)
    await target.host.send(text, mode, target.sessionId)
  }

  async stop(sessionId?: string): Promise<void> {
    const id = sessionId ?? this.activeId
    if (!id) return
    const host = this.hosts.get(id)
    if (!host) return
    await host.stop(id)
  }

  async close(sessionId?: string): Promise<void> {
    const id = sessionId ?? this.activeId
    if (!id) return
    const host = this.hosts.get(id)
    if (!host) return
    try {
      await host.close()
    } catch {
      // A dead child already dropped its session.
    } finally {
      host.dispose()
      this.hosts.delete(id)
      if (this.activeId === id) this.activeId = null
    }
  }

  async closeAll(): Promise<void> {
    const hosts = [...this.hosts.values()]
    this.hosts.clear()
    this.activeId = null
    await Promise.all(
      hosts.map(async (host) => {
        try {
          await host.close()
        } catch {
          // Ignore; dispose still tears the child down.
        }
        host.dispose()
      })
    )
  }

  /** Settings changed: drop every host so the next RPC starts a fresh one. */
  restart(): void {
    this.disposeAll()
  }

  /** Quit path: tear every child process down. */
  dispose(): void {
    this.disposeAll()
  }

  disposeAll(): void {
    for (const host of this.hosts.values()) host.dispose()
    this.hosts.clear()
    this.activeId = null
    this.spareHost?.dispose()
    this.spareHost = null
  }

  reloadPlugins(): void {
    for (const host of this.hosts.values()) host.reloadPlugins()
    this.spareHost?.reloadPlugins()
  }

  async setCredential(providerId: string, apiKey: string): Promise<void> {
    for (const host of this.hosts.values()) {
      await host.setCredential(providerId, apiKey)
    }
    if (this.spareHost) await this.spareHost.setCredential(providerId, apiKey)
  }

  async list(workspace: string): Promise<SessionSummary[]> {
    return this.spare().list(workspace)
  }

  async adaptPlugin(input: {
    cwd: string
    name: string
    description: string
    sources: { path: string; text: string }[]
  }): Promise<{ code: string; note: string }> {
    return this.spare().adaptPlugin(input)
  }

  async answerPrompt(input: UserPromptAnswerInput): Promise<{ ok: true; answer: string }> {
    return this.require(input.sessionId).host.answerPrompt(input)
  }

  async startGroupChat(
    input: StartGroupChatInput & { roleModels?: Record<string, { providerId: string; modelId: string }> }
  ): Promise<StartGroupChatResult> {
    return this.require(input.sessionId).host.startGroupChat(input)
  }
}
