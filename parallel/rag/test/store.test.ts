import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RagStore } from '../src/store.ts'
import type { SourceRecord, StoredChunk } from '../src/types.ts'

function source(revision: string): SourceRecord {
  return {
    projectId: 'p1',
    sourceId: 'doc',
    fileName: 'doc.pdf',
    path: '/tmp/doc.pdf',
    revision,
    status: 'active',
    kind: 'pdf',
    bytes: 10,
    sha256: revision,
    parser: 'pdf-fallback',
    parserVersion: '1',
    pages: 1,
    ocrPages: [],
    importedAt: new Date().toISOString(),
    warnings: []
  }
}

function chunk(revision: string, ordinal: number, text: string): StoredChunk {
  return {
    projectId: 'p1',
    sourceId: 'doc',
    sourceRevision: revision,
    chunkId: `doc#r${revision}#${String(ordinal).padStart(3, '0')}`,
    ordinal,
    page: 1,
    charStart: 0,
    charEnd: text.length,
    kind: 'paragraph',
    text,
    tokenCount: text.length,
    contentHash: `hash-${ordinal}`
  }
}

test('store: supersede, replace and revoke keep the active set exact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-store-'))
  const store = new RagStore(join(dir, 'index.sqlite'))
  store.upsertSource(source('r1'))
  store.replaceChunks('p1', 'doc', 'r1', [chunk('r1', 0, '保修 36 个月'), chunk('r1', 1, 'OF-2200 Pro')])
  assert.equal(store.countChunks('p1'), 2)
  assert.deepEqual(store.activeSourceRevisions('p1'), new Map([['doc', 'r1']]))

  store.upsertSource(source('r2'))
  store.replaceChunks('p1', 'doc', 'r2', [chunk('r2', 0, '保修 24 个月')])
  assert.equal(store.countChunks('p1'), 1, 'old revision chunks must be removed')
  assert.equal(store.activeChunks('p1')[0]?.sourceRevision, 'r2')
  assert.equal(store.listSources('p1').filter((row) => row.status === 'active').length, 1)

  assert.equal(store.indexBytes() > 0, true)
  store.setSourceStatus('p1', 'doc', 'revoked')
  assert.equal(store.countChunks('p1'), 0)
  assert.equal(store.getSource('p1', 'doc')?.status, undefined, 'revoked source is no longer active')
  assert.equal(store.getSource('p1', 'doc', 'r2')?.status, 'revoked')
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('store: FTS candidates tolerate short CJK terms', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-store-'))
  const store = new RagStore(join(dir, 'index.sqlite'))
  store.upsertSource(source('r1'))
  store.replaceChunks('p1', 'doc', 'r1', [chunk('r1', 0, '整机保修 36 个月，备件供应周期 7 年')])
  assert.deepEqual(store.ftsCandidates('p1', '保修', 10), [])
  assert.deepEqual(store.ftsCandidates('p1', '保修 36', 10), [])
  store.close()
  rmSync(dir, { recursive: true, force: true })
})
