/**
 * Runtime-local inbox with correlation-based waiting.
 *
 * Two properties matter for the multi-agent demo:
 *  - idempotent send via `clientMessageId`, because a crashed caller may retry;
 *  - a waiting task frees its scheduler slot while its peer request timeout is
 *    still enforced.
 *
 * The inbox is deliberately in-memory: the engine persists every message into
 * the run snapshot, so a restart hydrates the inbox from durable state.
 */

import { TeamError, TaskFailureError, abortError } from './errors.ts'
import type {
  AgentRegistration,
  AgentSendInput,
  InboxMessage,
  MessageType,
  RoleId
} from './types.ts'
import { createIdFactory, systemClock, type Clock, type IdFactory } from './util.ts'

export interface InboxOptions {
  runId: string
  projectId: string
  clock?: Clock
  idFactory?: IdFactory
  initialMessages?: readonly InboxMessage[]
}

export interface InboxSendResult {
  message: InboxMessage
  duplicate: boolean
}

export interface InboxWaitOptions {
  timeoutMs: number
  /** Only consume messages with this correlation id. */
  correlationId?: string
  /** Correlation ids this task is willing to consume (for wait cycle detection). */
  consumes?: readonly string[]
  /** Correlation ids this task issued and expects replies for. */
  issues?: readonly string[]
  signal?: AbortSignal
}

export interface InboxWaitOutcome {
  messages: InboxMessage[]
  waitedMs: number
}

const MESSAGE_TYPES: readonly MessageType[] = [
  'request',
  'reply',
  'contract',
  'artifact',
  'blocker',
  'review'
]

interface Waiter {
  agentId: string
  correlationId?: string
  consumes: Set<string>
  issues: Set<string>
  startedAt: number
  timer: ReturnType<typeof setTimeout>
  settle: (outcome: InboxWaitOutcome | Error) => void
  cleanup: () => void
}

export class Inbox {
  readonly runId: string
  readonly projectId: string
  private readonly clock: Clock
  private readonly ids: IdFactory
  private readonly registrations = new Map<string, AgentRegistration>()
  private readonly roleIndex = new Map<RoleId, Set<string>>()
  private readonly messages: InboxMessage[] = []
  private readonly byClientId = new Map<string, InboxMessage>()
  private readonly waiters = new Map<string, Waiter>()
  private seq = 0

  constructor(options: InboxOptions) {
    this.runId = options.runId
    this.projectId = options.projectId
    this.clock = options.clock ?? systemClock
    this.ids = options.idFactory ?? createIdFactory()
    if (options.initialMessages) this.hydrate(options.initialMessages)
  }

  register(registration: AgentRegistration): void {
    if (!registration.agentId || !registration.taskId) {
      throw new TeamError('inbox-invalid-registration', 'agentId and taskId are required')
    }
    if (this.registrations.has(registration.agentId)) {
      throw new TeamError('inbox-agent-exists', `agent ${registration.agentId} is already registered`)
    }
    this.registrations.set(registration.agentId, { ...registration })
    let agents = this.roleIndex.get(registration.role)
    if (!agents) {
      agents = new Set()
      this.roleIndex.set(registration.role, agents)
    }
    agents.add(registration.agentId)
  }

  unregister(agentId: string): void {
    const registration = this.registrations.get(agentId)
    if (!registration) return
    this.registrations.delete(agentId)
    this.roleIndex.get(registration.role)?.delete(agentId)
    const waiter = this.waiters.get(agentId)
    if (waiter) {
      waiter.cleanup()
      waiter.settle(new TeamError('inbox-agent-unregistered', `agent ${agentId} was unregistered`))
    }
  }

  registrationOf(agentId: string): AgentRegistration | undefined {
    const registration = this.registrations.get(agentId)
    return registration ? { ...registration } : undefined
  }

