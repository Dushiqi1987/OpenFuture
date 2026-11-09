/**
 * Shared DTOs for the parallel RAG prototype.
 *
 * Everything here is JSON-serializable: the mainline passes project identity,
 * active sources, a cancellation signal and local dependency configuration in,
 * and receives plain results or pending plans out. No Electron, Pi or QMD types
 * leak through this boundary.
 */

export type ParserKind = 'docling' | 'pdf-fallback' | 'markdown'

export interface PageInfo {
  /** 1-based page number as printed by the parser. */
  page: number
  text: string
  /** `required` means the page has no usable text layer (scan-only). */
  ocr: 'not-needed' | 'required' | 'performed'
  /** 0..1 heuristic: share of the page that carries extractable text. */
  quality: number
  width?: number
  height?: number
}

export type BlockKind = 'heading' | 'paragraph' | 'list' | 'table'

export interface BlockInfo {
  id: string
  page: number
  kind: BlockKind
  text: string
  level?: number
  /** Character range inside the page text (both inclusive/exclusive). */
  charStart: number
  charEnd: number
}

export interface ParsedDocument {
  parser: ParserKind
  parserVersion: string
  fileName: string
  pages: PageInfo[]
  blocks: BlockInfo[]
  warnings: string[]
}

export interface EvidenceLocator {
  page: number
  charStart: number
  charEnd: number
}

export type LayoutKind = 'A' | 'B'

export type ChunkKind = 'paragraph' | 'table' | 'list'

export interface StoredChunk {
  projectId: string
  sourceId: string
  sourceRevision: string
  chunkId: string
  ordinal: number
  page: number
  charStart: number
  charEnd: number
  heading: string
  kind: ChunkKind
  text: string
  tokenCount: number
  contentHash: string
}

export type SourceStatus = 'active' | 'superseded' | 'revoked'

export interface SourceRecord {
  projectId: string
  sourceId: string
  fileName: string
  path: string
  revision: string
  status: SourceStatus
  kind: 'pdf' | 'markdown'
  bytes: number
  sha256: string
  parser: ParserKind
  parserVersion: string
  pages: number
  ocrPages: number
  importedAt: string
  warnings: string[]
}

export interface ImportResult {
  source: SourceRecord
  replacedRevision?: string
  chunkCount: number
  qmd: QmdSyncStatus
}

export interface QmdSyncStatus {
  ok: boolean
  /** True when the index actually contains vector embeddings. */
  vector: boolean
  engine: 'qmd' | 'local-lexical'
  reason?: string
  mode?: string
  collections?: string[]
}

export type RetrievalMode = 'hybrid' | 'lexical'

export type EngineName = 'fts5' | 'local-hash-vector' | 'qmd'

export interface Candidate {
  chunkId: string
  sourceId: string
  sourceRevision: string
  page: number
  charStart: number
  charEnd: number
  heading: string
  kind: ChunkKind
  text: string
  score: number
  engines: Partial<Record<EngineName, number>>
}

export interface Evidence {
  evidenceId: string
  rank: number
  projectId: string
  sourceId: string
  sourceRevision: string
  chunkId: string
  fileName: string
  locator: EvidenceLocator
  heading: string
  text: string
  score: number
  /** Final blended score after the reranker band blend. */
  rerankScore: number
  contentHash: string
  verifiedAt: string
  engine: EngineName
}

export interface RetrievalDiagnostics {
  mode: RetrievalMode
  engines: EngineName[]
  engineNote?: string
  qmd: QmdSyncStatus
  candidateCount: number
  k: number
  n: number
  staleDropped: number
  revokedDropped: number
  deduped: number
  lowRelevanceDropped: number
  latencyMs: number
  layout: LayoutKind
  ordering: string
  indexBytes: number
}

export interface SearchResult {
  query: string
  hits: Evidence[]
  /** What the retrieval layer found before the token budget. */
  candidates: Candidate[]
  /** What the model would receive, in prompt order. */
  selected: Evidence[]
  diagnostics: RetrievalDiagnostics
}

export interface SearchInput {
  query: string
  k?: number
  n?: number
  layout?: LayoutKind
  mode?: RetrievalMode
  model?: string
  tokenBudget?: number
}

export interface RagDiagnostics {
  projectId: string
  dataDir: string
  sources: number
  activeSources: number
  chunks: number
  indexBytes: number
  qmd: QmdSyncStatus
  parsers: Record<string, boolean>
}

export interface ImportInput {
  path: string
  sourceId?: string
}

export interface RagAdapter {
  initialize(): Promise<RagDiagnostics>
  importSource(input: ImportInput): Promise<ImportResult>
  replaceSource(sourceId: string, input: ImportInput): Promise<ImportResult>
  revokeSource(sourceId: string): Promise<SourceRecord | null>
  listSources(): Promise<SourceRecord[]>
  search(input: SearchInput): Promise<SearchResult>
  diagnostics(): Promise<RagDiagnostics>
  close(): Promise<void>
}

export interface RagErrorShape {
  code:
    | 'VALIDATION'
    | 'NOT_FOUND'
    | 'READ_FAILED'
    | 'PARSE_FAILED'
    | 'DOCLING_UNAVAILABLE'
    | 'INDEX_FAILED'
    | 'INTERNAL'
  message: string
  detail?: string
}

export class RagError extends Error {
  readonly code: RagErrorShape['code']
  readonly detail?: string

  constructor(code: RagErrorShape['code'], message: string, detail?: string) {
    super(message)
    this.name = 'RagError'
    this.code = code
    this.detail = detail
  }
}
