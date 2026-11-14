/**
 * End-to-end check of the sidebar Skills panel: search, library install,
 * enable/disable and the detail view. Boots the built Electron app against a
 * throwaway profile; no model turn is needed because skills are read by the
 * main process.
 *
 * Run: node tools/skills-panel-smoke.mjs  (needs `electron-vite build`)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const USER_DATA = join(ROOT, '.scratch/skills-smoke-userdata')
const WORKSPACE = join(ROOT, '.scratch/skills-smoke-workspace')
const ELECTRON = join(ROOT, 'node_modules/electron/dist/electron.exe')

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
    join(USER_DATA, 'config/settings.json'),
    JSON.stringify({ version: 1, workspace: WORKSPACE, model: null, subagents: false, groupChat: false }, null, 2)
  )
  writeFileSync(
    join(USER_DATA, 'config/projects.json'),
    JSON.stringify(
      {
        version: 1,
        activeProjectId: 'p-skills',
        projects: [
          {
            id: 'p-skills',
            name: 'skills',
            canonicalRoot: WORKSPACE,
            memoryPreset: 'off',
            defaultModelRef: null,
            createdAt: 1_700_000_000_000,
            archivedAt: null,
            lastConversationId: 'c-skills'
          }
        ],
        conversations: [
          { id: 'c-skills', projectId: 'p-skills', title: '技能验收', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }
        ]
      },
      null,
      2
    )
  )
}

async function findTarget(port) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(800) })
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
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
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
  const cdpPort = await pickPort()
  console.log(`cdp port -> ${cdpPort}`)
  seedUserData()

  const appEnv = { ...process.env, OPENFUTURE_USER_DATA: USER_DATA }
  delete appEnv.ELECTRON_RUN_AS_NODE
  const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${cdpPort}`], {
    cwd: ROOT,
    env: appEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  app.stdout.on('data', (chunk) => process.stdout.write(`[app] ${chunk}`))
  app.stderr.on('data', (chunk) => process.stderr.write(`[app] ${chunk}`))

  let cdp
  try {
    await sleep(1_000)
    cdp = new Cdp(await findTarget(cdpPort))
    await cdp.open()
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await waitFor(cdp, "typeof window.openfuture === 'object'", 'preload bridge')

    await waitFor(cdp, "document.querySelectorAll('.dsh-nav button').length > 0 ? 'nav' : ''", 'sidebar nav')
    const navTexts = await cdp.evaluate(`(() => [...document.querySelectorAll('.dsh-nav button')].map((node) => node.textContent.trim()))()`)
    console.log('nav ->', JSON.stringify(navTexts))
    const opened = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('.dsh-nav button')].find((node) => node.textContent.includes('技能'))
      if (!button) return 'missing'
      button.click()
      return 'clicked'
    })()`)
    console.log('sidebar 技能 ->', opened)
    if (opened !== 'clicked') throw new Error('sidebar 技能 button missing')
    await waitFor(cdp, "document.querySelector('.skills-modal') ? 'open' : ''", 'skills modal')

    const initial = await cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.skills-card')]
      return { count: cards.length, names: cards.map((card) => card.querySelector('.skills-card-title')?.textContent ?? '') }
    })()`)
    console.log('installed ->', JSON.stringify(initial))
    if (initial.count < 2) throw new Error('starter skills were not seeded')
    if (!initial.names.some((name) => name.includes('code-review'))) throw new Error('code-review missing')

    // Search filters both tabs.
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.skills-search input')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, 'release')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(400)
    const searched = await cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.skills-card')]
      return { count: cards.length, names: cards.map((card) => card.querySelector('.skills-card-title')?.textContent ?? '') }
    })()`)
    console.log('search release ->', JSON.stringify(searched))
    if (searched.count !== 1 || !searched.names[0].includes('release-notes')) {
      throw new Error('search did not narrow to release-notes')
    }

    // Clear search, open the library tab and install a template.
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.skills-search input')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const tab = [...document.querySelectorAll('.skills-tabs > button')].find((node) => node.textContent.includes('技能库'))
      tab.click()
      return true
    })()`)
    await waitFor(cdp, "document.querySelectorAll('.skills-card.library').length >= 4 ? 'library' : ''", 'library tab')
    const target = await cdp.evaluate(`(() => {
      const card = [...document.querySelectorAll('.skills-card.library')].find((node) => !node.querySelector('button')?.disabled)
      if (!card) return null
      const name = card.querySelector('.skills-card-title')?.textContent ?? ''
      card.querySelector('button').click()
      return name
    })()`)
    console.log('install ->', target)
    if (!target) throw new Error('no installable library entry')
    await waitFor(
      cdp,
      `(() => (document.body.innerText || '').includes(${JSON.stringify(`已安装 ${target}`)}) ? 'notice' : '')()`,
      'install notice'
    )

    // Toggle the newly installed skill off through the card switch.
    const toggled = await cdp.evaluate(`(() => {
      const card = [...document.querySelectorAll('.skills-card')].find((node) => (node.querySelector('.skills-card-title')?.textContent ?? '').includes(${JSON.stringify(target)}))
      if (!card) return 'missing'
      card.querySelector('.skills-toggle').click()
      return 'clicked'
    })()`)
    console.log('toggle ->', toggled)
    await sleep(600)
    const list = await cdp.evaluate(`(async () => {
      const result = await window.openfuture.listSkills()
      return result.ok ? result.value.map((skill) => ({ name: skill.name, enabled: skill.enabled, origin: skill.origin })) : []
    })()`)
    const entry = list.find((item) => item.name === target)
    console.log('after toggle ->', JSON.stringify(entry))
    if (!entry || entry.enabled !== false) throw new Error('toggle did not persist')

    await cdp.send('Page.captureScreenshot', { format: 'png' }).then((shot) =>
      writeFileSync(join(ROOT, '.scratch/skills-panel.png'), Buffer.from(shot.data, 'base64'))
    )
    console.log('screenshot -> .scratch/skills-panel.png')

    // Detail view renders the SKILL.md body and metadata.
    await cdp.evaluate(`(() => {
      const card = [...document.querySelectorAll('.skills-card')].find((node) => (node.querySelector('.skills-card-title')?.textContent ?? '').includes('code-review'))
      card.click()
      return true
    })()`)
    const detail = await waitFor(
      cdp,
      "(() => { const node = document.querySelector('.skills-detail-body'); return node ? node.textContent.length : 0 })()",
      'skill detail body'
    )
    console.log('detail body chars ->', detail)
    if (detail < 40) throw new Error('detail body was empty')

    await cdp.send('Page.captureScreenshot', { format: 'png' }).then((shot) =>
      writeFileSync(join(ROOT, '.scratch/skills-detail.png'), Buffer.from(shot.data, 'base64'))
    )
    console.log('screenshot -> .scratch/skills-detail.png')
    console.log('SKILLS PANEL SMOKE PASSED')
  } finally {
    cdp?.close()
    app.kill()
  }
}

main().catch((error) => {
  console.error('SKILLS PANEL SMOKE FAILED:', error)
  process.exitCode = 1
})
