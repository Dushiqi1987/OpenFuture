import { join } from 'node:path'
import type {
  AgentEventPayload,
  AutomationListResult,
  AutomationRun,
  AutomationTask,
  ComputerToolInfo,
  OpenSessionResult,
  ProjectConversation,
  ProjectInfo
} from '../shared/protocol'
import { AgentHost } from './agent-host'
import type { AutomationStore } from './automation-store'
import { AppError, toErrorMessage } from './errors'
import type { MemoryHost } from './memory-host'
import type { ProjectStore } from './project-store'
import type { SettingsStore } from './settings-store'

export interface AutomationServiceOptions {
  modulePath: string
  store: AutomationStore
  projects: ProjectStore
  settings: SettingsStore
  memoryHost: MemoryHost
  environment: () => NodeJS.ProcessEnv
  onLog: (line: string) => void
  handleToolRequest: (workspace: string, tool: string, params: unknown) => Promise<unknown>
  handleContextRequest: (workspace: string, request: { mode: string; validateIds?: string[] }) => Promise<unknown>
  getComputerTools: () => Promise<ComputerToolInfo[]>
  /** Delivers a prompt into the conversation the user currently has open. */
  deliverToOpenConversation?: (piSessionId: string, prompt: string) => Promise<boolean>
  onChanged: () => void
}

const TICK_MS = 15_000
const RUN_TIMEOUT_MS = 15 * 60_000

function modeForPreset(preset: ProjectInfo['memoryPreset']): 'off' | 'rag' | 'wiki' | 'both' {
  if (preset === 'rag' || preset === 'wiki') return preset
  if (preset === 'dreaming' || preset === 'both') return 'both'
  return 'off'
}

function eventMessage(payload: AgentEventPayload): { text?: string; error?: string; settled?: boolean } {
  const event = payload.event
  if (event.type === 'assistant-message') {
    return { text: typeof event.message.text === 'string' ? event.message.text : '' }
  }
  if (event.type === 'error') return { error: event.message }
  if (event.type === 'settled') return { settled: true }
  return {}
}

/**
 * Runs scheduled prompts in a dedicated AgentHost. The user's interactive
 * session is never used, so a task can run while the user is idle or looking
 * at another conversation. Runs are serialized to keep memory/CPU bounded.
 */
export class AutomationService {
  private readonly options: AutomationServiceOptions
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private readonly running = new Set<string>()

  constructor(options: AutomationServiceOptions) {
    this.options = options
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
    // Do not wait a full tick for a task that became due while the app was closed.
    setTimeout(() => void this.tick(), 2_000).unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  runningTaskIds(): string[] {
    return [...this.running]
  }

  list(): AutomationListResult {
    const tasks = this.options.store.list().map((task) => {
      const project = this.safeProject(task.projectId)
      return project ? { ...task, projectName: project.name } : task
    })
    return { tasks, runs: this.options.store.runsFor() }
  }

  async runNow(taskId: string): Promise<AutomationTask> {
    const task = this.options.store.get(taskId)
    if (!task) throw new AppError('VALIDATION', '自动化任务不存在')
    if (this.running.has(taskId)) throw new AppError('VALIDATION', '该任务正在运行')
    this.running.add(taskId)
    this.options.onChanged()
    void this.execute(task)
      .catch((error: unknown) => {
        this.options.onLog(`[automation] ${task.title} failed: ${toErrorMessage(error)}`)
      })
      .finally(() => {
        this.running.delete(taskId)
        this.options.onChanged()
      })
    return task
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const due = this.options.store.due()
      for (const task of due) {
        if (this.running.has(task.id)) continue
        this.running.add(task.id)
        this.options.onChanged()
        try {
          await this.execute(task)
        } catch (error) {
          this.options.onLog(`[automation] ${task.title} failed: ${toErrorMessage(error)}`)
        } finally {
          this.running.delete(task.id)
          this.options.onChanged()
        }
      }
    } finally {
      this.ticking = false
    }
  }

  private safeProject(projectId: string): ProjectInfo | null {
    try {
      return this.options.projects.get(projectId)
    } catch {
      return null
    }
  }

