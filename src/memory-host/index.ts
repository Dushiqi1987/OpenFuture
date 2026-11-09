/**
 * Memory host: the only process allowed to write the application's memory DB.
 *
 * P1 layers:
 *  - L0 evidence: immutable chunks captured from user-selected sources.
 *  - L1 notes: versioned Markdown notes, active only after user approval.
 *  - L2 wiki: draft pages generated from evidence, published only after review.
 *
 * Retrieval is FTS5 with a trigram tokenizer plus a LIKE fallback for 1-2
 * character queries. The QMD adapter record lives in docs/P1-上游复现记录.md;
 * this host keeps a portable in-process keyword projection so the app works
 * offline and without downloading any model.
 */
import type { ParentPort } from 'electron'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type {
  DreamJob,
  DreamOp,
  DreamOpType,
  DreamPhase,
  DreamQuality,
  DreamQualityCheck,
  DreamScheduleState,
  DreamState,
  DreamVersion,
  MemoryCitation,
  MemoryDiagnostics,
  MemoryHitKind,
  MemoryMode,
  MemorySearchEngine,
  MemoryWikiEngine,
  MemoryNote,
  MemoryNoteType,
  MemoryProposal,
  MemorySearchHit,
  MemorySource,
  MemoryWorkspaceState,
  WikiPage
} from '../shared/protocol'

interface RpcRequest {
  kind: 'request'
  id: number
  method: string
  params?: unknown
}

class RpcError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const port: ParentPort = process.parentPort
const memoryDir = requiredEnv('OPENFUTURE_MEMORY_DIR')
const databasePath = join(memoryDir, 'memory.sqlite')
const TOKENIZER = 'trigram'
const SAMPLE_BODY = '记忆库 P0 自检：OpenFuture 通过独立 utilityProcess 访问 SQLite FTS5。'
const SAMPLE_QUERY = '记忆库'
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_SEARCH_RESULTS = 50
/**
 * Optional QMD module (see docs/P1-上游复现记录.md). The app never depends on it:
 * without the env var every search stays on the in-process FTS5 projection.
 * The path points at @tobilu/qmd/dist/index.js in a separately installed tree.
 */
const QMD_MODULE_PATH = process.env.OPENFUTURE_QMD_MODULE?.trim() ?? ''

interface QmdSearchRow {
  filepath?: string
  displayPath?: string
  title?: string
  body?: string
  score?: number
}

interface QmdStore {
  update(): Promise<unknown>
  searchLex(query: string, options?: { limit?: number }): Promise<QmdSearchRow[]>
  close(): Promise<unknown> | unknown
}

const qmdStores = new Map<string, Promise<QmdStore>>()
let qmdLastError = ''

/**
 * Optional pi-llm-wiki MCP bridge. Both variables are required: the module is
 * an external package and the vault lives outside the app, so the default
 * build never downloads or bundles it.
 */
const WIKI_ENV_MCP_PATH = process.env.OPENFUTURE_WIKI_MCP?.trim() ?? ''
const WIKI_ENV_ROOT = process.env.OPENFUTURE_WIKI_ROOT?.trim() ?? ''
const WIKI_MCP_TIMEOUT_MS = 10_000
const WIKI_MAX_RESULTS = 10

interface WikiRecallRow {
  id?: string
  title?: string
  type?: string
  preview?: string
  path?: string
  score?: number
}

interface WikiBinding {
  workspaceId: string
  vaultRoot: string
  mcpPath: string
}

interface WikiMcpClient {
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<string>
  close(): void
}

const wikiClients = new Map<string, Promise<WikiMcpClient>>()
const wikiErrors = new Map<string, string>()

/**
 * The env pair is only a *provisioning* source. The first workspace that uses
 * it owns the binding; every other workspace stays off, even after restart.
 */
function wikiBinding(workspaceId: string): WikiBinding | null {
  const row = db()
    .prepare('SELECT workspace_id, vault_root, mcp_path FROM workspace_wiki WHERE workspace_id = ?')
    .get(workspaceId) as { workspace_id: string; vault_root: string; mcp_path: string } | undefined
  if (row) {
    return { workspaceId: row.workspace_id, vaultRoot: row.vault_root, mcpPath: row.mcp_path }
  }
  if (!WIKI_ENV_MCP_PATH || !WIKI_ENV_ROOT) return null
  const existing = db().prepare('SELECT workspace_id FROM workspace_wiki LIMIT 1').get() as
    | { workspace_id?: string }
    | undefined
  if (existing?.workspace_id) return null
  db()
    .prepare(
      'INSERT OR IGNORE INTO workspace_wiki(workspace_id, vault_root, mcp_path, updated_at) VALUES (?, ?, ?, ?)'
    )
    .run(workspaceId, WIKI_ENV_ROOT, WIKI_ENV_MCP_PATH, Date.now())
  return { workspaceId, vaultRoot: WIKI_ENV_ROOT, mcpPath: WIKI_ENV_MCP_PATH }
}

function wikiConfigured(workspaceId: string): boolean {
  return wikiBinding(workspaceId) !== null
}

/** Extract the pretty-printed JSON array from a recall response that may append diagnostics. */
function extractJsonArray(text: string): unknown[] {
  const start = text.indexOf('[')
  if (start < 0) throw new Error('Wiki 返回内容不是 JSON 数组')
  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) throw new Error('Wiki 返回的 JSON 数组不完整')
  const parsed: unknown = JSON.parse(text.slice(start, end + 1))
  if (!Array.isArray(parsed)) throw new Error('Wiki 返回内容不是 JSON 数组')
  return parsed
}

function startWikiClient(binding: WikiBinding): Promise<WikiMcpClient> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binding.mcpPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        WIKI_ROOT: binding.vaultRoot
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let buffer = ''
    let stderr = ''
    let nextId = 1
    let closed = false
    let ready = false
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
    >()

    const failAll = (error: Error): void => {
      closed = true
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(error)
      }
      pending.clear()
    }

    const send = (method: string, params?: Record<string, unknown>, timeoutMs = WIKI_MCP_TIMEOUT_MS): Promise<unknown> => {
      if (closed) return Promise.reject(new Error(wikiErrors.get(binding.workspaceId) || 'Wiki MCP 已关闭'))
      const id = nextId++
      const message: Record<string, unknown> = { jsonrpc: '2.0', id, method }
      if (params) message.params = params
      return new Promise((resolveCall, rejectCall) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          rejectCall(new Error(`Wiki MCP 请求超时（${method}）`))
        }, timeoutMs)
        pending.set(id, { resolve: resolveCall, reject: rejectCall, timer })
        try {
          child.stdin.write(`${JSON.stringify(message)}\n`)
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          rejectCall(error instanceof Error ? error : new Error(String(error)))
        }
      })
    }

    const notify = (method: string): void => {
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
      } catch {
        // The child is exiting; pending/exit handling reports the failure.
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        let message: {
          id?: number
          result?: unknown
          error?: { code?: number; message?: string }
        }
        try {
          message = JSON.parse(line) as typeof message
        } catch {
          continue
        }
        if (typeof message.id !== 'number') continue
        const entry = pending.get(message.id)
        if (!entry) continue
        pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error) {
          entry.reject(new Error(`Wiki MCP：${message.error.message ?? `错误 ${message.error.code ?? ''}`}`))
        } else {
          entry.resolve(message.result)
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000)
    })
    child.on('error', (error) => {
      wikiErrors.set(binding.workspaceId, error.message)
      failAll(error)
      if (!ready) reject(error)
    })
    child.on('exit', (code) => {
      const detail = stderr.trim().split(/\r?\n/).slice(-3).join(' | ')
      const error = new Error(`Wiki MCP 已退出（${code ?? 'unknown'}）${detail ? `：${detail}` : ''}`)
      wikiErrors.set(binding.workspaceId, error.message)
      failAll(error)
      if (!ready) reject(error)
    })

    void send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'OpenFuture', version: '0.1.0' }
    })
      .then(() => {
        notify('notifications/initialized')
        ready = true
        resolve({
          callTool: async (name, args, timeoutMs) => {
            const result = (await send('tools/call', { name, arguments: args }, timeoutMs)) as {
              content?: Array<{ type?: string; text?: string }>
              isError?: boolean
            }
            const text = result.content?.find((part) => part.type === 'text')?.text ?? ''
            if (result.isError) throw new Error(text || 'Wiki 工具调用失败')
            return text
          },
          close: () => {
            closed = true
            try {
              child.stdin.end()
            } catch {
              // Already closed.
            }
            child.kill()
          }
        })
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error)
        wikiErrors.set(binding.workspaceId, detail)
        closed = true
        try {
          child.kill()
        } catch {
          // Ignore.
        }
        reject(new Error(detail))
      })
  })
}

function getWikiClient(workspaceId: string, binding: WikiBinding): Promise<WikiMcpClient> {
  let pending = wikiClients.get(workspaceId)
  if (!pending) {
    pending = startWikiClient(binding).catch((error: unknown) => {
      wikiClients.delete(workspaceId)
      throw error
    })
    wikiClients.set(workspaceId, pending)
  }
  return pending
}

function closeWikiClient(workspaceId: string): void {
  const pending = wikiClients.get(workspaceId)
  wikiClients.delete(workspaceId)
  if (!pending) return
  void pending.then((client) => client.close()).catch(() => undefined)
}

async function searchWiki(
  workspaceId: string,
  query: string,
  limit: number
): Promise<{ hits: MemorySearchHit[]; ok: boolean; error?: string }> {
  const binding = wikiBinding(workspaceId)
  if (!binding) return { hits: [], ok: false }
  try {
    const client = await getWikiClient(workspaceId, binding)
    const text = await client.callTool('wiki_recall', {
      query,
      max_results: Math.min(Math.max(limit, 1), WIKI_MAX_RESULTS)
    })
    const rows = extractJsonArray(text) as WikiRecallRow[]
    const hits: MemorySearchHit[] = []
    for (const row of rows) {
      const rawId = typeof row.id === 'string' ? row.id.trim() : ''
      if (!rawId) continue
      const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : rawId
      const score = typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : 0
      hits.push({
        id: `llm-wiki:${rawId}`,
        kind: 'wiki',
        title,
        excerpt: typeof row.preview === 'string' ? row.preview : '',
        citation: {
          label: `LLM Wiki · ${title}`,
          ...(typeof row.path === 'string' && row.path ? { locator: row.path } : {})
        },
        score: Math.max(0, score),
        engine: 'wiki'
      })
      if (hits.length >= limit) break
    }
    wikiErrors.delete(workspaceId)
    return { hits, ok: true }
  } catch (error) {
    wikiErrors.set(workspaceId, error instanceof Error ? error.message : String(error))
    closeWikiClient(workspaceId)
    return { hits: [], ok: false, error: wikiErrors.get(workspaceId) }
  }
}

function insideRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Resolve one external Wiki hit to its source file. The MCP recall gives the
 * canonical relative path; the derived path fallback keeps a stale index from
 * making an otherwise valid page unreadable.
 */
async function readWikiPage(workspaceId: string, id: string): Promise<MemorySearchHit | null> {
  if (!id.startsWith('llm-wiki:')) return null
  const rawId = id.slice('llm-wiki:'.length).trim()
  if (!rawId) return null
  const binding = wikiBinding(workspaceId)
  if (!binding) return null
  const root = resolve(binding.vaultRoot)
  let relativePath = ''
  try {
    const client = await getWikiClient(workspaceId, binding)
    const text = await client.callTool('wiki_recall', {
      query: rawId,
      max_results: WIKI_MAX_RESULTS
    })
    const rows = extractJsonArray(text) as WikiRecallRow[]
    const match =
      rows.find((row) => row.id === rawId) ??
      rows.find(
        (row) => typeof row.path === 'string' && typeof row.id === 'string' && rawId.endsWith(row.id)
      )
    if (match && typeof match.path === 'string' && match.path.trim()) relativePath = match.path.trim()
  } catch {
    // Fall through to path derivation; callTool failures are surfaced in search.
  }
  const candidates = [
    ...(relativePath ? [resolve(root, relativePath)] : []),
    resolve(root, `${rawId}.md`),
    resolve(root, rawId)
  ]
  for (const candidate of candidates) {
    if (!insideRoot(root, candidate)) continue
    let body: string
    try {
      body = readFileSync(candidate, 'utf8')
    } catch {
      continue
    }
    if (!body.trim()) continue
    const locator = relative(root, candidate).replace(/\\\\/g, '/')
    const title = basename(candidate, '.md')
    return {
      id,
      kind: 'wiki',
      title,
      excerpt: body.slice(0, 400),
      body: body.length > 512 * 1024 ? body.slice(0, 512 * 1024) : body,
      citation: { label: `LLM Wiki · ${title}`, locator },
      score: 1,
      engine: 'wiki'
    }
  }
  return null
}

