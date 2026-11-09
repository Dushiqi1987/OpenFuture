#!/usr/bin/env node
/**
 * Send one prompt to the running OpenFuture window and print the reply.
 *
 * Usage: node tools/cdp-chat.mjs "prompt"
 * Env: CDP_PORT (default 9222), CHAT_TIMEOUT_MS (default 180000)
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const PROMPT = process.argv.slice(2).join(' ') || '请用一句话介绍你自己。'
const TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS || 180_000)

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

async function main() {
  const page = await findPage()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })

  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  })

  const send = (method, params = {}) => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed')
    return result.result.value
  }

  await send('Runtime.enable')

  const before = await evaluate("document.querySelectorAll('.message.assistant').length")
  const sent = await evaluate(`(() => {
    const textarea = document.querySelector('textarea')
    if (!textarea) return 'no-textarea'
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(textarea, ${JSON.stringify(PROMPT)})
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    const button = document.querySelector('.send-button')
    if (!button) return 'no-button'
    button.click()
    return 'sent'
  })()`)
  if (sent !== 'sent') throw new Error(`cannot send prompt: ${sent}`)
  console.log('[chat] prompt sent:', PROMPT)

  const deadline = Date.now() + TIMEOUT_MS
  let lastText = ''
  while (Date.now() < deadline) {
    const snapshot = await evaluate(`(() => {
      const messages = Array.from(document.querySelectorAll('.message')).map((node) => ({
        role: node.classList.contains('assistant') ? 'assistant' : 'user',
        text: node.innerText
      }))
      const assistants = messages.filter((message) => message.role === 'assistant')
      const streaming = Boolean(document.querySelector('.stop-button')) || Boolean(document.querySelector('.typing-dots'))
      const banner = Array.from(document.querySelectorAll('.banner-error, .error-banner, .error'))
        .map((node) => node.innerText)
        .join('\\n')
      const status = document.querySelector('.status-text')?.innerText || ''
      return JSON.stringify({
        count: messages.length,
        assistants: assistants.length,
        streaming,
        banner,
        status,
        last: messages[messages.length - 1]?.text || '',
        lastAssistant: assistants[assistants.length - 1]?.text || ''
      })
    })()`)
    const state = JSON.parse(snapshot)
    lastText = state.lastAssistant || state.last
    if (state.banner) {
      console.error('[chat] UI error banner:', state.banner)
    }
    if (state.count > before && state.assistants > before && !state.streaming && state.lastAssistant.trim()) {
      console.log('[chat] messages:', state.count, '| status:', state.status)
      console.log('[chat] reply:\n' + state.lastAssistant)
      ws.close()
      return
    }
    await sleep(500)
  }

  console.error('[chat] timed out. Last assistant message:\n' + lastText)
  const body = await evaluate('document.body.innerText')
  console.error('[chat] page tail:\n' + body.slice(-1500))
  process.exitCode = 1
  ws.close()
}

main().catch((error) => {
  console.error('[chat] FAILED:', error.message)
  process.exitCode = 1
})
