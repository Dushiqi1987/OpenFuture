import { safeStorage } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { AppError } from './errors'
import { firstLanIp } from './lan'
import type { CloudAccountInfo, CloudQrPoll, CloudQrTicket, CloudStatus, CloudUserView } from '../shared/protocol'

interface StoredSession {
  base?: string
  token?: string
  user?: CloudUserView
}

interface AuthResponse {
  token: string
  user: CloudUserView
}

interface QrTicketResponse {
  ticket: string
  code: string
  pollSecret: string
  expiresAt: string
  expiresInSeconds: number
  imageUrl: string
}

interface QrPollResponse {
  status: 'pending' | 'claimed' | 'expired' | 'used'
  token?: string
  user?: CloudUserView
}

/**
 * 管理平台客户端（主进程侧）：
 * - 保存服务器地址与登录 token（token 用系统密钥加密）；
 * - 账号密码登录、扫码登录、账户信息、退出；
 * - 渲染进程只拿到脱敏后的状态，不直接持有 token。
 */
export class CloudClient {
  private readonly file: string
  private base = 'http://127.0.0.1:8090'
  private token: string | null = null
  private user: CloudUserView | null = null
  private pendingQr: { ticket: string; secret: string } | null = null

  constructor(userData: string) {
    this.file = join(userData, 'cloud', 'session.json')
  }

  async init(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const saved = JSON.parse(raw) as StoredSession
      if (saved.base) this.base = normalizeBase(saved.base)
      if (saved.token) this.token = decryptToken(saved.token)
      if (saved.user) this.user = saved.user
    } catch {
      // 首次启动 / 文件损坏：保持未登录状态即可
    }
  }

  status(): CloudStatus {
    return { base: this.base, signedIn: this.token !== null, user: this.user }
  }

  async setBase(value: string): Promise<CloudStatus> {
    const next = normalizeBase(value)
    if (next !== this.base) {
      this.base = next
      this.token = null
      this.user = null
      this.pendingQr = null
      await this.persist()
    }
    return this.status()
  }

  async login(phone: string, password: string): Promise<CloudStatus> {
    const trimmed = phone.trim()
    if (!/^1\d{10}$/.test(trimmed)) throw new AppError('VALIDATION', '请输入 11 位手机号')
    if (password.length < 6) throw new AppError('VALIDATION', '密码至少 6 位')
    const res = await this.request<AuthResponse>('POST', '/api/auth/login', { phone: trimmed, password })
    this.token = res.token
    this.user = res.user
    await this.persist()
    return this.status()
  }

  async logout(): Promise<CloudStatus> {
    if (this.token) {
      // 服务端目前不需要吊销 JWT，这里只是通知一声，失败不影响退出
      await this.request('POST', '/api/account/logout').catch(() => undefined)
    }
    this.token = null
    this.user = null
    this.pendingQr = null
    await this.persist()
    return this.status()
  }

  async account(): Promise<CloudAccountInfo> {
    if (!this.token) throw new AppError('CLOUD_AUTH', '请先登录账号')
    const info = await this.request<CloudAccountInfo>('GET', '/api/account')
    this.user = {
      id: info.id,
      phone: info.phone,
      nickname: info.nickname,
      balanceMicros: info.balanceMicros,
      balanceYuan: info.balanceYuan
    }
    await this.persist()
    return info
  }

  /** 创建二维码：图片由主进程取回并转成 data URL，渲染进程不需要联网。 */
  async qrStart(): Promise<CloudQrTicket> {
    const res = await this.request<QrTicketResponse>('POST', '/api/qr/ticket', {
      deviceName: `OpenFuture · ${hostname()}`,
      publicBase: this.phoneBase()
    })
    this.pendingQr = { ticket: res.ticket, secret: res.pollSecret }
    const png = await this.fetchBytes(res.imageUrl)
    if (!png) throw new AppError('CLOUD_UNAVAILABLE', '二维码图片加载失败')
    return {
      ticket: res.ticket,
      code: res.code,
      expiresAt: res.expiresAt,
      expiresInSeconds: res.expiresInSeconds,
      imageDataUrl: `data:image/png;base64,${png.toString('base64')}`
    }
  }

  /** 轮询扫码结果；确认后自动写入登录态。 */
  async qrPoll(ticket: string): Promise<CloudQrPoll> {
    const pending = this.pendingQr
    if (!pending || pending.ticket !== ticket) throw new AppError('VALIDATION', '二维码已失效，请刷新')
    const query = `?ticket=${encodeURIComponent(ticket)}&secret=${encodeURIComponent(pending.secret)}`
    const res = await this.request<QrPollResponse>('GET', `/api/qr/poll${query}`)
    if (res.status === 'claimed' && res.token && res.user) {
      this.token = res.token
      this.user = res.user
      this.pendingQr = null
      await this.persist()
    }
    return { status: res.status }
  }

  async openPage(kind: 'account' | 'admin'): Promise<void> {
    const { shell } = await import('electron')
    await shell.openExternal(`${this.base}/${kind === 'admin' ? 'admin.html' : 'app.html'}`)
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      })
      const text = await res.text()
      const data = (text ? JSON.parse(text) : null) as (T & { error?: { message?: string } }) | null
      if (!res.ok) {
        const message = data?.error?.message ?? `账号服务返回 ${res.status}`
        throw new AppError(res.status === 401 || res.status === 403 ? 'CLOUD_AUTH' : 'INTERNAL', message)
      }
      return data as T
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError('CLOUD_UNAVAILABLE', `连不上账号服务 ${this.base}，请确认它已启动`)
    } finally {
      clearTimeout(timer)
    }
  }

  private async fetchBytes(url: string): Promise<Buffer | null> {
    try {
      const res = await fetch(url)
      if (!res.ok) return null
      return Buffer.from(await res.arrayBuffer())
    } catch {
      return null
    }
  }

  /** 手机能访问的地址：本地回环地址换成局域网 IP。 */
  private phoneBase(): string {
    try {
      const url = new URL(this.base)
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return this.base
      const lan = firstLanIp()
      if (!lan) return this.base
      return `${url.protocol}//${lan}${url.port ? `:${url.port}` : ''}`
    } catch {
      return this.base
    }
  }

  private async persist(): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true })
    if (!this.token) {
      await rm(this.file, { force: true })
      return
    }
    const saved: StoredSession = {
      base: this.base,
      token: encryptToken(this.token),
      user: this.user ?? undefined
    }
    await writeFile(this.file, JSON.stringify(saved), 'utf8')
  }
}

function normalizeBase(value: string): string {
  const raw = value.trim().replace(/\/+$/, '')
  if (!raw) throw new AppError('VALIDATION', '服务器地址不能为空')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AppError('VALIDATION', '服务器地址格式不正确，例如 http://192.168.31.32:8090')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('VALIDATION', '服务器地址必须以 http:// 或 https:// 开头')
  }
  return `${url.protocol}//${url.host}`
}


function encryptToken(token: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return `enc:${safeStorage.encryptString(token).toString('base64')}`
    }
  } catch {
    // 极端情况下退回明文（仍只在本机 userData 里）
  }
  return `raw:${token}`
}

function decryptToken(value: string): string {
  if (value.startsWith('enc:')) {
    return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
  }
  return value.startsWith('raw:') ? value.slice(4) : value
}
