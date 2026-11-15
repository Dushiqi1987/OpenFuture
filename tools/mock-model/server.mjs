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
const REASONING = process.env.MOCK_REASONING || ''
const TOOL_CALL_MODE = process.env.MOCK_TOOL_CALL || ''
const GROUP_CHAT_MODE = process.env.MOCK_GROUP_CHAT === '1'
const PLUGIN_ADAPT_MODE = process.env.MOCK_PLUGIN_ADAPT === '1'
const FILE_REPLY = process.env.MOCK_FILE_REPLY || ''

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

/** Text of the most recent tool result, if the turn already ran a tool. */
function toolResultExcerpt(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message && message.role === 'tool') return textOf(message.content)
  }
  return ''
}

/**
 * MOCK_TOOL_CALL=delegate makes the mock emit a real `delegate_tasks` call so
 * the subagent runtime can be exercised end to end without a live model: the
 * call is only produced when the request advertises that tool (children never
 * do), and only on the first turn (after a tool result we answer in text).
 */
function delegateArguments(body) {
  if (TOOL_CALL_MODE !== 'delegate') return null
  const tools = Array.isArray(body.tools) ? body.tools : []
  const advertises = tools.some((tool) => tool && tool.function && tool.function.name === 'delegate_tasks')
  if (!advertises || toolResultExcerpt(body)) return null
  const user = lastUserMessage(body).trim() || '并行调研当前工作区'
  const excerpt = user.length > 120 ? `${user.slice(0, 120)}…` : user
  return JSON.stringify({
    tasks: [
      { title: '视角 A', prompt: `子任务 A：就「${excerpt}」给出一句话结论。` },
      { title: '视角 B', prompt: `子任务 B：就「${excerpt}」给出一句话结论。` }
    ]
  })
}

/**
 * MOCK_GROUP_CHAT=1 makes the parent agent call `start_group_chat`; role
 * sessions in the group never advertise that tool, so they answer with role
 * text instead and the two modes cannot recurse into each other.
 */
function groupChatArguments(body) {
  if (!GROUP_CHAT_MODE) return null
  const tools = Array.isArray(body.tools) ? body.tools : []
  const advertises = tools.some((tool) => tool && tool.function && tool.function.name === 'start_group_chat')
  if (!advertises || toolResultExcerpt(body)) return null
  const user = lastUserMessage(body).trim() || '把当前任务交给一个主研和一个评审讨论'
  const excerpt = user.length > 120 ? `${user.slice(0, 120)}…` : user
  return JSON.stringify({ goal: excerpt, rounds: 2 })
}

/** First tool call the mock should emit for this request, or null. */
/**
 * MOCK_ASK=1: pretend the model wants a clarification before writing the game.
 * Only fires while `ask_user` is offered and no tool result is present yet, so
 * the second turn simply consumes the user's answer.
 */
function askArguments(body) {
  if (process.env.MOCK_ASK !== '1') return null
  const names = Array.isArray(body?.tools) ? body.tools.map((tool) => tool?.function?.name) : []
  if (!names.includes('ask_user')) return null
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const last = messages[messages.length - 1]
  const asksAgain = last?.role === 'user' && textOf(last.content).includes('再问一次')
  if (toolResultExcerpt(body) && !asksAgain) return null
  return JSON.stringify({
    kind: 'choice',
    question: '你想让我先做哪一种小游戏？选一个我就直接开工。',
    options: [
      { label: '贪吃蛇', description: '经典街机，方向键控制' },
      { label: '打砖块', description: '挡板反弹球，清空砖块' },
      { label: '2048', description: '数字合并，滑动手感' }
    ],
    allowCustom: true
  })
}

function writeArguments(body) {
  if (process.env.MOCK_WRITE !== '1') return null
  const tools = Array.isArray(body.tools) ? body.tools : []
  const advertises = tools.some((tool) => tool && tool.function && tool.function.name === 'write')
  if (!advertises || toolResultExcerpt(body)) return null
  return JSON.stringify({
    path: 'mock-edit/notes.md',
    content: [
      '# 会议记录',
      '',
      '- 第一行：由 mock 模型写入',
      '- 第二行：用于验证差异统计',
      '- 第三行：写完了'
    ].join('\n') + '\n'
  })
}

function desktopArguments(body) {
  if (process.env.MOCK_DESKTOP !== '1') return null
  const names = Array.isArray(body?.tools) ? body.tools.map((tool) => tool?.function?.name) : []
  if (!names.includes('computer_desktop_status')) return null
  if (toolResultExcerpt(body)) return null
  return '{}'
}

