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
import {
  RETRIEVAL_MODE,
  cosine,
  hashEmbedding,
  reciprocalRankFusion,
  rerankScore,
  type RankedList
} from './retrieval.ts'
import {
  EMBED_MODEL,
  RERANK_MODEL,
  embedQuery,
  embedTexts,
  modelsReady,
  rerankScores,
  warmEmbedder,
  warmReranker
} from './semantic.ts'
import { parsePdfBuffer } from '../../parallel/rag/src/docling/pdf.ts'
import { runDocling } from '../../parallel/rag/src/docling/client.ts'
import { compileTopic } from '../../parallel/wiki/src/compiler.mjs'
import { diffLines, renderUnifiedDiff } from '../../parallel/wiki/src/diff.mjs'
import { estimateTokens } from '../../parallel/dream/src/util.mjs'
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
import { bilingualQueryTerms } from './bilingual'
import { synonymTerms } from './synonyms'
import { chunkText } from './chunk'
import { buildConstellation, type GraphDoc, type GraphStructuralEdge } from './graph.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  MemoryMetrics,
  MemoryMode,
  MemorySearchEngine,
  KnowledgeGraph,
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
/**
 * Bump when the text written into `search_index` changes shape. Workspaces
 * stamped with an older version get their FTS rows rebuilt once, so existing
 * libraries pick up index-side fixes without a re-import.
 */
const SEARCH_INDEX_VERSION = 5
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_SEARCH_RESULTS = 50
/**
 * Optional QMD module (see docs/P1-上游复现记录.md). The app never depends on it:
 * without the env var every search stays on the in-process FTS5 projection.
 * The path points at @tobilu/qmd/dist/index.js in a separately installed tree.
 */
const QMD_MODULE_PATH = process.env.OPENFUTURE_QMD_MODULE?.trim() ?? ''
// When enabled, searchMemory prints per-stage timings (anchors/words/fuse/prf/merged).
const SEARCH_PROFILE = process.env.OPENFUTURE_SEARCH_PROFILE === '1'
const QMD_HYBRID = process.env.OPENFUTURE_QMD_HYBRID === '1'

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
  embed?(): Promise<unknown>
  search?(options: {
    queries: { type: 'lex' | 'vec'; query: string }[]
    rerank: boolean
    limit: number
  }): Promise<QmdSearchRow[]>
  close(): Promise<unknown> | unknown
}

const qmdStores = new Map<string, Promise<QmdStore>>()
const qmdHybridRunning = new Set<string>()
/** Corpus generation each workspace's QMD index was last synced at. */
const qmdSyncedGeneration = new Map<string, number>()
let qmdLastError = ''

