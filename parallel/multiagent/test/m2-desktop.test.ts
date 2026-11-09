import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import test, { after, before } from 'node:test'

import type { RunBoard } from '../src/core/board.ts'
import type { ArtifactRef, RunEvent } from '../src/core/types.ts'
import { startDesktopBridge, type DesktopBridge } from '../src/desktop/server.ts'
import type {
  ContractManifest,
  ExternalTestReport,
  ProjectMemoryView,
  RunMemoryView,
  RunSummary,
  TestIntegrationView
} from '../src/desktop/types.ts'
import { makeSyntheticFixture, type SyntheticFixture } from './helpers.ts'

const TOKEN = 'm2-desktop-test-token'
const PORT = 19744

let fixture: SyntheticFixture
let bridge: DesktopBridge
let baseUrl: string
let runId: string
let testerTaskId: string

interface ApiEnvelope<T> {
  schemaVersion: string
  kind: string
  projectId: string
  runId?: string
  generatedAt: number
  data: T
}

interface ApiError {
  schemaVersion: string
  kind: 'error'
  generatedAt: number
  error: { code: string; message: string }
}

type ApiBody<T> = ApiEnvelope<T> | ApiError

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra }
}

async function fetchJson<T>(
  pathname: string,
  options: { auth?: boolean; method?: string; body?: unknown } = {}
): Promise<{ status: number; body: ApiBody<T> }> {
  const headers = options.auth === false ? {} : authHeaders()
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
  })
  return { status: response.status, body: (await response.json()) as ApiBody<T> }
}

function expectData<T>(body: ApiBody<T>): T {
  assert.ok(!('error' in body), `unexpected error response: ${JSON.stringify(body)}`)
  return body.data
}

before(async () => {
  fixture = await makeSyntheticFixture({ project: { projectId: 'project-desktop-bridge-test' } })
  runId = fixture.plan.runId
  testerTaskId = fixture.plan.tasks.find((task) => task.role === 'tester')?.id ?? ''
  assert.ok(testerTaskId, 'synthetic plan must contain a tester task')
  await fixture.runtime.run()
  bridge = await startDesktopBridge({
    project: fixture.project,
    port: PORT,
    token: TOKEN
  })
  baseUrl = bridge.url
})

after(async () => {
  await bridge?.close()
  await fixture?.cleanup()
})

test('contract and health endpoints are public and versioned', async () => {
  const health = await fetchJson<{ status: string; contractVersion: string }>('/v1/health', { auth: false })
  assert.equal(health.status, 200)
  assert.equal(health.body.schemaVersion, '1.0')
  const healthData = expectData(health.body)
  assert.equal(healthData.status, 'ok')
  assert.equal(healthData.contractVersion, '1.0')

  const contract = await fetchJson<ContractManifest>('/v1/contract', { auth: false })
  assert.equal(contract.status, 200)
  const manifest = expectData(contract.body)
  assert.equal(manifest.contractVersion, '1.0')
  assert.ok(manifest.capabilities.includes('board.traceability'))
  assert.ok(manifest.endpoints.some((endpoint) => endpoint.path === '/v1/runs/:runId/tests' && endpoint.method === 'POST'))
})

test('data endpoints require the bearer token when configured', async () => {
  const unauthorized = await fetchJson<RunSummary[]>('/v1/runs', { auth: false })
  assert.equal(unauthorized.status, 401)
  assert.ok('error' in unauthorized.body)
  assert.equal(unauthorized.body.error.code, 'desktop-unauthorized')
})

test('runs and board expose traceable task state', async () => {
  const runs = await fetchJson<{ runs: RunSummary[] }>('/v1/runs')
  assert.equal(runs.status, 200)
  const list = expectData(runs.body).runs
  const summary = list.find((candidate) => candidate.runId === runId)
  assert.ok(summary)
  assert.equal(summary.tasks, 4)
  assert.equal(summary.status, 'completed')

  const boardResponse = await fetchJson<RunBoard>(`/v1/runs/${runId}/board`)
  assert.equal(boardResponse.status, 200)
  const board = expectData(boardResponse.body)
  const boardTasks = board.lanes.flatMap((lane) => lane.tasks)
  assert.equal(boardTasks.length, 4)
  assert.equal(board.traceability.length, 4)
  assert.equal(board.summary.integrated, 2)
  assert.ok(boardTasks.some((task) => task.role === 'tester' && task.state === 'succeeded'))
  assert.ok(boardTasks.filter((task) => task.role === 'backend' || task.role === 'frontend').every((task) => task.integratedAt !== undefined))
})

