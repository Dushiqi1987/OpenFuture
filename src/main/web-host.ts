import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { AgentEventPayload } from '../shared/protocol'
import type { CloudClient } from './cloud-client'
import type { RemoteBridge } from './ipc'
import webHtml from '../../web/index.html?raw'

const MAX_BODY = 2_000_000
const MAX_EVENTS = 500
const HEARTBEAT_MS = 20_000

interface BufferedEvent {
  seq: number
  at: number
  sessionId: string
  event: unknown
}

export interface WebStatus {
  running: boolean
  port: number
  url: string
  startedAt: number | null
}

interface WebHostOptions {
  bridge: RemoteBridge
  version: string
  /** Defaults to 8790, overridable with OF_WEB_PORT. */
  port?: number
  /** Defaults to 127.0.0.1 so the page is local-only unless explicitly exposed. */
  host?: string
  /** Optional account service used by the web account drawer. */
  cloud?: CloudClient | null
  /** Directory where browser attachments are stored. */
  uploadsDir?: string
}

/**
 * 网页版宿主：把桌面端的主进程能力用 HTTP + SSE 暴露给浏览器。
 *
 * 和 RemoteHost（手机端）共用同一套 RemoteBridge，所以网页、手机、桌面
 * 打开的是同一批项目与会话，而不是三份互不相通的数据。
 */
export class WebHost {
  private readonly bridge: RemoteBridge
  private readonly version: string
  private readonly port: number
  private readonly host: string
  private readonly cloud: CloudClient | null
  private readonly uploadsDir: string
  private server: Server | null = null
  private startedAt: number | null = null
  private seq = 0
  private readonly buffer: BufferedEvent[] = []
  private readonly clients = new Set<ServerResponse>()
  private heartbeat: NodeJS.Timeout | null = null

  constructor(options: WebHostOptions) {
    this.bridge = options.bridge
    this.version = options.version
    this.port = options.port ?? (Number(process.env.OF_WEB_PORT) || 8790)
    this.host = options.host ?? process.env.OF_WEB_HOST ?? '127.0.0.1'
    this.cloud = options.cloud ?? null
    this.uploadsDir = options.uploadsDir ?? join(process.cwd(), '.of-uploads')
  }

  status(): WebStatus {
    const address = this.server?.address() as AddressInfo | null
    const port = address?.port ?? this.port
    return {
      running: this.server !== null,
      port,
      url: `http://${this.host === '0.0.0.0' ? '127.0.0.1' : this.host}:${port}/`,
      startedAt: this.startedAt
    }
  }

