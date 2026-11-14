import { safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CredentialState,
  GroupChatMembers,
  GroupModelProfile,
  ModelSettings,
  PublicSettings,
  SaveGroupModelProfileInput,
  SaveModelInput,
  SetUiPreferencesInput,
  UiPreferences
} from '../shared/protocol'
import { PROTOCOL_VERSION } from '../shared/protocol'
import { AppError, toErrorMessage } from './errors'

interface SettingsFile {
  version: number
  workspace: string | null
  model: ModelSettings | null
  allowPowerShell: boolean
  computerUse: boolean
  contextCompression: boolean
  /** Parallel in-process subagents (`delegate_tasks`). */
  subagents: boolean
  /** 1-4 concurrent child sessions. */
  subagentConcurrency: number
  /** Serial group chat (`start_group_chat`). */
  groupChat: boolean
  /** Extra endpoints that group chat roles can use. */
  groupModelProfiles: GroupModelProfile[]
  /** Profile id per role; null means the primary model. */
  groupChatModels: GroupChatMembers
  /** Local appearance and input preferences. */
  ui: UiPreferences
}

interface CredentialV2 {
  version: 2
  baseUrl: string
  apiKey: string
}

interface ActiveCredential {
  providerId: string
  baseUrl: string
  apiKey: string
}

const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 8_192
const PROVIDER_ID = 'openfuture'
const OPENCODE_GO_URL = 'https://opencode.ai/inference/go/openai/v1'
const OPENCODE_GO_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  maxTokensField: 'max_tokens',
  thinkingFormat: 'deepseek',
  requiresReasoningContentOnAssistantMessages: true
}
const CREDENTIAL_PLACEHOLDER = 'runtime-injected-credential'

function emptySettings(): SettingsFile {
  return {
    version: PROTOCOL_VERSION,
    workspace: null,
    model: null,
    allowPowerShell: false,
    computerUse: false,
    contextCompression: true,
    subagents: true,
    subagentConcurrency: 3,
    groupChat: true,
    groupModelProfiles: [],
    groupChatModels: { lead: null, critic: null, chair: null },
    ui: { ...DEFAULT_UI_PREFERENCES }
  }
}

const GROUP_PROVIDER_PREFIX = 'openfuture-g-'

const UI_THEMES = new Set(['system', 'dark', 'light'])
const UI_DENSITIES = new Set(['comfortable', 'compact'])
const UI_SHORTCUTS = new Set(['enter', 'ctrl+enter'])
const THINKING_LEVELS = new Set(['off', 'low', 'medium', 'high'])
const UI_SCALES = [0.9, 1, 1.1, 1.25]

/** Defaults also used when an older settings file has no `ui` block. */
export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  theme: 'system',
  scale: 1,
  density: 'comfortable',
  showTimestamps: true,
  sendShortcut: 'enter',
  thinkingLevel: 'medium'
}

/** Coerces an unknown persisted value into a valid UI preference block. */
export function normalizeUiPreferences(value: unknown): UiPreferences {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const scale = typeof record.scale === 'number' && UI_SCALES.includes(record.scale) ? record.scale : 1
  return {
    theme: UI_THEMES.has(record.theme as string) ? (record.theme as UiPreferences['theme']) : 'system',
    scale,
    density: UI_DENSITIES.has(record.density as string) ? (record.density as UiPreferences['density']) : 'comfortable',
    showTimestamps: record.showTimestamps !== false,
    sendShortcut: UI_SHORTCUTS.has(record.sendShortcut as string) ? (record.sendShortcut as UiPreferences['sendShortcut']) : 'enter',
    thinkingLevel: THINKING_LEVELS.has(record.thinkingLevel as string) ? (record.thinkingLevel as UiPreferences['thinkingLevel']) : 'medium'
  }
}

/** Provider id used for a group model profile in models.json. */
export function groupProviderId(profileId: string): string {
  return `${GROUP_PROVIDER_PREFIX}${profileId}`
}

