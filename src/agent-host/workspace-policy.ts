/**
 * Workspace path policy for the read-only tools.
 *
 * Everything the model can reach through read/grep/find/ls must pass through
 * this policy first. It deliberately uses the *real* filesystem path so that
 * relative traversal, Windows device paths, alternate data streams, short
 * names, symlinks and junctions cannot be used to escape the workspace.
 */
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync
} from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const DENIED_DIR_NAMES = new Set([
  '.git',
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  'secrets',
  'credentials'
])

const DENIED_FILE_NAMES = new Set([
  '.npmrc',
  '.netrc',
  '.git-credentials',
  '.gitconfig',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'auth.json',
  'model-api-key.bin',
  'model-credential.bin'
])

const DENIED_EXTENSIONS = ['.pem', '.key', '.pfx', '.p12', '.jks', '.keystore']

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

export class AccessDeniedError extends Error {
  constructor(reason: string) {
    super(`[安全策略] 拒绝访问：${reason}`)
    this.name = 'AccessDeniedError'
  }
}

export interface ResolvedPath {
  /** Path as handed to fs (still inside the workspace). */
  absolute: string
  /** Fully canonical path (long-path prefix stripped). */
  real: string
  exists: boolean
  isDirectory: boolean
  /** Workspace-relative path with forward slashes. */
  relative: string
}

export interface ListedEntry {
  name: string
  absolute: string
  isDirectory: boolean
}

function stripLongPathPrefix(input: string): string {
  let value = input
  if (value.startsWith('\\\\?\\UNC\\')) value = `\\\\${value.slice(8)}`
  else if (value.startsWith('\\\\?\\')) value = value.slice(4)
  return value
}

function samePath(a: string, b: string): boolean {
  return stripLongPathPrefix(a).toLowerCase() === stripLongPathPrefix(b).toLowerCase()
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root.toLowerCase(), candidate.toLowerCase())
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function toPosix(input: string): string {
  return input.replace(/\\/g, '/')
}

function deny(reason: string): never {
  throw new AccessDeniedError(reason)
}

export class WorkspacePolicy {
  readonly workspace: string
  private readonly protectedRoots: string[]

  constructor(workspaceInput: string, protectedRoots: string[] = []) {
    const requested = resolve(workspaceInput)
    let canonical: string
    try {
      canonical = stripLongPathPrefix(realpathSync.native(requested))
    } catch {
      deny('工作区不可访问')
    }
    this.workspace = canonical
    this.protectedRoots = protectedRoots
      .filter((root) => typeof root === 'string' && root.trim() !== '')
      .map((root) => {
        try {
          return stripLongPathPrefix(realpathSync.native(resolve(root)))
        } catch {
          return stripLongPathPrefix(resolve(root))
        }
      })
  }

  relativePath(absolute: string): string {
    return toPosix(relative(this.workspace, absolute))
  }

  /**
   * Resolve a path that must exist. Throws AccessDeniedError for anything
   * outside the workspace, traversing a link/junction, or named like a secret.
   */
  resolveExisting(input: string): ResolvedPath {
    const absolute = this.resolveLexical(input)
    let real: string
    let stats
    try {
      real = stripLongPathPrefix(realpathSync.native(absolute))
      stats = lstatSync(absolute)
    } catch {
      deny(`路径不存在或不可访问（${this.displayPath(absolute)}）`)
    }
    try {
      stats = statSync(absolute)
    } catch {
      deny(`路径不存在或不可访问（${this.displayPath(absolute)}）`)
    }
    if (lstatSync(absolute).isSymbolicLink()) deny('不允许读取链接或 junction')
    if (!samePath(absolute, real)) deny('路径经过链接、junction 或非规范别名')
    this.assertInside(real)
    this.assertNameAllowed(this.relativePath(absolute))
    this.assertNotProtected(real)
    return {
      absolute,
      real,
      exists: true,
      isDirectory: stats.isDirectory(),
      relative: this.relativePath(absolute)
    }
  }

  /**
   * Resolve a path that may not exist yet (used by `exists`). The nearest
   * existing ancestor is canonicalised and must not be a link.
   */
  resolveMaybeMissing(input: string): ResolvedPath {
    const absolute = this.resolveLexical(input)
    if (existsSync(absolute)) return this.resolveExisting(absolute)

    const tail: string[] = []
    let cursor = absolute
    while (!existsSync(cursor)) {
      const parent = dirname(cursor)
      if (parent === cursor) deny(`路径不存在（${this.displayPath(absolute)}）`)
      tail.unshift(basename(cursor))
      cursor = parent
    }
    let ancestorReal: string
    try {
      ancestorReal = stripLongPathPrefix(realpathSync.native(cursor))
    } catch {
      deny(`路径不存在或不可访问（${this.displayPath(absolute)}）`)
    }
    if (!samePath(cursor, ancestorReal)) deny('路径经过链接、junction 或非规范别名')
    const real = join(ancestorReal, ...tail)
    this.assertInside(ancestorReal)
    this.assertInside(real)
    this.assertNameAllowed(this.relativePath(absolute))
    this.assertNotProtected(real)
    return {
      absolute,
      real,
      exists: false,
      isDirectory: false,
      relative: this.relativePath(absolute)
    }
  }

