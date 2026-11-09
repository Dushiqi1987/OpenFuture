#!/usr/bin/env node
/**
 * Standalone M2 desktop contract bridge.
 *
 * Usage:
 *   node scripts/desktop-bridge.ts [--root PATH] [--port 19744] [--token TOKEN]
 *
 * The bridge only reads an existing project's .runtime/runs snapshots. It never
 * starts agents, merges branches or touches the main worktree.
 */

import path from 'node:path'

import { defaultProjectPolicy } from '../src/core/plan.ts'
import { startDesktopBridge } from '../src/desktop/server.ts'

function usage(): string {
  return [
    'Usage: node scripts/desktop-bridge.ts [options]',
    '',
    'Options:',
    '  --root PATH     project root containing .runtime/runs (default: cwd)',
    '  --project-id ID project identity stored in run snapshots',
    '  --port PORT     listen port (default: 19744)',
    '  --host HOST     bind host (default: 127.0.0.1; non-loopback needs --token)',
    '  --token TOKEN   require Authorization: Bearer TOKEN for data endpoints',
    '  --help          show this text'
  ].join('\n')
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage())
    return
  }
  const root = path.resolve(readOption(args, '--root') ?? process.env.DESKTOP_BRIDGE_ROOT ?? process.cwd())
  const portText = readOption(args, '--port') ?? process.env.DESKTOP_BRIDGE_PORT ?? '19744'
  const port = Number(portText)
  const host = readOption(args, '--host') ?? process.env.DESKTOP_BRIDGE_HOST ?? '127.0.0.1'
  const token = readOption(args, '--token') ?? process.env.DESKTOP_BRIDGE_TOKEN
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port ${JSON.stringify(portText)}`)
  }
  const projectId = readOption(args, '--project-id') ?? process.env.DESKTOP_BRIDGE_PROJECT_ID
  const project = defaultProjectPolicy({ rootPath: root, ...(projectId ? { projectId } : {}) })
  const bridge = await startDesktopBridge({ project, host, port, token })
  console.log(`OpenFuture desktop contract bridge ${bridge.contractVersion}`)
  console.log(`  project: ${bridge.projectId}`)
  console.log(`  root:    ${root}`)
  console.log(`  url:     ${bridge.url}`)
  console.log(`  contract ${bridge.url}/v1/contract`)
  console.log(`  auth:    ${token ? 'bearer token required for data endpoints' : 'local, no token'}`)
  console.log('Press Ctrl+C to stop.')

  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    await bridge.close()
    process.exit(0)
  }
  process.on('SIGINT', () => {
    void stop()
  })
  process.on('SIGTERM', () => {
    void stop()
  })
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
