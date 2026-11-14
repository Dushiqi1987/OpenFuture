/**
 * End-to-end check of sidebar > 群聊: add an extra model profile, bind it to the
 * critic, start a chat from the composer pill, and assert the transcript was
 * persisted and that the host resolved a per-role model.
 *
 * Run: node tools/e2e-group-panel.mjs  (needs `electron-vite build`)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const USER_DATA = join(ROOT, '.scratch', 'e2e-group-panel-userdata')
const WORKSPACE = join(ROOT, '.scratch', 'e2e-group-panel-workspace')
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
        subagents: false,
        subagentConcurrency: 2,
        groupChat: true
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
            title: '群聊面板验收',
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
      MOCK_GROUP_CHAT: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  mock.stderr.on('data', (chunk) => process.stderr.write(`[mock] ${chunk}`))

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
      return window.openfuture.saveModel({
        baseUrl: 'http://127.0.0.1:${MOCK_PORT}/v1',
        modelId: 'mock-model',
        displayName: 'Mock Model',
        contextWindow: 32000,
        maxTokens: 2048,
        apiKey: 'mock-key'
      })
    })()`)
    if (!saved?.ok) throw new Error(`saveModel failed: ${JSON.stringify(saved)}`)

    await sleep(2_000)
    await cdp.send('Page.reload', { ignoreCache: false })
    await sleep(800)
    await waitFor(cdp, "typeof window.openfuture === 'object'", 'preload bridge after reload')
    await waitFor(
      cdp,
      "(() => (document.body.innerText || '').includes('群聊面板验收'))()",
      'conversation bootstrap'
    )

    // Sidebar entry -> panel.
    const opened = await cdp.evaluate(`(() => {
      const nav = [...document.querySelectorAll('.dsh-nav button')].find((button) => button.textContent.includes('群聊'))
      if (!nav) return 'no-nav'
      nav.click()
      return 'clicked'
    })()`)
    console.log('sidebar entry ->', opened)
    if (opened !== 'clicked') throw new Error(`sidebar entry missing: ${opened}`)
    await waitFor(cdp, "!!document.querySelector('.group-chats-modal')", 'group chats panel')

    // Add an extra model profile through the real form.
    await cdp.evaluate(`(() => {
      const setValue = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const inputs = [...document.querySelectorAll('.group-chats-input')]
      setValue(inputs[0], 'Mock 评审模型')
      setValue(inputs[1], 'http://127.0.0.1:${MOCK_PORT}/v1')
      setValue(inputs[2], 'mock-critic')
      setValue(inputs[3], 'mock-critic-key')
      document.querySelector('.group-chats-form-actions .primary-button').click()
      return true
    })()`)
    const profileId = await waitFor(
      cdp,
      `(async () => {
        const settings = await window.openfuture.getSettings()
        if (!settings.ok) return ''
        const profiles = settings.value.groupModelProfiles || []
        return profiles.length === 1 ? profiles[0].id : ''
      })()`,
      'saved model profile',
      20_000
    )
    console.log('profile ->', profileId)
    await sleep(2_500)

    // Re-open the panel: the profile save restarts the host, which closes it.
    const reopened = await cdp.evaluate(`(() => {
      const nav = [...document.querySelectorAll('.dsh-nav button')].find((button) => button.textContent.includes('群聊'))
      const modal = document.querySelector('.group-chats-modal')
      if (!modal) nav?.click()
      return Boolean(document.querySelector('.group-chats-modal'))
    })()`)
    if (!reopened) {
      await waitFor(cdp, "!!document.querySelector('.group-chats-modal')", 'panel after restart')
    }

    // Bind the profile to the critic.
    const bound = await cdp.evaluate(`(async () => {
      const selects = [...document.querySelectorAll('.group-chats-member select')]
      if (selects.length !== 3) return 'missing-selects'
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setter.call(selects[1], ${JSON.stringify(profileId)})
      selects[1].dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((done) => setTimeout(done, 500))
      const settings = await window.openfuture.getSettings()
      return settings.ok ? settings.value.groupChatModels.critic : 'no-settings'
    })()`)
    console.log('critic binding ->', bound)
    if (bound !== profileId) throw new Error(`critic binding failed: ${bound}`)

    const panelShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const panelShotPath = join(ROOT, '.scratch', 'e2e-group-panel-modal.png')
    writeFileSync(panelShotPath, Buffer.from(panelShot.data, 'base64'))
    console.log('panel screenshot ->', panelShotPath)

    await cdp.evaluate("document.querySelector('.group-chats-modal .dsh-modal-close').click()")
    await waitFor(cdp, "!document.querySelector('.group-chats-modal')", 'panel closed')

    // Start a chat from the composer pill.
    await cdp.evaluate(`(() => {
      const pill = [...document.querySelectorAll('.dsh-pill')].find((button) => button.textContent.includes('群聊'))
      pill.click()
      return true
    })()`)
    await waitFor(cdp, "!!document.querySelector('.group-chat-modal')", 'group chat dialog')
    await cdp.evaluate(`(() => {
      const textarea = document.querySelector('.group-chat-modal textarea')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(textarea, '面板验收：两位成员分别用不同模型讨论')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await cdp.evaluate(`(() => {
      const opened = window.__ofEvents
      window.__ofEvents = opened || []
      return true
    })()`)
    await cdp.evaluate(`(() => {
      window.openfuture.onAgentEvent((payload) => window.__ofEvents.push(payload))
      return true
    })()`)
    await cdp.evaluate("document.querySelector('.group-chat-modal .primary-button').click()")

    let ended = 0
    try {
      ended = await waitFor(
        cdp,
        "(() => (window.__ofEvents || []).some((p) => p.event && p.event.type === 'group' && p.event.event.type === 'end') ? 1 : 0)()",
        'group chat end',
        90_000
      )
    } catch (error) {
      const debug = await cdp.evaluate(`(() => {
        const events = (window.__ofEvents || []).map((p) => p.event && p.event.type)
        const modal = document.querySelector('.group-chat-modal')
        const button = modal ? modal.querySelector('.primary-button') : null
        return JSON.stringify({
          events,
          modal: Boolean(modal),
          buttonDisabled: button ? button.disabled : null,
          notice: (document.body.innerText || '').slice(-600)
        })
      })()`)
      console.log('debug ->', debug)
      console.log('host log tail ->', hostLog.join('').split('\n').slice(-30).join('\n'))
      throw error
    }
    console.log('group chat ended ->', ended)
    await sleep(1_500)

    const summary = await cdp.evaluate(`(async () => {
      const events = (window.__ofEvents || []).filter((p) => p.event && p.event.type === 'group').map((p) => p.event.event)
      const end = events.find((event) => event.type === 'end')
      const list = await window.openfuture.listGroupChats()
      const chats = list.ok ? list.value : []
      const detail = chats.length > 0 ? await window.openfuture.getGroupChat(chats[0].chatId) : null
      return {
        status: end ? end.status : '',
        messages: events.filter((event) => event.type === 'message').length,
        archived: chats.length,
        archivedMessages: detail && detail.ok ? detail.value.messages.length : 0,
        archivedCritic: detail && detail.ok ? detail.value.members.critic : '',
        errors: (window.__ofEvents || []).filter((p) => p.event && p.event.type === 'error').map((p) => p.event.message)
      }
    })()`)
    console.log('summary ->', JSON.stringify(summary, null, 2))

    const logText = hostLog.join('')
    console.log('role models log ->', (logText.match(/\[agent-host\] group models[^\n]*/g) ?? []).join(' | '))

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const shotPath = join(ROOT, '.scratch', 'e2e-group-panel.png')
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
    console.log('screenshot ->', shotPath)

    const failures = []
    if (summary.status !== 'consensus') failures.push(`unexpected status: ${summary.status}`)
    if (summary.messages < 5) failures.push(`expected >=5 messages, got ${summary.messages}`)
    if (summary.archived !== 1) failures.push(`expected 1 archived chat, got ${summary.archived}`)
    if (summary.archivedMessages !== summary.messages) {
      failures.push(`archived messages ${summary.archivedMessages} != live ${summary.messages}`)
    }
    if (summary.archivedCritic !== profileId) failures.push(`archived critic binding: ${summary.archivedCritic}`)
    if (!logText.includes('critic=profile')) failures.push('host did not resolve a profile model for the critic')
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
