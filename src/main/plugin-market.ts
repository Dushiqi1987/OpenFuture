import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import type {
  AdaptedPluginInfo,
  InstalledPluginInfo,
  MarketEntry,
  PluginMarketState
} from '../shared/protocol'
import { AppError, toErrorMessage } from './errors.ts'
import { downloadBuffer, extractTar } from './tarball.ts'
import { validateAdaptedCode } from './plugin-code.ts'
import { isPluginPackageName } from '../shared/plugin-packages.ts'
import { dependenciesReady, installDependencies as installPluginDeps, resolveNpmTarball } from './plugin-deps.ts'

/**
 * Plugin market for DSH plugins.
 *
 * DSH plugins are npm packages (or release tarballs) that declare a
 * `dsh.bundle.patch`. They run against the DSH host API, so they cannot be
 * loaded as-is: this service only knows how to list the catalog, download a
 * package and unpack it into the user data directory. Turning a package into
 * something this app can load is the job of the adaptation step, which hands
 * the sources to the model and stores the resulting extension.
 */

interface InstalledFile {
  version: 1
  plugins: Record<string, Omit<InstalledPluginInfo, 'adapted'>>
}

type InstalledRecord = InstalledFile['plugins'][string]

export interface MarketCatalog {
  fetchedAt: number
  source: string
  entries: MarketEntry[]
}

const DEFAULT_CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json'
const CATALOG_PACKAGE = 'dsh-plugin-catalog'
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000
const CATALOG_CACHE_VERSION = 2

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function pluginId(owner: string, name: string, npm: string | null, homepage: string | null): string {
  const identity = owner ? [owner, name] : [npm ?? homepage ?? '', name]
  const hash = createHash('sha256').update(JSON.stringify(identity.map((part) => part.toLowerCase()))).digest('hex')
  return `dsh-${slug(name).slice(0, 24)}-${hash.slice(0, 32)}`
}

function legacyDirName(id: string): string | null {
  const name = slug(id)
  return name && name !== '.' && name !== '..' && !name.endsWith('.') &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) ? name : null
}

function safeDownloadUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function writeJson(file: string, value: unknown, pretty = true): void {
  const staged = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(staged, `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`, 'utf8')
    renameSync(staged, file)
  } finally {
    rmSync(staged, { force: true })
  }
}

function entryDescription(raw: unknown): { zh: string; en: string } {
  if (typeof raw === 'string') return { zh: raw, en: raw }
  if (raw === null || typeof raw !== 'object') return { zh: '', en: '' }
  const record = raw as Record<string, unknown>
  const pick = (key: string): string => (typeof record[key] === 'string' ? (record[key] as string) : '')
  return { zh: pick('zh') || pick('en'), en: pick('en') || pick('zh') }
}

export class PluginMarket {
  private readonly root: string
  private readonly catalogFile: string
  private readonly installedFile: string
  private readonly adaptedRoot: string
  private catalog: MarketCatalog | null = null
  private readonly loadErrors = new Map<string, string>()
  private readonly catalogUrl: string

  constructor(userDataDir: string, options: { catalogUrl?: string } = {}) {
    this.root = join(userDataDir, 'plugins')
    this.catalogFile = join(this.root, 'catalog.json')
    this.installedFile = join(this.root, 'installed.json')
    this.adaptedRoot = join(this.root, 'adapted')
    this.catalogUrl = options.catalogUrl ?? process.env.OPENFUTURE_MARKET_CATALOG ?? DEFAULT_CATALOG_URL
    mkdirSync(this.root, { recursive: true })
  }

  /** Ensure on-disk layout exists before the first state read. */
  init(): void {
    mkdirSync(this.root, { recursive: true })
    mkdirSync(this.adaptedRoot, { recursive: true })
  }

  private readInstalled(): InstalledFile {
    try {
      const parsed = JSON.parse(readFileSync(this.installedFile, 'utf8')) as InstalledFile
      if (parsed && parsed.version === 1 && parsed.plugins && typeof parsed.plugins === 'object') return parsed
    } catch {
      // fall through to an empty inventory
    }
    return { version: 1, plugins: {} }
  }

  private writeInstalled(data: InstalledFile): void {
    mkdirSync(this.root, { recursive: true })
    writeJson(this.installedFile, data)
  }

  installedDir(id: string): string {
    return join(this.root, 'dsh', this.directoryName(id))
  }

  adaptedDir(id: string): string {
    return join(this.adaptedRoot, this.directoryName(id))
  }

