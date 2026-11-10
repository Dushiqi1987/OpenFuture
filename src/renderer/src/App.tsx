import { useEffect, useRef, useState } from 'react'
import type {
  AgentStreamEvent,
  ChatMessage,
  MemoryCitation,
  MemoryMode,
  MessageUsage,
  ProjectConversation,
  ProjectInfo,
  ProjectMemoryPreset,
  PublicSettings
} from '../../shared/protocol'
import MemoryPanel from './MemoryPanel'
import SettingsDialog from './SettingsDialog'

interface UiMessage extends ChatMessage {
  thinking?: string
  streaming?: boolean
}

type Theme = 'system' | 'light' | 'dark'

const MEMORY_LABELS: Record<MemoryMode, string> = {
  off: '关闭',
  rag: 'RAG',
  wiki: 'Wiki',
  both: '组合'
}

const PRESET_LABELS: Record<ProjectMemoryPreset, string> = {
  off: '关闭',
  rag: 'RAG 检索',
  wiki: 'Wiki',
  dreaming: 'Dreaming',
  both: '旧组合（高级）'
}

const PRESET_DESCRIPTIONS: Record<ProjectMemoryPreset, string> = {
  off: '不读取项目记忆，也不生成候选。',
  rag: '从证据和笔记中做本地检索，再交给模型。',
  wiki: '只读取已发布的项目 Wiki 页面。',
  dreaming: '允许后台整理记忆，生成待审候选。',
  both: '旧组合策略，仅用于迁移后的项目；新项目请选择单一用途。'
}

const CREATE_PRESETS: ProjectMemoryPreset[] = ['rag', 'wiki', 'dreaming', 'off']

function mergeIncoming(list: UiMessage[], incoming: ChatMessage): UiMessage[] {
  const index = list.findIndex((message) => message.id === incoming.id)
  if (index === -1) return [...list, { ...incoming, streaming: false }]
  const existing = list[index]
  const next = [...list]
  next[index] = {
    ...existing,
    ...incoming,
    thinking: incoming.thinking !== undefined ? incoming.thinking : existing?.thinking,
    streaming: false
  }
  return next
}

interface UsageSummary {
  usage: MessageUsage | null
  promptTokens: number
  contextWindow: number
  contextPercent: number
  speed: number | null
  cachePercent: number | null
}

function summarizeUsage(messages: UiMessage[], configuredWindow: number | undefined): UsageSummary {
  let usage: MessageUsage | null = null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant' && message.usage) {
      usage = message.usage
      break
    }
  }
  const contextWindow =
    configuredWindow !== undefined && Number.isFinite(configuredWindow) && configuredWindow > 0
      ? configuredWindow
      : 128_000
  if (!usage) {
    return { usage: null, promptTokens: 0, contextWindow, contextPercent: 0, speed: null, cachePercent: null }
  }
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite
  const contextPercent = contextWindow > 0 ? (promptTokens / contextWindow) * 100 : 0
  const speed =
    usage.durationMs !== undefined && usage.durationMs > 0
      ? usage.output / (usage.durationMs / 1000)
      : null
  const cachePercent = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : null
  return { usage, promptTokens, contextWindow, contextPercent, speed, cachePercent }
}

function compactTokens(value: number): string {
  if (value >= 1_000_000) {
    const scaled = value / 1_000_000
    return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}M`
  }
  if (value >= 1_000) {
    const scaled = value / 1_000
    return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}K`
  }
  return String(Math.max(0, Math.round(value)))
}

function percentLabel(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  if (value > 0 && value < 0.1) return '<0.1%'
  return `${value.toFixed(1)}%`
}

interface AssistantTurn {
  id: string
  messages: UiMessage[]
  timestamp: number
  streaming: boolean
  text: string
  finalIndex: number
  citations: MemoryCitation[]
}

type ChatItem =
  | { kind: 'user'; message: UiMessage }
  | { kind: 'assistant'; turn: AssistantTurn }

function citationKey(citation: MemoryCitation): string {
  return `${citation.label}|${citation.sourceId ?? citation.noteId ?? citation.wikiId ?? ''}`
}

function buildAssistantTurn(messages: UiMessage[]): AssistantTurn {
  let finalIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.text.trim()) {
      finalIndex = index
      break
    }
  }
  const citations: MemoryCitation[] = []
  for (const message of messages) {
    for (const citation of message.citations ?? []) {
      if (!citations.some((item) => citationKey(item) === citationKey(citation))) {
        citations.push(citation)
      }
    }
  }
  return {
    id: messages[0]?.id ?? 'assistant',
    messages,
    timestamp: messages[0]?.timestamp ?? Date.now(),
    streaming: messages.some((message) => message.streaming),
    text: finalIndex >= 0 ? messages[finalIndex]?.text ?? '' : '',
    finalIndex,
    citations
  }
}

function buildChatItems(messages: UiMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index]
    if (!message) break
    if (message.role !== 'assistant') {
      items.push({ kind: 'user', message })
      index += 1
      continue
    }
    const turnMessages: UiMessage[] = []
    while (index < messages.length) {
      const next = messages[index]
      if (!next || next.role !== 'assistant') break
      turnMessages.push(next)
      index += 1
    }
    items.push({ kind: 'assistant', turn: buildAssistantTurn(turnMessages) })
  }
  return items
}

function basename(path: string): string {
  const normalized = path.replace(/[\\\\/]+$/, '')
  const parts = normalized.split(/[\\\\/]/)
  return parts[parts.length - 1] || normalized
}

