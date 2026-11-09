import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRagAdapter } from './adapter.ts'
import { RagError, type LayoutKind, type SearchInput } from './types.ts'
import type { RagAdapter } from './types.ts'

export interface ServerOptions {
  dataDir?: string
  projectId?: string
  port?: number
  host?: string
  qmdModule?: string
  useDocling?: boolean
  python?: string
  doclingWorker?: string
}

export interface RunningServer {
  adapter: RagAdapter
  server: ReturnType<typeof createServer>
  port: number
  close(): Promise<void>
}

class HttpError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const MAX_BODY_BYTES = 1024 * 1024

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejectBody(new HttpError(413, 'VALIDATION', 'request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0) {
        resolveBody({})
        return
      }
      try {
        resolveBody(JSON.parse(raw))
      } catch {
        rejectBody(new HttpError(400, 'VALIDATION', 'request body must be JSON'))
      }
    })
    req.on('error', rejectBody)
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'VALIDATION', 'request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, 'VALIDATION', `${field} must be a non-empty string`)
  }
  return value
}

function requiredString(value: unknown, field: string): string {
  const text = optionalString(value, field)
  if (text === undefined) throw new HttpError(400, 'VALIDATION', `${field} is required`)
  return text
}

function optionalInt(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, 'VALIDATION', `${field} must be an integer between ${min} and ${max}`)
  }
  return value
}

function parseLayout(value: unknown): LayoutKind | undefined {
  if (value === undefined || value === null) return undefined
  if (value === 'A' || value === 'B') return value
  throw new HttpError(400, 'VALIDATION', "layout must be 'A' or 'B'")
}

function parseMode(value: unknown): SearchInput['mode'] | undefined {
  if (value === undefined || value === null) return undefined
  if (value === 'auto' || value === 'lexical' || value === 'vector' || value === 'hybrid') return value
  throw new HttpError(400, 'VALIDATION', "mode must be 'auto', 'lexical', 'vector' or 'hybrid'")
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  })
  res.end(body)
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const port = options.port ?? Number(process.env.RAG_PORT ?? 19731)
  const host = options.host ?? '127.0.0.1'
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RagError('VALIDATION', `invalid port: ${String(port)}`)
  }
  const dataDir = options.dataDir ?? resolve(process.cwd(), '.scratch', 'data', 'server')
  const projectId = options.projectId ?? process.env.RAG_PROJECT_ID ?? 'default'
  const adapter = createRagAdapter({
    dataDir,
    projectId,
    qmdModule: options.qmdModule ?? process.env.RAG_QMD_MODULE,
    useDocling: options.useDocling ?? process.env.RAG_USE_DOCLING !== '0',
    python: options.python ?? process.env.RAG_PYTHON,
    doclingWorker: options.doclingWorker ?? process.env.RAG_DOCLING_WORKER,
    timeoutMs: Number(process.env.RAG_TIMEOUT_MS ?? 180000)
  })
  await adapter.initialize()

  const server = createServer((req, res) => {
    void handle(req, res)
  })

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`)
      const route = `${req.method ?? 'GET'} ${url.pathname}`

      if (route === 'GET /health') {
        sendJson(res, 200, { ok: true, projectId, dataDir, diagnostics: await adapter.diagnostics() })
        return
      }
      if (route === 'GET /diagnostics') {
        sendJson(res, 200, { projectId, dataDir, diagnostics: await adapter.diagnostics() })
        return
      }
      if (route === 'GET /sources') {
        sendJson(res, 200, { projectId, sources: await adapter.listSources() })
        return
      }
      if (route === 'POST /import') {
        const body = asRecord(await readBody(req))
        const sourcePath = resolve(requiredString(body.path, 'path'))
        if (!isAbsolute(requiredString(body.path, 'path'))) {
          throw new HttpError(400, 'VALIDATION', 'path must be absolute')
        }
        const sourceId = optionalString(body.sourceId, 'sourceId') ?? basename(sourcePath)
        const result = await adapter.importSource({ path: sourcePath, sourceId })
        sendJson(res, 200, result)
        return
      }
      if (route === 'POST /revoke') {
        const body = asRecord(await readBody(req))
        const sourceId = requiredString(body.sourceId, 'sourceId')
        const record = await adapter.revokeSource(sourceId)
        if (record === null) throw new HttpError(404, 'NOT_FOUND', `unknown source: ${sourceId}`)
        sendJson(res, 200, { source: record, diagnostics: await adapter.diagnostics() })
        return
      }
      if (route === 'POST /search' || route === 'POST /query') {
        const body = asRecord(await readBody(req))
        const query = requiredString(body.query, 'query')
        const input: SearchInput = {
          query,
          k: optionalInt(body.k, 'k', 1, 100),
          n: optionalInt(body.n, 'n', 1, 12),
          layout: parseLayout(body.layout),
          mode: parseMode(body.mode),
          tokenBudget: optionalInt(body.tokenBudget, 'tokenBudget', 64, 20000)
        }
        const result = await adapter.search(input)
        sendJson(res, 200, result)
        return
      }
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `no route: ${route}` } })
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message } })
        return
      }
      if (error instanceof RagError) {
        sendJson(res, 400, { error: { code: error.code, message: error.message } })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 500, { error: { code: 'INTERNAL', message } })
    }
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => resolveListen())
  })
  const address = server.address() as AddressInfo

  return {
    adapter,
    server,
    port: address.port,
    async close() {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      })
      await adapter.close()
    }
  }
}

const isDirectRun = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url
if (isDirectRun) {
  const running = await startServer()
  const shutdown = async (): Promise<void> => {
    try {
      await running.close()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  console.log(`[rag] listening on http://127.0.0.1:${running.port} project=${(await running.adapter.diagnostics()).projectId}`)
}
