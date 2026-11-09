import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RagStore } from '../src/store.ts'
import { QmdBridge } from '../src/qmd/index.ts'
import type { SourceRecord, StoredChunk } from '../src/types.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fakeQmd = pathToFileURL(join(root, 'test', 'fakes', 'qmd-fake.mjs')).href

function record(): SourceRecord {
  return {
    projectId: 'p1',
    sourceId: 'doc',
    fileName: 'doc.md',
    path: '/tmp/doc.md',
    revision: 'r1',
    status: 'active',
    kind: 'markdown',
    bytes: 1,
    sha256: 'sha',
    parser: 'markdown',
    parserVersion: '1',
    pages: 1,
    ocrPages: [],
    importedAt: new Date().toISOString(),
    warnings: []
  }
}

function chunk(text: string): StoredChunk {
  return {
    projectId: 'p1',
    sourceId: 'doc',
    sourceRevision: 'r1',
    chunkId: 'doc#rr1#000',
    ordinal: 0,
    page: 1,
    charStart: 0,
    charEnd: text.length,
    kind: 'paragraph',
    text,
    tokenCount: text.length,
    contentHash: 'h1'
  }
}

test('qmd bridge: fake SDK provides hybrid list and back-mapping', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-qmd-'))
  const store = new RagStore(join(dir, 'index.sqlite'))
  store.upsertSource(record())
  store.replaceChunks('p1', 'doc', 'r1', [chunk('OF-2200 Pro 1200 页/分钟 320 W')])
  const bridge = new QmdBridge({ dataDir: dir, projectId: 'p1', moduleName: fakeQmd })
  const status = await bridge.initialize()
  assert.equal(status.ok, true)
  assert.equal(status.engine, 'qmd')
  const synced = await bridge.sync(store)
  assert.equal(synced.ok, true)
  const lex = await bridge.searchLex('OF-2200 Pro', 10)
  assert.equal(lex.length > 0, true)
  assert.equal(lex[0]?.chunkId, 'doc#rr1#000')
  await bridge.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('qmd bridge: unavailable SDK is reported as lexical-only with a reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-qmd-fail-'))
  process.env.QMD_FAKE_FAIL = '1'
  try {
    const bridge = new QmdBridge({ dataDir: dir, projectId: 'p1', moduleName: fakeQmd })
    const status = await bridge.initialize()
    assert.equal(status.ok, false)
    assert.equal(status.engine, 'local-lexical')
    assert.match(status.reason ?? '', /QMD/)
    await bridge.close()
  } finally {
    delete process.env.QMD_FAKE_FAIL
    rmSync(dir, { recursive: true, force: true })
  }
})
