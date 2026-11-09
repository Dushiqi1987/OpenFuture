#!/usr/bin/env node
/**
 * UI smoke test over the Chrome DevTools Protocol.
 *
 * Prereqs:
 *   - mock model server on 127.0.0.1:8787
 *   - OpenFuture running with --remote-debugging-port=9222
 *
 * Verifies: workspace/model boot, streaming reply, stop, session restore.
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const MOCK_MARKER = '本地 Mock 模型'
const PROMPT = '你好，请用一句话说明这次测试验证了什么。'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function findPage() {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((response) => response.json())
      const page = targets.find((target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
      if (page) return page
    } catch {
      // Electron may still be starting.
    }
    await sleep(300)
  }
  throw new Error('CDP page target not found')
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      }
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'evaluate failed')
    }
    return result.result.value
  }

  close() {
    this.ws.close()
  }
}

async function bodyText(cdp) {
  return cdp.evaluate('document.body.innerText')
}

async function waitFor(cdp, predicateSource, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const text = await bodyText(cdp)
      if (text.includes(predicateSource)) return text
    } catch {
      // Renderer may be reloading.
    }
    await sleep(250)
  }
  throw new Error(`timed out waiting for: ${label}`)
}

async function sendPrompt(cdp, text) {
  const filled = await cdp.evaluate(`(() => {
    const textarea = document.querySelector('textarea')
    if (!textarea) return 'no-textarea'
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(textarea, ${JSON.stringify(text)})
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    return textarea.value
  })()`)
  if (filled === 'no-textarea') throw new Error('composer textarea missing')
  const clicked = await cdp.evaluate(`(() => {
    const button = document.querySelector('.send-button')
    if (!button) return false
    button.click()
    return true
  })()`)
  if (!clicked) throw new Error('send button missing')
}

async function main() {
  const page = await findPage()
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Runtime.enable')

  const bootText = await bodyText(cdp)
  const workspaceShown = bootText.includes('OpenFuture') || bootText.includes('工作区')
  console.log('[smoke] page:', page.url)
  console.log('[smoke] workspace/model UI present:', workspaceShown)

  const memoryRaw = await cdp.evaluate('window.openfuture.memoryDiagnostics().then((result) => JSON.stringify(result))')
  const memoryResponse = JSON.parse(memoryRaw)
  const memory = memoryResponse.ok
    ? memoryResponse.value
    : {
        ok: false,
        sqliteVersion: 'n/a',
        fts5: false,
        tokenizer: 'n/a',
        sampleMatches: 0,
        detail: memoryResponse.error?.message || 'IPC failed'
      }
  console.log(
    '[smoke] memory FTS5:',
    JSON.stringify({
      ok: memory.ok,
      sqlite: memory.sqliteVersion,
      fts5: memory.fts5,
      tokenizer: memory.tokenizer,
      sampleMatches: memory.sampleMatches,
      detail: memory.detail
    })
  )
  if (!memory.ok || !memory.fts5 || memory.sampleMatches < 1) {
    console.error('[smoke] memory FTS5 diagnostics FAILED')
    process.exitCode = 1
  }

  const initialSessions = await cdp.evaluate("document.querySelectorAll('.session-item').length")
  console.log('[smoke] session items before:', initialSessions)

  await sendPrompt(cdp, PROMPT)
  console.log('[smoke] prompt sent, waiting for streaming reply')

  await waitFor(cdp, MOCK_MARKER, 30_000, 'streamed mock reply')
  const replyText = await bodyText(cdp)
  console.log('[smoke] streaming reply received:', replyText.includes(MOCK_MARKER))
  console.log('[smoke] reply mentions utilityProcess:', replyText.includes('utilityProcess'))

  const replyMessages = await cdp.evaluate(`(() => Array.from(document.querySelectorAll('.message')).map((node) => node.innerText.slice(0, 180)))()`)
  console.log('[smoke] messages:', JSON.stringify(replyMessages, null, 2))

  // Give the stream a moment to settle and persist the session.
  await sleep(1500)
  const settledText = await bodyText(cdp)
  console.log('[smoke] status idle:', settledText.includes('空闲') || settledText.includes('就绪') || settledText.includes('Idle'))
  const sessionsAfter = await cdp.evaluate("document.querySelectorAll('.session-item').length")
  console.log('[smoke] session items after:', sessionsAfter)

  // --- Stop test: start a fresh session, send, then press stop quickly. ---
  await cdp.evaluate("document.querySelector('.new-session-button')?.click(); true")
  await sleep(400)
  const stopPrompt = '请生成一段较长的说明，用于测试停止按钮是否真的中断了流式输出。'
  await sendPrompt(cdp, stopPrompt)
  let stopClicked = false
  const stopDeadline = Date.now() + 10_000
  while (Date.now() < stopDeadline) {
    stopClicked = await cdp.evaluate(`(() => {
      const button = document.querySelector('.stop-button')
      if (!button) return false
      button.click()
      return true
    })()`)
    if (stopClicked) break
    await sleep(120)
  }
  console.log('[smoke] stop clicked:', stopClicked)
  await sleep(1800)
  const afterStop = await bodyText(cdp)
  console.log('[smoke] stopped status visible:', afterStop.includes('已停止') || afterStop.includes('停止'))
  console.log('[smoke] stop settled:', !(await cdp.evaluate("Boolean(document.querySelector('.stop-button'))")))

  // --- Restore test: open the first session in the sidebar. ---
  await cdp.evaluate("document.querySelector('.session-item')?.click(); true")
  await sleep(1200)
  const restored = await bodyText(cdp)
  console.log('[smoke] restored session has prompt:', restored.includes(stopPrompt.slice(0, 20)) || restored.includes(PROMPT.slice(0, 20)))
  const restoredMessages = await cdp.evaluate("document.querySelectorAll('.message').length")
  console.log('[smoke] restored message count:', restoredMessages)

  cdp.close()
  console.log('[smoke] DONE')
}

main().catch((error) => {
  console.error('[smoke] FAILED:', error.message)
  process.exitCode = 1
})
