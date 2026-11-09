/**
 * P0.1 A1: read-only tools confined to the workspace.
 *
 * Pi's built-in read/ls accept operation overrides; find accepts a custom
 * glob(); grep always spawns ripgrep, so we keep its public definition
 * (schema, prompt text, renderers) and replace only execute().
 */
import { readFile as fsReadFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename, relative } from 'node:path'
import { Worker } from 'node:worker_threads'
import type * as Pi from '@earendil-works/pi-coding-agent'
import type {
  FindOperations,
  LsOperations,
  ReadOperations,
  ToolDefinition
} from '@earendil-works/pi-coding-agent'
import { AccessDeniedError, WorkspacePolicy } from './workspace-policy'

/**
 * Runtime factories are passed in from the agent host, where the ESM-only Pi
 * package is loaded with a dynamic import(). A static value import here would
 * be compiled into a require() in the CJS utilityProcess bundle and fail.
 */
export type PiToolFactories = Pick<
  typeof Pi,
  | 'createReadToolDefinition'
  | 'createLsToolDefinition'
  | 'createFindToolDefinition'
  | 'createGrepToolDefinition'
>

const READ_ONLY_TOOL_NAMES = ['read', 'grep', 'find', 'ls'] as const
const GREP_DEFAULT_LIMIT = 100
const GREP_MAX_LINE_LENGTH = 2000
const GREP_MAX_OUTPUT_BYTES = 50 * 1024
const MAX_SCANNED_FILE_BYTES = 4 * 1024 * 1024
const WALK_FILE_LIMIT = 20_000
const WALK_DIR_LIMIT = 5_000
const GREP_WORKER_TIMEOUT_MS = 1500

const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

export interface WorkspaceToolset {
  policy: WorkspacePolicy
  tools: Array<ToolDefinition<any, any, any>>
}

export function createWorkspaceToolset(
  pi: PiToolFactories,
  workspace: string,
  protectedRoots: string[] = []
): WorkspaceToolset {
  const policy = new WorkspacePolicy(workspace, protectedRoots)

  const readOperations: ReadOperations = {
    async access(absolutePath) {
      policy.assertReadableFile(absolutePath)
    },
    async readFile(absolutePath) {
      const resolved = policy.assertReadableFile(absolutePath)
      return fsReadFile(resolved.real)
    },
    async detectImageMimeType(absolutePath) {
      const resolved = policy.resolveExisting(absolutePath)
      return IMAGE_EXTENSIONS[basename(resolved.absolute).toLowerCase()] ?? null
    }
  }

  const lsOperations: LsOperations = {
    exists(absolutePath) {
      return policy.exists(absolutePath)
    },
    stat(absolutePath) {
      return policy.stat(absolutePath)
    },
    async readdir(absolutePath) {
      return policy.list(absolutePath).map((entry) => entry.name)
    }
  }

  const findOperations: FindOperations = {
    exists(absolutePath) {
      return policy.exists(absolutePath)
    },
    glob(pattern, searchPath, options) {
      return secureFind(policy, pattern, searchPath, options?.limit)
    }
  }

  const read = pi.createReadToolDefinition(workspace, { operations: readOperations })
  const ls = pi.createLsToolDefinition(workspace, { operations: lsOperations })
  const find = pi.createFindToolDefinition(workspace, { operations: findOperations })
  const grep = secureGrepDefinition(pi, workspace, policy)

  return { policy, tools: [read, grep, find, ls] }
}

export function isReadOnlyToolName(name: string): boolean {
  return (READ_ONLY_TOOL_NAMES as readonly string[]).includes(name)
}

export { AccessDeniedError }

function secureGrepDefinition(
  pi: PiToolFactories,
  workspace: string,
  policy: WorkspacePolicy
): ToolDefinition<any, any, any> {
  const base = pi.createGrepToolDefinition(workspace)
  return {
    ...base,
    async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
      return {
        content: [{ type: 'text' as const, text: await secureGrepText(policy, params, signal) }],
        details: undefined
      }
    }
  } as unknown as ToolDefinition<any, any, any>
}

