/**
 * P2 Dreaming end-to-end test against the real memory-host utility process.
 *
 * Run with Electron:
 *   electron.exe tools/p2-dream-test.cjs <memoryDir> <workspace>
 */
const { app, utilityProcess } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const [memoryDir, workspace] = process.argv.slice(2)
if (!memoryDir || !workspace) {
  console.error('usage: electron tools/p2-dream-test.cjs <memoryDir> <workspace>')
  process.exit(2)
}
const hostPath = path.join(__dirname, '..', 'out', 'main', 'memory-host.js')
const results = []
let failed = 0
let nextId = 0
const pending = new Map()

function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail })
  if (!condition) {
    failed += 1
    console.error(`FAIL ${name}: ${JSON.stringify(detail)}`)
  } else {
    console.log(`PASS ${name}`)
  }
}

function call(child, method, params) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout: ${method}`))
    }, 30000)
    pending.set(id, { resolve, reject, timer })
    child.postMessage({ kind: 'request', id, method, params })
  })
}

app.whenReady().then(async () => {
  fs.rmSync(memoryDir, { recursive: true, force: true })
  fs.mkdirSync(workspace, { recursive: true })

  const child = utilityProcess.fork(hostPath, [], {
    env: { ...process.env, OPENFUTURE_MEMORY_DIR: memoryDir },
    stdio: 'pipe',
    serviceName: 'OpenFuture P2 Dream Test'
  })
  child.stdout?.on('data', (chunk) => process.stdout.write(chunk))
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk))
  child.on('message', (message) => {
    if (!message || message.kind !== 'response') return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.ok) request.resolve(message.value)
    else request.reject(new Error(message.error?.message || 'rpc failed'))
  })
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('exit', (code) => reject(new Error(`memory-host exited early: ${code}`)))
  })

  try {
    await call(child, 'createNote', {
      workspace,
      type: 'preference',
      title: '用户偏好',
      body: '用户偏好中文回答，并要求思考链使用中文。'
    })
    await call(child, 'createNote', {
      workspace,
      type: 'fact',
      title: '用户偏好',
      body: '用户偏好简洁的工程说明，不喜欢空泛描述。'
    })
    await call(child, 'importSource', {
      workspace,
      title: 'OpenFuture P2 设计',
      origin: 'p2://design',
      kind: 'markdown',
      content:
        'P2 Dreaming 需要经过 Ingest、Light、REM、Deep、Promote 五个阶段。发布前必须预览，删除比例不得超过 25%。'
    })

    const before = await call(child, 'state', { workspace })
    check('state notes', before.noteCount === 2, before)
    check('state sources', before.sourceCount === 1, before)

    const job = await call(child, 'dreamStart', { workspace })
    check('job review', job.status === 'review', job.status)
    check('job ops', Array.isArray(job.ops) && job.ops.length >= 3, job.ops.length)
    check('job ratio', job.deleteRatio <= 0.25, job.deleteRatio)
    check('job preview', typeof job.l3Preview === 'string' && job.l3Preview.length > 0, job.l3Preview?.length)
    check('job has merge', job.ops.some((op) => op.type === 'merge'), job.ops.map((op) => op.type))
    check('job has promote', job.ops.some((op) => op.type === 'promote'), job.ops.map((op) => op.type))

    const publishId = 'p2-test-1'
    const v1 = await call(child, 'dreamApply', { workspace, jobId: job.id, publishId })
    check('apply active', v1.status === 'active', v1.status)
    check('apply content', v1.l3Content.length > 0, v1.l3Content.length)

    const same = await call(child, 'dreamApply', { workspace, jobId: job.id, publishId })
    check('idempotent publish', same.id === v1.id, { first: v1.id, second: same.id })

    const state1 = await call(child, 'dreamState', { workspace })
    check('one version', state1.versions.length === 1, state1.versions.length)
    check('active set', state1.active?.id === v1.id, state1.active?.id)

    const l3Path = path.join(memoryDir, 'injected', 'MEMORY.md')
    check('l3 file exists', fs.existsSync(l3Path), l3Path)
    const l3 = fs.readFileSync(l3Path, 'utf8')
    check('l3 non-empty', l3.length > 0, l3.length)
    check('l3 lines <= 200', l3.split(/\r?\n/).length <= 200, l3.split(/\r?\n/).length)
    check('l3 bytes <= 25000', Buffer.byteLength(l3, 'utf8') <= 25000, Buffer.byteLength(l3, 'utf8'))

    const job2 = await call(child, 'dreamStart', { workspace })
    const v2 = await call(child, 'dreamApply', { workspace, jobId: job2.id, publishId: 'p2-test-2' })
    check('second version', v2.id !== v1.id, { v1: v1.id, v2: v2.id })

    const rolled = await call(child, 'dreamRollback', { workspace })
    check('rollback target', rolled?.id === v1.id, rolled?.id)
    const afterRollback = fs.readFileSync(l3Path, 'utf8')
    check('rollback content', afterRollback === v1.l3Content, {
      expected: v1.l3Content.length,
      actual: afterRollback.length
    })

    const revoked = await call(child, 'dreamRevoke', { workspace, versionId: v1.id })
    check('revoked status', revoked.status === 'revoked', revoked.status)
    const state2 = await call(child, 'dreamState', { workspace })
    check('fallback active', state2.active?.id === v2.id, state2.active?.id)
    check('revoked file', fs.readFileSync(l3Path, 'utf8') === v2.l3Content, 'file should match fallback')

    const summary = { ok: failed === 0, passed: results.filter((r) => r.ok).length, total: results.length, failed }
    console.log(JSON.stringify({ results, summary }, null, 2))
    fs.mkdirSync(path.join(__dirname, '..', '.scratch', 'p2-logs'), { recursive: true })
    fs.writeFileSync(
      path.join(__dirname, '..', '.scratch', 'p2-logs', 'dream-test.json'),
      JSON.stringify({ results, summary }, null, 2)
    )
    child.kill()
    app.exit(failed === 0 ? 0 : 1)
  } catch (error) {
    console.error('P2 dream test crashed:', error)
    child.kill()
    app.exit(1)
  }
})
