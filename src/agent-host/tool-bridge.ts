import type { ParentPort } from 'electron'

/**
 * One request/response channel for every purpose-limited tool exposed by the
 * agent host. Memory and Computer Use tools share it so parallel calls cannot
 * collide on per-module request ids.
 */
interface ToolResponse {
  kind: 'tool-response'
  id: number
  ok: boolean
  value?: unknown
  error?: { code?: string; message?: string }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  cleanup?: () => void
}

const DEFAULT_TOOL_TIMEOUT_MS = 30_000
const port: ParentPort = process.parentPort

let nextId = 0
const pending = new Map<number, Pending>()

port.on('message', (event: Electron.MessageEvent) => {
  const message = event.data as ToolResponse | undefined
  if (!message || message.kind !== 'tool-response' || typeof message.id !== 'number') return
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  clearTimeout(request.timer)
  request.cleanup?.()
  if (message.ok) {
    request.resolve(message.value)
  } else {
    request.reject(new Error(message.error?.message || '工具调用失败'))
  }
})

export function requestHostTool(
  tool: string,
  params: unknown,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TOOL_TIMEOUT_MS
): Promise<unknown> {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('工具调用已取消'))
      return
    }
    const timer = setTimeout(() => {
      pending.delete(id)
      cleanup()
      reject(new Error('工具调用超时'))
    }, timeoutMs)
    const onAbort = (): void => {
      if (!pending.has(id)) return
      pending.delete(id)
      clearTimeout(timer)
      reject(new Error('工具调用已取消'))
    }
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    pending.set(id, { resolve, reject, timer, cleanup })

    try {
      port.postMessage({ kind: 'tool-request', id, tool, params })
    } catch (error) {
      pending.delete(id)
      clearTimeout(timer)
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