async function secureGrepText(
  policy: WorkspacePolicy,
  params: any,
  signal?: AbortSignal
): Promise<string> {
  if (!params || typeof params.pattern !== 'string') {
    throw new AccessDeniedError('grep 缺少 pattern')
  }
  const pattern: string = params.pattern
  if (pattern.length === 0) throw new AccessDeniedError('grep pattern 为空')
  if (pattern.length > 4000) throw new AccessDeniedError('grep pattern 过长')
  const literal: boolean = params.literal === true
  const ignoreCase: boolean = params.ignoreCase === true
  const context: number = clampInteger(params.context, 0, 0, 20)
  const limit: number = clampInteger(params.limit, GREP_DEFAULT_LIMIT, 1, 2000)
  const glob: string | undefined = typeof params.glob === 'string' ? params.glob : undefined
  const searchPath: string = typeof params.path === 'string' ? params.path : '.'

  const root = policy.resolveExisting(searchPath)
  const files = collectFiles(policy, root.absolute, root.isDirectory).filter(
    (file) => !glob || matchesGlob(file.display, glob)
  )

  if (!literal) {
    const result = await runRegexGrepWorker(files, pattern, ignoreCase, limit, context, signal)
    if (result.timeout) {
      return `grep 正则匹配超时（${GREP_WORKER_TIMEOUT_MS}ms），已中止本次搜索。请简化正则表达式或缩小搜索范围。`
    }
    if (result.invalid) throw new AccessDeniedError('grep 正则表达式无效')
    if (result.error === 'grep 已取消') throw new AccessDeniedError('grep 已取消')
    if (result.error) throw new AccessDeniedError(`grep 执行失败：${result.error}`)
    if (result.matches === 0) return 'No matches found'
    const rows = result.rows ?? []
    if (result.limitReached) {
      rows.push('', `[${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern]`)
    } else if ((result.bytes ?? 0) >= GREP_MAX_OUTPUT_BYTES) {
      rows.push('', '[50KB limit reached. Refine the pattern or path]')
    }
    return rows.join('\n')
  }

  const needle = ignoreCase ? pattern.toLowerCase() : pattern
  const output: string[] = []
  let matchCount = 0
  let bytes = 0
  let limitReached = false

  for (const file of files) {
    if (signal?.aborted) throw new AccessDeniedError('grep 已取消')
    let buffer: Buffer
    try {
      buffer = readFileSync(policy.assertReadableFile(file.absolute).real)
    } catch {
      continue
    }
    if (buffer.length === 0 || buffer.length > MAX_SCANNED_FILE_BYTES) continue
    if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) continue
    const lines = buffer.toString('utf8').replace(/\r\n/g, '\n').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const haystack = ignoreCase ? line.toLowerCase() : line
      if (!haystack.includes(needle)) continue
      matchCount += 1
      const block = formatMatchBlock(file.display, lines, index, context)
      for (const row of block) {
        output.push(row)
        bytes += Buffer.byteLength(row, 'utf8') + 1
      }
      if (matchCount >= limit) {
        limitReached = true
        break
      }
      if (bytes >= GREP_MAX_OUTPUT_BYTES) break
    }
    if (limitReached || bytes >= GREP_MAX_OUTPUT_BYTES) break
  }

  if (matchCount === 0) return 'No matches found'
  if (limitReached) {
    output.push('', `[${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern]`)
  } else if (bytes >= GREP_MAX_OUTPUT_BYTES) {
    output.push('', '[50KB limit reached. Refine the pattern or path]')
  }
  return output.join('\n')
}

interface RegexGrepWorkerResult {
  timeout?: boolean
  invalid?: boolean
  error?: string
  matches?: number
  bytes?: number
  limitReached?: boolean
  rows?: string[]
}

