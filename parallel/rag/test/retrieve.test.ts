import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRagAdapter } from '../src/adapter.ts'
import type { SearchResult } from '../src/types.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixtures = join(root, 'fixtures')
const fakeQmd = pathToFileURL(join(root, 'test', 'fakes', 'qmd-fake.mjs')).href

interface QuerySpec {
  id: string
  query: string
  kind: string
  gold: { sourceFile: string; page: number; phrase: string }
}

const queries = JSON.parse(readFileSync(join(fixtures, 'queries.json'), 'utf8')) as { queries: QuerySpec[] }

function pageOfHit(hit: SearchResult['hits'][number]): string {
  return `${hit.fileName}:${hit.locator.page}`
}

test('retrieval: gold pages are recallable and scanned sources stay out', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rag-retrieve-'))
  const adapter = createRagAdapter({ dataDir, projectId: 'p1', qmdModule: fakeQmd, useDocling: false })
  await adapter.initialize()
  await adapter.importSource({ path: join(fixtures, 'spec-cn-en.pdf') })
  await adapter.importSource({ path: join(fixtures, 'handbook-cn-en.md') })
  await adapter.importSource({ path: join(fixtures, 'scan-cn-en.pdf') })

  for (const spec of queries.queries) {
    const result = await adapter.search({ query: spec.query, k: 30, n: 5, layout: 'A' })
    const pages = result.hits.map(pageOfHit)
    if (spec.kind === 'scan') {
      assert.equal(pages.some((page) => page.startsWith('scan-cn-en.pdf')), false, 'scanned PDF has no text chunks')
      continue
    }
    assert.equal(
      pages.includes(`${spec.gold.sourceFile}:${spec.gold.page}`),
      true,
      `${spec.id} expected ${spec.gold.sourceFile}:${spec.gold.page}, got ${pages.join(', ')}`
    )
  }
  await adapter.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('retrieval: layout B uses two-end ordering over the same evidence set', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rag-layout-'))
  const adapter = createRagAdapter({ dataDir, projectId: 'p1', qmdModule: fakeQmd, useDocling: false })
  await adapter.initialize()
  await adapter.importSource({ path: join(fixtures, 'spec-cn-en.pdf') })
  await adapter.importSource({ path: join(fixtures, 'handbook-cn-en.md') })

  const a = await adapter.search({ query: 'OF-2200 Pro 的保修期和吞吐量', k: 30, n: 5, layout: 'A' })
  const b = await adapter.search({ query: 'OF-2200 Pro 的保修期和吞吐量', k: 30, n: 5, layout: 'B' })
  assert.deepEqual(new Set(a.selected.map((item) => item.chunkId)), new Set(b.selected.map((item) => item.chunkId)))
  const ordered = a.selected.map((item) => item.chunkId)
  const expected: string[] = []
  let low = 0
  let high = ordered.length - 1
  let takeLow = true
  while (low <= high) {
    expected.push(takeLow ? (ordered[low++] as string) : (ordered[high--] as string))
    takeLow = !takeLow
  }
  assert.deepEqual(b.selected.map((item) => item.chunkId), expected)
  await adapter.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('retrieval: revoking a source invalidates its evidence immediately', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rag-revoke-'))
  const adapter = createRagAdapter({ dataDir, projectId: 'p1', qmdModule: fakeQmd, useDocling: false })
  await adapter.initialize()
  await adapter.importSource({ path: join(fixtures, 'spec-cn-en.pdf') })
  const before = await adapter.search({ query: 'OF-2200 Pro 1200 页/分钟', n: 5 })
  assert.equal(before.hits.some((hit) => hit.fileName === 'spec-cn-en.pdf'), true)

  await adapter.revokeSource('spec-cn-en')
  const after = await adapter.search({ query: 'OF-2200 Pro 1200 页/分钟', n: 5 })
  assert.equal(after.hits.some((hit) => hit.fileName === 'spec-cn-en.pdf'), false)
  assert.equal(after.diagnostics.revokedDropped >= 0, true)
  await adapter.close()
  rmSync(dataDir, { recursive: true, force: true })
})
