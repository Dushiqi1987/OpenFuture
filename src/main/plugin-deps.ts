import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { maxSatisfying, rcompare, satisfies, valid, validRange } from 'semver'
import { isPluginPackageName, parsePluginPackageSpec } from '../shared/plugin-packages.ts'
import { AppError, toErrorMessage } from './errors.ts'
import { downloadBuffer, extractTar } from './tarball.ts'

/**
 * Minimal npm dependency installer for adapted plugins.
 *
 * Adapted plugins live in `<userData>/plugins/adapted/<id>/plugin.js`; a plain
 * `import "ssh2"` from that file resolves `<id>/node_modules/ssh2`, so this
 * downloads and unpacks packages into an isolated, flat node_modules directory.
 */

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const MAX_PACKAGES = 80
const MAX_TOTAL_BYTES = 80 * 1024 * 1024
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024
const FETCH_TIMEOUT_MS = 60_000

interface RegistryDocument {
  'dist-tags'?: Record<string, string>
  versions?: Record<string, RegistryVersion>
}

interface RegistryVersion {
  dist?: { tarball?: string }
}

export interface DependencySpec {
  name: string
  range: string
}

export interface DependencyInstallOptions {
  /** Directory that will hold `node_modules` (the adapted plugin directory). */
  dir: string
  /** Entries such as `ssh2@^1.15.0`, `ws`, `@scope/pkg@1.2.3`. */
  requires: string[]
  onProgress?: (message: string) => void
}

export interface DependencyInstallResult {
  installed: string[]
  skipped: string[]
  count: number
  bytes: number
}

/** `parseRequires` accepts the `// deps:` header format used by the adapter. */
export function parseRequires(values: string[]): DependencySpec[] {
  return values.map((value) => {
    const spec = parsePluginPackageSpec(value)
    if (!spec) throw new AppError('MARKET_INSTALL_FAILED', `无效的 npm 依赖声明：${value}`)
    return spec
  })
}

function pickVersion(document: RegistryDocument, range: string): string | null {
  const versions = Object.keys(document.versions ?? {}).filter((version) => valid(version))
  const tag = document['dist-tags']?.[range]
  if (tag && versions.includes(tag)) return tag
  if (range === 'latest') return versions.sort(rcompare).find((version) => !version.includes('-')) ?? null
  return maxSatisfying(versions, range)
}

export async function resolveNpmTarball(name: string, range: string): Promise<{ version: string; tarball: string }> {
  if (!isPluginPackageName(name)) throw new AppError('MARKET_INSTALL_FAILED', `无效的 npm 包名：${name}`)
  const document = await fetchDocument(name)
  const version = pickVersion(document, range)
  if (!version) throw new AppError('MARKET_INSTALL_FAILED', `找不到满足 ${name}@${range} 的版本`)
  const meta = document.versions?.[version]
  const tarball = meta?.dist?.tarball
  if (!tarball) throw new AppError('MARKET_INSTALL_FAILED', `依赖 ${name}@${version} 缺少下载地址`)
  return { version, tarball }
}

