import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { probeDocling, runDocling } from '../src/docling/client.ts'
import { RagError } from '../src/types.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const stub = join(root, 'test', 'fakes', 'docling_stub.py')
const pdf = join(root, 'fixtures', 'spec-cn-en.pdf')

async function pythonAvailable(): Promise<boolean> {
  const probe = await probeDocling({ python: process.env.RAG_DOCLING_PYTHON ?? 'python', timeoutMs: 20000 })
  return probe.reason === undefined || !/cannot start|ENOENT|not recognized/i.test(probe.reason)
}

test('docling client: worker protocol is exercised with a stub (real docling not installed)', async (t) => {
  if (!(await pythonAvailable())) {
    t.skip('local python is not available')
    return
  }
  const result = await runDocling(pdf, 'spec-cn-en.pdf', {
    python: process.env.RAG_DOCLING_PYTHON ?? 'python',
    worker: stub,
    timeoutMs: 60000
  })
  assert.equal(result.document.parser, 'docling')
  assert.equal(result.document.pages.length, 2)
  assert.equal(result.document.pages[1]?.ocr, 'performed')
  assert.equal(result.hybridChunks?.length, 1)
})

test('docling client: a broken worker becomes a typed error', async (t) => {
  if (!(await pythonAvailable())) {
    t.skip('local python is not available')
    return
  }
  await assert.rejects(
    runDocling(join(root, 'fixtures', 'broken.pdf'), 'broken.pdf', {
      python: process.env.RAG_DOCLING_PYTHON ?? 'python',
      worker: stub,
      timeoutMs: 60000
    }),
    (error: unknown) => error instanceof RagError
  )
})

test('docling probe never throws and local install is reported honestly', async () => {
  const probe = await probeDocling({ python: process.env.RAG_DOCLING_PYTHON ?? 'python', timeoutMs: 20000 })
  assert.equal(typeof probe.available, 'boolean')
  if (!probe.available) assert.equal(typeof probe.reason, 'string')
})
