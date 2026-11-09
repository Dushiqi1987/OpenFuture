import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parsePdfBuffer } from '../src/docling/pdf.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixtures = join(root, 'fixtures')

function read(name: string): Buffer {
  return readFileSync(join(fixtures, name))
}

test('electronic PDF: pages, locators and heading blocks', () => {
  const parsed = parsePdfBuffer(read('spec-cn-en.pdf'), 'spec-cn-en.pdf')
  assert.equal(parsed.parser, 'pdf-fallback')
  assert.equal(parsed.pages.length, 3)
  assert.equal(parsed.pages[0]?.ocr, 'not-needed')
  assert.equal(parsed.blocks.length > 20, true)

  const page1 = parsed.pages[0]?.text ?? ''
  const page2 = parsed.pages[1]?.text ?? ''
  const page3 = parsed.pages[2]?.text ?? ''
  assert.match(page1, /OF-2200 Pro/)
  assert.match(page1, /1200/)
  assert.match(page1, /保修 36 个月/)
  assert.match(page2, /跨页续行/)
  assert.match(page2, /OF-2200 Max 1800/)
  assert.match(page3, /E-RETRY-30/)

  for (const block of parsed.blocks) {
    const pageText = parsed.pages[block.page - 1]?.text ?? ''
    assert.equal(
      pageText.slice(block.charStart, block.charEnd),
      block.text,
      `block ${block.id} must map exactly onto its page text`
    )
  }

  const headings = parsed.blocks.filter((block) => block.kind === 'heading')
  assert.equal(headings.length >= 3, true)
  assert.equal(parsed.warnings.length, 0)
})

test('scanned PDF: no text layer is reported instead of silently succeeding', () => {
  const parsed = parsePdfBuffer(read('scan-cn-en.pdf'), 'scan-cn-en.pdf')
  assert.equal(parsed.pages.length, 2)
  assert.equal(parsed.blocks.length, 0)
  for (const page of parsed.pages) {
    assert.equal(page.ocr, 'required')
    assert.equal(page.text.length, 0)
  }
  assert.equal(parsed.warnings.length > 0, true)
  assert.match(parsed.warnings.join('\n'), /OCR required/)
})

test('markdown parser keeps offsets aligned with the synthetic page', async () => {
  const { parseMarkdown } = await import('../src/markdown.ts')
  const text = readFileSync(join(fixtures, 'handbook-cn-en.md'), 'utf8')
  const parsed = parseMarkdown(text, 'handbook-cn-en.md')
  assert.equal(parsed.parser, 'markdown')
  assert.equal(parsed.pages.length, 1)
  const pageText = parsed.pages[0]?.text ?? ''
  for (const block of parsed.blocks) {
    assert.equal(pageText.slice(block.charStart, block.charEnd), block.text)
  }
  assert.equal(parsed.blocks[0]?.kind, 'heading')
  assert.match(pageText, /备件供应周期为 7 年/)
})
