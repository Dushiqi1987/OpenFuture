import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type {
  ProjectConversation,
  ProjectInfo,
  ProjectMemoryPreset,
  SessionSummary
} from '../shared/protocol'
import { AppError, toErrorMessage } from './errors'
import type { SettingsStore } from './settings-store'

interface ProjectRecord {
  id: string
  name: string
  canonicalRoot: string
  memoryPreset: ProjectMemoryPreset
  defaultModelRef: string | null
  createdAt: number
  archivedAt: number | null
  lastConversationId: string | null
}

interface ConversationRecord {
  id: string
  projectId: string
  piSessionId?: string
  title: string
  modelOverrideRef?: string
  createdAt: number
  updatedAt: number
  draft?: string
}

interface ProjectFile {
  version: 1
  activeProjectId: string | null
  projects: ProjectRecord[]
  conversations: ConversationRecord[]
}

const EMPTY: ProjectFile = {
  version: 1,
  activeProjectId: null,
  projects: [],
  conversations: []
}

function trimText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new AppError('VALIDATION', `${label}必须是字符串`)
  const text = value.trim()
  if (!text) throw new AppError('VALIDATION', `${label}不能为空`)
  if (text.length > max) throw new AppError('VALIDATION', `${label}过长`)
  return text
}

function normalizePreset(value: unknown): ProjectMemoryPreset {
  return value === 'rag' || value === 'wiki' || value === 'dreaming' || value === 'both' || value === 'off'
    ? value
    : 'off'
}

