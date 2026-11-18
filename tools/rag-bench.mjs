/**
 * Offline RAG benchmark.
 *
 * Runs the built memory-host bundle under plain Node with a fake ParentPort so
 * retrieval can be measured without launching Electron. The host is pointed at
 * a snapshot of the real memory DB, so the index, embeddings and reranker are
 * the same ones the desktop app uses.
 *
 * Usage:
 *   node tools/rag-bench.mjs --snapshot            # refresh the DB snapshot
 *   OPENFUTURE_RETRIEVAL_MODE=hybrid node tools/rag-bench.mjs
 *   OPENFUTURE_RERANK=model OPENFUTURE_RETRIEVAL_MODE=hybrid-rerank node tools/rag-bench.mjs
 *   node tools/rag-bench.mjs --dataset=synthetic
 *
 * Metrics: R@1/5/10/20, nDCG@10, MRR@10, latency p50/p95.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const ROOT = join(import.meta.dirname, '..')
const BENCH = join(ROOT, '.scratch', 'bench')
const SYNTHETIC_CORPUS = join(ROOT, '.scratch', 'rag-corpus')
const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = '1'] = arg.replace(/^--/, '').split('=')
    return [key, value]
  })
)
const DATASET = args.get('dataset') || 'trec'
// Default to the e5-embedded snapshots: the bundled embedding model is now
// multilingual-e5-small, and pointing at a bge snapshot would silently score
// hashed fallback vectors instead of real semantics.
const MEMORY_DIR =
  process.env.OPENFUTURE_BENCH_MEMORY_DIR ||
  join(BENCH, DATASET === 'trec' || DATASET === 'trec-zh' ? 'memory-e5' : `${DATASET}-e5`)
const MODEL_DIR = process.env.OPENFUTURE_MODEL_DIR || join(ROOT, '.scratch', 'models')
const REAL_MEMORY = join(process.env.APPDATA || '', 'openfuture', 'memory')
const HOST_BUNDLE = join(ROOT, 'out', 'main', 'memory-host.js')
const SUBSET = join(ROOT, '.scratch', 'beir', 'trec-covid-subset.json')
const SCIFACT_DIR = join(ROOT, '.scratch', 'beir', 'scifact', 'scifact')

const MODE = process.env.OPENFUTURE_RETRIEVAL_MODE || 'hybrid-rerank'
const RERANK = process.env.OPENFUTURE_RERANK || 'heuristic'
const LIMIT = Number(args.get('limit') || 100)

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const log = (line) => console.log(line)
const round = (value, digits = 4) => Number(value.toFixed(digits))

function snapshotDatabase() {
  if (DATASET !== 'trec' && DATASET !== 'trec-zh') return
  if (existsSync(join(MEMORY_DIR, 'memory.sqlite'))) return
  mkdirSync(MEMORY_DIR, { recursive: true })
  const target = join(MEMORY_DIR, 'memory.sqlite')
  const source = join(REAL_MEMORY, 'memory.sqlite')
  if (!existsSync(source)) throw new Error(`real memory DB not found: ${source}`)
  const db = new DatabaseSync(source, { readOnly: true })
  try {
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
  } finally {
    db.close()
  }
  log(`snapshot -> ${target}`)
}

function refreshDatabase() {
  rmSync(MEMORY_DIR, { recursive: true, force: true })
  snapshotDatabase()
}

class FakePort {
  constructor() {
    this.listeners = []
    this.pending = new Map()
    this.id = 0
  }
  on(name, listener) {
    if (name === 'message') this.listeners.push(listener)
  }
  emit(message) {
    for (const listener of this.listeners) listener({ data: message })
  }
  postMessage(message) {
    if (message?.kind === 'response') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.ok) pending.resolve(message.value)
      else pending.reject(new Error(`${message.error?.code}: ${message.error?.message}`))
      return
    }
    if (message?.kind === 'log' || message?.kind === 'event') return
  }
  call(method, params, timeoutMs = 600_000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`memory RPC timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      this.emit({ kind: 'request', id, method, params })
    })
  }
}

async function bootHost() {
  process.env.OPENFUTURE_MEMORY_DIR = MEMORY_DIR
  process.env.OPENFUTURE_MODEL_DIR = MODEL_DIR
  process.env.OPENFUTURE_RETRIEVAL_MODE = MODE
  process.env.OPENFUTURE_RERANK = RERANK
  process.env.OPENFUTURE_SEMANTIC = process.env.OPENFUTURE_SEMANTIC || '1'
  const port = new FakePort()
  process.parentPort = port
  await import(pathToFileURL(HOST_BUNDLE).href)
  if (port.listeners.length === 0) throw new Error('memory-host did not register a message listener')
  return port
}

function dcg(grades) {
  return grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0)
}

function docIdOf(hit) {
  const raw = hit?.citation?.sourceTitle || hit?.citation?.origin || hit?.title || ''
  const name = String(raw).split(/[\\/]/).pop() || ''
  return name.replace(/^file:/, '').replace(/\.(md|txt|pdf|docx)$/i, '')
}

function evaluate(rows, queries) {
  const missing = []
  for (const query of queries) {
    const row = rows.get(query.id)
    if (!row || row.ids.length === 0) missing.push(query.id)
  }
  const per = queries.map((query) => {
    const ids = rows.get(query.id)?.ids ?? []
    const qrels = query.qrels ?? {}
    const relevant = new Set(Object.keys(qrels))
    const first = ids.findIndex((id) => relevant.has(id))
    const recallAt = (k) => {
      let hit = 0
      for (const id of new Set(ids.slice(0, k))) if (relevant.has(id)) hit += 1
      return relevant.size > 0 ? hit / relevant.size : 0
    }
    const recallCap = (k) => {
      let hit = 0
      for (const id of new Set(ids.slice(0, k))) if (relevant.has(id)) hit += 1
      return hit / Math.min(k, relevant.size || 1)
    }
    const gains = ids.slice(0, 10).map((id) => qrels[id] ?? 0)
    const ideal = dcg(
      Object.values(qrels)
        .sort((a, b) => b - a)
        .slice(0, 10)
    )
    return {
      id: query.id,
      text: query.text,
      gold: relevant.size,
      ndcg10: ideal > 0 ? dcg(gains) / ideal : 0,
      recall1: recallAt(1),
      recall5: recallAt(5),
      recall10: recallAt(10),
      recall20: recallAt(20),
      recallCap10: recallCap(10),
      mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0,
      latencyMs: rows.get(query.id)?.latencyMs ?? null,
      topScore: rows.get(query.id)?.topScore ?? 0,
      top3: ids.slice(0, 3)
    }
  })
  const mean = (key) => per.reduce((sum, row) => sum + row[key], 0) / (per.length || 1)
  const latencies = per
    .map((row) => row.latencyMs)
    .filter((value) => typeof value === 'number')
    .sort((a, b) => a - b)
  const pct = (ratio) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * ratio))] ?? null
  return {
    dataset: DATASET,
    mode: MODE,
    rerank: RERANK,
    semantic: process.env.OPENFUTURE_SEMANTIC !== '0',
    graded: queries.some((query) => Object.keys(query.qrels ?? {}).length > 0),
    queries: per.length,
    emptyQueries: missing.length,
    missing,
    ndcg10: round(mean('ndcg10')),
    recall1: round(mean('recall1')),
    recall5: round(mean('recall5')),
    recall10: round(mean('recall10')),
    recall20: round(mean('recall20')),
    recallCap10: round(mean('recallCap10')),
    mrr10: round(mean('mrr10')),
    latencyAvg: Math.round(latencies.reduce((sum, value) => sum + value, 0) / (latencies.length || 1)),
    latencyP50: pct(0.5),
    latencyP95: pct(0.95),
    rows: per
  }
}

function readJsonl(file) {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function loadScifact() {
  const corpus = readJsonl(join(SCIFACT_DIR, 'corpus.jsonl'))
  const queries = new Map(readJsonl(join(SCIFACT_DIR, 'queries.jsonl')).map((row) => [String(row._id), row.text]))
  const qrels = readFileSync(join(SCIFACT_DIR, 'qrels', 'test.tsv'), 'utf8')
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
  const byQuery = new Map()
  for (const line of qrels) {
    const [queryId, corpusId, score] = line.split('\t')
    if (!byQuery.has(queryId)) byQuery.set(queryId, {})
    byQuery.get(queryId)[corpusId] = Number(score) || 1
  }
  return {
    docs: corpus.map((row) => ({ id: String(row._id), title: row.title || '', text: row.text || '' })),
    queries: [...byQuery.entries()]
      .filter(([id]) => queries.has(id))
      .map(([id, qrelsById]) => ({ id, text: queries.get(id), qrels: qrelsById }))
  }
}

async function loadTrecQueries() {
  const subset = JSON.parse(readFileSync(SUBSET, 'utf8'))
  return subset.queries.map((query) => ({ id: query.id, text: query.text, qrels: query.qrels }))
}

function loadTrecZhQueries() {
  const file = join(ROOT, '.scratch', 'beir', 'trec-covid-zh.json')
  return JSON.parse(readFileSync(file, 'utf8')).queries.map((query) => ({
    id: query.id,
    text: query.text,
    qrels: query.qrels
  }))
}

/**
 * Real conversation queries: exported from the live library's retrieval_events.
 * They have no qrels, so only latency / hit counts / top scores are meaningful.
 */
