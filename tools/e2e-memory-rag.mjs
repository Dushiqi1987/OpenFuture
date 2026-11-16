import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CORPUS = join(ROOT, '.scratch', 'rag-corpus')
const USER_DATA = join(ROOT, '.scratch', 'e2e-memory-userdata')
const WORKSPACE = join(ROOT, '.scratch', 'e2e-memory-workspace')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const log = (line) => console.log(line)

async function pickPort() {
  return new Promise((done) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => done(address.port))
    })
  })
}

function seed(workspace) {
  rmSync(USER_DATA, { recursive: true, force: true })
  mkdirSync(join(USER_DATA, 'config'), { recursive: true })
  writeFileSync(
    join(USER_DATA, 'config', 'settings.json'),
    JSON.stringify(
      { version: 1, workspace, model: null, allowPowerShell: false, computerUse: false, agentDesktop: false, contextCompression: false, subagents: false, subagentConcurrency: 1, groupChat: false },
      null,
      2
    )
  )
  writeFileSync(
    join(USER_DATA, 'config', 'projects.json'),
    JSON.stringify(
      {
        version: 1,
        activeProjectId: 'p-mem',
        projects: [
          { id: 'p-mem', name: 'rag-e2e', canonicalRoot: workspace, memoryPreset: 'rag', defaultModelRef: null, createdAt: 1_700_000_000_000, archivedAt: null, lastConversationId: 'c-mem' }
        ],
        conversations: [{ id: 'c-mem', projectId: 'p-mem', title: 'RAG 验收', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }]
      },
      null,
      2
    )
  )
}

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map() }
  async connect() {
    this.socket = new WebSocket(this.url)
    await new Promise((done, fail) => {
      this.socket.addEventListener('open', done, { once: true })
      this.socket.addEventListener('error', fail, { once: true })
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : '')
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.fail(new Error(message.error.message))
      else pending.done(message.result)
    })
    await this.send('Runtime.enable')
    return this
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((done, fail) => {
      this.pending.set(id, { done, fail })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed')
    return result.result?.value
  }
  async waitFor(expression, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await this.evaluate(expression)
      if (value) return value
      await sleep(250)
    }
    throw new Error(`timeout waiting for ${label}`)
  }
}

async function findTarget(port) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = targets.find((target) => target.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* not listening yet */ }
    await sleep(300)
  }
  throw new Error('no CDP page target')
}

let mock = null
let app = null
function shutdown() {
  try { app?.kill() } catch { /* gone */ }
  try { mock?.kill() } catch { /* gone */ }
}

