/**
 * Local Pi-compatible mock endpoint for M1.
 *
 * This is a deterministic session host, not a model. It exists to exercise the
 * adapter's real lifecycle: one session per task, SSE streaming, tool requests,
 * inbox round-trips, cancellation, failures and resumable disconnects.
 *
 * Run standalone:  node scripts/mock-pi-server.ts
 * Default address: http://127.0.0.1:19734
 */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import type {
  PiInput,
  PiSessionEvent,
  PiSessionSnapshot,
  PiSessionSpec,
  PiStats
} from '../src/pi/types.ts'

export const MOCK_PI_PORT = 19734

type TerminalStatus = 'completed' | 'failed' | 'cancelled'
type SessionStatus = 'created' | 'running' | 'disconnected' | TerminalStatus
type InputOrCancel = PiInput | { type: 'cancelled' }
type PiEventBody<T> = T extends unknown ? Omit<T, 'seq' | 'at'> : never

interface InputWaiter {
  predicate: (input: PiInput) => boolean
  resolve: (input: InputOrCancel) => void
}

interface MockSession {
  id: string
  spec: PiSessionSpec
  status: SessionStatus
  seq: number
  events: PiSessionEvent[]
  res: ServerResponse | undefined
  started: boolean
  inputs: PiInput[]
  inputWaiters: InputWaiter[]
  resumeWaiters: Array<() => void>
  deltas: number
}

export interface MockPiServerOptions {
  host?: string
  port?: number
}

export interface MockPiServer {
  url: string
  port: number
  readonly stats: PiStats
  close(): Promise<void>
}

const terminalStatuses = new Set<SessionStatus>(['completed', 'failed', 'cancelled'])

