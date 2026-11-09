/**
 * Verify that two workspaces never see each other's memory in the real
 * memory-host process. Run with Electron:
 *   electron.exe tools/p01-isolation-test.cjs
 */
const { app, utilityProcess } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..', '.scratch')
const memoryDir = path.join(root, 'p1-isolation-memory')
const workspaceA = path.join(root, 'p1-isolation-workspace-a')
const workspaceB = path.join(root, 'p1-isolation-workspace-b')
const hostPath = path.join(__dirname, '..', 'out', 'main', 'memory-host.js')

for (const dir of [memoryDir, workspaceA, workspaceB]) fs.mkdirSync(dir, { recursive: true })

let nextId = 0
const pending = new Map()

function call(child, method, params) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout: ${method}`))
    }, 30000)
    pending.set(id, { resolve, reject, timer })
    child.postMessage({ kind: 'request', id, method, params })
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

app.whenReady().then(async () => {
  const child = utilityProcess.fork(hostPath, [], {
    env: { ...process.env, OPENFUTURE_MEMORY_DIR: memoryDir },
    stdio: 'pipe',
    serviceName: 'OpenFuture P1 Isolation'
  })
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk))
  child.on('message', (message) => {
    if (!message || message.kind !== 'response') return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.ok) request.resolve(message.value)
    else request.reject(new Error(message.error?.message || 'rpc failed'))
  })
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('exit', (code) => reject(new Error(`memory-host exited early: ${code}`)))
  })

  try {
    const sourceA = await call(child, 'importSource', {
      workspace: workspaceA,
      title: '隔离资料 A',
      origin: 'test:isolation-a',
      content: 'AONLY_MARKER 阿尔法工作区专用记忆。'
    })
    const sourceB = await call(child, 'importSource', {
      workspace: workspaceB,
      title: '隔离资料 B',
      origin: 'test:isolation-b',
      content: 'BONLY_MARKER 贝塔工作区专用记忆。'
    })
    await call(child, 'setMode', { workspace: workspaceA, mode: 'rag' })
    await call(child, 'setMode', { workspace: workspaceB, mode: 'rag' })

    const aHits = (await call(child, 'search', { workspace: workspaceA, query: 'AONLY_MARKER' })).hits
    const bHits = (await call(child, 'search', { workspace: workspaceB, query: 'BONLY_MARKER' })).hits
    const aLeak = (await call(child, 'search', { workspace: workspaceA, query: 'BONLY_MARKER' })).hits
    const bLeak = (await call(child, 'search', { workspace: workspaceB, query: 'AONLY_MARKER' })).hits

    assert(aHits.length === 1 && aHits[0].citation.sourceId === sourceA.id, 'workspace A did not find its own evidence')
    assert(bHits.length === 1 && bHits[0].citation.sourceId === sourceB.id, 'workspace B did not find its own evidence')
    assert(aLeak.length === 0, 'workspace A leaked workspace B evidence')
    assert(bLeak.length === 0, 'workspace B leaked workspace A evidence')

    console.log(
      JSON.stringify({
        ok: true,
        workspaceA: { id: sourceA.id, hits: aHits.length, leak: aLeak.length },
        workspaceB: { id: sourceB.id, hits: bHits.length, leak: bLeak.length }
      })
    )
    child.kill()
    app.quit()
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }))
    child.kill()
    app.exit(1)
  }
})
