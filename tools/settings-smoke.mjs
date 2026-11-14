/**
 * End-to-end check of the grouped settings dialog.
 *
 * Boots the built Electron app against a copied profile (or an empty one with
 * `EMPTY=1`), opens 设置, switches 外观 > 消息密度 to compact, saves, and
 * verifies the persisted `ui` block and the document datasets. With `THINKING=1`
 * it also changes 对话与输入 > 思考等级 and checks that the agent host is
 * stopped so the next session starts with the new level.
 *
 * Run: node tools/settings-smoke.mjs  (needs `electron-vite build`)
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const USER_DATA = join(ROOT, '.scratch/settings-smoke-userdata')
const REAL = join(process.env.APPDATA ?? '', 'OpenFuture')

function pickPort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function seed() {
  rmSync(USER_DATA, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  if (process.env.EMPTY === '1') {
    mkdirSync(join(USER_DATA, 'config'), { recursive: true })
    writeFileSync(join(USER_DATA, 'config/settings.json'), '{}')
    return
  }
  for (const item of ['config', 'Local State']) {
    const source = join(REAL, item)
    if (!existsSync(source)) continue
    cpSync(source, join(USER_DATA, item), { recursive: true })
  }
  rmSync(join(USER_DATA, 'config/secrets/model-credential.bin'), { force: true })
}

async function main() {
  seed()
  const port = await pickPort()
  const appEnv = { ...process.env, OPENFUTURE_USER_DATA: USER_DATA }
  delete appEnv.ELECTRON_RUN_AS_NODE
  const child = spawn(join(ROOT, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    env: appEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))

  try {
    let target
    for (let i = 0; i < 120; i += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        target = list.find((t) => t.type === 'page')
        if (target) break
      } catch {}
      await sleep(500)
    }
    if (!target) throw new Error('no page target')

    const ws = new WebSocket(target.webSocketDebuggerUrl)
    let seq = 0
    const pending = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      const entry = pending.get(msg.id)
      if (!entry) return
      pending.delete(msg.id)
      entry.resolve(msg)
    })
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++seq
        pending.set(id, { resolve })
        ws.send(JSON.stringify({ id, method, params }))
      })
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))

    const evaluate = async (expression) => {
      const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 400))
      return res.result?.result?.value
    }

    for (let i = 0; i < 120; i += 1) {
      const ready = await evaluate("typeof window.openfuture === 'object' && document.querySelector('button[title=\"设置\"]') !== null")
      if (ready) break
      await sleep(500)
    }

    await evaluate(`document.querySelector('button[title="设置"]')?.click()`)
    await sleep(800)
    const nav = await evaluate("[...document.querySelectorAll('.settings-nav-item')].map((n) => n.textContent.trim())")
    console.log('nav ->', JSON.stringify(nav))

    const appearance = await evaluate(`(() => {
      const selects = [...document.querySelectorAll('.settings-content select')]
      return { count: selects.length, values: selects.map((s) => s.value) }
    })()`)
    console.log('appearance ->', JSON.stringify(appearance))

    await evaluate(`(() => {
      const selects = [...document.querySelectorAll('.settings-content select')]
      const density = selects.find((s) => [...s.options].some((o) => o.value === 'compact'))
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setter.call(density, 'compact')
      density.dispatchEvent(new Event('change', { bubbles: true }))
      return density.value
    })()`)
    await sleep(300)

    await evaluate(`(() => {
      const button = [...document.querySelectorAll('.settings-content button')].find((b) => b.textContent.includes('保存设置'))
      button?.click()
      return Boolean(button)
    })()`)
    await sleep(2500)

    const closed = await evaluate("document.querySelector('.settings-panel') === null")
    const datasets = await evaluate("({ density: document.documentElement.dataset.density, timestamps: document.documentElement.dataset.timestamps, theme: document.documentElement.dataset.theme })")
    const raw = JSON.parse(readFileSync(join(USER_DATA, 'config/settings.json'), 'utf8'))
    console.log('saved ->', JSON.stringify({ closed, ui: raw.ui }))
    console.log('datasets ->', JSON.stringify(datasets))
    console.log('notice ->', await evaluate("document.querySelector('.banner')?.textContent ?? ''"))
    let thinkingOk = true
    if (process.env.THINKING === '1') {
      const stopped = (log.match(/\[agent-host\] stopped/g) ?? []).length
      await evaluate(`document.querySelector('button[title="设置"]')?.click()`)
      await sleep(600)
      await evaluate(`[...document.querySelectorAll('.settings-nav-item')].find((n) => n.textContent.includes('对话与输入'))?.click()`)
      await sleep(400)
      await evaluate(`(() => {
        const selects = [...document.querySelectorAll('.settings-content select')]
        const thinking = selects.find((s) => [...s.options].some((o) => o.value === 'high'))
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
        setter.call(thinking, 'high')
        thinking.dispatchEvent(new Event('change', { bubbles: true }))
      })()`)
      await evaluate(`[...document.querySelectorAll('.settings-content button')].find((b) => b.textContent.includes('保存设置'))?.click()`)
      await sleep(9000)
      const after = JSON.parse(readFileSync(join(USER_DATA, 'config/settings.json'), 'utf8'))
      const restarted = (log.match(/\[agent-host\] stopped/g) ?? []).length > stopped
      thinkingOk = after.ui?.thinkingLevel === 'high' && restarted
      console.log('thinking ->', JSON.stringify({ level: after.ui?.thinkingLevel, restarted }))
    }

    const passed = raw.ui?.density === 'compact' && closed && datasets.density === 'compact' && thinkingOk
    console.log(passed ? 'SETTINGS SMOKE PASSED' : 'SETTINGS SMOKE FAILED')
    process.exitCode = passed ? 0 : 1
    ws.close()
  } finally {
    child.kill('SIGKILL')
    await sleep(500)
    if (log.includes('Error')) console.log('app log tail ->', log.slice(-800))
  }
}

main().catch((error) => {
  console.error('SETTINGS SMOKE FAILED', error)
  process.exitCode = 1
})
