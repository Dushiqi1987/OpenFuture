// Run after building with: electron.exe tools/rag-pdf-smoke.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { app, utilityProcess } = require('electron')

const root = path.resolve(__dirname, '..')

async function smoke() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'openfuture-rag-pdf-'))
  app.setPath('userData', profile)
  await app.whenReady()
  const child = utilityProcess.fork(path.join(root, 'out/main/memory-host.js'), [], {
    env: {
      ...process.env,
      OPENFUTURE_MEMORY_DIR: path.join(profile, 'memory'),
      OPENFUTURE_WIKI_MCP: '',
      OPENFUTURE_WIKI_ROOT: ''
    },
    stdio: 'pipe'
  })
  let nextId = 0
  function call(method, params) {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.off('message', onMessage)
        reject(new Error(`Memory RPC timed out: ${method}`))
      }, 10_000)
      function onMessage(message) {
        if (message.kind !== 'response' || message.id !== id) return
        clearTimeout(timer)
        child.off('message', onMessage)
        if (message.ok) resolve(message.value)
        else reject(new Error(message.error.message))
      }
      child.on('message', onMessage)
      child.postMessage({ kind: 'request', id, method, params })
    })
  }
  try {
    const workspace = path.join(profile, 'project-a')
    const other = path.join(profile, 'project-b')
    await Promise.all([fs.mkdir(workspace), fs.mkdir(other)])
    for (const dir of [workspace, other]) await call('setMode', { workspace: dir, mode: 'rag' })
    const loadPdf = (name) => fs.readFile(path.join(root, 'parallel/rag/fixtures', name), 'base64')
    const input = { workspace, kind: 'pdf', title: 'Synthetic PDF', origin: 'test:pdf' }
    const source = await call('importSource', { ...input, pdfBase64: await loadPdf('spec-cn-en.pdf') })
    const search = (dir) => call('search', { workspace: dir, query: 'E-RETRY-30' })
    const result = await search(workspace)
    if (process.env.OPENFUTURE_QMD_MODULE) {
      assert.equal(result.engine, 'qmd', result.engineNote)
    }
    const hit = result.hits.find((item) => item.citation.sourceId === source.id)
    assert.match(hit?.citation.locator ?? '', /^page:3:chars:\d+-\d+$/)
    if (process.env.OPENFUTURE_QMD_MODULE) assert.equal(hit.engine, 'qmd')
    assert.equal((await search(other)).hits.length, 0)
    const scan = await loadPdf('scan-cn-en.pdf')
    await assert.rejects(call('importSource', { ...input, pdfBase64: scan }), /OCR/)
    assert.equal((await search(workspace)).hits[0]?.citation.sourceId, source.id)
    await call('revokeSource', { workspace, id: source.id })
    assert.equal((await search(workspace)).hits.length, 0)
    console.log('PASS: PDF page citation, project isolation, failed replacement, and revocation')

    const importText = (dir, title, content) =>
      call('importSource', { workspace: dir, title, content, origin: 'test:' + title })
    const a = await importText(workspace, 'First topic source', 'ALPHAWIKI Sentinel describes the approved storage design.')
    await importText(workspace, 'Second topic source', 'BETAWIKI Sentinel describes the retention plan.')
    const foreign = await importText(other, 'Foreign source', 'FOREIGNWIKI Sentinel must stay isolated.')
    await call('setMode', { workspace, mode: 'wiki' })
    await assert.rejects(call('generateWiki', { workspace, sourceIds: [foreign.id] }), /不属于当前项目/)
    const generate = async () => (await call('generateWiki', { workspace }))[0]
    const draft = await generate()
    assert.match(draft.body, /ALPHAWIKI/)
    assert.match(draft.body, /BETAWIKI/)
    assert.match(draft.reviewDiff, /ALPHAWIKI/)
    const findWiki = () => call('search', { workspace, query: 'ALPHAWIKI' })
    assert.equal((await findWiki()).hits.length, 0)
    const nextDraft = await generate()
    const publish = (page) => call('publishWiki', { workspace, id: page.id, revision: page.revision })
    await assert.rejects(publish(draft), /重新审核/)
    const published = await publish(nextDraft)
    assert.equal((await findWiki()).hits[0]?.id, published.id)
    await importText(workspace, 'Third topic source', 'GAMMAWIKI Sentinel adds another revision.')
    const updated = await generate()
    assert.match(updated.reviewDiff, /GAMMAWIKI/)
    assert.equal((await findWiki()).hits[0]?.id, published.id)
    assert.equal((await publish(updated)).id, published.id)
    await call('revokeSource', { workspace, id: a.id })
    assert.equal((await findWiki()).hits.length, 0)
    console.log('PASS: multi-source Wiki, review diff, stale approval, stable publication, and revocation')
  } finally {
    child.kill()
  }
}

smoke().then(() => app.exit(0), (error) => {
  console.error(error)
  app.exit(1)
})