  private directoryName(id: string): string {
    const name = legacyDirName(id)
    if (!name) throw new AppError('VALIDATION', '无效的插件 ID')
    return name
  }

  /**
   * Catalog from the on-disk cache when one exists, otherwise a network
   * refresh. A cached catalog is returned immediately even when it is stale:
   * the official JSON is ~15 MB and a stalled download used to keep the panel
   * on "载入中" for two minutes. Stale caches refresh in the background.
   */
  async catalog_(force = false): Promise<MarketCatalog> {
    if (!force) {
      if (this.catalog) {
        this.refreshStaleInBackground()
        return this.catalog
      }
      const cached = this.readCachedCatalog()
      if (cached) {
        this.catalog = cached
        this.refreshStaleInBackground()
        return cached
      }
    }
    return this.refreshCatalog()
  }

  private readCachedCatalog(): MarketCatalog | null {
    try {
      const cached = JSON.parse(readFileSync(this.catalogFile, 'utf8')) as MarketCatalog
      if (cached && Array.isArray(cached.entries) && typeof cached.fetchedAt === 'number') {
        if ((cached as MarketCatalog & { version?: number }).version === CATALOG_CACHE_VERSION) return cached
        return { ...this.parseCatalog(cached.entries, cached.source), fetchedAt: cached.fetchedAt }
      }
    } catch {
      // no usable cache
    }
    return null
  }

  private refreshing: Promise<MarketCatalog> | null = null

  private refreshCatalog(): Promise<MarketCatalog> {
    this.refreshing ??= this.fetchCatalog()
      .then((catalog) => {
        writeJson(this.catalogFile, { ...catalog, version: CATALOG_CACHE_VERSION }, false)
        this.catalog = catalog
        return catalog
      })
      .finally(() => {
        this.refreshing = null
      })
    return this.refreshing
  }

  private refreshStaleInBackground(): void {
    if (this.refreshing) return
    const cached = this.catalog
    if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return
    void this.refreshCatalog()
      .catch((error: unknown) => {
        console.warn(`[plugin-market] background catalog refresh failed: ${toErrorMessage(error)}`)
      })
  }

  /**
   * `OPENFUTURE_MARKET_CATALOG` may point at a local file (absolute path or a
   * `file://` URL) for offline use; network sources stay HTTP(S).
   */
  private localCatalogPath(): string | null {
    if (this.catalogUrl.startsWith('file://')) return fileURLToPath(this.catalogUrl)
    return isAbsolute(this.catalogUrl) ? this.catalogUrl : null
  }

  private async fetchCatalog(): Promise<MarketCatalog> {
    const localPath = this.localCatalogPath()
    if (localPath !== null) {
      try {
        const raw = JSON.parse(readFileSync(localPath, 'utf8')) as unknown
        return this.parseCatalog(raw, localPath)
      } catch (error) {
        throw new AppError('MARKET_UNAVAILABLE', `插件目录不可用：${toErrorMessage(error)}`)
      }
    }

    // The official JSON is 15 MB served uncompressed from GitHub Pages; on
    // flaky links it truncates around 8 MB. The npm mirror ships the same data
    // as a ~5 MB gzipped package, so prefer it for the default catalog and
    // keep the official URL as the fallback (it is also fresher).
    if (this.catalogUrl === DEFAULT_CATALOG_URL) {
      try {
        const raw = await this.fetchCatalogFromNpm()
        return this.parseCatalog(raw, `${this.registryUrl()}/${CATALOG_PACKAGE}`)
      } catch (error) {
        console.warn(`[plugin-market] npm catalog failed, falling back: ${toErrorMessage(error)}`)
      }
    }
    const raw = await this.fetchJsonUrl(this.catalogUrl, 120_000)
    return this.parseCatalog(raw, this.catalogUrl)
  }

  private registryUrl(): string {
    return (process.env.OPENFUTURE_NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '')
  }

