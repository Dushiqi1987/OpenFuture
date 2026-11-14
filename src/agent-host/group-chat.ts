/**
 * In-process group chat runtime.
 *
 * Two roles sit in one "group": a lead researcher that actually does the work
 * and a critic that reviews goals and evidence. Turns are strictly serial, so
 * only one session streams and calls tools at a time; shared files (workspace)
 * therefore never see concurrent writes from this feature.
 *
 * Design follows the mechanisms observed in AutoGen's SelectorGroupChat
 * (per-agent context + a shared transcript), ChatDev (phase-scoped prompts and
 * explicit conclusion markers) and llm-council (anonymous review, strict
 * output contracts, a non-authoring chair at the end).
 *
 * Like `subagent-runtime.ts` this module only imports Pi types, which keeps it
 * runnable under Node's native type stripping for offline smoke tests.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  ToolDefinition
} from '@earendil-works/pi-coding-agent'
import type {
  GroupChatEvent,
  GroupChatMessage,
  GroupChatStage,
  GroupChatStatus,
  GroupChatRole
} from '../shared/protocol'

type PiModule = typeof import('@earendil-works/pi-coding-agent')
type RuntimeModel = NonNullable<ReturnType<ModelRuntime['getModel']>>

export interface GroupChatInput {
  goal: string
  constraints?: string
  /** What the critic should focus on; empty means "everything". */
  focus?: string
  /** Rounds of work/critique/response. 1-3, default 2. */
  rounds?: number
}

export interface GroupChatRuntimeOptions {
  pi: PiModule
  modelRuntime: ModelRuntime
  model: RuntimeModel
  cwd: string
  agentDir: string
  /** Directory for role session files, normally `<sessionDir>/group`. */
  sessionDir: string
  parentSessionFile?: string
  customTools: Array<ToolDefinition<any, any, any>>
  /** Allowlist for the lead: the parent's read tools plus research tools. */
  leadTools: string[]
  /** Allowlist for the critic: read-only tools only. */
  criticTools: string[]
  settingsManager: SettingsManager
  /** Per-role model override; roles without an entry use `model`. */
  roleModels?: Partial<Record<'lead' | 'critic' | 'chair', RuntimeModel>>
  /** Non-role system-prompt extras, e.g. the current-date extension. */
  extensionFactories?: ExtensionFactory[]
  maxMessageChars?: number
  turnTimeoutMs?: number
  onEvent?: (event: GroupChatEvent) => void
}

export interface GroupChatResult {
  chatId: string
  status: GroupChatStatus
  rounds: number
  messages: GroupChatMessage[]
  /** Chair synthesis, or the last lead message when the chair failed. */
  summary: string
  durationMs: number
  error?: string
}

export const GROUP_CHAT_MIN_ROUNDS = 1
export const GROUP_CHAT_MAX_ROUNDS = 3
const DEFAULT_ROUNDS = 2
const DEFAULT_MAX_MESSAGE_CHARS = 4_000
const MAX_MESSAGE_CHARS = 8_000
const DEFAULT_TURN_TIMEOUT_MS = 180_000
const MIN_TURN_TIMEOUT_MS = 30_000
const MAX_TURN_TIMEOUT_MS = 600_000
/** Transcript budget injected per turn; older messages get compacted away. */
const TRANSCRIPT_BUDGET_CHARS = 12_000
const HISTORY_PROMPT_BUDGET_CHARS = 8_000

const LEAD_CARD = [
  '你是「主研」（team lead），群聊里的执行者。用户把一个问题或任务交给这个群，你负责把事真正做出来，然后把可验证的工作汇报发到群里。',
  '',
  '职责：',
  '1. 复述目标与拆解：用一两句话说明你怎么理解任务，以及本轮准备验证什么。',
  '2. 实际执行：调用工具读代码、检索、对照文档；每轮至少一次真实工具调用，不要只凭记忆作答。',
  '3. 汇报格式：以「【工作汇报】」开头，包含：目标复述、做了什么（工具 + 结论）、关键证据（按 E 编号引用）、不确定点。',
  '4. 回应质疑：逐条回应评审的编号质疑。接受就写清如何修订；反驳必须给出证据或可复现的验证步骤。',
  '',
  '权限与边界：',
  '- 你只有只读工作区工具与联网检索，本轮不要假设自己能改文件；需要修改时在汇报里写明补丁计划。',
  '- 结论必须有证据支撑；证据不足时明确写「假设」，不要假装已验证。',
  '- 不要为了显得礼貌而立即同意评审；也不要无视有效质疑。',
  '',
  '输出纪律：只输出本轮要贴到群里的发言，不要输出思考过程或客套话。'
].join('\n')

