/**
 * End-to-end check for concurrent conversations.
 *
 *   node tools/e2e-multi.mjs      (needs `electron-vite build`)
 *
 * Starts a slow turn in conversation A, switches to conversation B while A is
 * still streaming, starts a turn there, and verifies that:
 *   - both conversations get distinct sessions and settle independently;
 *   - the main process started one agent host per conversation;
 *   - switching back to A shows the messages that accumulated in the background.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createTcpServer } from 'node:net'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const USER_DATA = join(ROOT, '.scratch', 'e2e-multi-userdata')
const WORKSPACE = join(ROOT, '.scratch', 'e2e-multi-workspace')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

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
            lastConversationId: 'c-a'
          }
        ],
        conversations: [
          {
            id: 'c-a',
            projectId: 'p-e2e',
            title: '对话 A',
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000
          },
          {
            id: 'c-b',
            projectId: 'p-e2e',
            title: '对话 B',
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

  async waitFor(expression, label, timeoutMs = 40_000) {
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

/** Click a conversation row by its visible title. */
async function openConversation(cdp, title) {
  const clicked = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.conversation-row')]
    const row = rows.find((item) => item.textContent.includes(${JSON.stringify(title)}))
    if (!row) return false
    row.click()
    return true
  })()`)
  if (!clicked) throw new Error(`conversation row not found: ${title}`)
}

async function composerType(cdp, text) {
  await cdp.evaluate(`(() => {
    const area = document.querySelector('textarea')
    if (!area) return false
    area.focus()
    area.select()
    return true
  })()`)
  await cdp.send('Input.insertText', { text })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    windowsVirtualKeyCode: 13,
    key: 'Enter',
    code: 'Enter'
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    windowsVirtualKeyCode: 13,
    key: 'Enter',
    code: 'Enter'
  })
}

async function main() {
  MOCK_PORT = await pickPort()
  CDP_PORT = await pickPort()
  seed()

  mock = spawn(process.execPath, [join(ROOT, 'tools', 'mock-model', 'server.mjs')], {
    cwd: ROOT,
    // Slow enough that conversation A is still streaming when B starts.
    env: { ...process.env, MOCK_MODEL_PORT: String(MOCK_PORT), MOCK_DELAY_MS: '90' },
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
  await cdp.waitFor(`document.body.innerText.includes('对话 A')`, 'conversation A bootstrapped', 40_000)
  await cdp.waitFor(`!!document.querySelector('textarea')`, 'composer', 30_000)

  await cdp.evaluate(`(() => {
    window.__ev = []
    window.__logs = []
    window.openfuture.onAgentEvent((payload) => window.__ev.push(payload))
    window.openfuture.onHostLog((line) => window.__logs.push(line))
    return true
  })()`)

  // Conversation A starts a slow turn.
  await composerType(cdp, '第一段：请慢慢回答这个问题')
  await cdp.waitFor(
    `window.__ev.some((item) => item.event.type === 'status' && item.event.state === 'streaming')`,
    'conversation A streaming'
  )
  const streamA = await cdp.evaluate(`window.__ev.find((item) => item.event.type === 'status' && item.event.state === 'streaming').sessionId`)
  log(`conversation A streaming -> ${streamA}`)

  // Switch away while A is still running; this must not stop it.
  await openConversation(cdp, '对话 B')
  await cdp.waitFor(`document.body.innerText.includes('对话 B')`, 'conversation B opened', 20_000)
  await cdp.waitFor(`!!document.querySelector('textarea')`, 'composer B', 20_000)

  await composerType(cdp, '第二段：同时在另一个对话里回答')
  await cdp.waitFor(
    `new Set(window.__ev.filter((item) => item.event.type === 'status' && item.event.state === 'streaming').map((item) => item.sessionId)).size >= 2`,
    'both conversations streaming'
  )

  // Both turns settle independently.
  await cdp.waitFor(
    `new Set(window.__ev.filter((item) => item.event.type === 'settled').map((item) => item.sessionId)).size >= 2`,
    'both conversations settled',
    120_000
  )
  const summary = await cdp.evaluate(`(() => {
    const settled = [...new Set(window.__ev.filter((item) => item.event.type === 'settled').map((item) => item.sessionId))]
    const streamed = [...new Set(window.__ev.filter((item) => item.event.type === 'status' && item.event.state === 'streaming').map((item) => item.sessionId))]
    return {
      settled,
      streamed,
      errors: window.__ev.filter((item) => item.event.type === 'error').map((item) => item.event.message),
      hostStarts: window.__logs.filter((line) => line.includes('[agent-host] started')).length
    }
  })()`)
  log(`settled sessions -> ${JSON.stringify(summary.settled)}`)
  log(`host starts -> ${summary.hostStarts}`)

  if (summary.settled.length < 2) throw new Error('expected two settled conversations')
  if (summary.errors.length > 0) throw new Error(`errors: ${summary.errors.join(' | ')}`)
  if (summary.hostStarts < 2) throw new Error('expected one agent host per conversation')

  // Switch back: A's finished answer must be replayed from the live host.
  await openConversation(cdp, '对话 A')
  await cdp.waitFor(`document.body.innerText.includes('第一段')`, 'conversation A replayed', 30_000)
  const replay = await cdp.evaluate(`(() => {
    const text = document.body.innerText
    return {
      hasPrompt: text.includes('第一段：请慢慢回答这个问题'),
      hasAnswer: text.includes('我收到了你的消息'),
      active: document.querySelector('.conversation-row.active')?.textContent?.trim() ?? ''
    }
  })()`)
  log(`replay -> ${JSON.stringify(replay)}`)
  if (!replay.hasPrompt || !replay.hasAnswer) throw new Error('conversation A history was not replayed')

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((result) => {
    if (result?.data) {
      writeFileSync(join(ROOT, '.scratch', 'e2e-multi.png'), Buffer.from(result.data, 'base64'))
    }
  })

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