function toolCallArguments(body) {
  const desktop = desktopArguments(body)
  if (desktop) return { name: 'computer_desktop_status', arguments: desktop }
  const delegate = delegateArguments(body)
  if (delegate) return { name: 'delegate_tasks', arguments: delegate }
  const group = groupChatArguments(body)
  if (group) return { name: 'start_group_chat', arguments: group }
  const ask = askArguments(body)
  if (ask) return { name: 'ask_user', arguments: ask }
  const write = writeArguments(body)
  if (write) return { name: 'write', arguments: write }
  return null
}

/** All system text concatenated: group role cards arrive there before the turn. */
function systemText(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages
    .filter((message) => message && message.role === 'system')
    .map((message) => textOf(message.content))
    .join('\n')
}

/**
 * MOCK_GROUP_CHAT=1 answers each group role with a valid, role-shaped message,
 * so the serial group-chat runtime can be verified offline: stance markers drive
 * convergence, and TEST_UNRESOLVED in the goal keeps the critic blocking.
 */
function groupReply(body) {
  const system = systemText(body)
  const user = lastUserMessage(body)
  const unresolved = user.includes('TEST_UNRESOLVED')
  if (system.includes('你是「主持」')) {
    return unresolved
      ? [
          '【未收敛】',
          '方案：主研版本：保守推进；评审版本：先补齐压测再推进。',
          '依据：[#1] [#2] [#3] [#4]',
          '未解决分歧：是否必须在首版前补压测数据。',
          '风险：mock 模式不产生真实结论，仅验证协议与收敛路径。',
          '下一步：由用户裁决是否接受主研的保守方案。'
        ].join('\n')
      : [
          '【共识】',
          '方案：按主研方案推进，先补只读证据再动写路径。',
          '依据：[#1] [#2]',
          '未解决分歧：无',
          '风险：mock 模式不产生真实结论，仅验证协议与收敛路径。',
          '下一步：真实模型下复核评审的阻断项。'
        ].join('\n')
  }
  if (system.includes('你是「评审」')) {
    return unresolved
      ? [
          '【质疑】',
          '1. 缺少并发写入的压测数据（依据：无 E 编号，验证方法：两路并行写同一文件）。',
          '2. 收敛条件没有覆盖"评审缺席"的情形。',
          '【可接受部分】消息格式与台账设计。',
          '【立场】反对',
          '【阻断项】有'
        ].join('\n')
      : [
          '【质疑】',
          '1. 只读工具的白名单需要固定，否则评审可能越权（验证方法：检查 allowlist）。',
          '【可接受部分】串行发言与证据编号设计。',
          '【立场】同意',
          '【阻断项】无'
        ].join('\n')
  }
  if (system.includes('你是「主研」')) {
    const lines = [
      '【工作汇报】',
      '目标复述：为 OpenFuture 增加串行群聊能力。',
      '做了什么：检查了 subagent-runtime 的会话创建方式（E1），复用了同一套 in-process 会话参数。',
      '结论：可行，串行发言天然避免工具并发冲突。',
      '不确定点：真实模型下评审是否会给足证据。'
    ]
    // Round 1 is a work report without a stance; the response turn states one,
    // which is what lets the runtime converge on round 2.
    if (user.includes('逐条回应')) lines.push('', '【立场】同意')
    return lines.join('\n')
  }
  return ''
}

function pluginAdaptReply(body) {
  if (!PLUGIN_ADAPT_MODE) return null
  const text = (Array.isArray(body.messages) ? body.messages : [])
    .map((message) => textOf(message?.content))
    .join('\n')
  if (!text.includes('插件适配工程师')) return null
  // Opt-in dependency header so the deps button can be exercised offline.
  const deps = process.env.MOCK_PLUGIN_DEPS === '1'
    ? '// deps: ' + (process.env.MOCK_PLUGIN_DEPS_SPEC ?? 'is-number@7') + '\n'
    : ''
  return [
    '适配说明：原插件是 DSH 的 host 插件，这里降级为 OpenFuture 扩展，注册一个命令并注入一行提示。',
    '',
    '```js',
    ...(deps === '' ? [] : [deps.trimEnd(), "import isNumber from 'is-number'"]),
    'export default function (api) {',
    "  api.registerCommand?.('dsh_demo', {",
    "    description: '来自 DSH 插件的示例命令',",
    "    handler: async () => 'dsh_demo: adapted by mock model'",
    '  })',
    "  api.registerTool?.({",
    "    name: 'dsh_demo_echo',",
    "    label: 'DSH 示例工具',",
    "    description: '回显传入的文本（来自适配后的 DSH 插件）',",
    "    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },",
    "    execute: async (_toolCallId, params) => ({ content: [{ type: 'text', text: String(params?.text ?? '') }] })",
    "  })",
    "  api.on?.('before_agent_start', async () => ({ systemPrompt: '已加载 dsh_demo 插件。' }))",
    '}',
    '```'
  ].join('\n')
}