  private async execute(task: AutomationTask): Promise<void> {
    const project = this.safeProject(task.projectId)
    if (!project) {
      this.finishWithoutConversation(task, '任务绑定的项目不存在')
      return
    }
    if (!project.available) {
      this.finishWithoutConversation(task, '项目目录不可用，请重新定位后再运行')
      return
    }

    let targetConversation: ProjectConversation | null = null
    if (task.targetConversationId) {
      try {
        targetConversation = this.options.projects.getConversation(task.projectId, task.targetConversationId)
      } catch {
        this.finishWithoutConversation(task, '任务绑定的对话不存在，可能已被删除')
        return
      }
      if (!targetConversation.piSessionId) {
        this.finishWithoutConversation(task, '任务绑定的对话还没有建立会话，请先在对话里发送一条消息')
        return
      }
    }

    let conversationId: string | undefined = targetConversation?.id
    let sessionId: string | undefined = targetConversation?.piSessionId
    let host: AgentHost | null = null
    const run = this.options.store.startRun(task.id)
    this.options.onChanged()

    try {
      // Prefer the user's already-open host. This makes the due prompt appear
      // live in the target conversation instead of opening a second writer on
      // the same Pi session file.
      if (targetConversation?.piSessionId) {
        const delivered = await this.options.deliverToOpenConversation?.(
          targetConversation.piSessionId,
          task.prompt
        )
        if (delivered) {
          this.options.store.finishRun(run.id, {
            ok: true,
            output: '已投递到当前打开的对话，结果会显示在那个对话里。',
            conversationId,
            sessionId
          })
          this.options.onLog(`[automation] ${task.title} delivered into the open conversation`)
          return
        }
      }

      const credential = this.options.settings.getActiveCredential()
      if (!targetConversation) {
        const conversation = this.options.projects.createConversation(
          project.id,
          `${task.title} · ${new Date().toLocaleString('zh-CN')}`
        )
        conversationId = conversation.id
      }

      let output = ''
      let runtimeError: string | undefined
      let settledResolve: (() => void) | null = null
      const settled = new Promise<void>((resolve) => {
        settledResolve = resolve
      })
      host = new AgentHost({
        modulePath: this.options.modulePath,
        environment: this.options.environment,
        onLog: (line) => this.options.onLog(`[automation] ${line}`),
        onEvent: (payload) => {
          const message = eventMessage(payload)
          if (message.text !== undefined) output = message.text
          if (message.error) runtimeError = message.error
          if (message.settled) settledResolve?.()
        },
        onToolRequest: (tool, params) => this.options.handleToolRequest(project.canonicalRoot, tool, params),
        onContextRequest: (request) => this.options.handleContextRequest(project.canonicalRoot, request),
        getComputerTools: this.options.getComputerTools
      })

      await host.setCredential(credential.providerId, credential.apiKey)
      const mode = modeForPreset(project.memoryPreset)
      await this.options.memoryHost.setMode(project.canonicalRoot, mode)
      const opened: OpenSessionResult = await host.open(
        project.canonicalRoot,
        targetConversation?.piSessionId,
        mode,
        this.options.settings.getComputerUse(),
        false
      )
      sessionId = opened.sessionId
      if (!targetConversation && conversationId) {
        this.options.projects.bindConversation(project.id, conversationId, opened.sessionId)
      }

      await host.send(task.prompt)
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new AppError('HOST_UNAVAILABLE', '自动化任务运行超时')), RUN_TIMEOUT_MS).unref?.()
      })
      await Promise.race([settled, timeout])
      if (runtimeError) throw new AppError('PI_ERROR', runtimeError)
      this.options.store.finishRun(run.id, {
        ok: true,
        output: output.slice(0, 60_000),
        conversationId,
        sessionId
      })
      this.options.onLog(`[automation] ${task.title} completed`)
    } catch (error) {
      this.options.store.finishRun(run.id, {
        ok: false,
        error: toErrorMessage(error).slice(0, 4_000),
        conversationId,
        sessionId
      })
      this.options.onLog(`[automation] ${task.title} failed: ${toErrorMessage(error)}`)
    } finally {
      try {
        await host?.close()
      } catch {
        // Host may already be gone.
      }
      host?.dispose()
      this.options.onChanged()
    }
  }

  private finishWithoutConversation(task: AutomationTask, error: string): void {
    const run = this.options.store.startRun(task.id)
    this.options.store.finishRun(run.id, { ok: false, error })
    this.options.onLog(`[automation] ${task.title} failed: ${error}`)
    this.options.onChanged()
  }
}
