/**
 * RAG adapter entry point for the mainline. It owns parsing, chunking, storage
 * and retrieval for ONE project; the caller owns project identity, the active
 * source list, cancellation and the decision to commit an import.
 */
import { readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { RagError } from './types.ts'
import type {
  ImportInput,
  ImportResult,
  ParsedDocument,
  RagAdapter,
  RagDiagnostics,
  SearchInput,
  SearchResult,
  SourceRecord,
  StoredChunk
} from './types.ts'
import { RagStore } from './store.ts'
import { QmdBridge } from './qmd/index.ts'
import { parsePdfBuffer } from './docling/pdf.ts'
import { probeDocling, runDocling } from './docling/client.ts'
import { chunkDocument, sha256Bytes } from './chunk.ts'
import { parseMarkdown } from './markdown.ts'
import { retrieve } from './retrieve.ts'

export interface RagAdapterOptions {
  dataDir: string
  projectId: string
  qmdModule?: string
  python?: string
  doclingWorker?: string
  timeoutMs?: number
  useDocling?: boolean
}

export class LocalRagAdapter implements RagAdapter {
  readonly projectId: string
  readonly dataDir: string
  private readonly options: RagAdapterOptions
  private store: RagStore
  private bridge: QmdBridge
  private docling = { available: false, version: undefined as string | undefined, reason: 'not probed' }
  private initialized = false

  constructor(options: RagAdapterOptions) {
    if (options.projectId.trim().length === 0) throw new RagError('VALIDATION', 'projectId must not be empty')
    this.options = options
    this.projectId = options.projectId
    this.dataDir = options.dataDir
    this.store = new RagStore(join(options.dataDir, 'index.sqlite'))
    this.bridge = new QmdBridge({ dataDir: options.dataDir, projectId: options.projectId, moduleName: options.qmdModule })
  }

  async initialize(): Promise<RagDiagnostics> {
    if (this.initialized) return this.diagnostics()
    this.docling = await probeDocling({ python: this.options.python, timeoutMs: 20000 })
    await this.bridge.initialize()
    if (this.bridge.status.ok) await this.bridge.sync(this.store)
    this.initialized = true
    return this.diagnostics()
  }

  private ensureInitialized(): void {
    if (!this.initialized) throw new RagError('INTERNAL', 'adapter not initialized; call initialize() first')
  }

  private sanitizeId(sourceId: string): string {
    return sourceId.replace(/[\\/:*?"<>|]/g, '_').trim()
  }

  async importSource(input: ImportInput): Promise<ImportResult> {
    return this.ingest(input)
  }

  async replaceSource(sourceId: string, input: ImportInput): Promise<ImportResult> {
    return this.ingest({ ...input, sourceId: input.sourceId ?? sourceId })
  }

  private async ingest(input: ImportInput): Promise<ImportResult> {
    this.ensureInitialized()
    const path = input.path
    if (typeof path !== 'string' || path.trim().length === 0) throw new RagError('VALIDATION', 'path is required')
    let bytes: Buffer
    let size = 0
    try {
      bytes = readFileSync(path)
      size = statSync(path).size
    } catch (error) {
      throw new RagError('READ_FAILED', `cannot read ${path}`, error instanceof Error ? error.message : String(error))
    }
    if (bytes.length === 0) throw new RagError('READ_FAILED', `empty file: ${path}`)

    const fileName = basename(path)
    const extension = extname(fileName).toLowerCase()
    const digest = sha256Bytes(bytes)
    const sourceId = this.sanitizeId(input.sourceId ?? basename(fileName, extension))
    const revision = digest.slice(0, 12)
    const warnings: string[] = []
    let document: ParsedDocument

    if (extension === '.pdf') {
      document = await this.parsePdf(path, fileName, warnings)
    } else if (extension === '.md' || extension === '.markdown') {
      document = parseMarkdown(bytes.toString('utf8'), fileName)
    } else {
      throw new RagError('VALIDATION', `unsupported source type: ${extension || '(none)'}`, 'expected .pdf or .md')
    }

    const chunks = chunkDocument(document, { projectId: this.projectId, sourceId, sourceRevision: revision })
    if (chunks.length === 0) {
      warnings.push('no extractable text; source stored without chunks (OCR required)')
    }

    const previous = this.store.getSource(this.projectId, sourceId)
    const record: SourceRecord = {
      projectId: this.projectId,
      sourceId,
      fileName,
      path,
      revision,
      status: 'active',
      kind: extension === '.pdf' ? 'pdf' : 'markdown',
      bytes: size,
      sha256: digest,
      parser: document.parser,
      parserVersion: document.parserVersion,
      pages: document.pages.length,
      ocrPages: document.pages.filter((page) => page.ocr === 'required' || page.ocr === 'performed').length,
      importedAt: new Date().toISOString(),
      warnings
    }

    this.store.transaction(() => {
      this.store.upsertSource(record)
      this.store.replaceChunks(this.projectId, sourceId, revision, chunks)
    })
    const qmd = await this.bridge.sync(this.store)
    return {
      source: record,
      replacedRevision: previous !== null && previous.revision !== revision ? previous.revision : undefined,
      chunkCount: chunks.length,
      qmd
    }
  }

  private async parsePdf(path: string, fileName: string, warnings: string[]): Promise<ParsedDocument> {
    const useDocling = this.options.useDocling !== false && this.docling.available
    if (useDocling) {
      try {
        const result = await runDocling(path, fileName, {
          python: this.options.python,
          worker: this.options.doclingWorker,
          timeoutMs: this.options.timeoutMs ?? 180000
        })
        if (result.document.warnings.length > 0) warnings.push(...result.document.warnings)
        return result.document
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        warnings.push(`Docling failed, used PDF fallback parser: ${message}`)
      }
    } else {
      warnings.push(`Docling unavailable (${this.docling.reason ?? 'not installed'}), used PDF fallback parser`)
    }
    return parsePdfBuffer(readFileSync(path), fileName)
  }

  async revokeSource(sourceId: string): Promise<SourceRecord | null> {
    this.ensureInitialized()
    const source = this.store.getSource(this.projectId, sourceId)
    if (source === null) return null
    this.store.setSourceStatus(this.projectId, sourceId, 'revoked')
    await this.bridge.sync(this.store)
    return { ...source, status: 'revoked' }
  }

  async listSources(): Promise<SourceRecord[]> {
    this.ensureInitialized()
    return this.store.listSources(this.projectId)
  }

  async search(input: SearchInput): Promise<SearchResult> {
    this.ensureInitialized()
    try {
      return await retrieve({ store: this.store, bridge: this.bridge, projectId: this.projectId }, input)
    } catch (error) {
      if (error instanceof Error && error.message === 'query must not be empty') {
        throw new RagError('VALIDATION', 'query must not be empty')
      }
      throw error instanceof RagError ? error : new RagError('INTERNAL', error instanceof Error ? error.message : String(error))
    }
  }

  async diagnostics(): Promise<RagDiagnostics> {
    const sources = this.store.listSources(this.projectId)
    return {
      projectId: this.projectId,
      dataDir: this.dataDir,
      sources: sources.length,
      activeSources: sources.filter((source) => source.status === 'active').length,
      chunks: this.store.countChunks(this.projectId),
      indexBytes: this.store.indexBytes(),
      qmd: this.bridge.status,
      parsers: {
        docling: this.docling.available,
        'pdf-fallback': true,
        markdown: true
      }
    }
  }

  /** Chunk count helper used by the acceptance script. */
  chunkCount(): number {
    return this.store.countChunks(this.projectId)
  }

  /** All active chunks, used by acceptance metrics (not part of the mainline DTO). */
  activeChunks(): StoredChunk[] {
    return this.store.activeChunks(this.projectId)
  }

  async close(): Promise<void> {
    await this.bridge.close()
    this.store.close()
    this.initialized = false
  }
}

export function createRagAdapter(options: RagAdapterOptions): LocalRagAdapter {
  return new LocalRagAdapter(options)
}

/** Cheap guard used by tests for invalid inputs. */
export function isRagError(value: unknown): value is RagError {
  return value instanceof RagError
}
