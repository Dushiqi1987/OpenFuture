import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CredentialState,
  ModelSettings,
  PublicSettings,
  SaveModelInput
} from '../shared/protocol'
import { PROTOCOL_VERSION } from '../shared/protocol'
import { AppError, toErrorMessage } from './errors'

interface SettingsFile {
  version: number
  workspace: string | null
  model: ModelSettings | null
  allowPowerShell: boolean
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
const CREDENTIAL_PLACEHOLDER = 'runtime-injected-credential'

function emptySettings(): SettingsFile {
  return { version: PROTOCOL_VERSION, workspace: null, model: null, allowPowerShell: false }
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

  credentialState(): CredentialState {
    if (this.readCredential()) return 'bound'
    if (existsSync(this.credentialPath) || existsSync(this.legacyKeyPath)) return 'needs-rebind'
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
    const existing = this.readCredential()
    if (apiKey) {
      this.writeCredential({ version: 2, baseUrl, apiKey })
      // The old key-only file carries no endpoint information and must never be
      // used again; remove it only after the bound credential was written.
      if (existsSync(this.legacyKeyPath)) rmSync(this.legacyKeyPath, { force: true })
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
    if (existsSync(this.credentialPath)) rmSync(this.credentialPath, { force: true })
    if (existsSync(this.legacyKeyPath)) rmSync(this.legacyKeyPath, { force: true })
    return this.getPublicSettings()
  }

  setPowerShellAccess(enabled: boolean): PublicSettings {
    this.settings.allowPowerShell = enabled === true
    this.persist()
    return this.getPublicSettings()
  }

  getPublicSettings(): PublicSettings {
    return {
      version: PROTOCOL_VERSION,
      workspace: this.settings.workspace,
      model: this.settings.model,
      apiKeyConfigured: this.credentialState() === 'bound',
      credentialState: this.credentialState(),
      allowPowerShell: this.settings.allowPowerShell,
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
      // High-risk tool access is an explicit opt-in persisted in settings.
      OPENFUTURE_ALLOW_POWERSHELL: this.settings.allowPowerShell ? '1' : '0'
    }
    const model = this.settings.model
    if (model) {
      env.OPENFUTURE_MODEL_PROVIDER = model.providerId
      env.OPENFUTURE_MODEL_ID = model.modelId
    }
    return env
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

  private readCredential(): CredentialV2 | null {
    if (!existsSync(this.credentialPath)) return null
    try {
      if (!safeStorage.isEncryptionAvailable()) return null
      const encoded = readFileSync(this.credentialPath, 'utf8').trim()
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
    this.writeAtomic(this.credentialPath, encrypted.toString('base64'))
  }

  private writeModelsJson(): void {
    const model = this.settings.model
    if (!model) return
    const document = {
      providers: {
        [PROVIDER_ID]: {
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
              compat: { supportsDeveloperRole: false }
            }
          ]
        }
      }
    }
    this.writeAtomic(join(this.agentDir, 'models.json'), JSON.stringify(document, null, 2))
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