async function fetchDocument(name: string): Promise<RegistryDocument> {
  const registry = (process.env.OPENFUTURE_NPM_REGISTRY ?? DEFAULT_REGISTRY).replace(/\/+$/, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(`${registry}/${encodeURIComponent(name)}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    })
    if (!response.ok) throw new AppError('MARKET_INSTALL_FAILED', `依赖 ${name} 查询失败：HTTP ${response.status}`)
    return (await response.json()) as RegistryDocument
  } finally {
    clearTimeout(timer)
  }
}

/** Names present in `<dir>/node_modules`. */
export function installedDependencies(dir: string): string[] {
  const root = join(dir, 'node_modules')
  if (!existsSync(root)) return []
  const names: string[] = []
  try {
    for (const name of readdirSync(root) as string[]) {
      if (name.startsWith('.')) continue
      if (name.startsWith('@')) {
        try {
          for (const child of readdirSync(join(root, name)) as string[]) {
            names.push(`${name}/${child}`)
          }
        } catch {
          // unreadable scope
        }
        continue
      }
      names.push(name)
    }
  } catch {
    // missing directory
  }
  return names
}

interface DependencyManifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
}

function readPackage(root: string, name: string): DependencyManifest {
  return JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8')) as DependencyManifest
}

export function dependenciesReady(dir: string, requires: string[]): boolean {
  if (requires.length === 0) return true
  try {
    const lock = JSON.parse(readFileSync(join(dir, 'openfuture-deps.json'), 'utf8')) as {
      requires?: string[]
      installed?: string[]
    }
    if (!Array.isArray(lock.requires) || !Array.isArray(lock.installed) ||
        JSON.stringify([...lock.requires].sort()) !== JSON.stringify([...requires].sort())) return false
    const resolved = new Map(parseRequires(lock.installed).map(({ name, range }) => [name, range]))
    const root = join(dir, 'node_modules')
    const visited = new Set<string>()
    const check = ({ name, range }: DependencySpec): boolean => {
      if (!isPluginPackageName(name)) return false
      const version = resolved.get(name)
      if (!version || !valid(version) || (validRange(range) && !satisfies(version, range))) return false
      if (visited.has(name)) return true
      const pkg = readPackage(root, name)
      if (pkg.name !== name || pkg.version !== version) return false
      visited.add(name)
      return Object.entries(pkg.dependencies ?? {}).every(([name, range]) => check({ name, range }))
    }
    return parseRequires(requires).every(check)
  } catch {
    return false
  }
}

/**
 * Some published tarballs (e.g. ssh2@1.17.0) unpack into a single repo-named
 * directory instead of the usual `package/` root; lift the real package up so
 * Node's resolution finds `package.json` at the top.
 */
function flattenPackageDirectory(target: string): void {
  if (existsSync(join(target, 'package.json'))) return
  let entries: string[]
  try {
    entries = readdirSync(target)
  } catch {
    return
  }
  if (entries.length !== 1) return
  const inner = join(target, entries[0] as string)
  if (!existsSync(join(inner, 'package.json'))) return
  for (const name of readdirSync(inner)) {
    renameSync(join(inner, name), join(target, name))
  }
  rmSync(inner, { recursive: true, force: true })
}

/** Install `requires` plus transitive dependencies into `<dir>/node_modules`. */
export async function installDependencies(options: DependencyInstallOptions): Promise<DependencyInstallResult> {
  mkdirSync(options.dir, { recursive: true })
  const stage = mkdtempSync(join(options.dir, '.deps-'))
  try {
    const result = await stageDependencies({ ...options, dir: stage })
    if (!dependenciesReady(stage, options.requires)) {
      throw new AppError('MARKET_INSTALL_FAILED', '下载的包与依赖清单不一致')
    }
    const modules = join(options.dir, 'node_modules')
    const previous = join(stage, 'previous')
    const hadModules = existsSync(modules)
    if (hadModules) renameSync(modules, previous)
    try {
      renameSync(join(stage, 'node_modules'), modules)
      renameSync(join(stage, 'openfuture-deps.json'), join(options.dir, 'openfuture-deps.json'))
    } catch (error) {
      rmSync(modules, { recursive: true, force: true })
      if (hadModules) renameSync(previous, modules)
      throw error
    }
    options.onProgress?.(`依赖安装完成：${result.count} 个`)
    return result
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

async function stageDependencies(options: DependencyInstallOptions): Promise<DependencyInstallResult> {
  const specs = parseRequires(options.requires)
  const root = join(options.dir, 'node_modules')
  mkdirSync(root, { recursive: true })
  const resolved = new Map<string, string>()
  const skipped: string[] = []
  const queue: DependencySpec[] = [...specs]
  const installed: string[] = []
  let bytes = 0
  const progress = options.onProgress ?? (() => {})

  while (queue.length > 0) {
    const spec = queue.shift()
    if (!spec) break
    const existing = resolved.get(spec.name)
    if (existing) {
      if (!satisfies(existing, spec.range)) {
        const compatible = !validRange(spec.range) && (await resolveNpmTarball(spec.name, spec.range)).version === existing
        if (!compatible) throw new AppError('MARKET_INSTALL_FAILED', `依赖版本冲突：${spec.name}@${existing} 无法满足 ${spec.range}`)
      }
      skipped.push(spec.name)
      continue
    }
    if (resolved.size >= MAX_PACKAGES) {
      throw new AppError('MARKET_INSTALL_FAILED', `依赖数量超过上限（${MAX_PACKAGES} 个），请减少依赖后重试`)
    }
    progress(`解析依赖 ${spec.name}${spec.range === '*' ? '' : `@${spec.range}`}…`)
    const { version, tarball } = await resolveNpmTarball(spec.name, spec.range)
    resolved.set(spec.name, version)

    const target = join(root, spec.name)
    mkdirSync(target, { recursive: true })
    progress(`下载 ${spec.name}@${version}…`)
    const archive = await downloadBuffer(tarball, {
      label: `依赖 ${spec.name}`,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_PACKAGE_BYTES
    })
    bytes += archive.length
    if (bytes > MAX_TOTAL_BYTES) {
      throw new AppError('MARKET_INSTALL_FAILED', `依赖总体积超过 ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB 上限`)
    }
    extractTar(gunzipSync(archive, { maxOutputLength: 80 * 1024 * 1024 }), target)
    flattenPackageDirectory(target)
    const pkg = readPackage(root, spec.name)
    if (pkg.name !== spec.name || pkg.version !== version) {
      throw new AppError('MARKET_INSTALL_FAILED', `下载的包与 ${spec.name}@${version} 不一致`)
    }
    installed.push(`${spec.name}@${version}`)
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) queue.push({ name, range })
  }

  mkdirSync(options.dir, { recursive: true })
  writeFileSync(
    join(options.dir, 'openfuture-deps.json'),
    JSON.stringify({ installedAt: Date.now(), requires: options.requires, installed }, null, 2)
  )
  return { installed, skipped, count: installed.length, bytes }
}

export function describeDependencyError(error: unknown): string {
  return toErrorMessage(error)
}
