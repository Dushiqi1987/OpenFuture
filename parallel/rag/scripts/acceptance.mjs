#!/usr/bin/env node
/**
 * Local acceptance run for the RAG hybrid-retrieval prototype.
 *
 * Everything runs on 127.0.0.1, inside parallel/rag/.scratch, with synthetic fixtures
 * and a fake QMD SDK module (the real @tobilu/qmd 2.8.3 needs native modules and
 * multi-hundred-MB model downloads, which this isolated workspace must not fetch).
 * Set RAG_QMD_MODULE to a real QMD install to re-run the same script against it.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRagAdapter } from '../src/adapter.ts'
import { probeDocling } from '../src/docling/client.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixtures = join(root, 'fixtures')
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const runDir = join(root, '.scratch', 'run', `acceptance-${stamp}`)
const fakeQmd = process.env.RAG_QMD_MODULE ?? pathToFileURL(join(root, 'test', 'fakes', 'qmd-fake.mjs')).href
const usingRealQmd = process.env.RAG_QMD_MODULE !== undefined
const K = Number(process.env.RAG_ACCEPT_K ?? 30)
const N = Number(process.env.RAG_ACCEPT_N ?? 5)

mkdirSync(runDir, { recursive: true })

const queries = JSON.parse(readFileSync(join(fixtures, 'queries.json'), 'utf8')).queries
const eligible = queries.filter((q) => q.kind !== 'scan')

function nid(fileName, page) {
  return `${fileName}:${page}`
}

function metrics(results) {
  let recallHits = 0
  let dcg = 0
  let idcg = 0
  let mrr = 0
  let citations = 0
  let citationHits = 0
  for (const { query, result, gold } of results) {
    const pages = result.hits.map((hit) => nid(hit.fileName, hit.locator.page))
    const goldIds = (gold.pages ?? [gold.page]).map((page) => nid(gold.sourceFile, page))
    const rank = pages.findIndex((id) => goldIds.includes(id))
    if (rank >= 0) {
      recallHits += 1
      dcg += 1 / Math.log2(rank + 2)
      mrr += 1 / (rank + 1)
    }
    idcg += 1
    for (const evidence of result.selected) {
      const citesFact = evidence.text.includes(gold.phrase)
      if (!citesFact) continue
      citations += 1
      if (goldIds.includes(nid(evidence.fileName, evidence.locator.page))) citationHits += 1
    }
  }
  const total = results.length
  return {
    queries: total,
    recallAtN: recallHits / total,
    ndcgAtN: idcg === 0 ? 0 : dcg / idcg,
    mrr: mrr / total,
    citationPageAccuracy: citations === 0 ? 0 : citationHits / citations,
    citations
  }
}

async function timed(fn) {
  const started = performance.now()
  const value = await fn()
  return { value, ms: performance.now() - started }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

async function main() {
  const docling = await probeDocling({ python: process.env.RAG_DOCLING_PYTHON ?? 'python', timeoutMs: 20000 })
  const dataDir = join(runDir, 'data')
  const adapter = createRagAdapter({
    dataDir,
    projectId: 'acceptance',
    qmdModule: fakeQmd,
    useDocling: false,
    python: process.env.RAG_DOCLING_PYTHON
  })
  const diagnostics = await adapter.initialize()

  const imports = []
  for (const file of ['spec-cn-en.pdf', 'handbook-cn-en.md', 'scan-cn-en.pdf']) {
    const { value, ms } = await timed(() => adapter.importSource({ path: join(fixtures, file) }))
    imports.push({
      file,
      sourceId: value.source.sourceId,
      revision: value.source.revision,
      chunks: value.chunkCount,
      parseMs: Math.round(ms),
      ocrPages: value.source.ocrPages,
      warnings: value.source.warnings
    })
  }

  const runs = []
  const lexicalRuns = []
  for (const spec of queries) {
    if (spec.kind === 'scan') continue
    const hybrid = await timed(() => adapter.search({ query: spec.query, k: K, n: N, layout: 'A' }))
    runs.push({ query: spec, result: hybrid.value, gold: spec.gold, ms: hybrid.ms })
    const lexical = await timed(() => adapter.search({ query: spec.query, k: K, n: N, layout: 'A', mode: 'lexical' }))
    lexicalRuns.push({ query: spec, result: lexical.value, gold: spec.gold, ms: lexical.ms })
  }

  const hybridMetrics = metrics(runs)
  hybridMetrics.avgLatencyMs = Math.round(runs.reduce((sum, run) => sum + run.ms, 0) / runs.length)
  hybridMetrics.p50LatencyMs = Math.round(median(runs.map((run) => run.ms)))
  const lexicalMetrics = metrics(lexicalRuns)
  lexicalMetrics.avgLatencyMs = Math.round(lexicalRuns.reduce((sum, run) => sum + run.ms, 0) / lexicalRuns.length)
  lexicalMetrics.p50LatencyMs = Math.round(median(lexicalRuns.map((run) => run.ms)))

  const perQuery = runs.map((run) => {
    const pages = run.result.hits.map((hit) => nid(hit.fileName, hit.locator.page))
    const goldIds = (run.gold.pages ?? [run.gold.page]).map((page) => nid(run.gold.sourceFile, page))
    return {
      id: run.query.id,
      query: run.query.query,
      gold: goldIds.join(' / '),
      hitPages: pages,
      rank: pages.findIndex((id) => goldIds.includes(id)),
      engines: run.result.diagnostics.engines,
      latencyMs: Math.round(run.ms),
      topEvidence: run.result.selected.map((evidence) => `${evidence.fileName}:${evidence.locator.page} ${evidence.heading ?? ''}`.trim())
    }
  })

  const abSpec = queries.find((q) => q.id === 'q-pro-throughput')
  const abA = await adapter.search({ query: abSpec.query, k: K, n: N, layout: 'A' })
  const abB = await adapter.search({ query: abSpec.query, k: K, n: N, layout: 'B' })
  const ab = {
    query: abSpec.query,
    layoutA: abA.selected.map((evidence, index) => ({
      rank: index + 1,
      file: evidence.fileName,
      page: evidence.locator.page,
      chunkId: evidence.chunkId
    })),
    layoutB: abB.selected.map((evidence, index) => ({
      rank: index + 1,
      file: evidence.fileName,
      page: evidence.locator.page,
      chunkId: evidence.chunkId
    })),
    sameSet: new Set(abA.selected.map((e) => e.chunkId)).size === new Set(abB.selected.map((e) => e.chunkId)).size &&
      abA.selected.every((item) => abB.selected.some((other) => other.chunkId === item.chunkId))
  }

  const gates = {}
  const scanQuery = queries.find((q) => q.kind === 'scan')
  const scanResult = await adapter.search({ query: scanQuery.query, k: K, n: N })
  gates.scanNoTextEvidence = scanResult.hits.every((hit) => hit.fileName !== 'scan-cn-en.pdf')
  gates.scanImport = imports.find((item) => item.file === 'scan-cn-en.pdf')

  const before = await adapter.search({ query: 'OF-2200 Pro 1200 页/分钟', k: K, n: N })
  gates.revokeBefore = before.hits.some((hit) => hit.sourceId === 'spec-cn-en')
  await adapter.revokeSource('spec-cn-en')
  const after = await adapter.search({ query: 'OF-2200 Pro 1200 页/分钟', k: K, n: N })
  gates.revokeAfter = after.hits.every((hit) => hit.sourceId !== 'spec-cn-en')
  gates.revokeDiagnostics = after.diagnostics

  const handbookPath = join(fixtures, 'handbook-cn-en.md')
  const modifiedPath = join(runDir, 'handbook-replaced.md')
  const modified = readFileSync(handbookPath, 'utf8').replace('备件供应周期为 7 年', '备件供应周期为 9 年').replace('30 秒', '45 秒')
  writeFileSync(modifiedPath, modified)
  const replaced = await adapter.importSource({ path: modifiedPath, sourceId: 'handbook-cn-en' })
  const oldText = await adapter.search({ query: '备件供应周期为 7 年', k: K, n: N })
  const newText = await adapter.search({ query: '备件供应周期为 9 年', k: K, n: N })
  gates.replacement = {
    oldRevision: replaced.source.revision,
    chunks: replaced.chunkCount,
    oldPhraseGone: oldText.hits.every((hit) => !hit.text.includes('7 年')),
    newPhrasePresent: newText.hits.some((hit) => hit.text.includes('9 年'))
  }

  const diagSnapshot = await adapter.diagnostics()
  const indexBytes = diagSnapshot.indexBytes
  await adapter.close()

  const restarted = createRagAdapter({ dataDir, projectId: 'acceptance', qmdModule: fakeQmd, useDocling: false })
  await restarted.initialize()
  const restartSearch = await restarted.search({ query: 'OF-2200 X 功耗', k: K, n: N })
  const restartDiagnostics = await restarted.diagnostics()
  gates.restart = {
    sources: restartDiagnostics.sources,
    chunks: restartDiagnostics.chunks,
    indexBytes: restartDiagnostics.indexBytes,
    searchWorks: restartSearch.hits.length > 0,
    noStaleSpec: restartSearch.hits.every((hit) => hit.sourceId !== 'spec-cn-en')
  }
  await restarted.close()

  const offlineDir = join(runDir, 'offline')
  mkdirSync(offlineDir, { recursive: true })
  copyFileSync(join(fixtures, 'handbook-cn-en.md'), join(offlineDir, 'handbook.md'))
  const offline = createRagAdapter({
    dataDir: join(runDir, 'offline-data'),
    projectId: 'offline',
    qmdModule: pathToFileURL(join(offlineDir, 'missing-qmd-module.mjs')).href,
    useDocling: false
  })
  const offlineDiagnostics = await offline.initialize()
  await offline.importSource({ path: join(offlineDir, 'handbook.md') })
  const offlineSearch = await offline.search({ query: '保修 备件', k: K, n: N })
  gates.offline = {
    engine: offlineDiagnostics.qmd.engine,
    reason: offlineDiagnostics.qmd.reason,
    searchStillWorks: offlineSearch.hits.length > 0
  }
  await offline.close()

  const report = {
    version: 1,
    createdAt: new Date().toISOString(),
    fixtureSet: {
      spec: 'fixtures/spec-cn-en.pdf',
      handbook: 'fixtures/handbook-cn-en.md',
      scan: 'fixtures/scan-cn-en.pdf',
      queries: 'fixtures/queries.json'
    },
    environment: {
      node: process.versions.node,
      qmdModule: usingRealQmd ? 'real (@tobilu/qmd via RAG_QMD_MODULE)' : 'test/fakes/qmd-fake.mjs (simulated SDK API)',
      qmdVersionPinned: '2.8.3',
      docling: docling,
      dataDir,
      k: K,
      n: N
    },
    index: {
      indexBytes,
      qmdCorpusBytes: directoryBytes(join(dataDir, 'qmd')),
      sources: diagSnapshot.sources,
      activeSources: diagSnapshot.activeSources,
      chunks: diagSnapshot.chunks,
      qmd: diagSnapshot.qmd
    },
    imports,
    metrics: { hybrid: hybridMetrics, lexical: lexicalMetrics },
    perQuery,
    layoutComparison: ab,
    gates,
    notes: [
      'Answer accuracy is not scored: this prototype returns verifiable evidence, not generated answers; citation page accuracy is reported instead.',
      'Citation page accuracy = share of returned evidence whose text contains the gold fact phrase and whose locator page equals the gold page.',
      'The QMD SDK surface is exercised through a fake module with the same API; no models are downloaded and no network calls are made.',
      'Scanned PDF pages are detected as OCR-required and yield zero text chunks; they are deliberately excluded from recall denominators.'
    ]
  }

  const jsonPath = join(runDir, 'acceptance-report.json')
  writeFileSync(jsonPath, JSON.stringify(report, null, 2))
  const mdPath = join(runDir, 'acceptance-report.md')
  writeFileSync(mdPath, renderMarkdown(report))

  console.log(`[acceptance] hybrid Recall@${N}=${(hybridMetrics.recallAtN * 100).toFixed(1)}% ` +
    `nDCG@${N}=${hybridMetrics.ndcgAtN.toFixed(3)} MRR=${hybridMetrics.mrr.toFixed(3)} ` +
    `citation=${(hybridMetrics.citationPageAccuracy * 100).toFixed(1)}% p50=${hybridMetrics.p50LatencyMs}ms`)
  console.log(`[acceptance] lexical Recall@${N}=${(lexicalMetrics.recallAtN * 100).toFixed(1)}% ` +
    `nDCG@${N}=${lexicalMetrics.ndcgAtN.toFixed(3)} MRR=${lexicalMetrics.mrr.toFixed(3)} ` +
    `citation=${(lexicalMetrics.citationPageAccuracy * 100).toFixed(1)}% p50=${lexicalMetrics.p50LatencyMs}ms`)
  console.log(`[acceptance] qmd=${report.index.qmd.engine} sources=${report.index.sources} chunks=${report.index.chunks} indexBytes=${indexBytes}`)
  console.log(`[acceptance] report: ${jsonPath}`)
  console.log(`[acceptance] markdown: ${mdPath}`)
}

function directoryBytes(path) {
  try {
    const info = statSync(path)
    if (info.isFile()) return info.size
    let total = 0
    for (const entry of readdirSafe(path)) {
      total += directoryBytes(join(path, entry))
    }
    return total
  } catch {
    return 0
  }
}

function readdirSafe(path) {
  try {
    return readFileSync ? readdirSyncSafe(path) : []
  } catch {
    return []
  }
}

import { readdirSync } from 'node:fs'
function readdirSyncSafe(path) {
  return readdirSync(path)
}

function listLabel(value) {
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '-'
  if (value === undefined || value === null || value === '') return '-'
  return String(value)
}

function renderMarkdown(report) {
  const lines = []
  lines.push('# RAG 混合检索验收报告 (synthetic / local)')
  lines.push('')
  lines.push(`- Created: ${report.createdAt}`)
  lines.push(`- Node: ${report.environment.node}`)
  lines.push(`- QMD module: ${report.environment.qmdModule} (pinned ${report.environment.qmdVersionPinned})`)
  lines.push(`- Docling: ${report.environment.docling.available ? `available ${report.environment.docling.version ?? ''}` : `unavailable — ${report.environment.docling.reason ?? 'unknown'}`}`)
  lines.push(`- Data dir: ${report.environment.dataDir}`)
  lines.push(`- K=${report.environment.k} N=${report.environment.n}`)
  lines.push('')
  lines.push('## Imports')
  lines.push('')
  lines.push('| file | sourceId | revision | chunks | parse ms | ocr pages | warnings |')
  lines.push('| --- | --- | --- | ---: | ---: | --- | --- |')
  for (const item of report.imports) {
    lines.push(`| ${item.file} | ${item.sourceId} | ${item.revision} | ${item.chunks} | ${item.parseMs} | ${listLabel(item.ocrPages)} | ${listLabel(item.warnings)} |`)
  }
  lines.push('')
  lines.push('## Metrics (gold = source file + page)')
  lines.push('')
  lines.push('| mode | Recall@N | nDCG@N | MRR | citation page acc. | p50 latency | avg latency |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const [name, metrics] of [['hybrid (lexical+vector+RRF+rerank)', report.metrics.hybrid], ['lexical baseline', report.metrics.lexical]]) {
    lines.push(`| ${name} | ${(metrics.recallAtN * 100).toFixed(1)}% | ${metrics.ndcgAtN.toFixed(3)} | ${metrics.mrr.toFixed(3)} | ${(metrics.citationPageAccuracy * 100).toFixed(1)}% | ${metrics.p50LatencyMs} ms | ${metrics.avgLatencyMs} ms |`)
  }
  lines.push('')
  lines.push('## Per query (hybrid)')
  lines.push('')
  lines.push('| id | gold | rank | hit pages (top N) | engines | latency |')
  lines.push('| --- | --- | ---: | --- | --- | ---: |')
  for (const item of report.perQuery) {
    lines.push(`| ${item.id} | ${item.gold} | ${item.rank >= 0 ? item.rank + 1 : 'miss'} | ${item.hitPages.join(', ')} | ${item.engines.join('+')} | ${item.latencyMs} ms |`)
  }
  lines.push('')
  lines.push('## Layout A vs B')
  lines.push('')
  lines.push(`Query: ${report.layoutComparison.query} · same evidence set: ${report.layoutComparison.sameSet}`)
  lines.push('')
  lines.push('| rank | A (descending) | B (two-end) |')
  lines.push('| ---: | --- | --- |')
  const rows = Math.max(report.layoutComparison.layoutA.length, report.layoutComparison.layoutB.length)
  for (let index = 0; index < rows; index += 1) {
    const a = report.layoutComparison.layoutA[index]
    const b = report.layoutComparison.layoutB[index]
    const fmt = (item) => (item === undefined ? '-' : `${item.file}:${item.page} (${item.chunkId})`)
    lines.push(`| ${index + 1} | ${fmt(a)} | ${fmt(b)} |`)
  }
  lines.push('')
  lines.push('## Gates')
  lines.push('')
  lines.push(`- scan text evidence excluded: ${report.gates.scanNoTextEvidence}`)
  lines.push(`- scan import: chunks=${report.gates.scanImport.chunks}, ocrPages=${listLabel(report.gates.scanImport.ocrPages)}`)
  lines.push(`- revoke: before=${report.gates.revokeBefore}, after=${report.gates.revokeAfter}`)
  lines.push(`- replacement: old phrase gone=${report.gates.replacement.oldPhraseGone}, new phrase present=${report.gates.replacement.newPhrasePresent}`)
  lines.push(`- restart: sources=${report.gates.restart.sources}, chunks=${report.gates.restart.chunks}, search=${report.gates.restart.searchWorks}, no stale spec=${report.gates.restart.noStaleSpec}`)
  lines.push(`- offline/lexical-only: engine=${report.gates.offline.engine}, search=${report.gates.offline.searchStillWorks}, reason=${report.gates.offline.reason ?? '-'}`)
  lines.push('')
  lines.push('## Notes')
  lines.push('')
  for (const note of report.notes) lines.push(`- ${note}`)
  lines.push('')
  return lines.join('\n')
}

await main()
