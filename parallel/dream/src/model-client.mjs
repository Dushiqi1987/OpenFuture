/**
 * Model client contract (loopback HTTP, fake bearer credential).
 *
 * POST /v1/dream/extract    -> { candidates, notes? }
 * POST /v1/dream/adjudicate -> { ops, notes? }
 * GET  /health              -> { ok, provider }
 *
 * The token is a test credential. It is generated at runtime for the bundled
 * mock server and is never read from or written to the real application config.
 */

import { DreamError } from './errors.mjs'

function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}${path}`
}

function withTimeout(signal, timeoutMs) {
  if (!timeoutMs) return { signal, cleanup: () => {} }
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => {
    controller.abort(new Error(`model timeout after ${timeoutMs}ms`))
  }, timeoutMs)
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }
}

export class ModelClient {
  /**
   * @param {{baseUrl:string, token:string, timeoutMs?:number, fetchImpl?:typeof fetch, name?:string}} options
   */
  constructor({ baseUrl, token, timeoutMs = 5000, fetchImpl = globalThis.fetch, name = 'http-model' }) {
    if (!baseUrl) throw new DreamError('VALIDATION', 'ModelClient needs baseUrl')
    if (!token) throw new DreamError('VALIDATION', 'ModelClient needs a test token')
    if (typeof fetchImpl !== 'function') throw new DreamError('VALIDATION', 'fetch is not available')
    this.baseUrl = baseUrl
    this.token = token
    this.timeoutMs = timeoutMs
    this.fetchImpl = fetchImpl
    this.name = name
  }

  async request(path, payload, { signal } = {}) {
    const timed = withTimeout(signal, this.timeoutMs)
    let response
    try {
      response = await this.fetchImpl(joinUrl(this.baseUrl, path), {
        method: payload === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json'
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: timed.signal
      })
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
        throw new DreamError('MODEL_TIMEOUT', 'Model request timed out', { cause: error })
      }
      throw new DreamError('MODEL_UNAVAILABLE', 'Model endpoint is not reachable', { cause: error })
    } finally {
      timed.cleanup()
    }
    if (response.status === 401 || response.status === 403) {
      throw new DreamError('MODEL_UNAVAILABLE', 'Model credential rejected', {
        details: { status: response.status }
      })
    }
    if (!response.ok) {
      throw new DreamError('MODEL_UNAVAILABLE', `Model responded with HTTP ${response.status}`, {
        details: { status: response.status }
      })
    }
    let body
    try {
      body = await response.json()
    } catch (error) {
      throw new DreamError('MODEL_OUTPUT_INVALID', 'Model response is not JSON', { cause: error })
    }
    return body
  }

  async health() {
    try {
      const body = await this.request('/health')
      return { ok: body?.ok === true, provider: body?.provider ?? this.name, degraded: false }
    } catch (error) {
      return { ok: false, provider: this.name, degraded: true, error: error?.code ?? 'MODEL_UNAVAILABLE' }
    }
  }

  async extract({ projectId, evidence, signal }) {
    const body = await this.request(
      '/v1/dream/extract',
      {
        projectId,
        evidence: (evidence ?? []).map((record) => ({
          projectId: record.projectId,
          evidenceId: record.evidenceId,
          sourceId: record.sourceId,
          sourceRevision: record.sourceRevision,
          sourceKind: record.sourceKind,
          role: record.role,
          sessionId: record.sessionId,
          messageId: record.messageId,
          timestamp: record.timestamp,
          text: record.text,
          quarantined: record.quarantined === true,
          injectionFlags: Array.isArray(record.injectionFlags) ? record.injectionFlags : []
        }))
      },
      { signal }
    )
    if (!Array.isArray(body?.candidates)) {
      throw new DreamError('MODEL_OUTPUT_INVALID', 'Extraction response must contain candidates[]')
    }
    return {
      candidates: body.candidates,
      notes: Array.isArray(body.notes) ? body.notes : [],
      provider: body.provider ?? this.name,
      degraded: body.degraded === true,
      degradedReason: body.degradedReason ?? null
    }
  }

  async adjudicate({ projectId, candidates, entries, conflicts, signal }) {
    const body = await this.request(
      '/v1/dream/adjudicate',
      {
        projectId,
        candidates: candidates.map((candidate) => ({
          id: candidate.id,
          type: candidate.type,
          subject: candidate.subject,
          value: candidate.value,
          previousValue: candidate.previousValue,
          basis: candidate.basis,
          confidence: candidate.confidence,
          evidenceIds: candidate.evidenceIds
        })),
        entries: entries.map((entry) => ({
          id: entry.id,
          type: entry.type,
          subject: entry.subject,
          value: entry.value,
          revision: entry.revision,
          promoted: entry.promoted
        })),
        conflicts
      },
      { signal }
    )
    if (!Array.isArray(body?.ops)) {
      throw new DreamError('MODEL_OUTPUT_INVALID', 'Adjudication response must contain ops[]')
    }
    return {
      ops: body.ops,
      notes: Array.isArray(body.notes) ? body.notes : [],
      provider: body.provider ?? this.name,
      degraded: body.degraded === true,
      degradedReason: body.degradedReason ?? null
    }
  }
}

/**
 * Try a primary model and fall back to the local heuristic engine. A degraded
 * result is a recognizable status: the plan can still be produced for review,
 * but it records `degraded: true` and the reason.
 */
export class FallbackModel {
  constructor({ primary, fallback, onFallback = null }) {
    this.primary = primary
    this.fallback = fallback
    this.onFallback = onFallback
    this.name = `${primary.name ?? 'primary'}+fallback`
  }

  async health() {
    const primary = await this.primary.health().catch(() => ({ ok: false }))
    if (primary.ok) return { ...primary, degraded: false }
    return {
      ...(await this.fallback.health()),
      degraded: true,
      primaryError: primary.error ?? 'MODEL_UNAVAILABLE'
    }
  }

  async #call(method, payload) {
    try {
      const result = await this.primary[method](payload)
      return { result, degraded: false, provider: this.primary.name }
    } catch (error) {
      const result = await this.fallback[method](payload)
      const reason = error?.code ?? 'MODEL_UNAVAILABLE'
      if (this.onFallback) this.onFallback({ method, reason })
      return { result, degraded: true, provider: this.fallback.name, reason }
    }
  }

  async extract({ projectId, evidence, signal }) {
    const { result, degraded, provider, reason } = await this.#call('extract', { projectId, evidence, signal })
    return { ...result, degraded, provider, degradedReason: reason ?? null }
  }

  async adjudicate({ projectId, candidates, entries, conflicts, signal }) {
    const { result, degraded, provider, reason } = await this.#call('adjudicate', {
      projectId,
      candidates,
      entries,
      conflicts,
      signal
    })
    return { ...result, degraded, provider, degradedReason: reason ?? null }
  }
}