  /** Validate and read a regular file (no content is returned on denial). */
  assertReadableFile(input: string): ResolvedPath {
    const resolved = this.resolveExisting(input)
    if (resolved.isDirectory) deny(`不是文件（${resolved.relative}）`)
    try {
      accessSync(resolved.absolute, constants.R_OK)
    } catch {
      deny(`文件不可读（${resolved.relative}）`)
    }
    return resolved
  }

  exists(input: string): boolean {
    return this.resolveMaybeMissing(input).exists
  }

  stat(input: string): { isDirectory: () => boolean } {
    const resolved = this.resolveExisting(input)
    const stats = statSync(resolved.absolute)
    return { isDirectory: () => stats.isDirectory() }
  }

  /** List a directory with sensitive names and reparse points removed. */
  list(input: string): ListedEntry[] {
    const resolved = this.resolveExisting(input)
    if (!resolved.isDirectory) deny(`不是目录（${resolved.relative}）`)
    const entries: ListedEntry[] = []
    let dirents: Dirent[]
    try {
      dirents = readdirSync(resolved.absolute, { withFileTypes: true })
    } catch {
      deny(`目录不可读（${resolved.relative}）`)
    }
    for (const dirent of dirents) {
      if (this.isDeniedName(dirent.name)) continue
      if (dirent.isSymbolicLink()) continue
      const absolute = join(resolved.absolute, dirent.name)
      let isDirectory = false
      try {
        const stats = lstatSync(absolute)
        if (stats.isSymbolicLink()) continue
        isDirectory = stats.isDirectory()
      } catch {
        continue
      }
      entries.push({ name: dirent.name, absolute, isDirectory })
    }
    entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    return entries
  }

  detectImageMimeType(input: string): string | null {
    const resolved = this.resolveExisting(input)
    return IMAGE_MIME_TYPES[basename(resolved.absolute).toLowerCase()] ?? null
  }

  isDeniedName(name: string): boolean {
    const lower = name.toLowerCase()
    if (lower === '.env' || lower.startsWith('.env.')) return true
    if (DENIED_DIR_NAMES.has(lower) || DENIED_FILE_NAMES.has(lower)) return true
    return DENIED_EXTENSIONS.some((extension) => lower.endsWith(extension))
  }

  private resolveLexical(input: string): string {
    if (typeof input !== 'string' || input.trim() === '') deny('路径为空')
    if (input.includes('\0')) deny('路径包含非法字符')
    if (input.length > 32_768) deny('路径过长')
    // Reject Windows device paths before they reach fs; `resolve` can preserve
    // them, and `\\?\GLOBALROOT` is a well-known bypass.
    if (/^\\\\[?.]\\/.test(input) || input.startsWith('/??/')) deny('不允许设备路径')
    const absolute = resolve(this.workspace, input)
    if (/^\\\\[?.]\\/.test(absolute) || absolute.startsWith('/??/')) deny('不允许设备路径')
    // Alternate data streams: drive letter is allowed, any further colon is not.
    const withoutDrive = absolute.replace(/^[A-Za-z]:/, '')
    if (withoutDrive.includes(':')) deny('不允许备用数据流（ADS）路径')
    this.assertInside(absolute)
    return absolute
  }

  private assertInside(candidate: string): void {
    const normalized = stripLongPathPrefix(candidate)
    if (!isWithin(this.workspace, normalized)) {
      deny(`路径越出工作区（${this.displayPath(normalized)}）`)
    }
  }

  private assertNameAllowed(relativePath: string): void {
    if (relativePath === '' || relativePath === '.') return
    const segments = relativePath.split('/')
    for (const segment of segments) {
      if (segment === '') continue
      if (this.isDeniedName(segment)) deny(`敏感文件或目录（${segment}）`)
      // Windows silently strips trailing dots/spaces; the realpath check above
      // already catches aliases, but reject obvious forms up front.
      if (segment.endsWith('.') || segment.endsWith(' ')) deny('不允许非规范文件名')
    }
  }

  private assertNotProtected(candidate: string): void {
    for (const root of this.protectedRoots) {
      if (isWithin(root, candidate)) {
        deny('应用自己的配置、凭证或会话目录不可读')
      }
    }
  }

  private displayPath(input: string): string {
    const relativePath = this.relativePath(input)
    if (relativePath === '' || relativePath === '.') return '.'
    if (relativePath.startsWith('../') || isAbsolute(relativePath)) return basename(input)
    return relativePath
  }
}
