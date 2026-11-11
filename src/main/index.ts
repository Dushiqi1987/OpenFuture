import { app, BrowserWindow, session, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { IpcChannels } from '../shared/protocol'
import type { MemoryMode, MemorySearchHit, MemorySearchResult } from '../shared/protocol'
import { AgentHost } from './agent-host'
import { AutomationService } from './automation-service'
import { AutomationStore } from './automation-store'
import { ComputerUseBridge } from './computer-use'
import { AppError } from './errors'
import { registerIpc } from './ipc'
import { MemoryHost } from './memory-host'
import { ProjectStore } from './project-store'
import { SettingsStore } from './settings-store'

const APP_ID = 'dev.openfuture.desktop'
const BACKGROUND_COLOR = '#0b0f14'

let mainWindow: BrowserWindow | null = null
let store: SettingsStore | null = null
let agentHost: AgentHost | null = null
let memoryHost: MemoryHost | null = null
let projectStore: ProjectStore | null = null
let computerBridge: ComputerUseBridge | null = null
let automationStore: AutomationStore | null = null
let automationService: AutomationService | null = null

// Test/portable override: keep every artifact (settings, credentials, sessions,
// memory DB, Chromium profile) inside an isolated directory. Must run before
// the single-instance lock and before app is ready.
const userDataOverride = process.env.OPENFUTURE_USER_DATA?.trim()
if (userDataOverride) {
  const isolatedUserData = resolve(userDataOverride)
  mkdirSync(isolatedUserData, { recursive: true })
  app.setPath('userData', isolatedUserData)
}

function pushHostLog(line: string): void {
  console.log(line)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannels.hostLog, line)
  }
}

function disposeHosts(): void {
  automationService?.stop()
  automationService = null
  agentHost?.dispose()
  agentHost = null
  memoryHost?.dispose()
  memoryHost = null
  computerBridge?.dispose()
  computerBridge = null
}

async function handleToolRequestForWorkspace(
  workspace: string,
  tool: string,
  params: unknown
): Promise<unknown> {
  if (tool.startsWith('computer_')) {
    if (!store?.getComputerUse()) {
      throw new AppError('VALIDATION', 'Computer Use 已关闭，不能调用桌面工具')
    }
    if (!computerBridge) throw new AppError('HOST_UNAVAILABLE', 'Computer Use 服务尚未启动')
    return computerBridge.call(tool, params)
  }
  return handleMemoryToolForWorkspace(workspace, tool, params)
}

async function handleToolRequest(tool: string, params: unknown): Promise<unknown> {
  if (!store) throw new AppError('HOST_UNAVAILABLE', '配置服务尚未启动')
  return handleToolRequestForWorkspace(store.requireWorkspace(), tool, params)
}

async function handleContextRequestForWorkspace(
  workspace: string,
  request: { mode: string; validateIds?: string[] }
): Promise<unknown> {
  if (!memoryHost) throw new AppError('HOST_UNAVAILABLE', '记忆服务尚未启动')
  if (Array.isArray(request.validateIds)) {
    return memoryHost.validateIds(workspace, request.validateIds)
  }
  return memoryHost.l3Context(workspace, request.mode)
}

async function handleContextRequest(request: {
  mode: string
  validateIds?: string[]
}): Promise<unknown> {
  if (!store) throw new AppError('HOST_UNAVAILABLE', '配置服务尚未启动')
  return handleContextRequestForWorkspace(store.requireWorkspace(), request)
}

/**
 * Purpose-limited bridge for the read-only memory tools. The agent host never
 * gets a workspace path or SQLite handle; every call is re-scoped to the
 * workspace owned by this host (interactive or automation).
 */
