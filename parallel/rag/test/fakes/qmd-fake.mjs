/**
 * In-memory QMD double used by tests and by the acceptance run when the real
 * @tobilu/qmd package (native better-sqlite3 + GGUF models) is not installed.
 *
 * It mirrors the v2.8.3 SDK surface the adapter relies on:
 *   createStore({ dbPath, config }) → store
 *   store.update({ collections }) / embed({}) / searchLex / searchVector / search / close
 * Scores are lexical coverage and hashed-vector cosine, fused with RRF k=60.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const TERM = /\p{Script=Han}+|[A-Za-z0-9][A-Za-z0-9._+#-]*/gu

function normalize(text) {
  return text.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ')
}

function terms(query) {
  const out = new Set()
  for (const match of normalize(query).matchAll(TERM)) {
    const term = match[0]
    if (/^\p{Script=Han}+$/u.test(term)) {
      if (term.length >= 2) out.add(term)
      for (let i = 0; i + 2 <= term.length; i += 1) out.add(term.slice(i, i + 2))
    } else if (term.length >= 2) {
      out.add(term)
    }
  }
  return [...out]
}

function coverage(text, queryTerms) {
  const haystack = normalize(text)
  if (queryTerms.length === 0) return 0
  let hits = 0
  for (const term of queryTerms) if (haystack.includes(term)) hits += 1
  return hits / queryTerms.length
}

function fnv(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function embed(text, dims = 128) {
  const vector = new Float32Array(dims)
  const tokens = new Set()
  for (const match of normalize(text).matchAll(TERM)) {
    tokens.add(match[0])
    if (/^\p{Script=Han}+$/u.test(match[0])) {
      for (let i = 0; i + 2 <= match[0].length; i += 1) tokens.add(match[0].slice(i, i + 2))
    }
  }
  for (const token of tokens) {
    const hash = fnv(token)
    vector[hash % dims] += ((hash >>> 16) & 1) === 0 ? 1 : -1
  }
  let norm = 0
  for (const value of vector) norm += value * value
  if (norm > 0) for (let i = 0; i < dims; i += 1) vector[i] /= Math.sqrt(norm)
  return vector
}

function cosine(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i]
  return Math.max(0, dot)
}

export async function createStore({ dbPath, config } = {}) {
  if (process.env.QMD_FAKE_FAIL === '1') throw new Error('fake QMD disabled by QMD_FAKE_FAIL')
  const collections = config?.collections ?? {}
  let docs = []
  let embedded = false

  const api = {
    async update({ collections: names } = {}) {
      const selected = names ?? Object.keys(collections)
      const next = []
      for (const name of selected) {
        const dir = collections[name]?.path
        if (!dir) continue
        let files = []
        try {
          files = readdirSync(dir).filter((file) => file.endsWith('.md'))
        } catch {
          continue
        }
        for (const file of files) {
          const text = readFileSync(join(dir, file), 'utf8')
          const title = (text.match(/^#\s+(.*)$/m) ?? [])[1] ?? file
          next.push({ collection: name, path: file, text, title, docid: `#${fnv(file).toString(16).slice(0, 6)}` })
        }
      }
      docs = next
      return { collections: selected, indexed: docs.length, updated: docs.length, unchanged: 0, removed: 0, needsEmbedding: !embedded }
    },
    async embed() {
      embedded = true
      docs = docs.map((doc) => ({ ...doc, vector: embed(doc.text) }))
      return { embedded: docs.length }
    },
    async searchLex(query, { limit = 10 } = {}) {
      const queryTerms = terms(query)
      return docs
        .map((doc) => ({ doc, score: coverage(doc.text, queryTerms) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((row) => ({ file: `qmd://${row.doc.collection}/${row.doc.path}`, title: row.doc.title, score: row.score }))
    },
    async searchVector(query, { limit = 10 } = {}) {
      const queryVector = embed(query)
      return docs
        .map((doc) => ({ doc, score: cosine(queryVector, doc.vector ?? embed(doc.text)) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((row) => ({ file: `qmd://${row.doc.collection}/${row.doc.path}`, title: row.doc.title, score: row.score }))
    },
    async search({ query, limit = 10 }) {
      const lex = await api.searchLex(query, { limit })
      const vec = await api.searchVector(query, { limit })
      const fused = new Map()
      const add = (row, index) => {
        const current = fused.get(row.file) ?? { row, score: 0 }
        current.score += 1 / (60 + index + 1)
        fused.set(row.file, current)
      }
      lex.forEach(add)
      vec.forEach(add)
      return [...fused.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((entry) => ({ file: entry.row.file, title: entry.row.title, score: entry.score }))
    },
    async close() {}
  }
  return api
}

export default { createStore }
