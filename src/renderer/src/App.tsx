import { useEffect, useMemo, useRef, useState } from 'react'
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

interface TurnUsageSummary {
  promptTokens: number
  outputTokens: number
  cacheRead: number
  totalTokens: number
}

function summarizeTurnUsage(turn: AssistantTurn): TurnUsageSummary | null {
  let promptTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let totalTokens = 0
  let found = false
  for (const message of turn.messages) {
    if (!message.usage) continue
    found = true
    promptTokens += message.usage.input + message.usage.cacheRead + message.usage.cacheWrite
    outputTokens += message.usage.output
    cacheRead += message.usage.cacheRead
    totalTokens += message.usage.totalTokens
  }
  return found ? { promptTokens, outputTokens, cacheRead, totalTokens } : null
}

function turnStepCount(turn: AssistantTurn): number {
  return turn.messages.reduce((count, message) => {
    if (message.toolNames?.length) return count + message.toolNames.length
    return count + (message.thinking?.trim() ? 1 : 0)
  }, 0)
}

interface SessionUsageSummary {
  turns: number
  steps: number
  speed: number | null
  cachePercent: number | null
  totalTokens: number
  contextPercent: number | null
  promptTokens: number
  contextWindow: number
}

function summarizeSessionUsage(items: ChatItem[], configuredWindow: number | undefined): SessionUsageSummary {
  const contextWindow =
    configuredWindow !== undefined && Number.isFinite(configuredWindow) && configuredWindow > 0
      ? configuredWindow
      : 128_000
  let turns = 0
  let steps = 0
  let outputTokens = 0
  let durationMs = 0
  let cacheRead = 0
  let promptTokens = 0
  let totalTokens = 0
  let latestPromptTokens: number | null = null
  for (const item of items) {
    if (item.kind !== 'assistant') continue
    turns += 1
    steps += turnStepCount(item.turn)
    for (const message of item.turn.messages) {
      if (!message.usage) continue
      const prompt = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite
      promptTokens += prompt
      outputTokens += message.usage.output
      cacheRead += message.usage.cacheRead
      totalTokens += message.usage.totalTokens
      if (message.usage.durationMs && message.usage.durationMs > 0) durationMs += message.usage.durationMs
      if (prompt > 0) latestPromptTokens = prompt
    }
  }
  return {
    turns,
    steps,
    speed: durationMs > 0 ? outputTokens / (durationMs / 1000) : null,
    cachePercent: promptTokens > 0 ? (cacheRead / promptTokens) * 100 : null,
    totalTokens,
    contextPercent: latestPromptTokens === null ? null : (latestPromptTokens / contextWindow) * 100,
    promptTokens: latestPromptTokens ?? 0,
    contextWindow
  }
}

function clockTime(value: number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function ClockIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 4.7v3.6l2.4 1.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function DatabaseIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
      <ellipse cx="8" cy="3.6" rx="4.8" ry="1.8" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3.2 3.6v4.2c0 1 2.1 1.8 4.8 1.8s4.8-.8 4.8-1.8V3.6M3.2 7.8v4.2c0 1 2.1 1.8 4.8 1.8s4.8-.8 4.8-1.8V7.8" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function CopyIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
      <rect x="5.2" y="3.2" width="7.4" height="8.8" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3.4 5.4v7.2c0 .8.6 1.4 1.4 1.4h5.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function BrandMark({ className = '' }: { className?: string }): React.JSX.Element {
  return (
    <svg className={`brand-mark-svg ${className}`.trim()} viewBox="0 0 44 44" width="30" height="30" aria-hidden>
      <defs>
        <linearGradient id="of-mark-gradient" x1="5" y1="3" x2="39" y2="41" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#e6f9ff" />
          <stop offset="0.42" stopColor="#7dd3fc" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
      </defs>
      <path
        d="M22 3.5 38.2 12.4v19.2L22 40.5 5.8 31.6V12.4L22 3.5Z"
        fill="none"
        stroke="url(#of-mark-gradient)"
        strokeWidth="1.6"
        strokeLinejoin="round"
        opacity="0.9"
      />
      <path
        d="M15.8 29V15h9.4M15.8 22h6.3M27.8 16.5 33 22l-5.2 5.5"
        fill="none"
        stroke="url(#of-mark-gradient)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="34.6" cy="9.4" r="1.5" fill="#dff8ff" />
    </svg>
  )
}

function FolderIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
      <path
        d="M3.4 6.7c0-.9.7-1.6 1.6-1.6h4.2l2 2h7.8c.9 0 1.6.7 1.6 1.6v8.6c0 .9-.7 1.6-1.6 1.6H5c-.9 0-1.6-.7-1.6-1.6V6.7Z"
        fill="currentColor"
        fillOpacity="0.08"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SearchIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden>
      <circle cx="10.8" cy="10.8" r="6.1" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="m15.4 15.4 4.1 4.1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function SortIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden>
      <path d="M4 7h9M4 12h6M4 17h3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M18 5v14m0 0-3.4-3.4M18 19l3.4-3.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function NewFolderIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path
        d="M3.5 7c0-.8.6-1.5 1.5-1.5h4l1.9 2h7.6c.8 0 1.5.6 1.5 1.5v8.5c0 .8-.6 1.5-1.5 1.5H5c-.8 0-1.5-.6-1.5-1.5V7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M17 4.5v5M14.5 7h5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function UsageRing({ percent }: { percent: number | null }): React.JSX.Element {
  const value = percent === null || !Number.isFinite(percent) ? 0 : Math.max(0, Math.min(100, percent))
  return (
    <span
      className="usage-ring"
      style={{ ['--usage-fill' as string]: `${value}%` } as React.CSSProperties}
      title={percent === null ? '尚未收到用量数据' : `上下文已使用 ${percent.toFixed(1)}%`}
    >
      <span>{percentLabel(percent)}</span>
    </span>
  )
}