function assertPositiveInteger(value: number, field: string, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new AppError('VALIDATION', `${field} 必须是 1 到 ${max} 之间的整数`)
  }
  return value
}

/**
 * Canonical endpoint form used to bind credentials. Host names are
 * case-insensitive, default ports and trailing slashes are equivalent; path
 * case remains significant, and query/fragment are rejected because they are
 * not part of the endpoint identity.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new AppError('VALIDATION', '请填写 Base URL')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new AppError('VALIDATION', 'Base URL 不是合法的地址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('VALIDATION', 'Base URL 只支持 http 或 https')
  }
  if (url.username || url.password) {
    throw new AppError('VALIDATION', 'Base URL 不能包含用户名或密码')
  }
  if (url.search || url.hash) {
    throw new AppError('VALIDATION', 'Base URL 不能包含查询参数或片段')
  }
  const pathname = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${pathname}`
}

function normalizeProfiles(value: unknown): GroupModelProfile[] {
  if (!Array.isArray(value)) return []
  const profiles: GroupModelProfile[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as Partial<GroupModelProfile>
    if (typeof candidate.id !== 'string' || candidate.id === '') continue
    if (typeof candidate.label !== 'string') continue
    if (typeof candidate.baseUrl !== 'string') continue
    if (typeof candidate.modelId !== 'string' || candidate.modelId === '') continue
    profiles.push({
      id: candidate.id,
      label: candidate.label,
      baseUrl: candidate.baseUrl,
      modelId: candidate.modelId,
      contextWindow: Number(candidate.contextWindow) || DEFAULT_CONTEXT_WINDOW,
      maxTokens: Number(candidate.maxTokens) || DEFAULT_MAX_TOKENS
    })
  }
  return profiles
}

function normalizeMembers(value: unknown): GroupChatMembers {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const pick = (role: string): string | null =>
    typeof record[role] === 'string' && (record[role] as string) !== '' ? (record[role] as string) : null
  return { lead: pick('lead'), critic: pick('critic'), chair: pick('chair') }
}

export class SettingsStore {
  readonly userDataDir: string
  readonly agentDir: string
  readonly sessionDir: string
  readonly memoryDir: string
  readonly appVersion: string
  private readonly settingsPath: string
  private readonly credentialPath: string
  private readonly legacyKeyPath: string
  private settings: SettingsFile = emptySettings()

  constructor(userDataDir: string, appVersion: string) {
    this.userDataDir = userDataDir
    this.appVersion = appVersion
    this.agentDir = join(userDataDir, 'pi', 'agent')
    this.sessionDir = join(this.agentDir, 'sessions')
    this.memoryDir = join(userDataDir, 'memory')
    this.settingsPath = join(userDataDir, 'config', 'settings.json')
    this.credentialPath = join(userDataDir, 'config', 'secrets', 'model-credential.bin')
    this.legacyKeyPath = join(userDataDir, 'config', 'secrets', 'model-api-key.bin')
  }

  init(): void {
    mkdirSync(join(this.userDataDir, 'config', 'secrets'), { recursive: true })
    mkdirSync(this.agentDir, { recursive: true })
    mkdirSync(this.sessionDir, { recursive: true })
    mkdirSync(this.memoryDir, { recursive: true })
    this.settings = this.readSettings()
    this.writeModelsJson()
  }

  getWorkspace(): string | null {
    return this.settings.workspace
  }

  requireWorkspace(): string {
    if (!this.settings.workspace) throw new AppError('NO_WORKSPACE', '请先选择工作区')
    return this.settings.workspace
  }

  setWorkspace(workspace: string): PublicSettings {
    let stats
    try {
      stats = statSync(workspace)
    } catch {
      throw new AppError('VALIDATION', '工作区目录不存在')
    }
    if (!stats.isDirectory()) throw new AppError('VALIDATION', '工作区必须是目录')
    this.settings.workspace = workspace
    this.persist()
    return this.getPublicSettings()
  }

  clearWorkspace(): PublicSettings {
    this.settings.workspace = null
    this.persist()
    return this.getPublicSettings()
  }

  private credentialPathFor(baseUrl = this.settings.model?.baseUrl): string {
    return baseUrl === OPENCODE_GO_URL
      ? join(this.userDataDir, 'config', 'secrets', 'opencode-go-credential.bin')
      : this.credentialPath
  }

  credentialState(): CredentialState {
    if (this.readCredential()) return 'bound'
    if (existsSync(this.credentialPathFor()) || (this.settings.model?.baseUrl !== OPENCODE_GO_URL && existsSync(this.legacyKeyPath))) return 'needs-rebind'
    return 'none'
  }

  hasApiKey(): boolean {
    return this.credentialState() === 'bound'
  }

  /**
   * Returns the decrypted key only when it is bound to the *current* model
   * endpoint. This is the single gate used before a request leaves the app.
   */
  getActiveCredential(): ActiveCredential {
    const model = this.settings.model
    if (!model) throw new AppError('NO_MODEL', '请先在「模型与密钥」中配置模型和 API Key')
    const credential = this.readCredential()
    if (!credential) {
      if (this.credentialState() === 'needs-rebind') {
        throw new AppError(
          'VALIDATION',
          '检测到旧版或未绑定的 API Key。请在「模型与密钥」中重新输入 API Key，以绑定当前模型端点'
        )
      }
      throw new AppError('NO_MODEL', '尚未配置 API Key，请先在「模型与密钥」中填写')
    }
    const endpoint = normalizeBaseUrl(model.baseUrl)
    if (credential.baseUrl !== endpoint) {
      throw new AppError(
        'VALIDATION',
        'API Key 与当前模型端点不匹配，请在「模型与密钥」中重新输入 API Key'
      )
    }
    return { providerId: model.providerId, baseUrl: credential.baseUrl, apiKey: credential.apiKey }
  }

  getModel(): ModelSettings | null {
    return this.settings.model
  }

  saveModel(input: SaveModelInput): PublicSettings {
    const modelId = typeof input.modelId === 'string' ? input.modelId.trim() : ''
    if (!modelId || modelId.length > 200) {
      throw new AppError('VALIDATION', '模型 ID 不能为空且不能超过 200 个字符')
    }
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    const contextWindow = assertPositiveInteger(
      input.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      '上下文窗口',
      10_000_000
    )
    const maxTokens = assertPositiveInteger(input.maxTokens ?? DEFAULT_MAX_TOKENS, '最大输出 token', 1_000_000)
    const displayName = (input.displayName?.trim() || modelId).slice(0, 120)
    const model: ModelSettings = {
      providerId: PROVIDER_ID,
      baseUrl,
      modelId,
      displayName,
      contextWindow,
      maxTokens,
      reasoning: input.reasoning === true
    }

    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
    const existing = this.readCredential(baseUrl)
    if (apiKey) {
      this.writeCredential({ version: 2, baseUrl, apiKey })
      // The old key-only file carries no endpoint information and must never be
      // used again; remove it only after the bound credential was written.
      if (baseUrl !== OPENCODE_GO_URL && existsSync(this.legacyKeyPath)) rmSync(this.legacyKeyPath, { force: true })
    } else if (!existing || existing.baseUrl !== baseUrl) {
      const state = this.credentialState()
      if (state === 'needs-rebind') {
        throw new AppError(
          'VALIDATION',
          '检测到旧版或未绑定的 API Key。请重新输入 API Key，以绑定当前模型端点'
        )
      }
      if (existing) {
        throw new AppError(
          'VALIDATION',
          '更改模型端点时必须重新输入 API Key；原 Key 只对旧端点有效'
        )
      }
      throw new AppError('VALIDATION', '请为当前模型填写 API Key')
    }

    this.settings.model = model
    this.persist()
    this.writeModelsJson()
    return this.getPublicSettings()
  }

  clearApiKey(): PublicSettings {
    rmSync(this.credentialPathFor(), { force: true })
    if (this.settings.model?.baseUrl !== OPENCODE_GO_URL) rmSync(this.legacyKeyPath, { force: true })
    return this.getPublicSettings()
  }

  setPowerShellAccess(enabled: boolean): PublicSettings {
    this.settings.allowPowerShell = enabled === true
    this.persist()
    return this.getPublicSettings()
  }

  getComputerUse(): boolean {
    return this.settings.computerUse === true
  }

  setComputerUse(enabled: boolean): PublicSettings {
    this.settings.computerUse = enabled === true
    this.persist()
    return this.getPublicSettings()
  }

  getContextCompression(): boolean {
    return this.settings.contextCompression !== false
  }

  setContextCompression(enabled: boolean): PublicSettings {
    this.settings.contextCompression = enabled === true
    this.persist()
    return this.getPublicSettings()
  }

  /** Parallel subagents are on by default; they degrade to a plain session when off. */
  getSubagents(): boolean {
    return this.settings.subagents !== false
  }

  setSubagents(enabled: boolean): PublicSettings {
    this.settings.subagents = enabled === true
    this.persist()
    return this.getPublicSettings()
  }

  getSubagentConcurrency(): number {
    const value = this.settings.subagentConcurrency
    return Number.isInteger(value) && value >= 1 && value <= 4 ? value : 3
  }

  setSubagentConcurrency(value: number): PublicSettings {
    this.settings.subagentConcurrency = assertPositiveInteger(value, '子 Agent 并发数', 4)
    this.persist()
    return this.getPublicSettings()
  }

  /** Group chat is on by default; it degrades to a plain session when off. */
  getGroupChat(): boolean {
    return this.settings.groupChat !== false
  }

  setGroupChat(enabled: boolean): PublicSettings {
    this.settings.groupChat = enabled === true
    this.persist()
    return this.getPublicSettings()
  }

  getUiPreferences(): UiPreferences {
    return { ...normalizeUiPreferences(this.settings.ui) }
  }

  /** Merges validated UI preferences; unknown/invalid values fall back. */
  setUiPreferences(input: SetUiPreferencesInput): PublicSettings {
    const next = normalizeUiPreferences({ ...this.getUiPreferences(), ...input })
    this.settings.ui = next
    this.persist()
    return this.getPublicSettings()
  }

  getGroupModelProfiles(): GroupModelProfile[] {
    return this.settings.groupModelProfiles.map((profile) => ({ ...profile }))
  }

  getGroupChatMembers(): GroupChatMembers {
    return { ...this.settings.groupChatModels }
  }

  /**
   * Profiles are local endpoints with their own key file; the primary model
   * keeps using the encrypted credential bound to `settings.model.baseUrl`.
   */
  saveGroupModelProfile(input: SaveGroupModelProfileInput): PublicSettings {
    const label = typeof input.label === 'string' ? input.label.trim() : ''
    if (label === '' || label.length > 60) {
      throw new AppError('VALIDATION', '模型名称不能为空且不能超过 60 个字符')
    }
    const modelId = typeof input.modelId === 'string' ? input.modelId.trim() : ''
    if (modelId === '' || modelId.length > 200) {
      throw new AppError('VALIDATION', '模型 ID 不能为空且不能超过 200 个字符')
    }
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    const contextWindow = assertPositiveInteger(
      input.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      '上下文窗口',
      10_000_000
    )
    const maxTokens = assertPositiveInteger(
      input.maxTokens ?? DEFAULT_MAX_TOKENS,
      '最大输出 token',
      1_000_000
    )
    const existing =
      typeof input.id === 'string' && input.id !== ''
        ? this.settings.groupModelProfiles.find((profile) => profile.id === input.id)
        : undefined
    if (typeof input.id === 'string' && input.id !== '' && !existing) {
      throw new AppError('VALIDATION', '要修改的模型不存在')
    }
    const id = existing?.id ?? `gm-${randomUUID().slice(0, 8)}`
    const profile: GroupModelProfile = { id, label, baseUrl, modelId, contextWindow, maxTokens }

    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
    const stored = this.readGroupCredential(id)
    if (apiKey !== '') {
      this.writeGroupCredential(id, { version: 2, baseUrl, apiKey })
    } else if (!stored || stored.baseUrl !== baseUrl) {
      throw new AppError('VALIDATION', '更改端点时必须重新填写 API Key')
    }

    const index = this.settings.groupModelProfiles.findIndex((item) => item.id === id)
    if (index >= 0) this.settings.groupModelProfiles[index] = profile
    else this.settings.groupModelProfiles.push(profile)
    this.persist()
    this.writeModelsJson()
    return this.getPublicSettings()
  }

  deleteGroupModelProfile(id: string): PublicSettings {
    const index = this.settings.groupModelProfiles.findIndex((profile) => profile.id === id)
    if (index < 0) return this.getPublicSettings()
    this.settings.groupModelProfiles.splice(index, 1)
    const members = this.settings.groupChatModels
    for (const role of ['lead', 'critic', 'chair'] as const) {
      if (members[role] === id) members[role] = null
    }
    rmSync(this.groupCredentialPath(id), { force: true })
    this.persist()
    this.writeModelsJson()
    return this.getPublicSettings()
  }

  setGroupChatMembers(members: GroupChatMembers): PublicSettings {
    const known = new Set(this.settings.groupModelProfiles.map((profile) => profile.id))
    const pick = (value: unknown): string | null => {
      if (value === null || value === undefined || value === '') return null
      if (typeof value !== 'string' || !known.has(value)) {
        throw new AppError('VALIDATION', '请选择已配置的群聊模型')
      }
      return value
    }
    this.settings.groupChatModels = {
      lead: pick(members.lead),
      critic: pick(members.critic),
      chair: pick(members.chair)
    }
    this.persist()
    return this.getPublicSettings()
  }

  /** Decrypted key for a group profile, or null when missing. */
  getGroupProfileCredential(id: string): { providerId: string; apiKey: string } | null {
    const profile = this.settings.groupModelProfiles.find((item) => item.id === id)
    if (!profile) return null
    const credential = this.readGroupCredential(id)
    if (!credential || credential.baseUrl !== profile.baseUrl) return null
    return { providerId: groupProviderId(id), apiKey: credential.apiKey }
  }

  private groupCredentialPath(id: string): string {
    return join(this.userDataDir, 'config', 'secrets', `group-${id}.bin`)
  }

  private readGroupCredential(id: string): CredentialV2 | null {
    const path = this.groupCredentialPath(id)
    if (!existsSync(path)) return null
    try {
      if (!safeStorage.isEncryptionAvailable()) return null
      const encoded = readFileSync(path, 'utf8').trim()
      if (!encoded) return null
      const parsed = JSON.parse(safeStorage.decryptString(Buffer.from(encoded, 'base64'))) as Partial<CredentialV2>
      if (parsed.version !== 2 || typeof parsed.baseUrl !== 'string' || typeof parsed.apiKey !== 'string') {
        return null
      }
      return { version: 2, baseUrl: parsed.baseUrl, apiKey: parsed.apiKey }
    } catch {
      return null
    }
  }

  private writeGroupCredential(id: string, credential: CredentialV2): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new AppError('INTERNAL', '系统加密存储不可用，拒绝以明文保存 API Key')
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(credential))
    mkdirSync(join(this.userDataDir, 'config', 'secrets'), { recursive: true })
    this.writeAtomic(this.groupCredentialPath(id), encrypted.toString('base64'))
  }

  getPublicSettings(): PublicSettings {
    return {
      version: PROTOCOL_VERSION,
      workspace: this.settings.workspace,
      model: this.settings.model,
      apiKeyConfigured: this.credentialState() === 'bound',
      credentialState: this.credentialState(),
      allowPowerShell: this.settings.allowPowerShell,
      computerUse: this.getComputerUse(),
      contextCompression: this.getContextCompression(),
      subagents: this.getSubagents(),
      subagentConcurrency: this.getSubagentConcurrency(),
      groupChat: this.getGroupChat(),
      groupModelProfiles: this.getGroupModelProfiles(),
      groupChatModels: this.getGroupChatMembers(),
      ui: this.getUiPreferences(),
      agentDir: this.agentDir,
      appVersion: this.appVersion
    }
  }

  /** Environment variables injected into the agent utility process only. No secret. */
  hostEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      OPENFUTURE_AGENT_DIR: this.agentDir,
      OPENFUTURE_SESSION_DIR: this.sessionDir,
      OPENFUTURE_MEMORY_DIR: this.memoryDir,
      OPENFUTURE_USER_DATA_DIR: this.userDataDir,
      OPENFUTURE_ACP_CONTEXT: this.getContextCompression() ? '1' : '0',
      // High-risk tool access is an explicit opt-in persisted in settings.
      OPENFUTURE_ALLOW_POWERSHELL: this.settings.allowPowerShell ? '1' : '0',
      // Parallel subagents: settings win over the shell environment because the
      // host is forked with this exact env block.
      OPENFUTURE_SUBAGENTS: this.getSubagents() ? '1' : '0',
      OPENFUTURE_SUBAGENT_CONCURRENCY: String(this.getSubagentConcurrency()),
      OPENFUTURE_GROUP_CHAT: this.getGroupChat() ? '1' : '0',
      // Thinking level is fixed per session at creation time.
      OPENFUTURE_THINKING_LEVEL: this.getUiPreferences().thinkingLevel,
      // Role -> extra provider/model. Absent roles use the primary model.
      OPENFUTURE_GROUP_MODELS: JSON.stringify(this.groupRoleModels())
    }
    const model = this.settings.model
    if (model) {
      env.OPENFUTURE_MODEL_PROVIDER = model.providerId
      env.OPENFUTURE_MODEL_ID = model.modelId
    }
    return env
  }

  /** Role -> {providerId, modelId} for profiles that differ from the primary. */
  private groupRoleModels(): Record<string, { providerId: string; modelId: string }> {
    const members = this.settings.groupChatModels
    const result: Record<string, { providerId: string; modelId: string }> = {}
    for (const role of ['lead', 'critic', 'chair'] as const) {
      const id = members[role]
      if (!id) continue
      const profile = this.settings.groupModelProfiles.find((item) => item.id === id)
      if (!profile) continue
      result[role] = { providerId: groupProviderId(profile.id), modelId: profile.modelId }
    }
    return result
  }

  /** Environment variables injected into the memory utility process only. */
  memoryEnvironment(): NodeJS.ProcessEnv {
    return { OPENFUTURE_MEMORY_DIR: this.memoryDir }
  }

  private readSettings(): SettingsFile {
    if (!existsSync(this.settingsPath)) return emptySettings()
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as Partial<SettingsFile>
      const model = parsed.model
      return {
        version: PROTOCOL_VERSION,
        workspace: typeof parsed.workspace === 'string' ? parsed.workspace : null,
        allowPowerShell: parsed.allowPowerShell === true,
        computerUse: parsed.computerUse === true,
        contextCompression: parsed.contextCompression !== false,
        subagents: parsed.subagents !== false,
        subagentConcurrency:
          Number.isInteger(parsed.subagentConcurrency) &&
          (parsed.subagentConcurrency as number) >= 1 &&
          (parsed.subagentConcurrency as number) <= 4
            ? (parsed.subagentConcurrency as number)
            : 3,
        groupChat: parsed.groupChat !== false,
        groupModelProfiles: normalizeProfiles(parsed.groupModelProfiles),
        groupChatModels: normalizeMembers(parsed.groupChatModels),
        ui: normalizeUiPreferences(parsed.ui),
        model:
          model &&
          typeof model.providerId === 'string' &&
          typeof model.baseUrl === 'string' &&
          typeof model.modelId === 'string'
            ? {
                providerId: model.providerId,
                baseUrl: model.baseUrl,
                modelId: model.modelId,
                displayName: typeof model.displayName === 'string' ? model.displayName : model.modelId,
                contextWindow: Number(model.contextWindow) || DEFAULT_CONTEXT_WINDOW,
                maxTokens: Number(model.maxTokens) || DEFAULT_MAX_TOKENS,
                reasoning: model.reasoning === true
              }
            : null
      }
    } catch (error) {
      console.error('[settings] failed to read settings.json:', toErrorMessage(error))
      return emptySettings()
    }
  }

  private persist(): void {
    mkdirSync(join(this.userDataDir, 'config'), { recursive: true })
    this.writeAtomic(this.settingsPath, JSON.stringify(this.settings, null, 2))
  }

  private readCredential(baseUrl?: string): CredentialV2 | null {
    const path = this.credentialPathFor(baseUrl)
    if (!existsSync(path)) return null
    try {
      if (!safeStorage.isEncryptionAvailable()) return null
      const encoded = readFileSync(path, 'utf8').trim()
      if (!encoded) return null
      const raw = safeStorage.decryptString(Buffer.from(encoded, 'base64'))
      const parsed = JSON.parse(raw) as Partial<CredentialV2>
      if (
        parsed.version !== 2 ||
        typeof parsed.baseUrl !== 'string' ||
        typeof parsed.apiKey !== 'string' ||
        parsed.apiKey.trim() === ''
      ) {
        return null
      }
      return { version: 2, baseUrl: parsed.baseUrl, apiKey: parsed.apiKey }
    } catch {
      return null
    }
  }

  private writeCredential(credential: CredentialV2): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new AppError('INTERNAL', '系统加密存储不可用，拒绝以明文保存 API Key')
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(credential))
    mkdirSync(join(this.userDataDir, 'config', 'secrets'), { recursive: true })
    this.writeAtomic(this.credentialPathFor(credential.baseUrl), encrypted.toString('base64'))
  }

  private writeModelsJson(): void {
    const model = this.settings.model
    const providers: Record<string, unknown> = {}
    if (model) {
      providers[PROVIDER_ID] = {
          baseUrl: model.baseUrl,
          api: 'openai-completions',
          // The real key is injected at runtime with ModelRuntime.setRuntimeApiKey.
          apiKey: CREDENTIAL_PLACEHOLDER,
          models: [
            {
              id: model.modelId,
              name: model.displayName,
              reasoning: model.reasoning,
              input: ['text'],
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
              // DashScope's OpenAI-compatible layer rejects the `developer`
              // role. Pi only sends it for reasoning models, so pin the
              // instruction role to `system` for every custom provider.
              compat: model.baseUrl === OPENCODE_GO_URL ? OPENCODE_GO_COMPAT : { supportsDeveloperRole: false }
            }
          ]
        }
    }
    for (const profile of this.settings.groupModelProfiles) {
      providers[groupProviderId(profile.id)] = {
        baseUrl: profile.baseUrl,
        api: 'openai-completions',
        apiKey: CREDENTIAL_PLACEHOLDER,
        models: [
          {
            id: profile.modelId,
            name: profile.label,
            reasoning: false,
            input: ['text'],
            contextWindow: profile.contextWindow,
            maxTokens: profile.maxTokens,
            compat: { supportsDeveloperRole: false }
          }
        ]
      }
    }
    if (Object.keys(providers).length === 0) return
    this.writeAtomic(
      join(this.agentDir, 'models.json'),
      JSON.stringify({ providers }, null, 2)
    )
  }

  private writeAtomic(path: string, content: string): void {
    const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tempPath, content, 'utf8')
    // rename over the target; on Windows rename fails if the target exists in some
    // edge cases, so fall back to a direct write.
    try {
      renameSync(tempPath, path)
    } catch {
      writeFileSync(path, content, 'utf8')
      rmSync(tempPath, { force: true })
    }
  }
}
