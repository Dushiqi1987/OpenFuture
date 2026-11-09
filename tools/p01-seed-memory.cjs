/**
 * Seed a P1 memory database through the real memory-host utility process.
 *
 * Run with the packaged/dev Electron binary, not plain Node:
 *   electron.exe tools/p01-seed-memory.cjs <memoryDir> <workspace> <sources.json>
 */
const { app, utilityProcess } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const [memoryDir, workspace, sourcesFile] = process.argv.slice(2)
if (!memoryDir || !workspace || !sourcesFile) {
  console.error('usage: electron tools/p01-seed-memory.cjs <memoryDir> <workspace> <sources.json>')
  process.exit(2)
}

const parsed = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'))
const sources = Array.isArray(parsed) ? parsed : parsed.sources
if (!Array.isArray(sources)) throw new Error('sources.json must be an array or { sources: [] }')
const hostPath = path.join(__dirname, '..', 'out', 'main', 'memory-host.js')

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

app.whenReady().then(async () => {
  const child = utilityProcess.fork(hostPath, [], {
    env: { ...process.env, OPENFUTURE_MEMORY_DIR: memoryDir },
    stdio: 'pipe',
    serviceName: 'OpenFuture P1 Seed'
  })
  child.stdout?.on('data', (chunk) => process.stdout.write(chunk))
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
    for (const source of sources) {
      const result = await call(child, 'importSource', {
        workspace,
        title: source.title,
        origin: source.origin,
        kind: source.kind || 'markdown',
        content: source.content
      })
      console.log(JSON.stringify({ imported: result.id, title: result.title, evidence: result.evidenceCount }))
    }
    const state = await call(child, 'state', { workspace })
    console.log(JSON.stringify({ state }))
    child.kill()
    app.quit()
  } catch (error) {
    console.error(error)
    child.kill()
    app.exit(1)
  }
})
