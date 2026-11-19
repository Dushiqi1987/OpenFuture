import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

// Goal-mode E2E: a goal starts a round, the mock model answers without calling
// any tool, and the host must auto-pause instead of looping forever. This is the
// cheapest deterministic proof that the loop, the safety valve and persistence
// all work without a real credential.

const ROOT = join(import.meta.dirname, '..')
const USER_DATA = join(ROOT, '.scratch', 'e2e-goal-userdata')
const WORKSPACE = join(ROOT, '.scratch', 'e2e-goal-workspace')
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
  mkdirSync(workspace, { recursive: true })
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
        activeProjectId: 'p-goal',
        projects: [
          { id: 'p-goal', name: 'goal-e2e', canonicalRoot: workspace, memoryPreset: 'off', defaultModelRef: null, createdAt: 1_700_000_000_000, archivedAt: null, lastConversationId: 'c-goal' }
        ],
        conversations: [{ id: 'c-goal', projectId: 'p-goal', title: '目标验收', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }]
      },
      null,
      2
    )
  )
  rmSync(join(USER_DATA, 'config', 'goals'), { recursive: true, force: true })
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
    env: { ...process.env, MOCK_MODEL_PORT: String(mockPort), MOCK_MODEL_ID: 'mock-model', MOCK_DELAY_MS: '5' },
    stdio: 'ignore'
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${mockPort}/health`)).ok) break } catch { /* starting */ }
    await sleep(250)
  }
  log('mock model ready')

  seed(WORKSPACE)
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
  await sleep(1200)

  await cdp.waitFor(`document.body.innerText.includes('目标验收')`, 'conversation row', 40_000)
  const clicked = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('.conversation-row')].find((item) => item.textContent.includes('目标验收'))
    if (!row) return false
    row.click()
    return true
  })()`)
  if (!clicked) throw new Error('conversation row not clickable')
  await cdp.waitFor(`!!document.querySelector('textarea')`, 'composer', 40_000)

  // Start a two-round goal through the same composer UI a user would use.
  const opened = await cdp.evaluate(`(() => {
    const pill = [...document.querySelectorAll('.dsh-pill')].find((el) => el.textContent.includes('目标'))
    if (!pill) return false
    pill.click()
    return true
  })()`)
  if (!opened) throw new Error('goal pill missing')
  await cdp.waitFor(`!!document.querySelector('.goal-setup textarea')`, 'goal setup', 10_000)

  const filled = await cdp.evaluate(`(() => {
    const area = document.querySelector('.goal-setup textarea')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(area, '确认目标模式可以自动推进并在没有进展时暂停')
    area.dispatchEvent(new Event('input', { bubbles: true }))
    const rounds = document.querySelector('.goal-setup input[type=number]')
    const numberSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    numberSetter.call(rounds, '2')
    rounds.dispatchEvent(new Event('input', { bubbles: true }))
    rounds.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  if (!filled) throw new Error('goal setup not fillable')
  await cdp.evaluate(`document.querySelector('.goal-setup .goal-start').click()`)

  const badge = await cdp.waitFor(
    `(() => { const el = document.querySelector('.goal-badge'); return el && el.textContent.includes('第 1/2 轮') ? el.textContent.trim() : '' })()`,
    'goal round 1',
    60_000
  )
  log(`badge -> ${badge}`)

  const state = await cdp.waitFor(
    `(() => { const el = document.querySelector('.goal-state'); return el && ['已暂停', '已完成', '被阻塞'].includes(el.textContent.trim()) ? el.textContent.trim() : '' })()`,
    'goal safety pause',
    150_000
  )
  const detail = await cdp.evaluate(`(() => ({
    badge: document.querySelector('.goal-badge')?.textContent?.trim() || '',
    state: document.querySelector('.goal-state')?.textContent?.trim() || '',
    note: document.querySelector('.goal-note')?.textContent?.trim() || ''
  }))()`)
  log(`goal -> ${JSON.stringify(detail)}`)
  if (state !== '已暂停') throw new Error(`expected auto pause, got ${state}`)
  if (!detail.note.includes('自动暂停')) throw new Error(`pause reason missing: ${detail.note}`)

  const stored = readdirSync(join(USER_DATA, 'config', 'goals')).map((file) => JSON.parse(readFileSync(join(USER_DATA, 'config', 'goals', file), 'utf8')))
  const goal = stored.find((item) => item.objective.includes('确认目标模式'))
  if (!goal) throw new Error('goal not persisted')
  log(`stored -> ${JSON.stringify({ status: goal.status, round: goal.round, maxRounds: goal.maxRounds })}`)
  if (goal.status !== 'paused') throw new Error(`persisted status is ${goal.status}`)

  // Clearing removes the bar and the persisted file.
  await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('.goal-bar button')].find((el) => el.textContent.trim() === '清除'); b?.click(); return true })()`)
  await cdp.waitFor(`!document.querySelector('.goal-bar')`, 'goal cleared', 15_000)
  log('GOAL E2E PASSED')
}

main()
  .catch((error) => {
    console.error('GOAL E2E FAILED:', error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    await sleep(300)
    shutdown()
    await sleep(300)
    process.exit(process.exitCode ?? 0)
  })
