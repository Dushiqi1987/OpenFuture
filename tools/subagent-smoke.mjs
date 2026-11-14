#!/usr/bin/env node
/**
 * Offline smoke test for the in-process subagent runtime.
 *
 * Boots the repository's mock OpenAI endpoint on a private port, builds a
 * temporary agent directory with a static models.json, then runs three child
 * sessions through the real `SubagentRuntime` and checks:
 *
 *   - every child settles with the marker it was given;
 *   - children run concurrently (wall time far below serial time);
 *   - each child session file is linked to the parent via `parentSession`;
 *   - progress updates cover queued -> running -> done.
 *
 * Run with Node 22+ (native TypeScript stripping):
 *   node tools/subagent-smoke.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { SubagentRuntime } from '../src/agent-host/subagent-runtime.ts'

const ROOT = resolve(import.meta.dirname, '..')
const WORK = join(ROOT, '.scratch', 'subagent-smoke')
let PORT = 0
let BASE_URL = ''
let shutdownMock = () => {}

/** Ask the OS for a free loopback port; local proxies love the round numbers. */
async function pickPort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolvePort(port) : reject(new Error('no free port'))))
    })
  })
}

function log(line) {
  process.stdout.write(`${line}\n`)
}

function fail(message) {
  log(`FAIL: ${message}`)
  process.exitCode = 1
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return true
    } catch {
      // Not up yet.
    }
    await new Promise((done) => setTimeout(done, 120))
  }
  return false
}

function modelsJson() {
  return JSON.stringify(
    {
      providers: {
        mock: {
          baseUrl: BASE_URL,
          api: 'openai-completions',
          apiKey: 'smoke-test-key',
          models: [
            {
              id: 'mock-model',
              name: 'Mock Model',
              reasoning: false,
              input: ['text'],
              contextWindow: 32_000,
              maxTokens: 4_096,
              compat: { supportsDeveloperRole: false }
            }
          ]
        }
      }
    },
    null,
    2
  )
}

async function main() {
  PORT = await pickPort()
  BASE_URL = `http://127.0.0.1:${PORT}/v1`
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(join(WORK, 'workspace'), { recursive: true })
  mkdirSync(join(WORK, 'agent'), { recursive: true })
  writeFileSync(join(WORK, 'agent', 'models.json'), modelsJson(), 'utf8')
  writeFileSync(join(WORK, 'agent', 'auth.json'), '{}', 'utf8')

  const mock = spawn(process.execPath, [join(ROOT, 'tools', 'mock-model', 'server.mjs')], {
    env: {
      ...process.env,
      MOCK_MODEL_PORT: String(PORT),
      MOCK_MODEL_ID: 'mock-model',
      MOCK_DELAY_MS: '40'
    },
    stdio: 'ignore'
  })
  shutdownMock = () => {
    if (!mock.killed) mock.kill()
  }
  process.on('exit', shutdownMock)

  if (!(await waitForHealth(15_000))) {
    fail('mock model did not become healthy')
    return
  }
  log(`mock model ready on ${BASE_URL}`)

  const pi = await import('@earendil-works/pi-coding-agent')
  const agentDir = join(WORK, 'agent')
  const workspace = join(WORK, 'workspace')
  const sessionDir = join(WORK, 'sessions')
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false
  })
  await modelRuntime.setRuntimeApiKey('mock', 'smoke-test-key')

  const model = modelRuntime.getModel('mock', 'mock-model')
  if (!model) {
    fail('static model mock/mock-model missing')
    return
  }

  const settingsManager = pi.SettingsManager.create(workspace, agentDir)
  const parentManager = pi.SessionManager.create(workspace, sessionDir)
  const parentSessionFile = parentManager.getSessionFile()
  log(`parent session: ${parentSessionFile ?? '(unsaved)'}`)

  const updates = []
  const runtime = new SubagentRuntime({
    pi,
    modelRuntime,
    model,
    cwd: workspace,
    agentDir,
    sessionDir: join(sessionDir, 'subagents'),
    parentSessionFile,
    customTools: [],
    tools: [],
    settingsManager,
    extensionFactories: [],
    maxConcurrency: 3,
    timeoutMs: 90_000,
    onUpdate: (update) => updates.push(update)
  })

  const markers = ['ALPHA', 'BETA', 'GAMMA']
  const tasks = markers.map((marker) => ({
    title: `smoke-${marker}`,
    prompt: `冒烟任务 ${marker}：请原样复述这个标记 ${marker}，不要添加其他内容。`
  }))

  const startedAt = Date.now()
  const results = await runtime.run(tasks)
  const wallMs = Date.now() - startedAt

  log(`\nwall=${wallMs}ms results=${results.length}`)
  for (const result of results) {
    log(
      `  [${result.outcome}] ${result.title} ${result.durationMs}ms chars=${result.text.length} file=${result.sessionFile ?? '-'}`
    )
  }

  if (results.length !== tasks.length) fail(`expected ${tasks.length} results, got ${results.length}`)
  results.forEach((result, index) => {
    const marker = markers[index]
    if (result.outcome !== 'done') fail(`${result.title} outcome=${result.outcome} ${result.error ?? ''}`)
    if (!result.text.includes(marker)) fail(`${result.title} did not echo ${marker}: ${result.text.slice(0, 120)}`)
    if (!result.sessionFile) fail(`${result.title} has no session file`)
  })

  const serialMs = results.reduce((sum, result) => sum + result.durationMs, 0)
  if (wallMs > serialMs * 0.8) {
    fail(`children did not run concurrently: wall=${wallMs}ms serial=${serialMs}ms`)
  } else {
    log(`concurrency ok: ${wallMs}ms < ${Math.round(serialMs * 0.8)}ms (serial ${serialMs}ms)`)
  }

  const statuses = new Set(updates.map((update) => update.status))
  for (const status of ['queued', 'running', 'done']) {
    if (!statuses.has(status)) fail(`missing '${status}' progress update`)
  }
  log(`progress updates: ${updates.length} (${[...statuses].join(', ')})`)

  const childDir = join(sessionDir, 'subagents')
  const childFiles = readdirSync(childDir).filter((name) => name.endsWith('.jsonl'))
  if (childFiles.length !== tasks.length) fail(`expected ${tasks.length} child session files, got ${childFiles.length}`)
  let linked = 0
  for (const name of childFiles) {
    const header = JSON.parse(readFileSync(join(childDir, name), 'utf8').split('\n')[0])
    if (header.parentSession) linked += 1
  }
  if (linked !== childFiles.length) fail(`only ${linked}/${childFiles.length} child sessions link parentSession`)
  else log(`parentSession linkage ok: ${linked}/${childFiles.length}`)

  runtime.dispose()
  log(process.exitCode ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST PASSED')
}

main()
  .catch((error) => {
    fail(error instanceof Error ? (error.stack ?? error.message) : String(error))
  })
  .finally(() => {
    // Pi keeps a few long-lived handles (model runtime pool, session watchers);
    // report the result and leave without waiting for the event loop to drain.
    shutdownMock()
    process.exit(process.exitCode ?? 0)
  })
