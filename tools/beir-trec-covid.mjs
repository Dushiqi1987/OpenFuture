import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'

/**
 * BEIR / TREC-COVID retrieval evaluation through the real desktop memory stack.
 *
 * The full TREC-COVID corpus is 171k documents; importing it file-by-file
 * through the memory pipeline is not practical. We therefore evaluate a
 * reproducible slice: every graded-relevant document for the 15 smallest
 * queries plus seeded distractors. Metrics are computed against the graded
 * qrels inside that slice, so they read higher than full-corpus BEIR numbers.
 */

const ROOT = join(import.meta.dirname, '..')
const DATA = join(ROOT, '.scratch', 'beir', 'trec-covid', 'trec-covid')
const CORPUS = join(DATA, 'corpus.jsonl')
const QRELS = join(DATA, 'qrels', 'test.tsv')
const DOCS = join(ROOT, '.scratch', 'beir', 'trec-covid-docs')
const SUBSET = join(ROOT, '.scratch', 'beir', 'trec-covid-subset.json')
const USER_DATA = join(ROOT, '.scratch', 'beir-userdata')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const QUERY_COUNT = Number(process.env.QUERY_COUNT || 15)
const POOL_SIZE = Number(process.env.POOL_SIZE || 8000)
const MODE = process.env.RETRIEVAL || 'hybrid-rerank'
const REPORT = join(ROOT, '.scratch', 'beir', `trec-covid-report-${MODE}.json`)

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const log = (line) => console.log(line)

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function readQrels() {
  const per = new Map()
  for (const line of readFileSync(QRELS, 'utf8').split('\n')) {
    const [qid, doc, score] = line.split('\t')
    if (!qid || isNaN(Number(score))) continue
    const grade = Number(score)
    if (grade <= 0) continue
    if (!per.has(qid)) per.set(qid, new Map())
    per.get(qid).set(doc, grade)
  }
  return per
}

async function prepare() {
  if (existsSync(SUBSET) && existsSync(DOCS)) {
    const subset = JSON.parse(readFileSync(SUBSET, 'utf8'))
    log(`subset ready: ${subset.docs} docs / ${subset.queries.length} queries`)
    return subset
  }
  const qrels = readQrels()
  const ordered = [...qrels].sort((a, b) => a[1].size - b[1].size).slice(0, QUERY_COUNT)
  const queries = [...ordered].map(([id, docs]) => ({ id, docs }))
  const queryText = new Map()
  for await (const line of createInterface({ input: createReadStream(join(DATA, 'queries.jsonl')), crlfDelay: Infinity })) {
    if (!line.trim()) continue
    const row = JSON.parse(line)
    queryText.set(row._id, row.text)
  }

  const gold = new Set()
  for (const query of queries) for (const doc of query.docs.keys()) gold.add(doc)

  const ids = []
  for await (const line of createInterface({ input: createReadStream(CORPUS), crlfDelay: Infinity })) {
    if (!line.trim()) continue
    ids.push(JSON.parse(line)._id)
  }
  const noise = ids.filter((id) => !gold.has(id))
  const random = mulberry32(20261116)
  for (let i = noise.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[noise[i], noise[j]] = [noise[j], noise[i]]
  }
  const picked = new Set(gold)
  for (const id of noise) {
    if (picked.size >= POOL_SIZE) break
    picked.add(id)
  }

  rmSync(DOCS, { recursive: true, force: true })
  mkdirSync(DOCS, { recursive: true })
  let written = 0
  for await (const line of createInterface({ input: createReadStream(CORPUS), crlfDelay: Infinity })) {
    if (!line.trim()) continue
    const row = JSON.parse(line)
    if (!picked.has(row._id)) continue
    writeFileSync(join(DOCS, `${row._id}.md`), `# ${row._id}\n\n${row.text}\n`, 'utf8')
    written += 1
  }

  const subset = {
    dataset: 'BEIR/TREC-COVID (slice)',
    docs: written,
    queries: queries.map((query) => ({
      id: query.id,
      text: queryText.get(query.id) ?? '',
      qrels: Object.fromEntries(query.docs)
    }))
  }
  writeFileSync(SUBSET, JSON.stringify(subset, null, 2), 'utf8')
  log(`prepared ${written} docs / ${queries.length} queries -> ${SUBSET}`)
  return subset
}