  send(fromAgentId: string, input: AgentSendInput): InboxSendResult {
    const sender = this.registrations.get(fromAgentId)
    if (!sender) {
      throw new TeamError('inbox-unknown-sender', `agent ${fromAgentId} is not registered`)
    }
    if (!MESSAGE_TYPES.includes(input.type)) {
      throw new TeamError('inbox-invalid-message', `unsupported message type ${String(input.type)}`)
    }
    if (typeof input.body !== 'string' || input.body.trim().length === 0) {
      throw new TeamError('inbox-invalid-message', 'message body must be a non-empty string')
    }
    if ((input.toAgentId ? 1 : 0) + (input.toRole ? 1 : 0) !== 1) {
      throw new TeamError('inbox-invalid-target', 'exactly one of toAgentId or toRole is required')
    }
    if (input.type !== 'request' && !input.correlationId) {
      throw new TeamError('inbox-correlation-required', `${input.type} messages require a correlationId`)
    }
    for (const artifactRef of input.artifactRefs ?? []) {
      if (typeof artifactRef !== 'string' || artifactRef.length === 0) {
        throw new TeamError('inbox-invalid-message', 'artifactRefs must contain non-empty artifact ids')
      }
    }

    const clientMessageId = input.clientMessageId?.trim() || `auto-${this.ids.message()}`
    const dedupeKey = `${fromAgentId}::${clientMessageId}`
    const existing = this.byClientId.get(dedupeKey)
    if (existing) {
      return { message: { ...existing, duplicate: true }, duplicate: true }
    }

    const target = this.resolveTarget(input)
    const now = this.clock.now()
    const message: InboxMessage = {
      id: this.ids.message(),
      runId: this.runId,
      projectId: this.projectId,
      taskId: sender.taskId,
      clientMessageId,
      fromAgentId: sender.agentId,
      toAgentId: target.agentId,
      fromRole: sender.role,
      toRole: target.role,
      correlationId: input.correlationId?.trim() || '',
      type: input.type,
      body: input.body.trim(),
      artifactRefs: [...(input.artifactRefs ?? [])],
      createdAt: now,
      seq: ++this.seq
    }
    if (!message.correlationId) message.correlationId = message.id

    this.messages.push(message)
    this.byClientId.set(dedupeKey, message)
    this.notifyWaiters()
    return { message, duplicate: false }
  }

  private resolveTarget(input: AgentSendInput): AgentRegistration {
    if (input.toAgentId) {
      const target = this.registrations.get(input.toAgentId)
      if (!target) {
        throw new TeamError('inbox-unknown-target', `agent ${input.toAgentId} is not registered`)
      }
      return target
    }
    const agents = this.roleIndex.get(input.toRole as RoleId)
    if (!agents || agents.size === 0) {
      throw new TeamError('inbox-unknown-role', `no registered agent has role ${String(input.toRole)}`)
    }
    if (agents.size > 1) {
      throw new TeamError(
        'inbox-ambiguous-role',
        `role ${String(input.toRole)} is served by ${agents.size} agents; address the agent or task explicitly`
      )
    }
    const agentId = [...agents][0]
    const target = agentId ? this.registrations.get(agentId) : undefined
    if (!target) throw new TeamError('inbox-unknown-target', `role ${String(input.toRole)} is not available`)
    return target
  }

