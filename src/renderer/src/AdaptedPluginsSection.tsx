import { useCallback, useEffect, useState } from 'react'
import type { AdaptedPluginInfo } from '../../shared/protocol'

interface AdaptedPluginsSectionProps {
  onOpenMarket: () => void
}

const EMPTY: AdaptedPluginInfo[] = []

function formatDate(value: number): string {
  const date = new Date(value)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes()
  ).padStart(2, '0')}`
}

/** Adapted DSH plugins, shown inside the sidebar "插件" panel. */
export function AdaptedPluginsSection({ onOpenMarket }: AdaptedPluginsSectionProps) {
  const [plugins, setPlugins] = useState<AdaptedPluginInfo[]>(EMPTY)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const result = await window.openfuture.pluginMarket(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setError(null)
    setPlugins(result.value.adapted)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = async (item: AdaptedPluginInfo): Promise<void> => {
    setBusyId(item.id)
    setNotice(null)
    try {
      const result = await window.openfuture.setPluginEnabled(item.id, !item.enabled)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setPlugins(result.value.adapted)
      setError(null)
      setNotice(`已${item.enabled ? '停用' : '启用'}「${item.name}」，将在下次打开会话时生效。`)
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (item: AdaptedPluginInfo): Promise<void> => {
    setBusyId(item.id)
    setNotice(null)
    try {
      const result = await window.openfuture.removeAdaptedPlugin(item.id)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setPlugins(result.value.adapted)
      setError(null)
      setNotice(`已移除「${item.name}」的适配产物（下载的插件仍保留）。`)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="dsh-adapted-plugins">
      <header className="dsh-adapted-head">
        <div>
          <b>已适配插件{plugins.length > 0 ? `（${plugins.length}）` : ''}</b>
          <p>从插件市场下载并由模型改写过的扩展。启用后重启 Agent，模型在对话里就能调用它们注册的 `dsh_` 工具。</p>
        </div>
        <button type="button" className="ghost-button" onClick={onOpenMarket}>
          打开插件市场
        </button>
      </header>

      {error ? <div className="banner error-banner inline">{error}</div> : null}
      {notice ? <div className="banner inline">{notice}</div> : null}

      {plugins.length === 0 ? (
        <p className="dsh-adapted-empty">还没有适配过的插件。到「插件市场」下载一个 DSH 插件，点「适配」后就会出现在这里。</p>
      ) : (
        <div className="dsh-adapted-list">
          {plugins.map((item) => {
            const depsMissing = item.requires.length > 0 && !item.depsInstalled
            return (
              <article key={item.id} className={`dsh-adapted-card${item.enabled ? ' on' : ''}`}>
                <div className="dsh-adapted-main">
                  <b>{item.name}</b>
                  <span className={`dsh-plugin-state${item.enabled && !item.loadError && !depsMissing ? ' on' : ''}`}>
                    {item.loadError ? '加载失败' : depsMissing ? '等待依赖' : item.enabled ? '已启用' : '已停用'}
                  </span>
                  <span className="dsh-adapted-date">{formatDate(item.adaptedAt)}</span>
                  {item.note ? <p className="dsh-adapted-note">{item.note.slice(0, 240)}</p> : null}
                  {item.loadError ? <p className="dsh-adapted-note">{item.loadError}</p> : null}
                  <p className="dsh-adapted-meta">
                    {depsMissing
                      ? `依赖未安装：${item.requires.join(', ')}（到插件市场点「安装依赖」）`
                      : item.requires.length > 0
                        ? `依赖：${item.requires.join(', ')}`
                        : '无额外依赖'}
                  </p>
                </div>
                <div className="dsh-adapted-actions">
                  <button
                    type="button"
                    disabled={busyId === item.id}
                    onClick={() => item.enabled ? void toggle(item) : onOpenMarket()}
                  >
                    {item.enabled ? '停用' : '查看代码并启用'}
                  </button>
                  <button type="button" className="danger" disabled={busyId === item.id} onClick={() => void remove(item)}>
                    移除
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
