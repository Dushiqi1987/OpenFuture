/**
 * Structure-aware text chunking for the memory index.
 *
 * Design goals:
 * 1. Keep Markdown headings attached to the section they introduce.
 * 2. Split only at paragraph / sentence boundaries (never mid-sentence).
 * 3. Size chunks by *estimated tokens*, not raw characters: Chinese and Latin
 *    text tokenize at very different rates, and embedding models cap at 512
 *    tokens. A 1,200-character Chinese chunk would silently truncate.
 * 4. Overlap each chunk with the last sentence of the previous one.
 *
 * Token estimate: CJK characters ≈ 1 token each, Latin words ≈ 1.3 tokens,
 * punctuation ≈ 0.6 token. This is deliberately conservative.
 */

export interface TextChunk {
  quote: string
  start: number
  end: number
}

const TARGET_TOKENS = 352
const MAX_TOKENS = 448
const OVERLAP_TOKENS = 72
const MIN_TOKENS = 32

interface Block {
  text: string
  start: number
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g) ?? []).length
  const withoutCjk = text.replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g, ' ')
  const words = (withoutCjk.match(/[A-Za-z0-9][A-Za-z0-9_'-]*/g) ?? []).length
  const punctuation = (withoutCjk.replace(/[A-Za-z0-9][A-Za-z0-9_'-]*/g, ' ').match(/\S/g) ?? []).length
  return Math.ceil(cjk + words * 1.3 + punctuation * 0.6)
}

function isHeading(text: string): boolean {
  return /^\s{0,3}#{1,6}\s+\S/.test(text)
}

/** Split a paragraph at sentence boundaries (CJK and Latin punctuation). */
export function splitSentences(paragraph: string): string[] {
  const sentences: string[] = []
  let start = 0
  const push = (end: number): void => {
    const text = paragraph.slice(start, end).trim()
    if (text) sentences.push(text)
    start = end
  }
  for (let index = 0; index < paragraph.length; index += 1) {
    const char = paragraph[index] ?? ''
    if ('。！？!?'.includes(char)) {
      push(index + 1)
      continue
    }
    // A full stop is terminal only when whitespace or the string end follows;
    // that keeps decimals (3.14) and identifiers intact.
    if (char === '.' && (index + 1 >= paragraph.length || /\s/.test(paragraph[index + 1] ?? ''))) {
      push(index + 1)
    }
  }
  push(paragraph.length)
  return sentences
}

function blocks(text: string): Block[] {
  const result: Block[] = []
  const pattern = /\n{2,}/g
  let cursor = 0
  let match: RegExpExecArray | null
  const push = (raw: string, offset: number): void => {
    const trimmed = raw.trim()
    if (!trimmed) return
    const leading = raw.length - raw.trimStart().length
    result.push({ text: trimmed, start: offset + leading })
  }
  while ((match = pattern.exec(text)) !== null) {
    push(text.slice(cursor, match.index), cursor)
    cursor = match.index + match[0].length
  }
  push(text.slice(cursor), cursor)
  return result
}

function lastSentence(text: string): string {
  const sentences = splitSentences(text)
  return sentences[sentences.length - 1] ?? ''
}

/** Cut a single oversized sentence at a character budget derived from its own token density. */
function hardCut(sentence: string, start: number): TextChunk[] {
  const tokens = Math.max(1, estimateTokens(sentence))
  const charsPerToken = sentence.length / tokens
  const budget = Math.max(80, Math.floor(MAX_TOKENS * charsPerToken))
  const pieces: TextChunk[] = []
  for (let index = 0; index < sentence.length; index += budget) {
    const piece = sentence.slice(index, index + budget)
    pieces.push({ quote: piece, start: start + index, end: start + index + piece.length })
  }
  return pieces
}

function pack(blocks_: Block[]): TextChunk[] {
  const segments: TextChunk[] = []
  let pending = ''
  let pendingStart = 0
  let pendingEnd = 0
  const flush = (): void => {
    const quote = pending.trim()
    if (quote) segments.push({ quote, start: pendingStart, end: pendingEnd })
    pending = ''
  }
  const append = (text: string, start: number, end: number): void => {
    if (!pending) {
      pendingStart = start
      pendingEnd = end
    } else {
      pendingEnd = end
    }
    pending += (pending ? '\n\n' : '') + text
  }
  const fits = (extra: string): boolean =>
    estimateTokens(pending ? `${pending}\n\n${extra}` : extra) <= TARGET_TOKENS

  for (const block of blocks_) {
    if (isHeading(block.text)) {
      if (pending) flush()
      append(block.text, block.start, block.start + block.text.length)
      continue
    }
    const blockTokens = estimateTokens(block.text)
    if (blockTokens <= MAX_TOKENS) {
      if (pending && !fits(block.text)) flush()
      append(block.text, block.start, block.start + block.text.length)
      continue
    }
    let offset = 0
    for (const sentence of splitSentences(block.text)) {
      const found = block.text.indexOf(sentence, offset)
      const start = block.start + (found >= 0 ? found : offset)
      offset = (found >= 0 ? found : offset) + sentence.length
      if (estimateTokens(sentence) > MAX_TOKENS) {
        if (pending) flush()
        for (const piece of hardCut(sentence, start)) segments.push(piece)
        continue
      }
      if (pending && !fits(sentence)) flush()
      append(sentence, start, start + sentence.length)
    }
  }
  flush()
  return segments
}

export function chunkText(text: string): TextChunk[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  if (!normalized.trim()) return []
  const leading = normalized.length - normalized.trimStart().length
  const whole = normalized.trim()
  // A document that already fits one embedding window should stay whole:
  // splitting it only fragments the index and duplicates overlap text.
  if (estimateTokens(whole) <= MAX_TOKENS) {
    return [{ quote: whole, start: leading, end: leading + whole.length }]
  }
  const segments = pack(blocks(normalized))
  const chunks: TextChunk[] = []
  for (const segment of segments) {
    const previous = chunks[chunks.length - 1]
    const tail = previous ? lastSentence(previous.quote) : ''
    const usable =
      previous &&
      tail.length >= 12 &&
      !tail.startsWith('#') &&
      estimateTokens(tail) <= OVERLAP_TOKENS &&
      estimateTokens(`${tail}\n\n${segment.quote}`) <= MAX_TOKENS
    if (!usable) {
      chunks.push(segment)
      continue
    }
    chunks.push({
      quote: `${tail}\n\n${segment.quote}`,
      start: Math.max(0, segment.start - tail.length - 2),
      end: segment.end
    })
  }
  // Merge an undersized tail chunk into its predecessor when it still fits.
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1]
    const previous = chunks[chunks.length - 2]
    if (last && previous && estimateTokens(last.quote) < MIN_TOKENS) {
      const merged = `${previous.quote}\n\n${last.quote}`
      if (estimateTokens(merged) <= MAX_TOKENS) {
        chunks.splice(chunks.length - 2, 2, { quote: merged, start: previous.start, end: last.end })
      }
    }
  }
  return chunks
}