/** Windows paths are case-insensitive; keep a stable key for duplicate checks. */
function rootKey(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function canonicalDirectory(raw: string): { canonicalRoot: string; key: string } {
  let absolute: string
  try {
    absolute = realpathSync.native(resolve(raw))
  } catch {
    throw new AppError('VALIDATION', '目录不存在或无法访问')
  }
  let stats
  try {
    stats = statSync(absolute)
  } catch {
    throw new AppError('VALIDATION', '目录不存在或无法访问')
  }
  if (!stats.isDirectory()) throw new AppError('VALIDATION', '请选择文件夹，而不是文件')
  return { canonicalRoot: absolute.replace(/[\\/]+$/, ''), key: rootKey(absolute) }
}

function directoryAvailable(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function conversationTitle(session: SessionSummary): string {
  if (session.name && session.name.trim()) return session.name.trim().slice(0, 120)
  const first = session.firstMessage.trim()
  if (first) return first.length > 60 ? `${first.slice(0, 60)}…` : first
  return `对话 ${session.id.slice(0, 8)}`
}

/**
 * Small, versioned project registry. Pi JSONL remains the conversation body;
 * this file only stores ownership, titles, drafts and the active selection.
 */
export class ProjectStore {
  private readonly filePath: string
  private readonly backupPath: string
  private readonly settings: SettingsStore
  private data: ProjectFile = { ...EMPTY }
  private notice: string | undefined

  constructor(userDataDir: string, settings: SettingsStore) {
    this.filePath = join(userDataDir, 'config', 'projects.json')
    this.backupPath = `${this.filePath}.bak`
    this.settings = settings
    this.load()
    this.restoreActive()
  }

  private load(): void {
    mkdirSync(join(this.filePath, '..'), { recursive: true })
    if (!existsSync(this.filePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<ProjectFile>
      if (raw.version !== 1 || !Array.isArray(raw.projects) || !Array.isArray(raw.conversations)) {
        throw new Error('unsupported projects file')
      }
      this.data = {
        version: 1,
        activeProjectId: typeof raw.activeProjectId === 'string' ? raw.activeProjectId : null,
        projects: raw.projects.filter((item): item is ProjectRecord => Boolean(item && typeof item.id === 'string')),
        conversations: raw.conversations.filter(
          (item): item is ConversationRecord => Boolean(item && typeof item.id === 'string')
        )
      }
    } catch (error) {
      const quarantine = `${this.filePath}.corrupt-${Date.now()}`
      try {
        renameSync(this.filePath, quarantine)
      } catch {
        // Keep starting with an empty registry; the corrupt file is reported below.
      }
      this.notice = `项目注册表无法读取，已隔离到 ${basename(quarantine)}：${toErrorMessage(error)}`
    }
  }

  private persist(): void {
    mkdirSync(join(this.filePath, '..'), { recursive: true })
    const payload = `${JSON.stringify(this.data, null, 2)}\n`
    const temp = `${this.filePath}.${process.pid}.tmp`
    writeFileSync(temp, payload, 'utf8')
    if (existsSync(this.filePath)) {
      try {
        writeFileSync(this.backupPath, readFileSync(this.filePath))
      } catch {
        // The backup is best-effort; the atomic rename below is authoritative.
      }
    }
    renameSync(temp, this.filePath)
  }

  private restoreActive(): void {
    if (this.data.projects.length === 0) return
    const active = this.data.projects.find((project) => project.id === this.data.activeProjectId)
    const fallback = this.data.projects.find((project) => project.archivedAt === null) ?? this.data.projects[0]
    const project = active ?? fallback
    if (!project) return
    this.data.activeProjectId = project.id
    if (directoryAvailable(project.canonicalRoot)) {
      try {
        this.settings.setWorkspace(project.canonicalRoot)
      } catch {
        // The settings layer also validates; availability is re-checked on select.
      }
    } else {
      this.settings.clearWorkspace()
    }
    this.persist()
  }

  takeNotice(): string | undefined {
    const notice = this.notice
    this.notice = undefined
    return notice
  }

  /**
   * Build a project for the pre-v0.2 single workspace. This deliberately does
   * not touch existing Pi sessions or memory records; they are discovered by
   * root when the project is opened.
   */
  ensureLegacy(workspace: string | null, presetValue: unknown): string | undefined {
    if (this.data.projects.length > 0 || !workspace || !existsSync(workspace)) return undefined
    let info: { canonicalRoot: string }
    try {
      info = canonicalDirectory(workspace)
    } catch {
      return undefined
    }
    const now = Date.now()
    const project: ProjectRecord = {
      id: `proj-${randomUUID()}`,
      name: basename(info.canonicalRoot) || '原有项目',
      canonicalRoot: info.canonicalRoot,
      memoryPreset: normalizePreset(presetValue),
      defaultModelRef: this.settings.getModel()?.modelId
        ? `openfuture/${this.settings.getModel()?.modelId}`
        : null,
      createdAt: now,
      archivedAt: null,
      lastConversationId: null
    }
    this.data.projects.push(project)
    this.data.activeProjectId = project.id
    this.settings.setWorkspace(project.canonicalRoot)
    this.persist()
    this.notice = '已将原有工作区迁移为项目；历史会话会在项目中按目录恢复。'
    return this.notice
  }

  list(): ProjectInfo[] {
    return this.data.projects
      .slice()
      .sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null) || a.createdAt - b.createdAt)
      .map((project) => this.info(project))
  }

  activeProjectId(): string | null {
    return this.data.activeProjectId
  }

  private find(projectId: string): ProjectRecord {
    const project = this.data.projects.find((item) => item.id === projectId)
    if (!project) throw new AppError('VALIDATION', '项目不存在或已被删除')
    return project
  }

  info(project: ProjectRecord): ProjectInfo {
    return {
      id: project.id,
      name: project.name,
      canonicalRoot: project.canonicalRoot,
      memoryPreset: project.memoryPreset,
      defaultModelRef: project.defaultModelRef,
      createdAt: project.createdAt,
      archivedAt: project.archivedAt,
      available: directoryAvailable(project.canonicalRoot),
      conversationCount: this.data.conversations.filter((item) => item.projectId === project.id).length,
      lastConversationId: project.lastConversationId
    }
  }

  get(projectId: string): ProjectInfo {
    return this.info(this.find(projectId))
  }

  /** Resolve a canonical workspace path back to its project, if one exists. */
  findByRoot(root: string): ProjectInfo | null {
    try {
      const { key } = canonicalDirectory(root)
      const project = this.data.projects.find((item) => rootKey(item.canonicalRoot) === key)
      return project ? this.info(project) : null
    } catch {
      return null
    }
  }

  create(input: {
    name: string
    rootPath: string
    memoryPreset?: unknown
    defaultModelRef?: string | null
  }): ProjectInfo {
    const { canonicalRoot, key } = canonicalDirectory(input.rootPath)
    const existing = this.data.projects.find(
      (project) => rootKey(project.canonicalRoot) === key
    )
    if (existing) {
      // Selecting the same folder again must locate the existing project
      // instead of creating a second entry for the same workspace.
      if (existing.archivedAt !== null) existing.archivedAt = null
      this.data.activeProjectId = existing.id
      if (directoryAvailable(existing.canonicalRoot)) {
        this.settings.setWorkspace(existing.canonicalRoot)
      } else {
        this.settings.clearWorkspace()
      }
      this.persist()
      this.notice = `该目录已绑定到项目「${existing.name}」，已定位到已有项目。`
      return this.info(existing)
    }
    const name = trimText(input.name || basename(canonicalRoot), '项目名称', 80)
    const project: ProjectRecord = {
      id: `proj-${randomUUID()}`,
      name,
      canonicalRoot,
      memoryPreset: normalizePreset(input.memoryPreset),
      defaultModelRef:
        typeof input.defaultModelRef === 'string' && input.defaultModelRef.trim()
          ? input.defaultModelRef.trim()
          : null,
      createdAt: Date.now(),
      archivedAt: null,
      lastConversationId: null
    }
    this.data.projects.push(project)
    this.data.activeProjectId = project.id
    this.settings.setWorkspace(project.canonicalRoot)
    this.persist()
    return this.info(project)
  }

  select(projectId: string): ProjectInfo {
    const project = this.find(projectId)
    this.data.activeProjectId = project.id
    if (directoryAvailable(project.canonicalRoot)) {
      this.settings.setWorkspace(project.canonicalRoot)
    } else {
      this.settings.clearWorkspace()
    }
    this.persist()
    return this.info(project)
  }

  rename(projectId: string, rawName: unknown): ProjectInfo {
    const project = this.find(projectId)
    project.name = trimText(rawName, '项目名称', 80)
    this.persist()
    return this.info(project)
  }

  setMemoryPreset(projectId: string, preset: ProjectMemoryPreset): ProjectInfo {
    const project = this.find(projectId)
    project.memoryPreset = normalizePreset(preset)
    this.persist()
    return this.info(project)
  }

  archive(projectId: string, archived: boolean): ProjectInfo {
    const project = this.find(projectId)
    project.archivedAt = archived ? Date.now() : null
    if (archived && this.data.activeProjectId === project.id) {
      const next = this.data.projects.find((item) => item.archivedAt === null)
      this.data.activeProjectId = next?.id ?? null
      if (next && directoryAvailable(next.canonicalRoot)) this.settings.setWorkspace(next.canonicalRoot)
      else this.settings.clearWorkspace()
    }
    this.persist()
    return this.info(project)
  }

  relocate(projectId: string, newRoot: string): ProjectInfo {
    const project = this.find(projectId)
    const { canonicalRoot, key } = canonicalDirectory(newRoot)
    if (this.data.projects.some((item) => item.id !== project.id && rootKey(item.canonicalRoot) === key)) {
      throw new AppError('VALIDATION', '新目录已经绑定到另一个项目')
    }
    project.canonicalRoot = canonicalRoot
    if (this.data.activeProjectId === project.id) this.settings.setWorkspace(canonicalRoot)
    this.persist()
    return this.info(project)
  }

  conversations(projectId: string): ProjectConversation[] {
    this.find(projectId)
    return this.data.conversations
      .filter((item) => item.projectId === projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((item) => this.publicConversation(item))
  }

  private publicConversation(item: ConversationRecord): ProjectConversation {
    return {
      id: item.id,
      projectId: item.projectId,
      piSessionId: item.piSessionId,
      title: item.title,
      modelOverrideRef: item.modelOverrideRef,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      draft: item.draft
    }
  }

  getConversation(projectId: string, conversationId: string): ProjectConversation {
    const item = this.data.conversations.find(
      (conversation) => conversation.id === conversationId && conversation.projectId === projectId
    )
    if (!item) throw new AppError('VALIDATION', '对话不存在或不属于当前项目')
    return this.publicConversation(item)
  }

  private findConversationRecord(projectId: string, conversationId: string): ConversationRecord {
    const item = this.data.conversations.find(
      (conversation) => conversation.id === conversationId && conversation.projectId === projectId
    )
    if (!item) throw new AppError('VALIDATION', '对话不存在或不属于当前项目')
    return item
  }

  createConversation(projectId: string, titleValue?: unknown): ProjectConversation {
    const project = this.find(projectId)
    if (!directoryAvailable(project.canonicalRoot)) {
      throw new AppError('VALIDATION', '项目目录不可用，无法创建对话')
    }
    const now = Date.now()
    const title = typeof titleValue === 'string' && titleValue.trim() ? titleValue.trim().slice(0, 120) : '新对话'
    const item: ConversationRecord = {
      id: `conv-${randomUUID()}`,
      projectId,
      title,
      createdAt: now,
      updatedAt: now
    }
    this.data.conversations.push(item)
    project.lastConversationId = item.id
    this.persist()
    return this.publicConversation(item)
  }

  bindConversation(
    projectId: string,
    conversationId: string,
    piSessionId: string,
    title?: string
  ): ProjectConversation {
    const project = this.find(projectId)
    const item = this.findConversationRecord(projectId, conversationId)
    item.piSessionId = piSessionId
    item.updatedAt = Date.now()
    if (!item.title || item.title === '新对话') {
      item.title = title?.trim() ? title.trim().slice(0, 120) : `对话 ${piSessionId.slice(0, 8)}`
    }
    project.lastConversationId = item.id
    this.persist()
    return this.publicConversation(item)
  }

  setLastConversation(projectId: string, conversationId: string): void {
    const project = this.find(projectId)
    this.findConversationRecord(projectId, conversationId)
    if (project.lastConversationId === conversationId) return
    project.lastConversationId = conversationId
    this.persist()
  }

  updateConversation(input: {
    projectId: string
    conversationId: string
    title?: unknown
    draft?: unknown
  }): ProjectConversation {
    const item = this.findConversationRecord(input.projectId, input.conversationId)
    if (input.title !== undefined) item.title = trimText(input.title, '对话标题', 120)
    if (input.draft !== undefined) {
      item.draft = typeof input.draft === 'string' ? input.draft.slice(0, 100_000) : ''
    }
    item.updatedAt = Date.now()
    this.persist()
    return this.publicConversation(item)
  }

  upsertSessions(projectId: string, sessions: SessionSummary[]): void {
    const project = this.find(projectId)
    let changed = false
    for (const session of sessions) {
      const existing = this.data.conversations.find(
        (item) => item.projectId === projectId && item.piSessionId === session.id
      )
      const updated = Date.parse(session.modified) || Date.now()
      if (existing) {
        if (!existing.title || existing.title === '新对话') {
          existing.title = conversationTitle(session)
          changed = true
        }
        if (updated > existing.updatedAt) {
          existing.updatedAt = updated
          changed = true
        }
        continue
      }
      this.data.conversations.push({
        id: `conv-pi-${session.id}`,
        projectId,
        piSessionId: session.id,
        title: conversationTitle(session),
        createdAt: Date.parse(session.created) || updated,
        updatedAt: updated
      })
      changed = true
    }
    if (changed) {
      if (!project.lastConversationId) {
        const latest = this.data.conversations
          .filter((item) => item.projectId === projectId)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0]
        project.lastConversationId = latest?.id ?? null
      }
      this.persist()
    }
  }
}
