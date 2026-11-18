import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lanAddresses } from './lan'
import type {
  AgentEventPayload,
  OpenConversationInput,
  RemoteAccessStatus,
  RemoteActivity,
  SendMessageMode
} from '../shared/protocol'
import mobileHtml from '../../mobile/index.html?raw'

/** Everything the phone UI may do, backed by the renderer's own IPC handlers. */
export interface RemoteBridge {
  listProjects(): Promise<unknown>
  listConversations(projectId: string): Promise<unknown>
  createConversation(projectId: string, title?: string): Promise<unknown>
  openConversation(input: OpenConversationInput): Promise<unknown>
  sendMessage(input: { text: string; mode: SendMessageMode; sessionId?: string }): Promise<void>
  stop(sessionId?: string): Promise<void>
  answerPrompt(input: {
    id: string
    sessionId?: string
    optionIndex?: number
    text?: string
    cancelled?: boolean
  }): Promise<void>
  listSessions(): Promise<unknown>
  openSession(sessionId?: string): Promise<unknown>
}

export type RemoteStatus = RemoteAccessStatus

interface StoredToken {
  hash: string
  name: string
  createdAt: number
  lastSeenAt: number
}

const PAIR_TTL_MS = 10 * 60 * 1000
const MAX_EVENTS = 500
const MAX_BODY = 1_000_000

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export class RemoteHost {
  private bridge: RemoteBridge | null = null
  private server: Server | null = null
  private port = 8787
  private code = ''
  private codeExpiresAt = 0
  private tokens: StoredToken[] = []
  private readonly tokenFile: string
  private readonly clients = new Set<ServerResponse>()
  private readonly events: Array<{ seq: number; sessionId: string; event: unknown }> = []
  private seq = 0
  private readonly failures = new Map<string, { count: number; firstAt: number }>()
  private heartbeat: NodeJS.Timeout | null = null
  private startedAt = 0
  /** Last conversation the phone touched, so message events can be attributed. */
  private lastProjectId = ''
  private lastConversationId = ''

  constructor(private readonly options: {
    userData: string
    version: string
    onActivity?: (activity: RemoteActivity) => void
  }) {
    const dir = join(options.userData, 'remote')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.tokenFile = join(dir, 'tokens.json')
    this.loadTokens()
    this.rotateCode()
  }

  setBridge(bridge: RemoteBridge): void {
    this.bridge = bridge
  }

  async start(port = Number(process.env.OF_REMOTE_PORT) || 8787): Promise<void> {
    if (this.server) return
    this.port = port
    this.startedAt = Date.now()
    const server = createServer((req, res) => {
      void this.dispatch(req, res).catch((error: unknown) => {
        // Bridge failures are AppError-shaped ({code,message}); surface them as
        // 4xx JSON so the phone can show "先配置模型" instead of "内部错误".
        const code = (error as { code?: unknown } | null)?.code
        const message = error instanceof Error ? error.message : ''
        if (typeof code === 'string' && /^[A-Z][A-Z_]{2,39}$/.test(code)) {
          console.error('[remote] request rejected:', code, message)
          if (!res.headersSent) this.sendError(res, statusForError(code), code, message)
          else res.end()
          return
        }
        console.error('[remote] request failed:', error)
        if (!res.headersSent) this.sendError(res, 500, 'INTERNAL', '服务内部错误')
        else res.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '0.0.0.0', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    this.server = server
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) client.write(': ping\n\n')
    }, 25_000)
    console.log(`[remote] listening on http://0.0.0.0:${this.port}`)
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const client of this.clients) client.end()
    this.clients.clear()
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  status(): RemoteStatus {
    this.ensureCode()
    const port = this.port
    return {
      running: this.server !== null,
      port,
      urls: lanAddresses().map((ip) => `http://${ip}:${port}`),
      code: this.code,
      codeExpiresAt: this.codeExpiresAt,
      devices: this.tokens.map((token) => ({
        name: token.name,
        createdAt: token.createdAt,
        lastSeenAt: token.lastSeenAt
      }))
    }
  }

  rotateCode(): string {
    this.code = String(Math.floor(100_000 + Math.random() * 900_000))
    this.codeExpiresAt = Date.now() + PAIR_TTL_MS
    return this.code
  }

  broadcast(payload: AgentEventPayload): void {
    if (this.clients.size === 0) {
      // Keep a short tail even with no listeners so a reconnecting phone can
      // replay the last turn instead of losing it.
    }
    const entry = { seq: ++this.seq, sessionId: payload.sessionId, event: payload.event }
    this.events.push(entry)
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
    const line = `data: ${JSON.stringify(entry)}\n\n`
    for (const client of this.clients) {
      try {
        client.write(line)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  private ensureCode(): void {
    if (!this.code || Date.now() >= this.codeExpiresAt) this.rotateCode()
  }

  private loadTokens(): void {
    try {
      if (!existsSync(this.tokenFile)) return
      const parsed = JSON.parse(readFileSync(this.tokenFile, 'utf8')) as unknown
      if (!Array.isArray(parsed)) return
      this.tokens = parsed.flatMap((row) => {
        if (!row || typeof row !== 'object') return []
        const record = row as Record<string, unknown>
        if (typeof record.hash !== 'string' || typeof record.name !== 'string') return []
        return [
          {
            hash: record.hash,
            name: record.name,
            createdAt: Number(record.createdAt) || Date.now(),
            lastSeenAt: Number(record.lastSeenAt) || 0
          }
        ]
      })
    } catch (error) {
      console.error('[remote] token store unreadable:', error)
    }
  }

  private saveTokens(): void {
    try {
      writeFileSync(this.tokenFile, JSON.stringify(this.tokens, null, 2), 'utf8')
    } catch (error) {
      console.error('[remote] failed to save tokens:', error)
    }
  }

  private authenticate(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : ''
    const url = new URL(req.url ?? '/', 'http://localhost')
    const token = bearer || url.searchParams.get('token') || ''
    if (!token) return false
    const digest = Buffer.from(sha256(token), 'hex')
    let matched: StoredToken | null = null
    for (const stored of this.tokens) {
      const expected = Buffer.from(stored.hash, 'hex')
      if (expected.length === digest.length && timingSafeEqual(expected, digest)) {
        matched = stored
        break
      }
    }
    if (!matched) return false
    matched.lastSeenAt = Date.now()
    return true
  }

  private sendJson(res: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS'
    })
    res.end(body)
  }

  private sendError(res: ServerResponse, status: number, code: string, message: string): void {
    this.sendJson(res, status, { ok: false, error: { code, message } })
  }

  private sendValue(res: ServerResponse, value: unknown): void {
    this.sendJson(res, 200, { ok: true, value })
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = chunk as Buffer
      size += buffer.length
      if (size > MAX_BODY) throw new Error('BODY_TOO_LARGE')
      chunks.push(buffer)
    }
    if (size === 0) return {}
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (!text) return {}
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('BAD_JSON')
    return parsed as Record<string, unknown>
  }

  private rateLimited(req: IncomingMessage): boolean {
    const ip = req.socket.remoteAddress ?? 'unknown'
    const now = Date.now()
    const entry = this.failures.get(ip)
    if (!entry || now - entry.firstAt > 10 * 60 * 1000) {
      this.failures.set(ip, { count: 0, firstAt: now })
      return false
    }
    return entry.count >= 10
  }

  private noteFailure(req: IncomingMessage): void {
    const ip = req.socket.remoteAddress ?? 'unknown'
    const entry = this.failures.get(ip) ?? { count: 0, firstAt: Date.now() }
    entry.count += 1
    this.failures.set(ip, entry)
  }

  private bridgeOrThrow(): RemoteBridge {
    if (!this.bridge) throw new Error('BRIDGE_NOT_READY')
    return this.bridge
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const method = req.method ?? 'GET'

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-max-age': '86400'
      })
      res.end()
      return
    }

    if (method === 'GET' && (path === '/' || path === '/m' || path === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
      res.end(mobileHtml)
      return
    }

    if (method === 'GET' && path === '/api/ping') {
      this.sendJson(res, 200, {
        ok: true,
        value: { name: 'OpenFuture', version: this.options.version, startedAt: this.startedAt }
      })
      return
    }

    if (method === 'POST' && path === '/api/pair') {
      if (this.rateLimited(req)) {
        this.sendError(res, 429, 'TOO_MANY_ATTEMPTS', '尝试次数过多，请十分钟后再试')
        return
      }
      const body = await this.readBody(req).catch(() => null)
      const code = typeof body?.code === 'string' ? body.code.trim() : ''
      const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : '手机'
      this.ensureCode()
      if (!code || code !== this.code || Date.now() >= this.codeExpiresAt) {
        this.noteFailure(req)
        this.sendError(res, 401, 'PAIR_CODE_INVALID', '配对码不正确或已过期')
        return
      }
      const token = randomBytes(32).toString('hex')
      this.tokens.push({ hash: sha256(token), name, createdAt: Date.now(), lastSeenAt: Date.now() })
      this.saveTokens()
      this.rotateCode()
      this.sendJson(res, 200, { ok: true, value: { token, name, urls: this.status().urls } })
      return
    }

    if (method === 'GET' && path === '/api/events') {
      if (!this.authenticate(req)) {
        this.sendError(res, 401, 'UNAUTHORIZED', '未配对')
        return
      }
      const since = Number(url.searchParams.get('since') ?? '0') || 0
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'access-control-allow-origin': '*'
      })
      res.write('retry: 3000\n\n')
      for (const event of this.events) {
        if (event.seq > since) res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      this.clients.add(res)
      req.on('close', () => this.clients.delete(res))
      return
    }

    if (!this.authenticate(req)) {
      this.sendError(res, 401, 'UNAUTHORIZED', '未配对或令牌已失效')
      return
    }

    const bridge = this.bridgeOrThrow()

    if (method === 'GET' && path === '/api/state') {
      this.sendValue(res, { version: this.options.version, port: this.port, urls: lanAddresses() })
      return
    }

    if (method === 'GET' && path === '/api/projects') {
      this.sendValue(res, await bridge.listProjects())
      return
    }

    let match = /^\/api\/projects\/([^/]+)\/conversations$/.exec(path)
    if (match) {
      const projectId = decodeURIComponent(match[1] as string)
      if (method === 'GET') {
        this.sendValue(res, await bridge.listConversations(projectId))
        return
      }
      if (method === 'POST') {
        const body = await this.readBody(req)
        const title = typeof body.title === 'string' ? body.title : undefined
        const created = (await bridge.createConversation(projectId, title)) as { id?: unknown }
        const conversationId = typeof created?.id === 'string' ? created.id : ''
        if (conversationId) {
          this.lastProjectId = projectId
          this.lastConversationId = conversationId
          this.options.onActivity?.({ kind: 'conversation', projectId, conversationId })
        }
        this.sendValue(res, created)
        return
      }
    }

    if (method === 'POST' && path === '/api/conversations/open') {
      const body = await this.readBody(req)
      const projectId = typeof body.projectId === 'string' ? body.projectId : ''
      const conversationId = typeof body.conversationId === 'string' ? body.conversationId : ''
      if (!projectId || !conversationId) {
        this.sendError(res, 400, 'VALIDATION', '缺少项目或对话 ID')
        return
      }
      const opened = (await bridge.openConversation({ projectId, conversationId })) as {
        sessionId?: unknown
      }
      this.lastProjectId = projectId
      this.lastConversationId = conversationId
      this.options.onActivity?.({
        kind: 'open',
        projectId,
        conversationId,
        sessionId: typeof opened?.sessionId === 'string' ? opened.sessionId : ''
      })
      this.sendValue(res, opened)
      return
    }

    match = /^\/api\/sessions\/([^/]+)\/(messages|stop)$/.exec(path)
    if (match && method === 'POST') {
      const sessionId = decodeURIComponent(match[1] as string)
      if (!sessionId) {
        this.sendError(res, 400, 'VALIDATION', '缺少会话 ID')
        return
      }
      if (match[2] === 'stop') {
        await bridge.stop(sessionId)
        this.sendValue(res, null)
        return
      }
      const body = await this.readBody(req)
      const text = typeof body.text === 'string' ? body.text : ''
      const mode: SendMessageMode =
        body.mode === 'steer' || body.mode === 'followUp' ? body.mode : 'prompt'
      if (!text.trim()) {
        this.sendError(res, 400, 'VALIDATION', '消息不能为空')
        return
      }
      await bridge.sendMessage({ text, mode, sessionId })
      const projectId = typeof body.projectId === 'string' ? body.projectId : this.lastProjectId
      const conversationId =
        typeof body.conversationId === 'string' ? body.conversationId : this.lastConversationId
      if (projectId && conversationId) {
        this.options.onActivity?.({
          kind: 'message',
          projectId,
          conversationId,
          sessionId,
          text,
          at: Date.now()
        })
      }
      this.sendValue(res, null)
      return
    }

    if (method === 'POST' && path === '/api/prompts/answer') {
      const body = await this.readBody(req)
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) {
        this.sendError(res, 400, 'VALIDATION', '缺少提问 ID')
        return
      }
      await bridge.answerPrompt({
        id,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        optionIndex: typeof body.optionIndex === 'number' ? body.optionIndex : undefined,
        text: typeof body.text === 'string' ? body.text : undefined,
        cancelled: body.cancelled === true
      })
      this.sendValue(res, null)
      return
    }

    this.sendError(res, 404, 'NOT_FOUND', '接口不存在')
  }
}

/** Map a bridge error code to an HTTP status the phone UI can reason about. */
function statusForError(code: string): number {
  switch (code) {
    case 'UNAUTHORIZED':
    case 'FORBIDDEN':
      return 401
    case 'NOT_FOUND':
      return 404
    case 'NO_MODEL':
    case 'NO_WORKSPACE':
    case 'CONFLICT':
    case 'BUSY':
      return 409
    case 'NOT_IMPLEMENTED':
      return 501
    case 'INTERNAL':
      return 500
    default:
      return 400
  }
}