async function copyAnswer(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
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

function relativeTime(value: number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const diff = Math.max(0, Date.now() - date.getTime())
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}分钟`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}天`
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
  const stepCount = turnStepCount(turn) + (streaming && activeTool ? 1 : 0)
  const showTyping = streaming && !turn.text && !hasChain
  const chainRef = useRef<HTMLDivElement | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyTimer = useRef<number | null>(null)
  const turnUsage = useMemo(() => summarizeTurnUsage(turn), [turn])

  useEffect(() => {
    const rail = chainRef.current
    if (!rail || !streaming) return
    rail.scrollTop = rail.scrollHeight
  }, [streaming, turn.messages, activeTool])

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    }
  }, [])

  const handleCopy = async (): Promise<void> => {
    const ok = await copyAnswer(turn.text)
    setCopyState(ok ? 'copied' : 'failed')
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopyState('idle'), 1500)
  }

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
        {!streaming && turn.text ? (
          <div className="message-footer">
            <button
              type="button"
              className="message-action"
              onClick={() => void handleCopy()}
              aria-label="复制回答"
              title="复制回答"
            >
              <CopyIcon />
              <span>{copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制'}</span>
            </button>
            <span
              className="message-usage"
              title={
                turnUsage
                  ? `提示 ${turnUsage.promptTokens} · 输出 ${turnUsage.outputTokens} · 缓存读取 ${turnUsage.cacheRead}`
                  : '本次回答未返回 token 用量'
              }
            >
              {turnUsage
                ? `↑${compactTokens(turnUsage.promptTokens)} · ↓${compactTokens(turnUsage.outputTokens)}`
                : '用量 —'}
            </span>
            <span className="message-footer-spacer" />
            <span className="message-time">{clockTime(turn.timestamp)}</span>
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
  const [showAllConversations, setShowAllConversations] = useState<Set<string>>(new Set())
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
  const [appMenu, setAppMenu] = useState<'app' | 'edit' | null>(null)
  const [dshPanel, setDshPanel] = useState<'plugins' | 'automation' | 'more' | 'computer' | 'about' | null>(null)
  const [composerMenu, setComposerMenu] = useState<'project' | 'mode' | 'plus' | null>(null)
  const [sortMode, setSortMode] = useState<'name' | 'recent'>('name')
  const [view, setView] = useState<'chat' | 'trace' | 'context'>('chat')
  const [computerUse, setComputerUse] = useState(false)
  const [computerBusy, setComputerBusy] = useState(false)
  const [contextCompression, setContextCompression] = useState(true)
  const [contextBusy, setContextBusy] = useState(false)

  const sessionRef = useRef<string | null>(null)
  const assistantRef = useRef<string | null>(null)
  const activeProjectRef = useRef<string | null>(null)
  const activeConversationRef = useRef<string | null>(null)
  const draftRef = useRef('')
  const endRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const pendingSendsRef = useRef<string[]>([])

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
        if (settingsResult.ok) {
          setSettings(settingsResult.value)
          setComputerUse(settingsResult.value.computerUse)
          setContextCompression(settingsResult.value.contextCompression)
        } else setError(settingsResult.error.message)

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
          const cancelled = pendingSendsRef.current
          pendingSendsRef.current = []
          if (cancelled.length > 0) {
            setMessages((previous) =>
              previous.filter((message) => !(message.role === 'user' && message.pending))
            )
            setDraft((current) =>
              current.trim().length === 0 ? cancelled[cancelled.length - 1] ?? '' : current
            )
            setNotice('已停止，未发送的引导/排队已取消')
          } else {
            setNotice('已停止')
          }
          setError(null)
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
      case 'user-message': {
        const pendingIndex = pendingSendsRef.current.indexOf(event.message.text)
        if (pendingIndex >= 0) pendingSendsRef.current.splice(pendingIndex, 1)
        setMessages((previous) => {
          let matched = false
          const next = previous.map((message) => {
            if (
              !matched &&
              message.role === 'user' &&
              message.text === event.message.text &&
              (message.pending || Date.now() - message.timestamp < 15_000)
            ) {
              matched = true
              return { ...message, pending: undefined }
            }
            return message
          })
          return matched ? next : [...next, event.message]
        })
        break
      }
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

  async function sendWhileBusy(text: string, mode: 'queue' | 'steer'): Promise<void> {
    const project = activeProject
    if (!project || !project.available) {
      setError('项目目录不可用，请先重新定位目录')
      return
    }
    if (!currentSessionId) {
      setError('当前会话尚未建立，请稍后重试。')
      return
    }
    const optimisticId = `u-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setDraft('')
    setError(null)
    setNotice(null)
    pendingSendsRef.current.push(text)
    setMessages((previous) => [
      ...previous,
      {
        id: optimisticId,
        role: 'user',
        text,
        timestamp: Date.now(),
        pending: mode === 'steer' ? 'steer' : 'queued'
      }
    ])
    const result = await window.openfuture.sendMessage(text, mode === 'steer' ? 'steer' : 'followUp')
    if (!result.ok) {
      const pendingIndex = pendingSendsRef.current.lastIndexOf(text)
      if (pendingIndex >= 0) pendingSendsRef.current.splice(pendingIndex, 1)
      setMessages((previous) => previous.filter((message) => message.id !== optimisticId))
      setDraft((current) => (current.trim().length === 0 ? text : current))
      setError(result.error.message)
    }
  }

  async function handleSend(mode: 'queue' | 'steer' = 'queue'): Promise<void> {
    const text = draft.trim()
    if (!text) return
    if (busy) {
      await sendWhileBusy(text, mode)
      return
    }
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

    const result = await window.openfuture.sendMessage(text, 'prompt')
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
      void handleSend(event.ctrlKey || event.metaKey ? 'steer' : 'queue')
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

  async function toggleComputerUse(): Promise<void> {
    if (computerBusy) return
    const next = !computerUse
    setComputerUse(next)
    setComputerBusy(true)
    try {
      // Read the current access flags first: the Computer Use switch must not
      // silently turn PowerShell access off when another surface changed it.
      const currentSettings = await window.openfuture.getSettings()
      const currentPowerShell = currentSettings.ok
        ? currentSettings.value.allowPowerShell
        : settings?.allowPowerShell ?? false
      const result = await window.openfuture.setToolAccess({
        powershell: currentPowerShell,
        computerUse: next
      })
      if (!result.ok) throw new Error(result.error.message)
      setSettings(result.value)
      setNotice(
        next
          ? 'Computer Use 已开启；重新打开会话后会提供桌面工具。桌面操作需要约 10 秒无键鼠输入，工具会自动等待。'
          : 'Computer Use 已关闭。'
      )
      resetHostSession()
      if (activeProject?.available && activeConversation) {
        await openConversationFor(activeProject, activeConversation)
      }
    } catch (toggleError) {
      setComputerUse(!next)
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError))
    } finally {
      setComputerBusy(false)
    }
  }

  async function toggleContextCompression(): Promise<void> {
    if (contextBusy) return
    const next = !contextCompression
    setContextCompression(next)
    setContextBusy(true)
    try {
      const currentSettings = await window.openfuture.getSettings()
      const current = currentSettings.ok ? currentSettings.value : settings
      const result = await window.openfuture.setToolAccess({
        powershell: current?.allowPowerShell ?? false,
        computerUse: current?.computerUse ?? computerUse,
        contextCompression: next
      })
      if (!result.ok) throw new Error(result.error.message)
      setSettings(result.value)
      setNotice(
        next
          ? '上下文压缩已开启；重新打开会话后会接管 Pi 原生压缩（实验性）。'
          : '上下文压缩已关闭，使用 Pi 原生压缩。'
      )
      resetHostSession()
      if (activeProject?.available && activeConversation) {
        await openConversationFor(activeProject, activeConversation)
      }
    } catch (toggleError) {
      setContextCompression(!next)
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError))
    } finally {
      setContextBusy(false)
    }
  }

  const canSend = Boolean(activeProject?.available) && !busy && draft.trim().length > 0
  const title = activeConversation?.title ?? (activeProject ? '新建对话' : 'OpenFuture')
  const chatItems = buildChatItems(messages)
  const usage = summarizeUsage(messages, settings?.model?.contextWindow)
  const sessionUsage = summarizeSessionUsage(chatItems, settings?.model?.contextWindow)
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
  const sortedProjects = [...filteredProjects].sort((left, right) => {
    if (sortMode === 'name') return left.name.localeCompare(right.name, 'zh-CN')
    return right.createdAt - left.createdAt
  })
  const traceMessages = messages.filter(
    (message) =>
      message.role === 'assistant' && (Boolean(message.thinking?.trim()) || (message.toolNames?.length ?? 0) > 0)
  )

  function startNewSession(): void {
    setAppMenu(null)
    setDshPanel(null)
    setView('chat')
    if (!activeProject) {
      setCreateOpen(true)
      return
    }
    void createConversation(activeProject.id)
  }

  function changeProjectPreset(preset: ProjectMemoryPreset): void {
    const project = activeProject
    if (!project) return
    setComposerMenu(null)
    setProjects((previous) => previous.map((item) => (item.id === project.id ? { ...item, memoryPreset: preset } : item)))
    void window.openfuture
      .setProjectMemoryPreset({ projectId: project.id, preset })
      .then((result) => {
        if (!result.ok) {
          setError(result.error.message)
          return
        }
        setProjects((previous) => previous.map((item) => (item.id === result.value.id ? result.value : item)))
        setNotice(`项目用途已切换为「${PRESET_LABELS[preset]}」。`)
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
      })
  }

  function copyTranscript(): void {
    setAppMenu(null)
    const text = messages
      .map((message) => `${message.role === 'assistant' ? 'OpenFuture' : '你'}：${message.text}`)
      .join('\n\n')
    if (!text) {
      setNotice('当前没有可复制的对话。')
      return
    }
    void copyAnswer(text).then((ok) => setNotice(ok ? '对话已复制到剪贴板。' : '复制失败，请检查剪贴板权限。'))
  }

  if (!loaded) return <div className="fatal-screen">正在加载 OpenFuture…</div>

  return (
    <div className="app-shell v2-shell">
      <aside className="dsh-sidebar" aria-label="工作区与导航">
        <div className="dsh-menubar">
          <div className="dsh-menubar-buttons">
            <button type="button" onClick={() => setAppMenu(appMenu === 'app' ? null : 'app')}>应用</button>
            <button type="button" onClick={() => setAppMenu(appMenu === 'edit' ? null : 'edit')}>编辑</button>
          </div>
          {appMenu === 'app' ? (
            <div className="dsh-top-menu" role="menu">
              <button type="button" onClick={() => { setAppMenu(null); setCreateOpen(true) }}>新建项目</button>
              <button type="button" onClick={() => { setAppMenu(null); setSettingsOpen(true) }}>模型与密钥</button>
              <button type="button" onClick={() => { setAppMenu(null); setMemoryOpen(true) }}>项目记忆</button>
              <button type="button" onClick={() => { setAppMenu(null); setLogsOpen(true) }}>诊断日志</button>
              <button type="button" onClick={() => { setAppMenu(null); setDshPanel('about') }}>关于 OpenFuture</button>
            </div>
          ) : null}
          {appMenu === 'edit' ? (
            <div className="dsh-top-menu" role="menu">
              <button type="button" onClick={copyTranscript}>复制当前对话</button>
              <button type="button" onClick={() => { setAppMenu(null); textareaRef.current?.focus(); textareaRef.current?.select() }}>全选输入框</button>
              <button type="button" onClick={() => { setAppMenu(null); void persistDraftNow(); setNotice('草稿已保存。') }}>保存草稿</button>
            </div>
          ) : null}
        </div>

        <div className="dsh-brand">
          <span className="dsh-brand-mark" aria-hidden="true">
            <BrandMark />
          </span>
          <span className="dsh-brand-name">OpenFuture</span>
          <span className="dsh-brand-badge">HARNESS</span>
        </div>

        <button type="button" className="dsh-new-session" onClick={startNewSession}>
          <span aria-hidden="true">＋</span> 新会话
        </button>

        <nav className="dsh-nav" aria-label="工具导航">
          <button type="button" onClick={() => setDshPanel('plugins')}>
            <span aria-hidden="true">◇</span> 插件 <em>3</em>
          </button>
          <button type="button" onClick={() => setDshPanel('automation')}>
            <span aria-hidden="true">◷</span> 自动化任务
          </button>
          <button type="button" onClick={() => setDshPanel('more')}>
            <span aria-hidden="true">⋯</span> 更多
          </button>
        </nav>

        <div className="dsh-workspaces-head">
          <span>工作区</span>
          <div className="dsh-workspaces-actions">
            <button
              type="button"
              title="搜索工作区"
              aria-label="搜索工作区"
              onClick={() => {
                setSearchOpen((value) => !value)
                window.setTimeout(() => searchRef.current?.focus(), 0)
              }}
            >
              <SearchIcon />
            </button>
            <button
              type="button"
              title={sortMode === 'name' ? '按名称排序' : '按最近使用排序'}
              aria-label="切换工作区排序"
              onClick={() => setSortMode(sortMode === 'name' ? 'recent' : 'name')}
            >
              <SortIcon />
            </button>
            <button
              type="button"
              title="新建工作区"
              aria-label="新建工作区"
              onClick={() => {
                setNewProject({ name: '', path: '', preset: 'off', defaultModelRef: '' })
                setCreateOpen(true)
              }}
            >
              <NewFolderIcon />
            </button>
          </div>
        </div>

        {searchOpen ? (
          <div className="tree-search dsh-search">
            <input
              ref={searchRef}
              value={searchText}
              placeholder="搜索工作区或对话"
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

        <div className="project-list dsh-project-list">

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
            sortedProjects.map((project) => {
              const projectConversations = (convMap[project.id] ?? []).filter((conversation) =>
                searchText.trim()
                  ? conversation.title.toLowerCase().includes(searchText.trim().toLowerCase())
                  : true
              )
              const isOpen = expanded.has(project.id)
              const isActive = project.id === activeProjectId
              const revealAll = showAllConversations.has(project.id) || Boolean(searchText.trim())
              const visibleConversations = revealAll ? projectConversations : projectConversations.slice(0, 2)
              return (
                <div className={`project-group${isActive ? ' active' : ''}`} key={project.id}>
                  <div className="project-row">
                    <button
                      type="button"
                      className={`project-folder${isActive ? ' active' : ''}`}
                      aria-label={isOpen ? '折叠项目' : '展开项目'}
                      aria-expanded={isOpen}
                      onClick={() => void toggleProject(project)}
                    >
                      <FolderIcon />
                    </button>
                    <button
                      type="button"
                      className="project-main"
                      title={project.canonicalRoot}
                      onClick={() => void selectProject(project.id)}
                    >
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
                          {visibleConversations.map((conversation) => (
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
                              <span className="conversation-time">{relativeTime(conversation.updatedAt)}</span>
                            </button>
                          ))}
                          {!searchText.trim() && projectConversations.length > 2 ? (
                            <button
                              type="button"
                              className="conversation-more"
                              onClick={() => {
                                setShowAllConversations((previous) => {
                                  const next = new Set(previous)
                                  if (next.has(project.id)) next.delete(project.id)
                                  else next.add(project.id)
                                  return next
                                })
                              }}
                            >
                              {revealAll ? '收起对话' : `查看全部 ${projectConversations.length} 个对话`}
                            </button>
                          ) : null}
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

        <div className="dsh-sidebar-footer">
          <button
            type="button"
            className="dsh-user"
            title="打开模型与密钥设置"
            onClick={() => setSettingsOpen(true)}
          >
            <span className="dsh-user-avatar">17.</span>
            <span className="dsh-user-copy">
              <b>本地用户</b>
              <em>v{settings?.appVersion ?? '0.2.0'}</em>
            </span>
          </button>
          <div className="dsh-footer-actions">
            <button
              type="button"
              title={`主题：${theme === 'system' ? '跟随系统' : theme === 'light' ? '浅色' : '深色'}`}
              aria-label="切换主题"
              onClick={() => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')}
            >
              {theme === 'light' ? '☀' : theme === 'dark' ? '☾' : '◐'}
            </button>
            <button type="button" title="项目记忆" aria-label="项目记忆" onClick={() => setMemoryOpen(true)}>
              ◫
            </button>
            <button type="button" title="诊断日志" aria-label="诊断日志" onClick={() => setLogsOpen(true)}>
              ▤
            </button>
            <button type="button" title="设置" aria-label="设置" onClick={() => setSettingsOpen(true)}>
              ⚙
            </button>
          </div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="main-header dsh-main-header">
          <div className="main-title-wrap">
            <div className="dsh-context-line">
              <span>{activeProject?.name ?? '未选择工作区'}</span>
              {activeProject ? <em>{PRESET_LABELS[activeProject.memoryPreset]}</em> : null}
            </div>
            <div className="main-title" title={title}>
              {title}
            </div>
            <div className="dsh-tabs" role="tablist" aria-label="会话视图">
              {(
                [
                  ['chat', '对话'],
                  ['trace', '轨迹'],
                  ['context', '上下文']
                ] as Array<[typeof view, string]>
              ).map(([value, label]) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === value}
                  key={value}
                  className={view === value ? 'active' : ''}
                  onClick={() => setView(value)}
                >
                  {label}
                </button>
              ))}
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
          {view === 'trace' ? (
            <div className="dsh-view dsh-trace-view">
              <div className="dsh-view-head">
                <h2>轨迹</h2>
                <p>当前会话保存的思考与工具调用记录。</p>
              </div>
              {traceMessages.length === 0 ? (
                <div className="dsh-empty-note">还没有可显示的轨迹。发送一条消息后，这里会记录思考与工具步骤。</div>
              ) : (
                <div className="dsh-trace-list">
                  {traceMessages.map((message) => (
                    <article key={message.id} className="dsh-trace-item">
                      <header>
                        <span>{clockTime(message.timestamp)}</span>
                        <b>{message.toolNames?.length ? `工具 · ${message.toolNames.join(' / ')}` : '思考'}</b>
                      </header>
                      {message.thinking ? <p>{message.thinking}</p> : null}
                      {message.toolNames?.length ? (
                        <div className="dsh-trace-tools">
                          {message.toolNames.map((tool) => (
                            <span key={tool}>{tool}</span>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              )}
            </div>
          ) : view === 'context' ? (
            <div className="dsh-view dsh-context-view">
              <div className="dsh-view-head">
                <h2>上下文</h2>
                <p>当前工作区与这次会话共享给模型的信息。</p>
              </div>
              <div className="dsh-context-grid">
                <section>
                  <span>工作区</span>
                  <b>{activeProject?.name ?? '未选择'}</b>
                  <em>{activeProject?.canonicalRoot ?? '—'}</em>
                </section>
                <section>
                  <span>项目用途</span>
                  <b>{activeProject ? PRESET_LABELS[activeProject.memoryPreset] : '—'}</b>
                  <em>{activeProject ? `${activeProject.conversationCount} 条会话` : '—'}</em>
                </section>
                <section>
                  <span>上下文使用</span>
                  <b>{sessionUsage.promptTokens > 0 ? percentLabel(sessionUsage.contextPercent) : '—'}</b>
                  <em>
                    {sessionUsage.promptTokens > 0
                      ? `${compactTokens(sessionUsage.promptTokens)} / ${compactTokens(sessionUsage.contextWindow)}`
                      : '还没有请求用量'}
                  </em>
                </section>
                <section>
                  <span>缓存命中</span>
                  <b>{sessionUsage.cachePercent !== null ? percentLabel(sessionUsage.cachePercent) : '—'}</b>
                  <em>{sessionUsage.totalTokens > 0 ? `${compactTokens(sessionUsage.totalTokens)} tok 累计` : '—'}</em>
                </section>
              </div>
              <div className="dsh-context-actions">
                <button type="button" className="primary-button" onClick={() => setMemoryOpen(true)}>
                  打开项目记忆
                </button>
                <button type="button" className="secondary-button" onClick={() => setSettingsOpen(true)}>
                  模型与密钥
                </button>
                <button type="button" className="secondary-button" onClick={() => setLogsOpen(true)}>
                  诊断日志
                </button>
              </div>
            </div>
          ) : !activeProject || messages.length === 0 ? (
            <div className="empty-state dsh-welcome">
              <div className="dsh-welcome-glow" aria-hidden="true" />
              <div className="dsh-welcome-mark">
                <BrandMark className="dsh-welcome-logo" />
              </div>
              <div className="dsh-welcome-title">{activeProject?.name ?? '探索未至之境'}</div>
              <p className="dsh-welcome-copy">
                {activeProject
                  ? `${PRESET_LABELS[activeProject.memoryPreset]} · 工作区内的修改只影响当前项目`
                  : '选择一个文件夹作为工作区，开始一段只属于它的对话。'}
              </p>
              {activeProject ? (
                <p className="dsh-welcome-path" title={activeProject.canonicalRoot}>
                  {activeProject.canonicalRoot}
                </p>
              ) : (
                <button type="button" className="dsh-welcome-button" onClick={() => setCreateOpen(true)}>
                  ＋ 新建工作区
                </button>
              )}
              {activeProject ? (
                <button
                  type="button"
                  className="dsh-welcome-button"
                  disabled={!activeProject.available}
                  onClick={() => void createConversation(activeProject.id)}
                >
                  新会话
                </button>
              ) : null}
            </div>
          ) : (
            <div className="messages">
              {chatItems.map((item) =>
                item.kind === 'user' ? (
                  <article key={item.message.id} className={`message user${item.message.pending ? ' pending' : ''}`}>
                    <div className="message-body">
                      <div className="message-text">{item.message.text}</div>
                      {item.message.pending ? (
                        <div className="message-pending-tag">
                          {item.message.pending === 'steer' ? '引导中 · 当前工具结束后发送' : '已排队 · 本轮结束后发送'}
                        </div>
                      ) : null}
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

        <div className="composer-wrap dsh-composer-wrap">
          <div className="composer dsh-composer">
            {composerMenu === 'project' ? (
              <div className="dsh-composer-popover dsh-project-popover" role="menu">
                <div className="dsh-popover-title">切换工作区</div>
                {sortedProjects.length === 0 ? (
                  <button type="button" onClick={() => { setComposerMenu(null); setCreateOpen(true) }}>
                    ＋ 新建工作区
                  </button>
                ) : (
                  sortedProjects.map((project) => (
                    <button
                      type="button"
                      key={project.id}
                      className={project.id === activeProjectId ? 'active' : ''}
                      onClick={() => {
                        setComposerMenu(null)
                        void selectProject(project.id)
                      }}
                    >
                      <span className="dsh-folder">▱</span>
                      <span>{project.name}</span>
                      {!project.available ? <em>目录不可用</em> : null}
                    </button>
                  ))
                )}
              </div>
            ) : null}
            {composerMenu === 'mode' ? (
              <div className="dsh-composer-popover dsh-mode-popover" role="menu">
                <div className="dsh-popover-title">项目用途</div>
                {(['rag', 'wiki', 'dreaming', 'off'] as ProjectMemoryPreset[]).map((preset) => (
                  <button
                    type="button"
                    key={preset}
                    className={activeProject?.memoryPreset === preset ? 'active' : ''}
                    onClick={() => changeProjectPreset(preset)}
                  >
                    <span>{PRESET_LABELS[preset]}</span>
                    <em>{PRESET_DESCRIPTIONS[preset]}</em>
                  </button>
                ))}
                {activeProject?.memoryPreset === 'both' ? (
                  <button type="button" className="active" onClick={() => changeProjectPreset('both')}>
                    <span>{PRESET_LABELS.both}</span>
                    <em>{PRESET_DESCRIPTIONS.both}</em>
                  </button>
                ) : null}
              </div>
            ) : null}
            {composerMenu === 'plus' ? (
              <div className="dsh-composer-popover dsh-plus-popover" role="menu">
                <button type="button" onClick={() => { setComposerMenu(null); setNewProject({ name: '', path: '', preset: 'off', defaultModelRef: '' }); setCreateOpen(true) }}>
                  ＋ 新建工作区
                </button>
                <button type="button" onClick={() => { setComposerMenu(null); startNewSession() }}>◇ 新会话</button>
                <button type="button" onClick={() => { setComposerMenu(null); setMemoryOpen(true) }}>◫ 项目记忆</button>
                <button type="button" onClick={() => { setComposerMenu(null); setLogsOpen(true) }}>▤ 诊断日志</button>
                <button type="button" onClick={() => { setComposerMenu(null); setSettingsOpen(true) }}>⚙ 模型与密钥</button>
              </div>
            ) : null}
            <textarea
              ref={textareaRef}
              value={draft}
              rows={2}
              placeholder={
                !activeProject?.available
                  ? '请先创建或恢复一个工作区'
                  : busy
                    ? '输入后按 Enter 排队，Ctrl+Enter 立即引导；不打断当前工具调用…'
                    : '描述你想要构建的内容，或直接问一个问题…'
              }
              disabled={!activeProject?.available}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              onBlur={() => void persistDraftNow()}
            />
            <div className="dsh-composer-actions">
              <div className="dsh-composer-left">
                <button
                  type="button"
                  className="dsh-round-button"
                  title="添加或新建"
                  aria-label="添加或新建"
                  onClick={() => setComposerMenu(composerMenu === 'plus' ? null : 'plus')}
                >
                  ＋
                </button>
                <button
                  type="button"
                  className="dsh-pill"
                  title="切换工作区"
                  onClick={() => setComposerMenu(composerMenu === 'project' ? null : 'project')}
                >
                  <span className="dsh-pill-icon">◧</span>
                  {activeProject?.name ?? '选择工作区'}
                  <span className="dsh-pill-caret">⌄</span>
                </button>
                <button
                  type="button"
                  className="dsh-pill"
                  title="项目用途"
                  disabled={!activeProject}
                  onClick={() => setComposerMenu(composerMenu === 'mode' ? null : 'mode')}
                >
                  <span className="dsh-pill-icon">◐</span>
                  {activeProject ? PRESET_LABELS[activeProject.memoryPreset] : '项目用途'}
                  <span className="dsh-pill-caret">⌄</span>
                </button>
                <button
                  type="button"
                  className={`dsh-pill${computerUse ? ' active' : ''}`}
                  title="Computer Use（Windows）"
                  onClick={() => setDshPanel('computer')}
                >
                  <span className="dsh-pill-icon">▣</span>
                  Computer Use
                  <span className="dsh-pill-state">{computerUse ? '开' : '关'}</span>
                </button>
              </div>
              <div className="dsh-composer-right">
                <button
                  type="button"
                  className="dsh-model-button"
                  title="模型与密钥"
                  onClick={() => setSettingsOpen(true)}
                >
                  {modelName} <span className="dsh-pill-caret">⌄</span>
                </button>
                {busy ? (
                  <>
                    <button
                      type="button"
                      className="dsh-queue-button"
                      disabled={!draft.trim()}
                      title="排队：本轮结束后发送"
                      onClick={() => void handleSend('queue')}
                    >
                      排队
                    </button>
                    <button
                      type="button"
                      className="dsh-steer-button"
                      disabled={!draft.trim()}
                      title="引导：当前工具调用结束后立刻插入模型"
                      onClick={() => void handleSend('steer')}
                    >
                      引导
                    </button>
                    <button type="button" className="dsh-stop-button" onClick={() => void handleStop()}>
                      ■
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="dsh-send-button"
                    disabled={!canSend}
                    aria-label="发送"
                    onClick={() => void handleSend()}
                  >
                    ↑
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="dsh-statusbar" aria-label="会话用量">
            <span className="usage-cluster" title="当前会话的助手轮次与工具/思考步数">
              <ClockIcon />
              <span>
                <b>{sessionUsage.turns}</b> 轮 <b>{sessionUsage.steps}</b> 步{' '}
                <span className="usage-sep">·</span>{' '}
                <b>{sessionUsage.speed !== null ? sessionUsage.speed.toFixed(0) : '—'}</b>{' '}
                <span className="usage-unit">tok/s</span>
              </span>
            </span>
            <span className="usage-cluster" title="当前会话累计 token 与缓存读取占比">
              <DatabaseIcon />
              <span>
                <b>{sessionUsage.totalTokens > 0 ? compactTokens(sessionUsage.totalTokens) : '—'}</b>{' '}
                <span className="usage-unit">tok</span>{' '}
                <span className="usage-sep">·</span>{' '}缓存命中{' '}
                <b>{sessionUsage.cachePercent !== null ? percentLabel(sessionUsage.cachePercent) : '—'}</b>
              </span>
            </span>
            <span className="usage-context" title="最近一次请求的提示 token / 上下文窗口">
              <UsageRing percent={sessionUsage.promptTokens > 0 ? sessionUsage.contextPercent : null} />
              <span>
                <b>{sessionUsage.promptTokens > 0 ? percentLabel(sessionUsage.contextPercent) : '—'}</b>{' '}
                <span className="usage-context-detail">
                  {sessionUsage.promptTokens > 0
                    ? `${compactTokens(sessionUsage.promptTokens)} / ${compactTokens(sessionUsage.contextWindow)}`
                    : ''}
                </span>
              </span>
            </span>
          </div>
        </div>
      </main>

      {dshPanel ? (
        <div className="dsh-modal-backdrop" onClick={() => setDshPanel(null)}>
          <div
            className="dsh-modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              dshPanel === 'plugins'
                ? '插件'
                : dshPanel === 'automation'
                  ? '自动化任务'
                  : dshPanel === 'computer'
                    ? 'Computer Use'
                    : dshPanel === 'more'
                      ? '更多'
                      : '关于 OpenFuture'
            }
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dsh-modal-head">
              <div>
                <span className="dsh-modal-kicker">OPENFUTURE</span>
                <h2>
                  {dshPanel === 'plugins'
                    ? '插件'
                    : dshPanel === 'automation'
                      ? '自动化任务'
                      : dshPanel === 'computer'
                        ? 'Computer Use'
                        : dshPanel === 'more'
                          ? '更多'
                          : '关于 OpenFuture'}
                </h2>
              </div>
              <button type="button" className="dsh-modal-close" aria-label="关闭" onClick={() => setDshPanel(null)}>
                ×
              </button>
            </div>

            {dshPanel === 'plugins' ? (
              <div className="dsh-plugin-list">
                <article className="dsh-plugin-card">
                  <div className="dsh-plugin-icon">◈</div>
                  <div>
                    <b>项目记忆</b>
                    <p>RAG 检索、长期 Wiki、会话沉淀 Dreaming，按项目隔离。</p>
                    <span className={`dsh-plugin-state${activeProject && activeProject.memoryPreset !== 'off' ? ' on' : ''}`}>
                      {activeProject ? PRESET_LABELS[activeProject.memoryPreset] : '未选择工作区'}
                    </span>
                  </div>
                  <button type="button" onClick={() => { setDshPanel(null); setMemoryOpen(true) }}>打开</button>
                </article>
                <article className="dsh-plugin-card">
                  <div className="dsh-plugin-icon">▣</div>
                  <div>
                    <b>Computer Use</b>
                    <p>通过 Windows-MCP 观察屏幕、点击、输入和读取窗口。</p>
                    <span className={`dsh-plugin-state${computerUse ? ' on' : ''}`}>
                      {computerUse ? '已启用 · MCP' : '未启用'}
                    </span>
                  </div>
                  <button type="button" onClick={() => setDshPanel('computer')}>配置</button>
                </article>
                <article className="dsh-plugin-card">
                  <div className="dsh-plugin-icon">≋</div>
                  <div>
                    <b>上下文压缩</b>
                    <p>billion-context ACP 接管超长对话；Pi 原生压缩作为回退。</p>
                    <span className={`dsh-plugin-state${contextCompression ? ' on' : ''}`}>
                      {contextCompression ? '已启用 · ACP' : 'Pi 原生'}
                    </span>
                  </div>
                  <button type="button" disabled={contextBusy} onClick={() => void toggleContextCompression()}>
                    {contextCompression ? '关闭' : '启用'}
                  </button>
                </article>
                <article className="dsh-plugin-card">
                  <div className="dsh-plugin-icon">◇</div>
                  <div>
                    <b>协作运行</b>
                    <p>查看多 Agent 协作运行摘要；复用桌面适配层。</p>
                    <span className="dsh-plugin-state">已安装</span>
                  </div>
                  <button type="button" onClick={() => { setDshPanel(null); setLogsOpen(true) }}>查看</button>
                </article>
              </div>
            ) : null}

            {dshPanel === 'automation' ? (
              <div className="dsh-panel-body">
                <div className="dsh-panel-row">
                  <div>
                    <b>Dreaming 自动整理</b>
                    <p>按项目计划整理会话记忆；评审通过后才会发布到 L3。</p>
                  </div>
                  <span className="dsh-plugin-state">待配置</span>
                </div>
                <div className="dsh-panel-row">
                  <div>
                    <b>项目记忆质量检查</b>
                    <p>检查重复、陈旧、覆盖率和上下文预算。</p>
                  </div>
                  <span className="dsh-plugin-state">手动</span>
                </div>
                <div className="dsh-panel-actions">
                  <button type="button" className="primary-button" onClick={() => { setDshPanel(null); setMemoryOpen(true) }}>
                    打开项目记忆
                  </button>
                  <button type="button" className="secondary-button" onClick={() => { setDshPanel(null); setLogsOpen(true) }}>
                    查看诊断日志
                  </button>
                </div>
              </div>
            ) : null}

            {dshPanel === 'computer' ? (
              <div className="dsh-panel-body">
                <div className="dsh-panel-row">
                  <div>
                    <b>Computer Use</b>
                    <p>Windows-MCP 通过 MCP stdio 提供截图、点击、输入、窗口和剪贴板工具。</p>
                  </div>
                  <button
                    type="button"
                    className={`dsh-switch${computerUse ? ' on' : ''}`}
                    role="switch"
                    aria-checked={computerUse}
                    aria-busy={computerBusy}
                    onClick={() => void toggleComputerUse()}
                  >
                    <span />
                  </button>
                </div>
                <div className="dsh-panel-note">
                  <b>适配状态</b>
                  <p>
                    OpenFuture 通过本地 MCP stdio 启动 `windows-mcp@0.8.8`，只申请截图、点击、输入、窗口、
                    剪贴板等桌面工具，不启用 PowerShell、文件系统、注册表或应用启动工具。
                    首次开启会拉起 `uvx`，需要几秒准备运行时。Windows-MCP 要求桌面空闲：点击、移动、
                    输入等动作前请约 10 秒不要碰键盘和鼠标；工具会自动等待并重试，USER_CONTROL 不是故障。
                  </p>
                </div>
                <ol className="dsh-setup-steps">
                  <li>安装 uv：`powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`</li>
                  <li>确认 `uvx` 可用（本机可执行 `uvx --version`）。</li>
                  <li>开启后重新打开会话，模型会看到 `computer_*` 桌面工具。</li>
                  <li>执行桌面动作时保持约 10 秒不操作键鼠；工具会自动等待空闲。</li>
                </ol>
                <div className="dsh-panel-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      void copyAnswer('powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"').then((ok) =>
                        setNotice(ok ? '安装命令已复制。' : '复制失败。')
                      )
                    }}
                  >
                    复制安装命令
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => window.open('https://github.com/helloHub1212/dsh-windows-mcp', '_blank')}
                  >
                    查看插件文档
                  </button>
                </div>
              </div>
            ) : null}

            {dshPanel === 'more' ? (
              <div className="dsh-panel-body">
                <div className="dsh-theme-row">
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
                      onClick={() => setTheme(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button type="button" className="dsh-panel-link" onClick={() => { setDshPanel(null); setSettingsOpen(true) }}>
                  ⚙ 模型与密钥
                </button>
                <button type="button" className="dsh-panel-link" onClick={() => { setDshPanel(null); setLogsOpen(true) }}>
                  ▤ 诊断日志
                </button>
                <button type="button" className="dsh-panel-link" onClick={() => setDshPanel('about')}>
                  ◈ 关于 OpenFuture
                </button>
              </div>
            ) : null}

            {dshPanel === 'about' ? (
              <div className="dsh-panel-body">
                <div className="dsh-about-mark">◈</div>
                <h3>OpenFuture</h3>
                <p>本地优先的桌面 Agent，基于 Pi 运行时与项目级记忆。</p>
                <span className="dsh-plugin-state">v{settings?.appVersion ?? '0.2.0'} · 预览版</span>
                <div className="dsh-panel-actions">
                  <button type="button" className="secondary-button" onClick={() => window.open('https://github.com/Dushiqi1987/OpenFuture', '_blank')}>
                    打开 GitHub
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

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
