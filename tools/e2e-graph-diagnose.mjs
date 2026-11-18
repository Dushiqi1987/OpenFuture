/**
 * One-off diagnostic: boot the built app against a throwaway profile, dump the
 * renderer state, click the 项目记忆 rail button and report what happens.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CORPUS = join(ROOT, '.scratch', 'diag-corpus')
const USER_DATA = join(ROOT, '.scratch', 'diag-userdata')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

rmSync(USER_DATA, { recursive: true, force: true })
rmSync(CORPUS, { recursive: true, force: true })
mkdirSync(join(CORPUS, 'docs'), { recursive: true })
mkdirSync(join(USER_DATA, 'config'), { recursive: true })
writeFileSync(join(USER_DATA, 'config', 'settings.json'), JSON.stringify({
  version: 1, workspace: CORPUS, model: null, allowPowerShell: false, computerUse: false,
  agentDesktop: false, contextCompression: false, subagents: false, subagentConcurrency: 1,
  groupChat: false
}, null, 2))
writeFileSync(join(USER_DATA, 'config', 'projects.json'), JSON.stringify({
  version: 1,
  activeProjectId: 'p-diag',
  projects: [{
    id: 'p-diag', name: 'diag-e2e', canonicalRoot: CORPUS, memoryPreset: 'rag',
    defaultModelRef: null, createdAt: 1_700_000_000_000, archivedAt: null, lastConversationId: 'c-diag'
  }],
  conversations: [{ id: 'c-diag', projectId: 'p-diag', title: 'diag', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }]
}, null, 2))

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.logs = []
    this.exceptions = []
  }
  async connect() {
    this.socket = new WebSocket(this.url)
    await new Promise((done, fail) => {
      this.socket.addEventListener('open', done, { once: true })
      this.socket.addEventListener('error', fail, { once: true })
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : '')
      if (message.method) {
        if (message.method === 'Runtime.consoleAPICalled') {
          this.logs.push(`[${message.params.type}] ` + message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
        }
        if (message.method === 'Runtime.exceptionThrown') {
          this.exceptions.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'exception')
        }
        if (message.method === 'Log.entryAdded') {
          this.logs.push(`[log:${message.params.entry.level}] ${message.params.entry.text}`)
        }
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.fail(new Error(message.error.message))
      else pending.done(message.result)
    })
    await this.send('Runtime.enable')
    await this.send('Log.enable')
    await this.send('Page.enable')
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'eval failed')
    return result.result?.value
  }
}

async function pickPort() {
  return new Promise((done) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => done(address.port))
    })
  })
}

async function findTarget(port) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = targets.find((target) => target.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(300)
  }
  throw new Error('no CDP target')
}

let app = null
try {
  const port = await pickPort()
  const env = { ...process.env, OPENFUTURE_USER_DATA: USER_DATA }
  delete env.ELECTRON_RUN_AS_NODE
  app = spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`], { cwd: ROOT, env, stdio: 'ignore' })
  const cdp = await new Cdp(await findTarget(port)).connect()
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`typeof window.openfuture === 'object'`)) break
    await sleep(250)
  }
  await sleep(2500)

  const state = await cdp.evaluate(`(() => {
    const labels = [...document.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label'))
    const footers = [...document.querySelectorAll('.dsh-footer-actions button')].map((el) => el.getAttribute('aria-label') || el.textContent)
    return {
      href: location.href,
      title: document.title,
      bodyText: document.body.innerText.slice(0, 1400),
      labels,
      footers,
      backdrops: document.querySelectorAll('.modal-backdrop').length,
      panels: [...document.querySelectorAll('[class*="panel"]')].map((el) => el.className).slice(0, 30)
    }
  })()`)
  console.log('STATE', JSON.stringify(state, null, 2))

  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__boot = { started: Date.now(), errors: [], rejections: [] };
      window.addEventListener('error', (event) => window.__boot.errors.push(String(event.message) + ' @ ' + String(event.filename) + ':' + String(event.lineno)));
      window.addEventListener('unhandledrejection', (event) => window.__boot.rejections.push(String(event.reason && (event.reason.stack || event.reason))));
      window.addEventListener('DOMContentLoaded', () => { window.__boot.domReady = Date.now() });`
  })
  cdp.logs.length = 0
  cdp.exceptions.length = 0
  await cdp.send('Page.reload', { ignoreCache: true })
  await sleep(8000)
  const boot = await cdp.evaluate(`(() => ({
    boot: window.__boot,
    rootHtml: document.getElementById('root')?.innerHTML.slice(0, 260) ?? 'no root',
    text: document.body.innerText.slice(0, 300)
  }))()`)
  console.log('BOOT', JSON.stringify(boot, null, 2))
  console.log('BOOT-LOGS', JSON.stringify(cdp.logs.slice(-30), null, 2))
  console.log('BOOT-EXCEPTIONS', JSON.stringify(cdp.exceptions.slice(-10), null, 2))

  const probe = await cdp.evaluate(`(async () => {
    const api = window.openfuture || {}
    const out = { apiKeys: Object.keys(api).length, readyState: document.readyState }
    const time = async (label, fn) => {
      const started = performance.now()
      try {
        const value = await Promise.race([
          Promise.resolve().then(fn),
          new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 5000))
        ])
        out[label] = { ms: Math.round(performance.now() - started), ok: true, sample: JSON.stringify(value).slice(0, 500) }
      } catch (error) {
        out[label] = { ms: Math.round(performance.now() - started), ok: false, error: String(error) }
      }
    }
    await time('getSettings', () => api.getSettings())
    await time('listProjects', () => api.listProjects())
    await time('listConversations', () => api.listConversations('p-diag'))
    return out
  })()`)
  console.log('PROBE', JSON.stringify(probe, null, 2))

  const clicked = await cdp.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="项目记忆"]')
    if (!button) return 'missing'
    button.click()
    return 'clicked'
  })()`)
  await sleep(2500)
  const after = await cdp.evaluate(`(() => ({
    memoryPanels: document.querySelectorAll('.memory-panel').length,
    backdrops: document.querySelectorAll('.modal-backdrop').length,
    tabs: [...document.querySelectorAll('.memory-tab')].map((el) => el.textContent),
    errors: [...document.querySelectorAll('.memory-error')].map((el) => el.textContent)
  }))()`)
  console.log('CLICK', clicked, 'AFTER', JSON.stringify(after, null, 2))
  console.log('EXCEPTIONS', JSON.stringify(cdp.exceptions, null, 2))
  console.log('LOGS', JSON.stringify(cdp.logs.slice(-40), null, 2))

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(ROOT, '.scratch', 'diag-graph.png'), Buffer.from(shot.data, 'base64'))
  console.log('screenshot -> .scratch/diag-graph.png')
  try { cdp.socket?.close() } catch {}
  console.log('DIAG DONE')
} catch (error) {
  console.error('DIAG FAILED', error)
} finally {
  try { app?.kill() } catch {}
}
process.exit(0)
