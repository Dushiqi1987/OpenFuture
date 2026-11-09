/**
 * Deterministic local scoring used when QMD (or an embedding model) is absent.
 *
 * - `lexicalScore`: term coverage with CJK bigrams, so 2-character Chinese terms
 *   still match even though the FTS5 trigram tokenizer cannot index them.
 * - `embedText`: feature hashing (FNV-1a into 256 dimensions). It is NOT a
 *   semantic model; it exists to exercise the vector path offline and is always
 *   labelled as `local-hash-vector` in diagnostics. QMD replaces it when present.
 */

const TERM_PATTERN = /\p{Script=Han}+|[A-Za-z0-9][A-Za-z0-9._+#-]*/gu

export function normalize(text: string): string {
  return text.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ')
}

export function queryTerms(query: string): string[] {
  const terms = new Set<string>()
  for (const match of normalize(query).matchAll(TERM_PATTERN)) {
    const term = match[0]
    if (/^\p{Script=Han}+$/u.test(term)) {
      if (term.length >= 2) terms.add(term)
      for (let index = 0; index + 2 <= term.length; index += 1) terms.add(term.slice(index, index + 2))
    } else if (term.length >= 2) {
      terms.add(term)
    }
  }
  return [...terms]
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return count
    count += 1
    from = at + needle.length
  }
}

export function lexicalScore(text: string, terms: string[]): number {
  if (terms.length === 0) return 0
  const haystack = normalize(text)
  let matched = 0
  let weight = 0
  for (const term of terms) {
    const hits = countOccurrences(haystack, term)
    if (hits > 0) {
      matched += 1
      weight += hits * (term.length >= 3 ? 1.4 : 1)
    }
  }
  if (matched === 0) return 0
  const coverage = matched / terms.length
  return Math.min(1, coverage * 0.75 + Math.min(1, weight / 12) * 0.25)
}

export function exactPhraseBonus(text: string, query: string): number {
  const phrase = normalize(query).trim()
  if (phrase.length < 4) return 0
  return normalize(text).includes(phrase) ? 0.15 : 0
}

const DIMS = 256

function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export function embedText(text: string, dims = DIMS): Float32Array {
  const vector = new Float32Array(dims)
  const normalized = normalize(text)
  const tokens = new Set<string>()
  for (const match of normalized.matchAll(TERM_PATTERN)) {
    const term = match[0]
    tokens.add(term)
    if (/^\p{Script=Han}+$/u.test(term)) {
      for (let index = 0; index + 2 <= term.length; index += 1) tokens.add(term.slice(index, index + 2))
    }
  }
  for (const token of tokens) {
    const hash = fnv1a(token)
    const slot = hash % dims
    const sign = ((hash >>> 16) & 1) === 0 ? 1 : -1
    vector[slot] = (vector[slot] ?? 0) + sign
  }
  let norm = 0
  for (let index = 0; index < dims; index += 1) norm += (vector[index] ?? 0) ** 2
  if (norm > 0) {
    const scale = 1 / Math.sqrt(norm)
    for (let index = 0; index < dims; index += 1) vector[index] = (vector[index] ?? 0) * scale
  }
  return vector
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let index = 0; index < a.length; index += 1) dot += (a[index] ?? 0) * (b[index] ?? 0)
  return Math.max(0, dot)
}

/** Words and model identifiers from the query, used by the reranker. */
export function queryProtectTerms(query: string): string[] {
  const terms = query.match(/[A-Za-z]{2,}-?\d{2,}[A-Za-z0-9]*|[A-Z]{2,}-\d+/g) ?? []
  return [...new Set(terms.map((term) => term.toUpperCase()))]
}