const CRITIC_CARD = [
  '你是「评审」（critic），群聊里的审查者。你不执行任务，只对照任务目标审查主研的汇报与证据。',
  '',
  '职责：',
  '1. 逐条质疑：每条给编号，写明依据（引用主研的 E 编号或 [#序号]）或「验证方法」。',
  '2. 指出遗漏：边界条件、失败模式、成本与安全风险、与任务目标不一致之处。',
  '3. 明确表态：最后两行必须是「立场：同意 | 存疑 | 反对」与「阻断项：有 | 无」。',
  '',
  '禁止：',
  '- 不要重复主研已经说过的内容当作意见；不要为了凑数编造风险。',
  '- 不要在没有证据时断言主研错误，给出可验证的方法即可。',
  '- 不要替主研做任务，也不要大段重写方案（那是主研的活）。',
  '',
  '输出格式（严格遵守）：',
  '【质疑】',
  '1. …（依据 E2 / 验证方法：…）',
  '2. …',
  '【可接受部分】…',
  '【立场】同意 | 存疑 | 反对',
  '【阻断项】有 | 无',
  '',
  '若确实没有新风险，写「【质疑】无新增风险」，并说明你检查过的维度；这比编造问题更有价值。'
].join('\n')

const CHAIR_CARD = [
  '你是「主持」（chair），只在讨论结束时出场做综合。你不做新的技术判断，也不引入新的主张。',
  '',
  '规则：',
  '- 按群聊记录与台账，把双方已经达成一致的内容整理成方案；每条主张标注来源（[#序号] 或 E 编号）。',
  '- 双方仍有分歧时，单列「未解决分歧」，并分别给出双方的最优版本。',
  '- 任何无法追溯到群聊记录的句子都不要写；宁可少写。',
  '',
  '输出格式：',
  '【共识】 或 【未收敛】',
  '方案：…',
  '依据：…',
  '未解决分歧：…（没有则写「无」）',
  '风险：…',
  '下一步：…'
].join('\n')

interface RoleSpec {
  id: 'lead' | 'critic' | 'chair'
  label: string
  card: string
  tools: string[]
}

interface TurnOutcome {
  text: string
  tools: string[]
  evidence: string[]
  session: AgentSession
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const typed = part as { type?: unknown; text?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
  }
  return parts.join('\n\n')
}

function extractAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | undefined
    if (!message || message.role !== 'assistant') continue
    const text = contentText(message.content).trim()
    if (text !== '') return text
  }
  return ''
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…（已截断，原文 ${text.length} 字符）`
}

function digestArgs(args: unknown): string {
  if (args === undefined) return ''
  let text: string
  try {
    text = JSON.stringify(args)
  } catch {
    text = String(args)
  }
  return text.replace(/\s+/g, ' ').slice(0, 80)
}

/** Cheap similarity for stall detection; token bigrams, order-insensitive. */
function similarity(left: string, right: string): number {
  const tokens = (text: string): Set<string> => {
    const normalized = text.replace(/[\s\p{P}]+/gu, '').slice(0, 2_000)
    const set = new Set<string>()
    for (let index = 0; index + 1 < normalized.length; index += 1) {
      set.add(normalized.slice(index, index + 2))
    }
    return set
  }
  const a = tokens(left)
  const b = tokens(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return (2 * shared) / (a.size + b.size)
}

function stanceOf(text: string, role: 'lead' | 'critic'): { agree: boolean; blocked: boolean } {
  const stanceMatch = text.match(/【?立场】?\s*[:：]?\s*(同意|接受|存疑|反对)/)
  const stance = stanceMatch?.[1] ?? ''
  const blockerMatch = text.match(/【?阻断项】?\s*[:：]?\s*(有|无|没有)/)
  const blocker = blockerMatch?.[1] ?? ''
  return {
    agree: stance === '同意' || stance === '接受',
    blocked: role === 'critic' ? blocker === '有' : false
  }
}

function roleExtension(card: string): ExtensionFactory {
  return (api: any) => {
    api.on('before_agent_start', async (event: { systemPrompt?: string }) => {
      return {
        systemPrompt: [`<group_role>\n${card}\n</group_role>`, event.systemPrompt ?? '']
          .filter((part) => part !== '')
          .join('\n\n')
      }
    })
  }
}

function formatMessage(message: GroupChatMessage): string {
  const header = `[#${message.seq} ${message.roleLabel}/${stageLabel(message.stage)}]`
  const evidence = message.tools.length > 0 ? `\n（本轮工具：${message.tools.join('、')}）` : ''
  return `${header}\n${message.text}${evidence}`
}

