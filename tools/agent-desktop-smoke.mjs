#!/usr/bin/env node
// Offline-ish smoke test for the Agent Desktop bridge: install the pinned
// release, run `status`, take an accessibility snapshot and list the exposed
// computer_desktop_* tools. Run with the Node 24 runtime because the bridge is
// written in TypeScript and relies on native type stripping.
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORK = join(ROOT, '.scratch', 'agent-desktop-smoke')
const USER_DATA = join(WORK, 'userdata')

const { AgentDesktopBridge } = await import('../src/main/agent-desktop.ts')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })

  const bridge = new AgentDesktopBridge(USER_DATA)
  console.log(`installed before -> ${bridge.installed()}`)

  const progress = []
  const installed = await bridge.install((message) => {
    progress.push(message)
    console.log(`install -> ${message}`)
  })
  console.log(`installed -> ${JSON.stringify(installed)}`)
  assert(bridge.installed(), 'bridge reports not installed after install()')
  assert(installed.version === '1.3.1', `unexpected version ${installed.version}`)
  assert(progress.length > 0, 'install() did not report progress')

  const status = await bridge.status()
  console.log(`status -> ${JSON.stringify(status).slice(0, 400)}`)
  assert(status && typeof status === 'object', 'status returned no object')
  assert(status.platform === 'windows', `unexpected platform ${status.platform}`)

  const apps = await bridge.call('computer_desktop_apps', {})
  const appsText = apps.content.map((item) => item.text).join('\n')
  console.log(`apps -> ${appsText.slice(0, 200).replace(/\n/g, ' | ')}`)

  let appName = ''
  try {
    const parsedApps = JSON.parse(appsText)
    const first = Array.isArray(parsedApps.apps) ? parsedApps.apps[0] : null
    appName = typeof first?.name === 'string' ? first.name : ''
  } catch {
    // keep appName empty; the snapshot below will report WINDOW_NOT_FOUND
  }
  console.log(`snapshot target -> ${appName || 'focused'}`)
  const snapshot = await bridge.call('computer_desktop_snapshot', {
    ...(appName ? { app: appName } : {}),
    interactive: true,
    maxDepth: 6
  })
  const snapshotText = snapshot.content.map((item) => item.text).join('\n')
  let parsed = null
  try {
    parsed = JSON.parse(snapshotText)
  } catch {
    // The CLI may prepend a human readable line; keep the raw text for the log.
  }
  const refs = Array.isArray(parsed?.refs) ? parsed.refs : []
  console.log(`snapshot -> ${snapshotText.trim().slice(0, 220).replace(/\n/g, ' | ')}`)
  if (refs.length > 0) {
    assert(
      refs.every((ref) => typeof ref.ref === 'string' && ref.ref.startsWith('@')),
      'snapshot refs are not @ prefixed'
    )
  } else {
    console.log('snapshot -> no refs (foreground window may be a console); structure still returned')
  }

  const tools = bridge.listTools()
  console.log(`tools -> ${tools.length} ${tools.map((tool) => tool.name).join(',')}`)
  assert(tools.length === 12, `expected 12 tools, got ${tools.length}`)
  assert(
    tools.some((tool) => tool.name === 'computer_desktop_snapshot') &&
      tools.some((tool) => tool.name === 'computer_desktop_click'),
    'expected snapshot/click tools'
  )

  console.log('AGENT DESKTOP SMOKE PASSED')
}

main().catch((error) => {
  console.error(`AGENT DESKTOP SMOKE FAILED: ${error && error.message ? error.message : error}`)
  process.exitCode = 1
})
