import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AdaptedPluginInfo, InstalledPluginInfo, MarketEntry, PluginAdaptProgress, PluginMarketState } from '../../shared/protocol'

const PHASE_LABELS: Record<PluginAdaptProgress['phase'], string> = {
  queued: '排队中',
  running: '适配中',
  done: '完成',
  failed: '失败'
}

type SortKey = 'default' | 'stars' | 'downloads' | 'name'

const SORT_LABELS: Record<SortKey, string> = {
  default: '目录顺序',
  stars: 'Star 最多',
  downloads: '下载最多',
  name: '名称 A→Z'
}

const EMPTY_ENTRIES: MarketEntry[] = []
const PAGE_SIZE = 80

function topCategory(value: string): string {
  const first = value.split('/')[0]?.trim() ?? ''
  return first || '未分类'
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  const date = new Date(value)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Sidebar > 插件市场: browse the DSH plugin catalog, install a tarball, then ask
 * the host model to rewrite it into an OpenFuture extension (`plugin.js`).
 */
export function PluginMarketPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [state, setState] = useState<PluginMarketState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [sort, setSort] = useState<SortKey>('default')
  const [page, setPage] = useState(1)
  const [preview, setPreview] = useState<{ item: AdaptedPluginInfo; code: string } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [progress, setProgress] = useState<PluginAdaptProgress | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.openfuture.pluginMarket(force)
      if (!mounted.current) return
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setState(result.value)
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  useEffect(() => {
    return window.openfuture.onAgentEvent(({ event }) => {
      if (event.type !== 'plugin') return
      setProgress(event.event)
      if (event.event.phase === 'done' || event.event.phase === 'failed') {
        void load(false)
      }
    })
  }, [load])

  const installed = useMemo(() => {
    const map = new Map<string, InstalledPluginInfo>()
    for (const item of state?.installed ?? []) {
      if (item.catalogId) map.set(item.catalogId, item)
    }
    return map
  }, [state])

  const entries = state?.entries ?? EMPTY_ENTRIES

  const categories = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of entries) {
      const label = topCategory(entry.category)
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [entries])

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    let list = entries
    if (category !== 'all') list = list.filter((entry) => topCategory(entry.category) === category)
    if (needle) {
      list = list.filter((entry) =>
        `${entry.name} ${entry.owner} ${entry.npm ?? ''} ${entry.description} ${entry.descriptionEn} ${entry.category}`.toLowerCase().includes(needle)
      )
    }
    const sorted = [...list]
    if (sort === 'stars') sorted.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0) || a.name.localeCompare(b.name))
    else if (sort === 'downloads') {
      sorted.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0) || a.name.localeCompare(b.name))
    } else if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name))
    return sorted
  }, [entries, query, category, sort])
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const visible = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const previewItem = state?.adapted.find((item) => item.id === preview?.item.id)

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [currentPage, category, query, sort])

  const run = async (id: string, task: () => Promise<void>): Promise<void> => {
    if (busyId) return
    setBusyId(id)
    setNotice(null)
    setError(null)
    try {
      await task()
    } finally {
      if (mounted.current) setBusyId(null)
    }
  }

  const install = (entry: MarketEntry): void =>
    void run(entry.id, async () => {
      const result = await window.openfuture.installPlugin(entry.id)
      if (!result.ok) {
        setNotice(`安装失败：${result.error.message}`)
        return
      }
      setState(result.value)
      setNotice(`已安装 ${entry.name}，接着点「适配」让模型改写成本项目扩展。`)
    })

  const adapt = (id: string): void =>
    void run(id, async () => {
      setProgress({ id, name: '', phase: 'queued', message: '准备适配…' })
      const result = await window.openfuture.adaptPlugin(id)
      if (!result.ok) {
        setNotice(`适配失败：${result.error.message}`)
        return
      }
      if (result.value.adapted === null) {
        setNotice(`适配失败：${result.value.error ?? '模型没有返回代码'}`)
        return
      }
      setNotice('适配完成。查看生成的代码后，可手动启用插件。')
      await load(false)
    })

  const remove = (id: string): void =>
    void run(id, async () => {
      const result = await window.openfuture.removePlugin(id)
      if (result.ok) setState(result.value)
      else setError(result.error.message)
    })

  const toggle = async (id: string, enabled: boolean): Promise<void> => {
    const result = await window.openfuture.setPluginEnabled(id, enabled)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setState(result.value)
    setPreview(null)
    setNotice(enabled ? '插件已启用，将在下次打开会话时加载。' : '插件已停用。')
  }

  const showCode = (item: AdaptedPluginInfo): void =>
    void run(item.id, async () => {
      const result = await window.openfuture.readAdaptedPlugin(item.id)
      if (result.ok) setPreview({ item, code: result.value })
      else setError(result.error.message)
    })

  const removeAdapted = (id: string): void =>
    void run(id, async () => {
      const result = await window.openfuture.removeAdaptedPlugin(id)
      if (result.ok) setState(result.value)
      else setError(result.error.message)
    })

  const installDeps = (item: AdaptedPluginInfo): void =>
    void run(item.id, async () => {
      setProgress({ id: item.id, name: item.name, phase: 'queued', message: '准备安装依赖…' })
      const result = await window.openfuture.installPluginDependencies(item.id)
      if (!result.ok) {
        setNotice(`依赖安装失败：${result.error.message}`)
        return
      }
      setState(result.value)
      setNotice('依赖已安装。')
    })

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal plugin-market-modal"
        role="dialog"
        aria-modal="true"
        aria-label="插件市场"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="plugin-market-head">
          <div>
            <span className="modal-kicker">PLUGIN MARKET</span>
            <h2>插件市场</h2>
            <p className="plugin-market-sub">
              DSH 插件原本适配 DeepSeek Harness；下载后由当前模型改写成本项目的扩展（可用命令、提示注入与
              <code> dsh_ </code>工具）。
            </p>
          </div>
          <div className="plugin-market-actions">
            <button type="button" className="ghost-button" disabled={loading} onClick={() => void load(true)}>
              {loading ? '刷新中…' : '刷新目录'}
            </button>
            <button type="button" className="ghost-button" onClick={onClose} aria-label="关闭">
              ×
            </button>
          </div>
        </div>

        {progress ? (
          <div className={`plugin-progress${progress.phase === 'failed' ? ' failed' : ''}`}>
            <span>{PHASE_LABELS[progress.phase]}</span>
            <b>{progress.name || progress.id}</b>
            <em>{progress.message ?? ''}</em>
          </div>
        ) : null}

        {error ? <div className="banner error-banner inline">{error}</div> : null}
        {state?.catalogError ? (
          <div className="banner error-banner inline">
            目录刷新失败：{state.catalogError}（已下载与已适配的插件仍可正常使用）
          </div>
        ) : null}
        {notice ? <div className="banner inline">{notice}</div> : null}

        {preview ? (
          <section className="plugin-code-review" aria-label="生成的扩展代码">
            <h3>{preview.item.name} · 生成的扩展代码</h3>
            <p>启用后，这段代码及其依赖会在本机 Agent 进程中运行，并拥有该进程的权限。</p>
            <pre tabIndex={0}>{preview.code}</pre>
            <div className="plugin-market-actions">
              <button type="button" className="ghost-button" onClick={() => setPreview(null)}>返回目录</button>
              {previewItem && !previewItem.enabled ? (
                <button
                  type="button"
                  className="primary-button"
                  disabled={busyId !== null || !previewItem.depsInstalled || previewItem.adaptedAt !== preview.item.adaptedAt}
                  onClick={() => void run(previewItem.id, () => toggle(previewItem.id, true))}
                >
                  {previewItem.depsInstalled ? '启用插件' : '请先安装依赖'}
                </button>
              ) : null}
            </div>
          </section>
        ) : (
          <>
            {loading && !state ? (
              <div className="plugin-loading">
                <span className="plugin-spinner" aria-hidden="true" />
                正在获取插件目录，首次拉取约需 20 秒…
              </div>
            ) : null}

            {state && state.adapted.length > 0 ? (
              <section className="plugin-section">
                <h3>已适配（{state.adapted.length}）</h3>
                <div className="plugin-list plugin-list-compact">
                  {state.adapted.map((item) => (
                    <div className="plugin-row" key={item.id}>
                      <div className="plugin-row-main">
                        <b>{item.name}</b>
                        <span className="plugin-row-meta">
                          {formatTime(item.adaptedAt)} · {item.note ? item.note.slice(0, 120) : '模型改写产物'}
                          {item.requires.length > 0
                            ? ` · 依赖：${item.requires.join(', ')}${item.depsInstalled ? '' : '（未安装）'}`
                            : ''}
                        </span>
                        {item.loadError ? <p className="plugin-row-desc">加载失败：{item.loadError}</p> : null}
                      </div>
                      <div className="plugin-row-actions">
                        {item.requires.length > 0 && !item.depsInstalled ? (
                          <button
                            type="button"
                            className="primary-button"
                            disabled={busyId !== null}
                            onClick={() => installDeps(item)}
                          >
                            {busyId === item.id ? '安装中…' : `安装依赖（${item.requires.length}）`}
                          </button>
                        ) : null}
                        <button type="button" className="ghost-button" disabled={busyId !== null} onClick={() => showCode(item)}>
                          {item.enabled || !item.depsInstalled ? '查看代码' : '查看代码并启用'}
                        </button>
                        {item.enabled ? (
                          <button
                            type="button"
                            className="ghost-button"
                            disabled={busyId !== null}
                            onClick={() => void run(item.id, () => toggle(item.id, false))}
                          >
                            停用
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="ghost-button"
                          disabled={busyId !== null}
                          onClick={() => removeAdapted(item.id)}
                        >
                          移除适配
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {state && state.installed.length > 0 ? (
              <section className="plugin-section">
                <h3>已下载（{state.installed.length}）</h3>
                <div className="plugin-list plugin-list-compact">
                  {state.installed.map((item) => {
                    const isAdapted = item.adapted
                    return (
                      <div className="plugin-row" key={item.id}>
                        <div className="plugin-row-main">
                          <b>{item.name}</b>
                          <span className="plugin-row-meta">
                            {item.owner ? `${item.owner} · ` : ''}
                            {item.version ? `v${item.version} · ` : ''}{formatTime(item.installedAt)}
                            {isAdapted ? ' · 已适配' : ''}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="primary-button"
                          disabled={busyId !== null || isAdapted}
                          onClick={() => adapt(item.id)}
                        >
                          {isAdapted ? '已适配' : busyId === item.id ? '适配中…' : '适配'}
                        </button>
                        <button
                          type="button"
                          className="ghost-button"
                          disabled={busyId !== null}
                          onClick={() => remove(item.id)}
                        >
                          删除
                        </button>
                      </div>
                    )
                  })}
                </div>
              </section>
            ) : null}

            <section className="plugin-section plugin-section-grow">
              <div className="plugin-market-bar">
                <h3>
                  目录（{rows.length}
                  {rows.length !== entries.length ? ` / ${entries.length}` : ''}）
                </h3>
                <div className="plugin-filters">
                  <select
                    className="plugin-select"
                    value={category}
                    aria-label="按分类筛选"
                    onChange={(event) => {
                      setCategory(event.target.value)
                      setPage(1)
                    }}
                  >
                    <option value="all">全部分类</option>
                    {categories.map(([label, count]) => (
                      <option key={label} value={label}>
                        {label}（{count}）
                      </option>
                    ))}
                  </select>
                  <select
                    className="plugin-select"
                    value={sort}
                    aria-label="排序方式"
                    onChange={(event) => {
                      setSort(event.target.value as SortKey)
                      setPage(1)
                    }}
                  >
                    {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                      <option key={key} value={key}>
                        {SORT_LABELS[key]}
                      </option>
                    ))}
                  </select>
                  <input
                    className="plugin-search"
                    value={query}
                    placeholder="搜索名称、作者或分类"
                    onChange={(event) => {
                      setQuery(event.target.value)
                      setPage(1)
                    }}
                  />
                </div>
              </div>
              {loading && !state ? <p className="plugin-empty">正在拉取插件目录…</p> : null}
              {state && rows.length === 0 ? (
                <p className="plugin-empty">{query || category !== 'all' ? '没有匹配的插件' : '目录为空，检查网络后点「刷新目录」'}</p>
              ) : null}
              {pageCount > 1 ? (
                <nav className="plugin-pagination" aria-label="目录分页">
                  <button type="button" className="ghost-button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</button>
                  <span>第 {currentPage} / {pageCount} 页</span>
                  <button type="button" className="ghost-button" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button>
                </nav>
              ) : null}
              <div className="plugin-list" ref={listRef}>
                {visible.map((entry) => {
                  const isInstalled = installed.has(entry.id)
                  const canDownload = Boolean(entry.tarball || entry.npm)
                  return (
                    <div className="plugin-row" key={entry.id}>
                      <div className="plugin-row-main">
                        <b>{entry.name}</b>
                        <span className="plugin-row-meta">
                          {entry.category || '未分类'} · {entry.owner} · ★ {entry.stars ?? 0} · ↓ {entry.downloads ?? 0}
                        </span>
                        <p className="plugin-row-desc">{entry.description || entry.descriptionEn}</p>
                      </div>
                      <button
                        type="button"
                        className={isInstalled || !canDownload ? 'ghost-button' : 'primary-button'}
                        disabled={busyId !== null || isInstalled || !canDownload}
                        onClick={() => install(entry)}
                      >
                        {isInstalled ? '已下载' : !canDownload ? '暂无可用安装包' : busyId === entry.id ? '下载中…' : '下载'}
                      </button>
                    </div>
                  )
                })}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
