import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ComputerToolInfo, ComputerToolResult } from '../shared/protocol'
import { AppError, toErrorMessage } from './errors'

/**
 * A deliberately small MCP client for the local Windows desktop automation
 * server. It is only started after the user explicitly enables Computer Use.
 *
 * The upstream server also ships PowerShell, filesystem, registry, app launch
 * and web scraping tools. Those are intentionally not requested here.
 */
const ALLOWED_TOOLS = [
  'ControlStatus',
  'DisplayInventory',
  'Screenshot',
  'Snapshot',
  'Click',
  'Type',
  'Scroll',
  'Move',
  'Shortcut',
  'Wait',
  'WaitFor',
  'Clipboard',
  'MultiSelect',
  'MultiEdit',
  'Notification'
] as const

const GATED_TOOLS = new Set(['Click', 'Type', 'Scroll', 'Move', 'Shortcut', 'MultiSelect', 'MultiEdit'])
const CONTROL_RETRY_MS = 15_000
const TOOL_PREFIX = 'computer_'
const INIT_TIMEOUT_MS = 30_000
const LIST_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 60_000
const MAX_STDERR = 4_000

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export class ComputerUseBridge {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly pending = new Map<number, PendingCall>()
  private nextId = 0
  private buffer = ''
  private stderr = ''
  private tools: ComputerToolInfo[] = []
  private toolByExposed = new Map<string, string>()
  private starting: Promise<void> | null = null

  async listTools(): Promise<ComputerToolInfo[]> {
    await this.start()
    return this.tools
  }

  async call(exposedName: string, args: unknown): Promise<ComputerToolResult> {
    await this.start()
    const mcpName = this.toolByExposed.get(exposedName)
    if (!mcpName) {
      throw new AppError('VALIDATION', `未知 Computer Use 工具：${exposedName}`)
    }
    const raw = await this.requestDesktopCall(mcpName, args ?? {})
    const result = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const content = Array.isArray(result.content) ? result.content : []
    const mapped: ComputerToolResult['content'] = []
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      const entry = item as Record<string, unknown>
      if (entry.type === 'text' && typeof entry.text === 'string') {
        mapped.push({ type: 'text', text: entry.text })
      } else if (entry.type === 'image' && typeof entry.data === 'string') {
        mapped.push({
          type: 'image',
          data: entry.data,
          mimeType: typeof entry.mimeType === 'string' ? entry.mimeType : 'image/png'
        })
      }
    }
    if (mapped.length === 0) {
      mapped.push({ type: 'text', text: JSON.stringify(raw, null, 2) })
    }
    const isError = result.isError === true
    if (isError) {
      const text = mapped
        .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
        .map((item) => item.text)
        .join('\n')
      throw new AppError('PI_ERROR', text || 'Windows 桌面工具调用失败')
    }
    return { content: mapped }
  }

  /**
   * Windows-MCP refuses gated input while the user has used the keyboard or
   * mouse in the last ten seconds (USER_CONTROL). Wait for the desktop to become
   * idle and retry instead of surfacing a misleading "no control" failure.
   */
  private async requestDesktopCall(name: string, args: unknown): Promise<unknown> {
    const deadline = Date.now() + CONTROL_RETRY_MS
    for (;;) {
      try {
        const raw = await this.request(
          'tools/call',
          { name, arguments: args },
          CALL_TIMEOUT_MS
        )
        if (!this.isControlBlocked(name, raw) || Date.now() >= deadline) return raw
      } catch (error) {
        if (!this.isControlBlocked(name, toErrorMessage(error)) || Date.now() >= deadline) {
          throw error
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  private isControlBlocked(name: string, value: unknown): boolean {
    if (!GATED_TOOLS.has(name)) return false
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
    return /USER_CONTROL|PHYSICAL_INPUT_HELD|TAKEOVER_PENDING/.test(text)
  }

  dispose(): void {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timer)
      pending.reject(new Error('Computer Use 已关闭'))
    })
    this.pending.clear()
    this.starting = null
    this.tools = []
    this.toolByExposed.clear()
    const child = this.child
    this.child = null
    if (child) {
      try {
        child.kill()
      } catch {
        // Process may already be gone.
      }
    }
  }

  private resolveUvx(): string {
    const configured = process.env.OPENFUTURE_UVX?.trim()
    if (configured && existsSync(configured)) return configured
    const candidate = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'uvx.exe' : 'uvx')
    if (!existsSync(candidate)) {
      throw new AppError(
        'HOST_UNAVAILABLE',
        'Computer Use 需要 uv/uvx。请先运行 `irm https://astral.sh/uv/install.ps1 | iex` 安装 uv，再重试。'
      )
    }
    return candidate
  }

  private async start(): Promise<void> {
    if (this.child && this.tools.length > 0) return
    if (this.starting) return this.starting
    this.starting = this.startInternal().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startInternal(): Promise<void> {
    this.dispose()
    const uvx = this.resolveUvx()
    const child = spawn(
      uvx,
      [
        'windows-mcp@0.8.8',
        'serve',
        '--transport',
        'stdio',
        '--tools',
        ALLOWED_TOOLS.join(',')
      ],
      {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        stdio: 'pipe'
      }
    )
    this.child = child
    this.buffer = ''
    this.stderr = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-MAX_STDERR)
      for (const line of chunk.split(/\r?\n/)) {
        const text = line.trim()
        if (text) console.log(`[computer-use] ${text.slice(0, 800)}`)
      }
    })
    child.on('error', (error) => {
      this.rejectAll(new AppError('HOST_UNAVAILABLE', `无法启动 windows-mcp：${toErrorMessage(error)}`))
    })
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      this.tools = []
      this.toolByExposed.clear()
      this.rejectAll(
        new AppError(
          'HOST_UNAVAILABLE',
          `windows-mcp 已退出（${code ?? 'unknown'}）。${this.stderr.trim().slice(-500)}`
        )
      )
    })

    await this.request(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'OpenFuture Computer Use', version: '0.1.0' }
      },
      INIT_TIMEOUT_MS
    )
    this.notify('notifications/initialized')
    const listed = await this.request('tools/list', {}, LIST_TIMEOUT_MS)
    const tools = listed && typeof listed === 'object' ? (listed as { tools?: McpTool[] }).tools : []
    const allowed = new Set<string>(ALLOWED_TOOLS)
    this.tools = (tools ?? [])
      .filter((tool) => typeof tool.name === 'string' && allowed.has(tool.name))
      .map((tool) => {
        const exposed = `${TOOL_PREFIX}${tool.name.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()}`
        this.toolByExposed.set(exposed, tool.name)
        const controlNote = GATED_TOOLS.has(tool.name)
          ? ' 若用户刚使用键鼠，工具会等待最多 15 秒空闲后重试；遇到 USER_CONTROL 不要直接放弃。'
          : ''
        return {
          name: exposed,
          label: tool.name,
          description: `Windows 桌面操作（${tool.name}）：${tool.description ?? ''}${controlNote}`.trim(),
          parameters:
            tool.inputSchema && typeof tool.inputSchema === 'object'
              ? tool.inputSchema
              : { type: 'object', properties: {}, additionalProperties: false }
        }
      })
    if (this.tools.length === 0) {
      throw new AppError('HOST_UNAVAILABLE', 'windows-mcp 没有返回允许的桌面工具')
    }
    console.log(`[computer-use] ready, tools=${this.tools.map((tool) => tool.label).join(',')}`)
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      index = this.buffer.indexOf('\n')
      if (!line) continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        console.warn(`[computer-use] non-JSON stdout: ${line.slice(0, 300)}`)
        continue
      }
      const id = message.id
      if (typeof id !== 'number' || !this.pending.has(id)) continue
      const pending = this.pending.get(id)
      if (!pending) continue
      this.pending.delete(id)
      clearTimeout(pending.timer)
      const error = message.error
      if (error && typeof error === 'object') {
        const text = (error as { message?: unknown }).message
        pending.reject(new Error(typeof text === 'string' ? text : 'MCP 调用失败'))
      } else {
        pending.resolve(message.result)
      }
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child
    if (!child) return Promise.reject(new AppError('HOST_UNAVAILABLE', 'windows-mcp 尚未启动'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AppError('PI_ERROR', `windows-mcp 调用超时（${method}）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
        )
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new AppError('HOST_UNAVAILABLE', `向 windows-mcp 发送请求失败：${toErrorMessage(error)}`))
      }
    })
  }

  private notify(method: string): void {
    try {
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
    } catch {
      // Notifications are best-effort; the next request will surface failure.
    }
  }

  private rejectAll(error: Error): void {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timer)
      pending.reject(error)
    })
    this.pending.clear()
  }
}