  private async fetchJsonUrl(url: string, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
      if (!response.ok) throw new AppError('MARKET_UNAVAILABLE', `插件目录请求失败：HTTP ${response.status}`)
      return (await response.json()) as unknown
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError('MARKET_UNAVAILABLE', `插件目录不可用：${toErrorMessage(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Same catalog, fetched as the `dsh-plugin-catalog` npm package. */
  private async fetchCatalogFromNpm(): Promise<unknown> {
    const registry = this.registryUrl()
    const document = (await this.fetchJsonUrl(`${registry}/${CATALOG_PACKAGE}`, 30_000)) as {
      'dist-tags'?: { latest?: string }
      versions?: Record<string, { dist?: { tarball?: string } }>
    }
    const latest = document['dist-tags']?.latest
    const tarball = latest ? document.versions?.[latest]?.dist?.tarball : undefined
    if (typeof tarball !== 'string') {
      throw new AppError('MARKET_UNAVAILABLE', 'npm 目录包缺少 tarball')
    }
    const archive = await downloadBuffer(tarball, {
      label: '插件目录包',
      timeoutMs: 120_000,
      maxBytes: 60 * 1024 * 1024
    })
    const dir = mkdtempSync(join(tmpdir(), 'openfuture-catalog-'))
    try {
      extractTar(gunzipSync(archive, { maxOutputLength: 160 * 1024 * 1024 }), dir)
      const candidates = [join(dir, 'package', 'plugins.json'), join(dir, 'plugins.json')]
      const file = candidates.find((candidate) => existsSync(candidate))
      if (file === undefined) throw new AppError('MARKET_UNAVAILABLE', '目录包内没有 plugins.json')
      return JSON.parse(readFileSync(file, 'utf8')) as unknown
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  private parseCatalog(raw: unknown, source: string): MarketCatalog {
    const list = Array.isArray(raw) ? raw : (raw as { plugins?: unknown } | null)?.plugins
    if (!Array.isArray(list)) throw new AppError('MARKET_UNAVAILABLE', '无法识别插件目录格式')
    const entries = new Map<string, MarketEntry>()
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const name = typeof record.name === 'string' ? record.name.trim() : ''
      if (name === '') continue
      const owner = typeof record.owner === 'string' ? record.owner.trim() : ''
      const npm = typeof record.npm === 'string' && isPluginPackageName(record.npm) ? record.npm : null
      const homepage = safeDownloadUrl(record.url ?? record.homepage)
      const tarball = safeDownloadUrl(record.tarball) ??
        safeDownloadUrl((record.releaseManifest as { tarball?: unknown } | undefined)?.tarball)
      const id = pluginId(owner, name, npm, homepage)
      const description = entryDescription(typeof record.descriptionEn === 'string'
        ? { zh: record.description, en: record.descriptionEn }
        : record.description)
      const category = Array.isArray(record.category)
        ? record.category.filter((value): value is string => typeof value === 'string').join('/')
        : typeof record.category === 'string'
          ? record.category
          : ''
      const existing = entries.get(id)
      if (existing && (existing.tarball || existing.npm || (!tarball && !npm))) continue
      entries.set(id, {
        id,
        name,
        owner,
        description: description.zh.slice(0, 600),
        descriptionEn: description.en.slice(0, 600),
        category,
        npm,
        version: typeof record.version === 'string' ? record.version : null,
        stars: typeof record.stars === 'number' ? record.stars : null,
        downloads: typeof record.downloads === 'number' ? record.downloads : null,
        install: typeof record.install === 'string' ? record.install : null,
        homepage,
        tarball
      })
    }
    return { fetchedAt: Date.now(), source, entries: [...entries.values()] }
  }

  listInstalled(): InstalledPluginInfo[] {
    const data = this.readInstalled()
    return Object.values(data.plugins)
      .filter((item) => item && typeof item.id === 'string' && legacyDirName(item.id))
      .map((item: Omit<InstalledPluginInfo, 'adapted'>) => ({ ...item, adapted: this.readAdapted(item.id) !== null }))
      .sort((a, b) => b.installedAt - a.installedAt)
  }

  private findInstalled(entry: MarketEntry, data: InstalledFile): InstalledRecord | undefined {
    if (Object.hasOwn(data.plugins, entry.id)) return data.plugins[entry.id]
    if (!Object.hasOwn(data.plugins, entry.name)) return undefined
    const legacy = data.plugins[entry.name]
    if (!legacy?.sourceUrl || typeof legacy.id !== 'string' || !legacyDirName(legacy.id)) return undefined
    const npmName = entry.npm?.split('/').at(-1)
    const npmUrl = entry.npm && `https://registry.npmjs.org/${entry.npm}/-/${npmName}-${legacy.version ?? 'latest'}.tgz`
    const matchesRelease = entry.tarball !== null && safeDownloadUrl(legacy.sourceUrl) === entry.tarball
    return matchesRelease || legacy.sourceUrl === npmUrl ? legacy : undefined
  }

  private findUnambiguousInstall(entry: MarketEntry, catalog: MarketCatalog, data: InstalledFile): InstalledRecord | undefined {
    const match = this.findInstalled(entry, data)
    if (!match || match.id === entry.id) return match
    return catalog.entries.some((candidate) =>
      candidate.id !== entry.id && this.findInstalled(candidate, data)?.id === match.id) ? undefined : match
  }

  async install(id: string): Promise<InstalledPluginInfo> {
    const catalog = await this.catalog_()
    const entry = catalog.entries.find((item) => item.id === id)
    if (!entry) throw new AppError('VALIDATION', '插件不在当前目录中，请先刷新插件目录')
    const previous = this.findUnambiguousInstall(entry, catalog, this.readInstalled())
    if (previous && existsSync(join(this.installedDir(previous.id), 'package.json'))) {
      return { ...previous, adapted: this.readAdapted(previous.id) !== null }
    }
    const npm = !entry.tarball && entry.npm ? await resolveNpmTarball(entry.npm, entry.version ?? 'latest') : null
    const url = entry.tarball ?? npm?.tarball
    if (!url) throw new AppError('VALIDATION', '该插件没有可下载的 npm 包或 Release 资产')
    const dir = this.installedDir(id)
    const archive = await this.download(url)
    const data = this.readInstalled()
    const concurrent = this.findUnambiguousInstall(entry, catalog, data)
    if (concurrent && existsSync(join(this.installedDir(concurrent.id), 'package.json'))) {
      return { ...concurrent, adapted: this.readAdapted(concurrent.id) !== null }
    }
    mkdirSync(join(this.root, 'dsh'), { recursive: true })
    const staged = mkdtempSync(join(this.root, 'dsh', '.download-'))
    try {
      extractTar(gunzipSync(archive, { maxOutputLength: 160 * 1024 * 1024 }), staged)
      const manifest = JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8')) as { version?: unknown }
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error('安装包的 package.json 格式无效')
      }
      const installed: InstalledRecord = {
        id,
        name: entry.name,
        owner: entry.owner,
        version: typeof manifest.version === 'string' ? manifest.version : npm?.version ?? entry.version,
        installedAt: Date.now(),
        dir,
        sourceUrl: url
      }
      rmSync(dir, { recursive: true, force: true })
      renameSync(staged, dir)
      data.plugins[id] = installed
      try {
        this.writeInstalled(data)
      } catch (error) {
        rmSync(dir, { recursive: true, force: true })
        throw error
      }
      return { ...installed, adapted: this.readAdapted(id) !== null }
    } catch (error) {
      throw new AppError('MARKET_INSTALL_FAILED', `插件安装失败：${toErrorMessage(error)}`)
    } finally {
      rmSync(staged, { recursive: true, force: true })
    }
  }