async function pickPort() {
  return new Promise((done) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => done(address.port))
    })
  })
}

function seed() {
  // Keep the imported corpus between retrieval modes: re-importing 8k files
  // costs ~9 minutes and the store is deterministic.
  if (existsSync(join(USER_DATA, 'memory', 'memory.sqlite'))) return
  rmSync(USER_DATA, { recursive: true, force: true })
  mkdirSync(join(USER_DATA, 'config'), { recursive: true })
  writeFileSync(
    join(USER_DATA, 'config', 'settings.json'),
    JSON.stringify(
      {
        version: 1,
        workspace: DOCS,
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
        activeProjectId: 'p-beir',
        projects: [
          {
            id: 'p-beir',
            name: 'trec-covid',
            canonicalRoot: DOCS,
            memoryPreset: 'rag',
            defaultModelRef: null,
            createdAt: 1_700_000_000_000,
            archivedAt: null,
            lastConversationId: 'c-beir'
          }
        ],
        conversations: [
          { id: 'c-beir', projectId: 'p-beir', title: 'TREC-COVID 评测', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }
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
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 300_000 })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed')
    }
    return result.result?.value
  }
}

async function findTarget(port) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      // list endpoint not ready yet
    }
    await sleep(250)
  }
  throw new Error('devtools target not found')
}

async function waitFor(cdp, expression, label, timeoutMs = 120_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await cdp.evaluate(expression)) return
    await sleep(200)
  }
  throw new Error(`timeout waiting for ${label}`)
}

function dcg(grades) {
  return grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0)
}

