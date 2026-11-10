/**
 * Agent host: runs inside an Electron utilityProcess.
 *
 * The renderer never talks to this process directly. The main process forwards
 * validated RPC calls and relays AgentStreamEvent payloads back to the window.
 * All Pi SDK access stays in this file so the Electron main bundle does not have
 * to load the (ESM-only) Pi runtime.
 */
import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ParentPort } from 'electron'
import { createWorkspaceToolset } from './workspace-tools'
import { createMemoryTools } from './memory-tools'
import { createComputerTools } from './computer-tools'
import type {
  AgentSession,
  AgentSessionEvent,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type {
  AgentStreamEvent,
  ChatMessage,
  ComputerToolInfo,
  IpcErrorCode,
  L3Context,
  MemoryCitation,
  MemoryMode,
  MessageUsage,
  OpenSessionResult,
  SessionSummary,
} from '../shared/protocol'

type PiModule = typeof import('@earendil-works/pi-coding-agent')

interface RpcRequest {
  kind: 'request'
  id: number
  method: string
  params?: unknown
}

interface RpcSuccess {
  kind: 'response'
  id: number
  ok: true
  value: unknown
}

interface RpcFailure {
  kind: 'response'
  id: number
  ok: false
  error: { code: IpcErrorCode; message: string }
}

type RpcResponse = RpcSuccess | RpcFailure

interface HostEvent {
  kind: 'event'
  event: AgentStreamEvent
}

export type HostMessage = RpcResponse | HostEvent

class RpcError extends Error {
  readonly code: IpcErrorCode

  constructor(code: IpcErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

const port: ParentPort = process.parentPort
const agentDir = requiredEnv('OPENFUTURE_AGENT_DIR')
const sessionDir = requiredEnv('OPENFUTURE_SESSION_DIR')
const providerId = process.env.OPENFUTURE_MODEL_PROVIDER ?? 'openfuture'
const modelId = process.env.OPENFUTURE_MODEL_ID ?? ''

let piPromise: Promise<PiModule> | undefined
let modelRuntimePromise: Promise<ModelRuntime> | undefined
let current: AgentSession | null = null
let unsubscribe: (() => void) | null = null
let currentCwd: string | null = null
let busy = false
let abortRequested = false
let assistantSeq = 0
let currentAssistantId: string | null = null
let runtimeApiKey: string | null = null

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable ${name}`)
  return value
}

function loadPi(): Promise<PiModule> {
  piPromise ??= import('@earendil-works/pi-coding-agent')
  return piPromise
}

function loadModelRuntime(pi: PiModule): Promise<ModelRuntime> {
  modelRuntimePromise ??= pi.ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  })
  return modelRuntimePromise
}

function send(message: RpcResponse | HostEvent): void {
  port.postMessage(message)
}

function sendEvent(event: AgentStreamEvent): void {
  send({ kind: 'event', event })
}

interface ContextResponse {
  kind: 'context-response'
  id: number
  ok: boolean
  value?: unknown
  error?: { code?: string; message?: string }
}

interface PendingContext {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

let contextSeq = 0
const contextPending = new Map<number, PendingContext>()

function requestContextValue(payload: { mode: MemoryMode; validateIds?: string[] }): Promise<unknown> {
  const id = ++contextSeq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      contextPending.delete(id)
      reject(new Error('记忆上下文请求超时'))
    }, 4_000)
    contextPending.set(id, { resolve, reject, timer })
    try {
      port.postMessage({ kind: 'context-request', id, ...payload })
    } catch (error) {
      contextPending.delete(id)
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function requestL3Context(mode: MemoryMode): Promise<L3Context | null> {
  return requestContextValue({ mode }).then((value) => (value as L3Context | null) ?? null)
}

async function requestValidIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  try {
    const value = (await requestContextValue({ mode: 'both', validateIds: ids })) as
      | { valid?: unknown }
      | undefined
    const valid = Array.isArray(value?.valid) ? value.valid.filter((id): id is string => typeof id === 'string') : []
    return new Set(valid)
  } catch (error) {
    // A validation outage must fail closed for historical tool results.
    console.log(`[agent-host] memory tool result validation unavailable: ${errorMessage(error)}`)
    return new Set()
  }
}

const MEMORY_TOOL_NAMES = new Set(['memory_search', 'memory_get', 'memory_propose', 'wiki_search', 'wiki_get'])
const HISTORICAL_MEMORY_PLACEHOLDER = '[历史记忆工具结果已按当前撤销状态清理]'

function toolResultText(message: any): string {
  const parts = Array.isArray(message?.content) ? message.content : []
  return parts
    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: any) => part.text as string)
    .join('\n')
}

function parseToolPayload(message: any): Record<string, unknown> | null {
  const text = toolResultText(message).trim()
  if (!text.startsWith('{')) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function memoryIdsIn(payload: Record<string, unknown> | null): string[] {
  if (!payload) return []
  const ids: string[] = []
  if (typeof payload.id === 'string' && payload.id) ids.push(payload.id)
  if (Array.isArray(payload.hits)) {
    for (const hit of payload.hits) {
      if (hit && typeof hit === 'object' && typeof (hit as { id?: unknown }).id === 'string') {
        ids.push((hit as { id: string }).id)
      }
    }
  }
  return ids
}

function filteredMemoryResult(payload: Record<string, unknown>, valid: Set<string>): Record<string, unknown> | null {
  if (Array.isArray(payload.hits)) {
    const allValid = payload.hits.every(
      (hit) =>
        hit &&
        typeof hit === 'object' &&
        typeof (hit as { id?: unknown }).id === 'string' &&
        valid.has((hit as { id: string }).id)
    )
    if (allValid) return payload
    const kept = payload.hits.filter(
      (hit) =>
        hit &&
        typeof hit === 'object' &&
        typeof (hit as { id?: unknown }).id === 'string' &&
        valid.has((hit as { id: string }).id)
    )
    if (kept.length === 0) return null
    return { ...payload, hits: kept, details: [] }
  }
  if (typeof payload.id === 'string') return valid.has(payload.id) ? payload : null
  return payload
}

interface ContextAdapter {
  process(messages: unknown[]): Promise<{ ok: boolean; mode: string; messages: unknown[] }>
}

async function openContextAdapter(workspace: string, sessionId: string, limit: number): Promise<ContextAdapter | undefined> {
  const modulePath = process.env.OPENFUTURE_ACP_MODULE?.trim()
  const dataDir = process.env.OPENFUTURE_USER_DATA_DIR
  if (!modulePath || !dataDir || !isAbsolute(modulePath) || !Number.isFinite(limit)) return
  try {
    const { KernelHost } = await import(pathToFileURL(modulePath).href)
    return KernelHost.open({
      projectId: createHash('sha256').update(workspace).digest('hex'),
      sessionId,
      storeRoot: join(dataDir, 'context'),
      modelContextLimit: limit
    }) as ContextAdapter
  } catch {
    console.log('[agent-host] ACP unavailable, using Pi context')
    return undefined
  }
}

function createLiveMemoryExtension(mode: MemoryMode, adapter?: ContextAdapter): (pi: unknown) => void {
  return (pi: unknown) => {
    const api = pi as {
      on: (name: string, handler: (event: any) => Promise<unknown>) => void
    }
    api.on('context', async (event: { messages?: Array<any> }) => {
      if (!Array.isArray(event.messages)) return undefined
      if (adapter) {
        // Only project text-only history. Pi retains ownership of tool and
        // multimodal turns, and ACP never archives retrieved memory.
        const textOnly = event.messages.every((message) =>
          (message?.role === 'user' || message?.role === 'assistant') &&
          (typeof message.content === 'string' ||
            (Array.isArray(message.content) &&
              message.content.every((part: { type?: string }) => part?.type === 'text' || part?.type === 'thinking')))
        )
        if (!textOnly) {
          adapter = undefined
        } else {
          try {
            const result = await adapter.process(event.messages)
            if (result.ok && result.mode === 'acp' && result.messages.length > 0) return { messages: result.messages }
          } catch {
            adapter = undefined
          }
        }
      }
      const memoryMessages = event.messages.filter(
        (message) => message?.role === 'toolResult' && MEMORY_TOOL_NAMES.has(message.toolName)
      )
      const parsed = new Map<any, Record<string, unknown> | null>()
      const ids = new Set<string>()
      for (const message of memoryMessages) {
        if (message.toolName === 'memory_propose') continue
        const payload = parseToolPayload(message)
        parsed.set(message, payload)
        for (const id of memoryIdsIn(payload)) ids.add(id)
      }
      if (ids.size === 0) return undefined
      const valid = await requestValidIds([...ids])
      let changed = false
      const messages = event.messages.map((message) => {
        if (!memoryMessages.includes(message) || message.toolName === 'memory_propose') return message
        const payload = parsed.get(message) ?? null
        const filtered = payload ? filteredMemoryResult(payload, valid) : null
        if (filtered === payload) return message
        changed = true
        if (!filtered) {
          return {
            ...message,
            content: [{ type: 'text', text: HISTORICAL_MEMORY_PLACEHOLDER }],
            details: {}
          }
        }
        return {
          ...message,
          content: [{ type: 'text', text: JSON.stringify(filtered) }],
          details: {}
        }
      })
      return changed ? { messages } : undefined
    })
    api.on('before_agent_start', async (event) => {
      if (mode === 'off') return undefined
      try {
        const context = await requestL3Context(mode)
        if (!context || !context.text.trim()) return undefined
        console.log(`[agent-host] memory context injected bytes=${Buffer.byteLength(context.text, 'utf8')} needsReview=${context.needsReview}`)
        const base = event.systemPrompt ?? ''
        return { systemPrompt: `${base}\n\n<memory_context>\n${context.text}\n</memory_context>` }
      } catch (error) {
        console.log(`[agent-host] memory context unavailable: ${errorMessage(error)}`)
        return undefined
      }
    })
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validateWorkspace(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RpcError('VALIDATION', '缺少工作区路径')
  }
  const workspace = resolve(value)
  try {
    if (!statSync(workspace).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new RpcError('NO_WORKSPACE', `工作区不存在或不可访问：${workspace}`)
  }
  return workspace
}

function contentToText(content: unknown): { text: string; thinking: string; toolNames: string[] } {
  if (typeof content === 'string') return { text: content, thinking: '', toolNames: [] }
  if (!Array.isArray(content)) return { text: '', thinking: '', toolNames: [] }
  const texts: string[] = []
  const thoughts: string[] = []
  const toolNames: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const typed = part as { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') {
      texts.push(typed.text)
    } else if (typed.type === 'image') {
      texts.push('[图片]')
    } else if (typed.type === 'thinking' && typeof typed.thinking === 'string') {
      thoughts.push(typed.thinking)
    } else if (typed.type === 'toolCall' && typeof typed.name === 'string') {
      toolNames.push(typed.name)
    }
  }
  return { text: texts.join('\n\n'), thinking: thoughts.join('\n\n'), toolNames }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function toMessageUsage(raw: unknown): MessageUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const message = raw as { usage?: unknown; durationMs?: unknown }
  if (!message.usage || typeof message.usage !== 'object') return undefined
  const usage = message.usage as Record<string, unknown>
  const input = finiteNumber(usage.input) ?? 0
  const output = finiteNumber(usage.output) ?? 0
  const cacheRead = finiteNumber(usage.cacheRead) ?? 0
  const cacheWrite = finiteNumber(usage.cacheWrite) ?? 0
  const totalTokens = finiteNumber(usage.totalTokens) ?? input + output + cacheRead + cacheWrite
  const reasoning = finiteNumber(usage.reasoning)
  const durationMs = finiteNumber(message.durationMs)
  if (input + output + cacheRead + cacheWrite + totalTokens === 0 && durationMs === undefined) {
    return undefined
  }
  const result: MessageUsage = { input, output, cacheRead, cacheWrite, totalTokens }
  if (reasoning !== undefined) result.reasoning = reasoning
  if (durationMs !== undefined && durationMs >= 0) result.durationMs = durationMs
  return result
}

function toChatMessage(raw: unknown, id: string): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const message = raw as { role?: unknown; content?: unknown; timestamp?: unknown }
  if (message.role !== 'user' && message.role !== 'assistant') return null
  const { text, thinking, toolNames } = contentToText(message.content)
  if (message.role === 'user' && text === '' && toolNames.length === 0) return null
  const chat: ChatMessage = {
    id,
    role: message.role,
    text,
    timestamp: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
  }
  if (thinking !== '') chat.thinking = thinking
  if (toolNames.length > 0) chat.toolNames = toolNames
  if (message.role === 'assistant') {
    const usage = toMessageUsage(raw)
    if (usage) chat.usage = usage
  }
  return chat
}

function nextAssistantId(): string {
  assistantSeq += 1
  return `live-${Date.now()}-${assistantSeq}`
}

function citationsFromToolResult(result: unknown): MemoryCitation[] {
  if (!result || typeof result !== 'object') return []
  const details = (result as { details?: unknown }).details
  if (!details || typeof details !== 'object') return []
  const record = details as { hits?: unknown; citation?: unknown }
  const citations: MemoryCitation[] = []
  const push = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    const citation = value as MemoryCitation
    if (typeof citation.label !== 'string' || citation.label.trim() === '') return
    const key = `${citation.label}|${citation.sourceId ?? citation.noteId ?? citation.wikiId ?? ''}`
    if (citations.some((item) => `${item.label}|${item.sourceId ?? item.noteId ?? item.wikiId ?? ''}` === key)) {
      return
    }
    citations.push(citation)
  }
  if (Array.isArray(record.hits)) {
    for (const hit of record.hits) {
      if (hit && typeof hit === 'object') push((hit as { citation?: unknown }).citation)
    }
  }
  push(record.citation)
  return citations
}

function handlePiEvent(event: AgentSessionEvent): void {
  switch (event.type) {
    case 'message_start': {
      const message = event.message as { role?: unknown }
      if (message.role === 'assistant') {
        currentAssistantId = nextAssistantId()
        sendEvent({ type: 'assistant-start', id: currentAssistantId })
      }
      break
    }
    case 'message_update': {
      const message = event.message as { role?: unknown }
      if (message.role !== 'assistant') break
      if (!currentAssistantId) {
        currentAssistantId = nextAssistantId()
        sendEvent({ type: 'assistant-start', id: currentAssistantId })
      }
      const update = event.assistantMessageEvent
      if (update.type === 'text_delta') {
        sendEvent({ type: 'text-delta', id: currentAssistantId, delta: update.delta })
      } else if (update.type === 'thinking_delta') {
        sendEvent({ type: 'thinking-delta', id: currentAssistantId, delta: update.delta })
      }
      break
    }
    case 'message_end': {
      const message = event.message as {
        role?: unknown
        stopReason?: unknown
        errorMessage?: unknown
      }
      if (message.role !== 'assistant') break
      const id = currentAssistantId ?? nextAssistantId()
      const chat = toChatMessage(message, id)
      if (chat) sendEvent({ type: 'assistant-message', message: chat })
      // Pi records provider failures (HTTP 4xx/5xx, auth, quota) as an
      // assistant message with stopReason "error" and resolves prompt()
      // normally. Without this branch the UI silently drops the turn.
      if (message.stopReason === 'error' || typeof message.errorMessage === 'string') {
        const raw =
          typeof message.errorMessage === 'string' && message.errorMessage.trim() !== ''
            ? message.errorMessage.trim()
            : '模型请求失败，请检查模型设置与 API Key。'
        const text = raw.length > 1200 ? `${raw.slice(0, 1200)}…` : raw
        sendEvent({ type: 'error', message: text })
      }
      currentAssistantId = null
      break
    }
    case 'tool_execution_start': {
      sendEvent({ type: 'tool-start', toolCallId: event.toolCallId, name: event.toolName })
      break
    }
    case 'tool_execution_end': {
      sendEvent({
        type: 'tool-end',
        toolCallId: event.toolCallId,
        name: event.toolName,
        isError: event.isError,
      })
      if (!event.isError) {
        const citations = citationsFromToolResult(event.result)
        if (citations.length > 0) sendEvent({ type: 'citations', citations })
      }
      break
    }
    default:
      break
  }
}

function disposeCurrent(): void {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  if (current) {
    try {
      current.dispose()
    } catch {
      // Ignore dispose failures; the process is going away or the session is broken.
    }
    current = null
  }
  currentCwd = null
  busy = false
  abortRequested = false
  currentAssistantId = null
}

function requireSession(sessionId: unknown): AgentSession {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new RpcError('VALIDATION', '缺少会话 ID')
  }
  if (!current || current.sessionId !== sessionId) {
    throw new RpcError('SESSION_NOT_FOUND', '会话不存在或已关闭')
  }
  return current
}

async function listSessions(params: { cwd?: unknown }): Promise<SessionSummary[]> {
  const workspace = validateWorkspace(params.cwd)
  const pi = await loadPi()
  const sessions = await pi.SessionManager.list(workspace, sessionDir)
  return sessions
    .map((info) => ({
      id: info.id,
      name: info.name,
      firstMessage: info.firstMessage,
      created: info.created.toISOString(),
      modified: info.modified.toISOString(),
      messageCount: info.messageCount,
    }))
    .sort((a, b) => (a.modified < b.modified ? 1 : -1))
}

function validateMemoryMode(value: unknown): MemoryMode {
  return value === 'rag' || value === 'wiki' || value === 'both' || value === 'off' ? value : 'off'
}

async function openSession(params: {
  cwd?: unknown
  sessionId?: unknown
  memoryMode?: unknown
  l3Content?: unknown
  computerTools?: unknown
}): Promise<OpenSessionResult> {
  if (busy) throw new RpcError('BUSY', '当前会话仍在生成，请先停止')
  const workspace = validateWorkspace(params.cwd)
  const pi = await loadPi()
  const memoryMode = validateMemoryMode(params.memoryMode)

  if (!modelId) throw new RpcError('NO_MODEL', '尚未配置模型，请先填写模型设置')
  const modelRuntime = await loadModelRuntime(pi)
  const model = modelRuntime.getModel(providerId, modelId)
  if (!model) {
    throw new RpcError(
      'NO_MODEL',
      `模型 ${providerId}/${modelId} 不可用，请检查模型设置与 API Key`,
    )
  }

  disposeCurrent()

  let manager: SessionManager
  if (typeof params.sessionId === 'string' && params.sessionId !== '') {
    const path = pi.SessionManager.findById(workspace, params.sessionId, sessionDir)
    if (!path) throw new RpcError('SESSION_NOT_FOUND', '找不到该会话，或会话不属于当前工作区')
    manager = pi.SessionManager.open(path, sessionDir, workspace)
  } else {
    manager = pi.SessionManager.create(workspace, sessionDir)
  }

  let toolset
  try {
    toolset = createWorkspaceToolset(pi, workspace, [
      agentDir,
      sessionDir,
      process.env.OPENFUTURE_MEMORY_DIR ?? '',
      process.env.OPENFUTURE_USER_DATA_DIR ?? ''
    ])
  } catch (error: unknown) {
    throw new RpcError('NO_WORKSPACE', `无法启用工作区安全工具：${errorMessage(error)}`)
  }

  const settingsManager = pi.SettingsManager.create(workspace, agentDir)
  const contextAdapter = memoryMode === 'off' && !params.sessionId
    ? await openContextAdapter(workspace, manager.getSessionId(), model.contextWindow)
    : undefined
  console.log(`[agent-host] open session mode=${memoryMode}`)
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [createLiveMemoryExtension(memoryMode, contextAdapter)]
  })
  await resourceLoader.reload()

  // Read-only by default. PowerShell is a separate, explicit opt-in because
  // it can execute arbitrary commands; the main process injects the flag.
  const memoryTools = createMemoryTools(workspace, memoryMode)
  const computerTools = createComputerTools(
    Array.isArray(params.computerTools) ? (params.computerTools as ComputerToolInfo[]) : []
  )
  const customTools = [...toolset.tools, ...memoryTools, ...computerTools]
  const tools = customTools.map((item) => item.name)
  if (process.env.OPENFUTURE_ALLOW_POWERSHELL === '1') tools.push('powershell')

  if (runtimeApiKey) {
    await modelRuntime.setRuntimeApiKey(providerId, runtimeApiKey)
  }

  const result = await pi.createAgentSession({
    cwd: workspace,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: 'medium',
    tools,
    customTools,
    sessionManager: manager,
    settingsManager,
    resourceLoader,
  })

  current = result.session
  currentCwd = workspace
  unsubscribe = result.session.subscribe(handlePiEvent)

  const messages: ChatMessage[] = []
  let index = 0
  for (const raw of result.session.messages) {
    const chat = toChatMessage(raw, `s-${index}`)
    if (chat) messages.push(chat)
    index += 1
  }

  return {
    sessionId: result.session.sessionId,
    sessionFile: result.session.sessionFile,
    model: `${model.provider}/${model.id}`,
    fallbackMessage: result.modelFallbackMessage,
    messages,
  }
}

async function sendMessage(params: {
  sessionId?: unknown
  text?: unknown
  cwd?: unknown
}): Promise<void> {
  const session = requireSession(params.sessionId)
  if (busy) throw new RpcError('BUSY', '正在生成回复，请先停止')
  const text = typeof params.text === 'string' ? params.text.trim() : ''
  if (text === '') throw new RpcError('VALIDATION', '消息不能为空')
  if (text.length > 100_000) throw new RpcError('VALIDATION', '消息过长')
  if (!currentCwd) throw new RpcError('NO_WORKSPACE', '会话没有工作区')

  busy = true
  abortRequested = false
  currentAssistantId = null
  sendEvent({ type: 'status', state: 'streaming' })

  // Do not await prompt inside the RPC handler: the response must reach the
  // renderer immediately, and events carry the actual progress.
  void session
    .prompt(text, { expandPromptTemplates: false })
    .then(() => {
      const aborted = abortRequested
      busy = false
      sendEvent({ type: 'status', state: aborted ? 'aborted' : 'idle' })
      sendEvent({ type: 'settled', aborted })
    })
    .catch((error: unknown) => {
      busy = false
      if (abortRequested) {
        // A user-initiated stop is not an error. Pi may reject prompt() with
        // "Operation aborted"; keep the partial answer and report neutrally.
        sendEvent({ type: 'status', state: 'aborted' })
        sendEvent({ type: 'settled', aborted: true })
        return
      }
      sendEvent({ type: 'error', message: errorMessage(error) })
      sendEvent({ type: 'status', state: 'idle' })
      sendEvent({ type: 'settled', aborted: false })
    })
}

async function stop(params: { sessionId?: unknown }): Promise<void> {
  const session = requireSession(params.sessionId)
  if (!busy) return
  abortRequested = true
  await session.abort()
}

async function close(params: { sessionId?: unknown }): Promise<void> {
  const session = current
  if (!session) return
  if (typeof params.sessionId === 'string' && params.sessionId !== session.sessionId) return
  if (busy) {
    try {
      await session.abort()
    } catch {
      // Ignore; dispose below still tears the session down.
    }
  }
  disposeCurrent()
}

async function setCredential(params: { providerId?: unknown; apiKey?: unknown }): Promise<void> {
  if (params.providerId !== providerId) {
    throw new RpcError('VALIDATION', '凭证的模型提供方不匹配')
  }
  if (typeof params.apiKey !== 'string' || params.apiKey.trim() === '') {
    throw new RpcError('VALIDATION', 'API Key 不能为空')
  }
  runtimeApiKey = params.apiKey.trim()
  if (modelRuntimePromise) {
    const runtime = await modelRuntimePromise
    await runtime.setRuntimeApiKey(providerId, runtimeApiKey)
  }
}

async function dispatch(method: string, params: unknown): Promise<unknown> {
  const record = (params ?? {}) as Record<string, unknown>
  switch (method) {
    case 'list':
      return listSessions({ cwd: record.cwd })
    case 'open':
      return openSession({
        cwd: record.cwd,
        sessionId: record.sessionId,
        memoryMode: record.memoryMode,
        computerTools: record.computerTools
      })
    case 'send':
      return sendMessage({ sessionId: record.sessionId, text: record.text, cwd: record.cwd })
    case 'stop':
      return stop({ sessionId: record.sessionId })
    case 'close':
      return close({ sessionId: record.sessionId })
    case 'setCredential':
      return setCredential({
        providerId: record.providerId,
        apiKey: record.apiKey
      })
    default:
      throw new RpcError('VALIDATION', `未知的主机方法：${method}`)
  }
}

port.on('message', (event: Electron.MessageEvent) => {
  const incoming = event.data as ContextResponse | RpcRequest | undefined
  if (incoming && incoming.kind === 'context-response' && typeof incoming.id === 'number') {
    const pending = contextPending.get(incoming.id)
    if (!pending) return
    contextPending.delete(incoming.id)
    clearTimeout(pending.timer)
    if (incoming.ok) pending.resolve((incoming.value as L3Context | null) ?? null)
    else pending.reject(new Error(incoming.error?.message || '记忆上下文请求失败'))
    return
  }
  const payload = event.data as RpcRequest | undefined
  if (!payload || payload.kind !== 'request' || typeof payload.id !== 'number') return
  void dispatch(payload.method, payload.params).then(
    (value) => {
      const response: RpcSuccess = { kind: 'response', id: payload.id, ok: true, value }
      send(response)
    },
    (error: unknown) => {
      const code = error instanceof RpcError ? error.code : 'PI_ERROR'
      const response: RpcFailure = {
        kind: 'response',
        id: payload.id,
        ok: false,
        error: { code, message: errorMessage(error) },
      }
      send(response)
    },
  )
})
