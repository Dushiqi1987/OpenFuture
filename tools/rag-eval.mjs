import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(import.meta.dirname, '..')
const CORPUS = join(ROOT, '.scratch', 'rag-corpus')
const USER_DATA = join(ROOT, '.scratch', 'rag-eval-userdata')
const OUT = join(ROOT, '.scratch', 'rag-eval')
const CDP_PORT = 9460
const RETRIEVAL = process.env.RETRIEVAL || 'hybrid-rerank'
const MODE = process.env.MODE || 'rag'
const SEED_WIKI = process.env.WIKI === '1'
const LABEL = [RETRIEVAL, MODE, SEED_WIKI ? 'seeded' : '', process.env.OPENFUTURE_QMD_MODULE ? 'qmd' : '']
  .filter(Boolean)
  .join('-')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const NODE = process.execPath

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const log = (line) => console.log(line)

function seed() {
  rmSync(USER_DATA, { recursive: true, force: true })
  mkdirSync(join(USER_DATA, 'config'), { recursive: true })
  writeFileSync(
    join(USER_DATA, 'config', 'settings.json'),
    JSON.stringify(
      {
        version: 1,
        workspace: CORPUS,
        model: null,
        allowPowerShell: false,
        computerUse: false,
        agentDesktop: false,
        contextCompression: false,
        subagents: false,
        subagentConcurrency: 1,
        groupChat: false
      },
      null,
      2
    )
  )
  writeFileSync(
    join(USER_DATA, 'config', 'projects.json'),
    JSON.stringify(
      {
        version: 1,
        activeProjectId: 'p-rag',
        projects: [
          {
            id: 'p-rag',
            name: 'rag-eval',
            canonicalRoot: CORPUS,
            memoryPreset: MODE,
            defaultModelRef: null,
            createdAt: 1_700_000_000_000,
            archivedAt: null,
            lastConversationId: 'c-rag'
          }
        ],
        conversations: [
          {
            id: 'c-rag',
            projectId: 'p-rag',
            title: 'RAG 评测',
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000
          }
        ]
      },
      null,
      2
    )
  )
}

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
  }
  async connect() {
    this.socket = new WebSocket(this.url)
    await new Promise((done, fail) => {
      this.socket.addEventListener('open', done, { once: true })
      this.socket.addEventListener('error', fail, { once: true })
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : '')
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.fail(new Error(message.error.message))
      else pending.done(message.result)
    })
    await this.send('Runtime.enable')
    return this
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((done, fail) => {
      this.pending.set(id, { done, fail })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed')
    return result.result?.value
  }
  async waitFor(expression, label, timeoutMs = 40_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await this.evaluate(expression)
      if (value) return value
      await sleep(250)
    }
    throw new Error(`timeout waiting for ${label}`)
  }
}

async function findTarget() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* devtools not listening yet */
    }
    await sleep(300)
  }
  throw new Error('no CDP page target')
}

let app = null
function shutdown() {
  try {
    app?.kill()
  } catch {
    /* already gone */
  }
}

function metric(results) {
  const ranked = (hits, gold) => {
    const flags = hits.map((hit) => (gold.some((name) => hit.title === name || hit.origin.endsWith(name)) ? 1 : 0))
    const first = flags.indexOf(1)
    const dcg = flags.reduce((sum, flag, index) => (flag ? sum + 1 / Math.log2(index + 2) : sum), 0)
    const ideal = Math.min(gold.length, 10)
    const idcg = Array.from({ length: ideal }, (_, index) => 1 / Math.log2(index + 2)).reduce((a, b) => a + b, 0)
    return {
      recall1: flags.slice(0, 1).some(Boolean) ? 1 : 0,
      recall5: flags.slice(0, 5).filter(Boolean).length / gold.length,
      recall10: flags.slice(0, 10).filter(Boolean).length / gold.length,
      mrr: first >= 0 ? 1 / (first + 1) : 0,
      ndcg10: idcg > 0 ? dcg / idcg : 0
    }
  }
  const groups = new Map()
  const all = []
  for (const row of results) {
    const value = ranked(row.hits, row.gold)
    const entry = { ...value, ms: row.ms }
    all.push(entry)
    if (!groups.has(row.type)) groups.set(row.type, [])
    groups.get(row.type).push(entry)
  }
  const summarize = (rows) => ({
    count: rows.length,
    recall1: rows.reduce((s, r) => s + r.recall1, 0) / rows.length,
    recall5: rows.reduce((s, r) => s + r.recall5, 0) / rows.length,
    recall10: rows.reduce((s, r) => s + r.recall10, 0) / rows.length,
    mrr: rows.reduce((s, r) => s + r.mrr, 0) / rows.length,
    ndcg10: rows.reduce((s, r) => s + r.ndcg10, 0) / rows.length,
    p50: percentile(rows.map((r) => r.ms), 0.5),
    p95: percentile(rows.map((r) => r.ms), 0.95)
  })
  return { overall: summarize(all), byType: Object.fromEntries([...groups].map(([type, rows]) => [type, summarize(rows)])) }
}

