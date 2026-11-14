/**
 * End-to-end check for the Codex-style step timeline.
 *
 *   node tools/e2e-steps.mjs      (needs `electron-vite build`)
 *
 * The mock model emits reasoning, calls `write`, then answers. The renderer
 * shows one collapsed row per action: thinking/tool/skill, each expandable.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createTcpServer } from 'node:net'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const USER_DATA = join(ROOT, '.scratch', 'e2e-steps-userdata')
const WORKSPACE = join(ROOT, '.scratch', 'e2e-steps-workspace')
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
            lastConversationId: 'c-e2e'
          }
        ],
        conversations: [
          {
            id: 'c-e2e',
            projectId: 'p-e2e',
            title: '提问验收',
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


async function clickElement(cdp, selector) {
  const point = await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)
  if (!point) throw new Error(`missing element: ${selector}`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  return point
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
      MOCK_WRITE: '1',
      MOCK_REASONING: '先梳理需求，再调用写入工具。'
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

  await cdp.evaluate(`(() => { const el = document.querySelector('textarea'); el.focus(); return true })()`)
  await cdp.send('Input.insertText', { text: '整理一份会议记录写入文件' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  log('message sent')

  await cdp.waitFor(
    `!!document.querySelector('.chain-step-row') && !document.querySelector('.agent-turn.streaming')`,
    'step rows',
    90_000
  )
  const steps = await cdp.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.chain-step-row'))
    return rows.map((row) => ({
      kind: row.getAttribute('data-kind'),
      head: row.querySelector('.chain-step-title').textContent.trim(),
      meta: (row.querySelector('.chain-step-meta')?.textContent || '').trim()
    }))
  })()`)
  log(`steps -> ${JSON.stringify(steps)}`)
  const thinking = steps.filter((step) => step.kind === 'thinking')
  const tools = steps.filter((step) => step.kind === 'tool')
  if (thinking.length === 0) throw new Error('no thinking step')
  if (tools.length === 0) throw new Error('no tool step')
  if (!tools.some((step) => step.head.startsWith('write'))) throw new Error('write step missing')
  if (thinking[0].head.length > 130) throw new Error(`thinking preview not clamped: ${thinking[0].head.length}`)

  await clickElement(cdp, '.chain-step-row[data-kind="thinking"] .chain-step-head')
  await sleep(250)
  const expandedThinking = await cdp.evaluate(`(() => {
    const row = document.querySelector('.chain-step-row[data-kind="thinking"][open]')
    if (!row) return null
    const body = row.querySelector('.chain-step-body')
    return body ? body.textContent.trim() : null
  })()`)
  log(`thinking expanded -> ${JSON.stringify(expandedThinking?.slice(0, 120))}`)
  if (!expandedThinking?.includes('先梳理需求')) throw new Error('thinking did not expand')

  await clickElement(cdp, '.chain-step-row[data-kind="tool"] .chain-step-head')
  await sleep(250)
  const expandedTool = await cdp.evaluate(`(() => {
    const row = document.querySelector('.chain-step-row[data-kind="tool"][open]')
    if (!row) return null
    const body = row.querySelector('.chain-step-body')
    return body ? body.textContent.trim() : null
  })()`)
  log(`tool expanded -> ${JSON.stringify(expandedTool?.slice(0, 200))}`)
  if (!expandedTool || !expandedTool.includes('mock-edit/notes.md')) throw new Error('tool body missing path')
  if (!expandedTool.includes('结果')) throw new Error('tool body missing result section')

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((shot) => {
    writeFileSync(join(ROOT, '.scratch', 'e2e-steps.png'), Buffer.from(shot.data, 'base64'))
  })

  await cdp.evaluate(`(() => { const el = document.querySelector('textarea'); el.focus(); return true })()`)
  await cdp.send('Input.insertText', { text: '/skill:release-notes 检查发布说明' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await cdp.waitFor(`!!document.querySelector('.chain-step-row[data-kind="skill"]')`, 'skill step', 60_000)
  const skill = await cdp.evaluate(`(() => {
    const row = document.querySelector('.chain-step-row[data-kind="skill"]')
    return row ? row.querySelector('.chain-step-title').textContent.trim() : ''
  })()`)
  log(`skill step -> ${JSON.stringify(skill)}`)
  if (!skill.includes('release-notes')) throw new Error(`skill step missing: ${skill}`)

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