  async waitForMessages(agentId: string, options: InboxWaitOptions): Promise<InboxWaitOutcome> {
    if (!this.registrations.has(agentId)) {
      throw new TeamError('inbox-unknown-agent', `agent ${agentId} is not registered`)
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new TeamError('inbox-invalid-timeout', 'timeoutMs must be positive')
    }
    if (this.waiters.has(agentId)) {
      throw new TeamError('inbox-already-waiting', `agent ${agentId} already has an active wait`)
    }
    if (options.signal?.aborted) throw abortError(options.signal)

    const alreadyPending = this.takeUndelivered(agentId, options.correlationId)
    if (alreadyPending.length > 0) {
      return { messages: alreadyPending, waitedMs: 0 }
    }

    const consumes = new Set(options.consumes ?? (options.correlationId ? [options.correlationId] : []))
    const issues = new Set(options.issues ?? [])
    const cycle = this.detectCycle(agentId, consumes, issues)
    if (cycle) {
      throw new TeamError('inbox-wait-cycle', 'tasks are waiting on each other', { cycle })
    }

    return await new Promise<InboxWaitOutcome>((resolve, reject) => {
      const startedAt = this.clock.now()
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = (): void => {
        cleanup()
        reject(abortError(options.signal))
      }
      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        this.waiters.delete(agentId)
        options.signal?.removeEventListener('abort', onAbort)
      }
      const settle = (outcome: InboxWaitOutcome | Error): void => {
        cleanup()
        if (outcome instanceof Error) reject(outcome)
        else resolve(outcome)
      }
      const waiter: Waiter = {
        agentId,
        correlationId: options.correlationId,
        consumes,
        issues,
        startedAt,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        settle,
        cleanup
      }
      timer = setTimeout(() => {
        const waitedMs = this.clock.now() - startedAt
        settle(
          new TaskFailureError(
            'inbox-timeout',
            `no matching message arrived for agent ${agentId} within ${options.timeoutMs}ms`,
            {
              retryable: true,
              retryAfterMs: 250,
              details: {
                agentId,
                timeoutMs: options.timeoutMs,
                correlationId: options.correlationId ?? null,
                waitedMs
              }
            }
          )
        )
      }, options.timeoutMs)
      waiter.timer = timer
      this.waiters.set(agentId, waiter)
      options.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private detectCycle(agentId: string, consumes: Set<string>, issues: Set<string>): string[] | null {
    if (consumes.size === 0 || issues.size === 0) return null
    for (const [otherId, other] of this.waiters) {
      if (otherId === agentId) continue
      const otherConsumesMine = [...other.consumes].some((id) => issues.has(id))
      const iConsumeOther = [...consumes].some((id) => other.issues.has(id))
      if (otherConsumesMine && iConsumeOther) {
        const shared = [...consumes].filter((id) => other.issues.has(id))
        return [agentId, otherId, ...(shared[0] ? [shared[0]] : [])]
      }
    }
    return null
  }

  private notifyWaiters(): void {
    for (const waiter of [...this.waiters.values()]) {
      const messages = this.takeUndelivered(waiter.agentId, waiter.correlationId)
      if (messages.length === 0) continue
      const waitedMs = this.clock.now() - waiter.startedAt
      waiter.settle({ messages, waitedMs })
    }
  }

  private takeUndelivered(agentId: string, correlationId?: string): InboxMessage[] {
    const now = this.clock.now()
    const taken: InboxMessage[] = []
    for (const message of this.messages) {
      if (message.toAgentId !== agentId || message.deliveredAt !== undefined) continue
      if (correlationId && message.correlationId !== correlationId) continue
      message.deliveredAt = now
      taken.push(message)
    }
    return taken.map((message) => ({ ...message }))
  }

  /** Poll without blocking; useful for workers that are not waiting. */
  drain(agentId: string, correlationId?: string): InboxMessage[] {
    if (!this.registrations.has(agentId)) return []
    return this.takeUndelivered(agentId, correlationId)
  }

  pendingCount(agentId: string): number {
    return this.messages.filter((message) => message.toAgentId === agentId && message.deliveredAt === undefined)
      .length
  }

  ack(agentId: string, messageId: string): InboxMessage {
    const message = this.messages.find((candidate) => candidate.id === messageId)
    if (!message) throw new TeamError('inbox-unknown-message', `message ${messageId} does not exist`)
    if (message.toAgentId !== agentId) {
      throw new TeamError('inbox-wrong-recipient', `agent ${agentId} cannot ack message ${messageId}`)
    }
    if (message.deliveredAt === undefined) {
      throw new TeamError('inbox-not-delivered', `message ${messageId} has not been delivered`)
    }
    if (message.ackedAt === undefined) message.ackedAt = this.clock.now()
    return { ...message }
  }

  list(filter: { agentId?: string; taskId?: string; correlationId?: string } = {}): InboxMessage[] {
    return this.messages
      .filter((message) => {
        if (filter.agentId && message.toAgentId !== filter.agentId && message.fromAgentId !== filter.agentId) {
          return false
        }
        if (filter.taskId && message.taskId !== filter.taskId) return false
        if (filter.correlationId && message.correlationId !== filter.correlationId) return false
        return true
      })
      .map((message) => ({ ...message }))
  }

  exportMessages(): InboxMessage[] {
    return this.messages.map((message) => ({ ...message }))
  }

  get waitingAgentIds(): string[] {
    return [...this.waiters.keys()]
  }

  private hydrate(messages: readonly InboxMessage[]): void {
    for (const message of messages) {
      if (message.runId !== this.runId || message.projectId !== this.projectId) {
        throw new TeamError('inbox-hydrate-mismatch', `message ${message.id} belongs to another run`)
      }
      this.messages.push({ ...message })
      const key = `${message.fromAgentId}::${message.clientMessageId}`
      this.byClientId.set(key, this.messages[this.messages.length - 1] as InboxMessage)
      this.seq = Math.max(this.seq, message.seq)
    }
  }
}
