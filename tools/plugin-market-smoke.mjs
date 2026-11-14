#!/usr/bin/env node
/**
 * Offline smoke test for the plugin market + DSH -> OpenFuture adaptation path.
 *
 * Serves a tiny fixture catalog and tarball over loopback, then exercises the
 * real `PluginMarket` (catalog fetch, tarball install, source readback) and the
 * real `adaptPluginSources` session against the repository mock model
 * (MOCK_PLUGIN_ADAPT=1 returns a valid extension in a ```js fence).
 *
 *   node tools/plugin-market-smoke.mjs
 */
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer as createTcpServer } from 'node:net'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { PluginMarket } from '../src/main/plugin-market.ts'
import { adaptPluginSources } from '../src/agent-host/plugin-adapt.ts'
import { validateAdaptedCode } from '../src/main/plugin-code.ts'

const ROOT = resolve(import.meta.dirname, '..')
const WORK = join(ROOT, '.scratch', 'plugin-market-smoke')
let MOCK_PORT = 0
let FIXTURE_PORT = 0
let MOCK_BASE = ''
let FIXTURE_BASE = ''
let shutdownMock = () => {}
let shutdownFixture = () => {}

async function pickPort() {
  return new Promise((resolvePort, reject) => {
    const probe = createTcpServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolvePort(port) : reject(new Error('no free port'))))
    })
  })
}

const log = (line) => process.stdout.write(`${line}\n`)
const fail = (message) => {
  log(`FAIL: ${message}`)
  process.exitCode = 1
}
function check(label, condition, detail = '') {
  if (condition) {
    log(`  ok  ${label}`)
    return
  }
  fail(`${label}${detail ? ` — ${detail}` : ''}`)
}

