import { cosine, hashEmbedding, reciprocalRankFusion, rerankScore } from '../src/memory-host/retrieval.ts'

const assert = (condition, message) => {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

// 1. Hashed embeddings capture character overlap that trigram BM25 misses.
const query = hashEmbedding('存储引擎第 4 章的超时配置')
const near = hashEmbedding('存储引擎 第 4 章：超时配置与默认阈值')
const far = hashEmbedding('计费服务第 2 章的退款流程')
const nearScore = cosine(query, near)
const farScore = cosine(query, far)
console.log(`embedding -> near=${nearScore.toFixed(3)} far=${farScore.toFixed(3)}`)
assert(nearScore > farScore + 0.05, 'near doc must be closer than the unrelated doc')

// 2. RRF rewards documents that appear in several channels.
const fused = reciprocalRankFusion([
  { weight: 1, items: [{ kind: 'evidence', id: 'a' }, { kind: 'evidence', id: 'b' }] },
  { weight: 0.55, items: [{ kind: 'evidence', id: 'b' }] }
])
console.log(`rrf -> a=${fused.get('evidence:a')?.toFixed(4)} b=${fused.get('evidence:b')?.toFixed(4)}`)
assert((fused.get('evidence:b') ?? 0) > (fused.get('evidence:a') ?? 0), 'dual-list doc must outrank single-list doc')

// 3. The reranker prefers identifier and title hits over generic prose.
const anchored = rerankScore('HALCYON-001 的默认阈值是多少', {
  title: 'storage-01.md',
  body: '# 存储引擎运维手册 第 1 章：HALCYON-001\n\n服务代码：HALCYON-001\n默认阈值：10 秒'
})
const generic = rerankScore('HALCYON-001 的默认阈值是多少', {
  title: 'billing-03.md',
  body: '计费服务第 3 章介绍对账流程，阈值与超时按季度复核。'
})
console.log(`rerank -> anchored=${anchored.toFixed(2)} generic=${generic.toFixed(2)}`)
assert(anchored > generic + 4, 'anchor hit must dominate generic text')

console.log('RETRIEVAL SMOKE PASSED')
