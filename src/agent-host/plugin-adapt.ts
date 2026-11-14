export interface AdaptSession {
  subscribe(listener: (event: { type: string; message?: unknown }) => void): () => void
  prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<unknown>
  abort(): void | Promise<void>
  dispose(): void
}

/**
 * Turn a downloaded DSH plugin into a Pi extension source file.
 *
 * DSH plugins are cordis plugins: they import `@deepseek-ai/*` host packages
 * and expect the DSH plugin loader, so they cannot be imported here. The only
 * practical bridge is to let the model rewrite the useful part of the plugin
 * against this app's extension API, then load the generated file as an inline
 * extension factory.
 *
 * The model runs with no tools at all: everything it needs is inlined in the
 * prompt, and it answers with a single fenced JavaScript block. That keeps the
 * generated code reviewable and avoids giving a tool loop write access to the
 * user's disk.
 */

export interface PluginAdaptSource {
  path: string
  text: string
}

export interface PluginAdaptOptions {
  pi: {
    createAgentSession: (options: Record<string, unknown>) => Promise<{ session: AdaptSession }>
    SessionManager: { create: (cwd: string, sessionDir?: string) => unknown }
    DefaultResourceLoader: new (options: Record<string, unknown>) => {
      reload: () => Promise<void>
    }
  }
  modelRuntime: unknown
  model: unknown
  cwd: string
  agentDir: string
  sessionDir: string
  settingsManager: unknown
  pluginName: string
  description: string
  sources: PluginAdaptSource[]
}

export interface PluginAdaptOutcome {
  code: string
  note: string
}

const MAX_PROMPT_CHARS = 90_000
const DEFAULT_TIMEOUT_MS = 240_000

const EXTENSION_CONTRACT = `
你是 OpenFuture 的插件适配工程师。OpenFuture 是一个基于 Pi SDK 的桌面 Agent，
它不能直接运行 DSH（DeepSeek Harness）的 cordis 插件。你的任务：把给定的 DSH 插件源码
改写成一个 OpenFuture 能加载的 Pi 扩展文件。

## 目标产物（唯一文件）

一个 ESM JavaScript 文件，形状必须是：

\`\`\`js
export default function (api) {
  // 在这里注册能力
}
\`\`\`

硬性约束：
- 除“npm 依赖”一节声明的包以外，不要有其它 import / require。
- 不要发起任何网络请求去加载 DSH 的包。
- 不要把整个插件原样搬运；只保留能在 OpenFuture 里独立成立的能力。
- 所有注册都包在 try/catch 里，失败只打日志，不能抛出导致会话启动失败。
- 不要读写宿主文件、不要执行 shell。
- 用中文写注释与用户可见文案。

## npm 依赖（可选，最多 6 个）

如果你确实需要第三方包（例如 ssh2、ws、cheerio）：
- 在文件第一行写 \`// deps: 包名@版本范围, 包名2@版本范围\`，只列出你真正 import 的公开 npm 包，版本范围用 ^、~ 或精确版本。
- 用 \`import 名字 from '包名'\` 引入；不要 import 未声明的包，也不要使用 Node 内置模块（node:*）。
- 用户安装依赖并启用插件后，宿主才会加载扩展。静态 import 写在模块顶层。
- 禁止 child_process、禁止直接写文件系统、禁止自己开服务器监听；依赖自带的网络能力请在这段说明里写明，让用户知情。

## 可用的 api 能力（只允许这些）

1) 生命周期钩子：
   api.on('before_agent_start', async (event) => ({ systemPrompt: event.systemPrompt + '\\n额外要求…' }))
   api.on('agent_end', async () => {})
   api.on('tool_call', async (event) => undefined)   // 返回 { block: true, reason } 可拦截
   api.on('tool_result', async (event) => undefined)

2) 注册命令（用户在输入框输入 /命令 触发）：
   api.registerCommand('命令名', {
     description: '一句话说明',
     handler: async (args, ctx) => { /* ctx.ui / ctx.cwd 可用 */ }
   })

3) 注册 LLM 可调用工具：
   api.registerTool({
     name: 'snake_case_tool_name',
     label: '中文标签',
     description: '给模型看的说明',
     parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
     execute: async (toolCallId, params) => ({ content: [{ type: 'text', text: String(params.text ?? '') }] })
   })

## 适配策略

- 如果插件是 UI 面板 / 设置页 / 主题装饰：OpenFuture 没有 DSH 的客户端插件容器，
  把它降级成「注册一个命令 + 在 before_agent_start 里注入提示」或「注册一个工具」，并在
  文件头注释里写清楚丢失了哪些交互。
- 如果插件是工具/技能（搜索、抓取、命令封装）：优先改写成 registerTool，保持参数名与语义。
- 如果插件强依赖 DSH 私有服务（ctx.tools、ctx.credentials 等）：在文件头注释里说明
  无法适配的部分，只保留可独立实现的子集；宁可少做，也不要伪造能力。
- 生成的工具名统一加前缀 \`dsh_\`，避免和内置工具冲突。

## 输出格式

先写 3-6 行中文说明（做了什么、丢失了什么），然后输出且只输出一个
\`\`\`js 代码块，代码块里就是最终文件内容。不要在代码块之后写任何东西。
`

