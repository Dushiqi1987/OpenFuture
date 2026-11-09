#!/usr/bin/env node
/**
 * Configure the model through the running renderer's preload API.
 *
 * Usage:
 *   BAILIAN_API_KEY=sk-... node tools/configure-model.mjs
 *
 * The API key is sent over the local DevTools protocol, encrypted by the main
 * process via safeStorage and never written to disk in plaintext.
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const API_KEY = process.env.BAILIAN_API_KEY || process.env.OPENFUTURE_MODEL_API_KEY
const BASE_URL = process.env.MODEL_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const MODEL_ID = process.env.MODEL_ID || 'qwen3.7-flash'
const DISPLAY_NAME = process.env.MODEL_DISPLAY_NAME || 'Qwen3.7 Flash'
const CONTEXT_WINDOW = Number(process.env.MODEL_CONTEXT_WINDOW || 131072)
// qwen3.7-flash defaults thinking_budget to 32768, and DashScope requires
// max_completion_tokens to be greater than that. 65536 also leaves room for
// the visible answer after the thinking block.
const MAX_TOKENS = Number(process.env.MODEL_MAX_TOKENS || 65536)

if (!API_KEY) {
  console.error('BAILIAN_API_KEY is required')
  process.exit(1)
}

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

  const input = {
    baseUrl: BASE_URL,
    modelId: MODEL_ID,
    displayName: DISPLAY_NAME,
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_TOKENS,
    reasoning: true,
    apiKey: API_KEY
  }

  const raw = await evaluate(
    `window.openfuture.saveModel(${JSON.stringify(input)}).then((result) => JSON.stringify(result))`
  )
  const response = JSON.parse(raw)
  if (!response.ok) {
    console.error('[configure] saveModel failed:', response.error)
    process.exitCode = 1
    ws.close()
    return
  }

  console.log('[configure] saved:', JSON.stringify(response.value))
  // SaveModel restarts the agent host; reload so the renderer picks up the new
  // workspace/model snapshot and discards the stale session id.
  await evaluate('location.reload(); true')
  await sleep(1200)
  ws.close()
}

main().catch((error) => {
  console.error('[configure] FAILED:', error.message)
  process.exitCode = 1
})
