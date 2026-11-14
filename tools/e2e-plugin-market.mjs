/**
 * End-to-end check of the plugin market in the desktop app.
 *
 * Serves a fixture catalog + tarball over loopback (`OPENFUTURE_MARKET_CATALOG`),
 * boots the built Electron app against the mock model in plugin-adapt mode, then:
 *
 *   1. opens 侧边栏 > 插件市场, waits for the catalog row;
 *   2. clicks 下载 and 适配;
 *   3. reviews the generated code and enables the extension;
 *   4. sends another message in the same conversation and checks the host log for
 *      `[agent-host] adapted plugin loaded`.
 *
 * Run: node tools/e2e-plugin-market.mjs  (needs `electron-vite build`)
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createTcpServer } from 'node:net'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const ROOT = resolve(import.meta.dirname, '..')
const USER_DATA = join(ROOT, '.scratch', 'e2e-plugin-userdata')
const WORKSPACE = join(ROOT, '.scratch', 'e2e-plugin-workspace')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PLUGIN_ID = 'dsh-demo-plugin'

let MOCK_PORT = 0
let FIXTURE_PORT = 0
let CDP_PORT = 0
let FIXTURE_BASE = ''

const DEPS = process.env.E2E_PLUGIN_DEPS === '1'
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const log = (line) => process.stdout.write(`${line}\n`)

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

/** Minimal ustar writer for npm-style `package/...` archives. */
function buildTar(files) {
  const blocks = []
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content, 'utf8')
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'ascii')
    header.write('0000000\0', 108, 8, 'ascii')
    header.write('0000000\0', 116, 8, 'ascii')
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii')
    header.write('        ', 148, 8, 'ascii')
    header.write('0', 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

async function startFixture() {
  const archive = gzipSync(
    buildTar({
      'package/package.json': JSON.stringify({
        name: PLUGIN_ID,
        version: '0.1.0',
        description: 'Fixture plugin for the plugin market E2E'
      }),
      'package/index.js': "export function apply(ctx) {\n  ctx.logger?.info?.('dsh demo plugin loaded')\n}\n",
      'package/README.md': '# dsh-demo-plugin\n\nFixture plugin used by tools/e2e-plugin-market.mjs.\n'
    })
  )
  const catalog = JSON.stringify([
    {
      name: PLUGIN_ID,
      owner: 'openfuture',
      url: 'https://github.com/example/dsh-demo-plugin',
      category: 'demo',
      description: 'A tiny fixture plugin for the E2E run',
      version: '0.1.0',
      stars: 3,
      downloads: 7,
      tarball: `${FIXTURE_BASE}/demo.tgz`
    },
    {
      name: 'dsh-zeta',
      owner: 'fixture',
      url: 'https://github.com/example/dsh-zeta',
      category: 'demo/extra',
      description: 'Second fixture row used to exercise filtering',
      version: '0.2.0',
      stars: 40,
      downloads: 120
    },
    {
      name: 'dsh-alpha',
      owner: 'fixture',
      url: 'https://github.com/example/dsh-alpha',
      category: 'utility',
      description: 'Most starred fixture row',
      version: '1.0.0',
      stars: 500,
      downloads: 900
    },
    ...Array.from({ length: 78 }, (_, index) => ({
      name: `page-fixture-${String(index).padStart(2, '0')}`,
      owner: 'fixture',
      category: 'pagination',
      stars: 0
    }))
  ])
  const npmArchive = gzipSync(
    buildTar({
      'package/package.json': JSON.stringify({ name: 'is-number', version: '7.0.0', main: 'index.js' }),
      'package/index.js': "module.exports = (value) => typeof value === \'number\' || (typeof value === \'string\' && value.trim() !== \'\' && !Number.isNaN(Number(value)))\n"
    })
  )
  const npmDoc = JSON.stringify({
    name: 'is-number',
    'dist-tags': { latest: '7.0.0' },
    versions: { '7.0.0': { version: '7.0.0', dist: { tarball: `${FIXTURE_BASE}/pkg/is-number-7.0.0.tgz` } } }
  })
  const server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0]
    if (path === '/catalog.json') {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(catalog) })
      response.end(catalog)
      return
    }
    if (path === '/is-number') {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(npmDoc) })
      response.end(npmDoc)
      return
    }
    if (path === '/pkg/is-number-7.0.0.tgz') {
      response.writeHead(200, { 'content-type': 'application/gzip', 'content-length': npmArchive.length })
      response.end(npmArchive)
      return
    }
    if (path === '/demo.tgz') {
      response.writeHead(200, { 'content-type': 'application/gzip', 'content-length': archive.length })
      response.end(archive)
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  await new Promise((done) => server.listen(FIXTURE_PORT, '127.0.0.1', done))
  return server
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
            title: '插件市场验收',
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
  FIXTURE_PORT = await pickPort()
  CDP_PORT = await pickPort()
  FIXTURE_BASE = `http://127.0.0.1:${FIXTURE_PORT}`
  log(`ports -> mock=${MOCK_PORT} fixture=${FIXTURE_PORT} cdp=${CDP_PORT}`)

  const fixture = await startFixture()
  log(`fixture catalog -> ${FIXTURE_BASE}/catalog.json`)
  seedUserData()

  const mock = spawn(process.execPath, [join(ROOT, 'tools', 'mock-model', 'server.mjs')], {
    env: {
      ...process.env,
      MOCK_MODEL_PORT: String(MOCK_PORT),
      MOCK_MODEL_ID: 'mock-model',
      MOCK_DELAY_MS: '8',
      MOCK_PLUGIN_ADAPT: '1',
      ...(DEPS ? { MOCK_PLUGIN_DEPS: '1' } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  mock.stdout.on('data', (chunk) => process.stdout.write(`[mock] ${chunk}`))
  mock.stderr.on('data', (chunk) => process.stderr.write(`[mock] ${chunk}`))

  // The DSH shell exports ELECTRON_RUN_AS_NODE=1; the Electron binary would
  // behave like plain Node and crash on `app.setPath` unless it is removed.
  const appEnv = {
    ...process.env,
    OPENFUTURE_USER_DATA: USER_DATA,
    OPENFUTURE_MARKET_CATALOG: `${FIXTURE_BASE}/catalog.json`,
    ...(DEPS ? { OPENFUTURE_NPM_REGISTRY: FIXTURE_BASE } : {})
  }
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
    cdp = new Cdp(await findTarget())
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
    log(`saveModel -> ${JSON.stringify(saved).slice(0, 160)}`)

    await sleep(2_000)
    await cdp.send('Page.reload', { ignoreCache: false })
    await sleep(800)
    await waitFor(cdp, "typeof window.openfuture === 'object'", 'preload bridge after reload')
    const bootstrapped = await waitFor(
      cdp,
      "(() => { const body = document.body.innerText || ''; return body.includes('插件市场验收') ? 'ok' : '' })()",
      'conversation bootstrap'
    )
    log(`bootstrapped -> ${bootstrapped}`)

    await cdp.evaluate(`(() => {
      window.__ofEvents = []
      window.openfuture.onAgentEvent((payload) => window.__ofEvents.push(payload))
      document.querySelector('textarea').focus()
      return true
    })()`)
    await cdp.send('Input.insertText', { text: '插件操作前的对话' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, key: 'Enter' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter' })
    const initialSession = await waitFor(
      cdp,
      "window.__ofEvents.find((payload) => payload.event.type === 'settled')?.sessionId",
      'initial conversation turn'
    )

    // A real mouse click (not `button.click()`) so hit-testing and the generic
    // panel dialog are exercised too: `dshPanel` used to render the empty
    // "关于 OpenFuture" dialog on top of the market panel for every unknown panel.
    const point = await cdp.evaluate(`(() => {
      const nav = [...document.querySelectorAll('.dsh-nav button')]
      const button = nav.find((item) => item.textContent.includes('插件市场'))
      if (!button) return null
      const rect = button.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })()`)
    if (!point) throw new Error('plugin market nav unavailable')
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await waitFor(cdp, "!!document.querySelector('.plugin-market-modal')", 'plugin market modal')
    const stray = await cdp.evaluate(`(() => {
      const dialogs = [...document.querySelectorAll('.dsh-modal')].map((item) => (item.innerText || '').replace(/\\s+/g, ' ').slice(0, 40))
      return JSON.stringify(dialogs)
    })()`)
    if (stray !== '[]') throw new Error(`generic panel dialog still rendered: ${stray}`)
    log('plugin market modal opened (no generic dialog)')

    await waitFor(cdp, "document.querySelector('.plugin-pagination')?.innerText.includes('1 / 2')", 'catalog pagination')
    await cdp.evaluate("document.querySelector('.plugin-pagination button:last-child').click(); true")
    await waitFor(
      cdp,
      "document.querySelector('.plugin-section-grow .plugin-list')?.innerText.includes('page-fixture-77')",
      'last directory entry'
    )
    const unavailable = await cdp.evaluate(`(() => {
      const row = document.querySelector('.plugin-section-grow .plugin-row')
      return row.querySelector('button').disabled && row.textContent.includes('暂无可用安装包')
    })()`)
    if (!unavailable) throw new Error('entry without an archive was presented as downloadable')

    // Category filter + star sort: the catalog ships 10k+ entries, so these two
    // controls are part of the contract, not decoration.
    const filters = await cdp.evaluate(`(async () => {
      const setSelect = (index, value) => {
        const select = document.querySelectorAll('.plugin-select')[index]
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
        setter.call(select, value)
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
      const firstThree = () =>
        [...document.querySelectorAll('.plugin-section-grow .plugin-row b')].slice(0, 3).map((b) => b.textContent)
      await new Promise((done) => setTimeout(done, 200))
      setSelect(1, 'stars')
      await new Promise((done) => setTimeout(done, 200))
      const starred = firstThree()
      setSelect(0, 'demo')
      await new Promise((done) => setTimeout(done, 200))
      const demoRows = [...document.querySelectorAll('.plugin-section-grow .plugin-row b')].map((b) => b.textContent)
      setSelect(0, 'all')
      setSelect(1, 'default')
      await new Promise((done) => setTimeout(done, 200))
      return { starred, demoRows, categories: document.querySelectorAll('.plugin-select')[0].options.length }
    })()`)
    if (filters.starred[0] !== 'dsh-alpha') throw new Error(`star sort wrong: ${JSON.stringify(filters.starred)}`)
    if (filters.demoRows.length !== 2 || !filters.demoRows.includes(PLUGIN_ID)) {
      throw new Error(`category filter wrong: ${JSON.stringify(filters.demoRows)}`)
    }
    log(`filters ok -> ${JSON.stringify(filters)}`)

    const rowText = await waitFor(
      cdp,
      `(() => {
        const modal = document.querySelector('.plugin-market-modal')
        if (!modal) return ''
        const text = modal.innerText || ''
        return text.includes('${PLUGIN_ID}') ? text.slice(0, 160) : ''
      })()`,
      'catalog row',
      60_000
    )
    log(`catalog row -> ${JSON.stringify(rowText).slice(0, 200)}`)

    const installed = await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.plugin-market-modal .plugin-row')]
      const row = rows.find((item) => item.textContent.includes('${PLUGIN_ID}'))
      if (!row) return 'no-row'
      const button = [...row.querySelectorAll('button')].find((item) => item.textContent.trim() === '下载')
      if (!button) return 'no-download'
      if (button.disabled) return 'disabled'
      button.click()
      return 'clicked'
    })()`)
    if (installed !== 'clicked') throw new Error(`download unavailable: ${installed}`)
    log('download clicked ->', installed)

    await waitFor(
      cdp,
      `(() => {
        const rows = [...document.querySelectorAll('.plugin-market-modal .plugin-row')]
        const row = rows.find((item) => item.textContent.includes('${PLUGIN_ID}') && item.textContent.includes('适配'))
        return row ? 'ready' : ''
      })()`,
      'installed row with adapt button',
      60_000
    )

    const adapting = await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.plugin-market-modal .plugin-row')]
      const row = rows.find((item) => item.textContent.includes('${PLUGIN_ID}') && item.textContent.includes('适配'))
      if (!row) return 'no-row'
      const button = [...row.querySelectorAll('button')].find((item) => item.textContent.trim() === '适配')
      if (!button) return 'no-adapt'
      if (button.disabled) return 'disabled'
      button.click()
      return 'clicked'
    })()`)
    if (adapting !== 'clicked') throw new Error(`adapt unavailable: ${adapting}`)
    log('adapt clicked ->', adapting)

    const progress = await waitFor(
      cdp,
      `(() => {
        const modal = document.querySelector('.plugin-market-modal')
        if (!modal) return ''
        const text = modal.innerText || ''
        if (text.includes('适配完成')) return 'done'
        if (text.includes('适配失败')) return 'failed'
        return ''
      })()`,
      'adapt completion',
      120_000
    )
    log(`adaptation -> ${progress}`)
    if (progress === 'failed') {
      const detail = await cdp.evaluate(`(() => (document.querySelector('.plugin-market-modal')?.innerText || '').slice(-400))()`)
      throw new Error(`adaptation failed: ${detail}`)
    }

    const adaptedCount = await cdp.evaluate(`(async () => {
      const result = await window.openfuture.pluginMarket(false)
      return result.ok ? result.value.adapted.length : -1
    })()`)
    if (adaptedCount !== 1) throw new Error(`expected one adapted plugin, got ${adaptedCount}`)
    log(`adapted plugins -> ${adaptedCount}`)
    const disabled = await cdp.evaluate(`(async () => {
      const result = await window.openfuture.pluginMarket(false)
      return result.ok && result.value.adapted[0]?.enabled === false
    })()`)
    if (!disabled) throw new Error('the new adaptation enabled itself before review')

    if (DEPS) {
      await waitFor(
        cdp,
        `(() => {
          const rows = [...document.querySelectorAll('.plugin-market-modal .plugin-row')]
          return rows.some((item) => item.textContent.includes('安装依赖')) ? 'ready' : ''
        })()`,
        'dependency button',
        30_000
      )
      const clicked = await cdp.evaluate(`(() => {
        const button = [...document.querySelectorAll('.plugin-market-modal button')].find((item) => item.textContent.includes('安装依赖'))
        if (!button || button.disabled) return "unavailable"
        button.click()
        return "clicked"
      })()`)
      if (clicked !== 'clicked') throw new Error(`deps button: ${clicked}`)
      const notice = await waitFor(
        cdp,
        `(() => { const t = document.querySelector('.plugin-market-modal')?.innerText || ''; return t.includes('依赖已安装') || t.includes('依赖安装失败') ? t.slice(-200) : '' })()`,
        'dependency install',
        120_000
      )
      if (notice.includes('依赖安装失败')) throw new Error(`deps failed: ${notice}`)
      const depsState = await cdp.evaluate(`(async () => {
        const result = await window.openfuture.pluginMarket(false)
        return result.ok ? result.value.adapted.map((item) => item.depsInstalled) : []
      })()`)
      if (depsState.length !== 1 || depsState[0] !== true) {
        throw new Error(`deps not installed: ${JSON.stringify(depsState)}`)
      }
      log('deps installed -> true')
      await sleep(1_500)
    }
    await waitFor(cdp, `(() => {
      const button = [...document.querySelectorAll('.plugin-market-modal button')]
        .find((item) => item.textContent.trim() === '查看代码并启用')
      if (!button || button.disabled) return false
      button.click()
      return true
    })()`, 'review button')
    await waitFor(cdp, "document.querySelector('.plugin-code-review pre')?.textContent.includes('dsh_demo_echo')", 'generated code preview')
    await cdp.evaluate("document.querySelector('.plugin-code-review .primary-button').click(); true")
    await waitFor(cdp, "window.__ofEvents.some((payload) => payload.event.type === 'session-invalidated')", 'session invalidation')
    await waitFor(cdp, "!document.querySelector('.plugin-code-review')", 'plugin enabled')

    log('capturing screenshot')
    await Promise.race([
      cdp.send('Page.captureScreenshot', { format: 'png' }),
      sleep(15_000).then(() => {
        throw new Error('screenshot timed out')
      })
    ]).then(async (shot) => {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(join(ROOT, '.scratch', 'e2e-plugin-market.png'), Buffer.from(shot.data, 'base64'))
    })

    // Close the modal, then send a message so the host opens a session and
    // loads the adapted extension from `pluginExtensions`.
    log('closing modal')
    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('.plugin-market-actions button')].find((item) => item.textContent.includes('×'))
      button?.click()
      return true
    })()`)
    await waitFor(cdp, "!document.querySelector('.plugin-market-modal')", 'modal closed')
    log('modal closed')

    await cdp.evaluate("window.__ofEvents.length = 0; true")
    await cdp.evaluate("document.querySelector('textarea').focus()")
    await cdp.send('Input.insertText', { text: '插件市场验收：确认扩展已加载' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, key: 'Enter' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter' })

    const resumedSession = await waitFor(
      cdp,
      "window.__ofEvents.find((payload) => payload.event.type === 'settled')?.sessionId",
      'assistant turn settled',
      90_000
    )
    if (initialSession !== resumedSession) throw new Error('plugin enable did not resume the original conversation')
    log('composer turn settled')

    await sleep(1_500)
    const logText = hostLog.join('')
    const loaded = logText.includes('[agent-host] adapted plugin loaded')
    const failed = logText.includes('[agent-host] adapted plugin failed')
    // The plugin registers `dsh_demo_echo`; the session must expose it after
    // the `dsh_*` allowlist pattern is added, otherwise the model cannot call it.
    const pluginTool = logText.includes('dsh_demo_echo')
    log(`plugin log -> loaded=${loaded} failed=${failed} tool=${pluginTool}`)
    if (!loaded) throw new Error('host never loaded the adapted plugin')
    if (!pluginTool) throw new Error('adapted plugin tool missing from the session toolset')

    // The adapted plugin must also be visible (and toggleable) in the
    // left-sidebar "插件" panel, not only inside the market modal.
    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim().endsWith('插件'))
      button?.click()
      return true
    })()`)
    await waitFor(cdp, "!!document.querySelector('.dsh-adapted-plugins')", 'adapted plugin section', 15_000)
    const adaptedPanel = await cdp.evaluate("document.querySelector('.dsh-adapted-plugins').innerText")
    if (!adaptedPanel.includes(PLUGIN_ID)) throw new Error(`adapted panel missing plugin: ${adaptedPanel}`)
    if (!adaptedPanel.includes('已启用')) throw new Error(`adapted panel shows wrong state: ${adaptedPanel}`)
    log('adapted panel -> ok')
    if (failed) throw new Error('host reported an adapted plugin failure')

    const brokenDir = join(USER_DATA, 'plugins', 'adapted', 'broken-fixture')
    mkdirSync(brokenDir, { recursive: true })
    writeFileSync(join(brokenDir, 'package.json'), JSON.stringify({ type: 'module' }))
    writeFileSync(join(brokenDir, 'plugin.js'), "export default function () { throw new Error('fixture registration failed') }")
    writeFileSync(join(brokenDir, 'manifest.json'), JSON.stringify({
      id: 'broken-fixture', name: 'Broken fixture', file: 'plugin.js', enabled: true, adaptedAt: Date.now(), requires: []
    }))
    // Enabling a plugin restarts the host; the next open loads every enabled
    // plugin, which is what surfaces a registration error to the marketplace.
    const runtimeFailure = await cdp.evaluate(`(async () => {
      const before = await window.openfuture.pluginMarket(false)
      if (!before.ok) return before.error.message
      const enabled = before.value.adapted.find((item) => item.enabled)
      if (!enabled) return 'no enabled adapted plugin'
      const toggled = await window.openfuture.setPluginEnabled(enabled.id, true)
      if (!toggled.ok) return toggled.error.message
      const opened = await window.openfuture.openConversation({ projectId: 'p-e2e', conversationId: 'c-e2e' })
      if (!opened.ok) return opened.error.message
      await new Promise((done) => setTimeout(done, 800))
      const state = await window.openfuture.pluginMarket(false)
      return state.ok ? state.value.adapted.find((item) => item.id === 'broken-fixture')?.loadError : state.error.message
    })()`)
    if (runtimeFailure !== 'fixture registration failed') {
      throw new Error(`runtime load failure was not visible to the marketplace: ${runtimeFailure}`)
    }

    log('\nE2E PASSED')
  } finally {
    cdp?.close()
    app.kill()
    mock.kill()
    fixture.close()
  }
}

main().catch((error) => {
  console.error(`E2E FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
