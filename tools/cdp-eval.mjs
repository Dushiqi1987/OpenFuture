#!/usr/bin/env node
/** Evaluate one expression in the running renderer (local debugging helper). */
const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const expression = process.argv.slice(2).join(' ')

async function sleep(ms) {
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
      // retry
    }
    await sleep(300)
  }
  throw new Error('CDP page target not found')
}

async function main() {
  if (!expression) throw new Error('expression required')
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

  await send('Runtime.enable')
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    console.error(JSON.stringify(result.exceptionDetails, null, 2))
    process.exitCode = 1
  } else {
    console.log(JSON.stringify(result.result?.value ?? result.result, null, 2))
  }
  ws.close()
}

main().catch((error) => {
  console.error('[eval] FAILED:', error.message)
  process.exitCode = 1
})
