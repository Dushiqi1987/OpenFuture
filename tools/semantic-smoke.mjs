/**
 * Semantic retrieval smoke test.
 *
 * Loads the real bge-base-zh embedding model and the bge-reranker-base
 * cross-encoder from `<repo>/.scratch/models` (or OPENFUTURE_MODEL_DIR) and
 * checks that a near passage outranks an unrelated one. The first run downloads
 * ~380 MB of quantized ONNX weights; later runs only load local files.
 */
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
process.env.OPENFUTURE_MODEL_DIR ||= join(ROOT, '.scratch', 'models')

const { embedTexts, rerankScores, modelsReady } = await import('../src/memory-host/semantic.ts')

const near = 'HALCYON-001 的默认阈值是 10 秒，变更窗口为每周三 02:00–04:00。'
const far = '认证服务的访问令牌有效期是 30 分钟，刷新令牌有效期是 7 天。'
const query = 'HALCYON-001 的默认阈值是多少？'

const vectors = await embedTexts([near, far, query])
if (vectors.length !== 3) throw new Error(`expected 3 vectors, got ${vectors.length}`)
const [a, b, q] = vectors
if (!a || !b || !q) throw new Error('missing embedding')
if (a.length !== 768) throw new Error(`expected 768 dims, got ${a.length}`)

const cosine = (left, right) => left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0)
const nearScore = cosine(q, a)
const farScore = cosine(q, b)
if (!(nearScore > farScore + 0.1)) {
  throw new Error(`embedding order wrong: near=${nearScore.toFixed(3)} far=${farScore.toFixed(3)}`)
}

const scores = await rerankScores(query, [near, far])
if (!scores || scores.length !== 2) throw new Error('reranker returned no scores')
const [rankNear, rankFar] = scores
if (!(rankNear > rankFar)) {
  throw new Error(`rerank order wrong: near=${rankNear.toFixed(4)} far=${rankFar.toFixed(4)}`)
}

console.log(
  `embeddings -> dim=768 near=${nearScore.toFixed(3)} far=${farScore.toFixed(3)} ` +
    `rerank near=${rankNear.toFixed(4)} far=${rankFar.toFixed(4)}`
)
const ready = modelsReady()
if (!ready.embedder || !ready.reranker) throw new Error('models did not report ready')
console.log('SEMANTIC SMOKE PASSED')
