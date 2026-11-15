import { dialog, ipcMain, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import type {
  AgentDesktopState,
  AgentSummary,
  GroupChatMembers,
  McpConfigState,
  McpServerInput,
  SaveSkillInput,
  SkillInfo,
  SkillLibraryEntry,
  ResolveLinkResult,
  GroupChatRecord,
  GroupChatSummary,
  PluginAdaptResult,
  PluginMarketState,
  SaveGroupModelProfileInput,
  AutomationListResult,
  AutomationRun,
  AutomationTask,
  CreateAutomationInput,
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
  ImportSessionEvidenceInput,
  ImportSourceInput,
  ImportSourcesInput,
  IpcResult,
  MemoryMode,
  MemoryNote,
  MemoryProposal,
  MemorySearchHit,
  MemorySearchResult,
  MemorySource,
  MemoryWorkspaceState,
  OpenSessionInput,
  OpenSessionResult,
  ProjectConversation,
  ProjectInfo,
  ProjectListResult,
  ProjectMemoryPreset,
  ProjectSelectResult,
  ConversationListResult,
  CreateConversationInput,
  CreateProjectInput,
  OpenConversationInput,
  OpenConversationResult,
  PublicSettings,
  SaveModelInput,
  SessionSummary,
  StartGroupChatResult,
  TeamRunSummary,
  SetToolAccessInput,
  SetUiPreferencesInput,
  SetProjectMemoryPresetInput,
  UpdateConversationInput,
  UpdateNoteInput,
  WikiPage
} from '../shared/protocol'
import { IpcChannels } from '../shared/protocol'
import type { HostRegistry } from './host-registry'
import type { AutomationService } from './automation-service'
import type { AutomationStore } from './automation-store'
import { AppError, toErrorCode, toErrorMessage } from './errors'
import type { MemoryHost } from './memory-host'
import type { ProjectStore } from './project-store'
import { GroupChatStore } from './group-chat-store'
import type { McpStore } from './mcp-store'
import type { SkillsStore } from './skills-store'
import type { PluginMarket } from './plugin-market'
import type { AgentDesktopBridge } from './agent-desktop'
import { groupProviderId } from './settings-store'
import type { SettingsStore } from './settings-store'

type Handler<Arg, Result> = (arg: Arg) => Result | Promise<Result>

function assertTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) {
    throw new AppError('VALIDATION', '窗口不可用')
  }
  if (event.sender !== window.webContents) {
    throw new AppError('VALIDATION', '拒绝来自未知渲染进程的请求')
  }
  if (event.senderFrame && event.senderFrame !== window.webContents.mainFrame) {
    throw new AppError('VALIDATION', '拒绝来自子框架的请求')
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('VALIDATION', `${label} 参数格式不正确`)
  }
  return value as Record<string, unknown>
}

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new AppError('VALIDATION', `${label} 必须是字符串`)
  const trimmed = value.trim()
  if (trimmed.length > maxLength) throw new AppError('VALIDATION', `${label} 过长`)
  return trimmed
}

function parseSaveModelInput(value: unknown): SaveModelInput {
  const record = requireObject(value, '模型设置')
  const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() : ''
  const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : ''
  if (!baseUrl) throw new AppError('VALIDATION', '请填写 Base URL')
  if (!modelId) throw new AppError('VALIDATION', '请填写模型 ID')

  const toNumber = (raw: unknown, label: string): number | undefined => {
    if (raw === undefined || raw === null || raw === '') return undefined
    const parsed = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(parsed)) throw new AppError('VALIDATION', `${label} 必须是数字`)
    return parsed
  }

  const input: SaveModelInput = { baseUrl, modelId }
  const displayName = optionalString(record.displayName, '显示名称', 120)
  if (displayName) input.displayName = displayName
  const contextWindow = toNumber(record.contextWindow, '上下文窗口')
  if (contextWindow !== undefined) input.contextWindow = contextWindow
  const maxTokens = toNumber(record.maxTokens, '最大输出 token')
  if (maxTokens !== undefined) input.maxTokens = maxTokens
  if (record.reasoning !== undefined) input.reasoning = record.reasoning === true
  if (record.apiKey !== undefined && record.apiKey !== null) {
    if (typeof record.apiKey !== 'string') throw new AppError('VALIDATION', 'API Key 必须是字符串')
    const apiKey = record.apiKey.trim()
    if (apiKey.length > 8_192) throw new AppError('VALIDATION', 'API Key 过长')
    if (apiKey) input.apiKey = apiKey
  }
  return input
}

function parseSetToolAccessInput(value: unknown): SetToolAccessInput {
  const record = requireObject(value, '工具权限')
  if (typeof record.powershell !== 'boolean') {
    throw new AppError('VALIDATION', 'PowerShell 开关必须是布尔值')
  }
  if (record.agentDesktop !== undefined && typeof record.agentDesktop !== 'boolean') {
    throw new AppError('VALIDATION', 'Agent Desktop 开关必须是布尔值')
  }
  if (record.computerUse !== undefined && typeof record.computerUse !== 'boolean') {
    throw new AppError('VALIDATION', 'Computer Use 开关必须是布尔值')
  }
  if (record.contextCompression !== undefined && typeof record.contextCompression !== 'boolean') {
    throw new AppError('VALIDATION', '上下文压缩开关必须是布尔值')
  }
  if (record.subagents !== undefined && typeof record.subagents !== 'boolean') {
    throw new AppError('VALIDATION', '并行子 Agent 开关必须是布尔值')
  }
  if (record.groupChat !== undefined && typeof record.groupChat !== 'boolean') {
    throw new AppError('VALIDATION', '群聊 Agent 开关必须是布尔值')
  }
  if (record.allowFileWrites !== undefined && typeof record.allowFileWrites !== 'boolean') {
    throw new AppError('VALIDATION', '文件修改开关必须是布尔值')
  }
  if (
    record.subagentConcurrency !== undefined &&
    (!Number.isInteger(record.subagentConcurrency) ||
      (record.subagentConcurrency as number) < 1 ||
      (record.subagentConcurrency as number) > 4)
  ) {
    throw new AppError('VALIDATION', '子 Agent 并发数必须是 1 到 4 之间的整数')
  }
  return {
    powershell: record.powershell,
    ...(typeof record.computerUse === 'boolean' ? { computerUse: record.computerUse } : {}),
    ...(typeof record.agentDesktop === 'boolean' ? { agentDesktop: record.agentDesktop } : {}),
    ...(typeof record.contextCompression === 'boolean' ? { contextCompression: record.contextCompression } : {}),
    ...(typeof record.subagents === 'boolean' ? { subagents: record.subagents } : {}),
    ...(typeof record.subagentConcurrency === 'number' ? { subagentConcurrency: record.subagentConcurrency } : {}),
    ...(typeof record.groupChat === 'boolean' ? { groupChat: record.groupChat } : {}),
    ...(typeof record.allowFileWrites === 'boolean' ? { allowFileWrites: record.allowFileWrites } : {})
  }
}

const UI_THEMES = ['system', 'dark', 'light']
const UI_DENSITIES = ['comfortable', 'compact']
const UI_SHORTCUTS = ['enter', 'ctrl+enter']
const THINKING_LEVELS = ['off', 'low', 'medium', 'high']
const UI_SCALES = [0.9, 1, 1.1, 1.25]

