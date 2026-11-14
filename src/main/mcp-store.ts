import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpConfigState, McpServerInfo, McpServerInput, McpTransport } from '../shared/protocol.ts'
import { AppError } from './errors.ts'

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const DEFAULT_TIMEOUT_SECONDS = 60

/**
 * Reads and writes the `mcp.json` that Pi's built-in MCP extension consumes.
 * The agent host points `PI_CODING_AGENT_DIR` at the same directory, so the file
 * this store edits is the one the agent reads on the next session.
 */
export class McpStore {
  readonly agentDir: string
  readonly file: string

  constructor(userDataDir: string) {
    this.agentDir = join(userDataDir, 'pi', 'agent')
    this.file = join(this.agentDir, 'mcp.json')
  }

  state(): McpConfigState {
    if (!existsSync(this.file)) return { path: this.file, servers: [], errors: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf-8'))
    } catch (error) {
      return { path: this.file, servers: [], errors: [`mcp.json 解析失败：${messageOf(error)}`] }
    }
    return this.fromDocument(parsed)
  }

  save(input: McpServerInput): McpConfigState {
    const normalized = normalizeInput(input)
    const current = this.state()
    const servers = current.servers.filter((server) => server.name !== normalized.name)
    servers.push(normalized)
    servers.sort((a, b) => a.name.localeCompare(b.name))
    this.write(servers)
    return this.state()
  }

  remove(name: string): McpConfigState {
    const current = this.state()
    const servers = current.servers.filter((server) => server.name !== name)
    if (servers.length === current.servers.length) {
      throw new AppError('VALIDATION', `没有名为 ${name} 的 MCP 服务`)
    }
    this.write(servers)
    return this.state()
  }

  setEnabled(name: string, enabled: boolean): McpConfigState {
    const current = this.state()
    const server = current.servers.find((item) => item.name === name)
    if (!server) throw new AppError('VALIDATION', `没有名为 ${name} 的 MCP 服务`)
    server.enabled = enabled
    this.write(current.servers)
    return this.state()
  }

  private fromDocument(document: unknown): McpConfigState {
    const errors: string[] = []
    const record = isRecord(document) ? document : {}
    const raw = isRecord(record.mcpServers) ? record.mcpServers : {}
    const servers: McpServerInfo[] = []
    for (const [name, value] of Object.entries(raw)) {
      if (!isRecord(value)) {
        errors.push(`${name}：配置项必须是对象`)
        continue
      }
      try {
        servers.push(normalizeServer(name, value))
      } catch (error) {
        errors.push(`${name}：${messageOf(error)}`)
      }
    }
    servers.sort((a, b) => a.name.localeCompare(b.name))
    return { path: this.file, servers, errors }
  }

  private write(servers: McpServerInfo[]): void {
    const mcpServers: Record<string, unknown> = {}
    for (const server of servers) {
      mcpServers[server.name] = toEntry(server)
    }
    mkdirSync(this.agentDir, { recursive: true })
    const body = `${JSON.stringify({ mcpServers }, null, 2)}\n`
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, body, 'utf-8')
    renameSync(temp, this.file)
  }
}

function normalizeInput(input: McpServerInput): McpServerInfo {
  const name = input.name?.trim() ?? ''
  if (!NAME_PATTERN.test(name)) {
    throw new AppError('VALIDATION', 'MCP 服务名只能包含字母、数字、点、下划线和短横线（最多 64 个字符）')
  }
  const transport: McpTransport = input.transport === 'url' ? 'url' : 'stdio'
  const server: McpServerInfo = {
    name,
    transport,
    description: optionalText(input.description, 400, '描述'),
    timeout: normalizeTimeout(input.timeout),
    enabled: input.enabled !== false
  }
  if (transport === 'url') {
    const url = optionalText(input.url, 2000, '服务地址')
    if (!url) throw new AppError('VALIDATION', 'HTTP 服务需要填写地址')
    if (!/^https?:\/\//i.test(url)) throw new AppError('VALIDATION', 'MCP 服务地址必须以 http:// 或 https:// 开头')
    server.url = url
    const headers = normalizeRecord(input.headers, '请求头')
    if (headers) server.headers = headers
    return server
  }
  const command = optionalText(input.command, 400, '启动命令')
  if (!command) throw new AppError('VALIDATION', 'stdio 服务需要填写启动命令')
  server.command = command
  const args = (input.args ?? []).map((value) => String(value).trim()).filter(Boolean).slice(0, 64)
  if (args.length > 0) server.args = args
  const env = normalizeRecord(input.env, '环境变量')
  if (env) server.env = env
  const cwd = optionalText(input.cwd, 1000, '工作目录')
  if (cwd) server.cwd = cwd
  return server
}

function normalizeServer(name: string, value: Record<string, unknown>): McpServerInfo {
  const url = typeof value.url === 'string' ? value.url : undefined
  const transport: McpTransport = url ? 'url' : 'stdio'
  const server: McpServerInfo = {
    name,
    transport,
    description: typeof value.description === 'string' ? value.description.slice(0, 400) : undefined,
    timeout: normalizeTimeout(value.timeout),
    enabled: value.enabled !== false
  }
  if (transport === 'url') {
    server.url = url
    if (isRecord(value.headers)) server.headers = stringRecord(value.headers)
    return server
  }
  if (typeof value.command === 'string') server.command = value.command
  if (Array.isArray(value.args)) server.args = value.args.map((item) => String(item)).slice(0, 64)
  if (isRecord(value.env)) server.env = stringRecord(value.env)
  if (typeof value.cwd === 'string') server.cwd = value.cwd
  return server
}

function toEntry(server: McpServerInfo): Record<string, unknown> {
  const entry: Record<string, unknown> = { enabled: server.enabled }
  // Our agent never loads Pi's codemode built-in, so tools must be declared directly.
  entry.exposure = 'direct'
  if (server.description) entry.description = server.description
  if (server.timeout) entry.timeout = server.timeout
  if (server.transport === 'url') {
    entry.url = server.url
    if (server.headers) entry.headers = server.headers
  } else {
    entry.command = server.command
    if (server.args && server.args.length > 0) entry.args = server.args
    if (server.env) entry.env = server.env
    if (server.cwd) entry.cwd = server.cwd
  }
  return entry
}

function normalizeTimeout(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_TIMEOUT_SECONDS
  return Math.min(3600, Math.max(5, Math.round(numeric)))
}

function optionalText(value: unknown, max: number, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (text.length > max) throw new AppError('VALIDATION', `${label}不能超过 ${max} 个字符`)
  return text === '' ? undefined : text
}

function normalizeRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new AppError('VALIDATION', `${label}必须是键值对`)
  const entries = Object.entries(value)
  if (entries.length > 64) throw new AppError('VALIDATION', `${label}最多 64 项`)
  const result: Record<string, string> = {}
  for (const [key, item] of entries) {
    result[key] = String(item)
  }
  return Object.keys(result).length === 0 ? undefined : result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) result[key] = String(item)
  return result
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
