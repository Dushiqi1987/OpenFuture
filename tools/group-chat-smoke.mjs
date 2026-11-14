#!/usr/bin/env node
/**
 * Offline smoke test for the serial group-chat runtime.
 *
 * Boots the repository's mock OpenAI endpoint on a private port with
 * MOCK_GROUP_CHAT=1 (each role answers with a role-shaped message), then drives
 * the real `GroupChatRuntime` and checks:
 *
 *   - the happy path converges: work -> critique -> response -> critique -> chair,
 *     ending with 【共识】 and status "consensus";
 *   - a blocking critic keeps the chat at 4 messages and status "unresolved",
 *     ending with 【未收敛】;
 *   - every role session file is linked to the parent via `parentSession`.
 *
 * Run with Node 22+ (native TypeScript stripping):
 *   node tools/group-chat-smoke.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { GroupChatRuntime } from '../src/agent-host/group-chat.ts'

const ROOT = resolve(import.meta.dirname, '..')
const WORK = join(ROOT, '.scratch', 'group-chat-smoke')
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

function check(label, condition, detail = '') {
  if (condition) {
    log(`  ok  ${label}`)
    return
  }
  fail(`${label}${detail ? ` — ${detail}` : ''}`)
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

/** All role session files written by one run, newest first. */
function sessionFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => join(dir, name))
  } catch {
    return []
  }
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
      MOCK_DELAY_MS: '20',
      MOCK_GROUP_CHAT: '1'
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
  const groupDir = join(sessionDir, 'group')
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false
  })
  modelRuntime.setRuntimeApiKey('mock', 'smoke-test-key')
  const model = modelRuntime.getModel('mock', 'mock-model')
  if (!model) {
    fail('mock model is missing from ModelRuntime')
    return
  }
  const settingsManager = pi.SettingsManager.create(workspace, agentDir)
  const parentManager = pi.SessionManager.create(workspace, sessionDir)
  const parentSessionFile = parentManager.getSessionFile()

  const events = []
  const runtime = new GroupChatRuntime({
    pi,
    modelRuntime,
    model,
    cwd: workspace,
    agentDir,
    sessionDir: groupDir,
    parentSessionFile,
    customTools: [],
    leadTools: [],
    criticTools: [],
    settingsManager,
    maxMessageChars: 4_000,
    turnTimeoutMs: 90_000,
    onEvent: (event) => events.push({ ...event, at: Date.now() })
  })

  log('\n[consensus path]')
  const happy = await runtime.run({ goal: '为 OpenFuture 增加串行群聊能力', rounds: 2 })
  log(`status=${happy.status} rounds=${happy.rounds} messages=${happy.messages.length} in ${happy.durationMs}ms`)
  for (const message of happy.messages) {
    log(`  #${message.seq} ${message.roleId}/${message.stage} tools=${message.tools.length} chars=${message.text.length}`)
  }
  check('status is consensus', happy.status === 'consensus', happy.status)
  check(
    'stage order work -> critique -> response -> critique -> chair',
    happy.messages.map((message) => message.stage).join(',') === 'work,critique,response,critique,chair',
    happy.messages.map((message) => message.stage).join(',')
  )
  check('every message has text', happy.messages.every((message) => message.text.trim().length > 0))
  check('chair starts with 【共识】', happy.summary.startsWith('【共识】'), happy.summary.slice(0, 20))
  check('lead speaks twice and critic twice', happy.messages.filter((m) => m.roleId === 'lead').length === 2)
  check('start/message/end events emitted', events.some((e) => e.type === 'start') && events.some((e) => e.type === 'end'))

  log('\n[unresolved path]')
  const blocked = await runtime.run({ goal: 'TEST_UNRESOLVED 验证未收敛路径', rounds: 1 })
  log(`status=${blocked.status} rounds=${blocked.rounds} messages=${blocked.messages.length} in ${blocked.durationMs}ms`)
  check('status is unresolved', blocked.status === 'unresolved', blocked.status)
  check('stops after the single round (work, critique, chair)', blocked.messages.length === 3, String(blocked.messages.length))
  check('chair starts with 【未收敛】', blocked.summary.startsWith('【未收敛】'), blocked.summary.slice(0, 20))

  log('\n[session linkage]')
  const files = sessionFiles(groupDir)
  log(`  role session files: ${files.length}`)
  check('two runs created six role sessions', files.length === 6, String(files.length))
  let linked = 0
  for (const file of files) {
    const header = JSON.parse(readFileSync(file, 'utf8').split('\n')[0] || '{}')
    if (header.parentSession === parentSessionFile) linked += 1
  }
  check('all role sessions carry parentSession', linked === files.length, `${linked}/${files.length}`)

  const total = happy.durationMs + blocked.durationMs
  log(`\ntotal group chat time: ${total}ms`)
  await runtime.dispose()
  log(process.exitCode ? 'SMOKE TEST FAILED' : 'SMOKE TEST PASSED')
}

main()
  .catch((error) => {
    fail(error instanceof Error ? error.stack ?? error.message : String(error))
  })
  .finally(() => {
    // Pi keeps a few long-lived handles (model runtime pool, session watchers);
    // report the result and leave without waiting for the event loop to drain.
    shutdownMock()
    process.exit(process.exitCode ?? 0)
  })