function parseUiPreferencesInput(value: unknown): SetUiPreferencesInput {
  const record = requireObject(value, '界面设置')
  if (record.theme !== undefined && !UI_THEMES.includes(record.theme as string)) {
    throw new AppError('VALIDATION', '界面主题必须是 system、dark 或 light')
  }
  if (record.scale !== undefined && !UI_SCALES.includes(record.scale as number)) {
    throw new AppError('VALIDATION', '界面缩放必须是 0.9、1、1.1 或 1.25')
  }
  if (record.density !== undefined && !UI_DENSITIES.includes(record.density as string)) {
    throw new AppError('VALIDATION', '消息密度必须是 comfortable 或 compact')
  }
  if (record.showTimestamps !== undefined && typeof record.showTimestamps !== 'boolean') {
    throw new AppError('VALIDATION', '时间戳开关必须是布尔值')
  }
  if (record.sendShortcut !== undefined && !UI_SHORTCUTS.includes(record.sendShortcut as string)) {
    throw new AppError('VALIDATION', '发送快捷键必须是 enter 或 ctrl+enter')
  }
  if (record.thinkingLevel !== undefined && !THINKING_LEVELS.includes(record.thinkingLevel as string)) {
    throw new AppError('VALIDATION', '思考等级必须是 off、low、medium 或 high')
  }
  return {
    ...(typeof record.theme === 'string' ? { theme: record.theme as SetUiPreferencesInput['theme'] } : {}),
    ...(typeof record.scale === 'number' ? { scale: record.scale } : {}),
    ...(typeof record.density === 'string' ? { density: record.density as SetUiPreferencesInput['density'] } : {}),
    ...(typeof record.showTimestamps === 'boolean' ? { showTimestamps: record.showTimestamps } : {}),
    ...(typeof record.sendShortcut === 'string' ? { sendShortcut: record.sendShortcut as SetUiPreferencesInput['sendShortcut'] } : {}),
    ...(typeof record.thinkingLevel === 'string' ? { thinkingLevel: record.thinkingLevel as SetUiPreferencesInput['thinkingLevel'] } : {})
  }
}

function parseOpenSessionInput(value: unknown): OpenSessionInput {
  if (value === undefined || value === null) return {}
  const record = requireObject(value, '会话')
  const sessionId = optionalString(record.sessionId, '会话 ID', 200)
  return sessionId ? { sessionId } : {}
}

function requiredString(value: unknown, label: string, maxLength = 20_000): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError('VALIDATION', `${label}不能为空`)
  }
  const trimmed = value.trim()
  if (trimmed.length > maxLength) throw new AppError('VALIDATION', `${label}过长`)
  return trimmed
}

function parseMemoryMode(value: unknown): MemoryMode {
  if (value === 'off' || value === 'rag' || value === 'wiki' || value === 'both') return value
  throw new AppError('VALIDATION', '未知记忆策略')
}

function parseLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) throw new AppError('VALIDATION', 'limit 必须是数字')
  return Math.min(Math.max(Math.floor(parsed), 1), 50)
}

const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml',
  '.log', '.html', '.htm', '.xml', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.css', '.sql',
  '.toml', '.ini', '.cfg', '.sh', '.ps1'
])

const MAX_IMPORT_FILES = 100
const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024
const IMPORT_SKIP_DIRS = new Set(['.git', 'node_modules', '.scratch', 'dist', 'out'])

/**
 * Collect importable files under a folder. The batch is capped so a folder
 * pick cannot stall the memory host or blow past the per-file size limit.
 */
async function collectImportableFiles(root: string, limit: number): Promise<string[]> {
  const found: string[] = []
  const queue = [root]
  while (queue.length > 0 && found.length < limit) {
    const dir = queue.shift() as string
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (found.length >= limit) break
      if (entry.name.startsWith('.')) continue
      const full = join(entry.parentPath ?? dir, entry.name)
      if (entry.isDirectory()) {
        if (!IMPORT_SKIP_DIRS.has(entry.name)) queue.push(full)
        continue
      }
      if (!entry.isFile()) continue
      const extension = extname(entry.name).toLowerCase()
      if (extension !== '.pdf' && !TEXT_EXTENSIONS.has(extension)) continue
      found.push(full)
    }
  }
  return found.sort()
}

async function findSessionFile(root: string, sessionId: string): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    if (!entry.name.includes(sessionId)) continue
    return join(entry.parentPath, entry.name)
  }
  return null
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const record = part as { type?: string; text?: string }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}

async function buildSessionEvidence(filePath: string, sessionId: string): Promise<string> {
  const buffer = await readFile(filePath)
  if (buffer.byteLength > 2 * 1024 * 1024) throw new AppError('VALIDATION', '会话文件超过 2 MB 上限')
  const lines = buffer.toString('utf8').split(/\r?\n/)
  const sections: string[] = [`# 会话取证 ${sessionId}`, `> 来源：${filePath}`, '']
  for (const line of lines) {
    if (!line.trim()) continue
    let entry: { type?: string; message?: { role?: string; content?: unknown }; timestamp?: number }
    try {
      entry = JSON.parse(line) as typeof entry
    } catch {
      continue
    }
    if (entry.type !== 'message' || !entry.message) continue
    const role = entry.message.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = messageText(entry.message.content).trim()
    if (!text) continue
    sections.push(`## ${role === 'user' ? '用户' : '助手'}`, text, '')
  }
  if (sections.length <= 3) throw new AppError('VALIDATION', '该会话没有可导入的文本消息')
  return sections.join('\n').slice(0, 1_900_000)
}