let database: DatabaseSync | null = null

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable ${name}`)
  return value
}

function openDatabase(): DatabaseSync {
  if (database) return database
  mkdirSync(memoryDir, { recursive: true })
  const db = new DatabaseSync(databasePath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_notes (
      id TEXT PRIMARY KEY,
      layer TEXT NOT NULL DEFAULT 'L1',
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
    USING fts5(note_id UNINDEXED, body, tokenize = '${TOKENIZER}');
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      root TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_settings (
      workspace_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'off',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      origin TEXT NOT NULL,
      kind TEXT NOT NULL,
      revision INTEGER NOT NULL,
      hash TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS sources_workspace ON sources(workspace_id, status);
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      locator TEXT NOT NULL,
      quote TEXT NOT NULL,
      hash TEXT NOT NULL,
      trust TEXT NOT NULL DEFAULT 'user-provided',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS evidence_workspace ON evidence(workspace_id, status);
    CREATE INDEX IF NOT EXISTS evidence_source ON evidence(source_id);
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      derived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS notes_workspace ON notes(workspace_id, status);
    CREATE TABLE IF NOT EXISTS note_evidence (
      note_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      evidence_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL,
      workspace_id TEXT NOT NULL,
      PRIMARY KEY(note_id, revision, evidence_id, source_id)
    );
    CREATE INDEX IF NOT EXISTS note_evidence_note ON note_evidence(note_id, revision);
    CREATE TABLE IF NOT EXISTS note_versions (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS note_versions_note ON note_versions(note_id, revision);
    CREATE TABLE IF NOT EXISTS wiki_pages (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      source_ids TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS wiki_workspace ON wiki_pages(workspace_id, status);
    CREATE TABLE IF NOT EXISTS wiki_versions (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      evidence_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS proposals_workspace ON proposals(workspace_id, status);
    CREATE TABLE IF NOT EXISTS workspace_wiki (
      workspace_id TEXT PRIMARY KEY,
      vault_root TEXT NOT NULL,
      mcp_path TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dream_jobs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      ops_json TEXT NOT NULL,
      l3_preview TEXT NOT NULL,
      delete_ratio REAL NOT NULL,
      publish_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dream_jobs_workspace ON dream_jobs(workspace_id, created_at);
    CREATE TABLE IF NOT EXISTS knowledge_versions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      publish_id TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      l3_content TEXT NOT NULL,
      ops_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS knowledge_versions_workspace ON knowledge_versions(workspace_id, created_at);
    CREATE TABLE IF NOT EXISTS workspace_knowledge (
      workspace_id TEXT PRIMARY KEY,
      active_version_id TEXT,
      previous_version_id TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dream_schedule (
      workspace_id TEXT PRIMARY KEY,
      auto_dream INTEGER NOT NULL DEFAULT 0,
      interval_minutes INTEGER NOT NULL DEFAULT 240,
      last_run_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS dream_usage (
      workspace_id TEXT NOT NULL,
      day TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(workspace_id, day)
    );
    CREATE TABLE IF NOT EXISTS workspace_revision (
      workspace_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS search_index
    USING fts5(
      workspace_id UNINDEXED,
      doc_id UNINDEXED,
      kind UNINDEXED,
      title,
      body,
      tokenize = '${TOKENIZER}'
    );
  `)
  ensureColumn(db, 'knowledge_versions', 'projection_json', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn(db, 'knowledge_versions', 'workspace_revision', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'proposals', 'kind', "TEXT NOT NULL DEFAULT 'note'")
  ensureColumn(db, 'proposals', 'target_note_id', 'TEXT')
  ensureColumn(db, 'proposals', 'target_revision', 'INTEGER')
  ensureColumn(db, 'notes', 'derived', 'INTEGER NOT NULL DEFAULT 0')
  migrateDerivedNotes(db)
  database = db
  return db
}

/**
 * Best-effort migration of old approved corrections. A note is only marked as
 * derived when its current revision is exactly the revision that the approved
 * correction produced; otherwise the later manual edit wins and stays visible.
 */
function migrateDerivedNotes(connection: DatabaseSync): void {
  const rows = connection
    .prepare(
      `SELECT p.id, p.target_note_id, p.evidence_ids, p.created_at, n.revision AS note_revision
         FROM proposals p JOIN notes n ON n.id = p.target_note_id
        WHERE p.kind = 'fix' AND p.status = 'approved' AND p.target_note_id IS NOT NULL
          AND n.status = 'active'`
    )
    .all() as Array<{
    id: string
    target_note_id: string
    evidence_ids: string
    created_at: number
    note_revision: number
  }>
  for (const row of rows) {
    const baseline = connection
      .prepare(
        `SELECT revision FROM note_versions
          WHERE note_id = ? AND created_at <= ? ORDER BY revision DESC LIMIT 1`
      )
      .get(row.target_note_id, row.created_at) as { revision?: number } | undefined
    if (!baseline?.revision || row.note_revision !== baseline.revision + 1) continue
    connection
      .prepare('UPDATE notes SET derived = 1 WHERE id = ? AND revision = ?')
      .run(row.target_note_id, row.note_revision)
    const evidenceIds = parseStringArray(row.evidence_ids)
    for (const evidenceId of evidenceIds) {
      connection
        .prepare(
          `INSERT OR IGNORE INTO note_evidence(note_id, revision, evidence_id, source_id, source_revision, workspace_id)
           SELECT ?, ?, e.id, e.source_id, e.revision, e.workspace_id
             FROM evidence e WHERE e.id = ?`
        )
        .run(row.target_note_id, row.note_revision, evidenceId)
    }
  }
  connection.exec(`
    UPDATE proposals SET target_revision = (
      SELECT nv.revision FROM note_versions nv
       WHERE nv.note_id = proposals.target_note_id AND nv.created_at <= proposals.created_at
       ORDER BY nv.revision DESC LIMIT 1
    )
    WHERE kind = 'fix' AND target_note_id IS NOT NULL AND target_revision IS NULL;
  `)
}

function ensureColumn(connection: DatabaseSync, table: string, column: string, declaration: string): void {
  const rows = connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>
  if (rows.some((row) => row.name === column)) return
  connection.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
}

function db(): DatabaseSync {
  return openDatabase()
}

function tx<T>(fn: () => T): T {
  const connection = db()
  connection.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    connection.exec('COMMIT')
    return result
  } catch (error) {
    connection.exec('ROLLBACK')
    throw error
  }
}

function readSqliteVersion(connection: DatabaseSync): string {
  const row = connection.prepare('SELECT sqlite_version() AS version').get() as
    | { version?: string }
    | undefined
  return row?.version ?? 'unknown'
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function normalizeRoot(input: string): string {
  const absolute = resolve(input)
  if (existsSync(absolute)) {
    try {
      return realpathSync.native(absolute).replace(/[\\/]+$/, '')
    } catch {
      return absolute.replace(/[\\/]+$/, '')
    }
  }
  return absolute.replace(/[\\/]+$/, '')
}

function workspaceIdFor(root: string): string {
  return createHash('sha256').update(normalizeRoot(root).toLowerCase()).digest('hex').slice(0, 24)
}

function ensureWorkspace(root: string): { id: string; root: string } {
  const normalized = normalizeRoot(root)
  const id = workspaceIdFor(normalized)
  const now = Date.now()
  db()
    .prepare('INSERT OR IGNORE INTO workspaces(id, root, created_at) VALUES (?, ?, ?)')
    .run(id, normalized, now)
  db()
    .prepare('INSERT OR IGNORE INTO workspace_settings(workspace_id, mode, updated_at) VALUES (?, ?, ?)')
    .run(id, 'off', now)
  db()
    .prepare('INSERT OR IGNORE INTO workspace_revision(workspace_id, revision, updated_at) VALUES (?, 0, ?)')
    .run(id, now)
  return { id, root: normalized }
}

function currentRevision(workspaceId: string): number {
  const row = db()
    .prepare('SELECT revision FROM workspace_revision WHERE workspace_id = ?')
    .get(workspaceId) as { revision?: number } | undefined
  return row?.revision ?? 0
}

function bumpRevision(workspaceId: string): number {
  const now = Date.now()
  db()
    .prepare(
      `INSERT INTO workspace_revision(workspace_id, revision, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`
    )
    .run(workspaceId, now)
  return currentRevision(workspaceId)
}

function requireWorkspace(params: Record<string, unknown>): { id: string; root: string } {
  const root = stringParam(params, 'workspace', 2_000)
  return ensureWorkspace(root)
}

function stringParam(params: Record<string, unknown>, name: string, max = 2_000): string {
  const value = params[name]
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new RpcError('VALIDATION', `字段 ${name} 缺失或长度非法`)
  }
  return value
}

function optionalString(params: Record<string, unknown>, name: string, max = 2_000): string | undefined {
  const value = params[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length > max) {
    throw new RpcError('VALIDATION', `字段 ${name} 类型非法`)
  }
  return value
}

function objectParam(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new RpcError('VALIDATION', '参数必须是对象')
  }
  return params as Record<string, unknown>
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

function ftsQuery(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}_-]+/gu) ?? []
  if (tokens.length === 0) return null
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' AND ')
}

function excerpt(text: string, query: string, size = 180): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= size) return normalized
  const lowerText = normalized.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const at = lowerText.indexOf(lowerQuery)
  if (at < 0) return `${normalized.slice(0, size)}…`
  const start = Math.max(0, at - Math.floor(size / 3))
  return `${start > 0 ? '…' : ''}${normalized.slice(start, start + size)}…`
}

function chunkText(text: string): Array<{ quote: string; start: number; end: number }> {
  const normalized = text.replace(/\r\n?/g, '\n')
  const chunks: Array<{ quote: string; start: number; end: number }> = []
  let cursor = 0
  const paragraphs = normalized.split(/\n{2,}/)
  let pending = ''
  let pendingStart = 0
  const flush = (): void => {
    const quote = pending.trim()
    if (quote) {
      chunks.push({ quote, start: pendingStart, end: pendingStart + pending.length })
    }
    pending = ''
  }
  for (const paragraph of paragraphs) {
    const start = cursor
    cursor += paragraph.length + 2
    if (paragraph.length > 1_400) {
      flush()
      for (let offset = 0; offset < paragraph.length; offset += 1_400) {
        const slice = paragraph.slice(offset, offset + 1_400).trim()
        if (slice) chunks.push({ quote: slice, start: start + offset, end: start + offset + slice.length })
      }
      continue
    }
    if ((pending + '\n\n' + paragraph).length > 1_400) flush()
    if (!pending) pendingStart = start
    pending += (pending ? '\n\n' : '') + paragraph
  }
  flush()
  if (chunks.length === 0 && normalized.trim()) {
    chunks.push({ quote: normalized.trim().slice(0, 1_400), start: 0, end: normalized.length })
  }
  return chunks
}

function indexDoc(workspaceId: string, docId: string, kind: MemoryHitKind, title: string, body: string): void {
  db().prepare('DELETE FROM search_index WHERE doc_id = ?').run(docId)
  db()
    .prepare('INSERT INTO search_index(workspace_id, doc_id, kind, title, body) VALUES (?, ?, ?, ?, ?)')
    .run(workspaceId, docId, kind, title, body)
}

function unindexDoc(docId: string): void {
  db().prepare('DELETE FROM search_index WHERE doc_id = ?').run(docId)
}

type SourceRow = {
  id: string
  workspace_id: string
  title: string
  origin: string
  kind: string
  revision: number
  hash: string
  body: string
  status: string
  created_at: number
  revoked_at: number | null
}

type EvidenceRow = {
  id: string
  workspace_id: string
  source_id: string
  revision: number
  locator: string
  quote: string
  hash: string
  trust: string
  status: string
  created_at: number
  revoked_at: number | null
}

type NoteRow = {
  id: string
  workspace_id: string
  type: string
  title: string
  body: string
  revision: number
  status: string
  derived: number
  created_at: number
  updated_at: number
  revoked_at: number | null
}

type WikiRow = {
  id: string
  workspace_id: string
  slug: string
  title: string
  body: string
  revision: number
  status: string
  source_ids: string
  created_at: number
  updated_at: number
  revoked_at: number | null
}

function sourceDto(row: SourceRow): MemorySource {
  const count = db()
    .prepare('SELECT COUNT(*) AS count FROM evidence WHERE source_id = ?')
    .get(row.id) as { count?: number } | undefined
  return {
    id: row.id,
    title: row.title,
    origin: row.origin,
    kind: row.kind,
    revision: row.revision,
    hash: row.hash,
    status: row.status === 'revoked' ? 'revoked' : 'active',
    evidenceCount: count?.count ?? 0,
    createdAt: row.created_at
  }
}