function evaluateQueries(results, subset) {
  const rows = []
  for (const query of subset.queries) {
    const hit = results.find((item) => item.id === query.id)
    const ranked = (hit?.ids ?? []).slice(0, 100)
    const grades = ranked.map((doc) => query.qrels[doc] ?? 0)
    const relevant = new Map(Object.entries(query.qrels))
    const firstRelevant = grades.findIndex((grade) => grade > 0)
    const recallAt = (k) => {
      const seen = new Set(ranked.slice(0, k).filter((doc) => relevant.has(doc)))
      return seen.size / relevant.size
    }
    const ideal = dcg([...relevant.values()].sort((a, b) => b - a).slice(0, 10))
    const matched100 = new Set(ranked.slice(0, 100).filter((doc) => relevant.has(doc))).size
    rows.push({
      id: query.id,
      text: query.text,
      gold: relevant.size,
      ndcg10: ideal > 0 ? dcg(grades.slice(0, 10)) / ideal : 0,
      recall10: recallAt(10),
      recall100: recallAt(100),
      recall100Norm: relevant.size > 0 ? matched100 / Math.min(100, relevant.size) : 0,
      mrr10: firstRelevant >= 0 && firstRelevant < 10 ? 1 / (firstRelevant + 1) : 0,
      hits: ranked.length,
      latencyMs: hit?.latencyMs ?? null,
      top: ranked.slice(0, 3)
    })
  }
  const mean = (key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length
  const latencies = rows.map((row) => row.latencyMs).filter((value) => typeof value === 'number').sort((a, b) => a - b)
  return {
    mode: MODE,
    queries: rows.length,
    ndcg10: mean('ndcg10'),
    recall10: mean('recall10'),
    recall100: mean('recall100'),
    recall100Norm: mean('recall100Norm'),
    meanGold: mean('gold'),
    mrr10: mean('mrr10'),
    p50: latencies[Math.floor(latencies.length * 0.5)] ?? null,
    p95: latencies[Math.floor(latencies.length * 0.95)] ?? null,
    rows
  }
}

async function main() {
  const subset = await prepare()
  seed()
  const port = await pickPort()
  const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
      OPENFUTURE_USER_DATA: USER_DATA,
      OPENFUTURE_RETRIEVAL_MODE: MODE,
      OPENFUTURE_MODEL_DIR: join(ROOT, '.scratch', 'models'),
      OPENFUTURE_SEMANTIC: process.env.SEMANTIC || '1',
      OPENFUTURE_RERANK: process.env.RERANK || 'model'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let appLog = ''
  app.stdout.on('data', (chunk) => {
    appLog += chunk
  })
  app.stderr.on('data', (chunk) => {
    appLog += chunk
  })

  let cdp
  try {
    const url = await findTarget(port)
    cdp = await new Cdp(url).connect()
    await waitFor(cdp, 'typeof window.openfuture === "object"', 'preload')

    const imported = new Set(
      await cdp.evaluate(`(async () => {
        const response = await window.openfuture.memoryListSources()
        const list = response?.value ?? []
        return list.map((item) => item.title)
      })()`)
    )
    log(`sources already imported: ${imported.size}`)

    if (imported.size < subset.docs) {
      const all = readdirSync(DOCS).map((name) => join(DOCS, name)).sort()
      const started = Date.now()
      let done = 0
      for (let index = 0; index < all.length; index += 100) {
        const batch = all.slice(index, index + 100)
        await cdp.evaluate(`window.openfuture.memoryImportFiles({ paths: ${JSON.stringify(batch)} })`)
        done += batch.length
        if (done % 1000 === 0 || done === all.length) {
          log(`imported ${done}/${all.length} (${Math.round((Date.now() - started) / 1000)}s)`)
        }
      }
    }

    const modeResult = await cdp.evaluate(`window.openfuture.memorySetMode('rag')`)
    if (modeResult && modeResult.ok === false) throw new Error(`memorySetMode failed: ${modeResult.error?.message}`)
    await sleep(500)
    // Semantic vectors are built in the background during import; give the
    // embedding pass time to finish before measuring, otherwise the first
    // queries silently fall back to hashed vectors.
    const semanticWait = Number(process.env.SEMANTIC_WAIT_MS || 0)
    if (semanticWait > 0) {
      log(`waiting ${Math.round(semanticWait / 1000)}s for semantic indexing`)
      await sleep(semanticWait)
    }

    const queries = subset.queries.map((query) => ({ id: query.id, text: query.text }))
    const results = await cdp.evaluate(`(async () => {
      const list = ${JSON.stringify(queries)}
      const out = []
      for (const item of list) {
        const started = performance.now()
        const response = await window.openfuture.memorySearch({ query: item.text, limit: 100 })
        const result = response?.value ?? { hits: [] }
        const latencyMs = Math.round(performance.now() - started)
        const ids = (result.hits || []).map((hit) => {
          const origin = hit.citation?.origin || ''
          const name = hit.citation?.sourceTitle || hit.title || origin.split(/[\\\\/]/).pop() || ''
          const clean = name.replace(/^file:/, '').replace(/\\.(md|txt|pdf)$/i, '')
          return clean
        })
        out.push({ id: item.id, ids, latencyMs })
      }
      return out
    })()`)

    const report = evaluateQueries(results, subset)
    report.dataset = subset.dataset
    report.poolSize = subset.docs
    writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8')
    log(
      `[${MODE}] nDCG@10=${report.ndcg10.toFixed(4)} R@10=${report.recall10.toFixed(4)} ` +
        `R@100=${report.recall100.toFixed(4)} R@100(cap)=${report.recall100Norm.toFixed(4)} ` +
        `MRR@10=${report.mrr10.toFixed(4)} gold=${report.meanGold.toFixed(0)} p50=${report.p50}ms`
    )
    log(`report -> ${REPORT}`)
    if (appLog.includes('FATAL')) log(appLog.slice(-2000))
  } finally {
    try {
      cdp?.socket?.close()
    } catch {
      // ignore
    }
    app.kill()
    await sleep(300)
  }
}

main().catch((error) => {
  console.error(`BEIR EVAL FAILED: ${error.message}`)
  process.exitCode = 1
})
