/**
 * Structure-first chunking for the Docling fallback path.
 *
 * The Docling worker uses `HybridChunker` directly. When Docling is absent the
 * fallback parser only yields per-line blocks, so this module recreates the same
 * contract: heading-aware sections, a 400-700 token target, a small overlap
 * inside one page, and a stable locator + content hash per chunk. Chunks never
 * span pages, so a citation always resolves to one page range.
 */
import { createHash } from 'node:crypto'
import type { BlockInfo, ChunkKind, ParsedDocument, StoredChunk } from './types.ts'

export interface ChunkOptions {
  projectId: string
  sourceId: string
  sourceRevision: string
  targetTokens?: number
  maxTokens?: number
  overlapTokens?: number
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f]/g

/** Cheap token estimate: one CJK character ~ one token, four Latin chars ~ one. */
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0
  const latin = text.length - cjk
  return cjk + Math.ceil(latin / 4)
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function splitSentences(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]
  const parts = text.split(/(?<=[。！？!?；;])\s*/)
  const out: string[] = []
  let current = ''
  for (const part of parts) {
    if (current.length > 0 && current.length + part.length > maxChars) {
      out.push(current)
      current = ''
    }
    current += part
    if (current.length >= maxChars) {
      out.push(current)
      current = ''
    }
  }
  if (current.length > 0) out.push(current)
  return out
}

interface Pending {
  parts: string[]
  page: number
  charStart: number
  charEnd: number
  heading: string
  kinds: Set<ChunkKind>
}

export function chunkDocument(document: ParsedDocument, options: ChunkOptions): StoredChunk[] {
  const target = options.targetTokens ?? 420
  const max = options.maxTokens ?? 700
  const overlap = options.overlapTokens ?? 90
  const chunks: StoredChunk[] = []
  const pageText = new Map(document.pages.map((page) => [page.page, page.text]))
  let pending: Pending | null = null
  let currentHeading = ''
  let carry = ''
  let ordinal = 0

  const flush = (): void => {
    if (pending === null) return
    const text = pending.parts.map((part) => part.trim()).filter((part) => part.length > 0).join('\n')
    if (text.length === 0) {
      pending = null
      return
    }
    const kind: ChunkKind = pending.kinds.has('table') ? 'table' : pending.kinds.has('list') ? 'list' : 'paragraph'
    chunks.push({
      projectId: options.projectId,
      sourceId: options.sourceId,
      sourceRevision: options.sourceRevision,
      chunkId: `${options.sourceId}#r${options.sourceRevision}#${String(ordinal).padStart(3, '0')}`,
      ordinal,
      page: pending.page,
      charStart: pending.charStart,
      charEnd: pending.charEnd,
      heading: pending.heading,
      kind,
      text,
      tokenCount: estimateTokens(text),
      contentHash: sha256(text)
    })
    ordinal += 1
    const tail = text.slice(-overlap)
    carry = tail.length >= 24 ? tail : ''
    pending = null
  }

  for (const block of document.blocks) {
    if (block.text.trim().length === 0) continue
    if (pending !== null && pending.page !== block.page) {
      flush()
      // Overlap is page-local: a chunk must never contain text from another page.
      carry = ''
    }
    if (block.kind === 'heading') {
      flush()
      currentHeading = block.text.trim()
      pending = {
        parts: [block.text],
        page: block.page,
        charStart: block.charStart,
        charEnd: block.charEnd,
        heading: currentHeading,
        kinds: new Set<ChunkKind>()
      }
      continue
    }
    const blockKind: ChunkKind = block.kind === 'table' ? 'table' : block.kind === 'list' ? 'list' : 'paragraph'
    const pieces = splitSentences(block.text, Math.max(120, Math.floor(max * 1.6)))
    for (const piece of pieces) {
      if (pending === null) {
        pending = {
          parts: carry.length > 0 ? [carry] : [],
          page: block.page,
          charStart: block.charStart,
          charEnd: block.charEnd,
          heading: currentHeading,
          kinds: new Set<ChunkKind>()
        }
      }
      pending.parts.push(piece)
      pending.charEnd = Math.max(pending.charEnd, block.charEnd)
      pending.kinds.add(blockKind)
      const tokens = estimateTokens(pending.parts.join('\n'))
      if (tokens >= target) {
        const pageLength = pageText.get(block.page)?.length ?? block.charEnd
        pending.charEnd = Math.min(pending.charEnd, pageLength)
        flush()
      }
    }
  }
  flush()

  // Ensure every chunk carries a heading and a page-valid range.
  return chunks.map((chunk) => {
    const length = pageText.get(chunk.page)?.length ?? chunk.charEnd
    return { ...chunk, charStart: Math.min(chunk.charStart, length), charEnd: Math.min(Math.max(chunk.charEnd, chunk.charStart), length) }
  })
}
