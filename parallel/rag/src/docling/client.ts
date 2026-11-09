/**
 * Small client for the local Docling worker.
 *
 * The worker is a separate Python process so a crash, a slow model load or a
 * cancel signal can never take the Electron renderer down. The protocol is one
 * JSON request on stdin and one JSON object on stdout; diagnostics go to stderr.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { RagError } from '../types.ts'
import type { ParsedDocument } from '../types.ts'

export interface DoclingRunOptions {
  python?: string
  worker?: string
  timeoutMs?: number
  ocr?: boolean
  chunkTokens?: number
  hybridChunking?: boolean
}

export interface DoclingHybridChunk {
  text: string
  page: number
  headings: string[]
  tokens: number
}

export interface DoclingRunResult {
  document: ParsedDocument
  hybridChunks?: DoclingHybridChunk[]
}

interface WorkerEnvelope {
  ok: boolean
  version?: string
  document?: ParsedDocument
  hybridChunks?: DoclingHybridChunk[]
  error?: { code?: string; message?: string; detail?: string }
}

export function defaultWorkerPath(): string {
  return fileURLToPath(new URL('./worker.py', import.meta.url))
}

function runProcess(
  python: string,
  args: string[],
  input: string,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new RagError('DOCLING_UNAVAILABLE', `cannot start Docling worker: ${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
    child.stdin.end(input)
  })
}

function lastJsonLine(stdout: string): WorkerEnvelope | null {
  const lines = stdout.trim().split(/\r?\n/).filter((line) => line.trim().length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line) as WorkerEnvelope
    } catch {
      // keep looking: a stray print must not mask the real envelope
    }
  }
  return null
}

/** Heuristic probe used by diagnostics; never throws. */
export async function probeDocling(options: DoclingRunOptions = {}): Promise<{ available: boolean; version?: string; reason?: string }> {
  const python = options.python ?? process.env.RAG_DOCLING_PYTHON ?? 'python'
  const code = 'import json,importlib.metadata as m\ntry:\n print(json.dumps({"ok":True,"version":m.version("docling")}))\nexcept Exception as e:\n print(json.dumps({"ok":False,"error":{"message":str(e)}}))'
  try {
    const result = await runProcess(python, ['-X', 'utf8', '-c', code], '', options.timeoutMs ?? 20000)
    const parsed = lastJsonLine(result.stdout)
    if (parsed === null) return { available: false, reason: result.stderr.trim() || 'no JSON from python probe' }
    if (parsed.ok) return { available: true, version: parsed.version }
    return { available: false, reason: parsed.error?.message ?? 'docling import failed' }
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export async function runDocling(pdfPath: string, fileName: string, options: DoclingRunOptions = {}): Promise<DoclingRunResult> {
  const python = options.python ?? process.env.RAG_DOCLING_PYTHON ?? 'python'
  const worker = options.worker ?? process.env.RAG_DOCLING_WORKER ?? defaultWorkerPath()
  const request = JSON.stringify({
    path: pdfPath,
    fileName,
    ocr: options.ocr ?? true,
    chunkTokens: options.chunkTokens ?? 700,
    hybridChunking: options.hybridChunking ?? true
  })
  const result = await runProcess(python, ['-X', 'utf8', worker], `${request}\n`, options.timeoutMs ?? 180000)
  const envelope = lastJsonLine(result.stdout)
  if (result.timedOut) throw new RagError('DOCLING_UNAVAILABLE', `Docling worker timed out after ${options.timeoutMs ?? 180000} ms`, result.stderr)
  if (envelope === null) {
    throw new RagError(
      'DOCLING_UNAVAILABLE',
      'Docling worker produced no JSON envelope',
      result.stderr.trim() || `exit code ${String(result.code)}`
    )
  }
  if (!envelope.ok || envelope.document === undefined) {
    const message = envelope.error?.message ?? 'Docling worker failed'
    const detail = envelope.error?.detail ?? result.stderr.trim()
    throw new RagError('PARSE_FAILED', message, detail)
  }
  const document = envelope.document
  if (!Array.isArray(document.pages) || !Array.isArray(document.blocks)) {
    throw new RagError('PARSE_FAILED', 'Docling worker returned a malformed document')
  }
  return { document, hybridChunks: envelope.hybridChunks }
}
