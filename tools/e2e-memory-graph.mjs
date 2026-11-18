/**
 * Knowledge-graph constellation smoke test.
 *
 * Boots the real Electron app against a throwaway user-data directory, imports
 * a small corpus, and exercises the memory.graph RPC from the renderer. Then
 * opens the 记忆库 panel, switches to the 星座图 tab, and verifies that the
 * canvas actually rendered light pixels.
 *
 *   node tools/e2e-memory-graph.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CORPUS = join(ROOT, '.scratch', 'graph-corpus')
const CORPUS_B = join(ROOT, '.scratch', 'graph-corpus-b')
const USER_DATA = join(ROOT, '.scratch', 'graph-userdata')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const log = (line) => console.log(line)
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const DOCS = [
  ['deploy.md', '部署手册', 'HALCYON-001 部署在华东二区的 Kubernetes 集群，镜像通过内部 registry 分发，发布窗口是每周三 02:00-04:00。'],
  ['auth.md', '认证设计', '认证服务发放 30 分钟有效的访问令牌与 7 天有效的刷新令牌，所有内部服务通过 mTLS 互认。'],
  ['billing.md', '计费规则', '计费按分钟粒度结算，试用额度 500 元，超出后按阶梯单价计费，账单每月 1 日生成。'],
  ['database.md', '数据库规范', '业务库使用 PostgreSQL 16，读写分离，慢查询阈值 200ms，备份保留 30 天并每日校验。'],
  ['frontend.md', '前端架构', '渲染进程使用 React 19 与 Vite 8，状态尽量本地化，长列表使用虚拟滚动。'],
  ['monitor.md', '监控告警', '指标采集间隔 15 秒，P95 延迟超过 800ms 触发告警，值班群机器人负责通知。'],
  ['search.md', '检索策略', '记忆检索结合 FTS5 与语义向量，默认混合模式，命中率低时降级为关键词检索。'],
  ['roadmap.md', '路线图', '下季度重点是多知识库联通与知识图谱可视化，其次是离线模型打包。']
]

/** Second knowledge base, deliberately sharing vocabulary with the first. */
const DOCS_B = [
  ['retrieval.md', '检索引擎', '检索管线把关键词与向量混合排序，命中率靠重排器提升，缓存命中走本地索引。'],
  ['kg.md', '知识图谱', '知识图谱把笔记、证据与资料连成一张图，跨知识库的边用虚线桥接表示。'],
  ['ops.md', '值班手册', '值班以告警为核心，P95 延迟与错误率是两条红线，交接记录写在团队 Wiki。'],
  ['billing2.md', '对账流程', '每月账单生成后与支付流水对账，差额超过 1 元进入人工复核队列。'],
  ['design.md', '前端设计系统', '设计系统沉淀颜色、字号与间距令牌，组件库按季度升级，视觉回归自动截图。']
]

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
  }

  async connect() {
    this.socket = new WebSocket(this.url)
    await new Promise((done, fail) => {
      this.socket.addEventListener('open', done, { once: true })
      this.socket.addEventListener('error', fail, { once: true })
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : '')
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.fail(new Error(message.error.message))
      else pending.done(message.result)
    })
    await this.send('Runtime.enable')
    return this
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((done, fail) => {
      this.pending.set(id, { done, fail })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed')
    }
    return result.result?.value
  }

  async waitFor(expression, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await this.evaluate(expression)
      if (value) return value
      await sleep(250)
    }
    throw new Error(`timeout waiting for ${label}`)
  }
}

async function pickPort() {
  return new Promise((done) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => done(address.port))
    })
  })
}

async function findTarget(port) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = targets.find((target) => target.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* not listening yet */
    }
    await sleep(300)
  }
  throw new Error('no CDP page target')
}

