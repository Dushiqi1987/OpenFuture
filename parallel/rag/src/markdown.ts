/**
 * Markdown import for the fallback path: headings, paragraphs and list items
 * become blocks with character offsets into a single synthetic page. The chunker
 * treats this exactly like a parsed document, so evidence locators stay valid.
 */
import type { BlockInfo, ParsedDocument } from './types.ts'

function joinLines(left: string, right: string): string {
  const cjk = /[\u3400-\u9fff]$/u.test(left) || /^[\u3400-\u9fff]/u.test(right)
  return `${left}${cjk ? '' : ' '}${right}`
}

export function parseMarkdown(text: string, fileName: string): ParsedDocument {
  const normalized = text.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const blocks: BlockInfo[] = []
  let page = ''
  let paragraph: string[] = []
  let list: string[] = []

  const append = (kind: BlockInfo['kind'], value: string, level?: number): void => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    const charStart = page.length
    page += trimmed
    const charEnd = page.length
    blocks.push({ id: `b-1-${blocks.length}`, page: 1, kind, text: trimmed, level, charStart, charEnd })
    page += '\n'
  }
  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      append('paragraph', paragraph.reduce((acc, line) => (acc.length === 0 ? line : joinLines(acc, line)), ''))
      paragraph = []
    }
  }
  const flushList = (): void => {
    if (list.length > 0) {
      append('list', list.join('\n'))
      list = []
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flushParagraph()
      flushList()
      append('heading', heading[2], heading[1].length)
      continue
    }
    if (line.trim().length === 0) {
      flushParagraph()
      flushList()
      continue
    }
    const item = /^\s*[-*]\s+(.*)$/.exec(line)
    if (item !== null) {
      flushParagraph()
      list.push(item[1])
      continue
    }
    flushList()
    paragraph.push(line.trim())
  }
  flushParagraph()
  flushList()

  return {
    parser: 'markdown',
    parserVersion: 'markdown/1',
    fileName,
    pages: [{ page: 1, text: page, ocr: 'not-needed', quality: 1 }],
    blocks,
    warnings: []
  }
}
