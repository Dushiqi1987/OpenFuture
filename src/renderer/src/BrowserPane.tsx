import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { BrowserCommand, BrowserCommandResult } from '../../shared/protocol'

/* eslint-disable @typescript-eslint/no-explicit-any */
type WebviewElement = HTMLElement & {
  loadURL(url: string): Promise<void>
  getURL(): string
  getWebContentsId(): number
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  setZoomFactor(factor: number): void
  getZoomFactor(): number
  capturePage(): Promise<{ toDataURL(): string }>
  executeJavaScript(code: string, userGesture?: boolean): Promise<any>
  isLoading?(): boolean
}

export interface BrowserPaneProps {
  /** Absolute file:// or http(s) URL to load. */
  url: string
  /** What the user clicked; shown before the page reports its own title. */
  label: string
  /** Agent command waiting to run (see BrowserBridge). */
  command: BrowserCommand | null
  onCommandDone: (id: string, ok: boolean, value?: BrowserCommandResult, error?: string) => void
  onClose: () => void
}

const LOAD_TIMEOUT_MS = 20_000
const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5]

function looksLikeUrl(value: string): boolean {
  return /^(https?|file):/i.test(value) || /^[\w.-]+\.[a-z]{2,}(\/|$|\?|#)/i.test(value)
}

function withScheme(value: string): string {
  return /^(https?|file):/i.test(value) ? value : `https://${value}`
}

/**
 * Right-hand embedded browser dock. The guest is a hardened `<webview>`: main
 * strips its preload, blocks Node integration and sends `window.open` to the
 * system browser (see `web-contents-created` in src/main/index.ts).
 *
 * The same webview is driven by the agent: commands arrive from the main
 * process, run against this page and reply with text or a screenshot, so the
 * model and the user always share one browser state.
 */
export function BrowserPane({
  url,
  label,
  command,
  onCommandDone,
  onClose
}: BrowserPaneProps): React.JSX.Element {
  const viewRef = useRef<WebviewElement | null>(null)
  const [address, setAddress] = useState(url)
  const [title, setTitle] = useState(label)
  const [loading, setLoading] = useState(true)
  const [nav, setNav] = useState({ back: false, forward: false })
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const readyRef = useRef<Promise<void> | null>(null)
  const readyResolveRef = useRef<(() => void) | null>(null)
  const commandRef = useRef(command)
  commandRef.current = command

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

  const waitReady = useCallback(async (): Promise<WebviewElement> => {
    const view = viewRef.current
    if (!view) throw new Error('浏览器尚未挂载')
    if (!readyRef.current) {
      readyRef.current = new Promise<void>((resolve) => {
        readyResolveRef.current = resolve
        setTimeout(resolve, 8_000)
      })
    }
    await readyRef.current
    return view
  }, [])

  const waitLoaded = useCallback(async (view: WebviewElement): Promise<void> => {
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        view.removeEventListener('did-stop-loading', finish)
        view.removeEventListener('did-fail-load', finish)
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, LOAD_TIMEOUT_MS)
      view.addEventListener('did-stop-loading', finish)
      view.addEventListener('did-fail-load', finish)
    })
  }, [])

  const readPage = useCallback(async (view: WebviewElement, maxChars = 8_000): Promise<BrowserCommandResult> => {
    const payload = await view.executeJavaScript(
      `(() => {
        const text = (document.body && document.body.innerText ? document.body.innerText : '')
          .replace(/\\n{3,}/g, '\\n\\n')
          .trim()
        return { url: location.href, title: document.title || location.href, text: text.slice(0, ${maxChars}) }
      })()`,
      true
    )
    return payload as BrowserCommandResult
  }, [])

  const runCommand = useCallback(
    async (next: BrowserCommand): Promise<void> => {
      const view = await waitReady()
      const reply = (ok: boolean, value?: BrowserCommandResult, message?: string): void => {
        onCommandDone(next.id, ok, value, message)
      }
      try {
        switch (next.action) {
          case 'open': {
            const target = next.url ?? ''
            if (!target) throw new Error('url 不能为空')
            setError(null)
            setLoading(true)
            const normalized = looksLikeUrl(target) ? withScheme(target) : `https://www.bing.com/search?q=${encodeURIComponent(target)}`
            setAddress(normalized)
            await view.loadURL(normalized)
            await waitLoaded(view)
            sync()
            const page = await readPage(view, 600)
            reply(true, { ...page, text: page.text?.slice(0, 600) })
            return
          }
          case 'read': {
            const page = await readPage(view, next.maxChars ?? 8_000)
            reply(true, page)
            return
          }
          case 'screenshot': {
            // Capturing a `<webview>` from the renderer throws UnknownVizError
            // on some GPU/driver combinations. Hand the guest id to main and
            // let it capture the webContents there (with retries).
            const page = await readPage(view, 400)
            reply(true, { ...page, captureId: view.getWebContentsId() })
            return
          }
          case 'click': {
            const selector = JSON.stringify(next.selector ?? '')
            const text = JSON.stringify(next.text ?? '')
            const matched = await view.executeJavaScript(
              `(() => {
                const selector = ${selector}
                const text = ${text}
                let element = null
                if (selector) element = document.querySelector(selector)
                if (!element && text) {
                  const needle = text.trim().toLowerCase()
                  const nodes = [...document.querySelectorAll('a,button,[role="button"],input,summary,li,label,div,span')]
                  element = nodes.find((node) => (node.innerText || node.value || '').trim().toLowerCase() === needle)
                    || nodes.find((node) => (node.innerText || node.value || '').trim().toLowerCase().includes(needle))
                }
                if (!element) return null
                element.scrollIntoView({ block: 'center', inline: 'nearest' })
                if (typeof element.click === 'function') element.click()
                else element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
                const label = (element.innerText || element.value || element.getAttribute('aria-label') || element.tagName)
                  .trim().slice(0, 80)
                return label || element.tagName
              })()`,
              true
            )
            if (!matched) throw new Error('没有找到可点击的元素')
            await new Promise((resolve) => setTimeout(resolve, 400))
            const page = await readPage(view, 400)
            reply(true, { ...page, matched })
            return
          }
          case 'type': {
            const selector = JSON.stringify(next.selector ?? '')
            const value = JSON.stringify(next.text ?? '')
            const submit = next.submit === true
            const matched = await view.executeJavaScript(
              `(() => {
                const selector = ${selector}
                const value = ${value}
                const submit = ${submit}
                const isEditable = (node) => node && (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT' || node.isContentEditable)
                let element = selector ? document.querySelector(selector) : document.activeElement
                if (!isEditable(element)) element = document.querySelector('textarea, input[type="text"], input[type="search"], input:not([type]), [contenteditable="true"]')
                if (!element) return null
                element.focus()
                if (element.isContentEditable) {
                  element.textContent = value
                } else {
                  const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
                  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
                  setter.call(element, value)
                }
                element.dispatchEvent(new Event('input', { bubbles: true }))
                element.dispatchEvent(new Event('change', { bubbles: true }))
                if (submit) {
                  element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
                  element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }))
                  if (element.form && typeof element.form.requestSubmit === 'function') element.form.requestSubmit()
                }
                return element.tagName + (element.name ? '[' + element.name + ']' : '')
              })()`,
              true
            )
            if (!matched) throw new Error('没有找到可输入的输入框')
            await new Promise((resolve) => setTimeout(resolve, 400))
            const page = await readPage(view, 400)
            reply(true, { ...page, matched })
            return
          }
          case 'press': {
            const key = JSON.stringify(next.key ?? 'Enter')
            await view.executeJavaScript(
              `(() => {
                const key = ${key}
                const target = document.activeElement || document.body
                target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true }))
                target.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true }))
                return true
              })()`,
              true
            )
            await new Promise((resolve) => setTimeout(resolve, 300))
            reply(true, await readPage(view, 400))
            return
          }
          case 'scroll': {
            await view.executeJavaScript(
              `window.scrollBy({ top: ${Number(next.deltaY ?? 600)}, behavior: 'smooth' }); true`,
              true
            )
            await new Promise((resolve) => setTimeout(resolve, 350))
            reply(true, await readPage(view, 400))
            return
          }
          case 'back':
          case 'forward': {
            if (next.action === 'back') view.goBack()
            else view.goForward()
            await waitLoaded(view)
            sync()
            reply(true, await readPage(view, 400))
            return
          }
          case 'reload': {
            view.reload()
            await waitLoaded(view)
            sync()
            reply(true, await readPage(view, 400))
            return
          }
          case 'state': {
            reply(true, await readPage(view, 200))
            return
          }
          default:
            throw new Error(`未知的浏览器动作：${next.action}`)
        }
      } catch (cause) {
        reply(false, undefined, cause instanceof Error ? cause.message : String(cause))
      }
    },
    [onCommandDone, readPage, sync, waitLoaded, waitReady]
  )

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
    const onReady = () => {
      readyResolveRef.current?.()
      sync()
    }
    view.addEventListener('page-title-updated', onTitle)
    view.addEventListener('did-start-loading', onStart)
    view.addEventListener('did-stop-loading', onStop)
    view.addEventListener('did-navigate', sync)
    view.addEventListener('did-navigate-in-page', sync)
    view.addEventListener('did-fail-load', onFail)
    view.addEventListener('dom-ready', onReady)
    return () => {
      view.removeEventListener('page-title-updated', onTitle)
      view.removeEventListener('did-start-loading', onStart)
      view.removeEventListener('did-stop-loading', onStop)
      view.removeEventListener('did-navigate', sync)
      view.removeEventListener('did-navigate-in-page', sync)
      view.removeEventListener('did-fail-load', onFail)
      view.removeEventListener('dom-ready', onReady)
    }
  }, [sync])

  useEffect(() => {
    if (!command) return
    void runCommand(command)
  }, [command, runCommand])

  const go = useCallback(
    (raw: string) => {
      const target = raw.trim()
      if (target === '') return
      const view = viewRef.current
      if (!view) return
      if (looksLikeUrl(target)) {
        setError(null)
        void view.loadURL(withScheme(target))
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

  const applyZoom = useCallback((next: number) => {
    const view = viewRef.current
    if (!view) return
    const clamped = Math.min(1.5, Math.max(0.8, next))
    setZoom(clamped)
    try {
      view.setZoomFactor(clamped)
    } catch {
      /* guest not attached */
    }
  }, [])

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
          <button
            type="button"
            className="app-browser-icon"
            title="缩小"
            onClick={() => applyZoom(ZOOM_STEPS[Math.max(0, ZOOM_STEPS.indexOf(zoom) - 1)] ?? 0.8)}
          >
            −
          </button>
          <button
            type="button"
            className="app-browser-zoom"
            title="重置缩放"
            onClick={() => applyZoom(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className="app-browser-icon"
            title="放大"
            onClick={() => applyZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, ZOOM_STEPS.indexOf(zoom) + 1)] ?? 1.5)}
          >
            ＋
          </button>
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
      {loading ? <div className="app-browser-progress" aria-hidden /> : null}
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