function noteDto(row: NoteRow): MemoryNote {
  return {
    id: row.id,
    type: row.type as MemoryNoteType,
    title: row.title,
    body: row.body,
    revision: row.revision,
    status: row.status === 'revoked' ? 'revoked' : 'active',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function sourceRevoked(sourceId: string): boolean {
  const row = db().prepare('SELECT status FROM sources WHERE id = ?').get(sourceId) as
    | { status?: string }
    | undefined
  return !row || row.status !== 'active'
}

type NoteEvidenceRow = {
  note_id: string
  revision: number
  evidence_id: string
  source_id: string
  source_revision: number
  workspace_id: string
}

/** A derived note is live only while every recorded evidence/source revision is live. */
function noteIsLive(workspaceId: string, noteId: string, revision?: number): boolean {
  const note = db()
    .prepare("SELECT * FROM notes WHERE id = ? AND workspace_id = ? AND status = 'active'")
    .get(noteId, workspaceId) as NoteRow | undefined
  if (!note) return false
  if (revision !== undefined && note.revision !== revision) return false
  if (note.derived !== 1) return true
  const deps = db()
    .prepare('SELECT * FROM note_evidence WHERE workspace_id = ? AND note_id = ? AND revision = ?')
    .all(workspaceId, noteId, note.revision) as NoteEvidenceRow[]
  if (deps.length === 0) return false
  for (const dep of deps) {
    const live = db()
      .prepare(
        `SELECT 1 AS ok FROM evidence e JOIN sources s ON s.id = e.source_id
          WHERE e.id = ? AND e.source_id = ? AND e.workspace_id = ?
            AND e.status = 'active' AND s.status = 'active' AND s.revision = ?
          LIMIT 1`
      )
      .get(dep.evidence_id, dep.source_id, workspaceId, dep.source_revision) as { ok?: number } | undefined
    if (live?.ok !== 1) return false
  }
  return true
}

function recordEvidenceDependencies(
  workspaceId: string,
  noteId: string,
  revision: number,
  evidenceIds: string[]
): boolean {
  let recorded = 0
  for (const evidenceId of evidenceIds) {
    const evidence = db()
      .prepare(
        `SELECT e.id, e.source_id, e.revision FROM evidence e JOIN sources s ON s.id = e.source_id
          WHERE e.id = ? AND e.workspace_id = ? AND e.status = 'active' AND s.status = 'active'`
      )
      .get(evidenceId, workspaceId) as { id: string; source_id: string; revision: number } | undefined
    if (!evidence) continue
    db()
      .prepare(
        `INSERT OR REPLACE INTO note_evidence(note_id, revision, evidence_id, source_id, source_revision, workspace_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(noteId, revision, evidence.id, evidence.source_id, evidence.revision, workspaceId)
    recorded += 1
  }
  return recorded > 0
}

function recordSourceDependencies(
  workspaceId: string,
  noteId: string,
  revision: number,
  sourceIds: string[]
): boolean {
  let recorded = 0
  for (const sourceId of sourceIds) {
    const evidence = db()
      .prepare(
        `SELECT e.id, e.source_id, e.revision FROM evidence e JOIN sources s ON s.id = e.source_id
          WHERE e.source_id = ? AND e.workspace_id = ? AND e.status = 'active' AND s.status = 'active'
          ORDER BY e.created_at LIMIT 1`
      )
      .get(sourceId, workspaceId) as { id: string; source_id: string; revision: number } | undefined
    if (!evidence) continue
    db()
      .prepare(
        `INSERT OR REPLACE INTO note_evidence(note_id, revision, evidence_id, source_id, source_revision, workspace_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(noteId, revision, evidence.id, evidence.source_id, evidence.revision, workspaceId)
    recorded += 1
  }
  return recorded > 0
}

function clearNoteDependencies(noteId: string, revision: number): void {
  db().prepare('DELETE FROM note_evidence WHERE note_id = ? AND revision = ?').run(noteId, revision)
}

function copyNoteDependencies(noteId: string, fromRevision: number, toRevision: number): void {
  db()
    .prepare(
      `INSERT OR REPLACE INTO note_evidence(note_id, revision, evidence_id, source_id, source_revision, workspace_id)
       SELECT note_id, ?, evidence_id, source_id, source_revision, workspace_id
         FROM note_evidence WHERE note_id = ? AND revision = ?`
    )
    .run(toRevision, noteId, fromRevision)
}

function wikiDto(row: WikiRow): WikiPage {
  const sourceIds = parseStringArray(row.source_ids)
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    status: row.status === 'revoked' ? 'revoked' : row.status === 'published' ? 'published' : 'draft',
    revision: row.revision,
    body: row.body,
    sourceIds,
    stale: sourceIds.some((id) => sourceRevoked(id)),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function getMode(workspaceId: string): MemoryMode {
  const row = db()
    .prepare('SELECT mode FROM workspace_settings WHERE workspace_id = ?')
    .get(workspaceId) as { mode?: string } | undefined
  const mode = row?.mode
  return mode === 'rag' || mode === 'wiki' || mode === 'both' ? mode : 'off'
}

function loadHit(workspaceId: string, kind: MemoryHitKind, docId: string, query: string): MemorySearchHit | null {
  if (kind === 'evidence') {
    const row = db()
      .prepare(
        `SELECT e.*, s.title AS source_title, s.origin AS source_origin
         FROM evidence e JOIN sources s ON s.id = e.source_id
         WHERE e.id = ? AND e.workspace_id = ? AND e.status = 'active' AND s.status = 'active'`
      )
      .get(docId, workspaceId) as (EvidenceRow & { source_title: string; source_origin: string }) | undefined
    if (!row) return null
    return {
      id: row.id,
      kind,
      title: row.source_title,
      excerpt: excerpt(row.quote, query),
      citation: {
        label: `${row.source_title} · ${row.locator}`,
        sourceId: row.source_id,
        sourceTitle: row.source_title,
        origin: row.source_origin,
        locator: row.locator
      },
      score: 1
    }
  }
  if (kind === 'note') {
    const row = db()
      .prepare("SELECT * FROM notes WHERE id = ? AND workspace_id = ? AND status = 'active'")
      .get(docId, workspaceId) as NoteRow | undefined
    if (!row || !noteIsLive(workspaceId, row.id, row.revision)) return null
    return {
      id: row.id,
      kind,
      title: row.title,
      excerpt: excerpt(row.body, query),
      citation: { label: `L1 笔记 · ${row.title}`, noteId: row.id },
      score: 1
    }
  }
  const row = db()
    .prepare("SELECT * FROM wiki_pages WHERE id = ? AND workspace_id = ? AND status = 'published'")
    .get(docId, workspaceId) as WikiRow | undefined
  if (!row) return null
  const page = wikiDto(row)
  if (page.stale) return null
  return {
    id: row.id,
    kind: 'wiki',
    title: row.title,
    excerpt: excerpt(row.body, query),
    citation: { label: `Wiki · ${row.title}`, wikiId: row.id },
    score: 1
  }
}

function qmdCorpusDir(workspaceId: string): string {
  return join(memoryDir, 'qmd', workspaceId, 'corpus')
}

function qmdIndexPath(workspaceId: string): string {
  return join(memoryDir, 'qmd', workspaceId, 'index.sqlite')
}

/**
 * Project active evidence rows into one Markdown file per chunk. QMD owns the
 * lexical index; SQLite remains the source of truth for status and revisions.
 */
function syncQmdCorpus(workspaceId: string): void {
  const corpusDir = qmdCorpusDir(workspaceId)
  mkdirSync(corpusDir, { recursive: true })
  const rows = db()
    .prepare(
      `SELECT e.id AS id, e.quote AS quote, s.title AS title
         FROM evidence e JOIN sources s ON s.id = e.source_id
        WHERE e.workspace_id = ? AND e.status = 'active' AND s.status = 'active'`
    )
    .all(workspaceId) as Array<{ id: string; quote: string; title: string }>
  const wanted = new Set<string>()
  for (const row of rows) {
    const name = `${row.id}.md`
    wanted.add(name)
    const body = `# ${row.title}\n\n${row.quote}\n`
    const file = join(corpusDir, name)
    try {
      if (!existsSync(file) || readFileSync(file, 'utf8') !== body) writeFileSync(file, body, 'utf8')
    } catch {
      // A read-only cache must never break the canonical FTS5 path.
    }
  }
  for (const name of readdirSync(corpusDir)) {
    if (!name.endsWith('.md') || wanted.has(name)) continue
    try {
      rmSync(join(corpusDir, name), { force: true })
    } catch {
      // Ignore stale cache entries; QMD result mapping re-checks active status.
    }
  }
}

async function openQmdStore(workspaceId: string): Promise<QmdStore> {
  const mod = (await import(pathToFileURL(QMD_MODULE_PATH).href)) as {
    createStore?: (options: unknown) => Promise<QmdStore>
  }
  if (typeof mod.createStore !== 'function') throw new Error('QMD 模块缺少 createStore 导出')
  syncQmdCorpus(workspaceId)
  return mod.createStore({
    dbPath: qmdIndexPath(workspaceId),
    config: {
      collections: {
        docs: {
          path: qmdCorpusDir(workspaceId),
          pattern: '**/*.md'
        }
      }
    }
  })
}

async function searchQmd(
  workspaceId: string,
  query: string,
  limit: number
): Promise<{ hits: MemorySearchHit[]; ok: boolean; error?: string }> {
  if (!QMD_MODULE_PATH) return { hits: [], ok: false }
  let pending = qmdStores.get(workspaceId)
  try {
    if (!pending) {
      pending = openQmdStore(workspaceId)
      qmdStores.set(workspaceId, pending)
    }
    const store = await pending
    syncQmdCorpus(workspaceId)
    await store.update()
    const rows = await store.searchLex(query, { limit: Math.max(limit * 2, 10) })
    const hits: MemorySearchHit[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      const path = row.displayPath ?? row.filepath ?? ''
      const id = basename(path, '.md')
      if (!id.startsWith('ev-') || seen.has(id)) continue
      const hit = loadHit(workspaceId, 'evidence', id, query)
      if (!hit) continue
      seen.add(id)
      hit.score = typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : 0
      hit.engine = 'qmd'
      hits.push(hit)
      if (hits.length >= limit) break
    }
    qmdLastError = ''
    return { hits, ok: true }
  } catch (error) {
    qmdLastError = error instanceof Error ? error.message : String(error)
    qmdStores.delete(workspaceId)
    return { hits: [], ok: false, error: qmdLastError }
  }
}

function allowedKinds(mode: MemoryMode): MemoryHitKind[] {
  if (mode === 'off') return []
  if (mode === 'rag') return ['evidence', 'note', 'wiki']
  if (mode === 'wiki') return ['wiki']
  return ['evidence', 'note', 'wiki']
}

async function searchMemory(
  workspaceId: string,
  mode: MemoryMode,
  query: string,
  limit: number
): Promise<{
  hits: MemorySearchHit[]
  engine: MemorySearchEngine
  engineNote?: string
  wikiEngine?: MemoryWikiEngine
  wikiNote?: string
}> {
  const kinds = allowedKinds(mode)
  const wikiEngine: MemoryWikiEngine = wikiConfigured(workspaceId) ? 'mcp' : 'off'
  if (kinds.length === 0) return { hits: [], engine: 'fts5', wikiEngine }
  const kindPlaceholders = kinds.map(() => '?').join(', ')
  const seen = new Set<string>()
  const hits: MemorySearchHit[] = []

  const push = (kind: MemoryHitKind, id: string, rank: number): void => {
    if (seen.has(id) || hits.length >= limit) return
    const hit = loadHit(workspaceId, kind, id, query)
    if (!hit) return
    seen.add(id)
    hit.score = Math.max(0, -rank)
    hits.push(hit)
  }

  const match = ftsQuery(query)
  if (match && query.trim().length >= 3) {
    try {
      const rows = db()
        .prepare(
          `SELECT doc_id, kind, bm25(search_index) AS rank
           FROM search_index
           WHERE search_index MATCH ? AND workspace_id = ? AND kind IN (${kindPlaceholders})
           ORDER BY rank
           LIMIT ?`
        )
        .all(match, workspaceId, ...kinds, limit * 2) as Array<{
        doc_id: string
        kind: string
        rank: number
      }>
      for (const row of rows) {
        push(row.kind as MemoryHitKind, row.doc_id, row.rank)
      }
    } catch {
      // Fall through to LIKE for queries that the FTS parser rejects.
    }
  }

  if (hits.length === 0) {
    const pattern = `%${escapeLike(query.trim())}%`
    const rows = db()
      .prepare(
        `SELECT 'evidence' AS kind, e.id AS doc_id, s.title AS title
           FROM evidence e JOIN sources s ON s.id = e.source_id
          WHERE e.workspace_id = ? AND e.status = 'active' AND s.status = 'active'
            AND (e.quote LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\')
         UNION ALL
         SELECT 'note' AS kind, n.id AS doc_id, n.title AS title
           FROM notes n
          WHERE n.workspace_id = ? AND n.status = 'active'
            AND (n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\')
         UNION ALL
         SELECT 'wiki' AS kind, w.id AS doc_id, w.title AS title
           FROM wiki_pages w
          WHERE w.workspace_id = ? AND w.status = 'published'
            AND (w.title LIKE ? ESCAPE '\\' OR w.body LIKE ? ESCAPE '\\')
         LIMIT ?`
      )
      .all(
        workspaceId,
        pattern,
        pattern,
        workspaceId,
        pattern,
        pattern,
        workspaceId,
        pattern,
        pattern,
        limit * 2
      ) as Array<{ kind: string; doc_id: string; title: string }>
    for (const row of rows) {
      if (!kinds.includes(row.kind as MemoryHitKind)) continue
      push(row.kind as MemoryHitKind, row.doc_id, 0)
    }
  }
  for (const hit of hits) hit.engine = 'fts5'

  let engine: MemorySearchEngine = 'fts5'
  let engineNote: string | undefined
  let qmdHits: MemorySearchHit[] = []
  if (QMD_MODULE_PATH && kinds.includes('evidence')) {
    const qmd = await searchQmd(workspaceId, query, limit)
    if (qmd.ok) {
      engine = 'qmd'
      qmdHits = qmd.hits
    } else {
      engineNote = `QMD 暂不可用，已回退 FTS5：${qmd.error ?? '未知错误'}`
    }
  }

  const byId = new Map<string, MemorySearchHit>()
  for (const hit of hits) byId.set(hit.id, hit)
  for (const hit of qmdHits) byId.set(hit.id, hit)

  let wikiNote: string | undefined
  if (wikiConfigured(workspaceId) && kinds.includes('wiki')) {
    const wiki = await searchWiki(workspaceId, query, limit)
    if (wiki.ok) {
      for (const hit of wiki.hits) byId.set(hit.id, hit)
    } else if (wiki.error) {
      wikiNote = `pi-llm-wiki 暂不可用：${wiki.error}`
    }
  }

  const merged = [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  return { hits: merged, engine, engineNote, wikiEngine, wikiNote }
}

function stateFor(workspaceId: string): MemoryWorkspaceState {
  const count = (sql: string, ...args: Array<string | number>): number => {
    const row = db().prepare(sql).get(...args) as { count?: number } | undefined
    return row?.count ?? 0
  }
  return {
    workspaceId,
    mode: getMode(workspaceId),
    sourceCount: count("SELECT COUNT(*) AS count FROM sources WHERE workspace_id = ? AND status = 'active'", workspaceId),
    evidenceCount: count(
      "SELECT COUNT(*) AS count FROM evidence WHERE workspace_id = ? AND status = 'active'",
      workspaceId
    ),
    noteCount: count("SELECT COUNT(*) AS count FROM notes WHERE workspace_id = ? AND status = 'active'", workspaceId),
    wikiDraftCount: count(
      "SELECT COUNT(*) AS count FROM wiki_pages WHERE workspace_id = ? AND status = 'draft'",
      workspaceId
    ),
    wikiPublishedCount: count(
      "SELECT COUNT(*) AS count FROM wiki_pages WHERE workspace_id = ? AND status = 'published'",
      workspaceId
    ),
    pendingProposalCount: count(
      "SELECT COUNT(*) AS count FROM proposals WHERE workspace_id = ? AND status = 'pending'",
      workspaceId
    ),
    ftsReady: true,
    searchEngine: QMD_MODULE_PATH ? 'qmd' : 'fts5',
    wikiEngine: wikiConfigured(workspaceId) ? 'mcp' : 'off'
  }
}

function listSources(workspaceId: string): MemorySource[] {
  const rows = db()
    .prepare('SELECT * FROM sources WHERE workspace_id = ? ORDER BY created_at DESC')
    .all(workspaceId) as SourceRow[]
  return rows.map(sourceDto)
}

function importSource(params: Record<string, unknown>): MemorySource {
  const workspace = requireWorkspace(params)
  const title = optionalString(params, 'title', 240)?.trim() || '未命名资料'
  const origin = optionalString(params, 'origin', 2_000)?.trim() || `paste:${Date.now()}`
  const kind = optionalString(params, 'kind', 40)?.trim() || 'markdown'
  const content = stringParam(params, 'content', MAX_SOURCE_BYTES)
  if (Buffer.byteLength(content, 'utf8') > MAX_SOURCE_BYTES) {
    throw new RpcError('VALIDATION', '资料超过 2 MB 上限')
  }
  if (!content.trim()) throw new RpcError('VALIDATION', '资料内容为空')
  const hash = sha256(content)
  const chunks = chunkText(content)
  if (chunks.length === 0) throw new RpcError('VALIDATION', '资料没有可索引的文本')

  return tx(() => {
    const previous = db()
      .prepare(
        "SELECT id FROM sources WHERE workspace_id = ? AND origin = ? AND status = 'active' ORDER BY revision DESC LIMIT 1"
      )
      .get(workspace.id, origin) as { id?: string } | undefined
    if (previous?.id) revokeSourceById(workspace.id, previous.id)
    const revisionRow = db()
      .prepare('SELECT MAX(revision) AS revision FROM sources WHERE workspace_id = ? AND origin = ?')
      .get(workspace.id, origin) as { revision?: number } | undefined
    const revision = (revisionRow?.revision ?? 0) + 1
    const sourceId = `src-${randomUUID()}`
    const now = Date.now()
    db()
      .prepare(
        `INSERT INTO sources(id, workspace_id, title, origin, kind, revision, hash, body, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
      )
      .run(sourceId, workspace.id, title, origin, kind, revision, hash, content, now)
    for (const chunk of chunks) {
      const evidenceId = `ev-${randomUUID()}`
      db()
        .prepare(
          `INSERT INTO evidence(id, workspace_id, source_id, revision, locator, quote, hash, trust, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'user-provided', 'active', ?)`
        )
        .run(
          evidenceId,
          workspace.id,
          sourceId,
          revision,
          `chars:${chunk.start}-${chunk.end}`,
          chunk.quote,
          sha256(chunk.quote),
          now
        )
      indexDoc(workspace.id, evidenceId, 'evidence', title, chunk.quote)
    }
    bumpRevision(workspace.id)
    const row = db().prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as SourceRow
    return sourceDto(row)
  })
}

function revokeSourceById(workspaceId: string, sourceId: string): void {
  const now = Date.now()
  const evidenceRows = db()
    .prepare("SELECT id FROM evidence WHERE workspace_id = ? AND source_id = ? AND status = 'active'")
    .all(workspaceId, sourceId) as Array<{ id: string }>
  db()
    .prepare("UPDATE sources SET status = 'revoked', revoked_at = ? WHERE id = ? AND workspace_id = ?")
    .run(now, sourceId, workspaceId)
  db()
    .prepare("UPDATE evidence SET status = 'revoked', revoked_at = ? WHERE source_id = ? AND workspace_id = ?")
    .run(now, sourceId, workspaceId)
  for (const row of evidenceRows) unindexDoc(row.id)
  bumpRevision(workspaceId)
  refreshActiveProjection(workspaceId)
}

function revokeSource(params: Record<string, unknown>): void {
  const workspace = requireWorkspace(params)
  const id = stringParam(params, 'id', 200)
  const row = db()
    .prepare('SELECT id FROM sources WHERE id = ? AND workspace_id = ?')
    .get(id, workspace.id) as { id?: string } | undefined
  if (!row?.id) throw new RpcError('VALIDATION', '资料来源不存在')
  tx(() => revokeSourceById(workspace.id, id))
}

function createNoteRow(
  workspaceId: string,
  type: MemoryNoteType,
  title: string,
  body: string,
  derived = false,
  sourceIds: string[] = []
): MemoryNote {
  const id = `note-${randomUUID()}`
  const now = Date.now()
  db()
    .prepare(
      `INSERT INTO notes(id, workspace_id, type, title, body, revision, status, derived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 'active', ?, ?, ?)`
    )
    .run(id, workspaceId, type, title, body, derived ? 1 : 0, now, now)
  db()
    .prepare('INSERT INTO note_versions(id, note_id, revision, title, body, created_at) VALUES (?, ?, 1, ?, ?, ?)')
    .run(`nv-${randomUUID()}`, id, title, body, now)
  // A derived note with no recorded evidence dependency is intentionally not live.
  if (derived) recordSourceDependencies(workspaceId, id, 1, sourceIds)
  indexDoc(workspaceId, id, 'note', title, body)
  bumpRevision(workspaceId)
  return noteDto(db().prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow)
}

function validateNoteInput(params: Record<string, unknown>): { type: MemoryNoteType; title: string; body: string } {
  const rawType = optionalString(params, 'type', 40) ?? 'fact'
  const type: MemoryNoteType =
    rawType === 'preference' || rawType === 'decision' || rawType === 'rule' || rawType === 'lesson'
      ? rawType
      : 'fact'
  const title = stringParam(params, 'title', 240).trim()
  const body = stringParam(params, 'body', 40_000).trim()
  if (!title) throw new RpcError('VALIDATION', '笔记标题不能为空')
  if (!body) throw new RpcError('VALIDATION', '笔记正文不能为空')
  return { type, title, body }
}

function createNote(params: Record<string, unknown>): MemoryNote {
  const workspace = requireWorkspace(params)
  const input = validateNoteInput(params)
  return tx(() => createNoteRow(workspace.id, input.type, input.title, input.body))
}

function updateNote(params: Record<string, unknown>): MemoryNote {
  const workspace = requireWorkspace(params)
  const id = stringParam(params, 'id', 200)
  const existing = db()
    .prepare("SELECT * FROM notes WHERE id = ? AND workspace_id = ? AND status = 'active'")
    .get(id, workspace.id) as NoteRow | undefined
  if (!existing) throw new RpcError('VALIDATION', '笔记不存在或已撤销')
  const type = (optionalString(params, 'type', 40) ?? existing.type) as MemoryNoteType
  const title = (optionalString(params, 'title', 240) ?? existing.title).trim()
  const body = (optionalString(params, 'body', 40_000) ?? existing.body).trim()
  if (!title || !body) throw new RpcError('VALIDATION', '笔记标题与正文不能为空')
  const now = Date.now()
  const revision = existing.revision + 1
  return tx(() => {
    db()
      .prepare(
        'UPDATE notes SET type = ?, title = ?, body = ?, revision = ?, derived = 0, updated_at = ? WHERE id = ?'
      )
      .run(type, title, body, revision, now, id)
    db()
      .prepare('INSERT INTO note_versions(id, note_id, revision, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`nv-${randomUUID()}`, id, revision, title, body, now)
    clearNoteDependencies(id, revision)
    indexDoc(workspace.id, id, 'note', title, body)
    bumpRevision(workspace.id)
    return noteDto(db().prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow)
  })
}

function revokeNote(params: Record<string, unknown>): void {
  const workspace = requireWorkspace(params)
  const id = stringParam(params, 'id', 200)
  const now = Date.now()
  tx(() => {
    db()
      .prepare("UPDATE notes SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
      .run(now, now, id, workspace.id)
    unindexDoc(id)
    bumpRevision(workspace.id)
    refreshActiveProjection(workspace.id)
  })
}

function listNotes(workspaceId: string): MemoryNote[] {
  const rows = db()
    .prepare('SELECT * FROM notes WHERE workspace_id = ? ORDER BY updated_at DESC')
    .all(workspaceId) as NoteRow[]
  return rows.map(noteDto)
}

/* Dreaming (P2): deterministic staging pipeline, structured ops, atomic publish. */

const L3_MAX_LINES = 200
const L3_MAX_BYTES = 25_000
const DREAM_PER_RUN_TOKENS = 50_000
const DREAM_DAILY_TOKENS = 100_000
const DREAM_DEFAULT_INTERVAL_MINUTES = 240
const DREAM_MIN_INTERVAL_MINUTES = 5
const DREAM_MAX_INTERVAL_MINUTES = 1_440
const AUTO_DREAM_TICK_MS = Number(process.env.OPENFUTURE_AUTO_DREAM_TICK_MS) || 60_000
const L3_TOKEN_BUDGET = 1_500
const MAX_DELETE_RATIO = 0.25

interface DreamJobRow {
  id: string
  workspace_id: string
  status: DreamJob['status']
  phase: DreamPhase
  ops_json: string
  l3_preview: string
  delete_ratio: number
  publish_id: string | null
  error: string | null
  created_at: number
  updated_at: number
}

interface KnowledgeVersionRow {
  id: string
  workspace_id: string
  publish_id: string
  label: string
  l3_content: string
  ops_json: string
  summary: string
  status: DreamVersion['status']
  created_at: number
  projection_json?: string
  workspace_revision?: number
}

interface L3Entry {
  id: string
  kind: 'note' | 'source'
  refId: string
  revision: number
  title: string
  body: string
}

interface L3Context {
  workspaceId: string
  versionId: string | null
  revision: number
  entries: L3Entry[]
  text: string
  needsReview: boolean
  verifiedAt: number | null
}

function memoryInjectedPath(): string {
  return join(memoryDir, 'injected', 'MEMORY.md')
}

function writeL3File(content: string, mirrorId: string | null): void {
  const injected = memoryInjectedPath()
  mkdirSync(dirname(injected), { recursive: true })
  if (mirrorId && existsSync(injected)) {
    const mirrors = join(memoryDir, 'mirrors')
    mkdirSync(mirrors, { recursive: true })
    writeFileSync(join(mirrors, `${mirrorId}.md`), readFileSync(injected))
  }
  const tmp = `${injected}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, injected)
}

function compact(value: string, max = 220): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function collectL3Entries(workspaceId: string, excluded: Set<string>): L3Entry[] {
  const entries: L3Entry[] = []
  const notes = db()
    .prepare("SELECT * FROM notes WHERE workspace_id = ? AND status = 'active' ORDER BY updated_at DESC")
    .all(workspaceId) as NoteRow[]
  for (const note of notes) {
    if (excluded.has(note.id) || !noteIsLive(workspaceId, note.id, note.revision)) continue
    entries.push({
      id: `note:${note.id}`,
      kind: 'note',
      refId: note.id,
      revision: note.revision,
      title: note.title,
      body: compact(note.body, 240)
    })
  }
  const sources = db()
    .prepare("SELECT * FROM sources WHERE workspace_id = ? AND status = 'active' ORDER BY created_at DESC")
    .all(workspaceId) as SourceRow[]
  for (const source of sources) {
    if (excluded.has(source.id)) continue
    entries.push({
      id: `source:${source.id}`,
      kind: 'source',
      refId: source.id,
      revision: source.revision,
      title: source.title,
      body: `来源：${compact(source.origin, 160)}`
    })
  }
  return entries
}

function renderL3(entries: L3Entry[]): string {
  if (entries.length === 0) return ''
  const notes = entries.filter((entry) => entry.kind === 'note')
  const sources = entries.filter((entry) => entry.kind === 'source')
  const lines: string[] = ['# OpenFuture MEMORY', '', '> 由 Dreaming Promote 生成；只读注入。', '', '## 稳定记忆', '']
  let bytes = Buffer.byteLength(lines.join('\n'), 'utf8')
  for (const entry of notes) {
    const line = `- **${entry.title}**：${entry.body}`
    const nextBytes = bytes + Buffer.byteLength(line, 'utf8') + 1
    if (lines.length >= L3_MAX_LINES - 6 || nextBytes > L3_MAX_BYTES || Math.ceil(nextBytes / 4) > L3_TOKEN_BUDGET) break
    lines.push(line)
    bytes = nextBytes
  }
  lines.push('', '## 资料来源', '')
  for (const entry of sources) {
    const line = `- ${entry.title} — ${entry.body}`
    const nextBytes = bytes + Buffer.byteLength(line, 'utf8') + 1
    if (lines.length >= L3_MAX_LINES || nextBytes > L3_MAX_BYTES || Math.ceil(nextBytes / 4) > L3_TOKEN_BUDGET) break
    lines.push(line)
    bytes = nextBytes
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function buildL3Projection(
  workspaceId: string,
  excluded: Set<string>
): { entries: L3Entry[]; text: string } {
  const entries = collectL3Entries(workspaceId, excluded)
  return { entries, text: renderL3(entries) }
}

function l3EntryLive(workspaceId: string, entry: L3Entry): boolean {
  if (entry.kind === 'note') {
    return noteIsLive(workspaceId, entry.refId, entry.revision)
  }
  const source = db()
    .prepare("SELECT revision FROM sources WHERE id = ? AND workspace_id = ? AND status = 'active'")
    .get(entry.refId, workspaceId) as { revision?: number } | undefined
  if (source?.revision !== entry.revision) return false
  const evidence = db()
    .prepare("SELECT 1 AS ok FROM evidence WHERE source_id = ? AND workspace_id = ? AND status = 'active' LIMIT 1")
    .get(entry.refId, workspaceId) as { ok?: number } | undefined
  return evidence?.ok === 1
}

function parseProjection(row: KnowledgeVersionRow): L3Entry[] | null {
  if (!row.projection_json) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(row.projection_json)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const entries: L3Entry[] = []
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Partial<L3Entry>
    if (typeof item.id !== 'string' || typeof item.refId !== 'string') continue
    if (item.kind !== 'note' && item.kind !== 'source') continue
    if (typeof item.revision !== 'number' || typeof item.title !== 'string' || typeof item.body !== 'string') continue
    entries.push({
      id: item.id,
      kind: item.kind,
      refId: item.refId,
      revision: item.revision,
      title: item.title,
      body: item.body
    })
  }
  return entries
}

function l3ContextFor(workspaceId: string, mode: MemoryMode): L3Context {
  const revision = currentRevision(workspaceId)
  if (mode === 'off') {
    return { workspaceId, versionId: null, revision, entries: [], text: '', needsReview: false, verifiedAt: null }
  }
  const knowledge = activeKnowledge(workspaceId)
  if (!knowledge.active) {
    return { workspaceId, versionId: null, revision, entries: [], text: '', needsReview: false, verifiedAt: null }
  }
  const row = db()
    .prepare('SELECT * FROM knowledge_versions WHERE id = ?')
    .get(knowledge.active) as unknown as KnowledgeVersionRow | undefined
  if (!row) {
    return { workspaceId, versionId: null, revision, entries: [], text: '', needsReview: true, verifiedAt: null }
  }
  const projection = parseProjection(row)
  if (!projection) {
    return {
      workspaceId,
      versionId: row.id,
      revision,
      entries: [],
      text: '',
      needsReview: Boolean(row.l3_content?.trim()),
      verifiedAt: row.created_at ?? null
    }
  }
  const entries = projection.filter((entry) => l3EntryLive(workspaceId, entry))
  const blocked = projection.length - entries.length
  return {
    workspaceId,
    versionId: row.id,
    revision,
    entries,
    text: renderL3(entries),
    needsReview: blocked > 0,
    verifiedAt: row.created_at ?? null
  }
}

/**
 * Rebuild the active knowledge projection in place after an approved correction,
 * so the next session sees the corrected body instead of a stale snapshot.
 */
function refreshActiveProjection(workspaceId: string): void {
  const active = activeKnowledge(workspaceId).active
  if (!active) return
  const projection = buildL3Projection(workspaceId, new Set())
  const revision = currentRevision(workspaceId)
  db()
    .prepare(
      `UPDATE knowledge_versions
       SET l3_content = ?, projection_json = ?, workspace_revision = ?, summary = ?
       WHERE id = ? AND workspace_id = ?`
    )
    .run(
      projection.text,
      JSON.stringify(projection.entries),
      revision,
      `纠正后刷新 · ${projection.entries.length} 条稳定记忆 · ${Buffer.byteLength(projection.text, 'utf8')} 字节`,
      active,
      workspaceId
    )
  writeL3File(projection.text, active)
}

function computeQuality(workspaceId: string, deleteRatio = 0, contentOverride?: string): DreamQuality {
  const notes = (
    db()
      .prepare("SELECT * FROM notes WHERE workspace_id = ? AND status = 'active'")
      .all(workspaceId) as NoteRow[]
  ).filter((note) => noteIsLive(workspaceId, note.id, note.revision))
  const sources = db()
    .prepare("SELECT * FROM sources WHERE workspace_id = ? AND status = 'active'")
    .all(workspaceId) as SourceRow[]
  const groups = new Map<string, number>()
  for (const note of notes) {
    const key = note.title.replace(/\s+/g, '').toLowerCase()
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  let duplicate = 0
  for (const size of groups.values()) if (size > 1) duplicate += size - 1
  const duplicateRate = notes.length === 0 ? 0 : duplicate / notes.length
  const stale = notes.filter((note) => Date.now() - note.updated_at > 30 * 24 * 60 * 60 * 1000).length
  const staleRate = notes.length === 0 ? 0 : stale / notes.length
  let covered = 0
  for (const source of sources) {
    const key = source.title.replace(/\s+/g, '').toLowerCase()
    const hasNote = notes.some((note) => note.title.replace(/\s+/g, '').toLowerCase() === key)
    const evidence = db()
      .prepare("SELECT 1 AS ok FROM evidence WHERE workspace_id = ? AND source_id = ? AND status = 'active' LIMIT 1")
      .get(workspaceId, source.id) as { ok?: number } | undefined
    if (hasNote || evidence?.ok) covered += 1
  }
  const sourceCoverage = sources.length === 0 ? 1 : covered / sources.length
  const active = activeKnowledge(workspaceId).active
  const activeRow = active
    ? (db().prepare('SELECT l3_content FROM knowledge_versions WHERE id = ?').get(active) as { l3_content?: string } | undefined)
    : undefined
  const content = contentOverride ?? activeRow?.l3_content ?? ''
  const l3Lines = content ? content.replace(/\n$/, '').split('\n').length : 0
  const l3Bytes = Buffer.byteLength(content, 'utf8')
  const l3Tokens = Math.ceil(l3Bytes / 4)
  const checks: DreamQualityCheck[] = [
    {
      name: 'duplicate-rate',
      ok: duplicateRate < 0.05,
      detail: `重复笔记 ${duplicate} / ${notes.length}（目标 <5%）`
    },
    {
      name: 'stale-rate',
      ok: staleRate <= 0.5,
      detail: `超过 30 天未更新 ${stale} / ${notes.length}`
    },
    {
      name: 'source-coverage',
      ok: sourceCoverage >= 0.8,
      detail: `可追溯来源 ${covered} / ${sources.length}（目标 ≥80%）`
    },
    {
      name: 'l3-budget',
      ok: l3Lines <= L3_MAX_LINES && l3Bytes <= L3_MAX_BYTES && l3Tokens <= L3_TOKEN_BUDGET,
      detail: `L3 ${l3Lines} 行 / ${l3Bytes} 字节 / 约 ${l3Tokens} token`
    },
    {
      name: 'delete-ratio',
      ok: deleteRatio <= MAX_DELETE_RATIO,
      detail: `删除比例 ${(deleteRatio * 100).toFixed(0)}%（上限 25%）`
    }
  ]
  return {
    duplicateRate,
    staleRate,
    sourceCoverage,
    l3Lines,
    l3Bytes,
    l3Tokens,
    deleteRatio,
    verified: checks.every((check) => check.ok),
    checks
  }
}

function usageToday(workspaceId: string): number {
  const day = new Date().toISOString().slice(0, 10)
  const row = db()
    .prepare('SELECT tokens FROM dream_usage WHERE workspace_id = ? AND day = ?')
    .get(workspaceId, day) as { tokens?: number } | undefined
  return row?.tokens ?? 0
}

function addUsage(workspaceId: string, tokens: number): void {
  const day = new Date().toISOString().slice(0, 10)
  db()
    .prepare(
      `INSERT INTO dream_usage(workspace_id, day, tokens) VALUES (?, ?, ?)
       ON CONFLICT(workspace_id, day) DO UPDATE SET tokens = tokens + excluded.tokens`
    )
    .run(workspaceId, day, tokens)
}

function dreamQuality(params: Record<string, unknown>): DreamQuality {
  const workspace = requireWorkspace(params)
  return computeQuality(workspace.id)
}

function dreamScheduleState(params: Record<string, unknown>): DreamScheduleState {
  const workspace = requireWorkspace(params)
  const row = db()
    .prepare('SELECT auto_dream, interval_minutes, last_run_at FROM dream_schedule WHERE workspace_id = ?')
    .get(workspace.id) as { auto_dream?: number; interval_minutes?: number; last_run_at?: number | null } | undefined
  const interval = Math.min(
    Math.max(row?.interval_minutes ?? DREAM_DEFAULT_INTERVAL_MINUTES, DREAM_MIN_INTERVAL_MINUTES),
    DREAM_MAX_INTERVAL_MINUTES
  )
  const last = row?.last_run_at ?? null
  return {
    autoDream: (row?.auto_dream ?? 0) === 1,
    intervalMinutes: interval,
    lastRunAt: last,
    nextRunAt: last ? last + interval * 60_000 : null,
    tokensToday: usageToday(workspace.id),
    perRunBudget: DREAM_PER_RUN_TOKENS,
    dailyBudget: DREAM_DAILY_TOKENS
  }
}

function dreamSetSchedule(params: Record<string, unknown>): DreamScheduleState {
  const workspace = requireWorkspace(params)
  if (typeof params.autoDream !== 'boolean') throw new RpcError('VALIDATION', 'autoDream 必须是布尔值')
  const raw = params.intervalMinutes
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new RpcError('VALIDATION', 'intervalMinutes 非法')
  const interval = Math.min(Math.max(Math.floor(raw), DREAM_MIN_INTERVAL_MINUTES), DREAM_MAX_INTERVAL_MINUTES)
  db()
    .prepare(
      `INSERT INTO dream_schedule(workspace_id, auto_dream, interval_minutes, last_run_at)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(workspace_id) DO UPDATE SET auto_dream = excluded.auto_dream,
         interval_minutes = excluded.interval_minutes`
    )
    .run(workspace.id, params.autoDream ? 1 : 0, interval)
  return dreamScheduleState(params)
}

let autoDreamTimer: NodeJS.Timeout | null = null

function autoDreamTick(): void {
  const rows = db()
    .prepare(
      `SELECT s.workspace_id, s.interval_minutes, s.last_run_at, w.root
       FROM dream_schedule s JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.auto_dream = 1`
    )
    .all() as Array<{ workspace_id: string; interval_minutes: number; last_run_at: number | null; root: string }>
  const now = Date.now()
  for (const row of rows) {
    if (row.last_run_at && now - row.last_run_at < row.interval_minutes * 60_000) continue
    const review = db()
      .prepare("SELECT 1 AS ok FROM dream_jobs WHERE workspace_id = ? AND status = 'review' LIMIT 1")
      .get(row.workspace_id) as { ok?: number } | undefined
    if (review?.ok) continue
    try {
      dreamStart({ workspace: row.root })
      db()
        .prepare('UPDATE dream_schedule SET last_run_at = ? WHERE workspace_id = ?')
        .run(now, row.workspace_id)
    } catch {
      // Auto-dreaming is best-effort; a blocked run must not break the host.
    }
  }
}

function startAutoDreamTimer(): void {
  if (autoDreamTimer) return
  autoDreamTimer = setInterval(autoDreamTick, AUTO_DREAM_TICK_MS)
  autoDreamTimer.unref()
}

function dreamJobDto(row: DreamJobRow): DreamJob {
  let ops: DreamOp[] = []
  try {
    ops = JSON.parse(row.ops_json) as DreamOp[]
  } catch {
    ops = []
  }
  return {
    id: row.id,
    status: row.status,
    phase: row.phase,
    ops,
    deleteRatio: row.delete_ratio,
    l3Preview: row.l3_preview,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishId: row.publish_id ?? undefined,
    error: row.error ?? undefined
  }
}

function versionDto(row: KnowledgeVersionRow): DreamVersion {
  return {
    id: row.id,
    publishId: row.publish_id,
    label: row.label,
    status: row.status,
    summary: row.summary,
    l3Content: row.l3_content,
    opsCount: (() => {
      try {
        return (JSON.parse(row.ops_json) as unknown[]).length
      } catch {
        return 0
      }
    })(),
    createdAt: row.created_at
  }
}

function activeKnowledge(workspaceId: string): { active: string | null; previous: string | null } {
  const row = db()
    .prepare('SELECT active_version_id, previous_version_id FROM workspace_knowledge WHERE workspace_id = ?')
    .get(workspaceId) as { active_version_id?: string | null; previous_version_id?: string | null } | undefined
  return { active: row?.active_version_id ?? null, previous: row?.previous_version_id ?? null }
}

function dreamStart(params: Record<string, unknown>): DreamJob {
  const workspace = requireWorkspace(params)
  const notes = (
    db()
      .prepare("SELECT * FROM notes WHERE workspace_id = ? AND status = 'active' ORDER BY updated_at DESC")
      .all(workspace.id) as NoteRow[]
  ).filter((note) => noteIsLive(workspace.id, note.id, note.revision))
  const sources = db()
    .prepare("SELECT * FROM sources WHERE workspace_id = ? AND status = 'active' ORDER BY created_at DESC")
    .all(workspace.id) as SourceRow[]
  const ops: DreamOp[] = []
  const now = Date.now()
  const excluded = new Set<string>()
  const byTitle = new Map<string, NoteRow[]>()
  for (const note of notes) {
    const key = note.title.replace(/\s+/g, '').toLowerCase()
    const group = byTitle.get(key) ?? []
    group.push(note)
    byTitle.set(key, group)
  }
  for (const note of notes) {
    const stale = now - note.updated_at > 30 * 24 * 60 * 60 * 1000
    ops.push({
      id: `op-${randomUUID()}`,
      type: stale ? 'demote' : 'keep',
      targetIds: [note.id],
      evidenceRefs: [],
      reason: stale ? '笔记超过 30 天未更新，暂不进入启动摘要。' : '保留为稳定记忆。',
      confidence: 0.8,
      expectedRevision: note.revision
    })
    if (stale) excluded.add(note.id)
  }
  for (const group of byTitle.values()) {
    if (group.length < 2) continue
    ops.push({
      id: `op-${randomUUID()}`,
      type: 'merge',
      targetIds: group.map((note) => note.id),
      evidenceRefs: [],
      reason: '标题相同的笔记合并为一条。',
      confidence: 0.75,
      expectedRevision: Math.max(...group.map((note) => note.revision)),
      payload: {
        type: group[0]!.type as MemoryNoteType,
        title: group[0]!.title,
        body: group.map((note) => note.body).join('\n\n')
      }
    })
  }
  const noteTitles = new Set(notes.map((note) => note.title.replace(/\s+/g, '').toLowerCase()))
  for (const source of sources) {
    if (noteTitles.has(source.title.replace(/\s+/g, '').toLowerCase())) continue
    const evidence = db()
      .prepare("SELECT quote FROM evidence WHERE workspace_id = ? AND source_id = ? AND status = 'active' ORDER BY created_at LIMIT 1")
      .get(workspace.id, source.id) as { quote?: string } | undefined
    ops.push({
      id: `op-${randomUUID()}`,
      type: 'promote',
      targetIds: [],
      evidenceRefs: [source.id],
      reason: '资料尚未沉淀为 L1 笔记，提升为候选笔记。',
      confidence: 0.7,
      expectedRevision: 0,
      payload: {
        type: 'fact',
        title: source.title,
        body: evidence?.quote ? compact(evidence.quote, 1_200) : compact(source.body, 1_200)
      }
    })
  }
  for (const op of ops) {
    if (op.type === 'merge') for (const id of op.targetIds.slice(1)) excluded.add(id)
  }
  const deletions = ops.filter((op) => op.type === 'drop' || op.type === 'demote').length
  const deleteRatio = ops.length === 0 ? 0 : deletions / ops.length
  if (deleteRatio > MAX_DELETE_RATIO) {
    throw new RpcError('VALIDATION', `删除比例 ${(deleteRatio * 100).toFixed(0)}% 超过 25% 上限`)
  }
  const plan = ops.map((op) => ({
    ...op,
    payload: op.payload ? { ...op.payload, body: op.payload.body ? compact(op.payload.body, 600) : undefined } : undefined
  }))
  const l3Preview = buildL3Projection(workspace.id, excluded).text
  const id = `dream-${randomUUID()}`
  const createdAt = Date.now()
  db()
    .prepare(
      `INSERT INTO dream_jobs(id, workspace_id, status, phase, ops_json, l3_preview, delete_ratio, created_at, updated_at)
       VALUES (?, ?, 'review', 'promote', ?, ?, ?, ?, ?)`
    )
    .run(id, workspace.id, JSON.stringify(plan), l3Preview, deleteRatio, createdAt, createdAt)
  return dreamJobDto(db().prepare('SELECT * FROM dream_jobs WHERE id = ?').get(id) as unknown as DreamJobRow)
}

function dreamInspect(params: Record<string, unknown>): DreamJob | null {
  const workspace = requireWorkspace(params)
  const id = stringParam(params, 'jobId', 200)
  const row = db()
    .prepare('SELECT * FROM dream_jobs WHERE id = ? AND workspace_id = ?')
    .get(id, workspace.id) as unknown as DreamJobRow | undefined
  return row ? dreamJobDto(row) : null
}

function validateDreamOps(ops: DreamOp[]): void {
  if (!Array.isArray(ops)) throw new RpcError('VALIDATION', '裁决必须是数组')
  const seen = new Set<string>()
  for (const op of ops) {
    if (!op || typeof op !== 'object') throw new RpcError('VALIDATION', '裁决格式非法')
    if (seen.has(op.id)) throw new RpcError('VALIDATION', `重复的 opId：${op.id}`)
    seen.add(op.id)
    if (!['keep', 'fix', 'merge', 'drop', 'promote', 'demote'].includes(op.type)) {
      throw new RpcError('VALIDATION', `未知操作：${op.type}`)
    }
    if (!Array.isArray(op.targetIds) || !Array.isArray(op.evidenceRefs)) {
      throw new RpcError('VALIDATION', 'targetIds/evidenceRefs 必须是数组')
    }
    if (typeof op.reason !== 'string' || !op.reason.trim()) throw new RpcError('VALIDATION', '裁决缺少 reason')
    if (typeof op.confidence !== 'number' || op.confidence < 0 || op.confidence > 1) {
      throw new RpcError('VALIDATION', 'confidence 必须在 0..1')
    }
    if (typeof op.expectedRevision !== 'number') throw new RpcError('VALIDATION', '裁决缺少 expectedRevision')
  }
}

function applyDreamNote(workspaceId: string, op: DreamOp): void {
  if (op.type === 'promote') {
    const title = op.payload?.title?.trim()
    const body = op.payload?.body?.trim()
    if (!title || !body) throw new RpcError('VALIDATION', 'promote 缺少标题或正文')
    for (const ref of op.evidenceRefs) {
      const source = db()
        .prepare("SELECT id FROM sources WHERE id = ? AND workspace_id = ? AND status = 'active'")
        .get(ref, workspaceId) as { id?: string } | undefined
      if (!source?.id) throw new RpcError('VALIDATION', `证据来源不存在或已撤销：${ref}`)
    }
    createNoteRow(workspaceId, op.payload?.type ?? 'fact', title, body, true, op.evidenceRefs)
    return
  }
  if (op.type === 'fix' || op.type === 'merge') {
    const target = op.targetIds[0]
    if (!target) throw new RpcError('VALIDATION', `${op.type} 缺少目标`)
    const note = db()
      .prepare("SELECT * FROM notes WHERE id = ? AND workspace_id = ? AND status = 'active'")
      .get(target, workspaceId) as NoteRow | undefined
    if (!note) throw new RpcError('VALIDATION', '目标笔记不存在或已撤销')
    if (note.revision !== op.expectedRevision) {
      throw new RpcError('CONFLICT', `目标笔记版本已变化（期望 ${op.expectedRevision}，实际 ${note.revision}）`)
    }
    if (op.type === 'fix' || op.type === 'merge') {
      const title = op.payload?.title?.trim() || note.title
      const body = op.payload?.body?.trim() || note.body
      const revision = note.revision + 1
      db()
        .prepare('UPDATE notes SET title = ?, body = ?, revision = ?, updated_at = ? WHERE id = ?')
        .run(title, body, revision, Date.now(), note.id)
      db()
        .prepare('INSERT INTO note_versions(id, note_id, revision, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(`nv-${randomUUID()}`, note.id, revision, title, body, Date.now())
      if (note.derived === 1) {
        copyNoteDependencies(note.id, note.revision, revision)
        recordSourceDependencies(workspaceId, note.id, revision, op.evidenceRefs)
      }
      indexDoc(workspaceId, note.id, 'note', title, body)
      if (op.type === 'merge') {
        for (const extraId of op.targetIds.slice(1)) {
          const extra = db()
            .prepare("SELECT id FROM notes WHERE id = ? AND workspace_id = ? AND status = 'active'")
            .get(extraId, workspaceId) as { id?: string } | undefined
          if (!extra?.id) continue
          db()
            .prepare("UPDATE notes SET status = 'revoked', revoked_at = ? WHERE id = ?")
            .run(Date.now(), extraId)
          unindexDoc(extraId)
        }
      }
    }
  }
}

function dreamApply(params: Record<string, unknown>): DreamVersion {
  const workspace = requireWorkspace(params)
  const jobId = stringParam(params, 'jobId', 200)
  const publishId = stringParam(params, 'publishId', 200)
  const existing = db()
    .prepare('SELECT * FROM knowledge_versions WHERE publish_id = ?')
    .get(publishId) as unknown as KnowledgeVersionRow | undefined
  if (existing) {
    if (existing.workspace_id !== workspace.id) throw new RpcError('VALIDATION', 'publishId 已属于其它工作区')
    return versionDto(existing)
  }
  const job = db()
    .prepare('SELECT * FROM dream_jobs WHERE id = ? AND workspace_id = ?')
    .get(jobId, workspace.id) as unknown as DreamJobRow | undefined
  if (!job) throw new RpcError('VALIDATION', 'Dreaming 任务不存在')
  if (job.status !== 'review') throw new RpcError('VALIDATION', `任务状态为 ${job.status}，不能发布`)
  const ops = JSON.parse(job.ops_json) as DreamOp[]
  try {
    validateDreamOps(ops)
  } catch (error) {
    db()
      .prepare("UPDATE dream_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(error instanceof Error ? error.message : String(error), Date.now(), job.id)
    throw error
  }
  if (job.delete_ratio > MAX_DELETE_RATIO) throw new RpcError('VALIDATION', '删除比例超过 25% 上限')
  const excluded = new Set<string>()
  for (const op of ops) {
    if (op.type === 'drop' || op.type === 'demote') for (const id of op.targetIds) excluded.add(id)
    if (op.type === 'merge') for (const id of op.targetIds.slice(1)) excluded.add(id)
  }
  const published = tx(() => {
    for (const op of ops) applyDreamNote(workspace.id, op)
    const projection = buildL3Projection(workspace.id, excluded)
    const content = projection.text
    const tokens = Math.ceil(Buffer.byteLength(content, 'utf8') / 4)
    if (tokens > DREAM_PER_RUN_TOKENS) {
      throw new RpcError('VALIDATION', `单次 Dreaming 预算超限（${tokens} > ${DREAM_PER_RUN_TOKENS} token）`)
    }
    if (usageToday(workspace.id) + tokens > DREAM_DAILY_TOKENS) {
      throw new RpcError(
        'VALIDATION',
        `当日 Dreaming 预算超限（${usageToday(workspace.id) + tokens} > ${DREAM_DAILY_TOKENS} token）`
      )
    }
    const quality = computeQuality(workspace.id, job.delete_ratio, content)
    if (!quality.verified) {
      const failed = quality.checks.filter((check) => !check.ok).map((check) => check.detail).join('；')
      throw new RpcError('VALIDATION', `质量校验未通过：${failed}`)
    }
    const previous = activeKnowledge(workspace.id).active
    const revision = bumpRevision(workspace.id)
    const versionId = `kv-${randomUUID()}`
    const now = Date.now()
    const label = `Dream ${new Date(now).toISOString().slice(0, 19).replace('T', ' ')}`
    const summary = `${ops.length} 项裁决 · 删除比例 ${(job.delete_ratio * 100).toFixed(0)}% · ${Buffer.byteLength(content, 'utf8')} 字节`
    db()
      .prepare(
        `INSERT INTO knowledge_versions(id, workspace_id, publish_id, label, l3_content, ops_json, summary, status, created_at, projection_json, workspace_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      )
      .run(
        versionId,
        workspace.id,
        publishId,
        label,
        content,
        JSON.stringify(ops),
        summary,
        now,
        JSON.stringify(projection.entries),
        revision
      )
    if (previous) {
      db().prepare("UPDATE knowledge_versions SET status = 'superseded' WHERE id = ?").run(previous)
    }
    db()
      .prepare(
        `INSERT INTO workspace_knowledge(workspace_id, active_version_id, previous_version_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET active_version_id = excluded.active_version_id,
           previous_version_id = excluded.previous_version_id, updated_at = excluded.updated_at`
      )
      .run(workspace.id, versionId, previous, now)
    db()
      .prepare("UPDATE dream_jobs SET status = 'applied', publish_id = ?, updated_at = ? WHERE id = ?")
      .run(publishId, now, job.id)
    addUsage(workspace.id, tokens)
    return {
      version: versionDto(db().prepare('SELECT * FROM knowledge_versions WHERE id = ?').get(versionId) as unknown as KnowledgeVersionRow),
      content
    }
  })
  writeL3File(published.content, activeKnowledge(workspace.id).previous)
  return published.version
}

function dreamReject(params: Record<string, unknown>): DreamJob {
  const workspace = requireWorkspace(params)
  const id = stringParam(params, 'jobId', 200)
  const job = db()
    .prepare('SELECT * FROM dream_jobs WHERE id = ? AND workspace_id = ?')
    .get(id, workspace.id) as unknown as DreamJobRow | undefined
  if (!job) throw new RpcError('VALIDATION', 'Dreaming 任务不存在')
  if (job.status !== 'review') throw new RpcError('VALIDATION', '只有待审任务可以拒绝')
  const now = Date.now()
  db().prepare("UPDATE dream_jobs SET status = 'rejected', updated_at = ? WHERE id = ?").run(now, id)
  return dreamJobDto(db().prepare('SELECT * FROM dream_jobs WHERE id = ?').get(id) as unknown as DreamJobRow)
}

function dreamState(params: Record<string, unknown>): DreamState {
  const workspace = requireWorkspace(params)
  const { active } = activeKnowledge(workspace.id)
  const activeRow = active
    ? (db().prepare('SELECT * FROM knowledge_versions WHERE id = ?').get(active) as unknown as KnowledgeVersionRow | undefined)
    : undefined
  const rows = db()
    .prepare('SELECT * FROM knowledge_versions WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20')
    .all(workspace.id) as unknown as KnowledgeVersionRow[]
  return { active: activeRow ? versionDto(activeRow) : null, versions: rows.map(versionDto) }
}

function dreamRollback(params: Record<string, unknown>): DreamVersion | null {
  const workspace = requireWorkspace(params)
  const versionId = optionalString(params, 'versionId', 200)
  const knowledge = activeKnowledge(workspace.id)
  const target = versionId ?? knowledge.previous
  if (!target) return null
  const row = db()
    .prepare("SELECT * FROM knowledge_versions WHERE id = ? AND workspace_id = ? AND status != 'revoked'")
    .get(target, workspace.id) as unknown as KnowledgeVersionRow | undefined
  if (!row) throw new RpcError('VALIDATION', '目标知识版本不存在或已撤销')
  const now = Date.now()
  tx(() => {
    if (knowledge.active && knowledge.active !== target) {
      db().prepare("UPDATE knowledge_versions SET status = 'superseded' WHERE id = ?").run(knowledge.active)
    }
    db().prepare("UPDATE knowledge_versions SET status = 'active' WHERE id = ?").run(target)
    db()
      .prepare(
        `INSERT INTO workspace_knowledge(workspace_id, active_version_id, previous_version_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET active_version_id = excluded.active_version_id,
           previous_version_id = excluded.previous_version_id, updated_at = excluded.updated_at`
      )
      .run(workspace.id, target, knowledge.active, now)
    bumpRevision(workspace.id)
  })
  const targetEntries = parseProjection(row)
  const targetText = targetEntries ? renderL3(targetEntries.filter((entry) => l3EntryLive(workspace.id, entry))) : ''
  writeL3File(targetText, knowledge.active)
  return versionDto(db().prepare('SELECT * FROM knowledge_versions WHERE id = ?').get(target) as unknown as KnowledgeVersionRow)
}

function dreamRevoke(params: Record<string, unknown>): DreamVersion {
  const workspace = requireWorkspace(params)
  const versionId = stringParam(params, 'versionId', 200)
  const row = db()
    .prepare('SELECT * FROM knowledge_versions WHERE id = ? AND workspace_id = ?')
    .get(versionId, workspace.id) as unknown as KnowledgeVersionRow | undefined
  if (!row) throw new RpcError('VALIDATION', '知识版本不存在')
  const knowledge = activeKnowledge(workspace.id)
  tx(() => {
    db().prepare("UPDATE knowledge_versions SET status = 'revoked' WHERE id = ?").run(versionId)
    if (knowledge.active === versionId) {
      const fallback = knowledge.previous
      if (fallback) {
        db().prepare("UPDATE knowledge_versions SET status = 'active' WHERE id = ?").run(fallback)
        db()
          .prepare('UPDATE workspace_knowledge SET active_version_id = ?, previous_version_id = NULL, updated_at = ? WHERE workspace_id = ?')
          .run(fallback, Date.now(), workspace.id)
      } else {
        db()
          .prepare('UPDATE workspace_knowledge SET active_version_id = NULL, previous_version_id = NULL, updated_at = ? WHERE workspace_id = ?')
          .run(Date.now(), workspace.id)
      }
    }
    bumpRevision(workspace.id)
  })
  if (knowledge.active === versionId) {
    const fallbackRow = knowledge.previous
      ? (db().prepare('SELECT * FROM knowledge_versions WHERE id = ?').get(knowledge.previous) as unknown as KnowledgeVersionRow | undefined)
      : undefined
    const fallbackEntries = fallbackRow ? parseProjection(fallbackRow) : null
    const fallbackText = fallbackEntries
      ? renderL3(fallbackEntries.filter((entry) => l3EntryLive(workspace.id, entry)))
      : ''
    writeL3File(fallbackText, versionId)
  }
  return versionDto(db().prepare('SELECT * FROM knowledge_versions WHERE id = ?').get(versionId) as unknown as KnowledgeVersionRow)
}

function wikiBodyFor(source: SourceRow, quotes: string[]): string {
  return [
    `# ${source.title}`,
    '',
    `> 来源：${source.origin}`,
    `> 修订：${source.revision} · 内容哈希：${source.hash.slice(0, 16)}…`,
    '',
    '## 可核验摘录',
    ...quotes.slice(0, 4).map((quote) => `- ${quote.replace(/\s+/g, ' ').slice(0, 400)}`),
    '',
    '## 出处',
    `- source:${source.id} · revision:${source.revision}`
  ].join('\n')
}

function generateWiki(params: Record<string, unknown>): WikiPage[] {
  const workspace = requireWorkspace(params)
  const requested = params.sourceIds
  const requestedIds = Array.isArray(requested)
    ? requested.filter((item): item is string => typeof item === 'string')
    : []
  const rows = db()
    .prepare("SELECT * FROM sources WHERE workspace_id = ? AND status = 'active' ORDER BY created_at ASC")
    .all(workspace.id) as SourceRow[]
  const selected = requestedIds.length > 0 ? rows.filter((row) => requestedIds.includes(row.id)) : rows
  if (selected.length === 0) throw new RpcError('VALIDATION', '当前工作区没有可生成 Wiki 的有效来源')

  const pages: WikiPage[] = []
  for (const source of selected) {
    const quotes = db()
      .prepare("SELECT quote FROM evidence WHERE source_id = ? AND status = 'active' ORDER BY created_at ASC LIMIT 4")
      .all(source.id) as Array<{ quote: string }>
    const slug = `source-${source.id.slice(4, 16)}`
    const existing = db()
      .prepare('SELECT * FROM wiki_pages WHERE workspace_id = ? AND slug = ?')
      .get(workspace.id, slug) as WikiRow | undefined
    if (existing?.status === 'published') {
      pages.push(wikiDto(existing))
      continue
    }
    const now = Date.now()
    const body = wikiBodyFor(source, quotes.map((row) => row.quote))
    const id = existing?.id ?? `wiki-${randomUUID()}`
    const revision = existing ? existing.revision + 1 : 1
    tx(() => {
      if (existing) {
        db()
          .prepare(
            "UPDATE wiki_pages SET title = ?, body = ?, revision = ?, status = 'draft', source_ids = ?, updated_at = ? WHERE id = ?"
          )
          .run(source.title, body, revision, JSON.stringify([source.id]), now, id)
      } else {
        db()
          .prepare(
            `INSERT INTO wiki_pages(id, workspace_id, slug, title, body, revision, status, source_ids, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, 'draft', ?, ?, ?)`
          )
          .run(id, workspace.id, slug, source.title, body, JSON.stringify([source.id]), now, now)
      }
    })
    pages.push(wikiDto(db().prepare('SELECT * FROM wiki_pages WHERE id = ?').get(id) as WikiRow))
  }
  return pages
}

function listWiki(workspaceId: string): WikiPage[] {
  const rows = db()
    .prepare('SELECT * FROM wiki_pages WHERE workspace_id = ? ORDER BY updated_at DESC')
    .all(workspaceId) as WikiRow[]
  return rows.map(wikiDto)
}

function publishWiki(params: Record<string, unknown>): WikiPage {
  const workspace = requireWorkspace(params)
  const id = stringParam(params, 'id', 200)
  const row = db()
    .prepare('SELECT * FROM wiki_pages WHERE id = ? AND workspace_id = ?')
    .get(id, workspace.id) as WikiRow | undefined
  if (!row) throw new RpcError('VALIDATION', 'Wiki 页面不存在')
  const sourceIds = parseStringArray(row.source_ids)
  if (sourceIds.length === 0) throw new RpcError('VALIDATION', 'Wiki 页面没有来源，不能发布')
  if (sourceIds.some((sourceId) => sourceRevoked(sourceId))) {
    throw new RpcError('VALIDATION', '页面来源已撤销，请重新生成草稿')
  }
  const now = Date.now()
  const revision = row.revision + 1
  return tx(() => {
    db()
      .prepare("UPDATE wiki_pages SET status = 'published', revision = ?, updated_at = ? WHERE id = ?")
      .run(revision, now, id)
    db()
      .prepare('INSERT INTO wiki_versions(id, page_id, revision, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`wv-${randomUUID()}`, id, revision, row.title, row.body, now)
    indexDoc(workspace.id, id, 'wiki', row.title, row.body)
    bumpRevision(workspace.id)
    return wikiDto(db().prepare('SELECT * FROM wiki_pages WHERE id = ?').get(id) as WikiRow)
  })
}

function revokeWiki(params: Record<string, unknown>): void {
  const workspace = requireWorkspace(params)
  const id = stringParam(params, 'id', 200)
  const now = Date.now()
  tx(() => {
    db()
      .prepare("UPDATE wiki_pages SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
      .run(now, now, id, workspace.id)
    unindexDoc(id)
    bumpRevision(workspace.id)
  })
}

function listProposals(workspaceId: string): MemoryProposal[] {
  const rows = db()
    .prepare('SELECT * FROM proposals WHERE workspace_id = ? ORDER BY created_at DESC')
    .all(workspaceId) as Array<{
    id: string
    kind: string | null
    type: string
    title: string
    body: string
    evidence_ids: string
    target_note_id: string | null
    target_revision: number | null
    status: string
    created_at: number
    decided_at: number | null
  }>
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind === 'fix' ? 'fix' : 'note',
    type: row.type as MemoryNoteType,
    title: row.title,
    body: row.body,
    evidenceIds: parseStringArray(row.evidence_ids),
    targetNoteId: row.target_note_id ?? undefined,
    targetRevision: row.target_revision ?? undefined,
    status:
      row.status === 'approved'
        ? 'approved'
        : row.status === 'rejected'
          ? 'rejected'
          : row.status === 'stale'
            ? 'stale'
            : 'pending',
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined
  }))
}

function createProposal(params: Record<string, unknown>): MemoryProposal {
  const workspace = requireWorkspace(params)
  const mode = getMode(workspace.id)
  if (mode === 'off') throw new RpcError('VALIDATION', '记忆已关闭，不能提交候选')
  const input = validateNoteInput(params)
  const rawEvidence = params.evidenceIds
  const evidenceIds = Array.isArray(rawEvidence)
    ? rawEvidence.filter((item): item is string => typeof item === 'string').slice(0, 20)
    : []
  for (const evidenceId of evidenceIds) {
    const row = db()
      .prepare(
        `SELECT e.id FROM evidence e JOIN sources s ON s.id = e.source_id
         WHERE e.id = ? AND e.workspace_id = ? AND e.status = 'active' AND s.status = 'active'`
      )
      .get(evidenceId, workspace.id) as { id?: string } | undefined
    if (!row?.id) throw new RpcError('VALIDATION', `证据不存在或已撤销：${evidenceId}`)
  }
  const id = `prop-${randomUUID()}`
  const now = Date.now()
  db()
    .prepare(
      `INSERT INTO proposals(id, workspace_id, type, title, body, evidence_ids, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
    .run(id, workspace.id, input.type, input.title, input.body, JSON.stringify(evidenceIds), now)
  return listProposals(workspace.id).find((proposal) => proposal.id === id) as MemoryProposal
}

function correctNote(params: Record<string, unknown>): MemoryProposal {
  const workspace = requireWorkspace(params)
  if (getMode(workspace.id) === 'off') throw new RpcError('VALIDATION', '记忆已关闭，不能提交纠正候选')
  const noteId = stringParam(params, 'noteId', 200)
  const body = stringParam(params, 'body', 40_000).trim()
  if (!body) throw new RpcError('VALIDATION', '纠正后的正文不能为空')
  const note = db()
    .prepare("SELECT * FROM notes WHERE id = ? AND workspace_id = ? AND status = 'active'")
    .get(noteId, workspace.id) as NoteRow | undefined
  if (!note) throw new RpcError('VALIDATION', '目标笔记不存在或已撤销')
  const rawEvidence = params.evidenceIds
  const evidenceIds = Array.isArray(rawEvidence)
    ? rawEvidence.filter((item): item is string => typeof item === 'string').slice(0, 20)
    : []
  if (evidenceIds.length === 0) throw new RpcError('VALIDATION', '纠正笔记必须引用至少一条有效证据')
  for (const evidenceId of evidenceIds) {
    const row = db()
      .prepare(
        `SELECT e.id FROM evidence e JOIN sources s ON s.id = e.source_id
         WHERE e.id = ? AND e.workspace_id = ? AND e.status = 'active' AND s.status = 'active'`
      )
      .get(evidenceId, workspace.id) as { id?: string } | undefined
    if (!row?.id) throw new RpcError('VALIDATION', `证据不存在或已撤销：${evidenceId}`)
  }
  const id = `prop-${randomUUID()}`
  const now = Date.now()
  db()
    .prepare(
      `INSERT INTO proposals(id, workspace_id, kind, type, title, body, evidence_ids, target_note_id, target_revision, status, created_at)
       VALUES (?, ?, 'fix', ?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
    .run(id, workspace.id, note.type, note.title, body, JSON.stringify(evidenceIds), noteId, note.revision, now)
  return listProposals(workspace.id).find((proposal) => proposal.id === id) as MemoryProposal
}

function decideProposal(params: Record<string, unknown>): MemoryProposal {
  const workspace = requireWorkspace(params)
  const id = stringParam(params, 'id', 200)
  const approve = params.approve === true
  const row = db()
    .prepare("SELECT * FROM proposals WHERE id = ? AND workspace_id = ? AND status = 'pending'")
    .get(id, workspace.id) as
    | {
        id: string
        kind: string | null
        type: string
        title: string
        body: string
        evidence_ids: string
        target_note_id: string | null
        target_revision: number | null
      }
    | undefined
  if (!row) throw new RpcError('VALIDATION', '候选不存在或已处理')
  const now = Date.now()
  return tx(() => {
    if (approve && row.kind === 'fix') {
      const noteId = row.target_note_id
      if (!noteId) throw new RpcError('VALIDATION', '纠正候选缺少目标笔记')
      const note = db()
        .prepare("SELECT * FROM notes WHERE id = ? AND workspace_id = ? AND status = 'active'")
        .get(noteId, workspace.id) as NoteRow | undefined
      if (!note) throw new RpcError('VALIDATION', '目标笔记不存在或已撤销')
      if (row.target_revision === null || note.revision !== row.target_revision) {
        db()
          .prepare("UPDATE proposals SET status = 'stale', decided_at = ? WHERE id = ?")
          .run(now, id)
        return listProposals(workspace.id).find((proposal) => proposal.id === id) as MemoryProposal
      }
      const evidenceIds = parseStringArray(row.evidence_ids)
      for (const evidenceId of evidenceIds) {
        const evidence = db()
          .prepare(
            `SELECT e.id FROM evidence e JOIN sources s ON s.id = e.source_id
             WHERE e.id = ? AND e.workspace_id = ? AND e.status = 'active' AND s.status = 'active'`
          )
          .get(evidenceId, workspace.id) as { id?: string } | undefined
        if (!evidence?.id) throw new RpcError('VALIDATION', `纠正所用的证据已撤销：${evidenceId}`)
      }
      const revision = note.revision + 1
      db()
        .prepare('UPDATE notes SET body = ?, revision = ?, derived = 1, updated_at = ? WHERE id = ?')
        .run(row.body, revision, now, noteId)
      db()
        .prepare('INSERT INTO note_versions(id, note_id, revision, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(`nv-${randomUUID()}`, noteId, revision, note.title, row.body, now)
      if (!recordEvidenceDependencies(workspace.id, noteId, revision, evidenceIds)) {
        throw new RpcError('VALIDATION', '纠正证据无法映射到当前工作区')
      }
      indexDoc(workspace.id, noteId, 'note', note.title, row.body)
      bumpRevision(workspace.id)
      refreshActiveProjection(workspace.id)
    } else if (approve) {
      createNoteRow(workspace.id, row.type as MemoryNoteType, row.title, row.body)
    }
    db()
      .prepare('UPDATE proposals SET status = ?, decided_at = ? WHERE id = ?')
      .run(approve ? 'approved' : 'rejected', now, id)
    return listProposals(workspace.id).find((proposal) => proposal.id === id) as MemoryProposal
  })
}

function runDiagnostics(): MemoryDiagnostics {
  const checkedAt = Date.now()
  let connection: DatabaseSync | null = null
  try {
    connection = openDatabase()
    const sqliteVersion = readSqliteVersion(connection)
    const probeId = `probe-${checkedAt}-${Math.random().toString(36).slice(2, 10)}`
    connection.prepare('INSERT INTO memory_fts(note_id, body) VALUES (?, ?)').run(probeId, SAMPLE_BODY)
    try {
      const rows = connection
        .prepare(
          `SELECT note_id, snippet(memory_fts, 1, '[', ']', '…', 12) AS snippet
           FROM memory_fts
           WHERE memory_fts MATCH ?
           LIMIT 5`
        )
        .all(SAMPLE_QUERY) as Array<{ note_id: string; snippet: string }>
      const ownRows = rows.filter((row) => row.note_id === probeId)
      return {
        ok: ownRows.length === 1,
        sqliteVersion,
        fts5: true,
        tokenizer: TOKENIZER,
        sampleMatches: ownRows.length,
        checkedAt,
        detail:
          ownRows.length === 1
            ? `FTS5 ${TOKENIZER} 中文查询「${SAMPLE_QUERY}」命中了自检探针：${ownRows[0]?.snippet ?? ''}`
            : `FTS5 可用，但中文查询「${SAMPLE_QUERY}」未命中探针（匹配 ${rows.length} 条）`
      }
    } finally {
      connection.prepare('DELETE FROM memory_fts WHERE note_id = ?').run(probeId)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      sqliteVersion: connection ? readSqliteVersion(connection) : 'unavailable',
      fts5: false,
      tokenizer: TOKENIZER,
      sampleMatches: 0,
      checkedAt,
      detail: `SQLite/FTS5 自检失败：${message}`
    }
  }
}

function respond(id: number, value: unknown): void {
  port.postMessage({ kind: 'response', id, ok: true, value })
}

function respondError(id: number, code: string, message: string): void {
  port.postMessage({ kind: 'response', id, ok: false, error: { code, message } })
}

const handlers: Record<string, (params: Record<string, unknown>) => unknown | Promise<unknown>> = {
  diagnostics: () => runDiagnostics(),
  state: (params) => {
    const workspace = requireWorkspace(params)
    return stateFor(workspace.id)
  },
  setMode: (params) => {
    const workspace = requireWorkspace(params)
    const mode = stringParam(params, 'mode', 20)
    ensureWorkspace(workspace.root)
    if (mode !== 'off' && mode !== 'rag' && mode !== 'wiki' && mode !== 'both') {
      throw new RpcError('VALIDATION', '未知记忆策略')
    }
    db()
      .prepare('UPDATE workspace_settings SET mode = ?, updated_at = ? WHERE workspace_id = ?')
      .run(mode, Date.now(), workspace.id)
    return stateFor(workspace.id)
  },
  importSource,
  listSources: (params) => listSources(requireWorkspace(params).id),
  revokeSource,
  search: async (params) => {
    const workspace = requireWorkspace(params)
    const query = stringParam(params, 'query', 500).trim()
    const limitRaw = params.limit
    const limit = Math.min(
      Math.max(typeof limitRaw === 'number' && Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 10, 1),
      MAX_SEARCH_RESULTS
    )
    const mode = getMode(workspace.id)
    const result = await searchMemory(workspace.id, mode, query, limit)
    return {
      query,
      hits: result.hits,
      mode,
      engine: result.engine,
      engineNote: result.engineNote,
      wikiEngine: result.wikiEngine,
      wikiNote: result.wikiNote
    }
  },
  validateIds: async (params) => {
    const workspace = requireWorkspace(params)
    const raw = Array.isArray(params.ids) ? params.ids : []
    const ids = [...new Set(raw.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))]
      .slice(0, 200)
    const valid: string[] = []
    for (const id of ids) {
      if (id.startsWith('llm-wiki:')) {
        if (await readWikiPage(workspace.id, id)) valid.push(id)
        continue
      }
      if (
        loadHit(workspace.id, 'note', id, '') ||
        loadHit(workspace.id, 'evidence', id, '') ||
        loadHit(workspace.id, 'wiki', id, '')
      ) {
        valid.push(id)
      }
    }
    return { valid }
  },
  get: async (params) => {
    const workspace = requireWorkspace(params)
    const id = stringParam(params, 'id', 200)
    const mode = getMode(workspace.id)
    if (!allowedKinds(mode).includes('wiki')) return null
    if (id.startsWith('llm-wiki:')) return readWikiPage(workspace.id, id)
    for (const kind of ['note', 'wiki', 'evidence'] as MemoryHitKind[]) {
      if (!allowedKinds(mode).includes(kind)) continue
      const hit = loadHit(workspace.id, kind, id, '')
      if (hit) return hit
    }
    return null
  },
  listNotes: (params) => listNotes(requireWorkspace(params).id),
  createNote,
  correctNote,
  updateNote,
  revokeNote,
  generateWiki,
  listWiki: (params) => listWiki(requireWorkspace(params).id),
  publishWiki,
  revokeWiki,
  listProposals: (params) => listProposals(requireWorkspace(params).id),
  createProposal,
  decideProposal,
  dreamStart,
  dreamInspect,
  dreamApply,
  dreamReject,
  dreamState,
  dreamRollback,
  dreamRevoke,
  dreamQuality,
  dreamSchedule: dreamScheduleState,
  dreamSetSchedule,
  l3Context: (params) => {
    const workspace = requireWorkspace(params)
    const rawMode = optionalString(params, 'mode', 20) ?? 'both'
    const mode: MemoryMode =
      rawMode === 'rag' || rawMode === 'wiki' || rawMode === 'off' || rawMode === 'both' ? rawMode : 'both'
    return l3ContextFor(workspace.id, mode)
  }
};

(port as unknown as { on: (name: 'message', listener: (event: Electron.MessageEvent) => void) => void }).on('message', (event: Electron.MessageEvent) => {
  const message = event.data as RpcRequest | undefined
  if (!message || message.kind !== 'request') return
  const handler = handlers[message.method]
  if (!handler) {
    respondError(message.id, 'METHOD_NOT_FOUND', `Unknown memory method: ${message.method}`)
    return
  }
  void Promise.resolve()
    .then(() => handler(objectParam(message.params ?? {})))
    .then(
      (value) => respond(message.id, value),
      (error: unknown) => {
        console.error(`[memory-host] ${message.method} failed`, error)
        if (error instanceof RpcError) {
          respondError(message.id, error.code, error.message)
        } else {
          respondError(message.id, 'INTERNAL', error instanceof Error ? error.message : String(error))
        }
      }
    )
});

(port as unknown as { start?: () => void }).start?.();
startAutoDreamTimer();