function stageLabel(stage: GroupChatStage): string {
  switch (stage) {
    case 'work':
      return '工作汇报'
    case 'critique':
      return '质疑'
    case 'response':
      return '回应'
    case 'chair':
      return '共识'
  }
}

export class GroupChatRuntime {
  private readonly options: GroupChatRuntimeOptions
  private readonly maxMessageChars: number
  private readonly turnTimeoutMs: number
  private readonly sessions = new Map<string, AgentSession>()
  private readonly controller = new AbortController()
  private closed = false

  constructor(options: GroupChatRuntimeOptions) {
    this.options = options
    this.maxMessageChars = clampInt(
      options.maxMessageChars,
      DEFAULT_MAX_MESSAGE_CHARS,
      500,
      MAX_MESSAGE_CHARS
    )
    this.turnTimeoutMs = clampInt(
      options.turnTimeoutMs,
      DEFAULT_TURN_TIMEOUT_MS,
      MIN_TURN_TIMEOUT_MS,
      MAX_TURN_TIMEOUT_MS
    )
  }

  get maxRounds(): number {
    return GROUP_CHAT_MAX_ROUNDS
  }

  get activeCount(): number {
    return this.sessions.size
  }

  abortAll(): void {
    this.controller.abort()
    for (const session of this.sessions.values()) {
      void session.abort().catch(() => undefined)
    }
  }

  dispose(): void {
    this.closed = true
    this.abortAll()
    this.endChat()
  }

  /** Close the cached role sessions without closing the runtime itself. */
  private endChat(): void {
    for (const session of this.sessions.values()) {
      try {
        session.dispose()
      } catch {
        // The host may be shutting down; dispose failures are not actionable.
      }
    }
    this.sessions.clear()
  }