function fenceCode(text: string): string | null {
  const matches = [...text.matchAll(/```(?:js|javascript|mjs)\s*\n([\s\S]*?)```/gi)]
  const last = matches.length > 0 ? matches[matches.length - 1] : undefined
  if (last && typeof last[1] === 'string' && last[1].trim() !== '') return last[1].trim()
  return null
}

function buildPrompt(options: PluginAdaptOptions): string {
  const parts: string[] = [EXTENSION_CONTRACT, '', `## 插件：${options.pluginName}`, options.description.trim(), '', '## 源码']
  let budget = MAX_PROMPT_CHARS
  for (const source of options.sources) {
    if (budget <= 0) break
    const text = source.text.slice(0, Math.max(0, budget))
    budget -= text.length
    parts.push('', `### FILE ${source.path}`, '```', text, '```')
  }
  return parts.join('\n')
}

export async function adaptPluginSources(options: PluginAdaptOptions): Promise<PluginAdaptOutcome> {
  const sessionManager = options.pi.SessionManager.create(options.cwd, options.sessionDir)
  const resourceLoader = new options.pi.DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true
  })
  await resourceLoader.reload()
  const { session } = await options.pi.createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRuntime: options.modelRuntime,
    model: options.model,
    thinkingLevel: 'low',
    tools: [],
    customTools: [],
    sessionManager,
    settingsManager: options.settingsManager,
    resourceLoader
  })

  let assistantText = ''
  let lastAssistant: unknown = null
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== 'message_end') return
    const message = (event as { message?: { role?: string; content?: unknown } }).message
    if (!message || message.role !== 'assistant') return
    lastAssistant = message
    const content = Array.isArray(message.content) ? message.content : []
    const text = content
      .map((part) => (part && typeof part === 'object' && (part as { type?: string }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : ''))
      .join('')
      .trim()
    if (text !== '') assistantText = text
  })

  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void session.abort()
        reject(new Error('适配超时（4 分钟）'))
      }, DEFAULT_TIMEOUT_MS)
    })
    await Promise.race([session.prompt(buildPrompt(options), { expandPromptTemplates: false }), timeout])
  } finally {
    clearTimeout(timer)
    unsubscribe()
    try {
      session.dispose()
    } catch {
      // ignore disposal failures
    }
  }

  const finished = lastAssistant as { stopReason?: string; errorMessage?: string } | null
  if (finished && finished.stopReason === 'error') {
    const detail = (finished.errorMessage ?? '').trim()
    console.error(`[plugin-adapt] model error: ${detail}`)
    throw new Error(`模型调用失败：${detail === '' ? '未知错误' : detail.slice(0, 300)}`)
  }

  const code = fenceCode(assistantText)
  if (!code) {
    const tail = assistantText.slice(-1_500)
    const dump = lastAssistant ? JSON.stringify(lastAssistant).slice(0, 1_200) : 'null'
    console.error(
      `[plugin-adapt] no js code block (length=${assistantText.length}) tail:\n${tail}\nlast assistant:\n${dump}`
    )
    throw new Error('模型没有返回可解析的 JavaScript 代码块')
  }
  const note = assistantText.slice(0, assistantText.indexOf('```')).trim()
  return { code, note }
}