const GREP_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const data = workerData;
(() => {
let regex;
try {
  regex = new RegExp(data.pattern, data.ignoreCase ? 'i' : '');
} catch (error) {
  parentPort.postMessage({ invalid: true });
  return;
}
const rows = [];
let matches = 0;
let bytes = 0;
let limitReached = false;
for (const file of data.files) {
  let buffer;
  try {
    buffer = fs.readFileSync(file.absolute);
  } catch (error) {
    continue;
  }
  if (buffer.length === 0 || buffer.length > data.maxFileBytes) continue;
  if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) continue;
  const lines = buffer.toString('utf8').replace(/\r\n/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    regex.lastIndex = 0;
    if (!regex.test(lines[index])) continue;
    matches += 1;
    const matchLine = index + 1;
    const start = Math.max(1, matchLine - data.context);
    const end = Math.min(lines.length, matchLine + data.context);
    for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
      let text = lines[lineNumber - 1] || '';
      if (text.length > data.maxLineLength) text = text.slice(0, data.maxLineLength) + '\u2026';
      const row = lineNumber === matchLine
        ? file.display + ':' + lineNumber + ': ' + text
        : file.display + '-' + lineNumber + '- ' + text;
      rows.push(row);
      bytes += Buffer.byteLength(row, 'utf8') + 1;
    }
    if (matches >= data.limit) {
      limitReached = true;
      break;
    }
    if (bytes >= data.maxOutputBytes) break;
  }
  if (limitReached || bytes >= data.maxOutputBytes) break;
}
parentPort.postMessage({ matches, bytes, limitReached, rows });
})();
`

function runRegexGrepWorker(
  files: Array<{ absolute: string; display: string }>,
  pattern: string,
  ignoreCase: boolean,
  limit: number,
  context: number,
  signal?: AbortSignal
): Promise<RegexGrepWorkerResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ error: 'grep 已取消' })
      return
    }
    const worker = new Worker(GREP_WORKER_SOURCE, {
      eval: true,
      workerData: {
        files,
        pattern,
        ignoreCase,
        limit,
        context,
        maxFileBytes: MAX_SCANNED_FILE_BYTES,
        maxLineLength: GREP_MAX_LINE_LENGTH,
        maxOutputBytes: GREP_MAX_OUTPUT_BYTES
      }
    })
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (result: RegexGrepWorkerResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      void worker.terminate()
      resolve(result)
    }
    const onAbort = (): void => finish({ error: 'grep 已取消' })
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish({ timeout: true }), GREP_WORKER_TIMEOUT_MS)
    worker.once('message', (message: RegexGrepWorkerResult) => finish(message))
    worker.once('error', (error) => finish({ error: error.message }))
    worker.once('exit', (code) => {
      if (!settled) finish({ error: `worker exited with code ${code}` })
    })
  })
}

function formatMatchBlock(
  displayPath: string,
  lines: string[],
  zeroBasedIndex: number,
  context: number
): string[] {
  const matchLine = zeroBasedIndex + 1
  const start = Math.max(1, matchLine - context)
  const end = Math.min(lines.length, matchLine + context)
  const rows: string[] = []
  for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
    const text = truncateLine(lines[lineNumber - 1] ?? '')
    rows.push(
      lineNumber === matchLine
        ? `${displayPath}:${lineNumber}: ${text}`
        : `${displayPath}-${lineNumber}- ${text}`
    )
  }
  return rows
}

function truncateLine(line: string): string {
  return line.length > GREP_MAX_LINE_LENGTH ? `${line.slice(0, GREP_MAX_LINE_LENGTH)}…` : line
}

function secureFind(
  policy: WorkspacePolicy,
  pattern: string,
  searchPath: string,
  limit: number | undefined
): string[] {
  if (typeof pattern !== 'string' || pattern.trim() === '') {
    throw new AccessDeniedError('find 缺少 pattern')
  }
  if (pattern.includes('\0') || pattern.length > 2000) {
    throw new AccessDeniedError('find pattern 非法')
  }
  const root = policy.resolveExisting(searchPath)
  const effectiveLimit = clampInteger(limit, 1000, 1, 5000)
  const regex = globToRegExp(pattern)
  const matches: string[] = []
  const stack: string[] = [root.absolute]
  let visitedDirs = 0

  while (stack.length > 0 && matches.length < effectiveLimit && visitedDirs < WALK_DIR_LIMIT) {
    const current = stack.pop()
    if (!current) break
    visitedDirs += 1
    let entries: Array<{ name: string; absolute: string; isDirectory: boolean }>
    try {
      entries = policy.list(current)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.pnpm-store') continue
      const relativePath = toPosix(relative(root.absolute, entry.absolute))
      const target = relativePath === '' ? entry.name : relativePath
      const candidate = pattern.includes('/') ? target : entry.name
      if (regex.test(candidate)) {
        matches.push(entry.absolute)
        if (matches.length >= effectiveLimit) break
      }
      if (entry.isDirectory) stack.push(entry.absolute)
    }
  }
  return matches
}

function collectFiles(
  policy: WorkspacePolicy,
  rootAbsolute: string,
  rootIsDirectory: boolean
): Array<{ absolute: string; display: string }> {
  const result: Array<{ absolute: string; display: string }> = []
  if (!rootIsDirectory) {
    return [{ absolute: rootAbsolute, display: basename(rootAbsolute) }]
  }
  const stack: string[] = [rootAbsolute]
  let visitedDirs = 0
  while (stack.length > 0 && result.length < WALK_FILE_LIMIT && visitedDirs < WALK_DIR_LIMIT) {
    const current = stack.pop()
    if (!current) break
    visitedDirs += 1
    let entries: Array<{ name: string; absolute: string; isDirectory: boolean }>
    try {
      entries = policy.list(current)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.pnpm-store') continue
      if (entry.isDirectory) stack.push(entry.absolute)
      else result.push({ absolute: entry.absolute, display: toPosix(relative(rootAbsolute, entry.absolute)) })
    }
  }
  return result
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function toPosix(input: string): string {
  return input.replace(/\\/g, '/')
}

function matchesGlob(pathValue: string, pattern: string): boolean {
  const normalized = toPosix(pattern.replace(/^\.\//, ''))
  const regex = globToRegExp(normalized)
  return regex.test(normalized.includes('/') ? toPosix(pathValue) : basename(pathValue))
}

function globToRegExp(pattern: string): RegExp {
  const normalized = toPosix(pattern)
  let source = '^'
  let index = 0
  while (index < normalized.length) {
    const char = normalized[index] ?? ''
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index += 2
        if (normalized[index] === '/') {
          source += '(?:.*/)?'
          index += 1
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
        index += 1
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      index += 1
      continue
    }
    if (char === '{') {
      const end = normalized.indexOf('}', index + 1)
      if (end > index) {
        const options = normalized
          .slice(index + 1, end)
          .split(',')
          .map((option) => escapeRegExp(option).replace(/\\\*/g, '[^/]*'))
        source += `(?:${options.join('|')})`
        index = end + 1
        continue
      }
    }
    if (char === '[') {
      const end = normalized.indexOf(']', index + 1)
      if (end > index) {
        source += normalized.slice(index, end + 1)
        index = end + 1
        continue
      }
    }
    source += escapeRegExp(char)
    index += 1
  }
  source += '$'
  try {
    return new RegExp(source)
  } catch {
    throw new AccessDeniedError('find glob 模式无效')
  }
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