function seed() {
  rmSync(USER_DATA, { recursive: true, force: true })
  rmSync(CORPUS, { recursive: true, force: true })
  rmSync(CORPUS_B, { recursive: true, force: true })
  mkdirSync(join(CORPUS, 'docs'), { recursive: true })
  for (const [name, title, body] of DOCS) {
    writeFileSync(join(CORPUS, 'docs', name), `# ${title}\n\n${body}\n`)
  }
  mkdirSync(join(CORPUS_B, 'docs'), { recursive: true })
  for (const [name, title, body] of DOCS_B) {
    writeFileSync(join(CORPUS_B, 'docs', name), ['# ' + title, '', body, ''].join(String.fromCharCode(10)))
  }
  mkdirSync(join(USER_DATA, 'config'), { recursive: true })
  writeFileSync(
    join(USER_DATA, 'config', 'settings.json'),
    JSON.stringify(
      {
        version: 1,
        workspace: CORPUS,
        model: null,
        allowPowerShell: false,
        computerUse: false,
        agentDesktop: false,
        contextCompression: false,
        subagents: false,
        subagentConcurrency: 1,
        groupChat: false
      },
      null,
      2
    )
  )
  writeFileSync(
    join(USER_DATA, 'config', 'projects.json'),
    JSON.stringify(
      {
        version: 1,
        activeProjectId: 'p-graph',
        projects: [
          {
            id: 'p-graph',
            name: 'graph-e2e',
            canonicalRoot: CORPUS,
            memoryPreset: 'rag',
            defaultModelRef: null,
            createdAt: 1_700_000_000_000,
            archivedAt: null,
            lastConversationId: 'c-graph'
          },
          {
            id: 'p-graph-2',
            name: 'graph-e2e-2',
            canonicalRoot: CORPUS_B,
            memoryPreset: 'rag',
            defaultModelRef: null,
            createdAt: 1_700_000_000_000,
            archivedAt: null,
            lastConversationId: 'c-graph-2'
          }
        ],
        conversations: [
          {
            id: 'c-graph',
            projectId: 'p-graph',
            title: '星座图验收',
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000
          },
          {
            id: 'c-graph-2',
            projectId: 'p-graph-2',
            title: '星座图验收 B',
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000
          }
        ]
      },
      null,
      2
    )
  )
}

function validateGraph(graph, label) {
  assert(graph && typeof graph === 'object', `${label}: empty response`)
  assert(Array.isArray(graph.nodes) && graph.nodes.length > 0, `${label}: no nodes`)
  assert(Array.isArray(graph.edges), `${label}: edges missing`)
  assert(Array.isArray(graph.clusters) && graph.clusters.length > 0, `${label}: no clusters`)
  assert(graph.stats.nodeCount === graph.nodes.length, `${label}: nodeCount mismatch`)
  assert(graph.stats.edgeCount === graph.edges.length, `${label}: edgeCount mismatch`)

  const keys = new Set(graph.nodes.map((node) => node.key))
  assert(keys.size === graph.nodes.length, `${label}: duplicate node keys`)
  for (const node of graph.nodes) {
    assert(Number.isFinite(node.x) && Number.isFinite(node.y), `${label}: non-finite position for ${node.key}`)
    assert(Number.isFinite(node.z), `${label}: non-finite depth for ${node.key}`)
    assert(Math.abs(node.x) <= 1.0001 && Math.abs(node.y) <= 1.0001, `${label}: position outside sky`)
    assert(Math.abs(node.z) <= 1.0001, `${label}: depth outside sky`)
    assert(typeof node.title === 'string' && node.title.length > 0, `${label}: node without title`)
  }
  for (const edge of graph.edges) {
    assert(keys.has(edge.source) && keys.has(edge.target), `${label}: dangling edge ${edge.source} -> ${edge.target}`)
    assert(edge.source !== edge.target, `${label}: self edge`)
  }
  const clusterSizes = new Map()
  for (const node of graph.nodes) clusterSizes.set(node.cluster, (clusterSizes.get(node.cluster) ?? 0) + 1)
  for (const cluster of graph.clusters) {
    assert(cluster.size === (clusterSizes.get(cluster.id) ?? 0), `${label}: cluster ${cluster.id} size mismatch`)
  }
  log(
    `${label} -> nodes=${graph.stats.nodeCount} edges=${graph.stats.edgeCount} ` +
      `bridges=${graph.stats.bridgeCount} clusters=${graph.stats.clusterCount} ` +
      `space=${graph.stats.space} dim=${graph.stats.dim} threshold=${graph.stats.threshold}`
  )
  log(`${label} clusters -> ${graph.clusters.map((cluster) => `${cluster.label}(${cluster.size})`).join(' | ')}`)
  if (graph.notes?.length) log(`${label} notes -> ${graph.notes.join(' / ')}`)
}

