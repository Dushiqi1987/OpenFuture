/**
 * End-to-end check of MCP servers and skills.
 *
 * Seeds a throwaway profile with one stdio MCP server (`.scratch/mcp/demo-server.mjs`,
 * tool `echo`) and one skill, boots the built Electron app against a mock model,
 * sends a message so the UI opens a session, and asserts the agent host:
 *   1. connects the server and exposes `mcp__demo__echo`,
 *   2. loads the skill into the resource loader.
 *
 * Run: node tools/mcp-smoke.mjs  (needs `electron-vite build`)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const USER_DATA = join(ROOT, '.scratch/mcp-smoke-userdata')
const WORKSPACE = join(ROOT, '.scratch/mcp-smoke-workspace')
const ELECTRON = join(ROOT, 'node_modules/electron/dist/electron.exe')
const DEMO_SERVER = join(ROOT, '.scratch/mcp/demo-server.mjs')

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
        activeProjectId: 'p-mcp',
        projects: [
          {
            id: 'p-mcp',
            name: 'mcp',
            canonicalRoot: WORKSPACE,
            memoryPreset: 'off',
            defaultModelRef: null,
            createdAt: 1_700_000_000_000,
            archivedAt: null,
            lastConversationId: 'c-mcp'
          }
        ],
        conversations: [
          {
            id: 'c-mcp',
            projectId: 'p-mcp',
            title: 'MCP 验收',
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000
          }
        ]
      },
      null,
      2
    )
  )

  // The built-in MCP extension reads `<agentDir>/mcp.json`; agentDir is
  // `<userData>/pi/agent`. `direct` makes the tools visible to the model.
  mkdirSync(join(USER_DATA, 'pi', 'agent'), { recursive: true })
  writeFileSync(
    join(USER_DATA, 'pi', 'agent', 'mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          demo: {
            command: process.execPath,
            args: [DEMO_SERVER],
            exposure: 'direct',
            enabled: true,
            description: '本地 echo 演示服务'
          }
        }
      },
      null,
      2
    )
  )

  const skillDir = join(USER_DATA, 'skills', 'release-notes')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: release-notes',
      'description: 把一组改动整理成发布说明。',
      '---',
      '',
      '把用户给出的改动按「新增 / 修复 / 破坏性变更」分组，每条一行。',
      ''
    ].join('\n')
  )
}

async function findTarget(port) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(800)
      })
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
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
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
  const mockPort = await pickPort()
  const cdpPort = await pickPort()
  console.log(`ports -> mock=${mockPort} cdp=${cdpPort}`)
  seedUserData()

  const mock = spawn(process.execPath, [join(ROOT, 'tools', 'mock-model', 'server.mjs')], {
    env: {
      ...process.env,
      MOCK_MODEL_PORT: String(mockPort),
      MOCK_MODEL_ID: 'mock-model',
      MOCK_DELAY_MS: '8',
      MOCK_REPORT_TOOLS: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  mock.stdout.on('data', (chunk) => process.stdout.write(`[mock] ${chunk}`))
  mock.stderr.on('data', (chunk) => process.stderr.write(`[mock] ${chunk}`))

  // The DSH shell exports ELECTRON_RUN_AS_NODE=1; without removing it the
  // Electron binary behaves like plain Node and crashes on app.setPath.
  const appEnv = { ...process.env, OPENFUTURE_USER_DATA: USER_DATA }
  delete appEnv.ELECTRON_RUN_AS_NODE
  const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${cdpPort}`], {
    cwd: ROOT,
    env: appEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const appLog = []
  app.stdout.on('data', (chunk) => {
    appLog.push(chunk.toString())
    process.stdout.write(`[app] ${chunk}`)
  })
  app.stderr.on('data', (chunk) => {
    appLog.push(chunk.toString())
    process.stderr.write(`[app] ${chunk}`)
  })

  let cdp
  try {
    await sleep(1_000)
    cdp = new Cdp(await findTarget(cdpPort))
    await cdp.open()
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await waitFor(cdp, "typeof window.openfuture === 'object'", 'preload bridge')

    const saved = await cdp.evaluate(`(async () => {
      return window.openfuture.saveModel({
        baseUrl: 'http://127.0.0.1:${mockPort}/v1',
        modelId: 'mock-model',
        displayName: 'Mock Model',
        contextWindow: 32000,
        maxTokens: 2048,
        apiKey: 'mock-key'
      })
    })()`)
    console.log('saveModel ->', JSON.stringify(saved).slice(0, 160))

    await sleep(2_000)
    await cdp.send('Page.reload', { ignoreCache: false })
    await sleep(800)
    await waitFor(cdp, "typeof window.openfuture === 'object'", 'preload bridge after reload')
    await waitFor(
      cdp,
      "(() => ((document.body.innerText || '').includes('MCP 验收') ? 'conversation' : ''))()",
      'conversation bootstrap'
    )

    await cdp.evaluate(`(() => {
      window.__ofEvents = []
      window.openfuture.onAgentEvent((payload) => window.__ofEvents.push(payload))
      return true
    })()`)

    // Drive the real composer: opening the session is what starts the MCP
    // extension, so a plain IPC sendMessage would skip the UI's first-send path.
    await cdp.evaluate(`(() => {
      const textarea = document.querySelector('textarea')
      if (!textarea) return false
      textarea.focus()
      return true
    })()`)
    await cdp.send('Input.insertText', { text: '检查 MCP 与技能是否就绪' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })

    await waitFor(
      cdp,
      "(() => (window.__ofEvents || []).some((item) => (item.event?.type ?? item.type) === 'settled') ? 'settled' : '')()",
      'composer turn settled',
      90_000
    )
    await sleep(3_000)

    // The settings dialog surfaces both stores: one row per server/skill.
    await cdp.evaluate(`(() => {
      const button = document.querySelector('[aria-label="设置"]')
      if (button) button.click()
      return true
    })()`)
    const nav = (label) => `(() => {
      const item = [...document.querySelectorAll('.settings-nav-item')].find((node) => node.textContent.includes('${label}'))
      if (!item) return 'missing'
      item.click()
      return 'clicked'
    })()`
    await waitFor(cdp, nav('MCP 服务').replace("return 'clicked'", "return document.querySelectorAll('.settings-entity').length > 0 ? 'rows' : ''"), 'mcp section rows')
    const mcpPanel = await cdp.evaluate(`(() => {
      const panel = document.querySelector('.settings-panel')
      return panel ? panel.innerText.slice(0, 600) : ''
    })()`)
    console.log('mcp settings ->', mcpPanel.slice(0, 400))
    if (!mcpPanel.includes('demo')) throw new Error('MCP settings section does not list the demo server')
    await cdp.evaluate(nav('技能'))
    await waitFor(cdp, "(() => (document.querySelector('.settings-panel')?.innerText || '').includes('release-notes') ? 'row' : '')()", 'skills section rows')
    console.log('settings sections -> ok')

    // The mock model echoes the tool names it received in this request, so this
    // proves the MCP tools were declared to the model (not merely registered).
    const reply = await cdp.evaluate(`(() => {
      const messages = (window.__ofEvents || [])
        .map((item) => item.event ?? item)
        .filter((event) => event.type === 'assistant-message')
      const last = messages[messages.length - 1]
      return last?.message?.text ?? ''
    })()`)
    await cdp.send('Page.captureScreenshot', { format: 'png' }).then(async (shot) => {
      if (!shot?.data) return
      const { writeFileSync } = await import('node:fs')
      writeFileSync(join(ROOT, '.scratch/mcp-settings.png'), Buffer.from(shot.data, 'base64'))
    })
    const text = appLog.join('')
    const skillsLine = text.split('\n').find((line) => line.includes('[agent-host] skills=')) ?? ''
    const hasMcpTool = String(reply).includes('mcp__demo__echo')
    const hasSkill = skillsLine.includes('release-notes')
    console.log('model saw tools ->', String(reply).slice(0, 400))
    console.log('skills line ->', skillsLine.slice(0, 200))
    if (!hasMcpTool) throw new Error('MCP tool mcp__demo__echo was not declared to the model')
    if (!hasSkill) throw new Error('skill release-notes was not loaded')

    // `/skill:<name>` must expand the SKILL.md body into the prompt.
    await cdp.evaluate(`(() => {
      const textarea = document.querySelector('textarea')
      if (textarea) textarea.focus()
      return true
    })()`)
    await cdp.send('Input.insertText', { text: '/skill:release-notes 检查发布说明' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await waitFor(
      cdp,
      "(() => (window.__ofEvents || []).filter((item) => (item.event?.type ?? item.type) === 'settled').length >= 2 ? 'second-turn' : '')()",
      'skill turn settled',
      90_000
    )
    await sleep(1_500)
    const skillReply = await cdp.evaluate(`(() => {
      const messages = (window.__ofEvents || [])
        .map((item) => item.event ?? item)
        .filter((event) => event.type === 'assistant-message')
      return messages[messages.length - 1]?.message?.text ?? ''
    })()`)
    console.log('skill expansion ->', String(skillReply).slice(0, 300))
    if (!String(skillReply).includes('把用户给出的改动')) {
      throw new Error('skill body was not expanded into the prompt')
    }
    console.log('MCP SMOKE PASSED')
  } finally {
    cdp?.close()
    app.kill()
    mock.kill()
  }
}

main().catch((error) => {
  console.error('MCP SMOKE FAILED:', error)
  process.exitCode = 1
})
