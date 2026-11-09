#!/usr/bin/env node
/**
 * P0.1 test-only OpenAI-compatible mock.
 *
 * It can either emit a scripted tool call (read/ls/grep/find) or stream a final
 * text; every request body is appended to a JSONL log so tests can prove that
 * protected sentinels never reached the model endpoint.
 */
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const port = Number(process.env.P01_MOCK_PORT || 8791)
const logPath = process.env.P01_MOCK_LOG || '.scratch/p01-mock-requests.jsonl'
const failStatus = Number(process.env.P01_MOCK_FAIL || 0)
const modelId = process.env.P01_MOCK_MODEL || 'p01-mock'
const reasoning = process.env.P01_MOCK_REASONING === '1'
mkdirSync(dirname(logPath), { recursive: true })

function writeLog(entry) {
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8')
}

function sseChunk(delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })}\n\n`
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message && message.role === 'user') {
      if (typeof message.content === 'string') return message.content
      if (Array.isArray(message.content)) {
        return message.content
          .filter((part) => part && part.type === 'text')
          .map((part) => part.text)
          .join('\n')
      }
    }
  }
  return ''
}

function parseDirective(text) {
  const trimmed = text.trim()
  const match = /^(read|ls|grep|find|memory_search|memory_get|wiki_search|wiki_get|memory_propose):(.+)$/s.exec(trimmed)
  if (!match) return null
  const [, tool, rest] = match
  if (tool === 'read' || tool === 'ls') {
    return { name: tool, args: { path: rest.trim() } }
  }
  if (tool === 'memory_get' || tool === 'wiki_get') {
    return { name: tool, args: { id: rest.trim() } }
  }
  if (tool === 'memory_search' || tool === 'wiki_search') {
    return { name: tool, args: { query: rest.trim(), limit: 8 } }
  }
  if (tool === 'memory_propose') {
    const [title, body, evidenceIds] = rest.split('|')
    return {
      name: tool,
      args: {
        type: 'fact',
        title: (title || 'Memory candidate').trim(),
        body: (body || 'Candidate body').trim(),
        evidenceIds: (evidenceIds || '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      }
    }
  }
  const [pattern, path] = rest.split('|')
  return {
    name: tool,
    args: { pattern: pattern.trim(), path: (path || '.').trim() }
  }
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  })
  response.end(payload)
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, { ok: true, port, modelId, failStatus })
    return
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    sendJson(response, 200, { object: 'list', data: [{ id: modelId, object: 'model' }] })
    return
  }
  if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
    sendJson(response, 404, { error: { message: 'not found' } })
    return
  }

  let body
  try {
    body = await readBody(request)
  } catch {
    sendJson(response, 400, { error: { message: 'invalid json' } })
    return
  }

  const messages = Array.isArray(body.messages) ? body.messages : []
  const systemText = messages
    .filter((message) => message && message.role === 'system')
    .map((message) => String(message.content ?? ''))
    .join('\n')
  const toolMessages = messages.filter((message) => message && message.role === 'tool')
  const toolText = toolMessages.map((message) => String(message.content ?? '')).join('\n')
  const leaked = toolText.includes('P01_SECRET_SENTINEL') || toolText.includes('P01_SECRET_SENTINEL_PEM')
  writeLog({
    at: new Date().toISOString(),
    path: request.url,
    hasAuthorization: Boolean(request.headers.authorization),
    lastUser: lastUserText(messages).slice(0, 200),
    toolMessages: toolMessages.length,
    leaked,
    toolText: toolText.slice(0, 1200),
    systemRoles: messages.filter((m) => m && m.role === 'system').map((m) => ({ type: typeof m.content, len: String(m.content ?? '').length })),
    systemHead: systemText.slice(0, 300),
    systemHasMemory: systemText.includes('<memory_context>'),
    systemMemoryExcerpt: systemText.includes('<memory_context>')
      ? systemText.slice(Math.max(0, systemText.indexOf('<memory_context>') - 80), systemText.indexOf('<memory_context>') + 900)
      : ''
  })

  if (failStatus) {
    sendJson(response, failStatus, {
      error: {
        message: 'P0.1 injected authentication failure',
        type: 'invalid_request_error',
        code: 'invalid_api_key'
      }
    })
    return
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })

  const write = (chunk) => response.write(chunk)

  if (toolMessages.length > 0) {
    write(
      sseChunk({
        role: 'assistant',
        content: leaked ? 'DONE:LEAK' : 'DONE:CLEAN'
      })
    )
    write(
      sseChunk(
        {
          role: 'assistant',
          content: ''
        },
        'stop'
      )
    )
    write('data: [DONE]\n\n')
    response.end()
    return
  }

  const directive = parseDirective(lastUserText(messages))
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
            function: {
              name: directive.name,
              arguments: JSON.stringify(directive.args)
            }
          }
        ]
      })
    )
    write(sseChunk({ role: 'assistant', content: '' }, 'tool_calls'))
    write('data: [DONE]\n\n')
    response.end()
    return
  }

  if (reasoning) {
    for (const piece of ['先确认指令，', '再给出简短回答。']) {
      write(sseChunk({ role: 'assistant', reasoning_content: piece }))
    }
  }
  const text = 'P0.1 mock response: 收到，测试通过。'
  const parts = text.match(/.{1,6}/gu) || [text]
  for (const part of parts) {
    write(sseChunk({ role: 'assistant', content: part }))
  }
  write(sseChunk({ role: 'assistant', content: '' }, 'stop'))
  write('data: [DONE]\n\n')
  response.end()
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[p01-mock] listening on http://127.0.0.1:${port} model=${modelId} log=${logPath}`)
})
