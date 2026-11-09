#!/usr/bin/env node
/**
 * Verify stop + session restore against the running OpenFuture window.
 *
 * Starts a fresh session, sends a prompt that asks for a long answer, clicks
 * the stop button while streaming, then reopens the session and checks the
 * persisted messages.
 *
 * Usage: node tools/cdp-stop-test.mjs
 * Env: CDP_PORT (default 9222)
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const PROMPT = '请写一段不少于八百字的说明，介绍 OpenFuture 的 P0 桌面底座如何验证流式对话、停止与会话恢复。'

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

  const started = await evaluate(`(() => {
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
  if (started !== 'sent') throw new Error(`cannot send prompt: ${started}`)
  console.log('[stop-test] prompt sent')

  const stopDeadline = Date.now() + 20_000
  let stopState = null
  while (Date.now() < stopDeadline) {
    stopState = JSON.parse(
      await evaluate(`(() => {
        const stop = document.querySelector('.stop-button')
        const text = document.querySelector('.message.assistant')?.innerText || ''
        return JSON.stringify({ hasStop: Boolean(stop), textLength: text.length, status: document.querySelector('.status-text')?.innerText || '' })
      })()`)
    )
    if (stopState.hasStop && stopState.textLength > 20) break
    await sleep(150)
  }
  if (!stopState?.hasStop) throw new Error('stop button never appeared')
  console.log('[stop-test] streaming before stop:', JSON.stringify(stopState))

  const clicked = await evaluate(`(() => {
    const button = document.querySelector('.stop-button')
    if (!button) return false
    button.click()
    return true
  })()`)
  if (!clicked) throw new Error('stop button disappeared before click')

  await sleep(2500)
  const afterStop = JSON.parse(
    await evaluate(`(() => JSON.stringify({
      status: document.querySelector('.status-text')?.innerText || '',
      hasStop: Boolean(document.querySelector('.stop-button')),
      body: document.body.innerText.slice(-1200),
      messages: document.querySelectorAll('.message').length
    }))()`)
  )
  console.log('[stop-test] after stop:', JSON.stringify({ status: afterStop.status, hasStop: afterStop.hasStop, messages: afterStop.messages }))
  if (afterStop.hasStop) throw new Error('stop button still visible after abort')
  if (!/停止|已停止/.test(afterStop.body)) throw new Error('stopped status not visible')

  // Reopen the session from the sidebar and verify it persists the turn.
  const restored = await evaluate(`(() => {
    const item = document.querySelector('.session-item')
    if (!item) return 'no-session-item'
    item.click()
    return 'clicked'
  })()`)
  if (restored !== 'clicked') throw new Error(`cannot restore session: ${restored}`)
  await sleep(1500)
  const afterRestore = JSON.parse(
    await evaluate(`(() => JSON.stringify({
      messages: document.querySelectorAll('.message').length,
      user: document.querySelector('.message.user')?.innerText.slice(0, 80) || '',
      status: document.querySelector('.status-text')?.innerText || ''
    }))()`)
  )
  console.log('[stop-test] after restore:', JSON.stringify(afterRestore))
  if (afterRestore.messages < 2) throw new Error('restored session lost its messages')

  console.log('[stop-test] PASS')
  ws.close()
}

main().catch((error) => {
  console.error('[stop-test] FAILED:', error.message)
  process.exitCode = 1
})
