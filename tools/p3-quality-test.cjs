/**
 * P3 Dreaming quality-gate, budget and schedule test against the real memory host.
 *
 * Run with Electron:
 *   electron.exe tools/p3-quality-test.cjs <memoryDir> <workspace>
 */
const { app, utilityProcess } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const [memoryDir, workspace] = process.argv.slice(2)
if (!memoryDir || !workspace) {
  console.error('usage: electron tools/p3-quality-test.cjs <memoryDir> <workspace>')
  process.exit(2)
}
const hostPath = process.env.P3_HOST_PATH
  ? path.resolve(process.env.P3_HOST_PATH)
  : path.join(__dirname, '..', 'out', 'main', 'memory-host.js')
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
    env: { ...process.env, OPENFUTURE_MEMORY_DIR: memoryDir, OPENFUTURE_AUTO_DREAM_TICK_MS: '500' },
    stdio: 'pipe',
    serviceName: 'OpenFuture P3 Quality Test'
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
      title: 'OpenFuture P3 设计',
      origin: 'p3://design',
      kind: 'markdown',
      content:
        'P3 需要空闲调度、单次与每日预算、发布前 Verify，以及重复率、漂移和来源覆盖的质量回归。'
    })

    const before = await call(child, 'state', { workspace })
    check('state notes', before.noteCount === 2, before)
    check('state sources', before.sourceCount === 1, before)

    const preQuality = await call(child, 'dreamQuality', { workspace })
    check('pre duplicate rate', preQuality.duplicateRate > 0.05, preQuality.duplicateRate)
    check('pre verified false', preQuality.verified === false, preQuality)
    check(
      'pre duplicate check false',
      preQuality.checks.some((item) => item.name === 'duplicate-rate' && !item.ok),
      preQuality.checks
    )

    const job = await call(child, 'dreamStart', { workspace })
    check('job review', job.status === 'review', job.status)
    check('job has merge', job.ops.some((op) => op.type === 'merge'), job.ops.map((op) => op.type))
    check('job has promote', job.ops.some((op) => op.type === 'promote'), job.ops.map((op) => op.type))
    check('job ratio', job.deleteRatio <= 0.25, job.deleteRatio)

    const publishId = 'p3-test-1'
    const v1 = await call(child, 'dreamApply', { workspace, jobId: job.id, publishId })
    check('apply active', v1.status === 'active', v1.status)
    check('apply content', v1.l3Content.length > 0, v1.l3Content.length)
    check('l3 merged body', v1.l3Content.includes('中文回答') && v1.l3Content.includes('简洁'), v1.l3Content)
    check(
      'l3 single preference bullet',
      (v1.l3Content.match(/- \*\*用户偏好\*\*/g) || []).length === 1,
      v1.l3Content
    )

    const afterQuality = await call(child, 'dreamQuality', { workspace })
    check('post duplicate rate', afterQuality.duplicateRate === 0, afterQuality.duplicateRate)
    check('post verified', afterQuality.verified === true, afterQuality)
    check('post l3 budget', afterQuality.l3Lines <= 200 && afterQuality.l3Bytes <= 25000, afterQuality)
    check('post coverage', afterQuality.sourceCoverage >= 0.8, afterQuality.sourceCoverage)
    check('tokens recorded', afterQuality.l3Tokens > 0, afterQuality.l3Tokens)

    const schedule0 = await call(child, 'dreamSchedule', { workspace })
    check('schedule default off', schedule0.autoDream === false, schedule0)
    check('schedule per-run budget', schedule0.perRunBudget === 50000, schedule0.perRunBudget)
    check('schedule daily budget', schedule0.dailyBudget === 100000, schedule0.dailyBudget)
    check('schedule tokens today', schedule0.tokensToday === afterQuality.l3Tokens, {
      today: schedule0.tokensToday,
      l3: afterQuality.l3Tokens
    })

    const schedule1 = await call(child, 'dreamSetSchedule', {
      workspace,
      autoDream: true,
      intervalMinutes: 5
    })
    check('schedule enabled', schedule1.autoDream === true, schedule1)
    check('schedule interval', schedule1.intervalMinutes === 5, schedule1.intervalMinutes)
    check('schedule next run pending', schedule1.nextRunAt === null, schedule1.nextRunAt)

    await new Promise((resolve) => setTimeout(resolve, 1500))
    const { DatabaseSync } = require('node:sqlite')
    const observer = new DatabaseSync(path.join(memoryDir, 'memory.sqlite'))
    const autoJob = observer
      .prepare("SELECT COUNT(*) AS count FROM dream_jobs WHERE workspace_id = (SELECT id FROM workspaces LIMIT 1) AND status = 'review'")
      .get()
    observer.close()
    check('auto dream created review', (autoJob?.count ?? 0) >= 1, autoJob)

    const schedule2 = await call(child, 'dreamSetSchedule', {
      workspace,
      autoDream: false,
      intervalMinutes: 60
    })
    check('schedule disabled', schedule2.autoDream === false, schedule2)
    check('schedule interval 60', schedule2.intervalMinutes === 60, schedule2.intervalMinutes)

    const l3Path = path.join(memoryDir, 'injected', 'MEMORY.md')
    const l3 = fs.readFileSync(l3Path, 'utf8')
    check('l3 file exists', fs.existsSync(l3Path), l3Path)
    check('l3 lines <= 200', l3.split(/\r?\n/).length <= 200, l3.split(/\r?\n/).length)
    check('l3 bytes <= 25000', Buffer.byteLength(l3, 'utf8') <= 25000, Buffer.byteLength(l3, 'utf8'))

    const state = await call(child, 'dreamState', { workspace })
    check('one version', state.versions.length === 1, state.versions.length)
    check('active version', state.active?.id === v1.id, state.active?.id)

    const summary = {
      ok: failed === 0,
      passed: results.length - failed,
      total: results.length,
      failed,
      quality: afterQuality,
      schedule: schedule2,
      results
    }
    fs.mkdirSync(path.join(__dirname, '..', '.scratch', 'p3-logs'), { recursive: true })
    fs.writeFileSync(
      path.join(__dirname, '..', '.scratch', 'p3-logs', 'quality-test.json'),
      JSON.stringify(summary, null, 2)
    )
    console.log(JSON.stringify({ ok: summary.ok, passed: summary.passed, total: summary.total }))
    child.kill()
    app.exit(failed === 0 ? 0 : 1)
  } catch (error) {
    console.error(error)
    child.kill()
    app.exit(1)
  }
})
