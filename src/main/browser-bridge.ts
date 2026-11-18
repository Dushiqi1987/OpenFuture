import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { webContents } from 'electron'
import type { BrowserWindow, NativeImage } from 'electron'
import type { BrowserCommand, BrowserCommandResult } from '../shared/protocol'
import { IpcChannels } from '../shared/protocol'
import { AppError } from './errors'

interface Pending {
  resolve: (value: BrowserCommandResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface BrowserReply {
  id: string
  ok: boolean
  value?: BrowserCommandResult
  error?: string
}

const DEFAULT_TIMEOUT_MS = 25_000
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/**
 * The browser lives in the renderer as a hardened `<webview>`. Agent tools run
 * in the utility process, so their commands travel host → main → renderer and
 * the reply travels back the same way. Keeping one browser (not a hidden
 * window) means the user and the model always see the same page.
 */
export class BrowserBridge {
  private pending = new Map<string, Pending>()
  private nextId = 0

  constructor(private readonly window: () => BrowserWindow | null) {}

  /** Called by the IPC layer when the renderer finishes a command. */
  settle(reply: BrowserReply): void {
    const request = this.pending.get(reply.id)
    if (!request) return
    this.pending.delete(reply.id)
    clearTimeout(request.timer)
    if (reply.ok && reply.value) {
      request.resolve(reply.value)
      return
    }
    request.reject(new AppError('BROWSER_ERROR', reply.error || '内置浏览器执行失败'))
  }

  async command(
    action: BrowserCommand['action'],
    params: Omit<BrowserCommand, 'id' | 'action'>,
    workspace: string,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<BrowserCommandResult & { screenshotPath?: string }> {
    const win = this.window()
    if (!win || win.isDestroyed()) throw new AppError('HOST_UNAVAILABLE', '主窗口不可用，无法驱动内置浏览器')

    const id = `browser-${++this.nextId}`
    const command: BrowserCommand = { id, action, ...params }
    const result = await new Promise<BrowserCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AppError('BROWSER_TIMEOUT', `内置浏览器响应超时（${action}）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        win.webContents.send(IpcChannels.browserCommand, command)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new AppError('HOST_UNAVAILABLE', `无法发送浏览器命令：${String(error)}`))
      }
    })

    if (action === 'screenshot' && typeof result.captureId === 'number') {
      const image = await captureGuest(result.captureId)
      const path = persist(workspace, image.toPNG())
      const { captureId: _captureId, ...rest } = result
      return { ...rest, screenshotPath: path }
    }
    if (!result.screenshot) return result
    // Screenshots are written into the workspace so the agent can read the file
    // back with its normal file tools; base64 never enters the tool result.
    const path = persist(workspace, Buffer.from(result.screenshot.replace(/^data:image\/png;base64,/, ''), 'base64'))
    const { screenshot: _screenshot, ...rest } = result
    return { ...rest, screenshotPath: path }
  }
}

/** `capturePage` on a freshly attached guest can throw UnknownVizError; retry. */
async function captureGuest(id: number): Promise<NativeImage> {
  const guest = webContents.fromId(id)
  if (!guest || guest.isDestroyed()) throw new AppError('BROWSER_ERROR', '浏览器页面不可用，无法截屏')
  let lastError: unknown = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await guest.capturePage()
    } catch (error) {
      lastError = error
      await sleep(400)
    }
  }
  throw new AppError(
    'BROWSER_ERROR',
    `截屏失败：${lastError instanceof Error ? lastError.message : String(lastError)}`
  )
}

function persist(workspace: string, png: Buffer): string {
  const directory = join(workspace, '.openfuture', 'browser')
  mkdirSync(directory, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(directory, `browser-${stamp}.png`)
  writeFileSync(path, png)
  return path
}
