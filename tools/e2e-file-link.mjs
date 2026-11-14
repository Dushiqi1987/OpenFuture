/**
 * End-to-end check for clickable file paths and the embedded browser dock.
 *
 *   node tools/e2e-file-link.mjs      (needs `electron-vite build`)
 *
 * Seeds a workspace containing `demo.html`, runs the mock model in
 * `MOCK_FILE_REPLY` mode so the assistant answer contains that absolute path,
 * then clicks the blue path and asserts the dock loads the page via <webview>.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createTcpServer } from 'node:net'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const USER_DATA = join(ROOT, '.scratch', 'e2e-filelink-userdata')
const WORKSPACE = join(ROOT, '.scratch', 'e2e-filelink-workspace')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const DEMO = join(WORKSPACE, 'demo.html')

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const log = (line) => process.stdout.write(`${line}\n`)

let MOCK_PORT = 0
let CDP_PORT = 0

function pickPort() {
  return new Promise((done, fail) => {
    const server = createTcpServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => done(port))
    })
  })
}

async function waitForHttp(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      /* not up yet */
    }
    await sleep(200)
  }
  throw new Error(`timeout waiting for ${url}`)
}

function seed() {
  rmSync(USER_DATA, { recursive: true, force: true })
  rmSync(WORKSPACE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  mkdirSync(join(USER_DATA, 'config'), { recursive: true })
  writeFileSync(
    DEMO,
    `<!doctype html><html><head><meta charset="utf-8"><title>OpenFuture File Link</title></head><body><h1>File link works</h1><p>Rendered inside the embedded browser.</p></body></html>`
  )
  writeFileSync(
    join(USER_DATA, 'config', 'settings.json'),
    JSON.stringify(
      {
        version: 1,
        workspace: WORKSPACE,
        model: null,
        allowPowerShell: false,
        computerUse: false,
        contextCompression: false,
        subagents: false,
        subagentConcurrency: 1,
        groupChat: false
      },
      null,
      2
    )
  )
  writeFileSync(
    join(USER_DATA, 'config', 'projects.json'),
    JSON.stringify(
      {
        version: 1,
        activeProjectId: 'p-e2e',
        projects: [
          {
            id: 'p-e2e',
            name: 'e2e',
            canonicalRoot: WORKSPACE,
            memoryPreset: 'off',
            defaultModelRef: null,
            createdAt: 1_700_000_000_000,
            archivedAt: null,
            lastConversationId: 'c-e2e'
          }
        ],
        conversations: [
          {
            id: 'c-e2e',
            projectId: 'p-e2e',
            title: '文件链接验收',
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000
          }
        ]
      },
      null,
      2
    )
  )
}

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.socket = null
  }

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
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed')
    }
    return result.result?.value
  }

  async waitFor(expression, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await this.evaluate(expression)
      if (value) return value
      await sleep(250)
    }
    throw new Error(`timeout waiting for ${label}`)
  }
}

async function findTarget() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* devtools not listening yet */
    }
    await sleep(300)
  }
  throw new Error('no CDP page target')
}

let mock = null
let app = null
let exitCode = 0

function shutdown() {
  try {
    app?.kill()
  } catch {
    /* already gone */
  }
  try {
    mock?.kill()
  } catch {
    /* already gone */
  }
}

async function main() {
  MOCK_PORT = await pickPort()
  CDP_PORT = await pickPort()
  seed()

  mock = spawn(process.execPath, [join(ROOT, 'tools', 'mock-model', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      MOCK_MODEL_PORT: String(MOCK_PORT),
      MOCK_DELAY_MS: '8',
      MOCK_FILE_REPLY: DEMO
    },
    stdio: 'ignore'
  })
  await waitForHttp(`http://127.0.0.1:${MOCK_PORT}/health`)
  log('mock model ready')

  const appEnv = { ...process.env, OPENFUTURE_USER_DATA: USER_DATA }
  delete appEnv.ELECTRON_RUN_AS_NODE
  app = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT,
    env: appEnv,
    stdio: 'ignore'
  })

  const cdp = await new Cdp(await findTarget()).connect()
  await cdp.waitFor(`typeof window.openfuture === 'object'`, 'preload', 30_000)

  const saved = await cdp.evaluate(`window.openfuture.saveModel(${JSON.stringify({
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    modelId: 'mock-model',
    displayName: 'Mock Model',
    contextWindow: 32000,
    maxTokens: 2048,
    apiKey: 'mock-key'
  })})`)
  if (!saved?.ok) throw new Error(`saveModel failed: ${JSON.stringify(saved)}`)
  log('model saved')
  await sleep(1500)

  await cdp.send('Page.reload')
  await sleep(1200)
  await cdp.waitFor(`document.title === 'OpenFuture' && !!document.querySelector('textarea')`, 'composer')

  const textarea = `document.querySelector('textarea')`
  await cdp.evaluate(`(() => { const el = ${textarea}; el.focus(); return true })()`)
  await cdp.send('Input.insertText', { text: '帮我写一个演示页面' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  log('message sent')

  await cdp.waitFor(`document.querySelectorAll('.inline-link-path').length > 0`, 'file link', 90_000)
  const linkText = await cdp.evaluate(`document.querySelector('.inline-link-path').textContent`)
  log(`file link -> ${linkText}`)

  await cdp.evaluate(`(() => { document.querySelector('.inline-link-path').click(); return true })()`)
  await cdp.waitFor(`!!document.querySelector('.app-browser')`, 'browser dock')

  const loaded = await cdp.waitFor(
    `(() => { const view = document.querySelector('webview'); if (!view || typeof view.getURL !== 'function') return null; const url = view.getURL(); return url && url.indexOf('demo.html') >= 0 ? url : null })()`,
    'webview url',
    30_000
  )
  const title = await cdp.waitFor(
    `(() => { const node = document.querySelector('.app-browser-title'); return node && node.textContent.trim() === 'OpenFuture File Link' ? node.textContent.trim() : null })()`,
    'webview title',
    30_000
  )
  const external = await cdp.evaluate(`!!Array.from(document.querySelectorAll('.app-browser-pill')).find((node) => node.textContent.includes('外部浏览器'))`)
  if (!external) throw new Error('external browser button missing')

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((shot) => {
    writeFileSync(join(ROOT, '.scratch', 'e2e-filelink.png'), Buffer.from(shot.data, 'base64'))
  })

  log(`webview url -> ${loaded}`)
  log(`webview title -> ${title}`)
  log(`external button -> ${external}`)
  log('E2E PASSED')
}

main()
  .catch((error) => {
    exitCode = 1
    log(`E2E FAILED: ${error instanceof Error ? error.message : String(error)}`)
  })
  .finally(() => {
    shutdown()
    process.exit(exitCode)
  })
