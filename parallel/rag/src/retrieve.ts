/**
 * Retrieval orchestrator: lexical + vector + (optional) QMD lists are fused with
 * Reciprocal Rank Fusion (k=60), re-scored by a local ranker with position-aware
 * blending, validated against the active source revision, then assembled into
 * evidence for prompt layout A (descending) or B (two-end).
 */
import { createHash } from 'node:crypto'
import type { Candidate, Evidence, SearchInput, SearchResult, StoredChunk } from './types.ts'
import type { RagStore } from './store.ts'
import type { QmdBridge } from './qmd/index.ts'
import { cosine, embedText, exactPhraseBonus, lexicalScore, queryProtectTerms, queryTerms } from './score.ts'
import { estimateTokens } from './chunk.ts'

export interface RetrieveDeps {
  store: RagStore
  bridge: QmdBridge
  projectId: string
}

const RRF_K = 60

interface Ranked {
  chunkId: string
  score: number
}

interface FusionEntry {
  chunk: StoredChunk
  rrf: number
  engines: Candidate['engines']
  lexical: number
  vector: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function rankedList(scores: Map<string, number>, limit: number): Ranked[] {
  return [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([chunkId, score]) => ({ chunkId, score }))
}

function twoEndOrder<T>(items: T[]): T[] {
  const out: T[] = []
  let low = 0
  let high = items.length - 1
  let takeLow = true
  while (low <= high) {
    if (takeLow) {
      out.push(items[low] as T)
      low += 1
    } else {
      out.push(items[high] as T)
      high -= 1
    }
    takeLow = !takeLow
  }
  return out
}

function evidenceId(chunk: StoredChunk): string {
  return `ev-${createHash('sha256').update(`${chunk.chunkId}|${chunk.sourceRevision}|${chunk.contentHash}`).digest('hex').slice(0, 12)}`
}

export async function retrieve(deps: RetrieveDeps, input: SearchInput): Promise<SearchResult> {
  const started = Date.now()
  const query = (input.query ?? '').trim()
  if (query.length === 0) throw new Error('query must not be empty')
  const k = clamp(input.k ?? 30, 1, 100)
  const n = clamp(input.n ?? 5, 1, 10)
  const mode = input.mode ?? 'hybrid'
  const layout = input.layout ?? 'A'
  const tokenBudget = clamp(input.tokenBudget ?? 2000, 100, 20000)

  const chunks = deps.store.activeChunks(deps.projectId)
  const terms = queryTerms(query)
  const protect = queryProtectTerms(query)

  const lexicalScores = new Map<string, number>()
  const vectorScores = new Map<string, number>()
  const chunksById = new Map<string, StoredChunk>()
  const queryVector = embedText(query)
  for (const chunk of chunks) {
    chunksById.set(chunk.chunkId, chunk)
    const lexical = lexicalScore(`${chunk.heading}\n${chunk.text}`, terms)
    if (lexical > 0) lexicalScores.set(chunk.chunkId, lexical)
    const vector = cosine(queryVector, embedText(chunk.text))
    if (vector > 0) vectorScores.set(chunk.chunkId, vector)
  }

  const lists: { engine: 'fts5' | 'local-hash-vector' | 'qmd'; rows: Ranked[] }[] = []
  // FTS5 trigram candidates get a small lexical boost; 2-char CJK terms fall
  // back to the JS coverage score above (the trigram tokenizer cannot match them).
  const ftsCandidates = new Set(deps.store.ftsCandidates(deps.projectId, query, k))
  if (ftsCandidates.size > 0) {
    for (const chunkId of ftsCandidates) {
      const current = lexicalScores.get(chunkId) ?? 0
      lexicalScores.set(chunkId, Math.min(1, current + 0.15))
    }
  }
  lists.push({ engine: 'fts5', rows: rankedList(lexicalScores, k) })
  lists.push({ engine: 'local-hash-vector', rows: rankedList(vectorScores, k) })

  let qmdStatus = deps.bridge.status
  if (mode === 'hybrid' && qmdStatus.ok) {
    const [qmdLex, qmdVec] = await Promise.all([deps.bridge.searchLex(query, k), deps.bridge.searchVector(query, k)])
    if (qmdLex.length > 0) lists.push({ engine: 'qmd', rows: qmdLex.map((hit) => ({ chunkId: hit.chunkId, score: hit.score })) })
    if (qmdVec.length > 0) lists.push({ engine: 'qmd', rows: qmdVec.map((hit) => ({ chunkId: hit.chunkId, score: hit.score })) })
    qmdStatus = deps.bridge.status
  }

  const fusion = new Map<string, FusionEntry>()
  for (const list of lists) {
    list.rows.forEach((row, index) => {
      const chunk = chunksById.get(row.chunkId)
      if (chunk === undefined) return
      const entry = fusion.get(row.chunkId) ?? {
        chunk,
        rrf: 0,
        engines: {},
        lexical: lexicalScores.get(row.chunkId) ?? 0,
        vector: vectorScores.get(row.chunkId) ?? 0
      }
      const bonus = index === 0 ? 0.05 : index <= 2 ? 0.02 : 0
      entry.rrf += 1 / (RRF_K + index + 1) + bonus
      entry.engines[list.engine] = row.score
      fusion.set(row.chunkId, entry)
    })
  }

  const maxRrf = Math.max(0.0001, ...[...fusion.values()].map((entry) => entry.rrf))
  const ordered = [...fusion.values()].sort((left, right) => right.rrf - left.rrf)
  const ranks = new Map<string, number>()
  ordered.forEach((entry, index) => ranks.set(entry.chunk.chunkId, index + 1))

  const blended = ordered.map((entry) => {
    const rank = ranks.get(entry.chunk.chunkId) ?? 1
    const phrase = exactPhraseBonus(entry.chunk.text, query)
    const protectHit = protect.length > 0 && protect.every((term) => entry.chunk.text.toUpperCase().includes(term)) ? 1 : 0
    const rerank = Math.min(1, entry.lexical * 0.6 + phrase + entry.vector * 0.15 + protectHit * 0.15)
    const rrfNorm = entry.rrf / maxRrf
    const weight = rank <= 3 ? 0.75 : rank <= 10 ? 0.6 : 0.4
    const score = weight * rrfNorm + (1 - weight) * rerank
    return { ...entry, rank, rerank, score }
  })

  blended.sort((left, right) => right.score - left.score)

  let staleDropped = 0
  let revokedDropped = 0
  let deduped = 0
  let lowRelevanceDropped = 0
  const activeRevisions = deps.store.activeSourceRevisions(deps.projectId)
  const seenHash = new Set<string>()
  const candidates: Candidate[] = []
  for (const entry of blended) {
    const source = deps.store.getSource(deps.projectId, entry.chunk.sourceId)
    if (source === null || source.status !== 'active') {
      revokedDropped += 1
      continue
    }
    if (activeRevisions.get(entry.chunk.sourceId) !== entry.chunk.sourceRevision) {
      staleDropped += 1
      continue
    }
    if (seenHash.has(entry.chunk.contentHash)) {
      deduped += 1
      continue
    }
    if (entry.score < 0.08 && entry.lexical < 0.05) {
      lowRelevanceDropped += 1
      continue
    }
    seenHash.add(entry.chunk.contentHash)
    candidates.push({
      chunkId: entry.chunk.chunkId,
      sourceId: entry.chunk.sourceId,
      sourceRevision: entry.chunk.sourceRevision,
      page: entry.chunk.page,
      charStart: entry.chunk.charStart,
      charEnd: entry.chunk.charEnd,
      heading: entry.chunk.heading,
      kind: entry.chunk.kind,
      text: entry.chunk.text,
      score: Number(entry.score.toFixed(6)),
      engines: entry.engines
    })
  }

  const top = candidates.slice(0, n)
  const selectedChunks: Evidence[] = []
  let usedTokens = 0
  for (const candidate of top) {
    const chunk = chunksById.get(candidate.chunkId)
    if (chunk === undefined) continue
    const tokens = estimateTokens(candidate.text)
    if (usedTokens + tokens > tokenBudget && selectedChunks.length > 0) continue
    usedTokens += tokens
    selectedChunks.push({
      evidenceId: evidenceId(chunk),
      rank: selectedChunks.length + 1,
      projectId: deps.projectId,
      sourceId: chunk.sourceId,
      sourceRevision: chunk.sourceRevision,
      chunkId: chunk.chunkId,
      fileName: deps.store.getSource(deps.projectId, chunk.sourceId)?.fileName ?? chunk.sourceId,
      locator: { page: chunk.page, charStart: chunk.charStart, charEnd: chunk.charEnd },
      heading: chunk.heading,
      text: chunk.text,
      score: candidate.score,
      rerankScore: candidate.score,
      contentHash: chunk.contentHash,
      verifiedAt: new Date().toISOString(),
      engine: candidate.engines.qmd !== undefined ? 'qmd' : candidate.engines['local-hash-vector'] !== undefined ? 'local-hash-vector' : 'fts5'
    })
  }

  const selected = layout === 'B' ? twoEndOrder(selectedChunks) : selectedChunks
  return {
    query,
    hits: candidates.slice(0, n).map((candidate, index) => ({
      evidenceId: evidenceId(chunksById.get(candidate.chunkId) as StoredChunk),
      rank: index + 1,
      projectId: deps.projectId,
      sourceId: candidate.sourceId,
      sourceRevision: candidate.sourceRevision,
      chunkId: candidate.chunkId,
      fileName: deps.store.getSource(deps.projectId, candidate.sourceId)?.fileName ?? candidate.sourceId,
      locator: { page: candidate.page, charStart: candidate.charStart, charEnd: candidate.charEnd },
      heading: candidate.heading,
      text: candidate.text,
      score: candidate.score,
      rerankScore: candidate.score,
      contentHash: chunksById.get(candidate.chunkId)?.contentHash ?? '',
      verifiedAt: new Date().toISOString(),
      engine: candidate.engines.qmd !== undefined ? 'qmd' : candidate.engines['local-hash-vector'] !== undefined ? 'local-hash-vector' : 'fts5'
    })),
    candidates,
    selected: selected.map((item, index) => ({ ...item, rank: index + 1 })),
    diagnostics: {
      mode,
      engines: [...new Set(lists.map((list) => list.engine))],
      engineNote: qmdStatus.ok ? undefined : qmdStatus.reason,
      qmd: qmdStatus,
      candidateCount: candidates.length,
      k,
      n,
      staleDropped,
      revokedDropped,
      deduped,
      lowRelevanceDropped,
      latencyMs: Date.now() - started,
      layout,
      ordering: layout === 'B' ? 'two-end (#1→#N→#2→#N-1…)' : 'descending',
      indexBytes: deps.store.indexBytes()
    }
  }
}