  async run(input: GroupChatInput, options: { signal?: AbortSignal } = {}): Promise<GroupChatResult> {
    const startedAt = Date.now()
    const chatId = `gc-${randomUUID().slice(0, 8)}`
    const goal = input.goal.trim()
    if (goal === '') throw new Error('goal 不能为空')
    const rounds = clampInt(input.rounds, DEFAULT_ROUNDS, GROUP_CHAT_MIN_ROUNDS, GROUP_CHAT_MAX_ROUNDS)
    const constraints = input.constraints?.trim() ?? ''
    const focus = input.focus?.trim() ?? ''

    const lead: RoleSpec = {
      id: 'lead',
      label: '主研',
      card: LEAD_CARD,
      tools: this.options.leadTools
    }
    const critic: RoleSpec = {
      id: 'critic',
      label: '评审',
      card: CRITIC_CARD,
      tools: this.options.criticTools
    }
    const chair: RoleSpec = {
      id: 'chair',
      label: '主持',
      card: CHAIR_CARD,
      tools: []
    }
    const roles: GroupChatRole[] = [lead, critic, chair].map((role) => ({
      id: role.id,
      label: role.label
    }))

    const messages: GroupChatMessage[] = []
    const delivered = new Map<string, number>([[lead.id, 0], [critic.id, 0], [chair.id, 0]])
    const emit = (event: GroupChatEvent): void => {
      try {
        this.options.onEvent?.(event)
      } catch {
        // UI callbacks must never break a group chat.
      }
    }

    this.emitStart(emit, chatId, goal, roles, rounds)
    const finish = (
      status: GroupChatStatus,
      summary: string,
      error?: string
    ): GroupChatResult => {
      // A chat is a self-contained discussion: drop its role sessions so the
      // next chat cannot inherit this transcript (and its cost) by accident.
      this.endChat()
      const result: GroupChatResult = {
        chatId,
        status,
        rounds: messages.filter((message) => message.stage === 'work' || message.stage === 'response').length,
        messages,
        summary,
        durationMs: Date.now() - startedAt
      }
      if (error) result.error = error
      emit({ type: 'end', chatId, status, rounds: result.rounds, durationMs: result.durationMs, ...(error ? { error } : {}) })
      return result
    }

    const sources = [this.controller.signal]
    if (options.signal) sources.push(options.signal)
    const combined = combineSignals(sources)

    try {
      let converged = false
      let stalled = false
      let lastCritique = ''
      let actualRounds = 0

      for (let round = 1; round <= rounds && !converged && !stalled; round += 1) {
        if (combined.signal.aborted) return finish('aborted', '群聊已取消', '已取消')
        actualRounds = round

        const phase: GroupChatStage = round === 1 ? 'work' : 'response'
        const leadTurn = await this.speak(lead, phase, round, rounds, {
          goal,
          constraints,
          focus,
          messages,
          delivered,
          instruction:
            round === 1
              ? '本轮任务：拆解目标并实际执行第一轮调查，然后把【工作汇报】贴到群里。'
              : '本轮任务：逐条回应评审的质疑，接受的部分写清修订，反驳的部分给出证据；最后给出你的立场。'
        }, combined.signal)
        if (combined.signal.aborted) return finish('aborted', '群聊已取消', '已取消')
        const leadMessage = this.appendMessage(messages, lead, phase, leadTurn)
        emit({ type: 'message', chatId, message: leadMessage })

        const criticTurn = await this.speak(critic, 'critique', round, rounds, {
          goal,
          constraints,
          focus,
          messages,
          delivered,
          instruction:
            round === 1
              ? '本轮任务：审查上面这轮工作汇报，按格式给出质疑、可接受部分、立场与阻断项。'
              : '本轮任务：审查最新回应与修订，只提新的或仍未解决的问题，并按格式表态。'
        }, combined.signal)
        if (combined.signal.aborted) return finish('aborted', '群聊已取消', '已取消')
        const criticMessage = this.appendMessage(messages, critic, 'critique', criticTurn)
        emit({ type: 'message', chatId, message: criticMessage })

        const leadStance = stanceOf(leadMessage.text, 'lead')
        const criticStance = stanceOf(criticMessage.text, 'critic')
        converged = round >= GROUP_CHAT_MIN_ROUNDS && criticStance.agree && !criticStance.blocked && leadStance.agree

        const noTools = criticTurn.tools.length === 0 && leadTurn.tools.length === 0
        if (
          !converged &&
          round >= 2 &&
          noTools &&
          lastCritique !== '' &&
          similarity(lastCritique, criticMessage.text) > 0.9
        ) {
          stalled = true
        }
        lastCritique = criticMessage.text
      }

      if (combined.signal.aborted) return finish('aborted', '群聊已取消', '已取消')

      if (converged) {
        const chairTurn = await this.speak(chair, 'chair', actualRounds, rounds, {
          goal,
          constraints,
          focus,
          messages,
          delivered,
          instruction:
            '本轮任务：讨论已收敛。按格式输出【共识】：方案、依据、未解决分歧（无则写「无」）、风险、下一步。',
          fullTranscript: true
        }, combined.signal)
        const chairMessage = this.appendMessage(messages, chair, 'chair', chairTurn)
        emit({ type: 'message', chatId, message: chairMessage })
        return finish('consensus', chairMessage.text)
      }

      const chairTurn = await this.speak(chair, 'chair', actualRounds, rounds, {
        goal,
        constraints,
        focus,
        messages,
        delivered,
        instruction: stalled
          ? '本轮任务：讨论在原地打转，判为停滞。按格式输出【未收敛】：双方最优版本、仍存在的分歧、以及需要用户裁决的问题。'
          : `本轮任务：${rounds} 轮内未达成一致。按格式输出【未收敛】：双方最优版本、仍存在的分歧、以及需要用户裁决的问题。`,
        fullTranscript: true
      }, combined.signal)
      const chairMessage = this.appendMessage(messages, chair, 'chair', chairTurn)
      emit({ type: 'message', chatId, message: chairMessage })
      return finish(stalled ? 'stalled' : 'unresolved', chairMessage.text)
    } catch (error) {
      const message = errorMessage(error)
      if (combined.signal.aborted) return finish('aborted', '群聊已取消', message)
      return finish('failed', `群聊失败：${message}`, message)
    } finally {
      combined.dispose()
    }
  }