function shortTime(value: number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function AssistantTurnView({
  turn,
  activeTool,
  live
}: {
  turn: AssistantTurn
  activeTool: string | null
  live: boolean
}): React.JSX.Element {
  const streaming = live || turn.streaming
  const hasChain =
    streaming ||
    Boolean(activeTool) ||
    turn.messages.some(
      (message, index) =>
        Boolean(message.thinking?.trim()) ||
        Boolean(message.toolNames?.length) ||
        (index !== turn.finalIndex && Boolean(message.text.trim()))
    )
  const stepCount =
    turn.messages.filter((message) => message.thinking?.trim() || message.toolNames?.length).length +
    (streaming && activeTool ? 1 : 0)
  const showTyping = streaming && !turn.text && !hasChain
  const chainRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const rail = chainRef.current
    if (!rail || !streaming) return
    rail.scrollTop = rail.scrollHeight
  }, [streaming, turn.messages, activeTool])

  return (
    <article className={`message assistant agent-turn${streaming ? ' streaming' : ''}`}>
      <div className="avatar">OF</div>
      <div className="message-body">
        <div className="agent-turn-head">
          <span className="agent-name">OpenFuture</span>
          <span className="agent-time">{shortTime(turn.timestamp)}</span>
          {streaming ? <span className="agent-state">生成中</span> : null}
        </div>
        {hasChain ? (
          <div className="agent-chain" aria-live={streaming ? 'polite' : undefined}>
            <div className="agent-chain-head">
              <span className={`chain-status${streaming ? ' live' : ''}`} aria-hidden />
              <span>{streaming ? '正在思考 / 调用工具' : '思考与工具'}</span>
              <span className="chain-count">{stepCount} 步</span>
            </div>
            <div className="chain-rail" ref={chainRef}>
              {turn.messages.map((message, index) => {
                const thinking = message.thinking?.trim()
                const tools = message.toolNames ?? []
                const note = index !== turn.finalIndex ? message.text.trim() : ''
                if (!thinking && tools.length === 0 && !note) return null
                return (
                  <div className="chain-step" key={`${turn.id}-step-${index}`}>
                    <span className={`chain-node${message.streaming ? ' live' : ''}`} aria-hidden />
                    <div className="chain-content">
                      {thinking ? <pre className="chain-thought">{message.thinking}</pre> : null}
                      {note ? <div className="chain-note">{note}</div> : null}
                      {tools.length > 0 ? (
                        <div className="chain-tools">
                          {tools.map((name, toolIndex) => (
                            <span className="chain-tool" key={`${turn.id}-${index}-${name}-${toolIndex}`}>
                              <span className="chain-tool-icon" aria-hidden>
                                ▸
                              </span>
                              {name}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              })}
              {streaming && activeTool ? (
                <div className="chain-step">
                  <span className="chain-node live" aria-hidden />
                  <div className="chain-content">
                    <div className="chain-tool live">
                      <span className="chain-spinner" aria-hidden /> 正在调用 {activeTool}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {turn.text ? (
          <div className="message-text">
            {turn.text}
            {streaming ? <span className="caret" /> : null}
          </div>
        ) : showTyping ? (
          <div className="message-text typing">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </div>
        ) : null}
        {turn.citations.length > 0 ? (
          <div className="citation-list">
            <div className="citation-heading">引用来源</div>
            {turn.citations.map((citation, index) => (
              <div className="citation-item" key={`${turn.id}-cite-${index}`}>
                <span className="citation-dot">◆</span>
                <span className="citation-label">{citation.label}</span>
                {citation.origin ? <span className="citation-origin">{citation.origin}</span> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  )
}

function projectMode(preset: ProjectMemoryPreset): MemoryMode {
  if (preset === 'off') return 'off'
  if (preset === 'rag') return 'rag'
  if (preset === 'wiki') return 'wiki'
  return 'both'
}

interface RailButtonProps {
  icon: string
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}

function RailButton({ icon, label, active = false, disabled = false, onClick }: RailButtonProps): React.JSX.Element {
  const [show, setShow] = useState(false)
  const timer = useRef<number | null>(null)

  const open = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setShow(true), 350)
  }
  const close = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    setShow(false)
  }

  useEffect(() => {
    if (!show) return undefined
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [show])

  return (
    <div className="rail-slot">
      <button
        type="button"
        className={`rail-button${active ? ' active' : ''}`}
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close()
        }}
      >
        <span aria-hidden="true">{icon}</span>
      </button>
      {show ? <span className="rail-tooltip" role="tooltip">{label}</span> : null}
    </div>
  )
}

export default function App(): React.JSX.Element {
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [convMap, setConvMap] = useState<Record<string, ProjectConversation[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [activeTool, setActiveTool] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [logsOnce, setLogsOnce] = useState(false)
  const [theme, setTheme] = useState<Theme>('system')
  const [themeOpen, setThemeOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [newProject, setNewProject] = useState<{
    name: string
    path: string
    preset: ProjectMemoryPreset
    defaultModelRef: string
  }>({
    name: '',
    path: '',
    preset: 'off',
    defaultModelRef: ''
  })
  const [creating, setCreating] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const sessionRef = useRef<string | null>(null)
  const assistantRef = useRef<string | null>(null)
  const activeProjectRef = useRef<string | null>(null)
  const activeConversationRef = useRef<string | null>(null)
  const draftRef = useRef('')
  const endRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null
  const conversations = activeProjectId ? convMap[activeProjectId] ?? [] : []
  const activeConversation =
    conversations.find((conversation) => conversation.id === activeConversationId) ?? null
  const modelName = settings?.model?.displayName || settings?.model?.modelId || '未配置模型'

  useEffect(() => {
    sessionRef.current = currentSessionId
  }, [currentSessionId])

  useEffect(() => {
    activeProjectRef.current = activeProjectId
  }, [activeProjectId])

  useEffect(() => {
    activeConversationRef.current = activeConversationId
  }, [activeConversationId])

  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  useEffect(() => {
    const stored = window.localStorage.getItem('openfuture-theme')
    if (stored === 'light' || stored === 'dark' || stored === 'system') setTheme(stored)
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
      document.documentElement.dataset.theme = resolved
      document.documentElement.style.colorScheme = resolved
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  useEffect(() => {
    window.localStorage.setItem('openfuture-theme', theme)
  }, [theme])

  useEffect(() => {
    void (async () => {
      try {
        const settingsResult = await window.openfuture.getSettings()
        if (settingsResult.ok) setSettings(settingsResult.value)
        else setError(settingsResult.error.message)

        const listResult = await window.openfuture.listProjects()
        if (!listResult.ok) {
          setError(listResult.error.message)
          return
        }
        setProjects(listResult.value.projects)
        const activeId = listResult.value.activeProjectId
        setActiveProjectId(activeId)
        if (activeId) {
          setExpanded((previous) => new Set(previous).add(activeId))
          await loadConversations(activeId)
          const project = listResult.value.projects.find((item) => item.id === activeId)
          if (project && project.available) {
            const conversationsResult = await window.openfuture.listConversations(activeId)
            if (conversationsResult.ok) {
              const list = conversationsResult.value.conversations
              setConvMap((previous) => ({ ...previous, [activeId]: list }))
              const preferred =
                list.find((item) => item.id === project.lastConversationId) ?? list[0] ?? null
              if (preferred) await openConversationFor(project, preferred)
            }
          }
        }
        if (listResult.value.migrationNotice) setNotice(listResult.value.migrationNotice)
      } catch (bootstrapError) {
        setError(
          bootstrapError instanceof Error
            ? `项目初始化失败：${bootstrapError.message}`
            : '项目初始化失败'
        )
      } finally {
        setLoaded(true)
      }
    })()
    // Bootstrap runs once; openConversationFor reads the project passed in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const unsubscribe = window.openfuture.onAgentEvent(({ sessionId, event }) => {
      if (sessionRef.current !== sessionId) return
      applyEvent(event)
    })
    return unsubscribe
    // applyEvent is stable for the lifetime of the window; it reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const unsubscribe = window.openfuture.onHostLog((line) => {
      setLogs((previous) => {
        const next = [...previous, line]
        return next.length > 300 ? next.slice(next.length - 300) : next
      })
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, busy, activeTool])

  useEffect(() => {
    if (!activeProjectId || !activeConversationId) return
    const timer = window.setTimeout(() => {
      const text = draftRef.current
      setConvMap((previous) => {
        const list = previous[activeProjectId] ?? []
        return {
          ...previous,
          [activeProjectId]: list.map((item) =>
            item.id === activeConversationId ? { ...item, draft: text, updatedAt: Date.now() } : item
          )
        }
      })
      void window.openfuture.updateConversation({
        projectId: activeProjectId,
        conversationId: activeConversationId,
        draft: text
      })
    }, 500)
    return () => window.clearTimeout(timer)
  }, [draft, activeProjectId, activeConversationId])

  function applyEvent(event: AgentStreamEvent): void {
    switch (event.type) {
      case 'status':
        setBusy(event.state === 'streaming')
        if (event.state === 'aborted') {
          setError(null)
          setNotice('已停止')
        }
        if (event.state !== 'streaming') setActiveTool(null)
        break
      case 'assistant-start':
        assistantRef.current = event.id
        setMessages((previous) =>
          previous.some((message) => message.id === event.id)
            ? previous
            : [
                ...previous,
                {
                  id: event.id,
                  role: 'assistant',
                  text: '',
                  timestamp: Date.now(),
                  streaming: true
                }
              ]
        )
        break
      case 'text-delta':
        setMessages((previous) =>
          previous.map((message) =>
            message.id === event.id ? { ...message, text: message.text + event.delta } : message
          )
        )
        break
      case 'thinking-delta':
        setMessages((previous) =>
          previous.map((message) =>
            message.id === event.id
              ? { ...message, thinking: `${message.thinking ?? ''}${event.delta}` }
              : message
          )
        )
        break
      case 'assistant-message':
        setMessages((previous) => mergeIncoming(previous, event.message))
        break
      case 'tool-start':
        setActiveTool(event.name)
        break
      case 'tool-end':
        setActiveTool(null)
        break
      case 'citations': {
        const target = assistantRef.current
        if (!target) break
        setMessages((previous) =>
          previous.map((message) => {
            if (message.id !== target) return message
            const merged: MemoryCitation[] = [...(message.citations ?? [])]
            for (const citation of event.citations) {
              const key = `${citation.label}|${citation.sourceId ?? citation.noteId ?? citation.wikiId ?? ''}`
              if (
                !merged.some(
                  (item) =>
                    `${item.label}|${item.sourceId ?? item.noteId ?? item.wikiId ?? ''}` === key
                )
              ) {
                merged.push(citation)
              }
            }
            return { ...message, citations: merged }
          })
        )
        break
      }
      case 'error':
        setError(event.message)
        setBusy(false)
        setActiveTool(null)
        break
      case 'settled':
        assistantRef.current = null
        setBusy(false)
        setActiveTool(null)
        setMessages((previous) =>
          previous
            .filter((message) => {
              const emptyAssistant =
                message.role === 'assistant' &&
                !message.text &&
                !message.thinking &&
                (!message.toolNames || message.toolNames.length === 0)
              return !emptyAssistant
            })
            .map((message) => (message.streaming ? { ...message, streaming: false } : message))
        )
        if (activeProjectRef.current) void loadConversations(activeProjectRef.current)
        break
      default:
        break
    }
  }

  async function loadConversations(projectId: string): Promise<void> {
    const result = await window.openfuture.listConversations(projectId)
    if (!result.ok) return
    setConvMap((previous) => ({ ...previous, [projectId]: result.value.conversations }))
  }

  async function persistDraftNow(): Promise<void> {
    const projectId = activeProjectRef.current
    const conversationId = activeConversationRef.current
    if (!projectId || !conversationId) return
    const result = await window.openfuture.updateConversation({
      projectId,
      conversationId,
      draft: draftRef.current
    })
    if (result.ok) {
      setConvMap((previous) => ({
        ...previous,
        [projectId]: (previous[projectId] ?? []).map((item) =>
          item.id === conversationId ? result.value : item
        )
      }))
    }
  }

  async function openConversationFor(
    project: ProjectInfo,
    conversation: ProjectConversation
  ): Promise<boolean> {
    if (busy) {
      setNotice('当前仍在生成，请先停止再切换对话。')
      return false
    }
    if (activeConversationRef.current && activeConversationRef.current !== conversation.id) {
      await persistDraftNow()
    }
    setActiveProjectId(project.id)
    setActiveConversationId(conversation.id)
    setDraft(conversation.draft ?? '')
    setMessages([])
    setCurrentSessionId(null)
    setBusy(false)
    setActiveTool(null)
    setError(null)

    if (!conversation.piSessionId) {
      // Drafts stay local until the first send, so a project and empty
      // conversation can exist before a model or key is configured.
      return true
    }

    const result = await window.openfuture.openConversation({
      projectId: project.id,
      conversationId: conversation.id
    })
    if (!result.ok) {
      setError(result.error.message)
      return false
    }
    if (!result.value.sessionId) {
      return true
    }
    sessionRef.current = result.value.sessionId
    setCurrentSessionId(result.value.sessionId)
    setMessages(result.value.messages.map((message) => ({ ...message, streaming: false })))
    if (result.value.fallbackMessage) setNotice(result.value.fallbackMessage)
    return true
  }

  async function selectProject(projectId: string, conversationId?: string): Promise<void> {
    if (busy) {
      setNotice('请先停止当前生成，再切换项目。')
      return
    }
    await persistDraftNow()
    setMenuProjectId(null)
    const result = await window.openfuture.selectProject(projectId)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setProjects((previous) =>
      previous.map((project) => (project.id === projectId ? result.value.project : project))
    )
    setActiveProjectId(projectId)
    setExpanded((previous) => new Set(previous).add(projectId))
    setConvMap((previous) => ({ ...previous, [projectId]: result.value.conversations }))
    const target =
      result.value.conversations.find((item) => item.id === conversationId) ??
      result.value.conversations.find((item) => item.id === result.value.project.lastConversationId) ??
      result.value.conversations[0] ??
      null
    if (target) {
      await openConversationFor(result.value.project, target)
    } else {
      setActiveConversationId(null)
      setCurrentSessionId(null)
      setMessages([])
      setDraft('')
      setError(null)
    }
  }

  async function selectConversation(project: ProjectInfo, conversation: ProjectConversation): Promise<void> {
    if (activeProjectId !== project.id) {
      await selectProject(project.id, conversation.id)
      return
    }
    await openConversationFor(project, conversation)
  }

  async function createConversation(projectId: string): Promise<void> {
    if (busy) {
      setNotice('请先停止当前生成，再新建对话。')
      return
    }
    await persistDraftNow()
    const result = await window.openfuture.createConversation({ projectId })
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setConvMap((previous) => ({ ...previous, [projectId]: [result.value, ...(previous[projectId] ?? [])] }))
    setExpanded((previous) => new Set(previous).add(projectId))
    setActiveProjectId(projectId)
    setActiveConversationId(result.value.id)
    setCurrentSessionId(null)
    sessionRef.current = null
    setMessages([])
    setDraft('')
    setError(null)
    setMenuProjectId(null)
    window.setTimeout(() => textareaRef.current?.focus(), 0)
  }

  async function handleSend(): Promise<void> {
    const text = draft.trim()
    if (!text || busy) return
    const project = activeProject
    if (!project) {
      setError('请先创建或选择一个项目')
      return
    }
    if (!project.available) {
      setError('项目目录不可用，请先重新定位目录')
      return
    }
    if (!settings?.apiKeyConfigured) {
      setError('尚未配置可用的 API Key，请先在「模型与密钥」中填写。')
      setSettingsOpen(true)
      return
    }

    let conversation = activeConversation
    if (!conversation) {
      const created = await window.openfuture.createConversation({ projectId: project.id })
      if (!created.ok) {
        setError(created.error.message)
        return
      }
      conversation = created.value
      setConvMap((previous) => ({
        ...previous,
        [project.id]: [created.value, ...(previous[project.id] ?? [])]
      }))
      setActiveConversationId(created.value.id)
    }

    let sessionId = currentSessionId
    if (!sessionId) {
      const opened = await window.openfuture.openConversation({
        projectId: project.id,
        conversationId: conversation.id
      })
      if (!opened.ok) {
        setError(opened.error.message)
        return
      }
      if (!opened.value.sessionId) {
        setError('尚未配置可用模型，无法发送消息。请先完成「模型与密钥」配置。')
        setSettingsOpen(true)
        return
      }
      sessionId = opened.value.sessionId
      sessionRef.current = sessionId
      setCurrentSessionId(sessionId)
      if (opened.value.messages.length > 0) {
        setMessages(opened.value.messages.map((message) => ({ ...message, streaming: false })))
      }
      setConvMap((previous) => ({
        ...previous,
        [project.id]: (previous[project.id] ?? []).map((item) =>
          item.id === conversation?.id ? { ...item, piSessionId: sessionId ?? undefined } : item
        )
      }))
    }

    const optimisticId = `u-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setDraft('')
    setError(null)
    setNotice(null)
    setMessages((previous) => [
      ...previous,
      { id: optimisticId, role: 'user', text, timestamp: Date.now() }
    ])
    setBusy(true)

    if (
      conversation &&
      (conversation.title === '新对话' || /^对话\s+[0-9a-f]{8}$/i.test(conversation.title))
    ) {
      const title = text.replace(/\s+/g, ' ').trim().slice(0, 48)
      const updated = await window.openfuture.updateConversation({
        projectId: project.id,
        conversationId: conversation.id,
        title
      })
      if (updated.ok) {
        setConvMap((previous) => ({
          ...previous,
          [project.id]: (previous[project.id] ?? []).map((item) =>
            item.id === updated.value.id ? updated.value : item
          )
        }))
      }
    }

    const result = await window.openfuture.sendMessage(text)
    if (!result.ok) {
      setMessages((previous) => previous.filter((message) => message.id !== optimisticId))
      setDraft((current) => (current.trim().length === 0 ? text : current))
      setError(result.error.message)
      setBusy(false)
    }
  }

  async function handleStop(): Promise<void> {
    const result = await window.openfuture.stop()
    if (!result.ok) setError(result.error.message)
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void handleSend()
    }
  }

  async function chooseFolder(): Promise<void> {
    const result = await window.openfuture.chooseProjectFolder()
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    if (!result.value) return
    setNewProject((previous) => ({
      ...previous,
      path: result.value as string,
      name: previous.name.trim() ? previous.name : basename(result.value as string)
    }))
  }

  async function submitProject(): Promise<void> {
    if (!newProject.path.trim()) {
      setError('请选择项目工作区目录')
      return
    }
    if (!newProject.name.trim()) {
      setError('请填写项目名称')
      return
    }
    setCreating(true)
    setError(null)
    const result = await window.openfuture.createProject({
      name: newProject.name.trim(),
      rootPath: newProject.path,
      memoryPreset: newProject.preset,
      defaultModelRef: newProject.defaultModelRef || null
    })
    setCreating(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    const project = result.value.project
    const list = await window.openfuture.listProjects()
    if (list.ok) setProjects(list.value.projects)
    else setProjects((previous) => [...previous.filter((item) => item.id !== project.id), project])
    setActiveProjectId(project.id)
    setExpanded((previous) => new Set(previous).add(project.id))
    const conversations = await window.openfuture.listConversations(project.id)
    setConvMap((previous) => ({
      ...previous,
      [project.id]: conversations.ok ? conversations.value.conversations : []
    }))
    setActiveConversationId(null)
    setCurrentSessionId(null)
    sessionRef.current = null
    setMessages([])
    setDraft('')
    setCreateOpen(false)
    setNewProject({ name: '', path: '', preset: 'off', defaultModelRef: '' })
    setNotice(
      list.ok && list.value.migrationNotice
        ? list.value.migrationNotice
        : `项目「${project.name}」已就绪。点击 ＋ 新建对话。`
    )
  }

  async function renameProject(project: ProjectInfo): Promise<void> {
    const name = window.prompt('重命名项目', project.name)
    if (name === null) return
    if (!name.trim()) {
      setError('项目名称不能为空')
      return
    }
    const result = await window.openfuture.renameProject({ projectId: project.id, name: name.trim() })
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setProjects((previous) =>
      previous.map((item) => (item.id === project.id ? result.value : item))
    )
    setMenuProjectId(null)
  }

  async function archiveProject(project: ProjectInfo): Promise<void> {
    if (!window.confirm(`归档项目「${project.name}」？源目录和会话记录不会被删除。`)) return
    await persistDraftNow()
    const result = await window.openfuture.archiveProject({ projectId: project.id, archived: true })
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setMenuProjectId(null)
    const listResult = await window.openfuture.listProjects()
    if (listResult.ok) {
      setProjects(listResult.value.projects)
      const nextId = listResult.value.activeProjectId
      setActiveProjectId(nextId)
      if (nextId) {
        setExpanded((previous) => new Set(previous).add(nextId))
        await loadConversations(nextId)
        const projectNext = listResult.value.projects.find((item) => item.id === nextId)
        if (projectNext) {
          const nextConversations = await window.openfuture.listConversations(nextId)
          if (nextConversations.ok) {
            setConvMap((previous) => ({ ...previous, [nextId]: nextConversations.value.conversations }))
            const target =
              nextConversations.value.conversations.find(
                (item) => item.id === projectNext.lastConversationId
              ) ?? nextConversations.value.conversations[0]
            if (target) await openConversationFor(projectNext, target)
          }
        }
      } else {
        setActiveConversationId(null)
        setCurrentSessionId(null)
        setMessages([])
        setDraft('')
      }
    }
    setNotice('项目已归档；可在项目列表中恢复。')
  }

  async function restoreProject(project: ProjectInfo): Promise<void> {
    const result = await window.openfuture.archiveProject({ projectId: project.id, archived: false })
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setProjects((previous) =>
      previous.map((item) => (item.id === project.id ? result.value : item))
    )
    setMenuProjectId(null)
    setNotice('项目已恢复。')
  }

  async function relocateProject(project: ProjectInfo): Promise<void> {
    const result = await window.openfuture.relocateProject(project.id)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setProjects((previous) =>
      previous.map((item) => (item.id === project.id ? result.value : item))
    )
    setMenuProjectId(null)
    if (result.value.available) {
      await selectProject(project.id)
    }
    setNotice('项目目录已重新定位。')
  }

  async function revealProject(project: ProjectInfo): Promise<void> {
    const result = await window.openfuture.revealProject(project.id)
    if (!result.ok) setError(result.error.message)
    setMenuProjectId(null)
  }

  async function toggleProject(project: ProjectInfo): Promise<void> {
    const next = new Set(expanded)
    if (next.has(project.id)) next.delete(project.id)
    else {
      next.add(project.id)
      if (!convMap[project.id]) await loadConversations(project.id)
    }
    setExpanded(next)
  }

  function resetHostSession(): void {
    setCurrentSessionId(null)
    sessionRef.current = null
    assistantRef.current = null
    setBusy(false)
    setActiveTool(null)
  }

  const canSend = Boolean(activeProject?.available) && !busy && draft.trim().length > 0
  const title = activeConversation?.title ?? (activeProject ? '新建对话' : 'OpenFuture')
  const chatItems = buildChatItems(messages)
  const usage = summarizeUsage(messages, settings?.model?.contextWindow)
  let liveTurnId: string | null = null
  if (busy) {
    const lastItem = chatItems[chatItems.length - 1]
    if (lastItem?.kind === 'assistant') liveTurnId = lastItem.turn.id
  }
  const filteredProjects = projects.filter((project) => {
    if (!searchText.trim()) return true
    const needle = searchText.trim().toLowerCase()
    if (project.name.toLowerCase().includes(needle)) return true
    return (convMap[project.id] ?? []).some((conversation) =>
      conversation.title.toLowerCase().includes(needle)
    )
  })

  if (!loaded) return <div className="fatal-screen">正在加载 OpenFuture…</div>

  return (
    <div className="app-shell v2-shell">
      <aside className="rail" aria-label="主导航">
        <div className="rail-logo" title="OpenFuture">OF</div>
        <RailButton icon="▦" label="项目" active onClick={() => setSearchOpen(false)} />
        <RailButton
          icon="⌕"
          label="搜索对话"
          active={searchOpen}
          onClick={() => {
            setSearchOpen((value) => !value)
            window.setTimeout(() => searchRef.current?.focus(), 0)
          }}
        />
        <RailButton icon="◫" label="项目记忆" active={memoryOpen} onClick={() => setMemoryOpen(true)} />
        <div className="rail-spacer" />
        <div className="rail-theme-wrap">
          <RailButton
            icon={theme === 'light' ? '☀' : theme === 'dark' ? '☾' : '◐'}
            label={`主题：${theme === 'system' ? '跟随系统' : theme === 'light' ? '浅色' : '深色'}`}
            active={themeOpen}
            onClick={() => setThemeOpen((value) => !value)}
          />
          {themeOpen ? (
            <div className="rail-popover" role="menu">
              {(
                [
                  ['system', '跟随系统'],
                  ['light', '浅色'],
                  ['dark', '深色']
                ] as Array<[Theme, string]>
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  className={theme === value ? 'active' : ''}
                  onClick={() => {
                    setTheme(value)
                    setThemeOpen(false)
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <RailButton icon="⚙" label="设置" active={settingsOpen} onClick={() => setSettingsOpen(true)} />
      </aside>

      <aside className="project-pane">
        <div className="project-pane-header">
          <div>
            <div className="project-pane-kicker">OPENFUTURE</div>
            <div className="project-pane-title">项目</div>
          </div>
          <button
            type="button"
            className="project-add"
            title="新建项目"
            aria-label="新建项目"
            onClick={() => {
              setNewProject({ name: '', path: '', preset: 'off', defaultModelRef: '' })
              setCreateOpen(true)
            }}
          >
            ＋
          </button>
        </div>

        {searchOpen ? (
          <div className="tree-search">
            <input
              ref={searchRef}
              value={searchText}
              placeholder="搜索项目或对话"
              onChange={(event) => setSearchText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setSearchOpen(false)
                  setSearchText('')
                }
              }}
            />
            <button
              type="button"
              aria-label="清除搜索"
              onClick={() => {
                setSearchText('')
                setSearchOpen(false)
              }}
            >
              ×
            </button>
          </div>
        ) : null}

        <div className="project-list">
          {filteredProjects.length === 0 ? (
            <div className="project-empty">
              <div className="project-empty-mark">▦</div>
              <p>{searchText ? '没有匹配的项目或对话。' : '还没有项目。'}</p>
              {!searchText ? (
                <button type="button" className="text-button" onClick={() => setCreateOpen(true)}>
                  选择文件夹，创建第一个项目
                </button>
              ) : null}
            </div>
          ) : (
            filteredProjects.map((project) => {
              const projectConversations = (convMap[project.id] ?? []).filter((conversation) =>
                searchText.trim()
                  ? conversation.title.toLowerCase().includes(searchText.trim().toLowerCase())
                  : true
              )
              const isOpen = expanded.has(project.id)
              const isActive = project.id === activeProjectId
              return (
                <div className={`project-group${isActive ? ' active' : ''}`} key={project.id}>
                  <div className="project-row">
                    <button
                      type="button"
                      className="project-chevron"
                      aria-label={isOpen ? '折叠项目' : '展开项目'}
                      aria-expanded={isOpen}
                      onClick={() => void toggleProject(project)}
                    >
                      {isOpen ? '⌄' : '›'}
                    </button>
                    <button
                      type="button"
                      className="project-main"
                      title={project.canonicalRoot}
                      onClick={() => void selectProject(project.id)}
                    >
                      <span className={`project-dot${project.available ? '' : ' missing'}`} />
                      <span className="project-name">{project.name}</span>
                      {project.archivedAt ? <span className="project-badge">已归档</span> : null}
                      {!project.available ? <span className="project-badge warn">目录不可用</span> : null}
                    </button>
                    <div className="project-actions">
                      <button
                        type="button"
                        className="icon-button"
                        title="新建对话"
                        aria-label={`在 ${project.name} 中新建对话`}
                        disabled={!project.available || Boolean(project.archivedAt)}
                        onClick={() => void createConversation(project.id)}
                      >
                        ＋
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        title="项目菜单"
                        aria-label={`${project.name} 的项目菜单`}
                        onClick={() => setMenuProjectId(menuProjectId === project.id ? null : project.id)}
                      >
                        ⋯
                      </button>
                    </div>
                    {menuProjectId === project.id ? (
                      <div className="project-menu" role="menu">
                        <button type="button" onClick={() => void renameProject(project)}>
                          重命名
                        </button>
                        <button type="button" onClick={() => void revealProject(project)}>
                          打开文件夹
                        </button>
                        <button type="button" onClick={() => void relocateProject(project)}>
                          重新定位目录
                        </button>
                        {project.archivedAt ? (
                          <button type="button" onClick={() => void restoreProject(project)}>
                            恢复项目
                          </button>
                        ) : (
                          <button type="button" className="danger" onClick={() => void archiveProject(project)}>
                            归档项目
                          </button>
                        )}
                      </div>
                    ) : null}
                  </div>

                  {isOpen ? (
                    <div className="conversation-list">
                      {projectConversations.length === 0 ? (
                        <button
                          type="button"
                          className="conversation-new"
                          disabled={!project.available || Boolean(project.archivedAt)}
                          onClick={() => void createConversation(project.id)}
                        >
                          ＋ 新建对话
                        </button>
                      ) : (
                        <>
                          {projectConversations.map((conversation) => (
                            <button
                              type="button"
                              key={conversation.id}
                              className={`conversation-row${
                                isActive && conversation.id === activeConversationId ? ' active' : ''
                              }`}
                              onClick={() => void selectConversation(project, conversation)}
                              title={conversation.title}
                            >
                              <span className="conversation-title">{conversation.title}</span>
                              <span className="conversation-time">{shortTime(conversation.updatedAt)}</span>
                            </button>
                          ))}
                          <button
                            type="button"
                            className="conversation-new subtle"
                            disabled={!project.available || Boolean(project.archivedAt)}
                            onClick={() => void createConversation(project.id)}
                          >
                            ＋ 新建对话
                          </button>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              )
            })
          )}
        </div>

        <div className="project-pane-footer">
          <button type="button" className="footer-link" onClick={() => setMemoryOpen(true)}>
            <span>◫</span> 项目记忆
            {activeProject ? <em>{PRESET_LABELS[activeProject.memoryPreset]}</em> : null}
          </button>
          <button type="button" className="footer-link" onClick={() => setLogsOpen(true)}>
            <span>▤</span> 诊断日志
            {logsOnce ? <i className="tiny-dot" /> : null}
          </button>
          <div className="version-line">v{settings?.appVersion ?? '0.2.0'} · 项目</div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="main-header v2-header">
          <div className="main-title-wrap">
            <div className="main-project-name">{activeProject?.name ?? '未选择项目'}</div>
            <div className="main-title" title={title}>
              {title}
            </div>
          </div>
          <div className="main-header-right">
            {activeProject ? (
              <button
                type="button"
                className={`model-chip memory-chip${projectMode(activeProject.memoryPreset) !== 'off' ? ' on' : ''}`}
                title="打开项目记忆"
                onClick={() => setMemoryOpen(true)}
              >
                记忆 {PRESET_LABELS[activeProject.memoryPreset]}
              </button>
            ) : null}
            <span className="model-chip" title={settings?.model?.baseUrl ?? ''}>
              {modelName}
            </span>
            <span className={`status-dot ${busy ? 'busy' : currentSessionId ? 'ready' : 'idle'}`} />
            <span className="status-text">
              {busy ? '生成中' : currentSessionId ? '就绪' : activeProject ? '草稿' : '未选择项目'}
            </span>
          </div>
        </header>

        {error ? (
          <div className="banner error-banner">
            <span>{error}</span>
            <button type="button" className="banner-close" onClick={() => setError(null)}>
              ×
            </button>
          </div>
        ) : null}
        {notice ? (
          <div className="banner notice-banner">
            <span>{notice}</span>
            <button type="button" className="banner-close" onClick={() => setNotice(null)}>
              ×
            </button>
          </div>
        ) : null}
        {settings?.credentialState === 'needs-rebind' ? (
          <div className="banner error-banner">
            <span>API Key 与当前端点未绑定，或旧版凭证需要重新录入。</span>
            <button type="button" className="banner-action" onClick={() => setSettingsOpen(true)}>
              重新配置
            </button>
          </div>
        ) : null}
        {activeProject && !activeProject.available ? (
          <div className="banner error-banner">
            <span>项目目录不可用。历史和草稿仍在，工具与对话已暂停。</span>
            <button type="button" className="banner-action" onClick={() => void relocateProject(activeProject)}>
              重新定位
            </button>
          </div>
        ) : null}

        <div className="chat-scroll">
          {!activeProject ? (
            <div className="empty-state v2-empty">
              <div className="empty-mark">▦</div>
              <h1>从文件夹开始一个项目</h1>
              <p>每个项目绑定一个本地目录，拥有独立的对话、草稿和项目记忆。</p>
              <button type="button" className="primary-button" onClick={() => setCreateOpen(true)}>
                新建项目
              </button>
            </div>
          ) : messages.length === 0 ? (
            <div className="empty-state v2-empty">
              <div className="empty-mark">◈</div>
              <h1>{activeProject.name}</h1>
              <p className="project-path-line" title={activeProject.canonicalRoot}>
                {activeProject.canonicalRoot}
              </p>
              <p>
                策略：{PRESET_LABELS[activeProject.memoryPreset]} · 对话归属当前项目
                <br />
                对话历史保存在本机；工具只读，除非显式开启 PowerShell。
              </p>
              <button
                type="button"
                className="primary-button"
                disabled={!activeProject.available}
                onClick={() => void createConversation(activeProject.id)}
              >
                新建对话
              </button>
            </div>
          ) : (
            <div className="messages">
              {chatItems.map((item) =>
                item.kind === 'user' ? (
                  <article key={item.message.id} className="message user">
                    <div className="message-body">
                      <div className="message-text">{item.message.text}</div>
                    </div>
                  </article>
                ) : (
                  <AssistantTurnView
                    key={item.turn.id}
                    turn={item.turn}
                    activeTool={item.turn.id === liveTurnId ? activeTool : null}
                    live={item.turn.id === liveTurnId}
                  />
                )
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>

        <div className="composer-wrap">
          <div className="composer">
            <div className="composer-stats" aria-label="模型用量">
              <span
                className="usage-stat"
                title="最近一次请求的提示 token 占模型上下文窗口的比例"
              >
                上下文 <b>{usage.usage ? percentLabel(usage.contextPercent) : '—'}</b>
                <span className="usage-detail">
                  {usage.usage
                    ? `${compactTokens(usage.promptTokens)} / ${compactTokens(usage.contextWindow)}`
                    : ''}
                </span>
              </span>
              <span className="usage-stat" title="输出 token 除以请求耗时">
                速度 <b>{usage.speed !== null ? usage.speed.toFixed(1) : '—'}</b>
                <span className="usage-detail">tok/s</span>
              </span>
              <span className="usage-stat" title="前缀缓存读取 / 提示 token（输入 + 缓存读 + 缓存写）">
                缓存命中 <b>{usage.usage ? percentLabel(usage.cachePercent) : '—'}</b>
                <span className="usage-detail">
                  {usage.usage ? `${compactTokens(usage.usage.cacheRead)} 读` : ''}
                </span>
              </span>
            </div>
            <textarea
              ref={textareaRef}
              value={draft}
              rows={3}
              placeholder={
                activeProject?.available
                  ? activeConversation
                    ? '问点什么，或描述你想完成的任务…（Enter 发送，Shift+Enter 换行）'
                    : '输入第一条消息会自动新建对话'
                  : '请先创建项目或恢复项目目录'
              }
              disabled={!activeProject?.available}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              onBlur={() => void persistDraftNow()}
            />
            <div className="composer-actions">
              <span className="composer-hint">
                {activeProject ? '项目隔离 · 草稿自动保存 · 只读工具' : '尚未选择项目'}
              </span>
              {busy ? (
                <button type="button" className="stop-button" onClick={() => void handleStop()}>
                  ■ 停止
                </button>
              ) : (
                <button
                  type="button"
                  className="send-button"
                  disabled={!canSend}
                  onClick={() => void handleSend()}
                >
                  发送 <span className="send-arrow">↑</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </main>

      <MemoryPanel
        open={memoryOpen}
        settings={settings}
        projectName={activeProject?.name}
        onClose={() => setMemoryOpen(false)}
        onModeChanged={(nextMode) => {
          const nextPreset: ProjectMemoryPreset =
            nextMode === 'both'
              ? activeProject?.memoryPreset === 'dreaming'
                ? 'dreaming'
                : 'both'
              : nextMode
          setNotice(`记忆模式已切换为「${MEMORY_LABELS[nextMode]}」，项目策略已保存。`)
          if (activeProject) {
            setProjects((previous) =>
              previous.map((item) =>
                item.id === activeProject.id ? { ...item, memoryPreset: nextPreset } : item
              )
            )
            void window.openfuture
              .setProjectMemoryPreset({ projectId: activeProject.id, preset: nextPreset })
              .then((result) => {
                if (!result.ok) {
                  setError(result.error.message)
                  return
                }
                setProjects((previous) =>
                  previous.map((item) => (item.id === result.value.id ? result.value : item))
                )
              })
              .catch((error: unknown) => {
                setError(error instanceof Error ? error.message : String(error))
              })
          }
          resetHostSession()
        }}
      />

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSaved={(next) => {
          setSettings(next)
          setSettingsOpen(false)
          resetHostSession()
          setNotice('模型设置已保存，Agent 进程已重启；当前对话下次发送时会恢复。')
        }}
      />

      {createOpen ? (
        <div className="modal-backdrop" onClick={() => setCreateOpen(false)}>
          <div className="modal project-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div>
                <div className="modal-kicker">NEW PROJECT</div>
                <h2>新建项目</h2>
              </div>
              <button type="button" className="ghost-button" onClick={() => setCreateOpen(false)}>
                关闭
              </button>
            </div>

            <div className="field">
              <span className="field-label">工作区文件夹</span>
              <div className="path-picker">
                <div className={`path-value${newProject.path ? '' : ' empty'}`} title={newProject.path}>
                  {newProject.path || '尚未选择文件夹'}
                </div>
                <button type="button" className="ghost-button" onClick={() => void chooseFolder()}>
                  选择文件夹
                </button>
              </div>
            </div>

            <label className="field">
              <span className="field-label">项目名称</span>
              <input
                value={newProject.name}
                maxLength={80}
                placeholder="默认使用文件夹名称"
                onChange={(event) =>
                  setNewProject((previous) => ({ ...previous, name: event.target.value }))
                }
              />
            </label>

            <div className="field">
              <span className="field-label">项目记忆策略</span>
              <div className="preset-grid">
                {CREATE_PRESETS.map((preset) => (
                  <button
                    type="button"
                    key={preset}
                    className={`preset-card${newProject.preset === preset ? ' active' : ''}`}
                    onClick={() => setNewProject((previous) => ({ ...previous, preset }))}
                  >
                    <strong>{PRESET_LABELS[preset]}</strong>
                    <span>{PRESET_DESCRIPTIONS[preset]}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="field-row project-model-row">
              <label className="field project-model-field">
                <span className="field-label">默认模型（可选）</span>
                <select
                  value={newProject.defaultModelRef}
                  onChange={(event) =>
                    setNewProject((previous) => ({
                      ...previous,
                      defaultModelRef: event.target.value
                    }))
                  }
                >
                  <option value="">不指定，使用全局默认</option>
                  {settings?.model ? (
                    <option value={`openfuture/${settings.model.modelId}`}>
                      {settings.model.displayName || settings.model.modelId}
                    </option>
                  ) : null}
                </select>
              </label>
              <button
                type="button"
                className="primary-button"
                disabled={creating || !newProject.path.trim() || !newProject.name.trim()}
                onClick={() => void submitProject()}
              >
                {creating ? '创建中…' : '创建项目'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {logsOpen ? (
        <div
          className="modal-backdrop"
          onClick={() => {
            setLogsOpen(false)
            setLogsOnce(true)
          }}
        >
          <div className="log-panel" onClick={(event) => event.stopPropagation()}>
            <div className="log-header">
              <span>Agent 诊断日志</span>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setLogsOpen(false)
                  setLogsOnce(true)
                }}
              >
                关闭
              </button>
            </div>
            <pre className="log-content">{logs.length > 0 ? logs.join('\n') : '暂无日志'}</pre>
          </div>
        </div>
      ) : null}
    </div>
  )
}