function percentile(values, q) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[index]
}

function normalizeCjkSpacing(text) {
  return text
    .replace(/(?<=[\u3400-\u9fff])\s+(?=[0-9])/g, '')
    .replace(/(?<=[0-9])\s+(?=[\u3400-\u9fff])/g, '')
}

/**
 * Seed published wiki pages straight into the isolated profile so the wiki
 * channel can be measured without an LLM. Titles stay identical to the corpus
 * file names so the gold matching in `metric()` applies unchanged; bodies are
 * the full Markdown documents, and the FTS rows mirror what publishWiki would
 * write (kind `wiki`, normalized text). The publish path itself is covered by
 * the app unit tests; this harness measures retrieval only.
 */
function seedWiki(docs) {
  const database = new DatabaseSync(join(USER_DATA, 'memory', 'memory.sqlite'))
  database.exec('PRAGMA busy_timeout = 15000')
  const workspace = database.prepare('SELECT id FROM workspaces LIMIT 1').get()
  if (!workspace) throw new Error('workspace missing for wiki seed')
  const now = Date.now()
  const page = database.prepare(
    `INSERT INTO wiki_pages(id, workspace_id, slug, title, body, revision, status, source_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 'published', '[]', ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, updated_at = excluded.updated_at`
  )
  const unindex = database.prepare('DELETE FROM search_index WHERE doc_id = ?')
  const index = database.prepare('INSERT INTO search_index(workspace_id, doc_id, kind, title, body) VALUES (?, ?, ?, ?, ?)')
  let seeded = 0
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const doc of docs) {
      const text = readFileSync(join(CORPUS, 'docs', doc.fileName), 'utf8')
      const id = `wiki-seed-${doc.fileName.replace(/\.md$/, '')}`
      page.run(id, workspace.id, id, doc.fileName, text, now, now)
      unindex.run(id)
      index.run(workspace.id, id, 'wiki', normalizeCjkSpacing(doc.fileName), normalizeCjkSpacing(text))
      seeded += 1
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  } finally {
    database.close()
  }
  log(`seeded -> ${seeded} wiki pages`)
}

