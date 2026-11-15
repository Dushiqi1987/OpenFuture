import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { ComputerToolInfo, ComputerToolResult } from '../shared/protocol'
import { AppError, toErrorMessage } from './errors.ts'
import { downloadBuffer } from './tarball.ts'
import { extractTar } from './tarball.ts'

/**
 * Agent Desktop (vercel-labs/agent-desktop) is a native CLI that exposes the
 * Windows accessibility tree as JSON with `@snapshot:ref` handles. Compared to
 * the screenshot based windows-mcp bridge this is cheap and deterministic:
 * snapshot -> act on a ref -> snapshot again. The binary is downloaded on
 * demand into `<userData>/tools/agent-desktop`.
 */

const AGENT_DESKTOP_VERSION = '1.3.1'
const AGENT_DESKTOP_REPO = 'vercel-labs/agent-desktop'
const RUN_TIMEOUT_MS = 45_000
const TEXT_LIMIT = 20_000

const PLATFORM_TARGETS: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu'
}

interface Envelope<T> {
  ok?: boolean
  command?: string
  data?: T
  error?: { code?: string; message?: string; details?: unknown }
}

function truncate(text: string, limit = TEXT_LIMIT): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字符）`
}

export class AgentDesktopBridge {
  private readonly root: string

  constructor(userDataDir: string) {
    this.root = join(userDataDir, 'tools', 'agent-desktop')
  }

  binaryPath(): string {
    return join(this.root, process.platform === 'win32' ? 'agent-desktop.exe' : 'agent-desktop')
  }

  installed(): boolean {
    return existsSync(this.binaryPath())
  }

  versionFile(): string {
    return join(this.root, 'version.txt')
  }

  installedVersion(): string | null {
    try {
      return readFileSync(this.versionFile(), 'utf8').trim() || null
    } catch {
      return null
    }
  }

  async install(onProgress?: (message: string) => void): Promise<{ version: string; path: string }> {
    if (this.installed() && this.installedVersion() === AGENT_DESKTOP_VERSION) {
      return { version: AGENT_DESKTOP_VERSION, path: this.binaryPath() }
    }
    const target = PLATFORM_TARGETS[`${process.platform}-${process.arch}`]
    if (!target) throw new AppError('HOST_UNAVAILABLE', `Agent Desktop 暂不支持 ${process.platform}-${process.arch}`)

    onProgress?.(`下载 Agent Desktop ${AGENT_DESKTOP_VERSION}…`)
    const url = `https://github.com/${AGENT_DESKTOP_REPO}/releases/download/v${AGENT_DESKTOP_VERSION}/agent-desktop-v${AGENT_DESKTOP_VERSION}-${target}.tar.gz`
    const archive = await downloadBuffer(url, { label: 'Agent Desktop', timeoutMs: 120_000, maxBytes: 60 * 1024 * 1024 })
    onProgress?.('解压…')
    mkdirSync(this.root, { recursive: true })
    const staging = mkdtempSync(join(tmpdir(), 'openfuture-agent-desktop-'))
    try {
      extractTar(gunzipSync(archive), staging)
      const binary = join(staging, process.platform === 'win32' ? 'agent-desktop.exe' : 'agent-desktop')
      if (!existsSync(binary)) throw new AppError('HOST_UNAVAILABLE', 'Agent Desktop 压缩包里没有可执行文件')
      writeFileSync(this.binaryPath(), readFileSync(binary))
      writeFileSync(this.versionFile(), `${AGENT_DESKTOP_VERSION}\n`)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
    onProgress?.('验证…')
    const status = await this.run<{ version?: string }>(['status'])
    if (!status) throw new AppError('HOST_UNAVAILABLE', 'Agent Desktop 安装后无法运行')
    return { version: AGENT_DESKTOP_VERSION, path: this.binaryPath() }
  }

  private run<T>(args: string[], input?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.installed()) {
        reject(new AppError('HOST_UNAVAILABLE', 'Agent Desktop 尚未安装，请先在设置里点「安装 Agent Desktop」'))
        return
      }
      const child = spawn(this.binaryPath(), args, {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new AppError('PI_ERROR', `Agent Desktop 调用超时（${args[0] ?? ''}）`))
      }, RUN_TIMEOUT_MS)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-4_000)
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new AppError('HOST_UNAVAILABLE', `无法启动 Agent Desktop：${toErrorMessage(error)}`))
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        const line = stdout.trim().split(/\r?\n/).pop() ?? ''
        if (!line) {
          reject(new AppError('PI_ERROR', `Agent Desktop 没有输出（退出码 ${code}）：${stderr.slice(-500)}`))
          return
        }
        let envelope: Envelope<T>
        try {
          envelope = JSON.parse(line) as Envelope<T>
        } catch {
          reject(new AppError('PI_ERROR', `Agent Desktop 输出无法解析：${line.slice(0, 300)}`))
          return
        }
        if (envelope.ok === false) {
          const message = envelope.error?.message ?? '未知错误'
          const detail = envelope.error?.details ? ` ${JSON.stringify(envelope.error.details).slice(0, 500)}` : ''
          reject(new AppError('PI_ERROR', `Agent Desktop ${envelope.error?.code ?? 'FAILED'}：${message}${detail}`))
          return
        }
        resolve((envelope.data ?? envelope) as T)
      })
      if (input !== undefined) {
        child.stdin.end(input)
      } else {
        child.stdin.end()
      }
    })
  }

  async status(): Promise<unknown> {
    return this.run(['status'])
  }

  private text(value: unknown): ComputerToolResult {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    return { content: [{ type: 'text', text: truncate(text) }] }
  }

  async call(tool: string, params: Record<string, unknown>): Promise<ComputerToolResult> {
    const str = (key: string): string | undefined => {
      const value = params[key]
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
    }
    const num = (key: string): number | undefined => {
      const value = params[key]
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    }
    const flag = (key: string, name: string): string[] => {
      const value = params[key]
      return value === true ? [name] : []
    }

    switch (tool) {
      case 'computer_desktop_status':
        return this.text(await this.run(['status']))
      case 'computer_desktop_apps':
        return this.text(await this.run(['list-apps', ...(str('app') ? ['--app', str('app')!] : [])]))
      case 'computer_desktop_windows':
        return this.text(await this.run(['list-windows', ...(str('app') ? ['--app', str('app')!] : [])]))
      case 'computer_desktop_snapshot': {
        const args = ['snapshot']
        if (str('app')) args.push('--app', str('app')!)
        if (str('windowId')) args.push('--window-id', str('windowId')!)
        if (str('root')) args.push('--root', str('root')!)
        if (num('maxDepth')) args.push('--max-depth', String(num('maxDepth')))
        args.push(...flag('interactive', '-i'))
        args.push(...flag('compact', '--compact'))
        args.push(...flag('skeleton', '--skeleton'))
        args.push(...flag('includeBounds', '--include-bounds'))
        return this.text(await this.run(args))
      }
      case 'computer_desktop_find': {
        const args = ['find']
        if (str('app')) args.push('--app', str('app')!)
        if (str('windowId')) args.push('--window-id', str('windowId')!)
        if (str('role')) args.push('--role', str('role')!)
        const name = str('name') ?? str('query')
        if (name) args.push('--name', name)
        return this.text(await this.run(args))
      }
      case 'computer_desktop_get': {
        const ref = str('ref')
        if (!ref) throw new AppError('VALIDATION', '需要 ref（来自 snapshot）')
        const args = ['get', ref]
        if (str('property')) args.push('--property', str('property')!)
        return this.text(await this.run(args))
      }
      case 'computer_desktop_click': {
        const ref = str('ref')
        if (!ref) throw new AppError('VALIDATION', '需要 ref（来自 snapshot）')
        return this.text(await this.run(['click', ref]))
      }
      case 'computer_desktop_type': {
        const text = typeof params.text === 'string' ? params.text : ''
        if (!text) throw new AppError('VALIDATION', '需要要输入的文本')
        const ref = str('ref')
        if (!ref) throw new AppError('VALIDATION', '需要 ref（来自 snapshot）')
        return this.text(await this.run(['type', ref, '--stdin'], text))
      }
      case 'computer_desktop_press': {
        const combo = str('combo')
        if (!combo) throw new AppError('VALIDATION', '需要按键组合，例如 return / ctrl+s / alt+f4')
        const args = ['press', combo]
        if (str('app')) args.push('--app', str('app')!)
        if (str('windowId')) args.push('--window-id', str('windowId')!)
        return this.text(await this.run(args))
      }
      case 'computer_desktop_scroll': {
        const ref = str('ref')
        if (!ref) throw new AppError('VALIDATION', '需要 ref（来自 snapshot）')
        const args = ['scroll', ref, '--direction', str('direction') ?? 'down', '--amount', String(num('amount') ?? 3)]
        return this.text(await this.run(args))
      }
      case 'computer_desktop_screenshot': {
        const target = join(tmpdir(), `openfuture-desktop-${Date.now()}.png`)
        const args = ['screenshot', target]
        if (str('app')) args.push('--app', str('app')!)
        if (str('windowId')) args.push('--window-id', str('windowId')!)
        await this.run(args)
        return this.text(`截图已保存：${target}`)
      }
      case 'computer_desktop_launch': {
        const app = str('app')
        if (!app) throw new AppError('VALIDATION', '需要应用名或可执行文件路径')
        const args = ['launch', app]
        const argsList = params.args
        if (Array.isArray(argsList)) {
          for (const item of argsList) if (typeof item === 'string') args.push('--arg', item)
        }
        return this.text(await this.run(args, undefined))
      }
      default:
        throw new AppError('VALIDATION', `未知的 Agent Desktop 工具：${tool}`)
    }
  }

  listTools(): ComputerToolInfo[] {
    const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
      type: 'object',
      properties,
      required,
      additionalProperties: false
    })
    return [
      {
        name: 'computer_desktop_status',
        label: 'Desktop status',
        description: '检查 Agent Desktop 的平台、权限与版本。',
        parameters: object({})
      },
      {
        name: 'computer_desktop_apps',
        label: 'Desktop apps',
        description: '列出正在运行、可被无障碍树访问的桌面应用。',
        parameters: object({ app: { type: 'string', description: '按应用名过滤' } })
      },
      {
        name: 'computer_desktop_windows',
        label: 'Desktop windows',
        description: '列出可见窗口；多个同名实例时用返回的 window id 指定目标。',
        parameters: object({ app: { type: 'string', description: '按应用名过滤' } })
      },
      {
        name: 'computer_desktop_snapshot',
        label: 'Desktop snapshot',
        description:
          '读取应用的无障碍树，返回可直接操作的 @snapshot:ref。先用 interactive 只取可交互元素；ref 只属于本次快照，UI 变化后需重新 snapshot。',
        parameters: object({
          app: { type: 'string', description: '应用名；省略则取前台窗口' },
          windowId: { type: 'string', description: '窗口 id（来自 list-windows），多实例时使用' },
          root: { type: 'string', description: '从快照里的某个 ref 继续下钻' },
          maxDepth: { type: 'number', description: '树深上限，默认 10' },
          interactive: { type: 'boolean', description: '只返回可交互元素（推荐首次调用）' },
          compact: { type: 'boolean', description: '压缩输出' },
          skeleton: { type: 'boolean', description: '只返回骨架，先定位区域' },
          includeBounds: { type: 'boolean', description: '附带元素坐标' }
        })
      },
      {
        name: 'computer_desktop_find',
        label: 'Desktop find',
        description: '按角色或名称搜索元素，返回 ref；用于大应用里直接定位控件。',
        parameters: object({
          name: { type: 'string', description: '可访问名称/文本' },
          role: { type: 'string', description: '无障碍角色，例如 button、textfield' },
          app: { type: 'string', description: '应用名' },
          windowId: { type: 'string', description: '窗口 id' }
        })
      },
      {
        name: 'computer_desktop_get',
        label: 'Desktop get',
        description: '读取某个 ref 的属性（text/value/title/bounds/role/states）。',
        parameters: object(
          { ref: { type: 'string', description: '来自 snapshot 的 ref' }, property: { type: 'string', description: '属性名' } },
          ['ref']
        )
      },
      {
        name: 'computer_desktop_click',
        label: 'Desktop click',
        description: '通过无障碍 press 动作点击 ref（不移动鼠标、不抢焦点）。',
        parameters: object({ ref: { type: 'string', description: '来自 snapshot 的 ref' } }, ['ref'])
      },
      {
        name: 'computer_desktop_type',
        label: 'Desktop type',
        description: '向输入框 ref 插入文本（按 stdin 传递，不怕引号与换行）。',
        parameters: object(
          { ref: { type: 'string', description: '来自 snapshot 的 ref' }, text: { type: 'string', description: '要输入的文本' } },
          ['ref', 'text']
        )
      },
      {
        name: 'computer_desktop_press',
        label: 'Desktop press',
        description: '发送按键组合：return、escape、ctrl+s、alt+f4 等。',
        parameters: object(
          {
            combo: { type: 'string', description: '按键组合' },
            app: { type: 'string', description: '目标应用（不聚焦）' },
            windowId: { type: 'string', description: '窗口 id' }
          },
          ['combo']
        )
      },
      {
        name: 'computer_desktop_scroll',
        label: 'Desktop scroll',
        description: '滚动某个 ref 所在区域。',
        parameters: object(
          {
            ref: { type: 'string', description: '来自 snapshot 的 ref' },
            direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
            amount: { type: 'number', description: '滚动格数，默认 3' }
          },
          ['ref']
        )
      },
      {
        name: 'computer_desktop_screenshot',
        label: 'Desktop screenshot',
        description: '截取应用窗口 PNG（保存到临时目录并返回路径）。优先用 snapshot，截图只在确需像素时使用。',
        parameters: object({
          app: { type: 'string', description: '应用名' },
          windowId: { type: 'string', description: '窗口 id' }
        })
      },
      {
        name: 'computer_desktop_launch',
        label: 'Desktop launch',
        description: '启动应用（应用名或可执行文件路径），可传参数数组。',
        parameters: object(
          { app: { type: 'string', description: '应用名或路径' }, args: { type: 'array', items: { type: 'string' } } },
          ['app']
        )
      }
    ]
  }
}
