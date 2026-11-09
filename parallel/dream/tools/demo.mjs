/**
 * End-to-end demo for the Dreaming worker prototype.
 *
 * It starts the deterministic mock model on the loopback test port, creates an
 * isolated temporary version store and evidence registry, and walks the B3
 * acceptance path. It never touches the real application data directory and
 * never publishes without an explicit approval token.
 *
 * Usage: node tools/demo.mjs
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DreamingPipeline,
  EvidenceRegistry,
  FileDreamStore,
  ModelClient,
  PROJECT_ID,
  SESSION_1_ID,
  SYNTHETIC_BASE_TIME,
  buildSyntheticInputs,
  startMockModelServer
} from '../src/index.mjs'

const actor = 'demo-publisher@local.invalid'
const base = SYNTHETIC_BASE_TIME
let tick = 0
const clock = () => base + (tick += 1000)

function line(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }))
}

const root = await mkdtemp(join(tmpdir(), 'dreaming-worker-demo-'))
let server
let pipeline
try {
  server = await startMockModelServer()
  line('mock-model', {
    port: server.port,
    url: server.url,
    tokenLength: server.token.length,
    token: '<runtime fake bearer token>'
  })

  const store = new FileDreamStore({ root, clock })
  const registry = new EvidenceRegistry(PROJECT_ID)
  const policyState = { revokedSourceIds: [] }
  const policyProvider = async ({ projectId }) => ({
    authorized: projectId === PROJECT_ID,
    projectId,
    revokedSourceIds: [...policyState.revokedSourceIds]
  })
  const model = new ModelClient({
    baseUrl: server.url,
    token: server.token,
    timeoutMs: 5000,
    name: 'demo-http-heuristic'
  })
  pipeline = new DreamingPipeline({
    store,
    registry,
    model,
    policyProvider,
    l3Budget: { maxLines: 40, maxBytes: 4096, maxTokens: 800 },
    maxDeleteRatio: 0.5,
    maxAttempts: 2,
    sleep: async () => {},
    backoffMs: 1,
    clock,
    originalsDir: join(root, 'originals')
  })

  const fixture = buildSyntheticInputs()
  line('isolation', { root: '<temporary directory>', projectId: PROJECT_ID, freshRevision: (await store.getActive(PROJECT_ID)).revision })

  const first = await pipeline.start({
    projectId: PROJECT_ID,
    sessions: [fixture.sessions[0]],
    materials: fixture.materials,
    trigger: 'manual'
  })
  line('round-1', {
    jobId: first.id,
    status: first.status,
    error: first.error,
    planStatus: first.plan?.status ?? null,
    ops: first.plan?.ops.length ?? null,
    rejectedOps: first.plan?.rejectedOps.length ?? null,
    candidates: first.plan?.candidates.length ?? null,
    degraded: first.degraded,
    activeRevision: (await store.getActive(PROJECT_ID)).revision
  })
  if (first.status !== 'review' || first.plan.status !== 'pending-approval') {
    throw new Error(`first round did not stop for approval: ${first.status}/${first.plan.status}`)
  }

  const published1 = await pipeline.publish(first.id, {
    approvedBy: actor,
    approvalToken: first.plan.planHash
  })
  const l3AfterFirst = await pipeline.getL3(PROJECT_ID)
  line('publish-1', {
    status: published1.status,
    revision: published1.version.revision,
    verificationOk: published1.verification.ok,
    l3: l3AfterFirst.text
  })

  const answer1 = await pipeline.answer({ projectId: PROJECT_ID, query: 'review queue' })
  line('answer-1', {
    matched: answer1.matched,
    answer: answer1.answer,
    citationsOk: answer1.citationCheck.ok
  })

  const second = await pipeline.start({
    projectId: PROJECT_ID,
    sessions: [fixture.sessions[0], fixture.sessions[1]],
    materials: [],
    trigger: 'manual'
  })
  const conflicts = second.plan.conflicts.map((conflict) => ({
    subject: conflict.subject,
    status: conflict.status,
    values: [...new Set(conflict.sides.map((side) => side.value))]
  }))
  line('round-2', {
    jobId: second.id,
    status: second.status,
    planStatus: second.plan.status,
    ops: second.plan.ops.length,
    conflicts,
    degraded: second.degraded
  })
  if (second.status !== 'review' || second.plan.status !== 'pending-approval') {
    throw new Error(`second round did not stop for approval: ${second.status}/${second.plan.status}`)
  }

  const published2 = await pipeline.publish(second.id, {
    approvedBy: actor,
    approvalToken: second.plan.planHash
  })
  const l3AfterSecond = await pipeline.getL3(PROJECT_ID)
  const answer2 = await pipeline.answer({ projectId: PROJECT_ID, query: 'review queue' })
  line('publish-2', {
    status: published2.status,
    revision: published2.version.revision,
    answer: answer2.answer,
    citationsOk: answer2.citationCheck.ok,
    l3: l3AfterSecond.text
  })

  const revokedSourceId = `session:${SESSION_1_ID}`
  registry.revokeSource(revokedSourceId, { at: clock(), reason: 'synthetic demo revocation' })
  policyState.revokedSourceIds.push(revokedSourceId)
  const verification = await pipeline.verifyProject(PROJECT_ID)
  const l3AfterRevoke = await pipeline.getL3(PROJECT_ID)
  line('revoke-source-1', {
    verifyOk: verification.ok,
    invalidated: verification.invalidated.length,
    l3: l3AfterRevoke.text
  })

  const rollback = await pipeline.rollback({
    projectId: PROJECT_ID,
    toRevision: 2,
    approvedBy: actor,
    reason: 'synthetic demo rollback after revocation'
  })
  const l3AfterRollback = await pipeline.getL3(PROJECT_ID)
  line('rollback', {
    status: rollback.status,
    revision: rollback.version.revision,
    kind: rollback.version.kind,
    excluded: rollback.excluded.length,
    l3: l3AfterRollback.text
  })

  const audit = await store.readAudit(PROJECT_ID)
  line('audit', {
    actions: audit.map((event) => `${event.action}:r${event.revision}`)
  })
  line('demo-ok', { note: 'review -> approval -> publish -> revoke -> rollback completed' })
} finally {
  if (pipeline) await pipeline.close()
  if (server) await server.close()
  await rm(root, { recursive: true, force: true })
}
