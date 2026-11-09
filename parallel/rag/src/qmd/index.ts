/**
 * QMD 2.8.3 bridge.
 *
 * QMD indexes markdown files from a collection directory, so the adapter projects
 * every active chunk to `<corpus>/<source>--<revision>--<nnn>.md`, keeps a
 * path → chunkId map, then calls the real SDK (`update` + `embed` + `search`).
 * When `@tobilu/qmd` cannot be imported (models/native deps are optional in this
 * prototype) the bridge reports `local-lexical` with an explicit reason and the
 * retrieval layer falls back to FTS5 + hashed vectors.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { RagError } from '../types.ts'
import type { QmdSyncStatus, SourceRecord, StoredChunk } from '../types.ts'
import type { RagStore } from '../store.ts'

export interface QmdHit {
  chunkId: string
  score: number
}

export interface QmdBridgeOptions {
  dataDir: string
  projectId: string
  moduleName?: string
  collection?: string
  embedModel?: string
}

interface QmdStoreLike {
  update(options: { collections?: string[] }): Promise<unknown>
  embed(options: { force?: boolean }): Promise<unknown>
  search(options: Record<string, unknown>): Promise<unknown[]>
  searchLex(query: string, options?: Record<string, unknown>): Promise<unknown[]>
  searchVector(query: string, options?: Record<string, unknown>): Promise<unknown[]>
  close(): Promise<void>
}

const QMD_VERSION = '2.8.3'

export class QmdBridge {
  private readonly dataDir: string
  private readonly projectId: string
  private readonly moduleName: string
  private readonly collection: string
  private readonly embedModel: string
  private store: QmdStoreLike | null = null
  private corpusDir: string
  private map = new Map<string, string>()
  status: QmdSyncStatus = { ok: false, vector: false, engine: 'local-lexical', reason: 'QMD 尚未初始化' }

  constructor(options: QmdBridgeOptions) {
    this.dataDir = options.dataDir
    this.projectId = options.projectId
    this.moduleName = options.moduleName ?? process.env.RAG_QMD_MODULE ?? '@tobilu/qmd'
    this.collection = options.collection ?? `rag-${options.projectId.replace(/[^A-Za-z0-9_-]/g, '_')}`
    this.embedModel = options.embedModel ?? process.env.QMD_EMBED_MODEL ?? 'embeddinggemma-300M-Q8_0'
    this.corpusDir = join(this.dataDir, 'qmd', this.projectId, 'corpus')
  }

  get collectionName(): string {
    return this.collection
  }

  get corpusPath(): string {
    return this.corpusDir
  }

  /** Loads the SDK and opens/creates the per-project store. Never throws. */
  async initialize(): Promise<QmdSyncStatus> {
    try {
      const module = (await import(this.moduleName)) as { createStore?: unknown; default?: { createStore?: unknown } }
      const createStore = module.createStore ?? module.default?.createStore
      if (typeof createStore !== 'function') throw new Error('module does not export createStore')
      mkdirSync(this.corpusDir, { recursive: true })
      mkdirSync(join(this.dataDir, 'qmd', this.projectId), { recursive: true })
      writeFileSync(
        join(this.dataDir, 'qmd', this.projectId, 'identity.json'),
        JSON.stringify({ qmd: QMD_VERSION, collection: this.collection, embedModel: this.embedModel, chunking: 'rag-chunk-v1' }, null, 2)
      )
      this.store = (await createStore({
        dbPath: join(this.dataDir, 'qmd', this.projectId, 'index.sqlite'),
        config: { collections: { [this.collection]: { path: this.corpusDir, pattern: '**/*.md' } } }
      })) as QmdStoreLike
      this.status = { ok: true, vector: true, engine: 'qmd', mode: 'hybrid', collections: [this.collection] }
    } catch (error) {
      this.status = {
        ok: false,
        vector: false,
        engine: 'local-lexical',
        reason: `QMD ${QMD_VERSION} 不可用（${error instanceof Error ? error.message : String(error)}），回退到本地词法+哈希向量`
      }
    }
    return this.status
  }

  /** Rewrites the projection from active chunks, then update() + embed(). */
  async sync(store: RagStore, sources?: SourceRecord[]): Promise<QmdSyncStatus> {
    if (this.store === null) return this.status
    const chunks = store.activeChunks(this.projectId)
    rmSync(this.corpusDir, { recursive: true, force: true })
    mkdirSync(this.corpusDir, { recursive: true })
    const mapping: Record<string, string> = {}
    for (const chunk of chunks) {
      const name = `${safe(this.chunkFileStem(chunk))}.md`
      const body = `# ${chunk.heading || chunk.sourceId}\n\n${chunk.text}\n`
      writeFileSync(join(this.corpusDir, name), body, 'utf8')
      mapping[name] = chunk.chunkId
      this.map.set(name, chunk.chunkId)
    }
    // Drop stale mapping entries from removed sources.
    const keep = new Set(Object.keys(mapping))
    for (const key of [...this.map.keys()]) if (!keep.has(key)) this.map.delete(key)
    writeFileSync(join(this.dataDir, 'qmd', this.projectId, 'map.json'), JSON.stringify(mapping, null, 2))
    try {
      await this.store.update({ collections: [this.collection] })
      await this.store.embed({})
      this.status = { ok: true, vector: true, engine: 'qmd', mode: 'hybrid', collections: [this.collection], reason: this.status.reason }
    } catch (error) {
      this.status = {
        ok: false,
        vector: false,
        engine: 'local-lexical',
        reason: `QMD 索引失败: ${error instanceof Error ? error.message : String(error)}（回退到本地词法+哈希向量）`
      }
    }
    return this.status
  }

  private chunkFileStem(chunk: StoredChunk): string {
    return `${chunk.sourceId}--r${chunk.sourceRevision}--${String(chunk.ordinal).padStart(3, '0')}`
  }

  private mapRows(rows: unknown[]): QmdHit[] {
    const hits: QmdHit[] = []
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue
      const record = row as Record<string, unknown>
      const file = typeof record.file === 'string' ? record.file : typeof record.path === 'string' ? record.path : ''
      const path = file.replace(/^qmd:\/\/[^/]+\//, '')
      const chunkId = this.map.get(path)
      const score = typeof record.score === 'number' ? record.score : 0
      if (chunkId !== undefined) hits.push({ chunkId, score })
    }
    return hits
  }

  async search(query: string, limit: number): Promise<QmdHit[]> {
    if (this.store === null || !this.status.ok) return []
    try {
      return this.mapRows(await this.store.search({ query, collections: [this.collection], limit, rerank: process.env.RAG_QMD_RERANK === '1' }))
    } catch {
      return []
    }
  }

  async searchLex(query: string, limit: number): Promise<QmdHit[]> {
    if (this.store === null || !this.status.ok) return []
    try {
      return this.mapRows(await this.store.searchLex(query, { collection: this.collection, limit }))
    } catch {
      return []
    }
  }

  async searchVector(query: string, limit: number): Promise<QmdHit[]> {
    if (this.store === null || !this.status.ok) return []
    try {
      return this.mapRows(await this.store.searchVector(query, { collection: this.collection, limit }))
    } catch {
      return []
    }
  }

  async close(): Promise<void> {
    if (this.store !== null) {
      try {
        await this.store.close()
      } catch {
        // ignore: closing must never mask the original error
      }
    }
    this.store = null
  }
}

function safe(stem: string): string {
  return stem.replace(/[^A-Za-z0-9._-]/g, '_').replace(/-+$/, '')
}

/** Relative markdown files currently in the corpus (used by diagnostics and tests). */
export function corpusFiles(corpusDir: string): string[] {
  try {
    return readdirSync(corpusDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => join(corpusDir, name))
      .map((path) => relative(corpusDir, path).split(sep).join('/'))
  } catch (error) {
    throw new RagError('READ_FAILED', 'cannot list QMD corpus', error instanceof Error ? error.message : String(error))
  }
}
