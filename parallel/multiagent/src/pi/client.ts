/**
 * Small HTTP/SSE client for the local Pi-compatible session endpoint.
 *
 * Kept dependency-free so it can run inside the isolated M1 copy. The one
 * network boundary is explicit: no filesystem or shell work happens here.
 */
import { TeamError } from '../core/errors.ts'
import type {
  PiClientOptions,
  PiInput,
  PiSessionEvent,
  PiSessionSnapshot,
  PiSessionSpec,
  PiStats
} from './types.ts'

export interface PiStreamOptions {
  signal?: AbortSignal
  afterSeq?: number
  onEvent: (event: PiSessionEvent) => void | Promise<void>
}

interface RequestOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
}

export class PiSessionClient {
  readonly baseUrl: string
  readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: PiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    if (typeof this.fetchImpl !== 'function') {
      throw new TeamError('pi-fetch-unavailable', 'fetch is not available in this Node runtime')
    }
  }

  async createSession(spec: PiSessionSpec): Promise<{ sessionId: string }> {
    return this.json<{ sessionId: string }>('/v1/sessions', { method: 'POST', body: spec })
  }

  async resumeSession(sessionId: string): Promise<{ sessionId: string; status: string }> {
    return this.json(`/v1/sessions/${encodeURIComponent(sessionId)}/resume`, { method: 'POST', body: {} })
  }

  async cancelSession(sessionId: string, reason = 'cancelled'): Promise<void> {
    await this.json(`/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: 'POST',
      body: { reason }
    })
  }

  async sendInput(sessionId: string, input: PiInput): Promise<void> {
    await this.json(`/v1/sessions/${encodeURIComponent(sessionId)}/input`, {
      method: 'POST',
      body: input
    })
  }

  async getSession(sessionId: string): Promise<PiSessionSnapshot> {
    return this.json(`/v1/sessions/${encodeURIComponent(sessionId)}`)
  }

  async debugStats(): Promise<PiStats> {
    return this.json('/v1/debug/stats')
  }

  /**
   * Consume the SSE stream until the server closes it. A close without a
   * terminal event is surfaced to the caller as a resumable disconnect.
   */
  async stream(sessionId: string, options: PiStreamOptions): Promise<void> {
    const query = options.afterSeq !== undefined && options.afterSeq > 0 ? `?after=${options.afterSeq}` : ''
    const headers: Record<string, string> = { accept: 'text/event-stream' }
    if (options.afterSeq !== undefined && options.afterSeq > 0) {
      headers['last-event-id'] = String(options.afterSeq)
    }
    const response = await this.fetchImpl(`${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events${query}`, {
      method: 'GET',
      headers,
      signal: options.signal
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new TeamError('pi-stream-rejected', `event stream returned ${response.status}: ${body.slice(0, 300)}`, {
        status: response.status
      })
    }
    if (!response.body) {
      throw new TeamError('pi-stream-empty', 'event stream has no body')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (;;) {
          const boundary = findBoundary(buffer)
          if (!boundary) break
          const block = buffer.slice(0, boundary.index)
          buffer = buffer.slice(boundary.index + boundary.length)
          const event = parseSseBlock(block)
          if (event) await options.onEvent(event)
        }
      }
      buffer += decoder.decode()
      const trailing = parseSseBlock(buffer)
      if (trailing) await options.onEvent(trailing)
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }

  private async json<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const signals: AbortSignal[] = [AbortSignal.timeout(this.timeoutMs)]
    if (options.signal) signals.push(options.signal)
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)
    const headers: Record<string, string> = { accept: 'application/json' }
    let body: string | undefined
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(options.body)
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
      signal
    })
    const text = await response.text()
    if (!response.ok) {
      throw new TeamError('pi-http-error', `Pi endpoint ${path} returned ${response.status}: ${text.slice(0, 300)}`, {
        status: response.status,
        path
      })
    }
    if (!text.trim()) return {} as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new TeamError('pi-invalid-json', `Pi endpoint ${path} returned non-JSON content`)
    }
  }
}

function findBoundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf < 0 && crlf < 0) return undefined
  if (lf >= 0 && (crlf < 0 || lf < crlf)) return { index: lf, length: 2 }
  return { index: crlf, length: 4 }
}

function parseSseBlock(block: string): PiSessionEvent | undefined {
  const dataLines: string[] = []
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
  }
  if (dataLines.length === 0) return undefined
  const payload = dataLines.join('\n')
  try {
    const parsed = JSON.parse(payload) as PiSessionEvent
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { seq?: unknown }).seq !== 'number') {
      throw new Error('event has no sequence number')
    }
    return parsed
  } catch (error) {
    throw new TeamError('pi-invalid-event', `invalid SSE event: ${error instanceof Error ? error.message : String(error)}`, {
      payload: payload.slice(0, 500)
    })
  }
}
