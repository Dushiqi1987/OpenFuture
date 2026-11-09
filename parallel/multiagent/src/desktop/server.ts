/**
 * M2 desktop integration bridge.
 *
 * A dependency-free HTTP service that hands the persisted multi-agent run to
 * the desktop shell: board snapshots, versioned events, versioned artifacts,
 * curated memory projections and an external test-report inbox. It is
 * intentionally read-only except for POST /v1/runs/:runId/tests, and it does
 * not own a UI, a project picker or any model-provider configuration.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { ARTIFACT_DIR, ArtifactStore } from '../core/artifacts.ts'
import { buildBoard } from '../core/board.ts'
import type { RunResult } from '../core/engine.ts'
import { errorMessage, isTeamError, TeamError } from '../core/errors.ts'
import { RunStore } from '../core/store.ts'
import type { ArtifactRef, MemoryView, ProjectPolicy, RunEvent, TaskRecord } from '../core/types.ts'
import { systemClock, type Clock } from '../core/util.ts'
import { buildProjectMemory, buildRunMemory } from './memory.ts'
import {
  DESKTOP_BRIDGE_PORT,
  DESKTOP_CONTRACT_NAME,
  DESKTOP_CONTRACT_VERSION,
  type ContractEnvelope,
  type ContractErrorBody,
  type ContractManifest,
  type ExternalTestCheck,
  type ExternalTestReport,
  type ExternalTestReportInput,
  type RunSummary,
  type TestIntegrationView
} from './types.ts'

const MAX_BODY_BYTES = 256 * 1024
const MAX_EVENT_PAGE = 2000
const MAX_RUN_LIST = 200
const MAX_EXTERNAL_REPORTS = 1000

export interface DesktopBridgeOptions {
  project: ProjectPolicy
  host?: string
  port?: number
  token?: string
  artifactDir?: string
  clock?: Clock
  corsOrigin?: string
}

export interface DesktopBridgeStats {
  startedAt: number
  requests: number
  activeStreams: number
  streamsOpened: number
}

export interface DesktopBridge {
  host: string
  port: number
  url: string
  projectId: string
  contractVersion: string
  stats: () => DesktopBridgeStats
  close: () => Promise<void>
}

interface InternalStats extends DesktopBridgeStats {
  streamsOpened: number
}

const STATUS_BY_CODE: Record<string, number> = {
  'run-not-found': 404,
  'run-id-invalid': 400,
  'run-unreadable': 500,
  'run-snapshot-corrupt': 500,
  'run-snapshot-version': 500,
  'unknown-task': 404,
  'artifact-not-found': 404,
  'artifact-corrupt': 409,
  'artifact-outside-root': 400,
  'desktop-invalid-json': 400,
  'desktop-invalid-body': 400,
  'desktop-invalid-query': 400,
  'desktop-unauthorized': 401,
  'desktop-method-not-allowed': 405,
  'desktop-body-too-large': 413,
  'desktop-not-found': 404,
  'desktop-insecure-bind': 400,
  'desktop-listen-failed': 500
}

const MEMORY_VIEWS: MemoryView[] = ['off', 'rag', 'wiki']

function contractManifest(port: number): ContractManifest {
  return {
    contractVersion: DESKTOP_CONTRACT_VERSION,
    name: DESKTOP_CONTRACT_NAME,
    defaultPort: port,
    eventSchemaVersion: '1.0',
    capabilities: [
      'board.snapshot',
      'board.traceability',
      'events.replay',
      'events.stream',
      'artifacts.versioned',
      'artifacts.sha256-verified',
      'memory.off',
      'memory.rag',
      'memory.wiki',
      'tests.external-reports'
    ],
    endpoints: [
      { method: 'GET', path: '/v1/health', description: 'Liveness probe', auth: false },
      { method: 'GET', path: '/v1/contract', description: 'Versioned contract manifest', auth: false },
      { method: 'GET', path: '/v1/runs', description: 'List persisted runs (newest first)', auth: true },
      { method: 'GET', path: '/v1/runs/:runId/board', description: 'Task board with lanes and traceability', auth: true },
      { method: 'GET', path: '/v1/runs/:runId/events', description: 'Replay run events after a sequence number', auth: true },
      { method: 'GET', path: '/v1/runs/:runId/events/stream', description: 'SSE replay (and optional follow)', auth: true },
      { method: 'GET', path: '/v1/runs/:runId/artifacts', description: 'List versioned artifacts', auth: true },
      { method: 'GET', path: '/v1/runs/:runId/artifacts/:artifactId', description: 'Artifact metadata and hash verification', auth: true },
      { method: 'GET', path: '/v1/runs/:runId/artifacts/:artifactId/content', description: 'Artifact bytes, verified against sha256', auth: true },
      { method: 'GET', path: '/v1/runs/:runId/memory', description: 'Run-scoped memory view (off/rag/wiki)', auth: true },
      { method: 'GET', path: '/v1/memory', description: 'Project-level memory view across recent runs', auth: true },
      { method: 'GET', path: '/v1/runs/:runId/tests', description: 'Published test artifacts and external reports', auth: true },
      { method: 'POST', path: '/v1/runs/:runId/tests', description: 'Append an external test report', auth: true }
    ],
    memoryViews: MEMORY_VIEWS,
    notes: [
      'All envelopes carry schemaVersion 1.0 and are versioned by GET /v1/contract.',
      'Artifact content is read through ArtifactStore and verified against the stored sha256.',
      'External test reports are appended to <run>/desktop-tests and never mutate the run snapshot.',
      'Bind to loopback by default; non-loopback hosts require a bearer token.'
    ]
  }
}

function envelope<T>(
  kind: string,
  projectId: string,
  data: T,
  runId?: string,
  now = Date.now()
): ContractEnvelope<T> {
  return {
    schemaVersion: DESKTOP_CONTRACT_VERSION,
    kind,
    projectId,
    ...(runId !== undefined ? { runId } : {}),
    generatedAt: now,
    data
  }
}

function statusForError(error: unknown): number {
  if (isTeamError(error)) return STATUS_BY_CODE[error.code] ?? 500
  return 500
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store'
  })
  res.end(text)
}

function sendError(res: ServerResponse, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  const body: ContractErrorBody = {
    schemaVersion: DESKTOP_CONTRACT_VERSION,
    kind: 'error',
    generatedAt: Date.now(),
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {})
    }
  }
  sendJson(res, status, body)
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      throw new TeamError('desktop-body-too-large', `request body exceeds ${MAX_BODY_BYTES} bytes`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseJsonBody(raw: string): unknown {
  if (raw.trim().length === 0) throw new TeamError('desktop-invalid-json', 'request body is empty')
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    throw new TeamError('desktop-invalid-json', `request body is not valid JSON: ${errorMessage(error)}`)
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TeamError('desktop-invalid-body', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function optionalString(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TeamError('desktop-invalid-body', `${label} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new TeamError('desktop-invalid-body', `${label} must be 1..${max} characters`)
  }
  return trimmed
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TeamError('desktop-invalid-body', `${label} must be a finite number`)
  }
  return value
}

function parseTestReportInput(value: unknown): ExternalTestReportInput {
  const body = asRecord(value, 'test report')
  const name = optionalString(body.name, 'name', 200)
  if (!name) throw new TeamError('desktop-invalid-body', 'name is required')
  const status = body.status
  if (status !== 'passed' && status !== 'failed' && status !== 'blocked') {
    throw new TeamError('desktop-invalid-body', 'status must be passed, failed or blocked')
  }
  if (!Array.isArray(body.checks) || body.checks.length === 0 || body.checks.length > 200) {
    throw new TeamError('desktop-invalid-body', 'checks must be a non-empty array of at most 200 entries')
  }
  const seen = new Set<string>()
  const checks: ExternalTestCheck[] = body.checks.map((raw, index) => {
    const check = asRecord(raw, `checks[${index}]`)
    const id = optionalString(check.id, `checks[${index}].id`, 200)
    if (!id) throw new TeamError('desktop-invalid-body', `checks[${index}].id is required`)
    if (seen.has(id)) throw new TeamError('desktop-invalid-body', `duplicate check id ${id}`)
    seen.add(id)
    if (check.status !== 'passed' && check.status !== 'failed') {
      throw new TeamError('desktop-invalid-body', `checks[${index}].status must be passed or failed`)
    }
    const detail = optionalString(check.detail, `checks[${index}].detail`, 4000)
    return {
      id,
      status: check.status,
      ...(detail !== undefined ? { detail } : {})
    }
  })
  const taskId = optionalString(body.taskId, 'taskId', 200)
  const framework = optionalString(body.framework, 'framework', 120)
  const startedAt = optionalNumber(body.startedAt, 'startedAt')
  const finishedAt = optionalNumber(body.finishedAt, 'finishedAt')
  if (startedAt !== undefined && finishedAt !== undefined && finishedAt < startedAt) {
    throw new TeamError('desktop-invalid-body', 'finishedAt must not be earlier than startedAt')
  }
  let evidence: string[] | undefined
  if (body.evidence !== undefined) {
    if (!Array.isArray(body.evidence) || body.evidence.length > 100) {
      throw new TeamError('desktop-invalid-body', 'evidence must be an array of at most 100 strings')
    }
    evidence = body.evidence.map((item, index) => {
      if (typeof item !== 'string' || item.length === 0 || item.length > 4000) {
        throw new TeamError('desktop-invalid-body', `evidence[${index}] must be a non-empty string of at most 4000 characters`)
      }
      return item
    })
  }
  return {
    ...(taskId !== undefined ? { taskId } : {}),
    name,
    ...(framework !== undefined ? { framework } : {}),
    status,
    checks,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(evidence !== undefined ? { evidence } : {})
  }
}

function resultFromStore(store: RunStore, now = Date.now()): RunResult {
  const run = store.run
  const startedAt = run.startedAt ?? run.createdAt
  const finishedAt = run.finishedAt ?? now
  return {
    runId: run.runId,
    projectId: run.projectId,
    status: run.status,
    ...(run.stopReason !== undefined ? { stopReason: run.stopReason } : {}),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    maxConcurrency: store.plan.budget.maxConcurrency,
    plan: store.plan,
    tasks: store.tasks,
    artifacts: store.snapshot.artifacts,
    messages: store.snapshot.messages,
    events: store.events,
    integration: store.snapshot.integration
  }
}

function summarize(store: RunStore): RunSummary {
  const run = store.run
  return {
    runId: run.runId,
    projectId: run.projectId,
    planId: run.planId,
    mainGoal: run.mainGoal,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(run.stopReason !== undefined ? { stopReason: run.stopReason } : {}),
    tasks: store.tasks.length,
    artifacts: store.snapshot.artifacts.length,
    messages: store.snapshot.messages.length,
    events: store.events.length,
    ...(store.snapshot.integration ? { integrationStatus: store.snapshot.integration.status } : {})
  }
}

function parsePositiveInt(value: string | null, fallback: number, max: number, label: string): number {
  if (value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new TeamError('desktop-invalid-query', `${label} must be an integer in 0..${max}`)
  }
  return parsed
}

function parseMemoryView(value: string | null): MemoryView {
  const view = (value ?? 'rag') as MemoryView
  if (!MEMORY_VIEWS.includes(view)) {
    throw new TeamError('desktop-invalid-query', `view must be one of ${MEMORY_VIEWS.join(', ')}`)
  }
  return view
}

function terminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function externalReportsDir(project: ProjectPolicy, runId: string): string {
  return path.join(RunStore.runDir(project, runId), 'desktop-tests')
}

async function readExternalReports(project: ProjectPolicy, runId: string): Promise<ExternalTestReport[]> {
  const dir = externalReportsDir(project, runId)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const reports: ExternalTestReport[] = []
  for (const name of names.filter((candidate) => candidate.endsWith('.json')).slice(0, MAX_EXTERNAL_REPORTS)) {
    try {
      const raw = await readFile(path.join(dir, name), 'utf8')
      const parsed = JSON.parse(raw) as ExternalTestReport
      if (
        parsed &&
        parsed.schemaVersion === DESKTOP_CONTRACT_VERSION &&
        parsed.projectId === project.projectId &&
        parsed.runId === runId &&
        typeof parsed.reportId === 'string' &&
        Array.isArray(parsed.checks)
      ) {
        reports.push(parsed)
      }
    } catch {
      // A corrupt report must not take the whole test inbox down.
    }
  }
  return reports.sort((left, right) => left.receivedAt - right.receivedAt)
}

async function appendExternalReport(
  project: ProjectPolicy,
  runId: string,
  input: ExternalTestReportInput,
  task: TaskRecord | undefined,
  now: number
): Promise<ExternalTestReport> {
  const report: ExternalTestReport = {
    ...input,
    schemaVersion: DESKTOP_CONTRACT_VERSION,
    reportId: `desktop-test-${now.toString(36)}-${randomUUID().slice(0, 8)}`,
    projectId: project.projectId,
    runId,
    receivedAt: now,
    ...(task ? { ownerRole: task.role } : {})
  }
  const dir = externalReportsDir(project, runId)
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, `${report.reportId}.json`)
  const temporary = `${target}.tmp-${randomUUID().slice(0, 8)}`
  await writeFile(temporary, JSON.stringify(report, null, 2), 'utf8')
  await rename(temporary, target)
  return report
}

export async function startDesktopBridge(options: DesktopBridgeOptions): Promise<DesktopBridge> {
  const project = options.project
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? DESKTOP_BRIDGE_PORT
  const token = options.token
  const clock = options.clock ?? systemClock
  const artifactDir = options.artifactDir ?? ARTIFACT_DIR
  const artifacts = new ArtifactStore(project, { artifactDir, clock })
  const corsOrigin = options.corsOrigin
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TeamError('desktop-invalid-query', `port must be an integer in 0..65535, got ${String(port)}`)
  }
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  if (!loopback && !token) {
    throw new TeamError('desktop-insecure-bind', 'non-loopback desktop bridges require a bearer token')
  }

  const startedAt = clock.now()
  const stats: InternalStats = {
    startedAt,
    requests: 0,
    activeStreams: 0,
    streamsOpened: 0
  }
  const sseClients = new Set<ServerResponse>()
  let closed = false

  const openRun = async (runId: string): Promise<RunStore> => RunStore.open(project, runId, { clock })

  const authorized = (req: IncomingMessage): boolean => {
    if (!token) return true
    const header = req.headers.authorization
    const value = Array.isArray(header) ? header[0] ?? '' : header ?? ''
    const expected = `Bearer ${token}`
    const left = Buffer.from(value)
    const right = Buffer.from(expected)
    return left.length === right.length && timingSafeEqual(left, right)
  }

  const sendEnvelope = <T>(res: ServerResponse, status: number, kind: string, data: T, runId?: string): void => {
    sendJson(res, status, envelope(kind, project.projectId, data, runId, clock.now()))
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    stats.requests += 1
    res.setHeader('x-openfuture-contract-version', DESKTOP_CONTRACT_VERSION)
    if (corsOrigin) {
      res.setHeader('access-control-allow-origin', corsOrigin)
      res.setHeader('access-control-allow-headers', 'authorization, content-type')
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    }
    const method = (req.method ?? 'GET').toUpperCase()
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname
    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (pathname === '/v1/health') {
      if (method !== 'GET') throw new TeamError('desktop-method-not-allowed', 'health only supports GET')
      sendEnvelope(res, 200, 'health', {
        status: 'ok',
        contractVersion: DESKTOP_CONTRACT_VERSION,
        projectId: project.projectId,
        uptimeMs: Math.max(0, clock.now() - startedAt)
      })
      return
    }

    if (pathname === '/v1/contract') {
      if (method !== 'GET') throw new TeamError('desktop-method-not-allowed', 'contract only supports GET')
      sendEnvelope(res, 200, 'contract', contractManifest(port))
      return
    }

    if (!pathname.startsWith('/v1/')) {
      throw new TeamError('desktop-not-found', `unknown path ${pathname}`)
    }
    if (!authorized(req)) {
      throw new TeamError('desktop-unauthorized', 'missing or invalid bearer token')
    }

    let segments: string[]
    try {
      segments = pathname
        .split('/')
        .filter((segment) => segment.length > 0)
        .map((segment) => decodeURIComponent(segment))
    } catch {
      throw new TeamError('desktop-invalid-query', 'path contains invalid percent-encoding')
    }

    if (segments[0] !== 'v1') throw new TeamError('desktop-not-found', `unknown path ${pathname}`)

    if (method === 'GET' && segments.length === 2 && segments[1] === 'runs') {
      const limit = parsePositiveInt(url.searchParams.get('limit'), 50, MAX_RUN_LIST, 'limit')
      const metas = await RunStore.list(project)
      const runs: RunSummary[] = []
      for (const meta of metas.slice(0, limit)) {
        try {
          runs.push(summarize(await openRun(meta.runId)))
        } catch {
          // A corrupt run is skipped by the listing; explicit board access still
          // reports its precise error.
        }
      }
      sendEnvelope(res, 200, 'runs', { runs })
      return
    }

    if (method === 'GET' && segments.length === 2 && segments[1] === 'memory') {
      const view = parseMemoryView(url.searchParams.get('view'))
      const limit = parsePositiveInt(url.searchParams.get('limit'), 10, 50, 'limit')
      const metas = await RunStore.list(project)
      const results: RunResult[] = []
      for (const meta of metas.slice(0, limit)) {
        try {
          results.push(resultFromStore(await openRun(meta.runId)))
        } catch {
          // The project memory view is best-effort across recent runs.
        }
      }
      const memory = await buildProjectMemory(project, results, view, { artifactStore: artifacts, now: clock.now() })
      sendEnvelope(res, 200, 'memory', memory)
      return
    }

    if (segments[1] === 'runs' && segments.length >= 3) {
      const runId = segments[2] ?? ''
      if (!runId) throw new TeamError('desktop-not-found', 'run id is missing')

      if (method === 'GET' && segments.length === 4 && segments[3] === 'board') {
        const store = await openRun(runId)
        const board = buildBoard(resultFromStore(store, clock.now()), { now: clock.now() })
        sendEnvelope(res, 200, 'board', board, runId)
        return
      }

      if (method === 'GET' && segments.length === 4 && segments[3] === 'events') {
        const after = parsePositiveInt(url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER, 'after')
        const limit = parsePositiveInt(url.searchParams.get('limit'), 500, MAX_EVENT_PAGE, 'limit')
        const store = await openRun(runId)
        const all = store.events.filter((event) => event.seq > after)
        const events = all.slice(0, limit)
        const nextAfter = events.length > 0 ? events[events.length - 1]?.seq ?? after : after
        sendEnvelope(
          res,
          200,
          'events',
          {
            runId,
            after,
            events,
            nextAfter,
            hasMore: all.length > events.length,
            runStatus: store.run.status
          },
          runId
        )
        return
      }

      if (method === 'GET' && segments.length === 5 && segments[3] === 'events' && segments[4] === 'stream') {
        const headerAfter = req.headers['last-event-id']
        const afterValue = url.searchParams.get('after') ?? (typeof headerAfter === 'string' ? headerAfter : null)
        const after = parsePositiveInt(afterValue, 0, Number.MAX_SAFE_INTEGER, 'after')
        const follow = url.searchParams.get('follow') !== '0'
        await streamEvents(req, res, runId, after, follow)
        return
      }

      if (method === 'GET' && segments.length === 4 && segments[3] === 'artifacts') {
        const store = await openRun(runId)
        const latestByKind: Record<string, string> = {}
        for (const artifact of store.snapshot.artifacts) {
          const current = latestByKind[artifact.kind]
          if (!current) {
            latestByKind[artifact.kind] = artifact.id
            continue
          }
          const previous = store.snapshot.artifacts.find((candidate) => candidate.id === current)
          if (!previous || artifact.createdAt >= previous.createdAt) latestByKind[artifact.kind] = artifact.id
        }
        sendEnvelope(res, 200, 'artifacts', { artifacts: store.snapshot.artifacts, latestByKind }, runId)
        return
      }

      if (segments[3] === 'artifacts' && segments.length >= 5) {
        const artifactId = segments[4] ?? ''
        const store = await openRun(runId)
        const ref = store.snapshot.artifacts.find((candidate) => candidate.id === artifactId)
        if (!ref) throw new TeamError('artifact-not-found', `run ${runId} has no artifact ${artifactId}`)
        if (segments.length === 6 && segments[5] === 'content') {
          if (method !== 'GET') throw new TeamError('desktop-method-not-allowed', 'artifact content only supports GET')
          const buffer = await artifacts.read(ref)
          res.writeHead(200, {
            'content-type': ref.mediaType,
            'content-length': buffer.length,
            'cache-control': 'no-store',
            'x-artifact-sha256': ref.sha256,
            'x-artifact-version': ref.version,
            'x-artifact-kind': ref.kind,
            'content-disposition': `inline; filename="${ref.name.replace(/"/g, '')}"`
          })
          res.end(buffer)
          return
        }
        if (method !== 'GET') throw new TeamError('desktop-method-not-allowed', 'artifact metadata only supports GET')
        const verified = await artifacts.verify(ref).catch(() => false)
        sendEnvelope(res, 200, 'artifact', { ...ref, verified }, runId)
        return
      }

      if (method === 'GET' && segments.length === 4 && segments[3] === 'memory') {
        const view = parseMemoryView(url.searchParams.get('view'))
        const store = await openRun(runId)
        const memory = await buildRunMemory(resultFromStore(store, clock.now()), view, {
          artifactStore: artifacts,
          now: clock.now()
        })
        sendEnvelope(res, 200, 'memory', memory, runId)
        return
      }

      if (segments.length === 4 && segments[3] === 'tests') {
        if (method === 'GET') {
          const store = await openRun(runId)
          const artifactsForTests = store.snapshot.artifacts.filter((artifact) => artifact.kind === 'test-report')
          const reports = await readExternalReports(project, runId)
          const view: TestIntegrationView = {
            artifacts: artifactsForTests,
            reports,
            summary: {
              artifacts: artifactsForTests.length,
              reports: reports.length,
              passed: reports.filter((report) => report.status === 'passed').length,
              failed: reports.filter((report) => report.status === 'failed').length,
              blocked: reports.filter((report) => report.status === 'blocked').length
            }
          }
          sendEnvelope(res, 200, 'test-integration', view, runId)
          return
        }
        if (method === 'POST') {
          const raw = await readRequestBody(req)
          const input = parseTestReportInput(parseJsonBody(raw))
          const store = await openRun(runId)
          const task = input.taskId ? store.findTask(input.taskId) : undefined
          if (input.taskId && !task) throw new TeamError('unknown-task', `run ${runId} has no task ${input.taskId}`)
          const report = await appendExternalReport(project, runId, input, task, clock.now())
          sendEnvelope(res, 201, 'test-report', report, runId)
          return
        }
        throw new TeamError('desktop-method-not-allowed', 'tests supports GET and POST')
      }
    }

    throw new TeamError('desktop-not-found', `unknown path ${pathname}`)
  }

  const streamEvents = async (
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
    after: number,
    follow: boolean
  ): Promise<void> => {
    // Validate before sending SSE headers so a missing run is a normal 404.
    await openRun(runId)
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    sseClients.add(res)
    stats.activeStreams += 1
    stats.streamsOpened += 1
    let lastSeq = after
    let finished = false
    let timer: NodeJS.Timeout | undefined

    const cleanup = (): void => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      sseClients.delete(res)
      stats.activeStreams = Math.max(0, stats.activeStreams - 1)
    }
    const endStream = (status: string): void => {
      if (finished) return
      res.write(`event: stream.end\ndata: ${JSON.stringify({ runId, lastSeq, status })}\n\n`)
      cleanup()
      res.end()
    }
    req.on('close', cleanup)
    res.on('close', cleanup)

    const tick = async (): Promise<void> => {
      if (finished) return
      try {
        const store = await openRun(runId)
        const events = store.events.filter((event) => event.seq > lastSeq)
        for (const event of events) {
          if (finished) return
          res.write(`id: ${event.seq}\nevent: run-event\ndata: ${JSON.stringify(event)}\n\n`)
          lastSeq = event.seq
        }
        if (!follow) {
          endStream(store.run.status)
          return
        }
        if (terminalStatus(store.run.status) && events.length === 0) {
          endStream(store.run.status)
          return
        }
        timer = setTimeout(() => {
          void tick()
        }, 100)
      } catch (error) {
        if (finished) return
        res.write(
          `event: stream.error\ndata: ${JSON.stringify({
            runId,
            lastSeq,
            code: isTeamError(error) ? error.code : 'desktop-stream-error',
            message: errorMessage(error)
          })}\n\n`
        )
        cleanup()
        res.end()
      }
    }

    void tick()
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        try {
          res.end()
        } catch {
          // The client has already gone away.
        }
        return
      }
      const status = statusForError(error)
      const code = isTeamError(error) ? error.code : 'desktop-internal'
      const message = error instanceof Error ? error.message : String(error)
      const details = isTeamError(error) ? error.details : undefined
      sendError(res, status, code, message, details)
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(new TeamError('desktop-listen-failed', `cannot listen on ${host}:${port}: ${error.message}`))
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port
  const bridge: DesktopBridge = {
    host,
    port: actualPort,
    url: `http://${host === '::1' ? '[::1]' : host}:${actualPort}`,
    projectId: project.projectId,
    contractVersion: DESKTOP_CONTRACT_VERSION,
    stats: () => ({ ...stats }),
    close: async () => {
      if (closed) return
      closed = true
      for (const client of sseClients) {
        try {
          client.end()
        } catch {
          // Client already closed.
        }
      }
      sseClients.clear()
      stats.activeStreams = 0
      const drained = new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      server.closeAllConnections()
      await drained
    }
  }
  return bridge
}

export { contractManifest as desktopContractManifest }
