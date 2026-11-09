#!/usr/bin/env node
/**
 * Capture the running OpenFuture window to docs/screenshot-main.png.
 *
 * Usage: node tools/cdp-screenshot.mjs
 * Env: CDP_PORT (default 9222), SHOT_PATH (default docs/screenshot-main.png)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const SHOT_PATH = process.env.SHOT_PATH || 'docs/screenshot-main.png'

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

  await send('Page.enable')
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  mkdirSync(dirname(SHOT_PATH), { recursive: true })
  writeFileSync(SHOT_PATH, Buffer.from(shot.data, 'base64'))
  console.log('[screenshot] wrote', SHOT_PATH)
  ws.close()
}

main().catch((error) => {
  console.error('[screenshot] FAILED:', error.message)
  process.exitCode = 1
})
