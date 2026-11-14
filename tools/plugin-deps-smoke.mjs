import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { dependenciesReady, installDependencies, installedDependencies, parseRequires } from '../src/main/plugin-deps.ts'

/**
 * Offline smoke test for the adapted-plugin dependency installer: a local
 * registry serves two packages (one with a transitive dependency), the
 * installer resolves `^7.0.0`, and the generated ESM file then imports the
 * installed package through normal Node resolution.
 */

const ROOT = join(import.meta.dirname, '..')
const SCRATCH = join(ROOT, '.scratch', 'plugin-deps-smoke')

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

function packageTarball(files) {
  const tar = buildTar(Object.fromEntries(Object.entries(files).map(([name, body]) => [`package/${name}`, body])))
  return gzipSync(tar)
}

function startRegistry() {
  const packages = new Map()
  const tarballs = new Map()

  const add = ({ name, version, dependencies = {}, index }) => {
    const key = `${name}@${version}`
    const tgz = packageTarball({
      'package.json': JSON.stringify({ name, version, main: 'index.js', dependencies }),
      'index.js': index
    })
    tarballs.set(`${name}-${version}.tgz`, tgz)
    const document = packages.get(name) ?? {
      name,
      'dist-tags': { latest: version },
      versions: {}
    }
    document['dist-tags'].latest = version
    document.versions[version] = {
      version,
      dependencies,
      dist: { tarball: `${baseUrl}/pkg/${name}-${version}.tgz` }
    }
    packages.set(name, document)
  }

  let baseUrl = ''
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname.startsWith('/pkg/')) {
      const file = tarballs.get(url.pathname.slice('/pkg/'.length))
      if (!file) {
        response.writeHead(404).end('missing tarball')
        return
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(file)
      return
    }
    const name = decodeURIComponent(url.pathname.slice(1))
    const document = packages.get(name)
    if (!document) {
      response.writeHead(404).end('missing package')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(document))
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`
      add({ name: 'inner', version: '1.0.5', index: 'module.exports = { value: 42 }' })
      add({
        name: 'is-number',
        version: '7.0.0',
        index: 'module.exports = (value) => typeof value === "number" || /^\\d+$/.test(String(value))'
      })
      add({
        name: 'is-number',
        version: '7.1.0',
        dependencies: { inner: '^1.0.0' },
        index:
          'const inner = require("inner")\n' +
          'module.exports = (value) => (typeof value === "number" || /^\\d+$/.test(String(value))) && inner.value === 42'
      })
      resolve({
        baseUrl,
        close: () => new Promise((done) => server.close(done))
      })
    })
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`)
  console.log(`ok - ${message}`)
}

async function main() {
  rmSync(SCRATCH, { recursive: true, force: true })
  const pluginDir = join(SCRATCH, 'plugin')
  mkdirSync(pluginDir, { recursive: true })

  const parsed = parseRequires(['ssh2@^1.15.0', '@scope/pkg@~1.2.3', 'ws'])
  assert(parsed[0].name === 'ssh2' && parsed[0].range === '^1.15.0', 'parse scoped-range spec')
  assert(parsed[1].name === '@scope/pkg' && parsed[1].range === '~1.2.3', 'parse scoped package name')
  assert(parsed[2].name === 'ws' && parsed[2].range === '*', 'bare name means any version')

  const registry = await startRegistry()
  process.env.OPENFUTURE_NPM_REGISTRY = registry.baseUrl
  try {
    const result = await installDependencies({
      dir: pluginDir,
      requires: ['is-number@^7.0.0'],
      onProgress: (message) => console.log(`  progress: ${message}`)
    })
    console.log(`installed -> ${JSON.stringify(result.installed)}`)
    assert(result.installed.includes('is-number@7.1.0'), 'picks the highest matching version')
    assert(result.installed.includes('inner@1.0.5'), 'installs transitive dependencies')
    assert(existsSync(join(pluginDir, 'node_modules', 'is-number', 'package.json')), 'package unpacked into node_modules')
    assert(existsSync(join(pluginDir, 'openfuture-deps.json')), 'writes the deps manifest')
    assert(installedDependencies(pluginDir).length === 2, 'lists installed packages')
    assert(dependenciesReady(pluginDir, ['is-number@^7.0.0']), 'checks actual packages against the dependency manifest')
    assert(!dependenciesReady(pluginDir, ['is-number@^8.0.0']), 'a changed requirement invalidates the old manifest')

    writeFileSync(
      join(pluginDir, 'plugin.js'),
      [
        "import isNumber from 'is-number'",
        'export default function (api) {',
        '  return typeof api === "object" && isNumber("42")',
        '}'
      ].join('\n')
    )
    const module = await import(pathToFileURL(join(pluginDir, 'plugin.js')).href)
    assert(typeof module.default === 'function' && module.default({}) === true, 'generated plugin imports the installed package')

    const manifest = JSON.parse(readFileSync(join(pluginDir, 'openfuture-deps.json'), 'utf8'))
    assert(Array.isArray(manifest.installed) && manifest.installed.length === 2, 'manifest records resolved versions')

    let failedUpgrade = false
    try {
      await installDependencies({ dir: pluginDir, requires: ['is-number@7.0.0', 'missing-package@1'] })
    } catch {
      failedUpgrade = true
    }
    assert(failedUpgrade && dependenciesReady(pluginDir, ['is-number@^7.0.0']), 'failed install preserves the existing dependency tree')
    rmSync(join(pluginDir, 'node_modules', 'inner', 'package.json'))
    assert(!dependenciesReady(pluginDir, ['is-number@^7.0.0']), 'a missing transitive package invalidates the manifest')

    let failed = false
    try {
      await installDependencies({ dir: join(SCRATCH, 'missing'), requires: ['nope@^9.0.0'] })
    } catch (error) {
      failed = String(error.message).includes('HTTP 404') || String(error.message).includes('查询失败')
    }
    assert(failed, 'unknown package fails with a readable error')
  } finally {
    await registry.close()
  }

  console.log('SMOKE TEST PASSED')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
