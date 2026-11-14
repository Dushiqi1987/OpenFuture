/**
 * End-to-end check of the desktop app: boots the built Electron app against the
 * mock model in delegate mode, has the mock call `delegate_tasks`, and asserts
 * that subagent progress events reach the renderer and paint the strip.
 *
 * Run: node tools/e2e-subagent.mjs  (needs `electron-vite build` and the mock model script)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const USER_DATA = join(ROOT, '.scratch', 'e2e-userdata')
const WORKSPACE = join(ROOT, '.scratch', 'e2e-workspace')
// Ports are picked at run time: a fixed port collides with whatever the host
// machine already listens on (a proxy grabbed 18787 in an earlier run).
let MOCK_PORT = 0
let CDP_PORT = 0
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function pickPort() {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => done(port))
    })
  })
}

function seedUserData() {
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
        subagents: true,
        subagentConcurrency: 2
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
            title: '子 Agent 验收',
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
    this.ws = null
  }

  async open() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolveOpen, reject) => {
      this.ws.onopen = resolveOpen
      this.ws.onerror = (event) => reject(new Error(`cdp socket error: ${event?.message ?? 'unknown'}`))
    })
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      const pending = message.id ? this.pending.get(message.id) : null
      if (pending) {
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
      }
    }
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`evaluate failed: ${detail}`)
    }
    return result.result.value
  }

  close() {
    this.ws?.close()
  }
}

async function findTarget() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(800) })
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      // DevTools endpoint not up yet.
    }
    await sleep(250)
  }
  throw new Error('renderer DevTools endpoint never appeared')
}

async function waitFor(cdp, expression, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await cdp.evaluate(expression)
      if (last) return last
    } catch (error) {
      last = error.message
    }
    await sleep(300)
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`)
}

async function main() {
  MOCK_PORT = await pickPort()
  CDP_PORT = await pickPort()
  console.log(`ports -> mock=${MOCK_PORT} cdp=${CDP_PORT}`)
  seedUserData()
  const mock = spawn(process.execPath, [join(ROOT, 'tools', 'mock-model', 'server.mjs')], {
    env: {
      ...process.env,
      MOCK_MODEL_PORT: String(MOCK_PORT),
      MOCK_MODEL_ID: 'mock-model',
      MOCK_DELAY_MS: '8',
      MOCK_TOOL_CALL: 'delegate'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  mock.stdout.on('data', (chunk) => process.stdout.write(`[mock] ${chunk}`))
  mock.stderr.on('data', (chunk) => process.stderr.write(`[mock] ${chunk}`))

  // The DSH shell exports ELECTRON_RUN_AS_NODE=1; without removing it the
  // Electron binary would behave like plain Node and crash on `app.setPath`.
  const appEnv = { ...process.env, OPENFUTURE_USER_DATA: USER_DATA }
  delete appEnv.ELECTRON_RUN_AS_NODE
  const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT,
    env: appEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const hostLog = []
  app.stdout.on('data', (chunk) => {
    hostLog.push(chunk.toString())
    process.stdout.write(`[app] ${chunk}`)
  })
  app.stderr.on('data', (chunk) => {
    hostLog.push(chunk.toString())
    process.stderr.write(`[app] ${chunk}`)
  })

  let cdp
  try {
    await sleep(1_000)
    const wsUrl = await findTarget()
    cdp = new Cdp(wsUrl)
    await cdp.open()
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await waitFor(cdp, "typeof window.openfuture === 'object'", 'preload bridge')

    const saved = await cdp.evaluate(`(async () => {
      const result = await window.openfuture.saveModel({
        baseUrl: 'http://127.0.0.1:${MOCK_PORT}/v1',
        modelId: 'mock-model',
        displayName: 'Mock Model',
        contextWindow: 32000,
        maxTokens: 2048,
        apiKey: 'mock-key'
      })
      return result
    })()`)
    console.log('saveModel ->', JSON.stringify(saved).slice(0, 200))

    await sleep(2_000)
    await cdp.send('Page.reload', { ignoreCache: false })
    await sleep(800)
    await waitFor(cdp, "typeof window.openfuture === 'object'", 'preload bridge after reload')
    const ready = await waitFor(
      cdp,
      "(() => { const body = document.body.innerText || ''; return body.includes('子 Agent 验收') ? body.slice(0, 120) : '' })()",
      'conversation bootstrap'
    )
    console.log('bootstrapped ->', JSON.stringify(ready))

    await cdp.evaluate(`(() => {
      window.__ofEvents = []
      window.openfuture.onAgentEvent((payload) => window.__ofEvents.push(payload))
      return true
    })()`)

    // Drive the real composer: the UI creates the session on first send, which
    // a direct `sendMessage` IPC call skips.
    await cdp.evaluate("document.querySelector('textarea').focus()")
    await cdp.send('Input.insertText', { text: '并行调研 agent-host 的会话生命周期与工具注册' })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      key: 'Enter',
      code: 'Enter'
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      key: 'Enter',
      code: 'Enter'
    })
    let settle = 0
    try {
      settle = await waitFor(
        cdp,
        "(() => { const events = window.__ofEvents || []; return events.some((p) => p.event && p.event.type === 'settled') ? events.length : 0 })()",
        'turn settled',
        60_000
      )
    } catch (error) {
      const debug = await cdp.evaluate(
        "JSON.stringify({events: (window.__ofEvents || []).map((p) => p.event && p.event.type), sessions: 'n/a'})"
      )
      console.log('debug events ->', debug)
      console.log('host log tail ->', hostLog.join('').split('\n').slice(-25).join('\n'))
      throw error
    }
    console.log('events captured ->', settle)

    const summary = await cdp.evaluate(`(() => {
      const events = window.__ofEvents || []
      const subagents = events.filter((p) => p.event && p.event.type === 'subagent').map((p) => p.event.task)
      const strip = document.querySelector('.subagent-strip')
      const rows = strip ? [...strip.querySelectorAll('.subagent-row')].map((row) => row.innerText.replace(/\\n/g, ' | ')) : []
      const text = document.body.innerText || ''
      return {
        types: [...new Set(events.map((p) => p.event.type))],
        subagentCount: subagents.length,
        statuses: subagents.map((task) => task.status),
        titles: [...new Set(subagents.map((task) => task.title))],
        stripVisible: Boolean(strip),
        stripText: strip ? strip.innerText.replace(/\\n/g, ' | ') : '',
        rows,
        finalMentionsSummary: text.includes('并行子 Agent 已返回结果'),
        errors: events.filter((p) => p.event && p.event.type === 'error').map((p) => p.event.message)
      }
    })()`)
    console.log('summary ->', JSON.stringify(summary, null, 2))

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ROOT, '.scratch', 'e2e-subagent.png'), Buffer.from(shot.data, 'base64'))
    console.log('screenshot -> .scratch/e2e-subagent.png')

    const failures = []
    if (summary.subagentCount < 4) failures.push(`expected subagent events, got ${summary.subagentCount}`)
    if (!summary.statuses.includes('done')) failures.push(`no done status: ${summary.statuses.join(',')}`)
    if (!summary.stripVisible) failures.push('subagent strip not rendered')
    if (!summary.finalMentionsSummary) failures.push('final answer did not include the tool result')
    if (summary.errors.length) failures.push(`agent errors: ${summary.errors.join(' / ')}`)
    if (failures.length) {
      console.log('\nE2E FAILED')
      for (const failure of failures) console.log(` - ${failure}`)
      process.exitCode = 1
    } else {
      console.log('\nE2E PASSED')
    }
  } finally {
    cdp?.close()
    app.kill()
    mock.kill()
    await sleep(300)
  }
}

main().catch((error) => {
  console.error('E2E ERROR:', error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