async function main() {
  if (!existsSync(CORPUS)) throw new Error('run tools/rag-corpus.mjs first')
  const { docs, queries } = JSON.parse(readFileSync(join(CORPUS, 'queries.json'), 'utf8'))
  seed()
  mkdirSync(OUT, { recursive: true })

  const env = {
    ...process.env,
    OPENFUTURE_USER_DATA: USER_DATA,
    OPENFUTURE_RETRIEVAL_MODE: RETRIEVAL,
    OPENFUTURE_MODEL_DIR: join(ROOT, '.scratch', 'models'),
    OPENFUTURE_SEMANTIC_WAIT: '1',
    OPENFUTURE_RERANK: process.env.RERANK || 'model'
  }
  delete env.ELECTRON_RUN_AS_NODE
  app = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT,
    env,
    stdio: process.env.APP_LOG === '1' ? 'inherit' : 'ignore'
  })

  const cdp = await new Cdp(await findTarget()).connect()
  await cdp.waitFor(`typeof window.openfuture === 'object'`, 'preload', 40_000)

  log(`retrieval -> ${LABEL}`)
  const applyMode = () => cdp.evaluate(`window.openfuture.memorySetMode('${MODE}').then((r) => r.ok ? (r.value.mode + '@' + r.value.workspaceId) : ('ERR:' + r.error.message))`)
  let mode = await applyMode()
  for (let attempt = 0; attempt < 6 && !String(mode).startsWith(`${MODE}@`); attempt++) {
    await sleep(500)
    mode = await applyMode()
  }
  log(`mode -> ${mode}`)
  if (!String(mode).startsWith(`${MODE}@`)) throw new Error(`memory mode not applied: ${mode}`)

  const paths = docs.map((doc) => join(CORPUS, 'docs', doc.fileName))
  const importStarted = Date.now()
  const imported = await cdp.evaluate(
    `window.openfuture.memoryImportFiles({ paths: ${JSON.stringify(paths)} }).then((r) => r.ok ? r.value.length : ('ERR:' + r.error.message))`
  )
  const importMs = Date.now() - importStarted
  log(`imported -> ${imported} files in ${importMs}ms`)
  if (typeof imported !== 'number') throw new Error(`import failed: ${imported}`)
  if (SEED_WIKI) seedWiki(docs)
  // The reranker is loaded in the background to keep import inside the RPC
  // budget; give it time so every measured query uses the same pipeline.
  if (process.env.RERANK !== 'off') {
    log('waiting for the reranker to warm up')
    await new Promise((resolve) => setTimeout(resolve, 60_000))
  }

  const payload = JSON.stringify(
    process.env.QUERY_LIMIT ? queries.slice(0, Number(process.env.QUERY_LIMIT)) : queries
  )
  const rows = await cdp.evaluate(`(async () => {
    const data = ${payload}
    const out = []
    let engine = ''
    for (const q of data) {
      const started = performance.now()
      const result = await window.openfuture.memorySearch({ query: q.query, limit: 10 })
      const ms = performance.now() - started
      if (!result.ok) { out.push({ ...q, ms, hits: [], error: result.error.message }); continue }
      engine = result.value.engine || engine
      out.push({
        id: q.id,
        type: q.type,
        gold: q.gold,
        ms,
        hits: result.value.hits.map((hit) => ({
          kind: hit.kind,
          title: hit.citation?.sourceTitle || hit.title,
          origin: hit.citation?.origin || '',
          score: hit.score
        }))
      })
    }
    return { engine, rows: out }
  })()`)
  log(`engine -> ${rows.engine}`)
  if (process.env.DEBUG_HITS === '1') {
    log(JSON.stringify(rows.rows.slice(0, 3).map((row) => ({ id: row.id, hits: row.hits.slice(0, 5) })), null, 1))
  }

  const metrics = metric(rows.rows)
  const duplicates = rows.rows.reduce((sum, row) => {
    const titles = row.hits.map((hit) => hit.title)
    return sum + (titles.length > 0 ? (titles.length - new Set(titles).size) / titles.length : 0)
  }, 0) / Math.max(1, rows.rows.length)
  const report = {
    generatedAt: new Date().toISOString(),
    corpusDocs: docs.length,
    queries: queries.length,
    imported,
    importMs,
    engine: rows.engine,
    retrieval: RETRIEVAL,
    mode,
    wikiSeeded: SEED_WIKI,
    duplicateRate: duplicates,
    metrics
  }
  writeFileSync(join(OUT, `report-${LABEL}.json`), JSON.stringify(report, null, 2), 'utf8')

  const lines = [
    '# RAG 检索评测报告',
    '',
    `- 时间：${report.generatedAt}`,
    `- 语料：${docs.length} 个 Markdown 文件（10 主题 × 10 篇）`,
    `- 查询：${queries.length} 条（exact / value / compare / paraphrase）`,
    `- 导入：${imported} 份，耗时 ${importMs} ms`,
    `- 检索引擎：${rows.engine}，模式：${mode}，检索配置：${LABEL}`,
    `- Wiki 播种：${SEED_WIKI ? '是（100 篇，直接写入隔离 profile）' : '否'}，前 10 条重复标题占比：${(duplicates * 100).toFixed(1)}%`,
    '',
    '| 分组 | 查询数 | Recall@1 | Recall@5 | Recall@10 | MRR | nDCG@10 | p50 | p95 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  ]
  const fmt = (value) => `${(value * 100).toFixed(1)}%`
  for (const [type, group] of [['overall', metrics.overall], ...Object.entries(metrics.byType)]) {
    lines.push(
      `| ${type} | ${group.count} | ${fmt(group.recall1)} | ${fmt(group.recall5)} | ${fmt(group.recall10)} | ${group.mrr.toFixed(3)} | ${group.ndcg10.toFixed(3)} | ${group.p50.toFixed(1)} ms | ${group.p95.toFixed(1)} ms |`
    )
  }
  const misses = rows.rows
    .filter((row) => row.hits.length === 0 || !row.hits.slice(0, 5).some((hit) => row.gold.some((name) => hit.title === name || hit.origin.endsWith(name))))
    .slice(0, 20)
  lines.push('', `## 未命中（前 ${misses.length} 条）`, '')
  for (const miss of misses) {
    lines.push(`- [${miss.type}] ${miss.id}: 命中 ${miss.hits.length} 条，首条 ${JSON.stringify(miss.hits[0]?.title ?? null)}`)
  }
  const reportPath = join(OUT, `report-${LABEL}.md`)
  writeFileSync(reportPath, lines.join('\n'), 'utf8')
  log(`report -> ${reportPath}`)
  log(JSON.stringify(metrics, null, 2))
}

main()
  .catch((error) => {
    log(`RAG EVAL FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
  .finally(() => {
    shutdown()
    process.exit(process.exitCode ?? 0)
  })