async function handleMemoryToolForWorkspace(
  workspace: string,
  tool: string,
  params: unknown
): Promise<unknown> {
  if (!store || !memoryHost) {
    throw new AppError('HOST_UNAVAILABLE', '记忆服务尚未启动')
  }
  const state = await memoryHost.state(workspace)
  const record = params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
  const text = (name: string): string => {
    const value = record[name]
    if (typeof value !== 'string' || value.trim() === '') {
      throw new AppError('VALIDATION', `工具参数 ${name} 不能为空`)
    }
    return value.trim()
  }
  const limit = (): number => {
    const raw = record.limit
    return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), 50) : 8
  }

  if (tool === 'memory_search' || tool === 'wiki_search') {
    const allowed = tool === 'memory_search' ? state.mode === 'rag' || state.mode === 'both' : state.mode === 'wiki' || state.mode === 'both'
    if (!allowed) throw new AppError('VALIDATION', `当前记忆策略（${state.mode}）不允许 ${tool}`)
    const result = await memoryHost.search(workspace, text('query'), limit())
    if (tool === 'memory_search') return result
    return {
      query: result.query,
      mode: result.mode,
      hits: result.hits.filter((hit: MemorySearchHit) => hit.kind === 'wiki')
    } satisfies MemorySearchResult
  }

  if (tool === 'memory_get' || tool === 'wiki_get') {
    const allowed = tool === 'memory_get' ? state.mode === 'rag' || state.mode === 'both' : state.mode === 'wiki' || state.mode === 'both'
    if (!allowed) throw new AppError('VALIDATION', `当前记忆策略（${state.mode}）不允许 ${tool}`)
    const hit = await memoryHost.get(workspace, text('id'))
    if (!hit) throw new AppError('VALIDATION', '记忆条目不存在或已被撤销')
    if (tool === 'wiki_get' && (hit as MemorySearchHit).kind !== 'wiki') {
      throw new AppError('VALIDATION', '该 id 不是 Wiki 页面')
    }
    return hit
  }

  if (tool === 'memory_propose') {
    if (state.mode === 'off') throw new AppError('VALIDATION', '记忆已关闭，不能提交候选')
    const type = text('type')
    const evidenceIds = Array.isArray(record.evidenceIds)
      ? record.evidenceIds.filter((item): item is string => typeof item === 'string')
      : []
    return memoryHost.createProposal(workspace, {
      type,
      title: text('title'),
      body: text('body'),
      evidenceIds
    })
  }

  throw new AppError('VALIDATION', `未知记忆工具：${tool}`)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    disposeHosts()
  })

  app.whenReady().then(start).catch((error: unknown) => {
    console.error('[main] failed to start OpenFuture:', error)
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

async function start(): Promise<void> {
  app.setAppUserModelId(APP_ID)

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)

  store = new SettingsStore(app.getPath('userData'), app.getVersion())
  store.init()
  projectStore = new ProjectStore(app.getPath('userData'), store)
  computerBridge = new ComputerUseBridge()

  agentHost = new AgentHost({
    modulePath: join(__dirname, 'agent-host.js'),
    environment: () => store?.hostEnvironment() ?? {},
    onEvent: (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IpcChannels.agentEvent, payload)
      }
    },
    onLog: (line) => {
      pushHostLog(line)
    },
    onToolRequest: (tool, params) => handleToolRequest(tool, params),
    getComputerTools: () => computerBridge?.listTools() ?? Promise.resolve([]),
    onContextRequest: (request) => handleContextRequest(request)
  })

  memoryHost = new MemoryHost({
    modulePath: join(__dirname, 'memory-host.js'),
    environment: () => store?.memoryEnvironment() ?? {},
    onLog: (line) => {
      pushHostLog(line)
    }
  })

  automationStore = new AutomationStore(app.getPath('userData'))
  automationService = new AutomationService({
    modulePath: join(__dirname, 'agent-host.js'),
    store: automationStore,
    projects: projectStore,
    settings: store,
    memoryHost,
    environment: () => store?.hostEnvironment() ?? {},
    onLog: (line) => pushHostLog(line),
    handleToolRequest: handleToolRequestForWorkspace,
    handleContextRequest: handleContextRequestForWorkspace,
    getComputerTools: () => computerBridge?.listTools() ?? Promise.resolve([]),
    onChanged: () => {}
  })
  automationService.start()

  registerIpc(
    store,
    projectStore,
    agentHost,
    memoryHost,
    automationStore,
    automationService,
    () => mainWindow
  )
  createWindow()

  // Exercise SQLite FTS5 inside the packaged runtime on every start. The result
  // is surfaced in the diagnostics panel, so a broken build is visible at once.
  void memoryHost
    .diagnostics()
    .then((diagnostics) => {
      pushHostLog(
        `[memory-host] self-test ${diagnostics.ok ? 'OK' : 'FAIL'} · SQLite ${diagnostics.sqliteVersion} · ` +
          `${diagnostics.fts5 ? 'FTS5' : 'no FTS5'} · ${diagnostics.sampleMatches} match(es) · ${diagnostics.detail}`
      )
    })
    .catch((error: unknown) => {
      pushHostLog(`[memory-host] self-test failed: ${error instanceof Error ? error.message : String(error)}`)
    })
}

function createWindow(): void {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(app.getAppPath(), 'build', 'icon.ico')
  const window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: BACKGROUND_COLOR,
    autoHideMenuBar: true,
    title: 'OpenFuture',
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  mainWindow = window

  window.once('ready-to-show', () => {
    window.show()
  })

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    // Allow reloads of the one trusted page; block everything else.
    if (url === window.webContents.getURL()) return
    event.preventDefault()
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void window.loadURL(devUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
