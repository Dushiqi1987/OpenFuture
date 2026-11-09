/**
 * Loopback mock model server on the task-assigned test port (19733 by default).
 *
 * It is a deliberately small stand-in for a real memory model. The bearer token
 * is generated at runtime and only lives in memory; tests/demo pass it to
 * ModelClient. Nothing here reads real application credentials or config.
 */

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { DreamError } from './errors.mjs'
import { HeuristicModel } from './heuristics.mjs'

export const MOCK_MODEL_PORT = 19733
const MAX_BODY_BYTES = 2 * 1024 * 1024

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new DreamError('VALIDATION', 'Mock model request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text.length === 0 ? {} : JSON.parse(text))
      } catch (error) {
        reject(new DreamError('MODEL_OUTPUT_INVALID', 'Request body is not JSON', { cause: error }))
      }
    })
    req.on('error', reject)
  })
}

function tokenMatches(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

/**
 * Create (but do not start) the mock server.
 * @param {{port?:number, host?:string, token?:string, model?:any}} options
 */
export function createMockModelServer({
  port = MOCK_MODEL_PORT,
  host = '127.0.0.1',
  token = randomBytes(18).toString('base64url'),
  model = new HeuristicModel({ name: 'heuristic-mock-http' })
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DreamError('VALIDATION', 'Mock model port must be a valid TCP port')
  }
  const server = createServer(async (req, res) => {
    try {
      if (!tokenMatches(req.headers.authorization, token)) {
        sendJson(res, 401, { error: 'invalid_token' })
        return
      }
      const url = new URL(req.url, `http://${req.headers.host ?? host}`)
      if (req.method === 'GET' && url.pathname === '/health') {
        const health = (await model.health()) ?? { ok: true }
        sendJson(res, 200, { ...health, provider: health.provider ?? model.name })
        return
      }
      if (req.method !== 'POST' || !['/v1/dream/extract', '/v1/dream/adjudicate'].includes(url.pathname)) {
        sendJson(res, 404, { error: 'not_found' })
        return
      }
      const body = await readBody(req)
      if (typeof body?.projectId !== 'string' || body.projectId.length === 0) {
        sendJson(res, 400, { error: 'projectId is required' })
        return
      }
      if (url.pathname === '/v1/dream/extract') {
        if (!Array.isArray(body.evidence)) {
          sendJson(res, 400, { error: 'evidence[] is required' })
          return
        }
        const result = await model.extract({ projectId: body.projectId, evidence: body.evidence })
        sendJson(res, 200, { ...result, provider: model.name, degraded: false })
        return
      }
      if (!Array.isArray(body.candidates) || !Array.isArray(body.entries) || !Array.isArray(body.conflicts)) {
        sendJson(res, 400, { error: 'candidates[], entries[] and conflicts[] are required' })
        return
      }
      const result = await model.adjudicate({
        projectId: body.projectId,
        candidates: body.candidates,
        entries: body.entries,
        conflicts: body.conflicts
      })
      sendJson(res, 200, { ...result, provider: model.name, degraded: false })
    } catch (error) {
      const status = error instanceof DreamError && error.code === 'VALIDATION' ? 400 : 500
      sendJson(res, status, { error: error?.code ?? 'model_error', message: error?.message ?? 'model failed' })
    }
  })

  let listening = false
  return {
    server,
    port,
    host,
    token,
    model,
    get listening() {
      return listening
    },
    get url() {
      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : port
      return `http://${host}:${actualPort}`
    },
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          listening = true
          resolve({ url: this.url, token })
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
      })
    },
    close() {
      return new Promise((resolve, reject) => {
        if (!listening) {
          resolve()
          return
        }
        server.close((error) => {
          if (error) reject(error)
          else {
            listening = false
            resolve()
          }
        })
        server.closeAllConnections?.()
      })
    }
  }
}

export async function startMockModelServer(options = {}) {
  const server = createMockModelServer(options)
  await server.listen()
  return server
}
