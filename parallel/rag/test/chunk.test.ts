import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chunkDocument, estimateTokens } from '../src/chunk.ts'
import { parsePdfBuffer } from '../src/docling/pdf.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const document = parsePdfBuffer(readFileSync(join(root, 'fixtures', 'spec-cn-en.pdf')), 'spec-cn-en.pdf')

test('chunks stay inside one page and keep exact ids', () => {
  const chunks = chunkDocument(document, { projectId: 'p1', sourceId: 'spec', sourceRevision: 'rev1' })
  assert.equal(chunks.length >= 3, true)
  const ids = new Set<string>()
  for (const chunk of chunks) {
    assert.match(chunk.chunkId, /^spec#rrev1#\d{3}$/)
    assert.equal(ids.has(chunk.chunkId), false)
    ids.add(chunk.chunkId)
    const pageText = document.pages[chunk.page - 1]?.text ?? ''
    assert.equal(pageText.includes(chunk.text), true, `chunk ${chunk.chunkId} must come from page ${chunk.page}`)
    assert.equal(chunk.tokenCount, estimateTokens(chunk.text))
    assert.equal(chunk.tokenCount <= 790, true)
    assert.equal(chunk.kind === 'table' || chunk.kind === 'list' || chunk.kind === 'paragraph', true)
  }
  assert.equal(chunks.filter((chunk) => chunk.page === 2).length >= 1, true)
})

test('overlap never crosses a page boundary', () => {
  const chunks = chunkDocument(document, {
    projectId: 'p1',
    sourceId: 'spec',
    sourceRevision: 'rev1',
    targetTokens: 60,
    maxTokens: 120,
    overlapTokens: 30
  })
  for (const chunk of chunks) {
    const pageText = document.pages[chunk.page - 1]?.text ?? ''
    assert.equal(pageText.includes(chunk.text), true, `chunk ${chunk.chunkId} mixes pages`)
  }
})

test('chunk metadata carries revision and heading', () => {
  const chunks = chunkDocument(document, { projectId: 'p1', sourceId: 'spec', sourceRevision: 'abc' })
  assert.equal(chunks.every((chunk) => chunk.sourceRevision === 'abc'), true)
  assert.equal(chunks.some((chunk) => chunk.heading !== undefined), true)
})