/** Minimal ustar writer: enough for npm-style `package/...` archives. */
function buildTar(files) {
  const blocks = []
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content, 'utf8')
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'ascii')
    header.write('0000000\0', 108, 8, 'ascii')
    header.write('0000000\0', 116, 8, 'ascii')
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii')
    header.write('        ', 148, 8, 'ascii')
    header.write('0', 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

function modelsJson() {
  return JSON.stringify(
    {
      providers: {
        mock: {
          baseUrl: MOCK_BASE,
          api: 'openai-completions',
          apiKey: 'smoke-test-key',
          models: [
            {
              id: 'mock-model',
              name: 'Mock Model',
              reasoning: false,
              input: ['text'],
              contextWindow: 32_000,
              maxTokens: 4_096,
              compat: { supportsDeveloperRole: false }
            }
          ]
        }
      }
    },
    null,
    2
  )
}

async function main() {
  MOCK_PORT = await pickPort()
  FIXTURE_PORT = await pickPort()
  MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`
  FIXTURE_BASE = `http://127.0.0.1:${FIXTURE_PORT}`

  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(join(WORK, 'workspace'), { recursive: true })
  mkdirSync(join(WORK, 'agent'), { recursive: true })
  writeFileSync(join(WORK, 'agent', 'models.json'), modelsJson(), 'utf8')
  writeFileSync(join(WORK, 'agent', 'auth.json'), '{}', 'utf8')

  // ---- fixture catalog + tarball -----------------------------------------
  const archive = gzipSync(
    buildTar({
      'package/package.json': JSON.stringify({
        name: 'dsh-demo-plugin',
        version: '0.1.0',
        description: 'Fixture plugin for the market smoke test'
      }),
      'package/index.js': "export function apply(ctx) {\n  ctx.logger?.info?.('dsh demo plugin loaded')\n}\n",
      'package/README.md': '# dsh-demo-plugin\n\nFixture plugin used by tools/plugin-market-smoke.mjs.\n'
    })
  )
  const catalog = JSON.stringify([
    {
      name: 'dsh-demo-plugin',
      owner: 'openfuture',
      url: 'https://github.com/example/dsh-demo-plugin',
      category: 'demo',
      description: 'A tiny fixture plugin',
      version: '0.1.0',
      stars: 1,
      downloads: 2,
      tarball: `${FIXTURE_BASE}/demo.tgz`
    }
  ])
  const fixture = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0]
    if (path === '/catalog.json') {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(catalog) })
      response.end(catalog)
      return
    }
    if (path === '/demo.tgz') {
      response.writeHead(200, { 'content-type': 'application/gzip', 'content-length': archive.length })
      response.end(archive)
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  await new Promise((done) => fixture.listen(FIXTURE_PORT, '127.0.0.1', done))
  shutdownFixture = () => fixture.close()
  process.on('exit', shutdownFixture)
  log(`fixture catalog ready on ${FIXTURE_BASE}/catalog.json`)

  const mock = spawn(process.execPath, [join(ROOT, 'tools', 'mock-model', 'server.mjs')], {
    env: {
      ...process.env,
      MOCK_MODEL_PORT: String(MOCK_PORT),
      MOCK_MODEL_ID: 'mock-model',
      MOCK_DELAY_MS: '5',
      MOCK_PLUGIN_ADAPT: '1'
    },
    stdio: 'ignore'
  })
  shutdownMock = () => {
    if (!mock.killed) mock.kill()
  }
  process.on('exit', shutdownMock)
  const deadline = Date.now() + 15_000
  let ready = false
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${MOCK_PORT}/health`, { signal: AbortSignal.timeout(800) })
      if (response.ok) {
        ready = true
        break
      }
    } catch {
      // still booting
    }
    await new Promise((done) => setTimeout(done, 120))
  }
  if (!ready) {
    fail('mock model did not become healthy')
    return
  }
  log(`mock model ready on ${MOCK_BASE}`)

  // ---- market: catalog, install, read ------------------------------------
  const market = new PluginMarket(join(WORK, 'userdata'), { catalogUrl: `${FIXTURE_BASE}/catalog.json` })
  market.init()
  const empty = await market.state()
  check('catalog exposes one entry', empty.entries.length === 1, String(empty.entries.length))
  check('entry is normalized', empty.entries[0]?.name === 'dsh-demo-plugin')

  const id = empty.entries[0].id
  await market.install(id)
  const installed = await market.state()
  check('install records the plugin', installed.installed.length === 1, String(installed.installed.length))
  const installedDir = market.installedDir(id)
  check('tarball extracted the package manifest', existsSync(join(installedDir, 'package.json')))

  mkdirSync(join(installedDir, 'docs'), { recursive: true })
  writeFileSync(join(installedDir, 'docs', 'guide.md'), '文'.repeat(45_000))
  const sources = market.readSources(id)
  log(`  sources: ${sources.map((item) => `${item.path}(${item.text.length})`).join(', ')}`)
  check('readSources returns the plugin files', sources.some((item) => item.path.endsWith('index.js')))
  check(
    'source text includes the host apply() entry',
    sources.some((item) => item.text.includes('export function apply'))
  )

  // ---- adaptation against the mock model --------------------------------
  const pi = await import('@earendil-works/pi-coding-agent')
  const agentDir = join(WORK, 'agent')
  const workspace = join(WORK, 'workspace')
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false
  })
  modelRuntime.setRuntimeApiKey('mock', 'smoke-test-key')
  const model = modelRuntime.getModel('mock', 'mock-model')
  if (!model) {
    fail('mock model is missing from ModelRuntime')
    return
  }
  const settingsManager = pi.SettingsManager.create(workspace, agentDir)
  const sessionDir = join(WORK, 'sessions', 'plugin-adapt')
  mkdirSync(sessionDir, { recursive: true })
  log('\n[adaptation]')
  const adapted = await adaptPluginSources({
    pi,
    modelRuntime,
    model,
    cwd: workspace,
    agentDir,
    sessionDir,
    settingsManager,
    pluginName: 'dsh-demo-plugin',
    description: 'A tiny fixture plugin',
    sources
  })
  log(`  note: ${(adapted.note ?? '').slice(0, 80)}`)
  check('model returned an extension body', adapted.code.includes('export default function'), adapted.code.slice(0, 60))
  check('rewritten body uses the Pi extension API', adapted.code.includes('registerCommand'))
  check('rewritten body keeps the dsh_ tool prefix convention', adapted.code.includes('dsh_demo'))

  const written = market.writeAdapted(id, {
    name: 'dsh-demo-plugin',
    code: adapted.code,
    note: adapted.note
  })
  check('adapted file is written', existsSync(written.file))
  check('new adaptations stay disabled', market.enabledPluginFiles().length === 0)
  market.setAdaptedEnabled(id, true)
  check('enabledPluginFiles returns one path', market.enabledPluginFiles().length === 1)
  market.setAdaptedEnabled(id, false)
  check('disabling removes it from host load list', market.enabledPluginFiles().length === 0)

  const manifest = JSON.parse(readFileSync(join(market.adaptedDir(id), 'manifest.json'), 'utf8'))
  check('manifest records the adapted name', manifest.name === 'dsh-demo-plugin', String(manifest.name))

  assert.throws(() => validateAdaptedCode('export default function ( {'))
  assert.throws(() => market.writeAdapted('bad-code', { name: 'bad-code', code: 'export default function ( {' }), /无法保存/)
  assert.equal(existsSync(market.adaptedDir('bad-code')), false)
  assert.throws(() => validateAdaptedCode('export default {};'), /默认导出扩展函数/)
  assert.throws(() => validateAdaptedCode("export default () => import('node:fs')"), /不支持的模块/)
  assert.deepEqual(
    validateAdaptedCode("// deps: lodash@^4.17.0\nimport 'lodash/fp'\nexport default () => import('@example/pkg/extra')"),
    ['lodash@^4.17.0', '@example/pkg']
  )

  const legacyId = '@fixture/demo'
  market.writeAdapted(legacyId, { name: legacyId, code: "// deps: sample@2\nimport 'sample'\nexport default () => {}" })
  writeFileSync(
    join(market.adaptedDir(legacyId), 'openfuture-deps.json'),
    JSON.stringify({ requires: ['sample@1'], installed: ['sample@1.0.0'] })
  )
  const legacy = market.listAdapted().find((item) => item.id === legacyId)
  assert.equal(legacy?.depsInstalled, false)
  assert.throws(() => market.setAdaptedEnabled(legacyId, true), /先安装插件依赖/)

  const localCatalog = join(WORK, 'catalog.json')
  writeFileSync(localCatalog, JSON.stringify([
    { name: 'demo', owner: 'alpha' },
    { name: 'demo', owner: 'beta', tarball: empty.entries[0].tarball }
  ]))
  const userData = join(WORK, 'legacy-userdata')
  const updatedMarket = new PluginMarket(userData, { catalogUrl: localCatalog })
  const [alpha, beta] = (await updatedMarket.state()).entries
  assert.notEqual(alpha.id, beta.id)
  await assert.rejects(updatedMarket.install(alpha.id), /没有可下载/)
  mkdirSync(updatedMarket.installedDir('demo'), { recursive: true })
  writeFileSync(join(updatedMarket.installedDir('demo'), 'package.json'), '{}')
  writeFileSync(join(userData, 'plugins', 'installed.json'), JSON.stringify({
    version: 1,
    plugins: { demo: { id: 'demo', name: 'demo', installedAt: 1, sourceUrl: beta.tarball } }
  }))
  assert.equal((await updatedMarket.state()).installed[0].catalogId, beta.id)
  assert.equal((await updatedMarket.install(beta.id)).id, 'demo')
  writeFileSync(localCatalog, JSON.stringify({ unexpected: [] }))
  const failedRefresh = await updatedMarket.state(true)
  assert.match(failedRefresh.catalogError, /无法识别/)
  assert.equal(failedRefresh.entries.length, 2)

  log('\nSMOKE TEST PASSED')
}

main()
  .catch((error) => {
    fail(error instanceof Error ? error.stack ?? error.message : String(error))
  })
  .finally(() => {
    shutdownMock()
    shutdownFixture()
    process.exit(process.exitCode ?? 0)
  })