function loadLiveQueries() {
  const file = join(ROOT, '.scratch', 'beir', 'live-queries.json')
  return JSON.parse(readFileSync(file, 'utf8')).queries.map((query) => ({
    id: query.id,
    text: query.text,
    qrels: {}
  }))
}

function loadSyntheticQueries() {
  const file = join(ROOT, '.scratch', 'bench', 'synthetic-queries.json')
  return JSON.parse(readFileSync(file, 'utf8'))
}

async function main() {
  if (args.has('snapshot')) refreshDatabase()
  snapshotDatabase()
  if (!existsSync(HOST_BUNDLE)) throw new Error(`build memory-host first: ${HOST_BUNDLE}`)
  let queries
  const port = await bootHost()
  const workspace = join(ROOT, '.scratch', 'workspace')
  // Model loading is asynchronous at host start; queries issued before it
  // finishes silently fall back to hashed vectors, which would make every
  // semantic configuration look identical to the lexical one.
  let state = await port.call('state', { workspace })
  const wantReranker = RERANK !== 'off' && RERANK !== 'heuristic'
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    if (state.semanticReady && (!wantReranker || state.rerankerReady)) break
    await sleep(1000)
    state = await port.call('state', { workspace })
  }
  await port.call('setMode', { workspace, mode: 'rag' })
  if (DATASET === 'scifact') {
    const scifact = loadScifact()
    if (state.sourceCount < scifact.docs.length) {
      const seeding = Date.now()
      for (const doc of scifact.docs) {
        await port.call('importSource', {
          workspace,
          title: `${doc.id}.md`,
          origin: `file:scifact/${doc.id}.md`,
          kind: 'md',
          content: `# ${doc.title}\n\n${doc.text}`
        })
      }
      log(`seeded scifact corpus: ${scifact.docs.length} docs in ${Math.round((Date.now() - seeding) / 1000)}s`)
      state = await port.call('state', { workspace })
    }
    queries = scifact.queries
    log(`scifact queries: ${queries.length}`)
  } else if (DATASET === 'synthetic') {
    const corpus = JSON.parse(readFileSync(join(SYNTHETIC_CORPUS, 'queries.json'), 'utf8'))
    if (state.sourceCount < corpus.docs.length) {
      for (const doc of corpus.docs) {
        const absolute = join(SYNTHETIC_CORPUS, 'docs', doc.fileName)
        await port.call('importSource', {
          workspace,
          title: doc.fileName,
          origin: `file:${absolute}`,
          kind: 'md',
          content: readFileSync(absolute, 'utf8')
        })
      }
      log(`seeded synthetic corpus: ${corpus.docs.length} docs`)
    }
    queries = corpus.queries.map((entry) => ({
      id: entry.id,
      text: entry.query,
      qrels: Object.fromEntries((entry.gold ?? []).map((name) => [String(name).replace(/\.(md|txt)$/i, ''), 1]))
    }))
  } else if (DATASET === 'project') {
    const project = JSON.parse(readFileSync(join(ROOT, '.scratch', 'beir', 'project.json'), 'utf8'))
    if (state.sourceCount < project.docs.length) {
      for (const relative of project.docs) {
        const absolute = join(ROOT, relative)
        await port.call('importSource', {
          workspace,
          title: relative.split('/').pop(),
          origin: `file:${absolute}`,
          kind: 'md',
          content: readFileSync(absolute, 'utf8')
        })
      }
      log(`seeded project corpus: ${project.docs.length} docs`)
    }
    queries = project.queries.map((entry) => ({
      id: entry.id,
      text: entry.text,
      qrels: Object.fromEntries((entry.gold ?? []).map((name) => [String(name).replace(/\.(md|txt)$/i, ''), 1]))
    }))
  } else if (DATASET === 'trec-zh') {
    queries = loadTrecZhQueries()
  } else if (DATASET === 'live') {
    queries = loadLiveQueries()
  } else {
    queries = await loadTrecQueries()
  }
  if (DATASET !== 'trec' && process.env.OPENFUTURE_SEMANTIC !== '0') {
    await port.call('embedPending', { workspace })
    const embedDeadline = Date.now() + 240_000
    while (Date.now() < embedDeadline && state.semanticDocCount < state.indexedDocCount) {
      await sleep(1000)
      state = await port.call('state', { workspace })
    }
    log(`semantic index: ${state.semanticDocCount}/${state.indexedDocCount}`)
  }
  log(
    `state: sources=${state.sourceCount} evidence=${state.evidenceCount} indexed=${state.indexedDocCount} ` +
      `semantic=${state.semanticDocCount} embedder=${state.semanticReady} reranker=${state.rerankerReady}`
  )
  if (process.env.OPENFUTURE_SEMANTIC !== '0' && state.semanticDocCount === 0) {
    console.warn('[bench] WARNING: this snapshot has no embeddings for the active model; dense falls back to hashes')
  }
  const rows = new Map()
  const started = Date.now()
  for (const [index, query] of queries.entries()) {
    const at = Date.now()
    let result
    try {
      result = await port.call('search', { workspace, query: query.text, limit: LIMIT })
    } catch (error) {
      log(`query ${query.id} failed: ${error.message}`)
      result = { hits: [] }
    }
    const ids = []
    const seen = new Set()
    for (const hit of result.hits ?? []) {
      const id = docIdOf(hit)
      if (!id || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
    rows.set(query.id, { ids, latencyMs: Date.now() - at, engine: result.engine, topScore: Number(result.hits?.[0]?.score ?? 0) })
    if ((index + 1) % 5 === 0 || index === queries.length - 1) {
      log(`[${MODE}/${RERANK}] ${index + 1}/${queries.length} queries (${Math.round((Date.now() - started) / 1000)}s)`)
    }
  }
  const report = evaluate(rows, queries)
  report.poolSize = state.indexedDocCount
  const tag = [
    MODE,
    RERANK,
    `c${process.env.OPENFUTURE_RERANK_CANDIDATES ?? 20}`,
    `w${process.env.OPENFUTURE_RERANK_WEIGHT ?? '0.7'}`,
    `ch${process.env.OPENFUTURE_RERANK_CHARS ?? 480}`,
    `d${process.env.OPENFUTURE_DENSE_WEIGHT ?? '0.9'}`
  ].join('-')
  // Optional suffix so parameter sweeps do not overwrite each other: --tag=<name>
  const tagArg = process.argv.find((value) => value.startsWith('--tag='))
  const customTag = tagArg?.slice('--tag='.length) || process.env.OPENFUTURE_BENCH_TAG || ''
  const reportName = customTag ? `report-${DATASET}-${tag}-${customTag}.json` : `report-${DATASET}-${tag}.json`
  ;(report).tag = customTag || undefined
  const out = join(BENCH, reportName)
  writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')
  log(
    `[${report.mode}/${report.rerank}] nDCG@10=${report.ndcg10} R@1=${report.recall1} R@10=${report.recall10} ` +
      `MRR@10=${report.mrr10} p50=${report.latencyP50}ms p95=${report.latencyP95}ms empty=${report.emptyQueries}`
  )
  if (process.argv.includes('--verbose') || process.env.OPENFUTURE_BENCH_VERBOSE === '1') {
    for (const row of report.rows) {
      log(`  ${row.id} ndcg=${row.ndcg10.toFixed(3)} gold=${row.gold} top=${Number(row.topScore).toFixed(4)} ${row.top3.join(',')} :: ${String(row.text).slice(0, 48)}`)
    }
  }
  log(`report -> ${out}`)
  process.exit(0)
}

main().catch((error) => {
  console.error(`RAG BENCH FAILED: ${error.stack || error.message}`)
  process.exitCode = 1
})
