/**
 * SQLite storage for sources and chunks, plus a trigram FTS index used as a
 * candidate filter. Retrieval re-scores the terms in JS because FTS5 trigram
 * cannot match 2-character CJK terms, which are the common case in this corpus.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SourceRecord, SourceStatus, StoredChunk } from './types.ts'

function parsePages(value: unknown): number[] {
  if (typeof value === 'number') return value > 0 ? [value] : []
  if (typeof value !== 'string' || value.length === 0) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is number => typeof item === 'number') : []
  } catch {
    return []
  }
}

function parseWarnings(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export class RagStore {
  readonly dbPath: string
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    this.dbPath = dbPath
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.init()
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (
        project_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        file_name TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL,
        kind TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        parser TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        pages INTEGER NOT NULL,
        ocr_pages INTEGER NOT NULL,
        imported_at TEXT NOT NULL,
        warnings TEXT NOT NULL,
        PRIMARY KEY (project_id, source_id, revision)
      );
      CREATE TABLE IF NOT EXISTS chunks (
        project_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        page INTEGER NOT NULL,
        char_start INTEGER NOT NULL,
        char_end INTEGER NOT NULL,
        heading TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (project_id, chunk_id)
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks (project_id, source_id, revision);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5 (chunk_id UNINDEXED, text, tokenize = 'trigram');
    `)
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  /** Marks any previous active revision of the source as superseded, then inserts. */
  upsertSource(record: SourceRecord): void {
    this.db
      .prepare("UPDATE sources SET status = 'superseded' WHERE project_id = ? AND source_id = ? AND status = 'active'")
      .run(record.projectId, record.sourceId)
    this.db
      .prepare(
        `INSERT INTO sources (project_id, source_id, revision, file_name, path, status, kind, bytes, sha256, parser, parser_version, pages, ocr_pages, imported_at, warnings)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, source_id, revision) DO UPDATE SET
           status = excluded.status, imported_at = excluded.imported_at, warnings = excluded.warnings`
      )
      .run(
        record.projectId,
        record.sourceId,
        record.revision,
        record.fileName,
        record.path,
        record.status,
        record.kind,
        record.bytes,
        record.sha256,
        record.parser,
        record.parserVersion,
        record.pages,
        JSON.stringify(record.ocrPages),
        record.importedAt,
        JSON.stringify(record.warnings)
      )
  }

  replaceChunks(projectId: string, sourceId: string, revision: string, chunks: StoredChunk[]): void {
    const stale = this.db.prepare('SELECT chunk_id FROM chunks WHERE project_id = ? AND source_id = ? AND revision != ?').all(projectId, sourceId, revision) as { chunk_id: string }[]
    for (const row of stale) {
      this.db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?').run(row.chunk_id)
      this.db.prepare('DELETE FROM chunks WHERE project_id = ? AND chunk_id = ?').run(projectId, row.chunk_id)
    }
    const deleteChunk = this.db.prepare('DELETE FROM chunks WHERE project_id = ? AND chunk_id = ?')
    const deleteFts = this.db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?')
    const insert = this.db.prepare(
      `INSERT INTO chunks (project_id, source_id, revision, chunk_id, ordinal, page, char_start, char_end, heading, kind, text, token_count, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertFts = this.db.prepare('INSERT INTO chunks_fts (chunk_id, text) VALUES (?, ?)')
    for (const chunk of chunks) {
      deleteChunk.run(projectId, chunk.chunkId)
      deleteFts.run(chunk.chunkId)
      insert.run(
        projectId,
        chunk.sourceId,
        chunk.sourceRevision,
        chunk.chunkId,
        chunk.ordinal,
        chunk.page,
        chunk.charStart,
        chunk.charEnd,
        chunk.heading ?? '',
        chunk.kind,
        chunk.text,
        chunk.tokenCount,
        chunk.contentHash
      )
      insertFts.run(chunk.chunkId, `${chunk.heading}\n${chunk.text}`)
    }
  }

  setSourceStatus(projectId: string, sourceId: string, status: SourceStatus): void {
    this.db.prepare("UPDATE sources SET status = ? WHERE project_id = ? AND source_id = ? AND status = 'active'").run(status, projectId, sourceId)
    if (status === 'revoked') {
      const ids = this.db.prepare('SELECT chunk_id FROM chunks WHERE project_id = ? AND source_id = ?').all(projectId, sourceId) as { chunk_id: string }[]
      for (const row of ids) {
        this.db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?').run(row.chunk_id)
        this.db.prepare('DELETE FROM chunks WHERE project_id = ? AND chunk_id = ?').run(projectId, row.chunk_id)
      }
    }
  }

  getSource(projectId: string, sourceId: string, revision?: string): SourceRecord | null {
    const row = (
      revision === undefined
        ? this.db
            .prepare("SELECT * FROM sources WHERE project_id = ? AND source_id = ? AND status = 'active' ORDER BY imported_at DESC LIMIT 1")
            .get(projectId, sourceId)
        : this.db.prepare('SELECT * FROM sources WHERE project_id = ? AND source_id = ? AND revision = ?').get(projectId, sourceId, revision)
    ) as Record<string, unknown> | undefined
    if (row === undefined) return null
    return {
      projectId: String(row.project_id),
      sourceId: String(row.source_id),
      fileName: String(row.file_name),
      path: String(row.path),
      revision: String(row.revision),
      status: String(row.status) as SourceStatus,
      kind: String(row.kind) as 'pdf' | 'markdown',
      bytes: Number(row.bytes),
      sha256: String(row.sha256),
      parser: String(row.parser) as SourceRecord['parser'],
      parserVersion: String(row.parser_version),
      pages: Number(row.pages),
      ocrPages: parsePages(row.ocr_pages),
      importedAt: String(row.imported_at),
      warnings: parseWarnings(row.warnings)
    }
  }

  listSources(projectId: string): SourceRecord[] {
    const rows = this.db.prepare('SELECT * FROM sources WHERE project_id = ? ORDER BY imported_at ASC').all(projectId) as Record<string, unknown>[]
    return rows.map((row) => ({
      projectId: String(row.project_id),
      sourceId: String(row.source_id),
      fileName: String(row.file_name),
      path: String(row.path),
      revision: String(row.revision),
      status: String(row.status) as SourceStatus,
      kind: String(row.kind) as 'pdf' | 'markdown',
      bytes: Number(row.bytes),
      sha256: String(row.sha256),
      parser: String(row.parser) as SourceRecord['parser'],
      parserVersion: String(row.parser_version),
      pages: Number(row.pages),
      ocrPages: parsePages(row.ocr_pages),
      importedAt: String(row.imported_at),
      warnings: parseWarnings(row.warnings)
    }))
  }

  activeSourceRevisions(projectId: string): Map<string, string> {
    const rows = this.db.prepare("SELECT source_id, revision FROM sources WHERE project_id = ? AND status = 'active'").all(projectId) as { source_id: string; revision: string }[]
    return new Map(rows.map((row) => [row.source_id, row.revision]))
  }

  activeChunks(projectId: string): StoredChunk[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM chunks c
         JOIN sources s ON s.project_id = c.project_id AND s.source_id = c.source_id AND s.revision = c.revision
         WHERE c.project_id = ? AND s.status = 'active'
         ORDER BY c.source_id, c.ordinal`
      )
      .all(projectId) as Record<string, unknown>[]
    return rows.map(rowToChunk)
  }

  chunkById(projectId: string, chunkId: string): StoredChunk | null {
    const row = this.db.prepare('SELECT * FROM chunks WHERE project_id = ? AND chunk_id = ?').get(projectId, chunkId) as Record<string, unknown> | undefined
    return row === undefined ? null : rowToChunk(row)
  }

  countChunks(projectId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM chunks c JOIN sources s ON s.project_id = c.project_id AND s.source_id = c.source_id AND s.revision = c.revision WHERE c.project_id = ? AND s.status = 'active'`
      )
      .get(projectId) as { n: number }
    return Number(row.n)
  }

  /** FTS5 candidate filter; returns chunk ids for >=3-char terms, empty otherwise. */
  ftsCandidates(projectId: string, query: string, limit: number): string[] {
    const terms = query
      .split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length >= 3)
      .slice(0, 8)
    if (terms.length === 0) return []
    const match = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
    try {
      const rows = this.db
        .prepare(
          `SELECT f.chunk_id FROM chunks_fts f JOIN chunks c ON c.chunk_id = f.chunk_id
           WHERE chunks_fts MATCH ? AND c.project_id = ? LIMIT ?`
        )
        .all(match, projectId, limit) as { chunk_id: string }[]
      return rows.map((row) => row.chunk_id)
    } catch {
      return []
    }
  }

  indexBytes(): number {
    try {
      const pageCount = this.db.prepare('PRAGMA page_count').get() as Record<string, unknown> | undefined
      const pageSize = this.db.prepare('PRAGMA page_size').get() as Record<string, unknown> | undefined
      const count = Number(pageCount?.page_count ?? 0)
      const size = Number(pageSize?.page_size ?? 0)
      if (count > 0 && size > 0) return count * size
    } catch {
      // fall through to the file size below
    }
    try {
      return statSync(this.dbPath).size
    } catch {
      return 0
    }
  }

  close(): void {
    this.db.close()
  }
}

function rowToChunk(row: Record<string, unknown>): StoredChunk {
  return {
    projectId: String(row.project_id),
    sourceId: String(row.source_id),
    sourceRevision: String(row.revision),
    chunkId: String(row.chunk_id),
    ordinal: Number(row.ordinal),
    page: Number(row.page),
    charStart: Number(row.char_start),
    charEnd: Number(row.char_end),
    heading: String(row.heading).length > 0 ? String(row.heading) : undefined,
    kind: String(row.kind) as StoredChunk['kind'],
    text: String(row.text),
    tokenCount: Number(row.token_count),
    contentHash: String(row.content_hash)
  }
}