test('events replay after a sequence and SSE replay closes cleanly', async () => {
  const first = await fetchJson<{ events: RunEvent[]; nextAfter: number; runStatus: string }>(
    `/v1/runs/${runId}/events?after=0&limit=10`
  )
  assert.equal(first.status, 200)
  const page = expectData(first.body)
  assert.equal(page.events[0]?.seq, 1)
  assert.equal(page.nextAfter, page.events[page.events.length - 1]?.seq)
  assert.equal(page.runStatus, 'completed')

  const second = await fetchJson<{ events: RunEvent[] }>(`/v1/runs/${runId}/events?after=${page.nextAfter}`)
  const later = expectData(second.body).events
  assert.ok(later.every((event) => event.seq > page.nextAfter))

  const sse = await fetch(`${baseUrl}/v1/runs/${runId}/events/stream?after=0&follow=0`, {
    headers: authHeaders({ accept: 'text/event-stream' })
  })
  assert.equal(sse.status, 200)
  assert.match(sse.headers.get('content-type') ?? '', /text\/event-stream/)
  const text = await sse.text()
  assert.match(text, /^id: 1$/m)
  assert.match(text, /event: run-event/)
  assert.match(text, /event: stream\.end/)

  const resumed = await fetch(`${baseUrl}/v1/runs/${runId}/events/stream?follow=0`, {
    headers: authHeaders({ accept: 'text/event-stream', 'last-event-id': '1' })
  })
  assert.equal(resumed.status, 200)
  const resumedText = await resumed.text()
  assert.doesNotMatch(resumedText, /^id: 1$/m)
  assert.match(resumedText, /^id: 2$/m)
})

test('artifact metadata and content are hash-verified', async () => {
  const list = await fetchJson<{ artifacts: ArtifactRef[] }>(`/v1/runs/${runId}/artifacts`)
  assert.equal(list.status, 200)
  const artifacts = expectData(list.body).artifacts
  assert.ok(artifacts.length >= 1)
  const artifact = artifacts[0]
  assert.ok(artifact)
  assert.ok(artifact.version.length > 0)

  const metadata = await fetchJson<ArtifactRef & { verified: boolean }>(
    `/v1/runs/${runId}/artifacts/${artifact.id}`
  )
  assert.equal(metadata.status, 200)
  assert.equal(expectData(metadata.body).verified, true)

  const content = await fetch(`${baseUrl}/v1/runs/${runId}/artifacts/${artifact.id}/content`, {
    headers: authHeaders()
  })
  assert.equal(content.status, 200)
  const bytes = Buffer.from(await content.arrayBuffer())
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256)
})

test('memory views are curated, traceable and support off', async () => {
  const rag = await fetchJson<RunMemoryView>(`/v1/runs/${runId}/memory?view=rag`)
  assert.equal(rag.status, 200)
  const memory = expectData(rag.body)
  assert.equal(memory.view, 'rag')
  assert.ok(memory.entries.some((entry) => entry.kind === 'goal' && entry.text.length > 0))
  assert.ok(memory.entries.some((entry) => entry.kind === 'question' && entry.refs.some((ref) => ref.kind === 'task')))
  assert.ok(memory.entries.some((entry) => entry.kind === 'artifact' && entry.sha256))
  assert.ok(memory.entries.every((entry) => !entry.text.includes('Bearer ')))

  const off = await fetchJson<RunMemoryView>(`/v1/runs/${runId}/memory?view=off`)
  assert.equal(expectData(off.body).entries.length, 0)

  const project = await fetchJson<ProjectMemoryView>('/v1/memory?view=rag')
  assert.equal(project.status, 200)
  const projectMemory = expectData(project.body)
  assert.ok(projectMemory.runs.includes(runId))
  assert.ok(projectMemory.entries.some((entry) => entry.runId === runId && entry.kind === 'question'))
})

test('external test reports are validated, persisted and listed', async () => {
  const initial = await fetchJson<TestIntegrationView>(`/v1/runs/${runId}/tests`)
  assert.equal(initial.status, 200)
  const initialView = expectData(initial.body)
  assert.ok(initialView.artifacts.some((artifact) => artifact.kind === 'test-report'))

  const invalid = await fetchJson<unknown>(`/v1/runs/${runId}/tests`, {
    method: 'POST',
    body: { name: 'bad', status: 'green', checks: [] }
  })
  assert.equal(invalid.status, 400)
  assert.ok('error' in invalid.body)
  assert.equal(invalid.body.error.code, 'desktop-invalid-body')

  const created = await fetchJson<ExternalTestReport>(`/v1/runs/${runId}/tests`, {
    method: 'POST',
    body: {
      taskId: testerTaskId,
      name: 'desktop acceptance suite',
      framework: 'external-ci',
      status: 'passed',
      checks: [
        { id: 'board-contract', status: 'passed' },
        { id: 'artifact-hash', status: 'passed', detail: 'sha256 verified' }
      ],
      startedAt: Date.now() - 50,
      finishedAt: Date.now(),
      evidence: ['desktop contract smoke']
    }
  })
  assert.equal(created.status, 201)
  const report = expectData(created.body)
  assert.equal(report.ownerRole, 'tester')
  assert.equal(report.runId, runId)
  assert.equal(report.checks.length, 2)

  const listed = await fetchJson<TestIntegrationView>(`/v1/runs/${runId}/tests`)
  const view = expectData(listed.body)
  assert.ok(view.reports.some((candidate) => candidate.reportId === report.reportId))
  assert.equal(view.summary.passed, 1)

  const files = await readdir(path.join(fixture.root, '.runtime', 'runs', runId, 'desktop-tests'))
  assert.ok(files.some((file) => file.startsWith(report.reportId) && file.endsWith('.json')))
})

test('unknown runs return a typed 404', async () => {
  const missing = await fetchJson<unknown>('/v1/runs/does-not-exist/board')
  assert.equal(missing.status, 404)
  assert.ok('error' in missing.body)
  assert.equal(missing.body.error.code, 'run-not-found')
})
