#!/usr/bin/env node
/**
 * Local mock of an OpenAI-compatible Chat Completions endpoint.
 *
 * Usage: pnpm mock-model
 * Then configure OpenFuture with Base URL http://127.0.0.1:8787/v1 and any
 * model id (for example mock-model). This keeps P0 verification fully offline.
 */
import http from 'node:http'

const PORT = Number(process.env.MOCK_MODEL_PORT || 8787)
const HOST = '127.0.0.1'
const DELAY_MS = Number(process.env.MOCK_DELAY_MS || 18)
const MODEL = process.env.MOCK_MODEL_ID || 'mock-model'

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

function lastUserMessage(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message && message.role === 'user') return textOf(message.content)
  }
  return ''
}

function buildReply(body) {
  const user = lastUserMessage(body).trim()
  const excerpt = user.length > 160 ? `${user.slice(0, 160)}…` : user
  return [
    '你好，我是 OpenFuture 的本地 Mock 模型。',
    '',
    user ? `我收到了你的消息：「${excerpt}」` : '我收到了一条空消息。',
    '',
    '这条回复由 tools/mock-model/server.mjs 流式生成，用于验证：',
    '1. Pi 会话在 utilityProcess 中启动并输出 text_delta；',
    '2. 渲染层逐字显示、停止按钮与会话恢复；',
    '3. 打包后的应用仍然可以正常加载 Pi 的 ESM SDK。',
    '',
    '配置一个真实模型后，就可以开始正式对话了。'
  ].join('\n')
}

function sseChunk(id, created, model, delta, finishReason = null, usage = undefined) {
  const payload = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  }
  if (usage) payload.usage = usage
  return `data: ${JSON.stringify(payload)}\n\n`
}

function streamCompletion(response, body) {
  const id = `chatcmpl-mock-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  const model = typeof body.model === 'string' && body.model ? body.model : MODEL
  const reply = buildReply(body)
  const characters = Array.from(reply)
  let offset = 0
  let closed = false
  let timer = null

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })

  const finish = () => {
    if (closed) return
    closed = true
    response.write(
      sseChunk(id, created, model, {}, 'stop', {
        prompt_tokens: 32,
        completion_tokens: characters.length,
        total_tokens: 32 + characters.length
      })
    )
    response.write('data: [DONE]\n\n')
    response.end()
  }

  const step = () => {
    if (closed) return
    if (offset >= characters.length) {
      finish()
      return
    }
    const size = 4 + Math.floor(Math.random() * 5)
    const piece = characters.slice(offset, offset + size).join('')
    offset += size
    response.write(sseChunk(id, created, model, { content: piece }))
    timer = setTimeout(step, DELAY_MS)
  }

  response.on('close', () => {
    closed = true
    if (timer) clearTimeout(timer)
  })

  response.write(sseChunk(id, created, model, { role: 'assistant', content: '' }))
  timer = setTimeout(step, DELAY_MS)
}

function jsonCompletion(response, body) {
  const id = `chatcmpl-mock-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  const model = typeof body.model === 'string' && body.model ? body.model : MODEL
  const reply = buildReply(body)
  const payload = {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: reply },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 32, completion_tokens: Array.from(reply).length, total_tokens: 32 + Array.from(reply).length }
  }
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', `http://${HOST}:${PORT}`)

  if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true, service: 'openfuture-mock-model', model: MODEL }))
    return
  }

  if (request.method === 'GET' && url.pathname === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'openfuture' }]
      })
    )
    return
  }

  if (request.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
    void readBody(request)
      .then((body) => {
        const streaming = body.stream !== false
        console.log(
          `[mock] ${new Date().toISOString()} model=${body.model || MODEL} stream=${streaming} messages=${Array.isArray(body.messages) ? body.messages.length : 0}`
        )
        if (streaming) streamCompletion(response, body)
        else jsonCompletion(response, body)
      })
      .catch((error) => {
        console.error('[mock] bad request:', error.message)
        if (!response.headersSent) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        }
        response.end(JSON.stringify({ error: { message: error.message, type: 'invalid_request_error' } }))
      })
    return
  }

  response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ error: { message: `not found: ${request.method} ${url.pathname}` } }))
})

server.listen(PORT, HOST, () => {
  console.log(`[mock] OpenAI-compatible endpoint: http://${HOST}:${PORT}/v1`)
  console.log(`[mock] model id: ${MODEL} (any id is accepted)`)
  console.log('[mock] press Ctrl+C to stop')
})