function buildReply(body) {
  const pluginReply = pluginAdaptReply(body)
  if (pluginReply) return pluginReply
  // File-link smoke: hand back a path the renderer should turn into a link.
  if (FILE_REPLY !== '') {
    return `做好了：\`${FILE_REPLY}\`\n\n这是一个单文件页面，点击上面的路径即可在内置浏览器里查看，也可以选「外部浏览器」交给系统打开。`
  }
  const user = lastUserMessage(body).trim()
  const excerpt = user.length > 160 ? `${user.slice(0, 160)}…` : user
  // MCP smoke: prove the model actually received the tool declarations by
  // echoing the names it was offered in this request. A `/skill:` prompt is
  // echoed verbatim instead, so the smoke can assert the skill body reached
  // the model after expansion.
  if (process.env.MOCK_REPORT_TOOLS === '1') {
    if (user.startsWith('/skill:') || user.startsWith('<skill')) return user
    const names = Array.isArray(body?.tools)
      ? body.tools.map((tool) => tool?.function?.name).filter((name) => typeof name === 'string')
      : []
    return `MOCK_TOOLS: ${names.join(',')}`
  }
  const groupReplyText = groupReply(body)
  if (groupReplyText) return groupReplyText
  const toolResult = toolResultExcerpt(body)
  if (toolResult && process.env.MOCK_WRITE === '1') {
    return '已把会议记录写入 `mock-edit/notes.md`，并按工作区策略完成校验。'
  }
  if (toolResult && process.env.MOCK_DESKTOP === '1' && toolResult.includes('"platform"')) {
    return `桌面工具返回：${toolResult.slice(0, 300)}`
  }
  if (toolResult && process.env.MOCK_ASK === '1') {
    return `明白：${toolResult.slice(0, 200)}\n\n我按这个方向开始实现。`
  }
  if (toolResult) {
    const brief = toolResult.length > 400 ? `${toolResult.slice(0, 400)}…` : toolResult
    const isGroup = toolResult.includes('## 群聊记录')
    return [
      isGroup ? '群聊已结束，以下是主持人的结论：' : '并行子 Agent 已返回结果，汇总如下：',
      '',
      brief,
      '',
      '（mock 模型不做二次加工，这里直接回显工具结果。）'
    ].join('\n')
  }
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

function streamToolCall(response, id, created, model, toolName, toolArguments) {
  const callId = `call-mock-${Date.now()}`
  const pieces = []
  for (let index = 0; index < toolArguments.length; index += 48) {
    pieces.push(toolArguments.slice(index, index + 48))
  }
  let offset = 0
  let closed = false
  let timer = null

  const finish = () => {
    if (closed) return
    closed = true
    response.write(
      sseChunk(id, created, model, {}, 'tool_calls', {
        prompt_tokens: 32,
        completion_tokens: pieces.join('').length,
        total_tokens: 32 + pieces.join('').length
      })
    )
    response.write('data: [DONE]\n\n')
    response.end()
  }

  const step = () => {
    if (closed) return
    if (offset >= pieces.length) {
      finish()
      return
    }
    response.write(
      sseChunk(id, created, model, {
        tool_calls: [{ index: 0, function: { arguments: pieces[offset] } }]
      })
    )
    offset += 1
    timer = setTimeout(step, DELAY_MS)
  }

  response.on('close', () => {
    closed = true
    if (timer) clearTimeout(timer)
  })

  response.write(
    sseChunk(id, created, model, {
      role: 'assistant',
      content: null,
      tool_calls: [
        { index: 0, id: callId, type: 'function', function: { name: toolName, arguments: '' } }
      ]
    })
  )
  timer = setTimeout(step, DELAY_MS)
}

function streamCompletion(response, body) {
  const id = `chatcmpl-mock-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  const model = typeof body.model === 'string' && body.model ? body.model : MODEL
  const reply = buildReply(body)
  const tool = toolCallArguments(body)
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

  if (tool) {
    if (REASONING) {
      response.write(sseChunk(id, created, model, { role: 'assistant', reasoning_content: REASONING }))
    }
    streamToolCall(response, id, created, model, tool.name, tool.arguments)
    return
  }

  if (REASONING) {
    // Pi maps OpenAI-compatible reasoning deltas to thinking blocks, which the
    // renderer shows as its own collapsed step row.
    response.write(sseChunk(id, created, model, { role: 'assistant', reasoning_content: REASONING }))
  }

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
  const tool = toolCallArguments(body)
  const payload = tool
    ? {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call-mock-${Date.now()}`,
                  type: 'function',
                  function: { name: tool.name, arguments: tool.arguments }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 32, completion_tokens: 0, total_tokens: 32 }
      }
    : {
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
        usage: {
          prompt_tokens: 32,
          completion_tokens: Array.from(reply).length,
          total_tokens: 32 + Array.from(reply).length
        }
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