async function main() {
  const mockPort = await pickPort()
  mock = spawn(process.execPath, [join(ROOT, 'tools', 'mock-model', 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, MOCK_MODEL_PORT: String(mockPort), MOCK_MODEL_ID: 'mock-model', MOCK_DELAY_MS: '8', MOCK_MEMORY: '1' },
    stdio: 'ignore'
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${mockPort}/health`)).ok) break } catch { /* starting */ }
    await sleep(250)
  }
  log('mock model ready')

  seed(CORPUS)
  const cdpPort = await pickPort()
  const env = { ...process.env, OPENFUTURE_USER_DATA: USER_DATA }
  delete env.ELECTRON_RUN_AS_NODE
  app = spawn(ELECTRON, ['.', `--remote-debugging-port=${cdpPort}`], { cwd: ROOT, env, stdio: 'ignore' })
  const cdp = await new Cdp(await findTarget(cdpPort)).connect()
  await cdp.waitFor(`typeof window.openfuture === 'object'`, 'preload', 40_000)

  const saved = await cdp.evaluate(`window.openfuture.saveModel(${JSON.stringify({ baseUrl: `http://127.0.0.1:${mockPort}/v1`, modelId: 'mock-model', displayName: 'Mock Model', contextWindow: 32000, maxTokens: 2048, apiKey: 'mock-key' })}).then((r) => r.ok)`)
  if (!saved) throw new Error('model save failed')
  await cdp.send('Page.reload')
  await cdp.waitFor(`typeof window.openfuture === 'object' && document.title === 'OpenFuture'`, 'reload', 40_000)
  await sleep(1500)

  await cdp.waitFor(`document.body.innerText.includes('RAG 验收')`, 'conversation row', 40_000)
  const clicked = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.conversation-row')]
    const row = rows.find((item) => item.textContent.includes('RAG 验收'))
    if (!row) return false
    row.click()
    return true
  })()`)
  if (!clicked) throw new Error('conversation row not clickable')
  await cdp.waitFor(`!!document.querySelector('textarea')`, 'composer', 40_000)

  const workspace = await cdp.evaluate(`window.openfuture.getSettings().then((r) => r.ok ? r.value.workspace : r.error.message)`)
  log(`workspace -> ${workspace}`)

  const docs = readdirSync(join(CORPUS, 'docs')).map((file) => join(CORPUS, 'docs', file))
  const imported = await cdp.evaluate(`(() => { const paths = ${JSON.stringify(docs)}; return window.openfuture.memoryImportFiles({ paths }).then((r) => r.ok ? r.value.length : ('ERR:' + r.error.message)) })()`)
  log(`imported -> ${imported}`)
  if (imported !== docs.length) throw new Error(`import failed: ${imported}`)

  const mode = await cdp.evaluate(`window.openfuture.memorySetMode('rag').then((r) => r.ok ? r.value.mode : ('ERR:' + r.error.message))`)
  log(`mode -> ${mode}`)
  await sleep(800)

  await cdp.evaluate(`(() => { const area = document.querySelector('textarea'); area.focus(); return true })()`)
  await cdp.send('Input.insertText', { text: '帮我查一下 HALCYON-001 的默认阈值是多少' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })

  await cdp.waitFor(
    `document.body.innerText.includes('记忆检索结果') || !!document.querySelector('.banner.error-banner')`,
    'memory answer',
    150_000
  )
  await sleep(600)
  const result = await cdp.evaluate(`(() => {
    const turns = [...document.querySelectorAll('.agent-turn')]
    const last = turns[turns.length - 1]
    return {
      text: (last?.textContent || '').slice(-600),
      tools: [...document.querySelectorAll('.chain-step-row[data-kind="tool"] .chain-step-title')].map((el) => el.textContent.trim()),
      hasMemory: document.body.innerText.includes('memory_search'),
      bodyEcho: document.body.innerText.includes('记忆检索结果')
    }
  })()`)
  log(`result -> ${JSON.stringify(result)}`)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(ROOT, '.scratch', 'e2e-memory-rag.png'), Buffer.from(shot.data, 'base64'))

  const metrics = await cdp.evaluate(`window.openfuture.memoryMetrics().then((r) => r.ok ? r.value : ('ERR:' + r.error.message))`)
  log(`metrics -> ${JSON.stringify({ searches: metrics.searches, hitRate: metrics.hitRate, p50Ms: metrics.p50Ms, recent: metrics.recent?.slice(0, 2) })}`)
  if (typeof metrics === 'string') throw new Error(`memory metrics failed: ${metrics}`)
  if (!(metrics.searches >= 1)) throw new Error('retrieval metrics not recorded after a conversation turn')
  if (!(metrics.hitRate > 0)) throw new Error('retrieval hit rate stayed at zero')
  if (!metrics.recent.some((event) => typeof event.query === 'string' && event.query.includes('HALCYON'))) {
    throw new Error('retrieval event does not contain the conversation query')
  }
  await cdp.evaluate(`document.querySelector('button[aria-label="项目记忆"]')?.click()`)
  await sleep(1200)
  const panelText = await cdp.evaluate(`document.querySelector('.memory-panel')?.innerText || document.body.innerText`)
  if (!panelText.includes('检索次数')) throw new Error('memory panel does not render retrieval counters')
  log('panel -> retrieval counters visible')

  if (!result.bodyEcho) throw new Error('model reply does not echo memory tool result')
  if (!result.text.includes('storage-01.md')) throw new Error('memory result missing the gold document')
  if (!result.hasMemory) throw new Error('memory_search step missing')
  log('E2E PASSED')
}

main()
  .catch((error) => {
    log(`E2E FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
  .finally(() => {
    shutdown()
    process.exit(process.exitCode ?? 0)
  })
