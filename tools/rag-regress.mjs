/**
 * Retrieval regression gate.
 *
 * Runs the offline benchmark on every corpus we tune against and fails when a
 * corpus drops below its recorded floor. The floors are ~1 point under the
 * current best so that ordinary noise does not trip the gate, but a real
 * regression (weights, chunking, model swap) does.
 *
 * Usage:
 *   node tools/rag-regress.mjs
 *   node tools/rag-regress.mjs --only=trec,scifact
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const BENCH = join(ROOT, '.scratch', 'bench')
const MODELS = join(ROOT, '.scratch', 'models')
const only = process.argv
  .find((arg) => arg.startsWith('--only='))
  ?.slice('--only='.length)
  .split(',')
  .filter(Boolean)

const CASES = [
  { dataset: 'trec', dir: 'memory-e5', minNdcg: 0.76, minMrr: 0.93 },
  { dataset: 'trec-zh', dir: 'memory-e5', minNdcg: 0.68, minMrr: 0.9 },
  { dataset: 'scifact', dir: 'scifact-e5', minNdcg: 0.72, minMrr: 0.69 },
  { dataset: 'synthetic', dir: 'synthetic-e5', minNdcg: 0.99, minMrr: 0.98 },
  { dataset: 'project', dir: 'project-e5', minNdcg: 0.88, minMrr: 0.84 }
]

const PATTERN = /nDCG@10=([\d.]+).*MRR@10=([\d.]+).*p50=(\d+)ms/
const results = []
let failed = false

for (const testCase of CASES) {
  if (only && only.length > 0 && !only.includes(testCase.dataset)) continue
  process.stdout.write(`\n[regress] ${testCase.dataset} ... `)
  const run = spawnSync(process.execPath, ['tools/rag-bench.mjs', `--dataset=${testCase.dataset}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPENFUTURE_MODEL_DIR: MODELS,
      OPENFUTURE_BENCH_MEMORY_DIR: join(BENCH, testCase.dir),
      OPENFUTURE_RETRIEVAL_MODE: process.env.OPENFUTURE_RETRIEVAL_MODE || 'hybrid-rerank'
    },
    encoding: 'utf8',
    timeout: 20 * 60 * 1000
  })
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  const match = [...output.matchAll(new RegExp(PATTERN.source, 'g'))].pop()
  if (!match) {
    failed = true
    process.stdout.write('NO RESULT\n')
    console.error(output.split('\n').slice(-12).join('\n'))
    continue
  }
  const [, ndcg, mrr, p50] = match
  const n = Number(ndcg)
  const m = Number(mrr)
  const ok = n >= testCase.minNdcg && m >= testCase.minMrr
  if (!ok) failed = true
  results.push({ ...testCase, n, m, p50: Number(p50), ok })
  process.stdout.write(`${ok ? 'OK' : 'FAIL'} nDCG@10=${ndcg} MRR=${mrr} p50=${p50}ms\n`)
}

const pad = (text, width) => String(text).padEnd(width)
console.log('\ncorpus      nDCG@10   MRR     p50      floor   status')
for (const row of results) {
  console.log(
    `${pad(row.dataset, 11)} ${String(row.n.toFixed(4)).padEnd(8)} ${String(row.m.toFixed(4)).padEnd(7)} ` +
      `${String(`${row.p50}ms`).padEnd(8)} ${String(row.minNdcg).padEnd(7)} ${row.ok ? 'ok' : 'REGRESSION'}`
  )
}

if (failed) {
  console.error('\nRAG REGRESSION FAILED')
  process.exit(1)
}
console.log('\nRAG REGRESSION PASSED')