async function searchQmdRows(store: QmdStore, workspaceId: string, query: string, limit: number): Promise<QmdSearchRow[]> {
  // Rewriting the corpus and calling update() on every query costs ~400 ms.
  // The corpus only changes when the FTS projection changes, so reuse the
  // last sync until the generation advances.
  const syncIfStale = async (): Promise<void> => {
    if (qmdSyncedGeneration.get(workspaceId) === vectorGeneration) return
    syncQmdCorpus(workspaceId)
    await store.update()
    qmdSyncedGeneration.set(workspaceId, vectorGeneration)
  }
  if (!QMD_HYBRID || !store.embed || !store.search) {
    await syncIfStale()
    return store.searchLex(query, { limit })
  }
  if (qmdHybridRunning.has(workspaceId)) throw new Error('QMD 混合检索仍在处理')
  qmdHybridRunning.add(workspaceId)
  const task = (async () => {
    await syncIfStale()
    try {
      await store.embed!()
      return await store.search!({
        queries: [{ type: 'lex', query }, { type: 'vec', query }],
        rerank: false,
        limit
      })
    } catch {
      return store.searchLex(query, { limit })
    }
  })().finally(() => qmdHybridRunning.delete(workspaceId))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('QMD 混合检索超时，已回退到本地全文检索')), 5_000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

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
    CREATE TABLE IF NOT EXISTS search_index_meta (
      workspace_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS semantic_vectors (
      hash TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS retrieval_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      query TEXT NOT NULL,
      hits INTEGER NOT NULL,
      top_score REAL NOT NULL,
      duration_ms INTEGER NOT NULL,
      engine TEXT NOT NULL,
      mode TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS retrieval_events_workspace ON retrieval_events(workspace_id, at DESC);
    CREATE TABLE IF NOT EXISTS semantic_docs (
      workspace_id TEXT NOT NULL,
      hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      PRIMARY KEY(workspace_id, hash)
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
    CREATE VIRTUAL TABLE IF NOT EXISTS search_words
    USING fts5(
      workspace_id UNINDEXED,
      doc_id UNINDEXED,
      kind UNINDEXED,
      title,
      body,
      tokenize = 'porter unicode61'
    );
    CREATE TABLE IF NOT EXISTS search_docs (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      text_lower TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS search_docs_workspace ON search_docs(workspace_id, kind);
  `)
  ensureColumn(db, 'knowledge_versions', 'projection_json', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn(db, 'knowledge_versions', 'workspace_revision', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'proposals', 'kind', "TEXT NOT NULL DEFAULT 'note'")
  ensureColumn(db, 'proposals', 'target_note_id', 'TEXT')
  ensureColumn(db, 'proposals', 'target_revision', 'INTEGER')
  ensureColumn(db, 'notes', 'derived', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'search_docs', 'text_lower', "TEXT NOT NULL DEFAULT ''")
  migrateDerivedNotes(db)
  migrateSearchIndex(db)
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

/**
 * Text in `search_index` was written with an older normalisation, so a query
 * built by the current `ftsQuery` would silently miss terms that the new
 * canonical form produces. Rebuild the FTS projection from the canonical
 * tables once per workspace; user content is never rewritten.
 */
function migrateSearchIndex(connection: DatabaseSync): void {
  try {
    const rows = connection
      .prepare(
        `SELECT workspace_id, version FROM (
           SELECT id AS workspace_id FROM workspaces
           UNION SELECT workspace_id FROM search_index
           UNION SELECT workspace_id FROM evidence
           UNION SELECT workspace_id FROM notes
           UNION SELECT workspace_id FROM wiki_pages
         ) ids LEFT JOIN search_index_meta meta USING (workspace_id)`
      )
      .all() as Array<{ workspace_id: string; version: number | null }>
    // Compare for equality, not just "older": a snapshot written by a newer
    // build (or a half-reverted experiment) must also be rebuilt, otherwise the
    // index keeps content that no longer matches the current write path.
    const stale = rows.filter((row) => row.version !== SEARCH_INDEX_VERSION)
    if (stale.length === 0) return
    connection.exec('BEGIN IMMEDIATE')
    try {
      for (const row of stale) rebuildSearchIndex(connection, row.workspace_id)
      connection.exec('COMMIT')
    } catch (error) {
      connection.exec('ROLLBACK')
      throw error
    }
  } catch (error) {
    // Retrieval keeps working against the rows that are already indexed.
    console.error(
      `search index migrate failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function rebuildSearchIndex(connection: DatabaseSync, workspaceId: string): void {
  connection.prepare('DELETE FROM search_index WHERE workspace_id = ?').run(workspaceId)
  connection.prepare('DELETE FROM search_words WHERE workspace_id = ?').run(workspaceId)
  connection.prepare('DELETE FROM search_docs WHERE workspace_id = ?').run(workspaceId)
  const evidence = connection
    .prepare(
      `SELECT e.id AS id, s.title AS title, e.quote AS body
         FROM evidence e JOIN sources s ON s.id = e.source_id
        WHERE e.workspace_id = ? AND e.status = 'active' AND s.status = 'active'`
    )
    .all(workspaceId) as Array<{ id: string; title: string; body: string }>
  for (const row of evidence) writeSearchRow(connection, workspaceId, row.id, 'evidence', row.title, row.body)
  const notes = connection
    .prepare(`SELECT id, title, body FROM notes WHERE workspace_id = ? AND status = 'active'`)
    .all(workspaceId) as Array<{ id: string; title: string; body: string }>
  for (const row of notes) writeSearchRow(connection, workspaceId, row.id, 'note', row.title, row.body)
  const wiki = connection
    .prepare(`SELECT id, title, body FROM wiki_pages WHERE workspace_id = ? AND status = 'published'`)
    .all(workspaceId) as Array<{ id: string; title: string; body: string }>
  for (const row of wiki) writeSearchRow(connection, workspaceId, row.id, 'wiki', row.title, row.body)
  connection
    .prepare(
      `INSERT INTO search_index_meta(workspace_id, version, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`
    )
    .run(workspaceId, SEARCH_INDEX_VERSION, Date.now())
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
  // New workspaces are indexed by the current code path, so they start current.
  // Existing workspaces were rebuilt by migrateSearchIndex() before this runs.
  db()
    .prepare(
      'INSERT OR IGNORE INTO search_index_meta(workspace_id, version, updated_at) VALUES (?, ?, ?)'
    )
    .run(id, SEARCH_INDEX_VERSION, now)
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

/**
 * The trigram tokenizer never spans whitespace, so "第 4 章" and "第4章" are
 * different text even though they mean the same thing. Chinese documents
 * routinely space out numerals around headings and units ("第 4 章", "20 秒")
 * while questions often do not, which leaves those three-character windows
 * unmatchable. Collapse that cosmetic spacing on both the index and the query.
 */
function normalizeCjkSpacing(text: string): string {
  return text
    .replace(/(?<=[\u3400-\u9fff])\s+(?=[0-9])/g, '')
    .replace(/(?<=[0-9])\s+(?=[\u3400-\u9fff])/g, '')
}

/**
 * Build an FTS5 MATCH expression. CJK text is tokenized by unicode61 as one
 * token per contiguous run, so a natural-language question never matches a
 * document verbatim. Split CJK runs into bigrams and OR them together (BM25
 * still ranks the best overlap first), while keeping ASCII identifiers and
 * numbers as strict AND terms so model codes and thresholds stay selective.
 */
function ftsQuery(query: string): string | null {
  const tokens = normalizeCjkSpacing(query).match(/[\p{L}\p{N}_-]+/gu) ?? []
  if (tokens.length === 0) return null
  // The index uses the FTS5 trigram tokenizer, so only substrings of three or
  // more characters can match. Natural-language questions are split into
  // overlapping trigrams and OR-ed; BM25 ranks documents by how many of them
  // they contain.
  const grams: string[] = []
  for (const token of tokens) {
    const chars = [...token]
    if (chars.length < 3) continue
    for (let index = 0; index <= chars.length - 3; index += 1) {
      grams.push(chars.slice(index, index + 3).join(''))
    }
  }
  if (grams.length === 0) return null
  return [...new Set(grams)].map((gram) => `"${gram.replace(/"/g, '""')}"`).join(' OR ')
}

/**
 * Question words carry no retrieval signal but inflate the anchor match count,
 * which is why they are dropped from both the word channel and the literal
 * anchor scan.
 */
const ANCHOR_STOPWORDS = new Set([
  'a', 'about', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'being', 'between',
  'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'during', 'for', 'from', 'had', 'has',
  'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into',
  'is', 'it', 'its', 'me', 'might', 'more', 'most', 'must', 'my', 'no', 'nor', 'not', 'of',
  'off', 'on', 'or', 'our', 'ours', 'out', 'over', 'own', 'should', 'so', 'some', 'such',
  'than', 'that', 'the', 'their', 'theirs', 'them', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you',
  'your', 'yours'
])

/**
 * Chinese interrogatives survive the bigram expansion below ("多少" → 多少、
 * 少…) and match almost every page, so they are dropped before the literal
 * scan. Content bigrams are untouched.
 */
const CJK_STOPWORDS = new Set([
  '多少', '什么', '哪个', '哪些', '哪里', '为什么', '怎么', '如何', '是否', '可以', '能够',
  '我们', '他们', '这个', '那个', '以及', '还是', '或者', '因为', '所以', '如果', '需要',
  '进行', '一个', '没有', '现在', '已经', '自己', '这样', '那样', '时候', '问题', '办法'
])

/** Tokens that can be matched literally against the mirror table. */
function isClaimQuery(query: string): boolean {
  if (/[?？]/.test(query)) return false
  return !/^(how|what|which|who|whom|whose|when|where|why|is|are|was|were|does|do|did|can|could|should|would|will)\b/i.test(
    query.trim()
  )
}

function queryAnchors(query: string): string[] {
  return [...new Set((normalizeCjkSpacing(query).match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((token) => token.length >= 2))]
}

function wordStopwords(): boolean {
  return process.env.OPENFUTURE_WORD_STOPWORDS !== '0'
}

/** Words for the porter-tokenised word index; stopwords only hurt BM25. */
function wordTokens(query: string): string[] {
  const words = (query
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}_-]+/gu) ?? []).filter(
    (token) => token.length >= 2 && (!wordStopwords() || !ANCHOR_STOPWORDS.has(token))
  )
  return [...new Set(words)]
}

function wordMatchExpr(words: string[]): string | null {
  if (words.length === 0) return null
  return words.map((word) => `"${word.replace(/"/g, '""')}"`).join(' OR ')
}

function wordsQuery(query: string): string | null {
  return wordMatchExpr(wordTokens(query))
}

function hasCjk(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text)
}

/**
 * Pseudo-relevance feedback: words that the best lexical hits share but the
 * question does not mention are usually domain terms from the same answer.
 * They are fused as a small extra list, never used on CJK questions where the
 * seed documents' stray English identifiers drift the ranking.
 */
function prfTerms(query: string, texts: string[], max: number): string[] {
  const known = new Set(wordTokens(query))
  const counts = new Map<string, number>()
  for (const text of texts) {
    const seen = new Set<string>()
    for (const word of wordTokens(text)) {
      if (known.has(word) || seen.has(word)) continue
      if (word.length < 3 || /^[0-9]+$/.test(word)) continue
      seen.add(word)
      counts.set(word, (counts.get(word) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1])
    .slice(0, max)
    .map(([word]) => word)
}

/** Window of a document around the first query term, so reranking can be cheap. */
function rerankText(text: string, query: string, chars: number): string {
  if (chars <= 0 || text.length <= chars) return text
  const lower = text.toLowerCase()
  const term = wordTokens(query).sort((left, right) => right.length - left.length)[0]
  const at = term ? lower.indexOf(term) : -1
  const start = at > 0 ? Math.max(0, at - Math.floor(chars / 3)) : 0
  return text.slice(start, start + chars)
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

interface VectorEntry {
  kind: MemoryHitKind
  id: string
  title: string
  body: string
  vector: Float32Array
}

let vectorGeneration = 0
const vectorCache = new Map<string, { generation: number; entries: VectorEntry[] }>()
let semanticGeneration = 0
const semanticCache = new Map<string, { generation: number; entries: VectorEntry[] }>()
const semanticIndexing = new Map<string, Promise<void>>()

function removeSearchDocument(connection: DatabaseSync, docId: string): void {
  const rows = connection.prepare('SELECT row_id FROM search_docs WHERE doc_id = ?').all(docId) as Array<{
    row_id: number
  }>
  for (const row of rows) {
    connection.prepare('DELETE FROM search_index WHERE rowid = ?').run(row.row_id)
    connection.prepare('DELETE FROM search_words WHERE rowid = ?').run(row.row_id)
  }
  connection.prepare('DELETE FROM search_docs WHERE doc_id = ?').run(docId)
}

function writeSearchRow(
  connection: DatabaseSync,
  workspaceId: string,
  docId: string,
  kind: MemoryHitKind,
  title: string,
  body: string
): void {
  // The plain mirror table keeps the FTS rowid so deleting a document is an
  // O(1) rowid delete instead of a full scan of UNINDEXED columns (which took
  // minutes on an 8k-document corpus).
  removeSearchDocument(connection, docId)
  const titleText = normalizeCjkSpacing(title)
  const bodyText = normalizeCjkSpacing(body)
  const info = connection
    .prepare(
      'INSERT INTO search_docs(doc_id, workspace_id, kind, title, body, text_lower) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(docId, workspaceId, kind, titleText, bodyText, `${titleText}\n${bodyText}`.toLowerCase())
  const rowId = Number(info.lastInsertRowid)
  connection
    .prepare('INSERT INTO search_index(rowid, workspace_id, doc_id, kind, title, body) VALUES (?, ?, ?, ?, ?, ?)')
    .run(rowId, workspaceId, docId, kind, titleText, bodyText)
  connection
    .prepare('INSERT INTO search_words(rowid, workspace_id, doc_id, kind, title, body) VALUES (?, ?, ?, ?, ?, ?)')
    .run(rowId, workspaceId, docId, kind, titleText, bodyText)
  vectorGeneration += 1
}

function indexDoc(workspaceId: string, docId: string, kind: MemoryHitKind, title: string, body: string): void {
  writeSearchRow(db(), workspaceId, docId, kind, title, body)
}

function unindexDoc(docId: string): void {
  removeSearchDocument(db(), docId)
  vectorGeneration += 1
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
  const reviewDiff = row.status === 'draft' && row.slug === PROJECT_TOPIC_DRAFT_SLUG
    ? renderUnifiedDiff(diffLines(projectTopic(row.workspace_id)?.body ?? '', row.body))
    : undefined
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    status: row.status === 'revoked' ? 'revoked' : row.status === 'published' ? 'published' : 'draft',
    revision: row.revision,
    body: row.body,
    sourceIds,
    stale: sourceIds.some((id) => sourceRevoked(id)),
    reviewDiff,
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

/**
 * Batch variant of `loadHit`: the fused candidate list can hold ~100 keys and
 * one prepared query per key dominated the tail of `search`. Fetching each
 * kind with a single `IN (…)` keeps the semantics identical and cuts the
 * per-key round trip.
 */
function loadHits(
  workspaceId: string,
  keys: Array<{ kind: MemoryHitKind; id: string }>,
  query: string
): Map<string, MemorySearchHit> {
  const hits = new Map<string, MemorySearchHit>()
  const groups = new Map<MemoryHitKind, string[]>()
  for (const key of keys) {
    const list = groups.get(key.kind) ?? []
    list.push(key.id)
    groups.set(key.kind, list)
  }
  const batch = (ids: string[]): string[][] => {
    const chunks: string[][] = []
    for (let index = 0; index < ids.length; index += 400) chunks.push(ids.slice(index, index + 400))
    return chunks
  }
  for (const [kind, ids] of groups) {
    for (const chunk of batch([...new Set(ids)])) {
      const placeholders = chunk.map(() => '?').join(', ')
      if (kind === 'evidence') {
        const rows = db()
          .prepare(
            `SELECT e.*, s.title AS source_title, s.origin AS source_origin
             FROM evidence e JOIN sources s ON s.id = e.source_id
             WHERE e.workspace_id = ? AND e.status = 'active' AND s.status = 'active'
               AND e.id IN (${placeholders})`
          )
          .all(workspaceId, ...chunk) as Array<EvidenceRow & { source_title: string; source_origin: string }>
        for (const row of rows) {
          hits.set(`evidence:${row.id}`, {
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
          })
        }
      } else if (kind === 'note') {
        const rows = db()
          .prepare(`SELECT * FROM notes WHERE workspace_id = ? AND status = 'active' AND id IN (${placeholders})`)
          .all(workspaceId, ...chunk) as NoteRow[]
        for (const row of rows) {
          if (!noteIsLive(workspaceId, row.id, row.revision)) continue
          hits.set(`note:${row.id}`, {
            id: row.id,
            kind,
            title: row.title,
            excerpt: excerpt(row.body, query),
            citation: { label: `L1 笔记 · ${row.title}`, noteId: row.id },
            score: 1
          })
        }
      } else {
        const rows = db()
          .prepare(
            `SELECT * FROM wiki_pages WHERE workspace_id = ? AND status = 'published' AND id IN (${placeholders})`
          )
          .all(workspaceId, ...chunk) as WikiRow[]
        for (const row of rows) {
          const page = wikiDto(row)
          if (page.stale) continue
          hits.set(`wiki:${row.id}`, {
            id: row.id,
            kind,
            title: row.title,
            excerpt: excerpt(row.body, query),
            citation: { label: `Wiki · ${row.title}`, wikiId: row.id },
            score: 1
          })
        }
      }
    }
  }
  return hits
}

/** Batch `documentText` for the fused candidate list (one query per 400 ids). */
function documentTexts(workspaceId: string, ids: string[]): Map<string, string> {
  const texts = new Map<string, string>()
  const unique = [...new Set(ids)]
  for (let index = 0; index < unique.length; index += 400) {
    const chunk = unique.slice(index, index + 400)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = db()
      .prepare(`SELECT doc_id, body FROM search_docs WHERE workspace_id = ? AND doc_id IN (${placeholders})`)
      .all(workspaceId, ...chunk) as Array<{ doc_id: string; body: string }>
    for (const row of rows) texts.set(row.doc_id, row.body)
  }
  return texts
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
    const rows = await searchQmdRows(store, workspaceId, query, Math.max(limit * 2, 10))
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
    if (!qmdHybridRunning.has(workspaceId)) qmdStores.delete(workspaceId)
    return { hits: [], ok: false, error: qmdLastError }
  }
}

/**
 * Dense channel: hashed character/word n-grams over the FTS projection. The
 * cache is rebuilt lazily after any index mutation, so revocation and imports
 * stay consistent without a schema migration.
 */
function vectorEntries(workspaceId: string, kinds: MemoryHitKind[]): VectorEntry[] {
  const cached = vectorCache.get(workspaceId)
  if (cached && cached.generation === vectorGeneration) return cached.entries
  const rows = db()
    .prepare('SELECT doc_id, kind, title, body FROM search_index WHERE workspace_id = ?')
    .all(workspaceId) as Array<{ doc_id: string; kind: string; title: string; body: string }>
  const entries: VectorEntry[] = []
  for (const row of rows) {
    const kind = row.kind as MemoryHitKind
    if (!kinds.includes(kind)) continue
    entries.push({
      kind,
      id: row.doc_id,
      title: row.title,
      body: row.body,
      vector: hashEmbedding(`${row.title}\n${row.body}`)
    })
  }
  vectorCache.set(workspaceId, { generation: vectorGeneration, entries })
  return entries
}

/**
 * Embeddings computed for the current document set. Returns null when the model
 * is not loaded or the index is still being built, so callers can fall back to
 * hashed vectors instead of blocking the query for minutes.
 */
/**
 * Read the persisted vectors of a workspace together with their document text.
 *
 * The document text lives in the FTS5 `search_index` table whose columns are
 * all UNINDEXED: joining it row by row degrades to a full table scan per row
 * (on the 8k medical corpus that froze the utility process for minutes). The
 * plain `search_docs` mirror is read once and merged in memory instead.
 */
function readSemanticEntries(workspaceId: string): VectorEntry[] {
  const rows = db()
    .prepare(
      `SELECT d.kind AS kind, d.doc_id AS id, v.vector AS vector
         FROM semantic_docs d
         JOIN semantic_vectors v ON v.hash = d.hash
        WHERE d.workspace_id = ? AND v.model = ?`
    )
    .all(workspaceId, EMBED_MODEL) as Array<{ kind: string; id: string; vector: Uint8Array }>
  if (rows.length === 0) return []
  const documents = db()
    .prepare('SELECT doc_id, kind, title, body FROM search_docs WHERE workspace_id = ?')
    .all(workspaceId) as Array<{ doc_id: string; kind: string; title: string; body: string }>
  const meta = new Map<string, { title: string; body: string }>()
  for (const document of documents) {
    meta.set(`${document.kind}:${document.doc_id}`, { title: document.title, body: document.body })
  }
  const entries: VectorEntry[] = []
  for (const row of rows) {
    const document = meta.get(`${row.kind}:${row.id}`)
    if (!document) continue
    const bytes = Buffer.from(row.vector)
    entries.push({
      kind: row.kind as MemoryHitKind,
      id: row.id,
      title: document.title,
      body: document.body,
      vector: new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    })
  }
  return entries
}

function loadSemanticCache(workspaceId: string): void {
  const cached = semanticCache.get(workspaceId)
  if (cached && cached.generation === semanticGeneration) return
  const entries = readSemanticEntries(workspaceId)
  if (entries.length === 0) return
  semanticCache.set(workspaceId, { generation: semanticGeneration, entries })
}

function semanticEntries(workspaceId: string, kinds: MemoryHitKind[]): VectorEntry[] | null {
  if (!modelsReady().embedder) return null
  loadSemanticCache(workspaceId)
  const cached = semanticCache.get(workspaceId)
  if (!cached || cached.generation !== semanticGeneration) return null
  return cached.entries.filter((entry) => kinds.includes(entry.kind))
}

/**
 * Compute embeddings for every indexed document of a workspace and persist them
 * by content hash. Import calls this per batch, so the first RAG query finds a
 * warm index instead of paying the whole cost inside the request.
 */
function ensureSemanticIndex(workspaceId: string): Promise<void> {
  const running = semanticIndexing.get(workspaceId)
  if (running) return running
  const task = (async () => {
    const rows = db()
      .prepare('SELECT doc_id, kind, title, body FROM search_docs WHERE workspace_id = ?')
      .all(workspaceId) as Array<{ doc_id: string; kind: string; title: string; body: string }>
    if (rows.length === 0) return
    const payload = new Map<string, { kind: MemoryHitKind; docId: string; text: string }>()
    for (const row of rows) {
      payload.set(sha256(`${row.title}\n${row.body}`), {
        kind: row.kind as MemoryHitKind,
        docId: row.doc_id,
        text: `${row.title}\n${row.body}`
      })
    }
    const known = new Set(
      (db().prepare('SELECT hash FROM semantic_vectors WHERE model = ?').all(EMBED_MODEL) as Array<{ hash: string }>).map(
        (row) => row.hash
      )
    )
    const missing = [...payload.entries()].filter(([hash]) => !known.has(hash))
    const insertVector = db().prepare(
      'INSERT OR REPLACE INTO semantic_vectors(hash, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    const insertDoc = db().prepare(
      'INSERT OR REPLACE INTO semantic_docs(workspace_id, hash, kind, doc_id) VALUES (?, ?, ?, ?)'
    )
    for (let offset = 0; offset < missing.length; offset += 16) {
      const batch = missing.slice(offset, offset + 16)
      const vectors = await embedTexts(batch.map(([, item]) => item.text))
      vectors.forEach((vector, index) => {
        const [hash, item] = batch[index]!
        insertVector.run(hash, EMBED_MODEL, vector.length, Buffer.from(vector.buffer), Date.now())
        insertDoc.run(workspaceId, hash, item.kind, item.docId)
      })
    }
    semanticGeneration += 1
    const entries = readSemanticEntries(workspaceId)
    semanticCache.set(workspaceId, { generation: semanticGeneration, entries })
    console.log(`[semantic] index ready: ${entries.length} docs (${missing.length} new embeddings)`)
  })()
    .catch((error) => {
      console.error('[memory] semantic indexing failed:', error)
    })
    .finally(() => {
      semanticIndexing.delete(workspaceId)
    })
  semanticIndexing.set(workspaceId, task)
  return task
}

async function denseHits(
  workspaceId: string,
  query: string,
  limit: number,
  kinds: MemoryHitKind[],
  instruction = false
): Promise<MemorySearchHit[]> {
  if (RETRIEVAL_MODE === 'lexical') return []
  const semantic = semanticEntries(workspaceId, kinds)
  let entries = semantic ?? vectorEntries(workspaceId, kinds)
  if (entries.length === 0) return []
  let queryVector: Float32Array | null = null
  if (semantic) {
    queryVector = await embedQuery(query, instruction)
    if (!queryVector) entries = vectorEntries(workspaceId, kinds)
  }
  const effective = queryVector ?? hashEmbedding(query)
  const scored = entries
    .map((entry) => ({ entry, score: cosine(effective, entry.vector) }))
    .filter((item) => item.score > (queryVector ? 0.3 : 0.02))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(limit, 10))
  const hits: MemorySearchHit[] = []
  for (const item of scored) {
    const hit = loadHit(workspaceId, item.entry.kind, item.entry.id, query)
    if (!hit) continue
    hit.engine = 'hybrid'
    hit.score = item.score
    hits.push(hit)
  }
  return hits
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
  const started = SEARCH_PROFILE ? performance.now() : 0
  let previous = started
  const mark = (label: string): void => {
    if (!SEARCH_PROFILE) return
    const now = performance.now()
    console.log(`[profile] ${label} ${(now - previous).toFixed(0)}ms`)
    previous = now
  }
  const wikiEngine: MemoryWikiEngine = wikiConfigured(workspaceId) ? 'mcp' : 'off'
  if (kinds.length === 0) return { hits: [], engine: 'fts5', wikiEngine }
  const kindPlaceholders = kinds.map(() => '?').join(', ')
  // Candidate pool size fed into RRF. Larger pools help long documents but add
  // FTS work per query.
  const rawCandidateScale = Number(process.env.OPENFUTURE_CANDIDATE_SCALE ?? '2')
  const candidateScale = Number.isFinite(rawCandidateScale) && rawCandidateScale >= 1 ? Math.floor(rawCandidateScale) : 2
  const rawTitleBoost = Number(process.env.OPENFUTURE_TITLE_BOOST ?? '1')
  const titleBoost = Number.isFinite(rawTitleBoost) && rawTitleBoost >= 0 ? rawTitleBoost : 1
  const seen = new Set<string>()
  const hits: MemorySearchHit[] = []
  const wordHits: MemorySearchHit[] = []

  const push = (kind: MemoryHitKind, id: string, rank: number): void => {
    if (seen.has(id) || hits.length >= limit) return
    const hit = loadHit(workspaceId, kind, id, query)
    if (!hit) return
    seen.add(id)
    hit.score = Math.max(0, -rank)
    hits.push(hit)
  }

  // Identifiers, numbers and ordinary keywords are resolved literally against
  // the plain mirror table: SQLite's instr() over 8k rows is ~1s cheaper than
  // touching the FTS index for every token, and the match count ranks rows.
  const anchorWeight = (() => {
    const configured = Number(process.env.OPENFUTURE_ANCHOR_WEIGHT ?? '')
    // 0 is meaningful: it disables the literal-anchor list entirely.
    if (Number.isFinite(configured) && configured >= 0 && process.env.OPENFUTURE_ANCHOR_WEIGHT) return configured
    if (hasCjk(query)) return 0.8
    // Claim-style queries are statements, not questions: literal anchors mostly
    // amplify incidental word overlap there (SciFact: disabling them measured +3 nDCG).
    if (isClaimQuery(query)) return 0
    return 0.45
  })()
  const anchors = queryAnchors(query)
    .map((anchor) => anchor.toLowerCase())
    .filter((anchor) => !ANCHOR_STOPWORDS.has(anchor))
    .flatMap((anchor) =>
      // A Chinese sentence arrives as one long token, which almost never occurs
      // verbatim in a document. Overlapping bigrams turn it into a bag of
      // phrases ("服务", "默认", "阈值", …) that still ranks by shared content.
      /[\u3400-\u9fff]/.test(anchor) && anchor.length > 2
        ? Array.from({ length: anchor.length - 1 }, (_, index) => anchor.slice(index, index + 2))
        : [anchor]
    )
    .filter((anchor) => !CJK_STOPWORDS.has(anchor))
    .filter((anchor, index, list) => list.indexOf(anchor) === index)
    .sort((left, right) => right.length - left.length)
    .slice(0, 32)
  if (anchors.length > 0 && anchorWeight > 0) {
    const terms: string[] = []
    const clauses: string[] = []
    for (const anchor of anchors) {
      if (/^[0-9]+$/.test(anchor) && !hasCjk(query)) {
        // English text isolates numbers with spaces; the padded form keeps "20"
        // from matching "200".
        clauses.push(`instr(' ' || replace(text_lower, char(10), ' ') || ' ', ?) > 0`)
        terms.push(` ${anchor} `)
      } else {
        // CJK glues the number to its unit ("10秒"), so plain substring wins.
        clauses.push('instr(text_lower, ?) > 0')
        terms.push(anchor)
      }
    }
    try {
      const rows = db()
        .prepare(
          `SELECT doc_id, kind, (${clauses.map((clause) => `CASE WHEN ${clause} THEN 1 ELSE 0 END`).join(' + ')}) AS matched
             FROM search_docs
            WHERE workspace_id = ? AND kind IN (${kindPlaceholders})
            ORDER BY matched DESC
            LIMIT ?`
        )
        .all(...terms, workspaceId, ...kinds, limit * candidateScale) as Array<{
        doc_id: string
        kind: string
        matched: number
      }>
      for (const row of rows) {
        if (row.matched <= 0) continue
        push(row.kind as MemoryHitKind, row.doc_id, 0)
        if (hits.length >= limit) break
      }
    } catch {
      // Anchor matching is an optimisation; the word index still serves the query.
    }
  }
  mark('anchors')

  const wordMatch = wordsQuery(query)
  if (wordMatch) {
    try {
      const rows = db()
        .prepare(
          `SELECT doc_id, kind, bm25(search_words, 0, 0, 0, ${titleBoost}, 1) AS rank
             FROM search_words
            WHERE search_words MATCH ? AND workspace_id = ? AND kind IN (${kindPlaceholders})
            ORDER BY rank
            LIMIT ?`
        )
        .all(wordMatch, workspaceId, ...kinds, limit * candidateScale) as Array<{
        doc_id: string
        kind: string
        rank: number
      }>
      const wordSeen = new Set<string>()
      for (const row of rows) {
        const key = `${row.kind}:${row.doc_id}`
        if (wordSeen.has(key)) continue
        wordSeen.add(key)
        const hit = loadHit(workspaceId, row.kind as MemoryHitKind, row.doc_id, query)
        if (!hit) continue
        hit.engine = 'fts5'
        wordHits.push(hit)
      }
    } catch {
      // Ignore word-index errors: the trigram list still serves the query.
    }
  }
  mark('words')

  // Chinese questions cannot match English vocabulary at all. Translate a few
  // high-value terms from a curated glossary and run them through the porter
  // index: this is the only lexical bridge from zh questions to en corpora.
  const bilingualTerms = hasCjk(query) ? bilingualQueryTerms(query) : []
  const bilingualHits: MemorySearchHit[] = []
  if (bilingualTerms.length > 0 && process.env.OPENFUTURE_BILINGUAL !== '0') {
    try {
      const rows = db()
        .prepare(
          `SELECT doc_id, kind, bm25(search_words) AS rank
             FROM search_words
            WHERE search_words MATCH ? AND workspace_id = ? AND kind IN (${kindPlaceholders})
            ORDER BY rank
            LIMIT ?`
        )
        .all(wordMatchExpr(bilingualTerms), workspaceId, ...kinds, limit) as Array<{
        doc_id: string
        kind: string
        rank: number
      }>
      const bilingualSeen = new Set<string>()
      for (const row of rows) {
        const key = `${row.kind}:${row.doc_id}`
        if (bilingualSeen.has(key)) continue
        bilingualSeen.add(key)
        const hit = loadHit(workspaceId, row.kind as MemoryHitKind, row.doc_id, query)
        if (!hit) continue
        hit.engine = 'fts5'
        bilingualHits.push(hit)
      }
    } catch {
      // Expansion is best-effort; the original query still runs.
    }
  }

  // Scientific claims frequently name a concept by abbreviation while the
  // abstract spells it out (or the reverse). Add those expansions as a small
  // extra BM25 list; it is off by default and only fires on English claims.
  const synonymList = !hasCjk(query) && isClaimQuery(query) ? synonymTerms(query) : []
  const synonymHits: MemorySearchHit[] = []
  const synonymWeight = Number(process.env.OPENFUTURE_SYNONYM_WEIGHT ?? '0') || 0
  if (synonymList.length > 0 && synonymWeight > 0) {
    try {
      const rows = db()
        .prepare(
          `SELECT doc_id, kind, bm25(search_words) AS rank
             FROM search_words
            WHERE search_words MATCH ? AND workspace_id = ? AND kind IN (${kindPlaceholders})
            ORDER BY rank
            LIMIT ?`
        )
        .all(wordMatchExpr(synonymList), workspaceId, ...kinds, limit) as Array<{
        doc_id: string
        kind: string
        rank: number
      }>
      const synonymSeen = new Set<string>()
      for (const row of rows) {
        const key = `${row.kind}:${row.doc_id}`
        if (synonymSeen.has(key)) continue
        synonymSeen.add(key)
        const hit = loadHit(workspaceId, row.kind as MemoryHitKind, row.doc_id, query)
        if (!hit) continue
        hit.engine = 'fts5'
        synonymHits.push(hit)
      }
    } catch {
      // Synonym expansion is best-effort.
    }
  }

  // The trigram channel is a rescue path: on English, porter BM25 ranks far
  // better, and fusing both would let a mediocre trigram candidate outrank a
  // strong word match simply by appearing in two lists. Use it for CJK (which
  // the porter tokenizer cannot see) or when the word index found little.
  // CJK always keeps the trigram channel: the word index sees a Chinese run as
  // one opaque token and otherwise drowns the ranking in number/title matches.
  const trigramMatch = hasCjk(query) || !(wordMatch && wordHits.length >= 3) ? ftsQuery(query) : null
  if (trigramMatch && query.trim().length >= 3) {
    try {
      const rows = db()
        .prepare(
          `SELECT doc_id, kind, bm25(search_index) AS rank
             FROM search_index
            WHERE search_index MATCH ? AND workspace_id = ? AND kind IN (${kindPlaceholders})
            ORDER BY rank
            LIMIT ?`
        )
        .all(trigramMatch, workspaceId, ...kinds, limit * 2) as Array<{ doc_id: string; kind: string; rank: number }>
      for (const row of rows) push(row.kind as MemoryHitKind, row.doc_id, row.rank)
    } catch {
      // The trigram index is an optimisation; the word index still answers.
    }
  }
  mark('trigram')

  if (hits.length === 0 && wordHits.length === 0) {
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

  let wikiNote: string | undefined
  let wikiHits: MemorySearchHit[] = []
  if (wikiConfigured(workspaceId) && kinds.includes('wiki')) {
    const wiki = await searchWiki(workspaceId, query, limit)
    if (wiki.ok) {
      wikiHits = wiki.hits
    } else if (wiki.error) {
      wikiNote = `pi-llm-wiki 暂不可用：${wiki.error}`
    }
  }

  const documentText = (kind: MemoryHitKind, id: string, fallback: string): string => {
    const row = db()
      .prepare('SELECT title, body FROM search_docs WHERE workspace_id = ? AND doc_id = ? LIMIT 1')
      .get(workspaceId, id) as { title?: string; body?: string } | undefined
    return row ? `${row.title ?? ''}\n${row.body ?? ''}` : fallback
  }

  // Cross-lingual queries (glossary fired) are embedded without the bge query
  // instruction; same-language CJK queries benefit from it (+0.3 nDCG synthetic).
  const translateQuery = bilingualHits.length > 0
  const dense =
    RETRIEVAL_MODE === 'lexical'
      ? []
      : await denseHits(workspaceId, query, Math.max(limit * 3, 20), kinds, !translateQuery)
  if (SEARCH_PROFILE) {
    console.log(
      `[profile] anchors=${hits.length} words=${wordHits.length} bilingual=${bilingualHits.length} dense=${dense.length} mode=${RETRIEVAL_MODE} dtop=${dense.slice(0, 3).map((hit) => hit.id).join(',')}`
    )
  }
  mark('dense')
  // Without a reranker, fusing a fuzzy channel with BM25 can push a correct
  // BM25 top hit below a document that merely appears in both lists. Keep the
  // lexical order and treat dense hits as a rescue channel in that mode.
  const crossLingualQuery = bilingualHits.length > 0 && process.env.OPENFUTURE_ADAPTIVE_RERANK !== '0'
  const lexicalKeys = new Set([...hits, ...wordHits].map((hit) => `${hit.kind}:${hit.id}`))
  const denseItems =
    RETRIEVAL_MODE === 'hybrid' || crossLingualQuery
      ? dense.filter((hit) => !lexicalKeys.has(`${hit.kind}:${hit.id}`))
      : dense
  const lists: RankedList[] = [
    {
      // Chinese questions arrive as one opaque run, so the literal-anchor list is
      // the main lexical channel there; English relies on BM25 and only needs a
      // light anchor signal.
      weight: anchorWeight,
      items: hits.map((hit) => ({ kind: hit.kind, id: hit.id }))
    },
    {
      // Word matches beat trigram overlap on English questions, so they carry
      // slightly more weight in the fusion.
      weight: Number(process.env.OPENFUTURE_WORD_WEIGHT ?? '1.4') || 1.4,
      items: wordHits.map((hit) => ({ kind: hit.kind, id: hit.id }))
    },
    {
      // Translated terms are strong evidence but only fill a lexicon gap: keep
      // them below the native word channel.
      weight: Number(process.env.OPENFUTURE_BILINGUAL_WEIGHT ?? '1.2') || 1.2,
      items: bilingualHits.map((hit) => ({ kind: hit.kind, id: hit.id }))
    },
    {
      // Abbreviation expansions are a precision hazard (a short token can match
      // many abstracts), so the weight stays low and is off unless configured.
      weight: synonymWeight,
      items: synonymHits.map((hit) => ({ kind: hit.kind, id: hit.id }))
    },
    {
      // The semantic channel is fuzzy: give it less authority than BM25.
      weight: Number(process.env.OPENFUTURE_DENSE_WEIGHT ?? '0.9') || 0.9,
      items: denseItems.map((hit) => ({ kind: hit.kind, id: hit.id }))
    },
    { weight: 1.1, items: qmdHits.map((hit) => ({ kind: hit.kind, id: hit.id })) },
    { weight: 0.8, items: wikiHits.map((hit) => ({ kind: hit.kind, id: hit.id })) }
  ].filter((list) => list.items.length > 0)
  const rawRrfK = Number(process.env.OPENFUTURE_RRF_K ?? '20')
  const rrfK = Number.isFinite(rawRrfK) && rawRrfK >= 1 ? rawRrfK : 60
  let fused = reciprocalRankFusion(lists, rrfK)
  mark('fuse')

  // Questions profit from stronger PRF; claim sentences (SciFact) pick up noise
  // from extra terms, so they use a lower default (1.0/0.5 measured best).
  const rawPrf = Number(process.env.OPENFUTURE_PRF ?? (isClaimQuery(query) ? '0.5' : '1.0'))
  if (Number.isFinite(rawPrf) && rawPrf > 0 && !hasCjk(query)) {
    try {
      const seeds = [...fused.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3)
        .map(([key]) => key)
      const texts = seeds
        .map((key) => {
          const separator = key.indexOf(':')
          return documentText(key.slice(0, separator) as MemoryHitKind, key.slice(separator + 1), '')
        })
        .filter((text) => text.length > 0)
      const maxTerms = Number(process.env.OPENFUTURE_PRF_TERMS ?? '6') || 6
      const expr = wordMatchExpr(prfTerms(query, texts, maxTerms))
      if (expr) {
        const rows = db()
          .prepare(
            `SELECT doc_id, kind, bm25(search_words) AS rank
               FROM search_words
              WHERE search_words MATCH ? AND workspace_id = ? AND kind IN (${kindPlaceholders})
              ORDER BY rank
              LIMIT ?`
          )
          .all(expr, workspaceId, ...kinds, limit) as Array<{ doc_id: string; kind: string; rank: number }>
        const prfHits: MemorySearchHit[] = []
        for (const row of rows) {
          const hit = loadHit(workspaceId, row.kind as MemoryHitKind, row.doc_id, query)
          if (hit) prfHits.push(hit)
        }
        if (prfHits.length > 0) {
          fused = reciprocalRankFusion(
            [...lists, { weight: rawPrf, items: prfHits.map((hit) => ({ kind: hit.kind, id: hit.id })) }],
            rrfK
          )
        }
      }
    } catch {
      // Feedback is best-effort; the first-pass fusion already ranks.
    }
  }
  mark('prf')

  // Phrase proximity list: documents where query term pairs appear adjacently
  // rank above documents that merely contain the same terms scattered around.
  // Only the current head is rescored, so the extra cost stays small.
  // Sweeps: English questions like adjacency (0.1 is best on TREC: 0.7580→
  // 0.7652), but scientific claims (SciFact 0.7093→0.7072) and Chinese
  // queries (project/synthetic unchanged) do not, so the default only fires
  // for English questions; the env var still overrides it.
  const phraseDefault = isClaimQuery(query) || hasCjk(query) ? 0 : 0.1
  const rawPhrase = Number(process.env.OPENFUTURE_PHRASE_WEIGHT ?? String(phraseDefault))
  if (Number.isFinite(rawPhrase) && rawPhrase > 0) {
    try {
      const contentTokens = wordTokens(query)
      const bigrams =
        contentTokens.length >= 2
          ? contentTokens.slice(0, -1).map((token, index) => `${token} ${contentTokens[index + 1]}`)
          : []
      if (bigrams.length > 0) {
        const head = [...fused.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 24)
        const scored: Array<{ key: string; score: number }> = []
        for (const [key] of head) {
          const separator = key.indexOf(':')
          const kind = key.slice(0, separator) as MemoryHitKind
          const id = key.slice(separator + 1)
          const text = documentText(kind, id, '').toLowerCase()
          if (!text) continue
          let matched = 0
          for (const bigram of bigrams) if (text.includes(bigram)) matched += 1
          if (matched > 0) scored.push({ key, score: matched / bigrams.length })
        }
        if (scored.length > 0) {
          scored.sort((left, right) => right.score - left.score)
          fused = reciprocalRankFusion(
            [
              ...lists,
              {
                weight: rawPhrase,
                items: scored.map((entry) => {
                  const separator = entry.key.indexOf(':')
                  return { kind: entry.key.slice(0, separator) as MemoryHitKind, id: entry.key.slice(separator + 1) }
                })
              }
            ],
            rrfK
          )
        }
      }
    } catch {
      // Proximity is a refinement; the previous fusion stays valid.
    }
  }
  mark('phrase')

  const fusedKeys = [...fused.entries()].map(([key, score]) => {
    const separator = key.indexOf(':')
    return { key, kind: key.slice(0, separator) as MemoryHitKind, id: key.slice(separator + 1), score }
  })
  const loaded = loadHits(
    workspaceId,
    fusedKeys.map((entry) => ({ kind: entry.kind, id: entry.id })),
    query
  )
  const refs = fusedKeys
    .map((entry) => {
      const hit = loaded.get(entry.key)
      return hit ? { hit, score: entry.score } : null
    })
    .filter((item): item is { hit: MemorySearchHit; score: number } => item !== null)

  const maxRrf = refs.length > 0 ? Math.max(...refs.map((item) => item.score)) : 1
  const rerankCharsRaw = Number(process.env.OPENFUTURE_RERANK_CHARS ?? '480')
  const rerankChars = Number.isFinite(rerankCharsRaw) && rerankCharsRaw >= 0 ? Math.floor(rerankCharsRaw) : 480
  const rerankRequested = process.env.OPENFUTURE_RERANK === 'model' || process.env.OPENFUTURE_RERANK === 'on'
  const rerankTopRaw = Number(process.env.OPENFUTURE_RERANK_TOP ?? '5')
  const rerankTop = Number.isFinite(rerankTopRaw) && rerankTopRaw >= 0 ? Math.floor(rerankTopRaw) : 5
  const rerankWeightRaw = Number(process.env.OPENFUTURE_RERANK_WEIGHT ?? '0.3')
  const rerankWeight = Number.isFinite(rerankWeightRaw) ? Math.min(1, Math.max(0, rerankWeightRaw)) : 0.3
  // A trained cross-encoder is opt-in: on the 8k medical corpus it costs seconds
  // per query and often only reorders the head that the lexical channels
  // already ranked well.
  // Only the head is blended, so scoring the tail is wasted CPU: score exactly
  // the refs that can move. `rerankTop = 0` keeps the historical full scan.
  const rerankCount = rerankTop > 0 ? Math.min(refs.length, rerankTop) : Math.min(refs.length, 20)
  const semanticScores =
    rerankRequested && refs.length > 0 && modelsReady().reranker
      ? await rerankScores(
          query,
          refs
            .slice(0, rerankCount)
            .map((item) => rerankText(documentText(item.hit.kind, item.hit.id, item.hit.title), query, rerankChars))
        )
      : null
  let merged: MemorySearchHit[]
  if (semanticScores && semanticScores.length === rerankCount) {
    const maxSemantic = Math.max(1e-6, ...semanticScores)
    const headCount = rerankTop > 0 ? Math.min(rerankTop, refs.length) : refs.length
    const scored = refs.map((item, index) => ({
      item,
      semantic: index < semanticScores.length ? (semanticScores[index] ?? 0) : 0
    }))
    const head = scored
      .slice(0, headCount)
      .map((entry) => ({
        ...entry,
        final: (entry.semantic / maxSemantic) * rerankWeight + (entry.item.score / maxRrf) * (1 - rerankWeight)
      }))
      .sort((left, right) => right.final - left.final)
    const tail = scored.slice(headCount).map((entry) => ({ ...entry, final: (entry.item.score / maxRrf) * (1 - rerankWeight) }))
    merged = [...head, ...tail].map((entry) => ({ ...entry.item.hit, score: entry.final }))
  } else if (
    RETRIEVAL_MODE === 'hybrid-rerank' &&
    refs.length > 0 &&
    // A translated query is a cross-lingual probe: word-overlap reranking has
    // nothing to score on (the Chinese tokens hardly appear in English docs)
    // and reorders the translated BM25 list badly. Keep plain RRF in that case.
    !(bilingualHits.length > 0 && process.env.OPENFUTURE_ADAPTIVE_RERANK !== '0')
  ) {
    const bodies = documentTexts(workspaceId, refs.map((item) => item.hit.id))
    const rescored = refs.map((item) => ({
      ...item,
      rerank: rerankScore(query, {
        title: item.hit.title,
        body: bodies.get(item.hit.id) ?? documentText(item.hit.kind, item.hit.id, item.hit.title)
      })
    }))
    const maxRerank = Math.max(1e-6, ...rescored.map((item) => item.rerank))
    // Weight of the lexical-overlap reranker against the fused RRF score.
    // English questions prefer 0.5 (TREC 0.7469→0.7652 once phrase scoring is
    // on), short scientific claims prefer 0.15 (SciFact 0.7093→0.7333: a heavy
    // overlap boost over-ranks claims that repeat a few query words) and
    // Chinese document questions keep 0.6 (project 0.8929 at 0.5–0.58 vs
    // 0.9175 at 0.6). The env var still overrides every branch.
    const heuristicRaw = Number(process.env.OPENFUTURE_HEURISTIC_WEIGHT ?? NaN)
    const heuristicBase = Number.isFinite(heuristicRaw)
      ? heuristicRaw
      : hasCjk(query)
        ? 0.6
        : isClaimQuery(query)
          ? 0.15
          : 0.5
    const heuristic = Math.min(1, Math.max(0, heuristicBase))
    rescored.sort((a, b) => {
      const left = (a.rerank / maxRerank) * heuristic + (a.score / maxRrf) * (1 - heuristic)
      const right = (b.rerank / maxRerank) * heuristic + (b.score / maxRrf) * (1 - heuristic)
      return right - left
    })
    merged = rescored.map((item) => ({ ...item.hit, score: item.rerank }))
  } else {
    merged = refs.sort((a, b) => b.score - a.score).map((item) => ({ ...item.hit, score: item.score }))
  }
  mark('merged')

  // One source can be split into many chunks; without a cap the same document
  // occupies several of the top slots and hides the other answer candidates.
  const maxPerSourceRaw = Number(process.env.OPENFUTURE_MAX_PER_SOURCE ?? '1')
  const maxPerSource = Number.isFinite(maxPerSourceRaw) && maxPerSourceRaw >= 0 ? Math.floor(maxPerSourceRaw) : 1
  const counts = new Map<string, number>()
  const deduped: MemorySearchHit[] = []
  for (const hit of merged) {
    const title = hit.title.trim().toLowerCase()
    const used = title ? counts.get(title) ?? 0 : 0
    if (title && maxPerSource > 0 && used >= maxPerSource) continue
    if (title) counts.set(title, used + 1)
    deduped.push(hit)
    if (deduped.length >= limit) break
  }
  merged = deduped

  if (RETRIEVAL_MODE !== 'lexical' && (dense.length > 0 || qmdHits.length > 0 || wikiHits.length > 0)) {
    engine = 'hybrid'
  }
  return { hits: merged, engine, engineNote, wikiEngine, wikiNote }
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))
  return sorted[index] ?? 0
}

function metricsFor(workspaceId: string): MemoryMetrics {
  const total = db()
    .prepare('SELECT COUNT(*) AS count FROM retrieval_events WHERE workspace_id = ?')
    .get(workspaceId) as { count: number }
  const rows = db()
    .prepare('SELECT query, hits, top_score, duration_ms, at, engine FROM retrieval_events WHERE workspace_id = ? ORDER BY at DESC LIMIT 200')
    .all(workspaceId) as Array<{ query: string; hits: number; top_score: number; duration_ms: number; at: number; engine: string }>
  const durations = rows.map((row) => row.duration_ms)
  const hitCount = rows.filter((row) => row.hits > 0).length
  return {
    searches: total.count,
    hitRate: rows.length > 0 ? hitCount / rows.length : 0,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    lastSearchAt: rows[0]?.at ?? null,
    recent: rows.slice(0, 8).map((row) => ({
      query: row.query,
      hits: row.hits,
      topScore: Number(row.top_score.toFixed(3)),
      durationMs: row.duration_ms,
      at: row.at,
      engine: row.engine as MemorySearchEngine
    }))
  }
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
    searchEngine: QMD_MODULE_PATH ? 'qmd' : RETRIEVAL_MODE === 'lexical' ? 'fts5' : 'hybrid',
    wikiEngine: wikiConfigured(workspaceId) ? 'mcp' : 'off',
    indexedDocCount: count('SELECT COUNT(*) AS count FROM search_index WHERE workspace_id = ?', workspaceId),
    semanticDocCount: count(
      `SELECT COUNT(*) AS count FROM semantic_docs d
         JOIN semantic_vectors v ON v.hash = d.hash
        WHERE d.workspace_id = ? AND v.model = ?`,
      workspaceId,
      EMBED_MODEL
    ),
    semanticReady: modelsReady().embedder,
    rerankerReady: modelsReady().reranker,
    qualityRerank: process.env.OPENFUTURE_RERANK === 'model' || process.env.OPENFUTURE_RERANK === 'on',
    embeddingModel: EMBED_MODEL,
    rerankerModel: RERANK_MODEL
  }
}

function listSources(workspaceId: string): MemorySource[] {
  const rows = db()
    .prepare('SELECT * FROM sources WHERE workspace_id = ? ORDER BY created_at DESC')
    .all(workspaceId) as SourceRow[]
  return rows.map(sourceDto)
}

async function parsePdfPages(bytes: Buffer, title: string): Promise<ReturnType<typeof parsePdfBuffer>['pages']> {
  const python = process.env.OPENFUTURE_DOCLING_PYTHON?.trim()
  if (python && isAbsolute(python)) {
    const bundled = process.resourcesPath && join(process.resourcesPath, 'openfuture-docling', 'worker.py')
    const worker = bundled && existsSync(bundled) ? bundled : resolve(__dirname, '../../parallel/rag/src/docling/worker.py')
    const staging = await mkdtemp(join(memoryDir, 'docling-'))
    try {
      const file = join(staging, 'source.pdf')
      await writeFile(file, bytes)
      const { document } = await runDocling(file, title, { python, worker, timeoutMs: 22_000, hybridChunking: false })
      if (document.pages.length > 0 && document.pages.every((page, i) =>
        page.page === i + 1 && typeof page.text === 'string' &&
        ['required', 'performed', 'not-needed'].includes(page.ocr)
      ) && document.pages.some((page) => page.text.trim())) return document.pages
    } catch {
      // The local text parser remains available when the optional worker fails.
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  return parsePdfBuffer(bytes, title).pages
}

async function importSource(params: Record<string, unknown>): Promise<MemorySource> {
  const workspace = requireWorkspace(params)
  const title = optionalString(params, 'title', 240)?.trim() || '未命名资料'
  const origin = optionalString(params, 'origin', 2_000)?.trim() || `paste:${Date.now()}`
  const kind = optionalString(params, 'kind', 40)?.trim() || 'markdown'
  let content: string
  let chunks: Array<{ quote: string; locator: string }>
  if (kind === 'pdf' && params.pdfBase64 !== undefined) {
    const encoded = stringParam(params, 'pdfBase64', Math.ceil(MAX_SOURCE_BYTES / 3) * 4)
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length > MAX_SOURCE_BYTES) throw new RpcError('VALIDATION', 'PDF 超过 2 MB 上限')
    let pages: ReturnType<typeof parsePdfBuffer>['pages']
    try {
      pages = await parsePdfPages(bytes, title)
    } catch {
      throw new RpcError('VALIDATION', '无法解析此 PDF。请使用有文本层的标准 PDF，或先转换为文本。')
    }
    if (pages.some((page) => page.ocr === 'required')) {
      throw new RpcError('VALIDATION', '此 PDF 包含需要 OCR 的扫描页。请先识别文字，再重新导入。')
    }
    content = pages.map((page) => page.text).join('\n\n')
    chunks = pages.flatMap((page) => chunkText(page.text).map((chunk) => ({
      quote: chunk.quote,
      locator: `page:${page.page}:chars:${chunk.start}-${chunk.end}`
    })))
  } else {
    content = stringParam(params, 'content', MAX_SOURCE_BYTES)
    chunks = chunkText(content).map((chunk) => ({
      quote: chunk.quote,
      locator: `chars:${chunk.start}-${chunk.end}`
    }))
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_SOURCE_BYTES) {
    throw new RpcError('VALIDATION', '资料超过 2 MB 上限')
  }
  if (!content.trim()) throw new RpcError('VALIDATION', '资料内容为空')
  const hash = sha256(content)
  if (chunks.length === 0) throw new RpcError('VALIDATION', '资料没有可索引的文本')

  const source = tx(() => {
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
          chunk.locator,
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
  // Index embeddings in the background so import stays inside the RPC budget.
  // Tests that need a warm index set OPENFUTURE_SEMANTIC_WAIT=1 and pay for the
  // first model download explicitly.
  const indexSemantics = async (): Promise<void> => {
    await warmEmbedder()
    await ensureSemanticIndex(workspace.id)
  }
  void indexSemantics().catch((error) => console.error('[memory] semantic indexing skipped:', error))
  // Reranking is opt-in (OPENFUTURE_RERANK=model|on); otherwise never fetch its 280 MB weights.
  if (process.env.OPENFUTURE_RERANK === 'model' || process.env.OPENFUTURE_RERANK === 'on') {
    void warmReranker().catch((error) => console.error('[semantic] reranker warmup failed:', error))
  }
  return source
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
  let tokens = estimateTokens(lines.join('\n\n## 资料来源\n'))
  for (const entry of notes) {
    const line = `- **${entry.title}**：${entry.body}`
    const nextBytes = bytes + Buffer.byteLength(line, 'utf8') + 1
    const nextTokens = tokens + estimateTokens(line)
    if (lines.length >= L3_MAX_LINES - 6 || nextBytes > L3_MAX_BYTES ||
        Math.ceil(nextBytes / 4) > L3_TOKEN_BUDGET || nextTokens > L3_TOKEN_BUDGET) break
    lines.push(line)
    bytes = nextBytes
    tokens = nextTokens
  }
  lines.push('', '## 资料来源', '')
  for (const entry of sources) {
    const line = `- ${entry.title} — ${entry.body}`
    const nextBytes = bytes + Buffer.byteLength(line, 'utf8') + 1
    const nextTokens = tokens + estimateTokens(line)
    if (lines.length >= L3_MAX_LINES || nextBytes > L3_MAX_BYTES ||
        Math.ceil(nextBytes / 4) > L3_TOKEN_BUDGET || nextTokens > L3_TOKEN_BUDGET) break
    lines.push(line)
    bytes = nextBytes
    tokens = nextTokens
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
  const l3Tokens = Math.max(Math.ceil(l3Bytes / 4), estimateTokens(content))
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

const PROJECT_TOPIC_SLUG = 'topic-project-knowledge'
const PROJECT_TOPIC_DRAFT_SLUG = PROJECT_TOPIC_SLUG + '-draft'

function projectTopic(workspaceId: string): WikiRow | undefined {
  return db().prepare('SELECT * FROM wiki_pages WHERE workspace_id = ? AND slug = ?')
    .get(workspaceId, PROJECT_TOPIC_SLUG) as WikiRow | undefined
}

function generateWiki(params: Record<string, unknown>): WikiPage[] {
  const workspace = requireWorkspace(params)
  const requested = Array.isArray(params.sourceIds) ? [...new Set(params.sourceIds)] : []
  if (requested.length > 12 || requested.some((id) => typeof id !== 'string')) {
    throw new RpcError('VALIDATION', '请选择至多 12 份有效资料')
  }
  const rows = db().prepare("SELECT * FROM sources WHERE workspace_id = ? AND status = 'active' ORDER BY created_at DESC, id ASC")
    .all(workspace.id) as SourceRow[]
  const selected = requested.length ? rows.filter((row) => requested.includes(row.id)) : rows.slice(0, 12)
  if (!selected.length || (requested.length && selected.length !== requested.length)) {
    throw new RpcError('VALIDATION', '选择的资料不存在、已撤销或不属于当前项目')
  }
  const title = '项目知识综述'
  const compiled = compileTopic({
    topic: { id: PROJECT_TOPIC_SLUG, title, projectId: workspace.id },
    sources: selected.map((source) => ({
      logicalId: source.id,
      packetId: source.id,
      revision: String(source.revision),
      title: source.title,
      text: source.body
    }))
  })
  if (!compiled.evidenceCount) throw new RpcError('VALIDATION', '所选资料没有可引用的文本')
  const previous = projectTopic(workspace.id)
  const draft = db().prepare('SELECT * FROM wiki_pages WHERE workspace_id = ? AND slug = ?')
    .get(workspace.id, PROJECT_TOPIC_DRAFT_SLUG) as WikiRow | undefined
  const revision = Math.max(previous?.revision ?? 0, draft?.revision ?? 0) + 1
  const id = draft?.id ?? 'wiki-' + randomUUID()
  const now = Date.now()
  db().prepare(
    `INSERT INTO wiki_pages(id, workspace_id, slug, title, body, revision, status, source_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body,
       revision = excluded.revision, status = 'draft', source_ids = excluded.source_ids,
       revoked_at = NULL, updated_at = excluded.updated_at`
  ).run(id, workspace.id, PROJECT_TOPIC_DRAFT_SLUG, title, compiled.body, revision,
    JSON.stringify(selected.map((source) => source.id)), now, now)
  return [wikiDto(db().prepare('SELECT * FROM wiki_pages WHERE id = ?').get(id) as WikiRow)]
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
  if (row.status !== 'draft' || params.revision !== row.revision) {
    throw new RpcError('VALIDATION', 'Wiki 草稿已经变更，请刷新后重新审核')
  }
  const sourceIds = parseStringArray(row.source_ids)
  if (sourceIds.length === 0) throw new RpcError('VALIDATION', 'Wiki 页面没有来源，不能发布')
  if (sourceIds.some((sourceId) => sourceRevoked(sourceId))) {
    throw new RpcError('VALIDATION', '页面来源已撤销，请重新生成草稿')
  }
  const now = Date.now()
  const revision = row.revision + 1
  return tx(() => {
    let publishedId = id
    if (row.slug === PROJECT_TOPIC_DRAFT_SLUG) {
      const previous = projectTopic(workspace.id)
      if (previous) {
        publishedId = previous.id
        db().prepare("UPDATE wiki_pages SET title = ?, body = ?, source_ids = ?, status = 'published', revision = ?, revoked_at = NULL, updated_at = ? WHERE id = ?")
          .run(row.title, row.body, row.source_ids, revision, now, publishedId)
        db().prepare('DELETE FROM wiki_pages WHERE id = ?').run(id)
      } else {
        db().prepare("UPDATE wiki_pages SET slug = ?, status = 'published', revision = ?, updated_at = ? WHERE id = ?")
          .run(PROJECT_TOPIC_SLUG, revision, now, id)
      }
    } else {
      db().prepare("UPDATE wiki_pages SET status = 'published', revision = ?, updated_at = ? WHERE id = ?")
        .run(revision, now, id)
    }
    db()
      .prepare('INSERT INTO wiki_versions(id, page_id, revision, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`wv-${randomUUID()}`, publishedId, revision, row.title, row.body, now)
    indexDoc(workspace.id, publishedId, 'wiki', row.title, row.body)
    bumpRevision(workspace.id)
    return wikiDto(db().prepare('SELECT * FROM wiki_pages WHERE id = ?').get(publishedId) as WikiRow)
  })
}

function revokeWiki(params: Record<string, unknown>): void {
  const workspace = requireWorkspace(params)
  const id = stringParam(params, 'id', 200)
  const now = Date.now()
  tx(() => {
    if (projectTopic(workspace.id)?.id === id) {
      db().prepare("UPDATE wiki_pages SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE workspace_id = ? AND slug = ? AND status = 'draft'")
        .run(now, now, workspace.id, PROJECT_TOPIC_DRAFT_SLUG)
    }
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

const GRAPH_DEFAULT_NODES = 320
const GRAPH_MIN_NODES = 60
const GRAPH_MAX_NODES = 600
const GRAPH_HASH_DIM = 192
const GRAPH_SOURCE_CAP = 140
const GRAPH_KINDS = new Set(['note', 'evidence', 'wiki', 'source'])

interface GraphSourceMeta {
  title: string
  createdAt: number
}

interface GraphWorkspace {
  id: string
  name: string
  root: string
}

interface GraphEvidenceSeed {
  key: string
  sourceId: string
  sourceKey: string | null
}

interface GraphWikiSeed {
  key: string
  sourceIds: string[]
}

function clampGraphNodes(value: unknown): number {
  return Math.min(
    GRAPH_MAX_NODES,
    Math.max(
      GRAPH_MIN_NODES,
      typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : GRAPH_DEFAULT_NODES
    )
  )
}

/** Persisted embeddings for one workspace, keyed `kind:docId`. */
function semanticVectorMap(workspaceId: string): Map<string, Float32Array> {
  const rows = db()
    .prepare(
      `SELECT d.kind AS kind, d.doc_id AS id, v.vector AS vector
         FROM semantic_docs d
         JOIN semantic_vectors v ON v.hash = d.hash
        WHERE d.workspace_id = ? AND v.model = ?`
    )
    .all(workspaceId, EMBED_MODEL) as Array<{ kind: string; id: string; vector: Uint8Array }>
  const map = new Map<string, Float32Array>()
  for (const row of rows) {
    const bytes = Buffer.from(row.vector)
    if (bytes.byteLength < 4) continue
    map.set(
      `${row.kind}:${row.id}`,
      new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    )
  }
  return map
}

/** Active workspaces in scope; `all` merges every project the main process knows. */
function graphWorkspaces(params: Record<string, unknown>, scope: 'workspace' | 'all'): GraphWorkspace[] {
  const current = requireWorkspace(params)
  const currentName = basename(current.root) || current.root
  if (scope === 'workspace') return [{ id: current.id, name: currentName, root: current.root }]
  const items: GraphWorkspace[] = [{ id: current.id, name: currentName, root: current.root }]
  const seen = new Set([current.id])
  const projects = Array.isArray(params.projects) ? params.projects : []
  for (const entry of projects) {
    if (!entry || typeof entry !== 'object') continue
    const root = (entry as { root?: unknown }).root
    const label = (entry as { name?: unknown }).name
    if (typeof root !== 'string' || root.length === 0) continue
    if (!existsSync(root)) continue
    const workspace = ensureWorkspace(root)
    if (seen.has(workspace.id)) continue
    seen.add(workspace.id)
    items.push({
      id: workspace.id,
      name: typeof label === 'string' && label.trim().length > 0 ? label.trim() : basename(workspace.root),
      root: workspace.root
    })
  }
  return items
}

function graphFor(params: Record<string, unknown>): KnowledgeGraph {
  const scope: 'workspace' | 'all' = optionalString(params, 'scope', 20) === 'all' ? 'all' : 'workspace'
  const workspaces = graphWorkspaces(params, scope)
  const maxNodes = clampGraphNodes(params.maxNodes)
  const rawKinds = Array.isArray(params.kinds) ? params.kinds : undefined
  const kinds = new Set<string>()
  if (rawKinds) {
    for (const kind of rawKinds) if (typeof kind === 'string' && GRAPH_KINDS.has(kind)) kinds.add(kind)
    if (kinds.size === 0) kinds.add('note')
  } else {
    kinds.add('note')
    kinds.add('evidence')
    kinds.add('wiki')
    kinds.add('source')
  }
  const requestedSimilarity =
    typeof params.minSimilarity === 'number' && Number.isFinite(params.minSimilarity)
      ? Math.min(1, Math.max(0, params.minSimilarity))
      : undefined
  const perWorkspace = Math.max(50, Math.floor(maxNodes / workspaces.length))
  const noteQuota = Math.max(12, Math.round(perWorkspace * 0.42))
  const wikiQuota = Math.max(8, Math.round(perWorkspace * 0.22))
  const evidenceQuota = Math.max(16, perWorkspace - noteQuota - wikiQuota)
  const docs: GraphDoc[] = []
  const structural: GraphStructuralEdge[] = []
  const evidenceSeeds: GraphEvidenceSeed[] = []
  const wikiSeeds: GraphWikiSeed[] = []
  const sourceMeta = new Map<string, GraphSourceMeta>()
  const sourceRefs = new Set<string>()
  let semanticCount = 0
  let totalDocs = 0
  let emptyWorkspaces = 0
  for (const workspace of workspaces) {
    const prefix = `${workspace.id}:`
    const semantic = semanticVectorMap(workspace.id)
    let workspaceDocs = 0
    const workspaceEvidenceIds = new Set<string>()
    if (kinds.has('source')) {
      const rows = db()
        .prepare(
          `SELECT id, title, created_at FROM sources
            WHERE workspace_id = ? AND status = 'active'
            ORDER BY created_at DESC LIMIT 800`
        )
        .all(workspace.id) as Array<{ id: string; title: string; created_at: number }>
      for (const row of rows) {
        sourceMeta.set(`${prefix}source:${row.id}`, { title: row.title, createdAt: row.created_at })
      }
    }
    if (kinds.has('note')) {
      const rows = db()
        .prepare(
          `SELECT id, type, title, body, created_at FROM notes
            WHERE workspace_id = ? AND status = 'active'
            ORDER BY updated_at DESC LIMIT ?`
        )
        .all(workspace.id, noteQuota) as Array<{
        id: string
        type: string
        title: string
        body: string
        created_at: number
      }>
      for (const row of rows) {
        const key = `${prefix}note:${row.id}`
        const vector = semantic.get(`note:${row.id}`) ?? null
        if (vector) semanticCount += 1
        docs.push({
          key,
          id: row.id,
          kind: 'note',
          title: row.title || '未命名笔记',
          body: row.body,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          noteType: row.type as MemoryNoteType,
          createdAt: row.created_at,
          vector
        })
        workspaceDocs += 1
      }
    }
    if (kinds.has('wiki')) {
      const rows = db()
        .prepare(
          `SELECT id, title, body, source_ids, created_at FROM wiki_pages
            WHERE workspace_id = ? AND status = 'published'
            ORDER BY updated_at DESC LIMIT ?`
        )
        .all(workspace.id, wikiQuota) as Array<{
        id: string
        title: string
        body: string
        source_ids: string | null
        created_at: number
      }>
      for (const row of rows) {
        const key = `${prefix}wiki:${row.id}`
        const vector = semantic.get(`wiki:${row.id}`) ?? null
        if (vector) semanticCount += 1
        docs.push({
          key,
          id: row.id,
          kind: 'wiki',
          title: row.title || '未命名 Wiki',
          body: row.body,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          createdAt: row.created_at,
          vector
        })
        wikiSeeds.push({ key, sourceIds: parseStringArray(row.source_ids ?? '') })
        workspaceDocs += 1
      }
    }
    if (kinds.has('evidence')) {
      const rows = db()
        .prepare(
          `SELECT e.id AS id, e.source_id AS source_id, s.title AS source_title,
                  e.quote AS body, e.created_at AS created_at
             FROM evidence e
             JOIN sources s ON s.id = e.source_id
            WHERE e.workspace_id = ? AND e.status = 'active' AND s.status = 'active'
            ORDER BY e.created_at DESC LIMIT ?`
        )
        .all(workspace.id, evidenceQuota) as Array<{
        id: string
        source_id: string
        source_title: string
        body: string
        created_at: number
      }>
      for (const row of rows) {
        const key = `${prefix}evidence:${row.id}`
        const vector = semantic.get(`evidence:${row.id}`) ?? null
        if (vector) semanticCount += 1
        workspaceEvidenceIds.add(row.id)
        docs.push({
          key,
          id: row.id,
          kind: 'evidence',
          title: row.source_title || '未命名资料',
          body: row.body,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          createdAt: row.created_at,
          vector
        })
        if (kinds.has('source')) sourceRefs.add(`${prefix}source:${row.source_id}`)
        evidenceSeeds.push({
          key,
          sourceId: row.source_id,
          sourceKey: kinds.has('source') ? `${prefix}source:${row.source_id}` : null
        })
        workspaceDocs += 1
      }
    }
    for (const seed of wikiSeeds) {
      if (!seed.key.startsWith(prefix)) continue
      for (const id of seed.sourceIds) {
        const sourceKey = `${prefix}source:${id}`
        if (sourceMeta.has(sourceKey)) {
          sourceRefs.add(sourceKey)
          structural.push({ source: seed.key, target: sourceKey, kind: 'cites' })
          continue
        }
        if (workspaceEvidenceIds.has(id)) {
          structural.push({ source: seed.key, target: `${prefix}evidence:${id}`, kind: 'cites' })
        }
      }
    }
    const counts = db()
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM notes WHERE workspace_id = ? AND status = 'active') AS notes,
           (SELECT COUNT(*) FROM evidence e JOIN sources s ON s.id = e.source_id
             WHERE e.workspace_id = ? AND e.status = 'active' AND s.status = 'active') AS evidence,
           (SELECT COUNT(*) FROM wiki_pages WHERE workspace_id = ? AND status = 'published') AS wiki`
      )
      .get(workspace.id, workspace.id, workspace.id) as { notes: number; evidence: number; wiki: number }
    totalDocs +=
      (kinds.has('note') ? counts.notes : 0) +
      (kinds.has('wiki') ? counts.wiki : 0) +
      (kinds.has('evidence') ? counts.evidence : 0)
    if (workspaceDocs === 0) emptyWorkspaces += 1
  }
  const kindRank: Record<string, number> = { note: 0, wiki: 1, evidence: 2, source: 3 }
  const selectedDocs = docs
    .sort(
      (a, b) =>
        (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9) ||
        b.createdAt - a.createdAt ||
        a.key.localeCompare(b.key)
    )
    .slice(0, maxNodes)
  const sourceNodes: GraphDoc[] = []
  if (kinds.has('source')) {
    const referenced = [...sourceRefs].filter((key) => sourceMeta.has(key))
    const rankedSources = (referenced.length > 0 ? referenced : [...sourceMeta.keys()])
      .filter((key) => sourceMeta.has(key))
      .map((key) => ({ key, meta: sourceMeta.get(key) as GraphSourceMeta }))
      .sort((a, b) => b.meta.createdAt - a.meta.createdAt || a.key.localeCompare(b.key))
      .slice(0, Math.min(GRAPH_SOURCE_CAP, Math.max(40, Math.round(maxNodes * 0.25))))
    for (const { key, meta } of rankedSources) {
      const parts = key.split(':')
      const workspaceId = parts[0] ?? ''
      const id = parts.slice(2).join(':')
      const owner = workspaces.find((workspace) => workspace.id === workspaceId)
      sourceNodes.push({
        key,
        id,
        kind: 'source',
        title: meta.title || '未命名资料',
        body: '',
        workspaceId,
        workspaceName: owner?.name ?? '',
        createdAt: meta.createdAt,
        vector: null
      })
    }
  }
  const allDocs = [...selectedDocs, ...sourceNodes]
  const knownKeys = new Set(allDocs.map((doc) => doc.key))
  for (const seed of evidenceSeeds) {
    if (!knownKeys.has(seed.key) || !seed.sourceKey || !knownKeys.has(seed.sourceKey)) continue
    structural.push({ source: seed.key, target: seed.sourceKey, kind: 'source' })
  }
  if (selectedDocs.some((doc) => doc.kind === 'note')) {
    for (const workspace of workspaces) {
      const rows = db()
        .prepare(
          `SELECT ne.note_id AS note_id, ne.evidence_id AS evidence_id
             FROM note_evidence ne
             JOIN notes n ON n.id = ne.note_id AND n.revision = ne.revision AND n.workspace_id = ne.workspace_id
            WHERE ne.workspace_id = ? AND n.status = 'active'`
        )
        .all(workspace.id) as Array<{ note_id: string; evidence_id: string }>
      for (const row of rows) {
        const noteKey = `${workspace.id}:note:${row.note_id}`
        const evidenceKey = `${workspace.id}:evidence:${row.evidence_id}`
        if (!knownKeys.has(noteKey) || !knownKeys.has(evidenceKey)) continue
        structural.push({ source: noteKey, target: evidenceKey, kind: 'evidence' })
      }
    }
  }
  const seenEdges = new Set<string>()
  const uniqueStructural = structural.filter((edge) => {
    const pair =
      edge.source < edge.target ? `${edge.source}|${edge.target}` : `${edge.target}|${edge.source}`
    if (seenEdges.has(pair)) return false
    seenEdges.add(pair)
    return true
  })
  const space: 'semantic' | 'hashed' = semanticCount > 0 ? 'semantic' : 'hashed'
  if (semanticCount === 0) {
    for (const doc of allDocs) {
      if (doc.kind === 'source') continue
      doc.vector = hashEmbedding(`${doc.title}\n${doc.body}`, GRAPH_HASH_DIM)
    }
  }
  const dim = allDocs.find((doc) => doc.vector !== null)?.vector?.length ?? GRAPH_HASH_DIM
  const model = space === 'semantic' ? EMBED_MODEL : `hash-${GRAPH_HASH_DIM}`
  const hints: string[] = []
  if (space === 'hashed' && allDocs.some((doc) => doc.kind !== 'source')) {
    hints.push('语义向量索引尚未就绪，当前方位来自本地哈希向量（近似）。可在「总览」里执行一次向量化。')
  }
  if (totalDocs > selectedDocs.length) {
    hints.push(`共 ${totalDocs} 份素材，星图按活跃度保留了 ${selectedDocs.length} 个文档节点。`)
  }
  if (scope === 'all' && emptyWorkspaces > 0 && selectedDocs.length > 0) {
    hints.push(`${emptyWorkspaces} 个知识库还没有可展示的记忆素材。`)
  }
  return buildConstellation(allDocs, uniqueStructural, {
    scope,
    maxNodes,
    minSimilarity: requestedSimilarity,
    space,
    dim,
    model,
    totalDocs,
    truncated: totalDocs > selectedDocs.length,
    notes: hints
  })
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
  metrics: (params) => {
    const workspace = requireWorkspace(params)
    return metricsFor(workspace.id)
  },
  embedPending: (params) => {
    const workspace = requireWorkspace(params)
    const indexed = db()
      .prepare('SELECT COUNT(*) AS count FROM search_index WHERE workspace_id = ?')
      .get(workspace.id) as { count: number }
    const embedded = db()
      .prepare(
        `SELECT COUNT(*) AS count FROM semantic_docs d
           JOIN semantic_vectors v ON v.hash = d.hash
          WHERE d.workspace_id = ? AND v.model = ?`
      )
      .get(workspace.id, EMBED_MODEL) as { count: number }
    const pending = Math.max(0, indexed.count - embedded.count)
    if (pending > 0) {
      void ensureSemanticIndex(workspace.id).then(
        () => console.log('[semantic] manual embedding finished'),
        (error) => console.error('[semantic] manual embedding failed:', error)
      )
    }
    return { pending, started: pending > 0 }
  },
  setRerank: async (params) => {
    const enabled = params.enabled === true
    process.env.OPENFUTURE_RERANK = enabled ? 'model' : 'heuristic'
    if (enabled) await warmReranker()
    return { enabled, rerankerReady: modelsReady().reranker }
  },
  revokeSource,
  graph: (params) => graphFor(params),
  search: async (params) => {
    const workspace = requireWorkspace(params)
    const query = stringParam(params, 'query', 500).trim()
    const limitRaw = params.limit
    const limit = Math.min(
      Math.max(typeof limitRaw === 'number' && Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 10, 1),
      MAX_SEARCH_RESULTS
    )
    const mode = getMode(workspace.id)
    const startedAt = Date.now()
    const result = await searchMemory(workspace.id, mode, query, limit)
    const durationMs = Date.now() - startedAt
    try {
      db()
        .prepare(
          'INSERT INTO retrieval_events(workspace_id, at, query, hits, top_score, duration_ms, engine, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          workspace.id,
          startedAt,
          query.slice(0, 200),
          result.hits.length,
          result.hits[0]?.score ?? 0,
          durationMs,
          result.engine ?? (QMD_MODULE_PATH ? 'qmd' : 'fts5'),
          mode
        )
      db()
        .prepare(
          'DELETE FROM retrieval_events WHERE workspace_id = ? AND id NOT IN (SELECT id FROM retrieval_events WHERE workspace_id = ? ORDER BY at DESC LIMIT 500)'
        )
        .run(workspace.id, workspace.id)
    } catch (error) {
      console.error('[memory] failed to record retrieval event:', error)
    }
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

function warmSemanticCaches(): void {
  if (process.env.OPENFUTURE_SEMANTIC === '0') return
  try {
    const workspaces = db()
      .prepare('SELECT DISTINCT workspace_id FROM semantic_docs')
      .all() as Array<{ workspace_id: string }>
    // Always warm the embedder: a brand-new workspace has no semantic_docs
    // rows yet, but its first import/query still needs the model ready.
    void warmEmbedder()
      .then(() => {
        for (const row of workspaces) loadSemanticCache(row.workspace_id)
        console.log(`[semantic] warmed ${workspaces.length} workspace cache(s)`)
      })
      .catch((error) => console.error('[semantic] warmup failed:', error))
    const rerankRequested = process.env.OPENFUTURE_RERANK === 'model' || process.env.OPENFUTURE_RERANK === 'on'
    if (rerankRequested) {
      void warmReranker().catch((error) => console.error('[semantic] reranker warmup failed:', error))
    }
  } catch (error) {
    console.error('[semantic] warmup skipped:', error)
  }
}

(port as unknown as { start?: () => void }).start?.();
startAutoDreamTimer();
warmSemanticCaches();
