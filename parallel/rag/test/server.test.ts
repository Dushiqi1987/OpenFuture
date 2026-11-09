import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startServer, type RunningServer } from '../src/server.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixtures = join(root, 'fixtures')
const fakeQmd = pathToFileURL(join(root, 'test', 'fakes', 'qmd-fake.mjs')).href

async function startOnTestPort(dataDir: string): Promise<RunningServer> {
  try {
    return await startServer({ dataDir, projectId: 'srv', port: 19731, qmdModule: fakeQmd, useDocling: false })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/EADDRINUSE/.test(message)) throw error
    return await startServer({ dataDir, projectId: 'srv', port: 19741, qmdModule: fakeQmd, useDocling: false })
  }
}

test('server: health → import → search → revoke over HTTP on 127.0.0.1', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rag-server-'))
  const running = await startOnTestPort(dataDir)
  const base = `http://127.0.0.1:${running.port}`
  try {
    const health = await (await fetch(`${base}/health`)).json() as { ok: boolean; diagnostics: { qmd: { engine: string } } }
    assert.equal(health.ok, true)
    assert.equal(health.diagnostics.qmd.engine, 'qmd')

    const imported = await (await fetch(`${base}/import`, {
      method: 'POST',
      body: JSON.stringify({ path: join(fixtures, 'spec-cn-en.pdf'), sourceId: 'spec' })
    })).json() as { source: { revision: string }; chunkCount: number }
    assert.equal(imported.chunkCount > 0, true)

    const search = await (await fetch(`${base}/search`, {
      method: 'POST',
      body: JSON.stringify({ query: 'OF-2200 Pro 最大吞吐量', n: 3, layout: 'B' })
    })).json() as { hits: Array<{ fileName: string; locator: { page: number } }>; selected: unknown[] }
    assert.equal(search.hits.some((hit) => hit.fileName === 'spec' || hit.fileName === 'spec-cn-en.pdf'), true)

    const bad = await fetch(`${base}/search`, { method: 'POST', body: JSON.stringify({ query: '' }) })
    assert.equal(bad.status, 400)

    const revoked = await (await fetch(`${base}/revoke`, { method: 'POST', body: JSON.stringify({ sourceId: 'spec' }) })).json() as { source: { status: string } }
    assert.equal(revoked.source.status, 'revoked')
    const after = await (await fetch(`${base}/search`, { method: 'POST', body: JSON.stringify({ query: 'OF-2200 Pro 最大吞吐量' }) })).json() as { hits: Array<{ fileName: string }> }
    assert.equal(after.hits.length, 0)
  } finally {
    await running.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
