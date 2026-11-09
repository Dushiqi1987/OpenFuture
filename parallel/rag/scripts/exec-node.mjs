#!/usr/bin/env node
/**
 * Run a Node >= 22.6 command with TypeScript type stripping and node:sqlite.
 *
 * Prefer the explicitly configured RAG_NODE and fall back to the current
 * executable. Check the actual version before running the requested command.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const MIN_MAJOR = 22
const MIN_MINOR = 6

const candidates = [
  process.env.RAG_NODE,
  process.execPath
].filter((value) => typeof value === 'string' && value.length > 0)

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('usage: node scripts/exec-node.mjs <node arguments...>')
  process.exit(2)
}

function versionArgs(major) {
  if (major >= 23) return args
  if (major === 22) return ['--experimental-strip-types', '--experimental-sqlite', ...args]
  return []
}

for (const bin of candidates) {
  if (!existsSync(bin)) continue
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  let probe
  try {
    probe = spawnSync(bin, ['-p', 'process.versions.node'], { env, encoding: 'utf8', timeout: 30_000 })
  } catch {
    continue
  }
  if (probe.status !== 0) continue
  const version = String(probe.stdout).trim()
  const [majorRaw, minorRaw] = version.split('.')
  const major = Number.parseInt(majorRaw ?? '', 10)
  const minor = Number.parseInt(minorRaw ?? '', 10)
  if (!Number.isInteger(major) || major < MIN_MAJOR) continue
  if (major === MIN_MAJOR && (!Number.isInteger(minor) || minor < MIN_MINOR)) continue

  const result = spawnSync(bin, versionArgs(major), { env, stdio: 'inherit' })
  if (result.error) {
    console.error(`rag: failed to run ${bin}: ${result.error.message}`)
    process.exit(2)
  }
  process.exit(result.status ?? 1)
}

console.error(
  `rag: no Node >= ${MIN_MAJOR}.${MIN_MINOR} runtime found. ` +
    'Run with a supported Node version, or set RAG_NODE to its executable.'
)
process.exit(2)
