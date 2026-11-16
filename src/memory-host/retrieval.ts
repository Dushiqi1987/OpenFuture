/**
 * Offline hybrid retrieval helpers.
 *
 * The desktop build must work without downloading an embedding model, so the
 * dense channel uses signed feature hashing over character n-grams. It is not
 * a replacement for a trained encoder, but it adds the fuzzy overlap that a
 * trigram BM25 index lacks (word order, near-synonyms sharing characters) and
 * is fully deterministic, so the evaluation harness can compare runs.
 *
 * QMD remains an optional third channel; its scores are fused here too.
 */

/** Runtime knobs are read once per process. */
export type RetrievalMode = 'lexical' | 'hybrid' | 'hybrid-rerank'

export const RETRIEVAL_MODE: RetrievalMode = (() => {
  const raw = (process.env.OPENFUTURE_RETRIEVAL_MODE ?? '').trim()
  return raw === 'lexical' || raw === 'hybrid' || raw === 'hybrid-rerank' ? raw : 'hybrid-rerank'
})()

const EMBEDDING_DIM = 192

function hash32(value: string, seed = 0): number {
  let hash = 2166136261 ^ seed
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Signed feature hashing over ASCII words and character n-grams. */
export function hashEmbedding(text: string, dim = EMBEDDING_DIM): Float32Array {
  const normalized = text.normalize('NFKC').toLowerCase()
  const vector = new Float32Array(dim)
  const add = (feature: string, weight: number): void => {
    const hash = hash32(feature)
    const index = hash % dim
    vector[index] = (vector[index] ?? 0) + ((hash & 0x80000000) === 0 ? weight : -weight)
  }
  for (const word of normalized.match(/[a-z0-9][a-z0-9_.-]*/g) ?? []) add(`w:${word}`, 1.6)
  const chars = [...normalized.replace(/\s+/g, ' ')]
  for (let index = 0; index < chars.length; index += 1) {
    add(`u:${chars[index]}`, 0.25)
    if (index + 1 < chars.length) add(`b:${chars[index]}${chars[index + 1]}`, 0.9)
    if (index + 2 < chars.length) add(`t:${chars[index]}${chars[index + 1]}${chars[index + 2]}`, 1.2)
  }
  let norm = 0
  for (const value of vector) norm += value * value
  if (norm > 0) {
    const scale = 1 / Math.sqrt(norm)
    for (let index = 0; index < vector.length; index += 1) vector[index] = (vector[index] ?? 0) * scale
  }
  return vector
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const size = Math.min(a.length, b.length)
  let dot = 0
  for (let index = 0; index < size; index += 1) dot += (a[index] ?? 0) * (b[index] ?? 0)
  return dot
}

export interface RankedRef {
  kind: string
  id: string
}

export interface RankedList {
  weight: number
  items: RankedRef[]
}

/**
 * Reciprocal Rank Fusion. Each list contributes weight / (k + rank + 1) to the
 * document's first occurrence; duplicates inside one list are ignored so a
 * noisy channel cannot vote twice for the same chunk.
 */
export function reciprocalRankFusion(lists: RankedList[], k = 60): Map<string, number> {
  const scores = new Map<string, number>()
  for (const list of lists) {
    const seen = new Set<string>()
    list.items.forEach((item, rank) => {
      const key = `${item.kind}:${item.id}`
      if (seen.has(key)) return
      seen.add(key)
      scores.set(key, (scores.get(key) ?? 0) + list.weight / (k + rank + 1))
    })
  }
  return scores
}

function trigrams(text: string): string[] {
  const chars = [...text]
  const grams: string[] = []
  for (let index = 0; index + 3 <= chars.length; index += 1) grams.push(chars.slice(index, index + 3).join(''))
  return grams
}

function longestCommonRun(a: string, b: string, cap = 12): number {
  if (!a || !b) return 0
  const previous = new Uint16Array(b.length + 1)
  let best = 0
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] !== b[j - 1]) {
        previous[j] = 0
        continue
      }
      const value = (previous[j - 1] ?? 0) + 1
      previous[j] = value
      if (value > best) best = value
    }
  }
  return Math.min(best, cap)
}

/**
 * Cheap cross-encoder stand-in: identifiers dominate, then title hits, then
 * trigram coverage of the body and a proximity bonus from the longest shared
 * run. Scores are relative, not calibrated probabilities.
 */
export function rerankScore(query: string, doc: { title: string; body: string }): number {
  const q = query.normalize('NFKC').toLowerCase()
  const title = doc.title.normalize('NFKC').toLowerCase()
  const body = doc.body.normalize('NFKC').toLowerCase()
  const haystack = `${title}\n${body}`
  let score = 0
  for (const anchor of q.match(/[a-z0-9][a-z0-9_-]+/g) ?? []) {
    if (haystack.includes(anchor)) score += 4
    if (title.includes(anchor)) score += 2
  }
  const grams = trigrams(q.replace(/\s+/g, ' '))
  if (grams.length > 0) {
    let hit = 0
    for (const gram of new Set(grams)) if (body.includes(gram)) hit += 1
    score += (hit / new Set(grams).size) * 3
  }
  score += (longestCommonRun(q, haystack) / 12) * 2
  return score
}
