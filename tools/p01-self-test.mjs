#!/usr/bin/env node
/**
 * P0.1 end-to-end self test.
 *
 * Starts three in-process mock OpenAI endpoints, drives the already-running
 * isolated app through CDP, and verifies A1/A2/B plus the FTS5 self check.
 * No real credentials or user data are touched.
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const ROOT = resolve(import.meta.dirname, '..')
const USER_DATA = process.env.OPENFUTURE_USER_DATA
  ? resolve(process.env.OPENFUTURE_USER_DATA)
  : join(ROOT, '.scratch', 'p01-userdata')
const WORKSPACE = join(ROOT, '.scratch', 'p01-workspace')
const OUTSIDE = join(ROOT, '.scratch', 'p01-outside')
const LOG_DIR = join(ROOT, '.scratch', 'p01-logs')
const CDP_PORT = Number(process.env.CDP_PORT || 9227)
const results = []
let failures = 0

function record(name, pass, detail) {
  results.push({ name, pass, detail })
  if (!pass) failures += 1
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

function expectThrows(fn, matcher, name) {
  try {
    fn()
    record(name, false, 'did not throw')
  } catch (error) {
    record(name, matcher.test(String(error?.message || error)), String(error?.message || error))
  }
}

// ---------------------------------------------------------------------------
// mock endpoints
// ---------------------------------------------------------------------------
const requests = []

function sseChunk(delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'p01-mock',
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })}\n\n`
}

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') {
      if (typeof message.content === 'string') return message.content
      if (Array.isArray(message.content)) {
        return message.content
          .filter((part) => part?.type === 'text')
          .map((part) => part.text)
          .join('\n')
      }
    }
  }
  return ''
}

function parseDirective(text) {
  const trimmed = text.trim()
  const match = /^(read|ls|grep|find):([\s\S]+)$/.exec(trimmed)
  if (!match) return null
  const [, tool, rest] = match
  if (tool === 'read' || tool === 'ls') return { name: tool, args: { path: rest.trim() } }
  const [pattern, pathPart] = rest.split('|')
  return { name: tool, args: { pattern: pattern.trim(), path: (pathPart || '.').trim() } }
}

function startMock(port, options = {}) {
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, port }))
      return
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'p01-mock', object: 'model' }] }))
      return
    }
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
      response.writeHead(404).end()
      return
    }

    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      response.writeHead(400).end()
      return
    }

    const messages = Array.isArray(body.messages) ? body.messages : []
    const toolMessages = messages.filter((message) => message?.role === 'tool')
    const lastMessage = messages.at(-1)
    const toolResultTurn = lastMessage?.role === 'tool'
    const toolText = toolMessages.map((message) => String(message.content ?? '')).join('\n')
    const lastToolText = lastMessage?.role === 'tool' ? String(lastMessage.content ?? '') : ''
    const leaked = toolText.includes('P01_SECRET_SENTINEL')
    const entry = {
      port,
      at: new Date().toISOString(),
      lastUser: lastUserText(messages).slice(0, 160),
      toolMessages: toolMessages.length,
      leaked,
      toolText: toolText.slice(0, 1600),
      lastToolText: lastToolText.slice(0, 1600),
      hasAuthorization: Boolean(request.headers.authorization)
    }
    requests.push(entry)

    if (options.failStatus) {
      const payload = JSON.stringify({
        error: {
          message: 'P0.1 injected authentication failure',
          type: 'invalid_request_error',
          code: 'invalid_api_key'
        }
      })
      response.writeHead(options.failStatus, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      })
      response.end(payload)
      return
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const write = (chunk) => response.write(chunk)

    if (toolResultTurn) {
      write(sseChunk({ role: 'assistant', content: leaked ? 'DONE:LEAK' : 'DONE:CLEAN' }))
      write(sseChunk({ role: 'assistant', content: '' }, 'stop'))
      write('data: [DONE]\n\n')
      response.end()
      return
    }

    const last = lastUserText(messages)
    if (last.trim().startsWith('long:')) {
      const timer = setInterval(() => {
        try {
          write(sseChunk({ role: 'assistant', content: `长文本片段-${randomUUID().slice(0, 6)}；` }))
        } catch {
          clearInterval(timer)
        }
      }, 60)
      request.on('close', () => clearInterval(timer))
      setTimeout(() => {
        clearInterval(timer)
        try {
          write(sseChunk({ role: 'assistant', content: '' }, 'stop'))
          write('data: [DONE]\n\n')
          response.end()
        } catch {
          // aborted by the UI
        }
      }, 12000)
      return
    }

    const directive = parseDirective(last)
    if (directive) {
      write(sseChunk({ role: 'assistant', content: '' }))
      write(
        sseChunk({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_${randomUUID()}`,
              type: 'function',
              function: { name: directive.name, arguments: JSON.stringify(directive.args) }
            }
          ]
        })
      )
      write(sseChunk({ role: 'assistant', content: '' }, 'tool_calls'))
      write('data: [DONE]\n\n')
      response.end()
      return
    }

    if (options.reasoning) {
      for (const piece of ['先确认环境，', '再给出简短结论。']) {
        write(sseChunk({ role: 'assistant', reasoning_content: piece }))
      }
    }
    const text = last.trim().startsWith('reason:')
      ? '推理测试完成：P0.1 mock response。'
      : 'P0.1 mock response：收到，测试通过。'
    for (const part of text.match(/.{1,6}/gu) || [text]) {
      write(sseChunk({ role: 'assistant', content: part }))
    }
    write(sseChunk({ role: 'assistant', content: '' }, 'stop'))
    write('data: [DONE]\n\n')
    response.end()
  })
  return new Promise((resolvePromise) => server.listen(port, '127.0.0.1', () => resolvePromise(server)))
}

// ---------------------------------------------------------------------------
// CDP
// ---------------------------------------------------------------------------
async function openPageTarget() {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((response) => response.json())
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // retry
    }
    await sleep(300)
  }
  throw new Error('CDP page not found')
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id || !this.pending.has(message.id)) return
      const { resolve: done, reject } = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else done(message.result)
    })
  }

  static async connect() {
    const page = await openPageTarget()
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolvePromise, reject) => {
      ws.addEventListener('open', resolvePromise, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    const cdp = new Cdp(ws)
    await cdp.send('Runtime.enable')
    return cdp
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluate failed')
    }
    return result.result?.value
  }

  async waitFor(expression, timeout = 25_000, interval = 200) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(`Boolean(${expression})`)) return true
      } catch {
        // execution context is being replaced during reload
      }
      await sleep(interval)
    }
    return false
  }

  async reload() {
    await this.evaluate('location.reload(); true')
    await sleep(500)
    const ready = await this.waitFor(
      `window.openfuture && document.querySelector('textarea') && !document.querySelector('.fatal-screen')`,
      25_000
    )
    if (!ready) throw new Error('page did not become ready after reload')
    await sleep(400)
  }

  async state() {
    return this.evaluate(`(() => {
      const text = (selector) => Array.from(document.querySelectorAll(selector)).map((node) => node.textContent || '');
      const assistant = Array.from(document.querySelectorAll('.message.assistant')).map((node) => ({
        text: (node.querySelector('.message-text')?.textContent || '').trim(),
        thinking: (node.querySelector('.thinking-block pre')?.textContent || '').trim(),
        tools: Array.from(node.querySelectorAll('.tool-chip')).map((chip) => chip.textContent || '')
      }));
      const ta = document.querySelector('textarea');
      return {
        status: document.querySelector('.status-text')?.textContent || '',
        error: text('.error-banner'),
        notice: text('.notice-banner'),
        assistant,
        users: Array.from(document.querySelectorAll('.message.user')).map((node) => (node.querySelector('.message-text')?.textContent || '').trim()),
        stopVisible: Boolean(document.querySelector('.stop-button')),
        sendVisible: Boolean(document.querySelector('.send-button')),
        textareaLength: ta ? ta.value.length : -1,
        sessionItems: document.querySelectorAll('.session-item').length,
        thinkingBlocks: document.querySelectorAll('.thinking-block').length
      };
    })()`)
  }

  async typeAndSend(text) {
    const ok = await this.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    if (!ok) throw new Error('textarea missing')
    await sleep(250)
    await this.evaluate(`document.querySelector('.send-button')?.click(); true`)
  }

  async waitIdle(timeout = 40_000) {
    return this.waitFor(
      `document.querySelector('.status-text')?.textContent === '就绪' && !document.querySelector('.stop-button')`,
      timeout
    )
  }

  async waitTurn(timeout = 40_000) {
    // The first render may finish before we observe the busy state; always
    // wait for idle afterwards so callers never read a half-finished turn.
    await this.waitFor(
      `document.querySelector('.stop-button') || document.querySelector('.status-text')?.textContent === '生成中'`,
      6_000
    )
    return this.waitIdle(timeout)
  }
}

async function saveModel(cdp, input) {
  const result = await cdp.evaluate(
    `window.openfuture.saveModel(${JSON.stringify(input)}).then((r) => JSON.stringify(r))`
  )
  return typeof result === 'string' ? JSON.parse(result) : result
}

async function getSettings(cdp) {
  const result = await cdp.evaluate('window.openfuture.getSettings().then((r) => JSON.stringify(r))')
  return typeof result === 'string' ? JSON.parse(result) : result
}

async function memoryDiagnostics(cdp) {
  const result = await cdp.evaluate('window.openfuture.memoryDiagnostics().then((r) => JSON.stringify(r))')
  return typeof result === 'string' ? JSON.parse(result) : result
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  mkdirSync(LOG_DIR, { recursive: true })

  const linkPath = join(WORKSPACE, 'link-outside')
  if (!existsSync(linkPath)) {
    try {
      symlinkSync(OUTSIDE, linkPath, 'junction')
    } catch (error) {
      console.log(`[setup] junction skipped: ${error.message}`)
    }
  }

  const servers = [
    await startMock(8791, {}),
    await startMock(8792, { failStatus: 401 }),
    await startMock(8793, { reasoning: true })
  ]

  const cdp = await Cdp.connect()
  await cdp.waitFor(`window.openfuture && document.querySelector('textarea')`, 20_000)

  const model = {
    baseUrl: 'http://127.0.0.1:8791/v1',
    modelId: 'p01-mock',
    displayName: 'P01 Mock',
    contextWindow: 96000,
    maxTokens: 8192,
    reasoning: false
  }

  // A2: first binding with a fake key.
  let saved = await saveModel(cdp, { ...model, apiKey: 'sk-fake-p01-A' })
  record('A2 initial key binding', saved.ok === true && saved.value?.credentialState === 'bound', JSON.stringify(saved).slice(0, 200))
  await cdp.reload()

  // A1: read allowed file.
  await cdp.typeAndSend(`read:${join(WORKSPACE, 'safe.txt')}`)
  await cdp.waitTurn()
  let state = await cdp.state()
  let lastAssistant = state.assistant.at(-1)
  record('A1 read allowed file', Boolean(lastAssistant?.text.includes('DONE:CLEAN')), lastAssistant?.text?.slice(0, 120))
  record('A1 read tool chip', state.assistant.some((message) => message.tools.includes('read')), JSON.stringify(state.assistant.map((message) => message.tools)))

  // A1: denied sensitive/outside/device/ADS paths.
  const deniedCases = [
    ['sensitive .env', `.env`],
    ['sensitive private key', `private.pem`],
    ['outside workspace', join(OUTSIDE, 'secret.txt')],
    ['device path', `\\\\?\\${join(WORKSPACE, 'safe.txt')}`],
    ['alternate data stream', `${join(WORKSPACE, 'safe.txt')}:p01`]
  ]
  for (const [label, target] of deniedCases) {
    const before = requests.length
    await cdp.typeAndSend(`read:${target}`)
    await cdp.waitTurn()
    state = await cdp.state()
    const newRequests = requests.slice(before)
    const toolOutput = newRequests.map((entry) => entry.toolText).join('\n')
    record(`A1 deny ${label}`, !toolOutput.includes('P01_SECRET_SENTINEL') && toolOutput.includes('安全策略'), toolOutput.slice(0, 160))
  }

  // A1: junction pointing outside.
  if (existsSync(linkPath)) {
    const before = requests.length
    await cdp.typeAndSend(`read:${join(linkPath, 'secret.txt')}`)
    await cdp.waitTurn()
    const toolOutput = requests.slice(before).map((entry) => entry.toolText).join('\n')
    record('A1 deny junction escape', !toolOutput.includes('P01_SECRET_SENTINEL') && toolOutput.includes('安全策略'), toolOutput.slice(0, 160))
  } else {
    record('A1 deny junction escape', true, 'skipped: junction could not be created')
  }

  // A1: ls must filter protected names.
  const lsBefore = requests.length
  await cdp.typeAndSend(`ls:${WORKSPACE}`)
  await cdp.waitTurn()
  const lsText = requests.slice(lsBefore).map((entry) => entry.lastToolText).filter(Boolean).join('\n')
  record(
    'A1 ls filters sensitive entries',
    !lsText.includes('.env') && !lsText.includes('private.pem') && !lsText.includes('.git') && !lsText.includes('link-outside') && lsText.includes('safe.txt'),
    lsText.replace(/\n/g, ' | ').slice(0, 300)
  )

  // A1: grep must not enter sensitive dirs or leak sentinels.
  const grepBefore = requests.length
  await cdp.typeAndSend(`grep:P01_SECRET_SENTINEL|${WORKSPACE}`)
  await cdp.waitTurn()
  const grepText = requests.slice(grepBefore).map((entry) => entry.toolText).join('\n')
  record('A1 grep sentinel-free', !grepText.includes('P01_SECRET_SENTINEL'), grepText.replace(/\n/g, ' | ').slice(0, 260))

  // A1: find must ignore sensitive names and outside junctions.
  const findBefore = requests.length
  await cdp.typeAndSend(`find:**/*|${WORKSPACE}`)
  await cdp.waitTurn()
  const findText = requests.slice(findBefore).map((entry) => entry.lastToolText).filter(Boolean).join('\n')
  record(
    'A1 find filters sensitive entries',
    !findText.includes('.env') && !findText.includes('private.pem') && !findText.includes('secret.txt') && !findText.includes('link-outside') && findText.includes('safe.txt'),
    findText.replace(/\n/g, ' | ').slice(0, 320)
  )

  record('A1 no sentinel reached mock model', requests.every((entry) => !entry.leaked), `${requests.length} requests`)

  // A2: endpoint binding rules.
  const noKeyNewEndpoint = await saveModel(cdp, {
    ...model,
    baseUrl: 'http://127.0.0.1:8791/v2'
  })
  record(
    'A2 change path without key rejected',
    noKeyNewEndpoint.ok === false && noKeyNewEndpoint.error?.code === 'VALIDATION',
    JSON.stringify(noKeyNewEndpoint).slice(0, 180)
  )

  const sameEndpoint = await saveModel(cdp, {
    ...model,
    baseUrl: 'http://127.0.0.1:8791/v1/'
  })
  record(
    'A2 trailing slash keeps bound key',
    sameEndpoint.ok === true && sameEndpoint.value?.credentialState === 'bound',
    JSON.stringify(sameEndpoint.value?.model?.baseUrl)
  )

  const withKeyOtherEndpoint = await saveModel(cdp, {
    ...model,
    baseUrl: 'http://127.0.0.1:8793/v1',
    reasoning: true,
    apiKey: 'sk-fake-p01-C'
  })
  record('A2 new endpoint with key accepted', withKeyOtherEndpoint.ok === true, JSON.stringify(withKeyOtherEndpoint.error || ''))
  const backWithoutKey = await saveModel(cdp, { ...model })
  record(
    'A2 switch back without key rejected',
    backWithoutKey.ok === false && backWithoutKey.error?.code === 'VALIDATION',
    JSON.stringify(backWithoutKey).slice(0, 160)
  )
  const backWithKey = await saveModel(cdp, { ...model, apiKey: 'sk-fake-p01-A' })
  record('A2 restore first endpoint with key', backWithKey.ok === true, JSON.stringify(backWithKey.error || ''))

  // A2: plaintext checks.
  const settingsText = readFileSync(join(USER_DATA, 'config', 'settings.json'), 'utf8')
  const modelsText = readFileSync(join(USER_DATA, 'pi', 'agent', 'models.json'), 'utf8')
  record('A2 settings contain no API key', !settingsText.includes('sk-fake') && !settingsText.includes('apiKey'), '')
  record('A2 models.json contains no API key', !modelsText.includes('sk-fake') && modelsText.includes('runtime-injected-credential'), '')
  const publicJson = JSON.stringify(await getSettings(cdp))
  record('A2 renderer never receives key', !publicJson.includes('sk-fake') && !publicJson.includes('apiKey"'), publicJson.slice(0, 140))

  // A2: legacy key-only file must become needs-rebind.
  const credentialPath = join(USER_DATA, 'config', 'secrets', 'model-credential.bin')
  const legacyPath = join(USER_DATA, 'config', 'secrets', 'model-api-key.bin')
  writeFileSync(legacyPath, Buffer.from('legacy-unreadable').toString('base64'), 'utf8')
  rmSync(credentialPath, { force: true })
  await cdp.reload()
  state = await cdp.state()
  const rebind = await getSettings(cdp)
  record('A2 legacy credential -> needs-rebind', rebind.value?.credentialState === 'needs-rebind', JSON.stringify(rebind.value?.credentialState))
  record('A2 unbound key shows guidance', state.error.some((line) => line.includes('API Key')) || state.notice.some((line) => line.includes('API Key')), JSON.stringify(state.error.concat(state.notice)).slice(0, 200))

  const rebindSaved = await saveModel(cdp, { ...model, apiKey: 'sk-fake-p01-A' })
  record('A2 rebind with key', rebindSaved.ok === true && !existsSync(legacyPath), JSON.stringify(rebindSaved.error || ''))
  await cdp.reload()

  // B: normal stop must be neutral and keep partial text.
  await saveModel(cdp, model)
  await cdp.reload()
  await cdp.typeAndSend('long: 写一段很长的内容')
  await cdp.waitFor(`document.querySelector('.stop-button') && (document.querySelector('.message.assistant .message-text')?.textContent || '').length > 20`, 20_000)
  await cdp.evaluate(`document.querySelector('.stop-button')?.click(); true`)
  await cdp.waitIdle(20_000)
  state = await cdp.state()
  const stoppedText = state.assistant.at(-1)?.text || ''
  record('B stop shows neutral notice', state.notice.some((line) => line.includes('已停止')), JSON.stringify(state.notice))
  record('B stop has no red error', state.error.length === 0, JSON.stringify(state.error))
  record('B stop keeps partial text', stoppedText.length > 0, `${stoppedText.length} chars`)

  await cdp.evaluate(`document.querySelector('.session-item')?.click(); true`)
  await cdp.waitFor(`document.querySelectorAll('.message').length > 0`, 15_000)
  state = await cdp.state()
  record('B stopped turn restores', state.assistant.some((message) => message.text.length > 0), `assistant=${state.assistant.length}`)

  // B: real 401 must stay visible.
  const unauthorized = await saveModel(cdp, {
    ...model,
    baseUrl: 'http://127.0.0.1:8792/v1',
    apiKey: 'sk-fake-p01-401'
  })
  record('B configure 401 endpoint', unauthorized.ok === true, JSON.stringify(unauthorized.error || ''))
  await cdp.reload()
  await cdp.typeAndSend('hello 401')
  await cdp.waitFor(`document.querySelector('.error-banner')`, 30_000)
  state = await cdp.state()
  record('B 401 shows error banner', state.error.some((line) => line.includes('401') || line.includes('认证') || line.includes('API Key')), JSON.stringify(state.error).slice(0, 240))

  // B: thinking block persists across reopen.
  const reasoningSave = await saveModel(cdp, {
    ...model,
    baseUrl: 'http://127.0.0.1:8793/v1',
    reasoning: true,
    apiKey: 'sk-fake-p01-C'
  })
  record('B configure reasoning endpoint', reasoningSave.ok === true, JSON.stringify(reasoningSave.error || ''))
  await cdp.reload()
  await cdp.typeAndSend('reason: 你好')
  await cdp.waitFor(`document.querySelector('.message.assistant .message-text')?.textContent.includes('P0.1')`, 30_000)
  await cdp.waitIdle(20_000)
  state = await cdp.state()
  record('B thinking block rendered', state.thinkingBlocks > 0, `${state.thinkingBlocks} block(s)`)
  await cdp.evaluate(`document.querySelector('.session-item')?.click(); true`)
  await cdp.waitFor(`document.querySelectorAll('.message').length > 0`, 15_000)
  state = await cdp.state()
  record('B thinking block restored after reopen', state.thinkingBlocks > 0, `${state.thinkingBlocks} block(s)`)

  // B: oversized prompt is rejected, draft kept, no optimistic user bubble.
  await saveModel(cdp, model)
  await cdp.reload()
  const beforeUsers = (await cdp.state()).users.length
  const hugeDraft = `x${'超长内容'.repeat(26_000)}`
  await cdp.typeAndSend(hugeDraft)
  await cdp.waitFor(`document.querySelector('.error-banner')`, 20_000)
  state = await cdp.state()
  record('B oversized prompt keeps draft', state.textareaLength === hugeDraft.length, `${state.textareaLength} vs ${hugeDraft.length}`)
  record('B oversized prompt adds no user bubble', state.users.length === beforeUsers, `${state.users.length} vs ${beforeUsers}`)
  record('B oversized prompt shows backend error', state.error.some((line) => line.includes('100000') || line.includes('长度') || line.includes('过长')), JSON.stringify(state.error).slice(0, 200))

  // FTS5 self check.
  const diagnostics = await memoryDiagnostics(cdp)
  record(
    'C SQLite FTS5 Chinese query',
    diagnostics.ok === true && diagnostics.value?.fts5 === true && diagnostics.value?.sampleMatches === 1,
    JSON.stringify(diagnostics.value || diagnostics.error).slice(0, 220)
  )

  writeFileSync(join(LOG_DIR, 'self-test.json'), JSON.stringify({ results, requests }, null, 2))
  console.log(`\nP0.1 self test: ${results.length - failures}/${results.length} passed`)
  for (const server of servers) server.close()
  cdp.ws.close()
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('[p01-self-test] FAILED:', error)
  process.exitCode = 1
})