  private emitStart(
    emit: (event: GroupChatEvent) => void,
    chatId: string,
    goal: string,
    roles: GroupChatRole[],
    rounds: number
  ): void {
    emit({ type: 'start', chatId, goal, roles, rounds })
  }

  private appendMessage(
    messages: GroupChatMessage[],
    role: RoleSpec,
    stage: GroupChatStage,
    turn: TurnOutcome
  ): GroupChatMessage {
    const message: GroupChatMessage = {
      seq: messages.length + 1,
      roleId: role.id,
      roleLabel: role.label,
      stage,
      text: truncate(turn.text, this.maxMessageChars),
      tools: turn.evidence
    }
    messages.push(message)
    return message
  }

  /** Run one serial turn for `role` and return its text plus evidence. */
  private async speak(
    role: RoleSpec,
    stage: GroupChatStage,
    round: number,
    rounds: number,
    context: {
      goal: string
      constraints: string
      focus: string
      messages: GroupChatMessage[]
      delivered: Map<string, number>
      instruction: string
      fullTranscript?: boolean
    },
    signal: AbortSignal
  ): Promise<TurnOutcome> {
    if (this.closed) throw new Error('群聊运行时已关闭')
    if (signal.aborted) throw new Error('已取消')

    const session = await this.ensureSession(role)
    const prompt = this.buildPrompt(role, round, rounds, context)
    const tools: string[] = []
    const evidence: string[] = []
    let evidenceSeq = context.messages.reduce((count, message) => count + message.tools.length, 0)

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type !== 'tool_execution_start') return
      const toolName = (event as { toolName?: string }).toolName ?? 'tool'
      const args = (event as { args?: unknown }).args
      tools.push(toolName)
      evidenceSeq += 1
      evidence.push(`E${evidenceSeq} ${toolName}${args === undefined ? '' : `(${digestArgs(args)})`}`)
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      void session.abort().catch(() => undefined)
    }, this.turnTimeoutMs)
    const onAbort = (): void => {
      void session.abort().catch(() => undefined)
    }
    signal.addEventListener('abort', onAbort, { once: true })

    let failure: unknown = null
    try {
      await session.prompt(prompt, { expandPromptTemplates: false })
    } catch (error) {
      failure = error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      unsubscribe()
    }

    if (signal.aborted) throw new Error('已取消')
    if (failure) throw new Error(`${role.label}发言失败：${errorMessage(failure)}`)
    if (timedOut) throw new Error(`${role.label}发言超时（${Math.round(this.turnTimeoutMs / 1000)} 秒）`)

    const text = extractAssistantText(session.messages).trim()
    if (text === '') {
      // Real providers may end a turn with a tool call, a refusal, or a
      // provider-side error and no visible text. Surface what actually arrived
      // instead of a bare "no text" so the panel can explain the failure.
      const last = session.messages[session.messages.length - 1] as
        | { role?: unknown; stopReason?: unknown; content?: unknown; errorMessage?: unknown }
        | undefined
      const detail = {
        stopReason: last?.stopReason ?? null,
        role: last?.role ?? null,
        errorMessage: typeof last?.errorMessage === 'string' ? last.errorMessage.slice(0, 300) : null,
        content: JSON.stringify(last?.content ?? null).slice(0, 400),
        raw: JSON.stringify(last ?? null).slice(0, 800),
        messages: session.messages.length
      }
      console.error(`[group-chat] ${role.label} returned no text`, detail)
      throw new Error(
        `${role.label}没有返回文本（stopReason=${String(detail.stopReason ?? 'unknown')}，` +
          `${detail.errorMessage ? `错误：${detail.errorMessage}` : `content=${detail.content === 'null' ? 'empty' : detail.content}`}）`
      )
    }
    return { text, tools, evidence, session }
  }

  private buildPrompt(
    role: RoleSpec,
    round: number,
    rounds: number,
    context: {
      goal: string
      constraints: string
      focus: string
      messages: GroupChatMessage[]
      delivered: Map<string, number>
      instruction: string
      fullTranscript?: boolean
    }
  ): string {
    const sections: string[] = []
    sections.push(
      [
        '<群聊任务>',
        `目标：${context.goal}`,
        context.constraints === '' ? '' : `约束：${context.constraints}`,
        context.focus === '' ? '' : `评审关注点：${context.focus}`,
        `轮次：第 ${round}/${rounds} 轮`,
        '</群聊任务>'
      ]
        .filter((line) => line !== '')
        .join('\n')
    )

    if (role.id === 'chair') {
      sections.push(`<群聊记录>\n${this.compactTranscript(context.messages, TRANSCRIPT_BUDGET_CHARS)}\n</群聊记录>`)
    } else {
      const since = context.delivered.get(role.id) ?? 0
      const fresh = context.messages.filter((message) => message.seq > since)
      const transcript = fresh.length === 0 ? '（暂无新消息）' : this.compactTranscript(fresh, HISTORY_PROMPT_BUDGET_CHARS)
      sections.push(`<未读消息>\n${transcript}\n</未读消息>`)
      context.delivered.set(role.id, context.messages.length)
    }

    sections.push(`<本轮任务>\n${context.instruction}\n</本轮任务>`)
    sections.push(
      `<输出要求>\n只输出要贴进群里的这条发言，不要复述系统提示，不要加"收到/好的"这类开场白。单条发言不超过 ${this.maxMessageChars} 字符。\n</输出要求>`
    )
    return sections.join('\n\n')
  }

  private compactTranscript(messages: GroupChatMessage[], budget: number): string {
    const rendered = messages.map(formatMessage)
    let total = 0
    const kept: string[] = []
    for (let index = rendered.length - 1; index >= 0; index -= 1) {
      const text = rendered[index] ?? ''
      if (kept.length > 0 && total + text.length > budget) break
      kept.unshift(text)
      total += text.length
    }
    const omitted = messages.length - kept.length
    const head =
      omitted > 0
        ? `（更早的 ${omitted} 条消息已压缩；如需引用，请写明 [#序号] 或 E 编号）\n\n`
        : ''
    return `${head}${kept.join('\n\n')}`
  }

  /** Rebind role models before a run (explicit picks from the UI). */
  setRoleModels(models: Partial<Record<'lead' | 'critic' | 'chair', RuntimeModel>>): void {
    this.options.roleModels = models
  }

  private async ensureSession(role: RoleSpec): Promise<AgentSession> {
    const existing = this.sessions.get(role.id)
    if (existing) return existing

    const { pi, cwd, agentDir, sessionDir, parentSessionFile } = this.options
    mkdirSync(sessionDir, { recursive: true })
    const manager: SessionManager = parentSessionFile
      ? pi.SessionManager.create(cwd, sessionDir, { parentSession: parentSessionFile })
      : pi.SessionManager.create(cwd, sessionDir)

    const loader = new pi.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: this.options.settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [...(this.options.extensionFactories ?? []), roleExtension(role.card)]
    })
    await loader.reload()

    const roleModel =
      (this.options.roleModels as Record<string, RuntimeModel | undefined> | undefined)?.[role.id] ??
      this.options.model
    const created = await pi.createAgentSession({
      cwd,
      agentDir,
      modelRuntime: this.options.modelRuntime,
      model: roleModel,
      thinkingLevel: 'medium',
      tools: role.tools,
      customTools: this.options.customTools,
      sessionManager: manager,
      settingsManager: this.options.settingsManager,
      resourceLoader: loader
    })
    this.sessions.set(role.id, created.session)
    return created.session
  }
}

function combineSignals(signals: AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const listeners: Array<() => void> = []
  const onAbort = (): void => controller.abort()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', onAbort, { once: true })
    listeners.push(() => signal.removeEventListener('abort', onAbort))
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const remove of listeners) remove()
    }
  }
}