export async function startMockPiServer(options: MockPiServerOptions = {}): Promise<MockPiServer> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? MOCK_PI_PORT
  const sessions = new Map<string, MockSession>()
  let created = 0
  let maxActive = 0
  let resumes = 0
  let closed = false
  let counter = 0

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      if (res.headersSent) {
        res.end()
      } else {
        sendJson(res, 500, { error: 'mock-internal', message: error instanceof Error ? error.message : String(error) })
      }
    })
  })

  const stats = (): PiStats => {
    const snapshots: PiSessionSnapshot[] = [...sessions.values()].map((session) => ({
      sessionId: session.id,
      status: session.status,
      attempt: session.spec.attempt,
      role: session.spec.role,
      taskId: session.spec.taskId,
      events: session.events.length,
      deltas: session.deltas
    }))
    return {
      created,
      active: snapshots.filter((session) => session.status === 'running').length,
      maxActive,
      completed: snapshots.filter((session) => session.status === 'completed').length,
      failed: snapshots.filter((session) => session.status === 'failed').length,
      cancelled: snapshots.filter((session) => session.status === 'cancelled').length,
      resumes,
      sessions: snapshots
    }
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`)
    const method = req.method ?? 'GET'
    const pathname = decodeURIComponent(url.pathname)

    if (method === 'GET' && pathname === '/v1/health') {
      sendJson(res, 200, { ok: true, protocolVersion: '1.0', sessions: sessions.size })
      return
    }
    if (method === 'GET' && pathname === '/v1/debug/stats') {
      sendJson(res, 200, stats())
      return
    }
    if (method === 'POST' && pathname === '/v1/sessions') {
      const body = await readJson(req)
      const spec = validateSpec(body)
      counter += 1
      const id = `pi-${counter}-${randomUUID().slice(0, 8)}`
      const session: MockSession = {
        id,
        spec,
        status: 'created',
        seq: 0,
        events: [],
        res: undefined,
        started: false,
        inputs: [],
        inputWaiters: [],
        resumeWaiters: [],
        deltas: 0
      }
      sessions.set(id, session)
      created += 1
      sendJson(res, 201, { sessionId: id, status: 'created' })
      return
    }

    const match = /^\/v1\/sessions\/([^/]+)(?:\/(events|input|cancel|resume))?$/.exec(pathname)
    if (!match) {
      sendJson(res, 404, { error: 'not-found', path: pathname })
      return
    }
    const sessionId = match[1] as string
    const action = match[2]
    const session = sessions.get(sessionId)
    if (!session) {
      sendJson(res, 404, { error: 'unknown-session', sessionId })
      return
    }

    if (method === 'GET' && action === 'events') {
      const after = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? '0')
      openEventStream(session, res, Number.isFinite(after) ? after : 0)
      return
    }
    if (method === 'POST' && action === 'input') {
      const input = await readJson(req)
      const inputType =
        input && typeof input === 'object' && 'type' in input ? (input as { type?: unknown }).type : undefined
      if (typeof inputType !== 'string') {
        sendJson(res, 400, { error: 'invalid-input' })
        return
      }
      pushInput(session, input as PiInput)
      sendJson(res, 202, { accepted: true })
      return
    }
    if (method === 'POST' && action === 'cancel') {
      if (terminalStatuses.has(session.status)) {
        sendJson(res, 200, { cancelled: false, status: session.status })
        return
      }
      cancelSession(session)
      sendJson(res, 200, { cancelled: true })
      return
    }
    if (method === 'POST' && action === 'resume') {
      if (session.status === 'failed' || session.status === 'completed' || session.status === 'cancelled') {
        sendJson(res, 409, { error: 'not-resumable', status: session.status })
        return
      }
      if (session.status === 'disconnected' || session.status === 'created') {
        session.status = 'running'
        resumes += 1
        emit(session, { type: 'session.resumed' })
        const waiters = session.resumeWaiters.splice(0)
        for (const resolve of waiters) resolve()
      }
      sendJson(res, 200, { sessionId: session.id, status: session.status })
      return
    }
    if (method === 'GET' && action === undefined) {
      sendJson(res, 200, {
        sessionId: session.id,
        status: session.status,
        attempt: session.spec.attempt,
        role: session.spec.role,
        taskId: session.spec.taskId,
        events: session.events.length,
        deltas: session.deltas
      })
      return
    }
    sendJson(res, 405, { error: 'method-not-allowed' })
  }

  function openEventStream(session: MockSession, res: ServerResponse, after: number): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    res.write('retry: 30\n\n')
    session.res = res
    if (!terminalStatuses.has(session.status)) {
      session.status = 'running'
      maxActive = Math.max(maxActive, stats().active)
    }
    for (const event of session.events) {
      if (event.seq > after) writeSse(res, event)
    }
    res.on('close', () => {
      if (session.res === res) session.res = undefined
    })
    res.on('error', () => {
      if (session.res === res) session.res = undefined
    })
    if (!session.started && !terminalStatuses.has(session.status)) {
      session.started = true
      void runScript(session).catch((error) => {
        if (terminalStatuses.has(session.status) || session.status === 'disconnected') return
        failSession(session, {
          code: 'mock-script-error',
          message: error instanceof Error ? error.message : String(error),
          retryable: false
        })
      })
    }
    res.flushHeaders()
  }

  async function runScript(session: MockSession): Promise<void> {
    emit(session, { type: 'session.started', sessionId: session.id })
    const scenario = session.spec.scenario ?? 'simple'
    switch (scenario) {
      case 'simple':
      case 'parallel': {
        await delay(scenario === 'parallel' ? 80 : 10)
        emit(session, { type: 'message.delta', text: `${session.spec.role} session ${session.id} is streaming` })
        await delay(10)
        completeSession(session, `${session.spec.role} completed ${session.spec.taskId}`)
        return
      }
      case 'message-researcher': {
        emit(session, { type: 'message.delta', text: 'researcher waiting for a backend request' })
        const requestId = nextRequestId(session)
        const wait = waitForInput(session, requestId, 'inbox.messages')
        emit(session, {
          type: 'inbox.wait',
          requestId,
          correlationId: 'pi:research',
          timeoutMs: 5_000
        })
        const input = await wait
        if (input.type === 'cancelled' || session.status === 'cancelled') return
        const messages = input.type === 'inbox.messages' ? input.messages : []
        emit(session, { type: 'message.delta', text: `researcher received ${messages.length} message(s)` })
        emit(session, {
          type: 'inbox.send',
          requestId: nextRequestId(session),
          input: {
            toRole: 'backend',
            clientMessageId: `${session.spec.taskId}:reply`,
            correlationId: 'pi:research',
            type: 'reply',
            body: 'Research reply produced from the Pi session mock.'
          }
        })
        await delay(10)
        completeSession(session, 'researcher replied over the Pi session inbox', [
          { id: 'pi-inbox-reply', status: 'passed', detail: 'reply correlated on pi:research' }
        ])
        return
      }
      case 'message-backend': {
        emit(session, { type: 'message.delta', text: 'backend asking the researcher for evidence' })
        emit(session, {
          type: 'inbox.send',
          requestId: nextRequestId(session),
          input: {
            toRole: 'researcher',
            clientMessageId: `${session.spec.taskId}:request`,
            correlationId: 'pi:research',
            type: 'request',
            body: 'Please return a short, cited research note.'
          }
        })
        const requestId = nextRequestId(session)
        const wait = waitForInput(session, requestId, 'inbox.messages')
        emit(session, {
          type: 'inbox.wait',
          requestId,
          correlationId: 'pi:research',
          timeoutMs: 5_000
        })
        const input = await wait
        if (input.type === 'cancelled' || session.status === 'cancelled') return
        const messages = input.type === 'inbox.messages' ? input.messages : []
        emit(session, { type: 'message.delta', text: `backend received ${messages.length} correlated reply/replies` })
        await delay(10)
        completeSession(session, 'backend consumed the correlated research reply', [
          { id: 'pi-inbox-correlation', status: 'passed', detail: 'request/reply share pi:research' }
        ])
        return
      }
      case 'tool-denied': {
        const requestId = nextRequestId(session)
        const wait = waitForInput(session, requestId, 'tool.result')
        emit(session, {
          type: 'tool.request',
          requestId,
          tool: 'write',
          args: { path: 'src/secret.ts', content: 'malicious' }
        })
        const input = await wait
        if (input.type === 'cancelled' || session.status === 'cancelled') return
        if (input.type === 'tool.result' && input.ok) {
          completeSession(session, 'unexpectedly accepted an out-of-scope write')
          return
        }
        failSession(session, {
          code: 'pi-tool-denied',
          message: 'Pi adapter rejected the out-of-scope write tool request',
          retryable: false
        })
        return
      }
      case 'fail-once': {
        if (session.spec.attempt <= 1) {
          failSession(session, {
            code: 'rate-limited',
            message: 'mock model returned 429 on the first attempt',
            retryable: true,
            retryAfterMs: 20
          })
          return
        }
        emit(session, { type: 'message.delta', text: 'retry attempt accepted by the mock model' })
        completeSession(session, 'mock model recovered on retry')
        return
      }
      case 'disconnect-once': {
        if (session.spec.attempt <= 1) {
          emit(session, { type: 'message.delta', text: 'streaming research context' })
          await delay(15)
          endStream(session)
          session.status = 'disconnected'
          await waitForResume(session)
          if (terminalStatuses.has(session.status)) return
          emit(session, { type: 'message.delta', text: 'resumed from the persisted event sequence' })
          await delay(10)
          completeSession(session, 'stream resumed and completed', [
            { id: 'pi-resume', status: 'passed', detail: 'same session resumed after disconnect' }
          ])
          return
        }
        emit(session, { type: 'message.delta', text: 'fresh session completed after disconnect' })
        completeSession(session, 'fresh session completed')
        return
      }
      case 'long': {
        for (let index = 0; index < 80; index += 1) {
          if (session.status === 'cancelled') return
          emit(session, { type: 'message.delta', text: `long stream frame ${index + 1}` })
          await delay(20)
        }
        completeSession(session, 'long stream completed')
        return
      }
      default: {
        failSession(session, {
          code: 'mock-unknown-scenario',
          message: `unknown mock scenario ${scenario}`,
          retryable: false
        })
      }
    }
  }

  function completeSession(
    session: MockSession,
    summary: string,
    checks: Array<{ id: string; status: 'passed' | 'failed'; detail?: string }> = []
  ): void {
    if (session.status === 'cancelled') return
    session.status = 'completed'
    emit(session, {
      type: 'session.completed',
      result: { summary, checks }
    })
    endStream(session)
  }

  function failSession(
    session: MockSession,
    error: { code: string; message: string; retryable?: boolean; retryAfterMs?: number }
  ): void {
    if (session.status === 'cancelled') return
    session.status = 'failed'
    emit(session, { type: 'session.failed', error })
    endStream(session)
    resolveInputs(session, { type: 'cancelled' })
  }

  function cancelSession(session: MockSession): void {
    if (terminalStatuses.has(session.status)) return
    session.status = 'cancelled'
    emit(session, { type: 'session.cancelled', reason: 'cancel requested' })
    endStream(session)
    resolveInputs(session, { type: 'cancelled' })
    const resumeWaiters = session.resumeWaiters.splice(0)
    for (const resolve of resumeWaiters) resolve()
  }

  function endStream(session: MockSession): void {
    if (session.res) {
      session.res.end()
      session.res = undefined
    }
  }

  function emit(session: MockSession, event: PiEventBody<PiSessionEvent>): void {
    session.seq += 1
    const full = { seq: session.seq, at: new Date().toISOString(), ...event } as PiSessionEvent
    if (full.type === 'message.delta') session.deltas += 1
    session.events.push(full)
    if (session.res) writeSse(session.res, full)
  }

  function pushInput(session: MockSession, input: PiInput): void {
    const waiterIndex = session.inputWaiters.findIndex((waiter) => waiter.predicate(input))
    if (waiterIndex >= 0) {
      const waiter = session.inputWaiters.splice(waiterIndex, 1)[0]
      waiter?.resolve(input)
      return
    }
    session.inputs.push(input)
  }

  function waitForInput(
    session: MockSession,
    requestId: string,
    expectedType: PiInput['type']
  ): Promise<InputOrCancel> {
    const predicate = (input: PiInput): boolean => input.type === expectedType && input.requestId === requestId
    const existingIndex = session.inputs.findIndex(predicate)
    if (existingIndex >= 0) {
      const existing = session.inputs.splice(existingIndex, 1)[0]
      return Promise.resolve(existing as PiInput)
    }
    return new Promise<InputOrCancel>((resolve) => {
      session.inputWaiters.push({ predicate, resolve })
    })
  }

  function waitForResume(session: MockSession): Promise<void> {
    if (session.status === 'running') return Promise.resolve()
    return new Promise<void>((resolve) => {
      session.resumeWaiters.push(resolve)
    })
  }

  function resolveInputs(session: MockSession, input: InputOrCancel): void {
    const waiters = session.inputWaiters.splice(0)
    for (const waiter of waiters) waiter.resolve(input)
  }

  function nextRequestId(session: MockSession): string {
    return `${session.id}:request-${session.seq + 1}-${randomUUID().slice(0, 4)}`
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  const url = `http://${host}:${actualPort}`

  return {
    url,
    port: actualPort,
    get stats() {
      return stats()
    },
    async close() {
      if (closed) return
      closed = true
      for (const session of sessions.values()) {
        endStream(session)
        resolveInputs(session, { type: 'cancelled' })
        for (const resolve of session.resumeWaiters.splice(0)) resolve()
      }
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }
}

function validateSpec(body: unknown): PiSessionSpec {
  if (!body || typeof body !== 'object') throw new Error('session body must be an object')
  const candidate = body as Partial<PiSessionSpec>
  for (const field of ['projectId', 'runId', 'taskId', 'agentId', 'role'] as const) {
    if (typeof candidate[field] !== 'string' || !candidate[field]) {
      throw new Error(`session.${field} is required`)
    }
  }
  if (typeof candidate.attempt !== 'number' || !Number.isInteger(candidate.attempt) || candidate.attempt < 1) {
    throw new Error('session.attempt must be a positive integer')
  }
  if (typeof candidate.prompt !== 'string') throw new Error('session.prompt is required')
  return {
    protocolVersion: candidate.protocolVersion ?? '1.0',
    projectId: candidate.projectId as string,
    runId: candidate.runId as string,
    taskId: candidate.taskId as string,
    agentId: candidate.agentId as string,
    role: candidate.role as string,
    attempt: candidate.attempt,
    baseRevision: candidate.baseRevision ?? '',
    prompt: candidate.prompt,
    tools: candidate.tools ?? [],
    writeScopes: candidate.writeScopes ?? [],
    memoryView: candidate.memoryView ?? 'off',
    model: candidate.model,
    maxTurns: candidate.maxTurns ?? 1,
    maxTokens: candidate.maxTokens ?? 1,
    timeoutMs: candidate.timeoutMs ?? 30_000,
    scenario: candidate.scenario
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 1_000_000) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

function writeSse(res: ServerResponse, event: PiSessionEvent): void {
  res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const port = Number(process.env.PI_MOCK_PORT ?? MOCK_PI_PORT)
  const mock = await startMockPiServer({ port })
  console.log(`[mock-pi] listening on ${mock.url} (protocol 1.0, port ${mock.port})`)
  const shutdown = async (): Promise<void> => {
    await mock.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}