let app = null

async function main() {
  seed()
  const cdpPort = await pickPort()
  const env = { ...process.env, OPENFUTURE_USER_DATA: USER_DATA }
  delete env.ELECTRON_RUN_AS_NODE
  app = spawn(ELECTRON, ['.', `--remote-debugging-port=${cdpPort}`], { cwd: ROOT, env, stdio: 'ignore' })
  const cdp = await new Cdp(await findTarget(cdpPort)).connect()
  await cdp.send('Page.enable')
  await cdp.waitFor(`typeof window.openfuture === 'object'`, 'preload', 40_000)
  // The very first renderer paint can stay on the loading screen in a cold
  // throwaway profile (main-process bootstrap race); a reload always settles.
  await cdp.send('Page.reload', { ignoreCache: true })
  await cdp.waitFor(`typeof window.openfuture === 'object'`, 'preload after reload', 40_000)
  await cdp.waitFor(`!!document.querySelector('button[aria-label="项目记忆"]')`, 'app chrome', 60_000)
  await sleep(1200)

  const docs = DOCS.map(([name]) => join(CORPUS, 'docs', name))
  const imported = await cdp.evaluate(
    `window.openfuture.memoryImportFiles({ paths: ${JSON.stringify(docs)} })` +
      `.then((result) => result.ok ? result.value.length : ('ERR:' + result.error.message))`
  )
  log(`imported -> ${imported}`)
  assert(imported === docs.length, `import failed: ${imported}`)

  const mode = await cdp.evaluate(
    `window.openfuture.memorySetMode('rag').then((result) => result.ok ? result.value.mode : ('ERR:' + result.error.message))`
  )
  log(`mode -> ${mode}`)
  assert(mode === 'rag', `unexpected memory mode: ${mode}`)
  await sleep(600)

  // Second knowledge base: switch project, then import its own corpus.
  const switched = await cdp.evaluate(
    `window.openfuture.selectProject('p-graph-2').then((result) => result.ok ? 'ok' : ('ERR:' + result.error.message))`
  )
  log(`project -> ${switched}`)
  assert(switched === 'ok', `project switch failed: ${switched}`)
  await sleep(1500)

  const docsB = DOCS_B.map(([name]) => join(CORPUS_B, 'docs', name))
  const importedB = await cdp.evaluate(
    `window.openfuture.memoryImportFiles({ paths: ${JSON.stringify(docsB)} })` +
      `.then((result) => result.ok ? result.value.length : ('ERR:' + result.error.message))`
  )
  log(`imported B -> ${importedB}`)
  assert(importedB === docsB.length, `import B failed: ${importedB}`)

  const modeB = await cdp.evaluate(
    `window.openfuture.memorySetMode('rag').then((result) => result.ok ? result.value.mode : ('ERR:' + result.error.message))`
  )
  log(`mode B -> ${modeB}`)
  assert(modeB === 'rag', `unexpected memory mode B: ${modeB}`)
  await sleep(600)

  const workspaceGraph = await cdp.evaluate(
    `window.openfuture.memoryGraph({ scope: 'workspace' })` +
      `.then((result) => result.ok ? result.value : ('ERR:' + result.error.message))`
  )
  if (typeof workspaceGraph === 'string') throw new Error(workspaceGraph)
  validateGraph(workspaceGraph, 'workspace')
  assert(workspaceGraph.nodes.some((node) => node.kind === 'evidence'), 'workspace: no evidence nodes')
  assert(workspaceGraph.nodes.some((node) => node.kind === 'source'), 'workspace: no source nodes')
  assert(workspaceGraph.clusters.some((cluster) => cluster.keywords.length > 0), 'workspace: clusters lack keywords')

  const allGraph = await cdp.evaluate(
    `window.openfuture.memoryGraph({ scope: 'all', maxNodes: 120 })` +
      `.then((result) => result.ok ? result.value : ('ERR:' + result.error.message))`
  )
  if (typeof allGraph === 'string') throw new Error(allGraph)
  validateGraph(allGraph, 'all')
  assert(allGraph.stats.workspaceCount >= 2, 'all: expected two knowledge bases')
  assert(allGraph.stats.bridgeCount > 0, 'all: no cross-knowledge-base bridges')

  const filtered = await cdp.evaluate(
    `window.openfuture.memoryGraph({ scope: 'workspace', kinds: ['source'] })` +
      `.then((result) => result.ok ? result.value : ('ERR:' + result.error.message))`
  )
  if (typeof filtered === 'string') throw new Error(filtered)
  assert(filtered.nodes.length === 0 || filtered.nodes.every((node) => node.kind === 'source'), 'kinds filter leaked')

  await cdp.evaluate(`document.querySelector('button[aria-label="项目记忆"]')?.click()`)
  await cdp.waitFor(`!!document.querySelector('.memory-panel')`, 'memory panel', 20_000)
  await cdp.evaluate(`(() => {
    const tab = [...document.querySelectorAll('.memory-tab')].find((button) => button.textContent.includes('星座图'))
    tab?.click()
    return Boolean(tab)
  })()`)
  await cdp.waitFor(`!!document.querySelector('.constellation-canvas')`, 'constellation canvas', 30_000)
  const scopeClicked = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('.constellation-toggle button')].find((item) => item.textContent.includes('全部知识库'))
    button?.click()
    return Boolean(button)
  })()`)
  assert(scopeClicked, 'all-scope toggle missing')
  await sleep(3200)

  const panel = await cdp.evaluate(`(async () => {
    const canvas = document.querySelector('.constellation-canvas')
    const error = document.querySelector('.memory-error')?.textContent || ''
    if (!canvas) return { error: 'missing canvas' }
    const stage = canvas.closest('.constellation-stage')
    const stageRect = stage ? stage.getBoundingClientRect() : null
    const rafOk = await Promise.race([
      new Promise((done) => requestAnimationFrame(() => done(true))),
      new Promise((done) => setTimeout(() => done(false), 1200))
    ])
    const context = canvas.getContext('2d')
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data
    let lit = 0
    for (let index = 0; index < data.length; index += 4 * 61) {
      if ((data[index] ?? 0) + (data[index + 1] ?? 0) + (data[index + 2] ?? 0) > 150) lit += 1
    }
    return {
      width: canvas.width,
      height: canvas.height,
      visibility: document.visibilityState,
      stage: stageRect ? { w: Math.round(stageRect.width), h: Math.round(stageRect.height) } : null,
      rafOk,
      lit,
      error: error.slice(0, 300),
      legend: document.querySelectorAll('.constellation-cluster').length,
      stats: document.querySelector('.constellation-stats')?.textContent || ''
    }
  })()`)
  log(`panel -> ${JSON.stringify({ width: panel.width, height: panel.height, stage: panel.stage, visibility: panel.visibility, rafOk: panel.rafOk, lit: panel.lit, legend: panel.legend, error: panel.error })}`)
  log(`stats line -> ${panel.stats.replace(/\s+/g, ' ').trim()}`)
  assert(!panel.error, `panel error: ${panel.error}`)
  assert(panel.lit > 60, `canvas looks blank (lit=${panel.lit})`)
  assert(panel.legend > 0, 'cluster legend did not render')

  const workspaceCount = Number((/(\d+) 个知识库/.exec(panel.stats) ?? [])[1] ?? 0)
  const bridgeCount = Number((/(\d+) 座跨库桥接/.exec(panel.stats) ?? [])[1] ?? 0)
  log(`panel breadth -> workspaces=${workspaceCount} bridges=${bridgeCount}`)
  assert(workspaceCount >= 2, `panel should cover two knowledge bases (got ${workspaceCount})`)
  assert(bridgeCount > 0, `panel should draw cross-base bridges (got ${bridgeCount})`)

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(ROOT, '.scratch', 'e2e-memory-graph.png'), Buffer.from(shot.data, 'base64'))
  log('screenshot -> .scratch/e2e-memory-graph.png')
  log('GRAPH E2E PASSED')
}

try {
  await main()
} catch (error) {
  console.error('GRAPH E2E FAILED', error)
  process.exitCode = 1
} finally {
  try {
    app?.kill()
  } catch {
    /* already gone */
  }
}
process.exit(process.exitCode ?? 0)