  private download(url: string): Promise<Buffer> {
    return downloadBuffer(url, { label: '插件包', timeoutMs: 120_000, maxBytes: 40 * 1024 * 1024 })
  }

  removeInstalled(id: string): void {
    const data = this.readInstalled()
    if (!Object.hasOwn(data.plugins, id)) throw new AppError('VALIDATION', '插件尚未下载')
    const installed = this.installedDir(id)
    rmSync(installed, { recursive: true, force: true })
    delete data.plugins[id]
    this.writeInstalled(data)
  }

  /** Package sources for the adaptation prompt, bounded to avoid huge prompts. */
  readSources(id: string, maxBytes = 40_000): Array<{ path: string; text: string }> {
    const dir = this.installedDir(id)
    if (!existsSync(dir)) throw new AppError('VALIDATION', '插件尚未安装，无法适配')
    const paths: string[] = []
    const entrypoints = new Set<string>()
    const addEntry = (value: unknown): void => {
      if (typeof value === 'string') entrypoints.add(posix.normalize(value.replace(/\\/g, '/')))
      else if (value && typeof value === 'object') Object.values(value).forEach(addEntry)
    }
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
      for (const key of ['main', 'module', 'exports', 'browser']) addEntry(pkg[key])
      const dsh = pkg.dsh as { bundle?: { patch?: unknown } } | undefined
      addEntry(dsh?.bundle?.patch)
    } catch {
      // Older downloads can lack usable package metadata.
    }
    const walk = (current: string, prefix: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const name = entry.name
        const full = join(current, name)
        const rel = prefix === '' ? name : `${prefix}/${name}`
        if (name === 'node_modules' || name === '.git') continue
        if (entry.isDirectory()) walk(full, rel)
        else if (entry.isFile() && /\.(js|mjs|cjs|json|yml|yaml|md|ts|tsx|jsx|svg|css)$/i.test(name)) paths.push(rel)
      }
    }
    walk(dir, '')
    const priority = (path: string): number => {
      if (path === 'package.json') return 0
      if (entrypoints.has(path) || entrypoints.has(path.replace(/\.[^.]+$/, '')) ||
          entrypoints.has(path.replace(/\/index\.[^.]+$/, ''))) return 1
      if (/^(?:(?:src|dist|lib)\/)?index\.(?:js|mjs|cjs|ts|tsx)$/.test(path)) return 2
      if (/\.(?:js|mjs|cjs|ts|tsx|jsx)$/.test(path) && !path.endsWith('.d.ts')) return 3
      if (/\.(?:json|ya?ml)$/.test(path)) return 4
      return 5
    }
    paths.sort((left, right) => priority(left) - priority(right) || left.localeCompare(right))
    const files: Array<{ path: string; text: string }> = []
    let budget = maxBytes
    for (const path of paths) {
      if (budget <= 0) break
      const full = join(dir, path)
      if (statSync(full).size > 1_000_000) continue
      const rank = priority(path)
      const limit = rank === 0 || rank >= 4 ? 4_000 : 14_000
      const original = readFileSync(full, 'utf8')
      const text = original.slice(0, Math.min(limit, budget))
      files.push({ path, text })
      budget -= text.length
    }
    return files
  }

  readAdapted(id: string): AdaptedPluginInfo | null {
    const dir = this.adaptedDir(id)
    const record = this.readAdaptedDirectory(dir, id)
    return record?.id === id ? record : null
  }

  private readAdaptedDirectory(dir: string, fallbackId: string): AdaptedPluginInfo | null {
    const manifestPath = join(dir, 'manifest.json')
    if (!existsSync(manifestPath)) return null
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<AdaptedPluginInfo>
      const id = typeof parsed.id === 'string' ? parsed.id : fallbackId
      if (legacyDirName(id) !== basename(dir)) return null
      const file = join(dir, 'plugin.js')
      if (!existsSync(file)) return null
      const requires = Array.isArray(parsed.requires)
        ? parsed.requires.filter((item): item is string => typeof item === 'string')
        : []
      return {
        id,
        name: typeof parsed.name === 'string' ? parsed.name : id,
        file,
        enabled: parsed.enabled !== false,
        adaptedAt: typeof parsed.adaptedAt === 'number' ? parsed.adaptedAt : 0,
        note: typeof parsed.note === 'string' ? parsed.note : undefined,
        requires,
        depsInstalled: dependenciesReady(dir, requires),
        loadError: this.loadErrors.get(file)
      }
    } catch {
      return null
    }
  }

  writeAdapted(id: string, input: { name: string; code: string; note?: string }): AdaptedPluginInfo {
    let requires: string[]
    try {
      requires = validateAdaptedCode(input.code)
    } catch (error) {
      throw new AppError('VALIDATION', `模型生成的扩展无法保存：${toErrorMessage(error)}`)
    }
    const dir = this.adaptedDir(id)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'plugin.js')
    // Mark the folder as ESM so Node does not reparse plugin.js as CommonJS.
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) writeJson(pkgPath, { type: 'module' })
    const manifest: AdaptedPluginInfo = {
      id,
      name: input.name,
      file: 'plugin.js',
      enabled: false,
      adaptedAt: Date.now(),
      note: input.note,
      requires,
      depsInstalled: dependenciesReady(dir, requires)
    }
    const staged = join(dir, `.${randomUUID()}.js`)
    const previous = existsSync(file) ? readFileSync(file) : null
    try {
      writeFileSync(staged, input.code, 'utf8')
      renameSync(staged, file)
      try {
        writeJson(join(dir, 'manifest.json'), manifest)
      } catch (error) {
        if (previous === null) rmSync(file, { force: true })
        else writeFileSync(file, previous)
        throw error
      }
    } finally {
      rmSync(staged, { force: true })
    }
    this.loadErrors.delete(file)
    return { ...manifest, file }
  }

  readAdaptedCode(id: string): string {
    const record = this.readAdapted(id)
    if (!record) throw new AppError('VALIDATION', '该插件还没有适配产物')
    return readFileSync(record.file, 'utf8')
  }

  updateLoadErrors(files: string[], errors: Record<string, string>): void {
    for (const file of files) {
      const error = errors[file]
      if (error) this.loadErrors.set(file, error)
      else this.loadErrors.delete(file)
    }
  }

  /** Install the npm packages the adapted code declared; returns the fresh record. */
  async installDependencies(id: string, onProgress?: (message: string) => void): Promise<AdaptedPluginInfo> {
    const record = this.readAdapted(id)
    if (!record) throw new AppError('VALIDATION', '插件尚未适配，无法安装依赖')
    if (record.requires.length === 0) return record
    await installPluginDeps({ dir: this.adaptedDir(id), requires: record.requires, onProgress })
    const updated = this.readAdapted(id)
    if (!updated?.depsInstalled) throw new AppError('MARKET_INSTALL_FAILED', '安装后的依赖不完整')
    this.loadErrors.delete(updated.file)
    return updated
  }

  /** Files handed to the host so adapted plugins load as extensions. */
  enabledPluginFiles(): string[] {
    return this.listAdapted()
      // Skip plugins whose declared packages are missing: importing them would
      // only log a load failure, and the panel offers an install button.
      .filter((item) => item.enabled && item.depsInstalled)
      // `file` is already absolute (readAdapted resolves it against the dir).
      .map((item) => item.file)
  }

  listAdapted(): AdaptedPluginInfo[] {
    if (!existsSync(this.adaptedRoot)) return []
    return readdirSync(this.adaptedRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => this.readAdaptedDirectory(join(this.adaptedRoot, name), name))
      .filter((item): item is AdaptedPluginInfo => item !== null)
  }

  setAdaptedEnabled(id: string, enabled: boolean): AdaptedPluginInfo {
    const adapted = this.readAdapted(id)
    if (!adapted) throw new AppError('VALIDATION', '该插件还没有适配产物')
    if (enabled && !adapted.depsInstalled) throw new AppError('VALIDATION', '请先安装插件依赖')
    const manifestPath = join(this.adaptedDir(id), 'manifest.json')
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    parsed.enabled = enabled
    writeJson(manifestPath, parsed)
    this.loadErrors.delete(adapted.file)
    return { ...adapted, enabled, loadError: undefined }
  }

  removeAdapted(id: string): void {
    const adapted = this.readAdapted(id)
    if (!adapted) throw new AppError('VALIDATION', '该插件还没有适配产物')
    rmSync(this.adaptedDir(id), { recursive: true, force: true })
    this.loadErrors.delete(adapted.file)
  }

  /** Package name of the installed plugin, for display and prompts. */
  installedName(id: string): string {
    const dir = this.installedDir(id)
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
        if (typeof parsed.name === 'string') return parsed.name
      } catch {
        // ignore malformed manifests
      }
    }
    return basename(dir)
  }

  /** Everything the market panel needs in one payload. */
  state(force = false): Promise<PluginMarketState> {
    return this.catalog_(force)
      .then((catalog) => this.stateWithCatalog(catalog))
      .catch((error: unknown) => {
        // A failed refresh (offline, truncated download) must not hide the
        // plugins already on disk; the panel shows the reason inline.
        const cached = this.readCachedCatalog()
        return { ...this.stateWithCatalog(cached), catalogError: toErrorMessage(error) }
      })
  }

  private stateWithCatalog(catalog: MarketCatalog | null): PluginMarketState {
    const data = this.readInstalled()
    const installed = this.listInstalled()
    const entries = catalog?.entries ?? []
    const linkedEntries = new Map<string, MarketEntry | null>()
    for (const entry of entries) {
      const match = this.findInstalled(entry, data)
      if (!match) continue
      linkedEntries.set(match.id, linkedEntries.has(match.id) ? null : entry)
    }
    return {
      fetchedAt: catalog?.fetchedAt ?? 0,
      source: catalog?.source ?? this.catalogUrl,
      entries,
      installed: installed.map((item) => {
        const entry = linkedEntries.get(item.id)
        return {
          ...item,
          owner: item.owner || entry?.owner,
          catalogId: existsSync(join(this.installedDir(item.id), 'package.json')) ? entry?.id : undefined
        }
      }),
      adapted: this.listAdapted()
    }
  }

  getCachedEntry(id: string): MarketEntry | undefined {
    const catalog = this.catalog ?? this.readCachedCatalog()
    const entries = catalog?.entries ?? []
    const installed = this.readInstalled()
    const direct = entries.find((entry) => entry.id === id)
    if (direct) return direct
    const matches = entries.filter((entry) => this.findInstalled(entry, installed)?.id === id)
    return matches.length === 1 ? matches[0] : undefined
  }
}
