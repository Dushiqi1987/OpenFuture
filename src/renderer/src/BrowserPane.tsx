import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'

/* eslint-disable @typescript-eslint/no-explicit-any */
type WebviewElement = HTMLElement & {
  loadURL(url: string): Promise<void>
  getURL(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  isLoading?(): boolean
}

export interface BrowserPaneProps {
  /** Absolute file:// or http(s) URL to load. */
  url: string
  /** What the user clicked; shown before the page reports its own title. */
  label: string
  onClose: () => void
}

/**
 * Right-hand embedded browser dock. The guest is a hardened `<webview>`: main
 * strips its preload, blocks Node integration and sends `window.open` to the
 * system browser (see `web-contents-created` in src/main/index.ts).
 */
export function BrowserPane({ url, label, onClose }: BrowserPaneProps): React.JSX.Element {
  const viewRef = useRef<WebviewElement | null>(null)
  const [address, setAddress] = useState(url)
  const [title, setTitle] = useState(label)
  const [loading, setLoading] = useState(true)
  const [nav, setNav] = useState({ back: false, forward: false })
  const [error, setError] = useState<string | null>(null)

  const sync = useCallback(() => {
    const view = viewRef.current
    if (!view) return
    try {
      setNav({ back: view.canGoBack(), forward: view.canGoForward() })
      const current = view.getURL()
      if (current) setAddress(current)
    } catch {
      /* the guest may not be attached yet */
    }
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const onTitle = (event: Event) => {
      const next = (event as unknown as { title?: string }).title
      if (typeof next === 'string' && next.trim() !== '') setTitle(next.trim())
    }
    const onStop = () => {
      setLoading(false)
      sync()
    }
    const onStart = () => {
      setLoading(true)
      setError(null)
    }
    const onFail = (event: Event) => {
      const detail = event as unknown as { errorDescription?: string; validatedURL?: string }
      if (detail.errorDescription) setError(`加载失败：${detail.errorDescription}`)
    }
    view.addEventListener('page-title-updated', onTitle)
    view.addEventListener('did-start-loading', onStart)
    view.addEventListener('did-stop-loading', onStop)
    view.addEventListener('did-navigate', sync)
    view.addEventListener('did-navigate-in-page', sync)
    view.addEventListener('did-fail-load', onFail)
    return () => {
      view.removeEventListener('page-title-updated', onTitle)
      view.removeEventListener('did-start-loading', onStart)
      view.removeEventListener('did-stop-loading', onStop)
      view.removeEventListener('did-navigate', sync)
      view.removeEventListener('did-navigate-in-page', sync)
      view.removeEventListener('did-fail-load', onFail)
    }
  }, [sync])

  const go = useCallback(
    (raw: string) => {
      const target = raw.trim()
      if (target === '') return
      const view = viewRef.current
      if (!view) return
      if (/^(https?|file):/i.test(target)) {
        void view.loadURL(target)
        return
      }
      void window.openfuture
        .resolveLink(target)
        .then((result) => {
          if (result.ok && result.value.url) void view.loadURL(result.value.url)
          else setError(result.ok ? (result.value.error ?? '无法打开该地址') : result.error.message)
        })
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
    },
    []
  )

  return (
    <aside className="app-browser" aria-label="内置浏览器">
      <header className="app-browser-bar">
        <div className="app-browser-nav">
          <button
            type="button"
            className="app-browser-icon"
            title="后退"
            disabled={!nav.back}
            onClick={() => viewRef.current?.goBack()}
          >
            ←
          </button>
          <button
            type="button"
            className="app-browser-icon"
            title="前进"
            disabled={!nav.forward}
            onClick={() => viewRef.current?.goForward()}
          >
            →
          </button>
          <button
            type="button"
            className="app-browser-icon"
            title={loading ? '停止' : '刷新'}
            onClick={() => (loading ? viewRef.current?.stop() : viewRef.current?.reload())}
          >
            {loading ? '×' : '⟳'}
          </button>
        </div>
        <input
          className="app-browser-address"
          value={address}
          spellCheck={false}
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              go(address)
            }
          }}
          aria-label="地址"
        />
        <div className="app-browser-actions">
          <span className="app-browser-title" title={title}>
            {title}
          </span>
          <button
            type="button"
            className="app-browser-pill"
            title="用系统默认浏览器打开"
            onClick={() =>
              void window.openfuture.openExternalTarget(address).then((result) => {
                if (!result.ok) setError(result.error.message)
              })
            }
          >
            外部浏览器
          </button>
          <button type="button" className="app-browser-icon" title="关闭" onClick={onClose}>
            ✕
          </button>
        </div>
      </header>
      {error ? <div className="app-browser-error">{error}</div> : null}
      {createElement('webview' as any, {
        ref: (node: WebviewElement | null) => {
          viewRef.current = node
        },
        src: url,
        className: 'app-browser-view'
      })}
    </aside>
  )
}