export function registerIpc(
  store: SettingsStore,
  projects: ProjectStore,
  host: HostRegistry,
  memoryHost: MemoryHost,
  automation: AutomationStore,
  automationService: AutomationService,
  getWindow: () => BrowserWindow | null,
  groupChatStore: GroupChatStore,
  market: PluginMarket,
  mcp: McpStore,
  skills: SkillsStore,
  agentDesktop: AgentDesktopBridge
): void {
  const handle = <Arg, Result>(channel: string, handler: Handler<Arg, Result>): void => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, arg: Arg): Promise<IpcResult<Result>> => {
      try {
        assertTrustedSender(event, getWindow())
        const value = await handler(arg)
        return { ok: true, value }
      } catch (error) {
        const code = toErrorCode(error)
        if (code === 'INTERNAL') {
          console.error(`[ipc] ${channel} failed:`, error)
        }
        return { ok: false, error: { code, message: toErrorMessage(error) } }
      }
    })
  }

  handle<void, PublicSettings>(IpcChannels.settingsGet, () => store.getPublicSettings())

  const pluginMutations = new Set<string>()
  const mutatePlugin = async <T>(id: string, action: () => T | Promise<T>): Promise<T> => {
    if (pluginMutations.has(id)) throw new AppError('BUSY', '该插件已有操作正在进行')
    pluginMutations.add(id)
    try {
      return await action()
    } finally {
      pluginMutations.delete(id)
    }
  }

  handle<void, TeamRunSummary[] | null>(IpcChannels.teamRunsList, async () => {
    const project = projects.list().find((item) => item.id === projects.activeProjectId())
    const token = process.env.OPENFUTURE_TEAM_BRIDGE_TOKEN
    const projectId = process.env.OPENFUTURE_TEAM_BRIDGE_PROJECT_ID
    if (!project?.available || !token || project.id !== projectId) return null
    const response = await fetch('http://127.0.0.1:19744/v1/runs?limit=20', {
      headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'identity' },
      redirect: 'error',
      signal: AbortSignal.timeout(3_000)
    })
    const size = Number(response.headers.get('content-length'))
    if (!response.ok || !Number.isSafeInteger(size) || size <= 0 || size > 128_000 ||
        response.headers.has('content-encoding')) {
      await response.body?.cancel()
      throw new AppError('VALIDATION', '多 Agent 桥接返回无效响应')
    }
    const envelope = requireObject(await response.json(), '多 Agent 响应')
    const data = requireObject(envelope.data, '多 Agent 数据')
    if (envelope.schemaVersion !== '1.0' || envelope.kind !== 'runs' ||
        envelope.projectId !== project.id || !Array.isArray(data.runs) ||
        projects.activeProjectId() !== project.id) {
      throw new AppError('VALIDATION', '多 Agent 桥接版本或项目不匹配')
    }
    return data.runs.slice(0, 20).flatMap((run: unknown) => {
      const row = requireObject(run, '多 Agent 运行')
      if (row.projectId !== project.id || typeof row.runId !== 'string' ||
          typeof row.mainGoal !== 'string' || typeof row.status !== 'string' ||
          typeof row.tasks !== 'number' || !Number.isSafeInteger(row.tasks) || row.tasks < 0) return []
      return [{
        runId: row.runId.slice(0, 128),
        mainGoal: row.mainGoal.slice(0, 500),
        status: row.status.slice(0, 40),
        tasks: row.tasks
      }]
    })
  })

  const memoryModeForPreset = (preset: ProjectMemoryPreset): MemoryMode => {
    if (preset === 'off') return 'off'
    if (preset === 'rag') return 'rag'
    if (preset === 'wiki') return 'wiki'
    return 'both'
  }

  const applyProjectPreset = async (project: ProjectInfo): Promise<void> => {
    if (!project.available) return
    try {
      await memoryHost.setMode(project.canonicalRoot, memoryModeForPreset(project.memoryPreset))
    } catch (error) {
      console.error('[ipc] failed to apply project memory preset:', error)
    }
  }

  const parseProjectId = (value: unknown, label = '项目 ID'): string => {
    if (typeof value !== 'string' || !value.trim()) throw new AppError('VALIDATION', `${label}不能为空`)
    return value.trim()
  }

  const parseCreateProject = (value: unknown): CreateProjectInput => {
    const record = requireObject(value, '新建项目')
    const rootPath = typeof record.rootPath === 'string' ? record.rootPath.trim() : ''
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (!rootPath) throw new AppError('VALIDATION', '请选择项目工作区目录')
    if (!name) throw new AppError('VALIDATION', '项目名称不能为空')
    if (name.length > 80) throw new AppError('VALIDATION', '项目名称不能超过 80 个字符')
    const preset =
      record.memoryPreset === 'rag' ||
      record.memoryPreset === 'wiki' ||
      record.memoryPreset === 'dreaming' ||
      record.memoryPreset === 'both' ||
      record.memoryPreset === 'off'
        ? record.memoryPreset
        : undefined
    const defaultModelRef =
      typeof record.defaultModelRef === 'string' && record.defaultModelRef.trim()
        ? record.defaultModelRef.trim()
        : null
    return { name, rootPath, memoryPreset: preset, defaultModelRef }
  }

  const parseOpenConversation = (value: unknown): OpenConversationInput => {
    const record = requireObject(value, '打开对话')
    return {
      projectId: parseProjectId(record.projectId),
      conversationId: parseProjectId(record.conversationId, '对话 ID')
    }
  }

  const stripSessionFile = (result: OpenSessionResult): OpenSessionResult => {
    const { sessionFile: _sessionFile, ...publicResult } = result
    return publicResult
  }

  handle<void, ProjectListResult>(IpcChannels.projectsList, async () => {
    const workspace = store.getWorkspace()
    let mode: MemoryMode = 'off'
    if (workspace) {
      try {
        mode = (await memoryHost.state(workspace)).mode
      } catch {
        // The project list must still open when the memory database is unavailable.
      }
    }
    const legacyNotice = projects.ensureLegacy(workspace, mode)
    const activeProject = projects.list().find((item) => item.id === projects.activeProjectId())
    if (activeProject) await applyProjectPreset(activeProject)
    return {
      projects: projects.list(),
      activeProjectId: projects.activeProjectId(),
      migrationNotice: legacyNotice ?? projects.takeNotice()
    }
  })

  handle<void, string | null>(IpcChannels.projectsChooseFolder, async () => {
    const window = getWindow()
    if (!window) throw new AppError('VALIDATION', '窗口不可用')
    const result = await dialog.showOpenDialog(window, {
      title: '选择项目工作区',
      buttonLabel: '选择此文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] as string
  })

  handle<unknown, ProjectSelectResult>(IpcChannels.projectsCreate, async (input) => {
    const parsed = parseCreateProject(input)
    await host.closeAll()
    const project = projects.create(parsed)
    await applyProjectPreset(project)
    return { project: projects.get(project.id), conversations: [] }
  })

  handle<unknown, ProjectSelectResult>(IpcChannels.projectsSelect, async (projectIdValue) => {
    const projectId = parseProjectId(projectIdValue)
    await host.closeAll()
    const project = projects.select(projectId)
    await applyProjectPreset(project)
    const conversations = projects.conversations(projectId)
    if (project.available) {
      try {
        const sessions = await host.list(project.canonicalRoot)
        projects.upsertSessions(projectId, sessions)
        return { project: projects.get(projectId), conversations: projects.conversations(projectId) }
      } catch (error) {
        console.error('[ipc] failed to list project sessions:', error)
      }
    }
    return { project, conversations }
  })

  handle<unknown, ProjectInfo>(IpcChannels.projectsRename, (input) => {
    const record = requireObject(input, '重命名项目')
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (!name) throw new AppError('VALIDATION', '项目名称不能为空')
    if (name.length > 80) throw new AppError('VALIDATION', '项目名称不能超过 80 个字符')
    return projects.rename(parseProjectId(record.projectId), name)
  })

  handle<unknown, ProjectInfo>(IpcChannels.projectsArchive, async (input) => {
    const record = requireObject(input, '归档项目')
    const projectId = parseProjectId(record.projectId)
    if (projects.activeProjectId() === projectId) await host.closeAll()
    return projects.archive(projectId, record.archived !== false)
  })

  handle<unknown, ProjectInfo>(IpcChannels.projectsSetMemoryPreset, async (input) => {
    const record = requireObject(input, '更新项目记忆策略')
    const parsed: SetProjectMemoryPresetInput = {
      projectId: parseProjectId(record.projectId),
      preset: record.preset as ProjectMemoryPreset
    }
    const project = projects.setMemoryPreset(parsed.projectId, parsed.preset)
    if (projects.activeProjectId() === project.id) await applyProjectPreset(project)
    return project
  })

  handle<unknown, ProjectInfo>(IpcChannels.projectsRelocate, async (projectIdValue) => {
    const projectId = parseProjectId(projectIdValue)
    const window = getWindow()
    if (!window) throw new AppError('VALIDATION', '窗口不可用')
    const result = await dialog.showOpenDialog(window, {
      title: '重新定位项目工作区',
      buttonLabel: '使用此文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return projects.get(projectId)
    await host.closeAll()
    return projects.relocate(projectId, result.filePaths[0] as string)
  })

  handle<unknown, void>(IpcChannels.projectsReveal, async (projectIdValue) => {
    const projectId = parseProjectId(projectIdValue)
    const project = projects.get(projectId)
    if (!project.available) throw new AppError('VALIDATION', '项目目录不可用，请先重新定位')
    const error = await shell.openPath(project.canonicalRoot)
    if (error) throw new AppError('VALIDATION', `无法打开文件夹：${error}`)
  })

  handle<unknown, ConversationListResult>(IpcChannels.conversationsList, async (projectIdValue) => {
    const projectId = parseProjectId(projectIdValue)
    const project = projects.get(projectId)
    if (project.available) {
      try {
        const sessions = await host.list(project.canonicalRoot)
        projects.upsertSessions(projectId, sessions)
      } catch (error) {
        console.error('[ipc] failed to list conversations:', error)
      }
    }
    return { projectId, conversations: projects.conversations(projectId) }
  })

  handle<unknown, ProjectConversation>(IpcChannels.conversationsCreate, (input) => {
    const record = requireObject(input, '新建对话')
    return projects.createConversation(parseProjectId(record.projectId), record.title)
  })

  handle<unknown, OpenConversationResult>(IpcChannels.conversationsOpen, async (input) => {
    const parsed = parseOpenConversation(input)
    const project = projects.get(parsed.projectId)
    if (!project.available) throw new AppError('VALIDATION', '项目目录不可用，请先重新定位')
    const conversation = projects.getConversation(parsed.projectId, parsed.conversationId)
    if (projects.activeProjectId() !== project.id) {
      await host.closeAll()
      projects.select(project.id)
    }
    await applyProjectPreset(project)
    projects.setLastConversation(project.id, conversation.id)
    const mode = memoryModeForPreset(project.memoryPreset)
    const agentRole =
      conversation.agentName && conversation.agentPrompt
        ? { name: conversation.agentName, prompt: conversation.agentPrompt }
        : undefined

    if (conversation.piSessionId) {
      try {
        const result = await host.open(
          project.canonicalRoot,
          conversation.piSessionId,
          mode,
          store.getComputerUse() || store.getAgentDesktop(),
          true,
          agentRole,
          market.enabledPluginFiles()
        )
        projects.bindConversation(project.id, conversation.id, result.sessionId)
        return { ...stripSessionFile(result), projectId: project.id, conversationId: conversation.id }
      } catch (error) {
        if (toErrorCode(error) !== 'SESSION_NOT_FOUND') throw error
        // The Pi JSONL was removed outside the app; keep the project entry and
        // start a fresh session rather than trapping the user on a dead link.
      }
    }

    try {
      const result = await host.open(
        project.canonicalRoot,
        undefined,
        mode,
        store.getComputerUse() || store.getAgentDesktop(),
        true,
        agentRole,
        market.enabledPluginFiles()
      )
      const bound = projects.bindConversation(project.id, conversation.id, result.sessionId)
      return {
        ...stripSessionFile(result),
        projectId: project.id,
        conversationId: bound.id
      }
    } catch (error) {
      const code = toErrorCode(error)
      if (code === 'NO_MODEL' || code === 'NO_WORKSPACE') {
        // Draft conversations are usable before a model is configured. The
        // renderer keeps the empty page and retries this call on first send.
        return {
          sessionId: '',
          messages: [],
          projectId: project.id,
          conversationId: conversation.id
        }
      }
      throw error
    }
  })

  handle<unknown, ProjectConversation>(IpcChannels.conversationsUpdate, (input) => {
    const record = requireObject(input, '更新对话')
    return projects.updateConversation({
      projectId: parseProjectId(record.projectId),
      conversationId: parseProjectId(record.conversationId, '对话 ID'),
      title: record.title,
      draft: record.draft,
      agentName: record.agentName,
      agentPrompt: record.agentPrompt
    })
  })

  handle<unknown, AgentSummary[]>(IpcChannels.agentsList, () => projects.listAgents())

  handle<unknown, void>(IpcChannels.conversationsDelete, async (input) => {
    const record = requireObject(input, '删除对话')
    const projectId = parseProjectId(record.projectId)
    const conversationId = parseProjectId(record.conversationId, '对话 ID')
    const conversation = projects.getConversation(projectId, conversationId)
    // Only close the deleted conversation; other conversations keep running.
    if (conversation.piSessionId) await host.close(conversation.piSessionId)
    projects.deleteConversation(projectId, conversationId)
  })

  const parseAutomationId = (value: unknown, label = '任务 ID'): string => {
    if (typeof value !== 'string' || !value.trim()) throw new AppError('VALIDATION', `${label}不能为空`)
    return value.trim()
  }

  const optionalNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined

  const optionalStringValue = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined

  handle<unknown, AutomationListResult>(IpcChannels.automationList, () => automationService.list())

  handle<unknown, AutomationTask>(IpcChannels.automationCreate, (input) => {
    const record = requireObject(input, '新建自动化任务')
    const projectId = parseProjectId(record.projectId, '项目 ID')
    const project = projects.get(projectId)
    const targetConversationId =
      typeof record.targetConversationId === 'string' ? record.targetConversationId.trim() : undefined
    if (targetConversationId) projects.getConversation(projectId, targetConversationId)
    const scheduleKind = record.scheduleKind
    if (
      scheduleKind !== 'once' &&
      scheduleKind !== 'interval' &&
      scheduleKind !== 'daily' &&
      scheduleKind !== 'weekly'
    ) {
      throw new AppError('VALIDATION', '请选择有效的重复方式')
    }
    return automation.create(
      {
        title: typeof record.title === 'string' ? record.title : '',
        prompt: typeof record.prompt === 'string' ? record.prompt : '',
        projectId,
        targetConversationId,
        scheduleKind,
        runAt: optionalStringValue(record.runAt),
        everyMinutes: optionalNumber(record.everyMinutes),
        timeOfDay: optionalStringValue(record.timeOfDay),
        weekday: optionalNumber(record.weekday)
      },
      project.name
    )
  })

  handle<unknown, AutomationTask>(IpcChannels.automationUpdate, (input) => {
    const record = requireObject(input, '更新自动化任务')
    const id = parseAutomationId(record.id)
    const existing = automation.get(id)
    if (!existing) throw new AppError('VALIDATION', '自动化任务不存在')
    const projectId = optionalStringValue(record.projectId)
    if (projectId) projects.get(projectId)
    const targetConversationId =
      typeof record.targetConversationId === 'string' ? record.targetConversationId.trim() : undefined
    if (targetConversationId) projects.getConversation(projectId ?? existing.projectId, targetConversationId)
    return automation.update({
      id,
      title: typeof record.title === 'string' ? record.title : undefined,
      prompt: typeof record.prompt === 'string' ? record.prompt : undefined,
      projectId,
      targetConversationId,
      scheduleKind:
        record.scheduleKind === 'once' ||
        record.scheduleKind === 'interval' ||
        record.scheduleKind === 'daily' ||
        record.scheduleKind === 'weekly'
          ? record.scheduleKind
          : undefined,
      runAt: optionalStringValue(record.runAt),
      everyMinutes: optionalNumber(record.everyMinutes),
      timeOfDay: optionalStringValue(record.timeOfDay),
      weekday: optionalNumber(record.weekday),
      status:
        record.status === 'active' || record.status === 'paused' ? record.status : undefined
    })
  })

  handle<unknown, void>(IpcChannels.automationDelete, (input) => {
    const id =
      typeof input === 'string'
        ? parseAutomationId(input)
        : parseAutomationId(requireObject(input, '删除自动化任务').id)
    automation.delete(id)
  })

  handle<unknown, AutomationTask>(IpcChannels.automationSetActive, (input) => {
    const record = requireObject(input, '切换自动化任务状态')
    if (typeof record.active !== 'boolean') throw new AppError('VALIDATION', '启用状态无效')
    return automation.setActive(parseAutomationId(record.id), record.active)
  })

  handle<unknown, AutomationTask>(IpcChannels.automationRunNow, async (input) => {
    const id =
      typeof input === 'string'
        ? parseAutomationId(input)
        : parseAutomationId(requireObject(input, '立即运行自动化任务').id)
    return automationService.runNow(id)
  })

  handle<unknown, AutomationRun[]>(IpcChannels.automationRuns, (input) => {
    const taskId =
      input && typeof input === 'object' && !Array.isArray(input)
        ? optionalStringValue((input as Record<string, unknown>).taskId)
        : undefined
    if (taskId) automation.get(taskId)
    return automation.runsFor(taskId)
  })


  handle<void, PublicSettings>(IpcChannels.workspaceChoose, async () => {
    const window = getWindow()
    if (!window) throw new AppError('VALIDATION', '窗口不可用')
    const result = await dialog.showOpenDialog(window, {
      title: '选择 OpenFuture 工作区',
      buttonLabel: '使用此文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return store.getPublicSettings()
    }
    await host.closeAll()
    return store.setWorkspace(result.filePaths[0] as string)
  })

  handle<void, PublicSettings>(IpcChannels.workspaceClear, async () => {
    await host.closeAll()
    return store.clearWorkspace()
  })

  handle<unknown, PublicSettings>(IpcChannels.modelSave, (input) => {
    const settings = store.saveModel(parseSaveModelInput(input))
    // The host caches models.json and in-memory credentials, so a settings
    // change always needs a fresh process.
    host.restart()
    return settings
  })

  handle<unknown, PublicSettings>(IpcChannels.toolAccessSet, (input) => {
    const parsed = parseSetToolAccessInput(input)
    store.setPowerShellAccess(parsed.powershell)
    let settings = store.getPublicSettings()
    if (typeof parsed.computerUse === 'boolean') settings = store.setComputerUse(parsed.computerUse)
    if (typeof parsed.contextCompression === 'boolean') settings = store.setContextCompression(parsed.contextCompression)
    if (typeof parsed.subagents === 'boolean') settings = store.setSubagents(parsed.subagents)
    if (typeof parsed.subagentConcurrency === 'number') {
      settings = store.setSubagentConcurrency(parsed.subagentConcurrency)
    }
    if (typeof parsed.groupChat === 'boolean') settings = store.setGroupChat(parsed.groupChat)
    if (typeof parsed.allowFileWrites === 'boolean') settings = store.setAllowFileWrites(parsed.allowFileWrites)
    // Tool access, compression and subagent wiring are decided when the agent
    // host starts, so the host is restarted with the new environment block.
    host.restart()
    return settings
  })

  handle<void, AgentDesktopState>(IpcChannels.agentDesktopState, async () => {
    const status = await agentDesktop.status().catch(() => null)
    return {
      installed: agentDesktop.installed(),
      version: agentDesktop.installedVersion(),
      path: agentDesktop.binaryPath(),
      supported: status !== null
    }
  })

  handle<unknown, AgentDesktopState>(IpcChannels.agentDesktopInstall, async (input) => {
    const progress = (message: string): void => {
      getWindow()?.webContents.send(IpcChannels.agentEvent, {
        sessionId: host.currentSessionId() ?? '',
        event: { type: 'plugin', event: { id: 'agent-desktop', name: 'Agent Desktop', phase: 'running', message } }
      })
    }
    try {
      await agentDesktop.install(progress)
    } catch (error) {
      throw error instanceof AppError ? error : new AppError('MARKET_INSTALL_FAILED', toErrorMessage(error))
    }
    // Desktop tools are resolved when a host opens a conversation.
    host.restart()
    return {
      installed: agentDesktop.installed(),
      version: agentDesktop.installedVersion(),
      path: agentDesktop.binaryPath(),
      supported: true
    }
  })

  handle<unknown, PublicSettings>(IpcChannels.uiPreferencesSet, (input) => {
    const parsed = parseUiPreferencesInput(input)
    const before = store.getUiPreferences()
    const settings = store.setUiPreferences(parsed)
    // Zoom is per renderer and applies immediately; the theme/density/timestamps
    // flags are applied by the renderer from the returned settings.
    getWindow()?.webContents.setZoomFactor(settings.ui.scale)
    // Thinking level is baked into each Pi session at creation time.
    if (before.thinkingLevel !== settings.ui.thinkingLevel) host.restart()
    return settings
  })

  handle<void, PublicSettings>(IpcChannels.apiKeyClear, () => {
    const settings = store.clearApiKey()
    host.restart()
    return settings
  })

  handle<void, SessionSummary[]>(IpcChannels.sessionsList, () => host.list(store.requireWorkspace()))

  handle<unknown, OpenSessionResult>(IpcChannels.sessionOpen, async (input) => {
    const workspace = store.requireWorkspace()
    let mode: MemoryMode = 'off'
    try {
      mode = (await memoryHost.state(workspace)).mode
    } catch (error) {
      console.error('[ipc] memory state unavailable, opening with memory off:', error)
    }
    const result = await host.open(
      workspace,
      parseOpenSessionInput(input).sessionId,
      mode,
      store.getComputerUse() || store.getAgentDesktop(),
      true,
      undefined,
      market.enabledPluginFiles()
    )
    // Keep filesystem paths inside the main process; the renderer only needs ids.
    const { sessionFile: _sessionFile, ...publicResult } = result
    return publicResult
  })

  handle<unknown, void>(IpcChannels.sessionSend, async (input) => {
    const record = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null
    const text = typeof input === 'string' ? input : typeof record?.text === 'string' ? record.text : ''
    const mode = record?.mode === 'steer' || record?.mode === 'followUp' ? record.mode : 'prompt'
    const textLength = text.trim().length
    if (textLength === 0) throw new AppError('VALIDATION', '消息不能为空')
    if (textLength > 100_000) throw new AppError('VALIDATION', '消息过长（上限 100000 字符）')
    // Validate the endpoint-bound credential before anything leaves the app;
    // the key travels only over this purpose-limited main -> host RPC.
    const sessionId =
      typeof record?.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : undefined
    const credential = store.getActiveCredential()
    await host.setCredential(credential.providerId, credential.apiKey)
    await host.send(text, mode, sessionId)
  })

  handle<unknown, void>(IpcChannels.sessionStop, (input) => {
    const record =
      input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null
    const sessionId =
      typeof record?.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : undefined
    return host.stop(sessionId)
  })

  handle<unknown, PublicSettings>(IpcChannels.groupModelSave, (input) => {
    const record =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : null
    const parsed: SaveGroupModelProfileInput = {
      label: typeof record?.label === 'string' ? record.label.trim() : '',
      baseUrl: typeof record?.baseUrl === 'string' ? record.baseUrl.trim() : '',
      modelId: typeof record?.modelId === 'string' ? record.modelId.trim() : '',
      ...(typeof record?.id === 'string' && record.id.trim() !== '' ? { id: record.id.trim() } : {}),
      ...(typeof record?.apiKey === 'string' && record.apiKey.trim() !== ''
        ? { apiKey: record.apiKey.trim() }
        : {}),
      ...(typeof record?.contextWindow === 'number' ? { contextWindow: record.contextWindow } : {}),
      ...(typeof record?.maxTokens === 'number' ? { maxTokens: record.maxTokens } : {})
    }
    if (parsed.label === '') throw new AppError('VALIDATION', '模型名称不能为空')
    if (parsed.modelId === '') throw new AppError('VALIDATION', '模型 ID 不能为空')
    const settings = store.saveGroupModelProfile(parsed)
    // models.json gains one provider per profile, and the host reads it on boot.
    host.restart()
    return settings
  })

  handle<unknown, PublicSettings>(IpcChannels.groupModelDelete, (input) => {
    const id = typeof input === 'string' ? input.trim() : ''
    if (id === '') throw new AppError('VALIDATION', '缺少模型档案 ID')
    const settings = store.deleteGroupModelProfile(id)
    host.restart()
    return settings
  })

  handle<unknown, PublicSettings>(IpcChannels.groupChatMembersSet, (input) => {
    const members: GroupChatMembers = {
      lead: null,
      critic: null,
      chair: null
    }
    const record =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : null
    for (const role of ['lead', 'critic', 'chair'] as const) {
      const value = record?.[role]
      members[role] = typeof value === 'string' && value.trim() !== '' ? value.trim() : null
    }
    // Member bindings travel with each groupChatStart call, so no host restart
    // is needed here: only the provider list in models.json is boot-time state.
    return store.setGroupChatMembers(members)
  })

  handle<void, GroupChatSummary[]>(IpcChannels.groupChatsList, () => groupChatStore.list())

  handle<unknown, GroupChatRecord>(IpcChannels.groupChatsGet, (input) => {
    const chatId = typeof input === 'string' ? input.trim() : ''
    if (chatId === '') throw new AppError('VALIDATION', '缺少群聊 ID')
    const record = groupChatStore.get(chatId)
    if (!record) throw new AppError('VALIDATION', '群聊不存在或已被删除')
    return record
  })

  handle<unknown, StartGroupChatResult>(IpcChannels.groupChatStart, async (input) => {
    const record =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : null
    const goal = typeof record?.goal === 'string' ? record.goal.trim() : ''
    if (goal === '') throw new AppError('VALIDATION', '群聊目标不能为空')
    if (goal.length > 4000) throw new AppError('VALIDATION', '群聊目标不能超过 4000 个字符')
    const constraints =
      typeof record?.constraints === 'string' ? record.constraints.trim().slice(0, 2000) : ''
    const focus = typeof record?.focus === 'string' ? record.focus.trim().slice(0, 1000) : ''
    const rawRounds = record?.rounds
    const rounds =
      typeof rawRounds === 'number' && Number.isFinite(rawRounds) ? Math.round(rawRounds) : undefined
    if (rounds !== undefined && (rounds < 1 || rounds > 3)) {
      throw new AppError('VALIDATION', '群聊轮数必须在 1 到 3 之间')
    }
    // A UI-started chat can be the first model call after the host boots or
    // restarts. The role sessions share the host runtime, so the key must be
    // pushed before their first prompt exactly like sessionSend does.
    const credential = store.getActiveCredential()
    await host.setCredential(credential.providerId, credential.apiKey)
    // Role sessions may run on their own provider, so every profile key has to
    // be present in the host runtime before the first prompt goes out.
    for (const profile of store.getGroupModelProfiles()) {
      const profileCredential = store.getGroupProfileCredential(profile.id)
      if (profileCredential) {
        await host.setCredential(profileCredential.providerId, profileCredential.apiKey)
      }
    }
    const roleModels: Record<string, { providerId: string; modelId: string }> = {}
    const members = store.getGroupChatMembers()
    for (const role of ['lead', 'critic', 'chair'] as const) {
      const profileId = members[role]
      if (!profileId) continue
      const profile = store.getGroupModelProfiles().find((item) => item.id === profileId)
      if (profile) roleModels[role] = { providerId: groupProviderId(profile.id), modelId: profile.modelId }
    }
    const sessionId =
      typeof record?.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : undefined
    return host.startGroupChat({
      goal,
      ...(sessionId ? { sessionId } : {}),
      ...(Object.keys(roleModels).length > 0 ? { roleModels } : {}),
      ...(constraints ? { constraints } : {}),
      ...(focus ? { focus } : {}),
      ...(rounds !== undefined ? { rounds } : {})
    })
  })

  handle<unknown, PluginMarketState>(IpcChannels.pluginMarket, (input) =>
    market.state(input === true)
  )

  handle<unknown, PluginMarketState>(IpcChannels.pluginInstall, async (input) => {
    const id = typeof input === 'string' ? input.trim() : ''
    if (id === '') throw new AppError('VALIDATION', '缺少插件 ID')
    await mutatePlugin(id, () => market.install(id))
    return market.state()
  })

  handle<unknown, PluginMarketState>(IpcChannels.pluginRemove, async (input) => {
    const id = typeof input === 'string' ? input.trim() : ''
    if (id === '') throw new AppError('VALIDATION', '缺少插件 ID')
    await mutatePlugin(id, () => market.removeInstalled(id))
    return market.state()
  })

  handle<unknown, PluginAdaptResult>(IpcChannels.pluginAdapt, async (input) => {
    const record =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : null
    const id = typeof input === 'string' ? input.trim() : typeof record?.id === 'string' ? record.id.trim() : ''
    if (id === '') throw new AppError('VALIDATION', '缺少插件 ID')
    const name = market.installedName(id)
    const sessionId = host.currentSessionId() ?? ''
    const progress = (phase: 'queued' | 'running' | 'done' | 'failed', message: string): void => {
      // The panel listens on the normal event stream, so tag the update with
      // the caller's session id; an empty id simply reaches no open view.
      getWindow()?.webContents.send(IpcChannels.agentEvent, {
        sessionId,
        event: { type: 'plugin', event: { id, name, phase, message } }
      })
    }
    return mutatePlugin(id, async () => {
      try {
        const sources = market.readSources(id)
        if (sources.length === 0) throw new AppError('VALIDATION', '插件目录里没有可读取的源码')
        const entry = market.getCachedEntry(id)
        progress('queued', `已读取 ${sources.length} 个源码文件，准备适配`)
        const credential = store.getActiveCredential()
        await host.setCredential(credential.providerId, credential.apiKey)
        progress('running', '模型正在改写为 OpenFuture 扩展…')
        const result = await host.adaptPlugin({
          cwd: store.requireWorkspace(),
          name,
          description: entry?.description ?? '',
          sources
        })
        const previouslyEnabled = market.readAdapted(id)?.enabled
        const adapted = market.writeAdapted(id, { name, ...result })
        if (previouslyEnabled) host.reloadPlugins()
        progress('done', '适配完成，请查看代码后启用')
        return { adapted }
      } catch (error) {
        const message = toErrorMessage(error)
        progress('failed', message)
        return { adapted: null, error: message }
      }
    })
  })

  handle<unknown, string>(IpcChannels.pluginReadAdapted, (input) => {
    const id = typeof input === 'string' ? input.trim() : ''
    if (id === '') throw new AppError('VALIDATION', '缺少插件 ID')
    return market.readAdaptedCode(id)
  })

  handle<unknown, PluginMarketState>(IpcChannels.pluginDepsInstall, async (input) => {
    const record =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : null
    const id = typeof record?.id === 'string' ? record.id.trim() : ''
    if (id === '') throw new AppError('VALIDATION', '缺少插件 ID')
    const name = market.readAdapted(id)?.name ?? id
    const sessionId = host.currentSessionId() ?? ''
    const progress = (phase: 'queued' | 'running' | 'done' | 'failed', message: string): void => {
      getWindow()?.webContents.send(IpcChannels.agentEvent, {
        sessionId,
        event: { type: 'plugin', event: { id, name, phase, message } }
      })
    }
    progress('queued', '准备安装插件依赖')
    try {
      const plugin = await mutatePlugin(id, () => market.installDependencies(id, (message) => progress('running', message)))
      progress('done', '依赖安装完成')
      if (plugin.enabled) host.reloadPlugins()
      return await market.state()
    } catch (error) {
      const message = toErrorMessage(error)
      progress('failed', message)
      throw error instanceof AppError ? error : new AppError('MARKET_INSTALL_FAILED', message)
    }
  })

  handle<unknown, PluginMarketState>(IpcChannels.pluginSetEnabled, async (input) => {
    const record =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : null
    const id = typeof record?.id === 'string' ? record.id.trim() : ''
    if (id === '') throw new AppError('VALIDATION', '缺少插件 ID')
    if (typeof record?.enabled !== 'boolean') throw new AppError('VALIDATION', '缺少插件启用状态')
    const enabled = record.enabled
    await mutatePlugin(id, () => market.setAdaptedEnabled(id, enabled))
    host.reloadPlugins()
    return market.state()
  })

  handle<unknown, PluginMarketState>(IpcChannels.pluginRemoveAdapted, async (input) => {
    const id = typeof input === 'string' ? input.trim() : ''
    if (id === '') throw new AppError('VALIDATION', '缺少插件 ID')
    const enabled = await mutatePlugin(id, () => {
      const wasEnabled = market.readAdapted(id)?.enabled
      market.removeAdapted(id)
      return wasEnabled
    })
    if (enabled) host.reloadPlugins()
    return market.state()
  })

  handle<void, McpConfigState>(IpcChannels.mcpState, () => mcp.state())

  handle<unknown, McpConfigState>(IpcChannels.mcpSaveServer, (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new AppError('VALIDATION', '缺少 MCP 服务配置')
    }
    const state = mcp.save(input as McpServerInput)
    // New servers connect when the agent boots, so the next session must see them.
    host.reloadPlugins()
    return state
  })

  handle<unknown, McpConfigState>(IpcChannels.mcpDeleteServer, (input) => {
    const name = typeof input === 'string' ? input.trim() : ''
    if (name === '') throw new AppError('VALIDATION', '缺少 MCP 服务名')
    const state = mcp.remove(name)
    host.reloadPlugins()
    return state
  })

  handle<unknown, McpConfigState>(IpcChannels.mcpSetEnabled, (input) => {
    const record = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (name === '') throw new AppError('VALIDATION', '缺少 MCP 服务名')
    if (typeof record.enabled !== 'boolean') throw new AppError('VALIDATION', '缺少启用状态')
    const state = mcp.setEnabled(name, record.enabled)
    host.reloadPlugins()
    return state
  })

  handle<void, SkillInfo[]>(IpcChannels.skillsList, () => skills.list())

  handle<void, SkillLibraryEntry[]>(IpcChannels.skillsLibrary, () => skills.library())

  handle<unknown, SkillInfo[]>(IpcChannels.skillsInstall, (input) => {
    const name = typeof input === 'string' ? input.trim() : ''
    if (name === '') throw new AppError('VALIDATION', '缺少技能名')
    const list = skills.installLibrarySkill(name)
    host.reloadPlugins()
    return list
  })

  handle<unknown, SkillInfo[]>(IpcChannels.skillsSetEnabled, (input) => {
    const record = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (name === '') throw new AppError('VALIDATION', '缺少技能名')
    if (typeof record.enabled !== 'boolean') throw new AppError('VALIDATION', '缺少启用状态')
    const list = skills.setEnabled(name, record.enabled)
    host.reloadPlugins()
    return list
  })

  handle<unknown, SkillInfo[]>(IpcChannels.skillsSave, (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new AppError('VALIDATION', '缺少技能内容')
    }
    const list = skills.save(input as SaveSkillInput)
    host.reloadPlugins()
    return list
  })

  handle<unknown, SkillInfo[]>(IpcChannels.skillsDelete, (input) => {
    const name = typeof input === 'string' ? input.trim() : ''
    if (name === '') throw new AppError('VALIDATION', '缺少技能名')
    const list = skills.remove(name)
    host.reloadPlugins()
    return list
  })

  handle<unknown, null>(IpcChannels.promptAnswer, async (input) => {
    const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (id === '') throw new AppError('VALIDATION', '缺少提问 id')
    const sessionId =
      typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : undefined
    await host.answerPrompt({
      id,
      ...(sessionId ? { sessionId } : {}),
      optionIndex: typeof record.optionIndex === 'number' ? record.optionIndex : undefined,
      text: typeof record.text === 'string' ? record.text : undefined,
      cancelled: record.cancelled === true
    })
    return null
  })

  handle<unknown, ResolveLinkResult>(IpcChannels.linkResolve, (input) => {
    const raw = typeof input === 'string' ? input.trim() : ''
    if (raw === '') throw new AppError('VALIDATION', '缺少要打开的路径或链接')
    // Models quote paths; trim punctuation that usually belongs to the prose.
    const target = raw.replace(/^["'`]+|["'`]+$/g, '').replace(/[),.;]+$/, '')
    if (/^https?:\/\//i.test(target)) return { kind: 'url', url: target }
    const filePart = target.replace(/:\d+(?::\d+)?$/, '')
    const workspace = store.requireWorkspace()
    const resolved = isAbsolute(filePart) ? filePart : resolve(workspace, filePart)
    if (!existsSync(resolved)) return { kind: 'missing', error: `文件不存在：${resolved}` }
    if (!statSync(resolved).isFile()) return { kind: 'missing', error: `目标不是文件：${resolved}` }
    return {
      kind: 'file',
      path: resolved,
      url: pathToFileURL(resolved).href,
      isHtml: /\.(x?html?|svg)$/i.test(resolved)
    }
  })

  handle<unknown, null>(IpcChannels.linkOpenExternal, async (input) => {
    const raw = typeof input === 'string' ? input.trim() : ''
    if (raw === '') throw new AppError('VALIDATION', '缺少要打开的路径或链接')
    if (/^https?:\/\//i.test(raw)) {
      await shell.openExternal(raw)
      return null
    }
    // Address bars hand us file:// URLs; openPath needs a plain path.
    const withoutUrl = raw.startsWith('file://') ? fileURLToPath(raw) : raw
    const filePart = withoutUrl.replace(/:\d+(?::\d+)?$/, '')
    const workspace = store.requireWorkspace()
    const resolved = isAbsolute(filePart) ? filePart : resolve(workspace, filePart)
    if (!existsSync(resolved)) throw new AppError('VALIDATION', `文件不存在：${resolved}`)
    const failure = await shell.openPath(resolved)
    if (failure !== '') throw new AppError('PI_ERROR', failure)
    return null
  })

  handle<unknown, void>(IpcChannels.sessionClose, (input) =>
    host.close(typeof input === 'string' && input !== '' ? input : undefined)
  )

  handle<void, Awaited<ReturnType<MemoryHost['diagnostics']>>>(IpcChannels.memoryDiagnostics, () =>
    memoryHost.diagnostics()
  )

  handle<void, MemoryWorkspaceState>(IpcChannels.memoryState, () =>
    memoryHost.state(store.requireWorkspace())
  )

  handle<unknown, MemoryWorkspaceState>(IpcChannels.memorySetMode, async (mode) => {
    const state = await memoryHost.setMode(store.requireWorkspace(), parseMemoryMode(mode))
    // The tool table is built when the agent session opens, so the next open
    // must see the new mode and a fresh process.
    host.restart()
    return state
  })

  handle<unknown, MemorySource | null>(IpcChannels.memoryImportSource, async (input) => {
    const workspace = store.requireWorkspace()
    const record = input && typeof input === 'object' ? (input as ImportSourceInput) : {}
    const window = getWindow()
    if (!window) throw new AppError('VALIDATION', '窗口不可用')
    const result = await dialog.showOpenDialog(window, {
      title: '导入记忆资料',
      buttonLabel: '导入',
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0] as string
    const extension = extname(filePath).toLowerCase()
    if (extension !== '.pdf' && !TEXT_EXTENSIONS.has(extension)) {
      throw new AppError('VALIDATION', `不支持的文件类型：${extension || '无扩展名'}（请选择 PDF 或文本类资料）`)
    }
    let buffer: Buffer
    try {
      buffer = await readFile(filePath)
      if (buffer.byteLength > 2 * 1024 * 1024) {
        throw new AppError('VALIDATION', '资料超过 2 MB 上限')
      }
      if (extension !== '.pdf' && buffer.includes(0)) throw new AppError('VALIDATION', '该文件看起来是二进制文件')
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError('VALIDATION', `读取资料失败：${toErrorMessage(error)}`)
    }
    const title = optionalString(record.title, '资料标题', 240) ?? basename(filePath)
    return memoryHost.importSource({
      workspace,
      title,
      origin: `file:${filePath}`,
      kind: extension.slice(1) || 'text',
      ...(extension === '.pdf' ? { pdfBase64: buffer.toString('base64') } : { content: buffer.toString('utf8') })
    })
  })

  handle<unknown, MemorySource[]>(IpcChannels.memoryImportFiles, async (input) => {
    const workspace = store.requireWorkspace()
    const record = input && typeof input === 'object' ? (input as ImportSourcesInput) : {}
    let paths = Array.isArray(record.paths)
      ? record.paths
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .slice(0, MAX_IMPORT_FILES)
      : []
    if (paths.length === 0) {
      const window = getWindow()
      if (!window) throw new AppError('VALIDATION', '窗口不可用')
      const picked = await dialog.showOpenDialog(window, {
        title: '导入记忆资料文件夹',
        buttonLabel: '导入',
        properties: ['openDirectory']
      })
      if (picked.canceled || picked.filePaths.length === 0) return []
      paths = await collectImportableFiles(picked.filePaths[0] as string, MAX_IMPORT_FILES)
    }

    const imported: MemorySource[] = []
    for (const filePath of paths) {
      const resolved = resolve(filePath)
      const extension = extname(resolved).toLowerCase()
      if (extension !== '.pdf' && !TEXT_EXTENSIONS.has(extension)) continue
      if (!existsSync(resolved)) continue
      let stats
      try {
        stats = statSync(resolved)
      } catch {
        continue
      }
      if (!stats.isFile() || stats.size > MAX_IMPORT_FILE_BYTES) continue
      const buffer = await readFile(resolved)
      if (extension !== '.pdf' && buffer.includes(0)) continue
      const source = await memoryHost.importSource({
        workspace,
        title: basename(resolved),
        origin: `file:${resolved}`,
        kind: extension.slice(1) || 'text',
        ...(extension === '.pdf'
          ? { pdfBase64: buffer.toString('base64') }
          : { content: buffer.toString('utf8') })
      })
      imported.push(source)
    }
    return imported
  })

  handle<ImportSessionEvidenceInput | undefined, MemorySource | null>(
    IpcChannels.memoryImportSessionEvidence,
    async (input) => {
      const workspace = store.requireWorkspace()
      const record = input && typeof input === 'object' ? input : {}
      const sessionId = optionalString(record.sessionId, '会话 ID', 200) ?? host.currentSessionId()
      if (!sessionId) throw new AppError('VALIDATION', '当前没有打开的会话，无法导入会话取证')
      const filePath = await findSessionFile(store.sessionDir, sessionId)
      if (!filePath) throw new AppError('VALIDATION', '找不到该会话的原始记录')
      const content = await buildSessionEvidence(filePath, sessionId)
      const title = optionalString(record.title, '取证标题', 240) ?? `会话取证 ${sessionId.slice(0, 8)}`
      return memoryHost.importSource({
        workspace,
        title,
        origin: `session:${sessionId}`,
        kind: 'session',
        content
      })
    }
  )

  handle<void, MemorySource[]>(IpcChannels.memoryListSources, () =>
    memoryHost.listSources(store.requireWorkspace())
  )

  handle<unknown, void>(IpcChannels.memoryRevokeSource, async (id) => {
    await memoryHost.revokeSource(store.requireWorkspace(), requiredString(id, '资料来源 ID'))
  })

  handle<unknown, MemorySearchResult>(IpcChannels.memorySearch, (input) => {
    const record = requireObject(input, '检索条件')
    const query = requiredString(record.query, '检索词', 500)
    return memoryHost.search(store.requireWorkspace(), query, parseLimit(record.limit) ?? 8)
  })

  handle<unknown, MemorySearchHit | null>(IpcChannels.memoryGet, async (id) => {
    const hit = await memoryHost.get(store.requireWorkspace(), requiredString(id, '记忆条目 ID'))
    return (hit as MemorySearchHit | null) ?? null
  })

  handle<void, MemoryNote[]>(IpcChannels.memoryListNotes, () =>
    memoryHost.listNotes(store.requireWorkspace())
  )

  handle<unknown, MemoryNote>(IpcChannels.memoryCreateNote, (input) => {
    const record = requireObject(input, '笔记')
    const note: CreateNoteInput = {
      type: requiredString(record.type, '笔记类型', 40) as CreateNoteInput['type'],
      title: requiredString(record.title, '笔记标题', 240),
      body: requiredString(record.body, '笔记正文', 40_000)
    }
    return memoryHost.createNote(store.requireWorkspace(), note)
  })

  handle<unknown, MemoryProposal>(IpcChannels.memoryCorrectNote, (input) => {
    const record = requireObject(input, '纠正候选')
    const rawEvidence = record.evidenceIds
    if (!Array.isArray(rawEvidence) || rawEvidence.length === 0) {
      throw new AppError('VALIDATION', '纠正笔记必须引用至少一条证据')
    }
    const evidenceIds = rawEvidence
      .map((item, index) => requiredString(item, `证据 ${index + 1}`, 200))
      .slice(0, 20)
    const correction: CorrectNoteInput = {
      noteId: requiredString(record.noteId, '笔记 ID'),
      body: requiredString(record.body, '纠正正文', 40_000),
      evidenceIds,
      reason: optionalString(record.reason, '纠正原因', 500)
    }
    return memoryHost.correctNote(store.requireWorkspace(), correction)
  })

  handle<unknown, MemoryNote>(IpcChannels.memoryUpdateNote, (input) => {
    const record = requireObject(input, '笔记')
    const note: UpdateNoteInput = { id: requiredString(record.id, '笔记 ID') }
    const type = optionalString(record.type, '笔记类型', 40)
    const title = optionalString(record.title, '笔记标题', 240)
    const body = optionalString(record.body, '笔记正文', 40_000)
    if (type) note.type = type as UpdateNoteInput['type']
    if (title) note.title = title
    if (body) note.body = body
    return memoryHost.updateNote(store.requireWorkspace(), note)
  })

  handle<unknown, void>(IpcChannels.memoryRevokeNote, async (id) => {
    await memoryHost.revokeNote(store.requireWorkspace(), requiredString(id, '笔记 ID'))
  })

  handle<unknown, WikiPage[]>(IpcChannels.memoryGenerateWiki, (input) => {
    const record = input && typeof input === 'object' ? (input as GenerateWikiInput) : {}
    const sourceIds = Array.isArray(record.sourceIds)
      ? record.sourceIds.filter((item): item is string => typeof item === 'string')
      : undefined
    return memoryHost.generateWiki(store.requireWorkspace(), sourceIds ? { sourceIds } : {})
  })

  handle<void, WikiPage[]>(IpcChannels.memoryListWiki, () =>
    memoryHost.listWiki(store.requireWorkspace())
  )

  handle<unknown, WikiPage>(IpcChannels.memoryPublishWiki, async (input) => {
    const review = requireObject(input, 'Wiki 发布')
    if (typeof review.revision !== 'number' || !Number.isSafeInteger(review.revision) || review.revision < 1) {
      throw new AppError('VALIDATION', '请重新打开 Wiki 草稿审核')
    }
    return memoryHost.publishWiki(store.requireWorkspace(), requiredString(review.id, 'Wiki ID'), review.revision)
  })

  handle<unknown, void>(IpcChannels.memoryRevokeWiki, async (id) => {
    await memoryHost.revokeWiki(store.requireWorkspace(), requiredString(id, 'Wiki ID'))
  })

  handle<void, MemoryProposal[]>(IpcChannels.memoryListProposals, () =>
    memoryHost.listProposals(store.requireWorkspace())
  )

  handle<unknown, MemoryProposal>(IpcChannels.memoryDecideProposal, (input) => {
    const record = requireObject(input, '候选审批')
    if (typeof record.approve !== 'boolean') {
      throw new AppError('VALIDATION', 'approve 必须是布尔值')
    }
    const decision: DecideProposalInput = {
      id: requiredString(record.id, '候选 ID'),
      approve: record.approve
    }
    return memoryHost.decideProposal(store.requireWorkspace(), decision)
  })

  handle<void, DreamJob>(IpcChannels.dreamStart, () => memoryHost.dreamStart(store.requireWorkspace()))

  handle<unknown, DreamJob | null>(IpcChannels.dreamInspect, (input) =>
    memoryHost.dreamInspect(store.requireWorkspace(), requiredString(input, '任务 ID'))
  )

  handle<unknown, DreamVersion>(IpcChannels.dreamApply, (input) => {
    const record = requireObject(input, 'Dreaming 发布')
    const decision: DreamApplyInput = {
      jobId: requiredString(record.jobId, '任务 ID'),
      publishId: requiredString(record.publishId, '发布 ID')
    }
    return memoryHost.dreamApply(store.requireWorkspace(), decision)
  })

  handle<unknown, DreamJob>(IpcChannels.dreamReject, (input) =>
    memoryHost.dreamReject(store.requireWorkspace(), requiredString(input, '任务 ID'))
  )

  handle<void, DreamState>(IpcChannels.dreamState, () => memoryHost.dreamState(store.requireWorkspace()))

  handle<unknown, DreamVersion | null>(IpcChannels.dreamRollback, (input) => {
    const record = input && typeof input === 'object' ? (input as DreamRollbackInput) : {}
    const versionId = record.versionId ? requiredString(record.versionId, '版本 ID') : undefined
    return memoryHost.dreamRollback(store.requireWorkspace(), versionId ? { versionId } : {})
  })

  handle<unknown, DreamVersion>(IpcChannels.dreamRevoke, (input) => {
    const record = requireObject(input, '知识撤销')
    const decision: DreamRevokeInput = { versionId: requiredString(record.versionId, '版本 ID') }
    return memoryHost.dreamRevoke(store.requireWorkspace(), decision)
  })

  handle<void, DreamQuality>(IpcChannels.dreamQuality, () => memoryHost.dreamQuality(store.requireWorkspace()))

  handle<void, DreamScheduleState>(IpcChannels.dreamSchedule, () =>
    memoryHost.dreamSchedule(store.requireWorkspace())
  )

  handle<unknown, DreamScheduleState>(IpcChannels.dreamSetSchedule, (input) => {
    const record = requireObject(input, 'Dreaming 调度')
    if (typeof record.autoDream !== 'boolean') throw new AppError('VALIDATION', 'autoDream 必须是布尔值')
    const interval = Number(record.intervalMinutes)
    if (!Number.isInteger(interval) || interval < 5 || interval > 1440) {
      throw new AppError('VALIDATION', '调度间隔需为 5–1440 分钟的整数')
    }
    const decision: DreamScheduleInput = { autoDream: record.autoDream, intervalMinutes: interval }
    return memoryHost.dreamSetSchedule(store.requireWorkspace(), decision)
  })
}