  async start(): Promise<WebStatus> {
    if (this.server) return this.status()
    const server = createServer((req, res) => {
      void this.dispatch(req, res).catch((error) => {
        console.error('[web] request failed:', error)
        if (!res.headersSent) this.sendError(res, 500, 'INTERNAL', '服务内部错误')
        else res.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, this.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    this.startedAt = Date.now()
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.write(': ping\n\n')
        } catch {
          this.clients.delete(client)
        }
      }
    }, HEARTBEAT_MS)
    this.heartbeat.unref?.()
    return this.status()
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const client of this.clients) {
      try {
        client.end()
      } catch {
        // ignore
      }
    }
    this.clients.clear()
    this.server?.close()
    this.server = null
    this.startedAt = null
  }

  broadcast(payload: AgentEventPayload): void {
    if (!this.server) return
    this.seq += 1
    const buffered: BufferedEvent = { seq: this.seq, at: Date.now(), sessionId: payload.sessionId, event: payload.event }
    this.buffer.push(buffered)
    if (this.buffer.length > MAX_EVENTS) this.buffer.splice(0, this.buffer.length - MAX_EVENTS)
    this.writeEvent(buffered)
  }

  private writeEvent(item: BufferedEvent): void {
    const frame = `id: ${item.seq}\nevent: agent\ndata: ${JSON.stringify(item)}\n\n`
    for (const client of this.clients) {
      try {
        client.write(frame)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    this.setCors(res)

    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/web')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(webHtml)
      return
    }

    if (method === 'GET' && url.pathname === '/api/ping') {
      this.sendValue(res, { name: 'OpenFuture Web', version: this.version, startedAt: this.startedAt })
      return
    }

    if (method === 'GET' && url.pathname === '/api/events') {
      this.streamEvents(url, req, res)
      return
    }

    try {
      if (method === 'GET' && (url.pathname === '/manifest.webmanifest' || url.pathname === '/manifest.json')) {
      this.sendJson(res, 200, {
        name: 'OpenFuture',
        short_name: 'OpenFuture',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f7f8fa',
        theme_color: '#1f6feb',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }]
      })
      return
    }

    if (method === 'GET' && url.pathname === '/icon.svg') {
      const icon =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">' +
        '<rect width="192" height="192" rx="40" fill="#10151f"/>' +
        '<text x="96" y="118" font-family="Segoe UI, Arial, sans-serif" font-size="64" font-weight="700" text-anchor="middle" fill="#3ddc84">OF</text>' +
        '</svg>'
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' })
      res.end(icon)
      return
    }

    if (method === 'POST' && url.pathname === '/api/uploads') {
      await this.handleUpload(req, res)
      return
    }

    if (method === 'POST' && url.pathname === '/api/settings/tool-access') {
      const body = await this.readJson(req)
      const settings = await this.bridge.setToolAccess({
        powershell: Boolean(body.powershell),
        allowFileWrites: Boolean(body.allowFileWrites)
      })
      this.sendValue(res, {
        allowPowerShell: settings.allowPowerShell,
        allowFileWrites: settings.allowFileWrites
      })
      return
    }

    if (method === 'GET' && url.pathname === '/api/running') {
      this.sendJson(res, 200, { ok: true, value: { sessions: await this.bridge.runningSessions(), seq: this.seq } })
      return
    }

    if (method === 'GET' && url.pathname === '/api/state') {
        const [projects, settings] = await Promise.all([this.bridge.listProjects(), this.bridge.getSettings()])
        this.sendValue(res, {
          projects: projects.projects,
          activeProjectId: projects.activeProjectId,
          settings: {
            model: settings.model,
            workspace: settings.workspace,
            apiKeyConfigured: settings.apiKeyConfigured,
            allowPowerShell: settings.allowPowerShell,
            allowFileWrites: settings.allowFileWrites
          }
        })
        return
      }

      if (url.pathname.startsWith('/api/account')) {
        if (!this.cloud) {
          this.sendError(res, 501, 'CLOUD_UNAVAILABLE', '账号服务未启用')
          return
        }
        if (method === 'GET' && url.pathname === '/api/account') {
          this.sendValue(res, await this.cloud.account())
          return
        }
        if (method === 'POST' && url.pathname === '/api/account/login') {
          const body = await this.readJson(req)
          this.sendValue(res, await this.cloud.login(String(body.phone ?? ''), String(body.password ?? '')))
          return
        }
        if (method === 'POST' && url.pathname === '/api/account/sms') {
          const body = await this.readJson(req)
          this.sendValue(res, await this.cloud.sendSms(String(body.phone ?? '')))
          return
        }
        if (method === 'POST' && url.pathname === '/api/account/login-sms') {
          const body = await this.readJson(req)
          this.sendValue(
            res,
            await this.cloud.loginSms(String(body.phone ?? ''), String(body.code ?? '')),
          )
          return
        }
        if (method === 'POST' && url.pathname === '/api/account/logout') {
          this.sendValue(res, await this.cloud.logout())
          return
        }
        if (method === 'GET' && url.pathname === '/api/account/qr') {
          this.sendValue(res, await this.cloud.qrStart())
          return
        }
        if (method === 'GET' && url.pathname === '/api/account/qr/poll') {
          this.sendValue(res, await this.cloud.qrPoll(url.searchParams.get('ticket') ?? ''))
          return
        }
        if (method === 'GET' && url.pathname === '/api/account/status') {
          this.sendValue(res, this.cloud.status())
          return
        }
      }

      if (method === 'GET' && url.pathname === '/api/projects') {
        this.sendValue(res, await this.bridge.listProjects())
        return
      }

      const projectConversations = url.pathname.match(/^\/api\/projects\/([^/]+)\/conversations$/)
      if (method === 'GET' && projectConversations) {
        this.sendValue(res, await this.bridge.listConversations(decodeURIComponent(projectConversations[1] ?? '')))
        return
      }

      if (method === 'POST' && url.pathname === '/api/conversations') {
        const body = await this.readJson(req)
        const created = await this.bridge.createConversation(String(body.projectId ?? ''), asOptionalString(body.title))
        this.sendValue(res, created)
        return
      }

      if (method === 'PATCH' && url.pathname === '/api/conversations') {
        const body = await this.readJson(req)
        const updated = await this.bridge.renameConversation(
          String(body.projectId ?? ''),
          String(body.conversationId ?? ''),
          String(body.title ?? '').trim()
        )
        this.sendValue(res, updated)
        return
      }

      if (method === 'DELETE' && url.pathname === '/api/conversations') {
        await this.bridge.deleteConversation(
          String(url.searchParams.get('projectId') ?? ''),
          String(url.searchParams.get('conversationId') ?? '')
        )
        this.sendValue(res, { deleted: true })
        return
      }

      if (method === 'POST' && url.pathname === '/api/conversations/open') {
        const body = await this.readJson(req)
        const conversationId = asOptionalString(body.conversationId)
        if (!conversationId) throw Object.assign(new Error('缺少对话 ID'), { code: 'VALIDATION' })
        const opened = await this.bridge.openConversation({
          projectId: String(body.projectId ?? ''),
          conversationId
        })
        this.sendValue(res, opened)
        return
      }

      const sessionMessage = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)
      if (method === 'POST' && sessionMessage) {
        const body = await this.readJson(req)
        const mode = body.mode === 'steer' || body.mode === 'followUp' ? body.mode : 'prompt'
        await this.bridge.sendMessage({
          text: String(body.text ?? ''),
          mode,
          sessionId: decodeURIComponent(sessionMessage[1] ?? '')
        })
        this.sendValue(res, { accepted: true })
        return
      }

      const sessionStop = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/)
      if (method === 'POST' && sessionStop) {
        await this.bridge.stop(decodeURIComponent(sessionStop[1] ?? ''))
        this.sendValue(res, { stopped: true })
        return
      }

      if (method === 'POST' && url.pathname === '/api/prompts/answer') {
        const body = await this.readJson(req)
        await this.bridge.answerPrompt({
          id: String(body.id ?? ''),
          sessionId: asOptionalString(body.sessionId),
          optionIndex: typeof body.optionIndex === 'number' ? body.optionIndex : undefined,
          text: asOptionalString(body.text),
          cancelled: Boolean(body.cancelled)
        })
        this.sendValue(res, { answered: true })
        return
      }

      this.sendError(res, 404, 'NOT_FOUND', '接口不存在')
    } catch (error) {
      this.replyError(res, error)
    }
  }

  private streamEvents(url: URL, req: IncomingMessage, res: ServerResponse): void {
    const since = Number(url.searchParams.get('since') ?? '0') || 0
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.write(`retry: 3000\n\n`)
    for (const item of this.buffer) {
      if (item.seq > since) res.write(`id: ${item.seq}\nevent: agent\ndata: ${JSON.stringify(item)}\n\n`)
    }
    this.clients.add(res)
    req.on('close', () => {
      this.clients.delete(res)
    })
  }

  private setCors(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  }

  private sendValue(res: ServerResponse, value: unknown): void {
    this.sendJson(res, 200, { ok: true, value })
  }

  private sendError(res: ServerResponse, status: number, code: string, message: string): void {
    this.sendJson(res, status, { ok: false, error: { code, message } })
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body)
    })
    res.end(body)
  }

  private replyError(res: ServerResponse, error: unknown): void {
    const shaped = error as { code?: unknown; message?: unknown }
    const message = typeof shaped?.message === 'string' ? shaped.message : '服务内部错误'
    const code = typeof shaped?.code === 'string' && /^[A-Z][A-Z_]{2,39}$/.test(shaped.code) ? shaped.code : 'INTERNAL'
    const status =
      code === 'VALIDATION' ? 400 : code === 'NOT_FOUND' ? 404 : code === 'CONFLICT' || code === 'BUSY' ? 409 : 500
    this.sendError(res, status, code, message)
  }

  private async handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawName = String(req.headers['x-file-name'] ?? '')
    let name = ''
    try { name = basename(decodeURIComponent(rawName)) } catch { name = '' }
    if (!name || name === '.' || name === '..') {
      this.sendError(res, 400, 'VALIDATION', '缺少文件名（X-File-Name）')
      return
    }
    const ext = extname(name).slice(1).toLowerCase()
    const images = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])
    const texts = new Set(['txt', 'md', 'json', 'log', 'csv', 'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'html', 'css', 'yml', 'yaml', 'xml', 'sql', 'sh', 'ps1', 'bat', 'ini', 'toml'])
    if (!images.has(ext) && !texts.has(ext)) {
      this.sendError(res, 400, 'VALIDATION', '不支持的文件类型：.' + ext)
      return
    }
    const limit = 20 * 1024 * 1024
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.length
      if (total > limit) {
        this.sendError(res, 413, 'VALIDATION', '附件超过 20MB')
        return
      }
      chunks.push(buf)
    }
    const data = Buffer.concat(chunks)
    if (data.length === 0) {
      this.sendError(res, 400, 'VALIDATION', '附件为空')
      return
    }
    const safe = name.replace(/[^\w.\-\u4e00-\u9fa5 ]+/g, '_').slice(-80)
    const stored = Date.now().toString(36) + '-' + safe
    await mkdir(this.uploadsDir, { recursive: true })
    const target = join(this.uploadsDir, stored)
    await writeFile(target, data)
    this.sendValue(res, { path: target, name: safe, size: data.length, kind: images.has(ext) ? 'image' : 'text' })
  }

  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.length
      if (total > MAX_BODY) throw Object.assign(new Error('请求体过大'), { code: 'VALIDATION' })
      chunks.push(buf)
    }
    if (total === 0) return {}
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'VALIDATION' })
    }
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
