import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SESSION_1_ID,
  SESSION_2_ID,
  DOC_SOURCE_ID,
  UNAUTHORIZED_SENTINEL,
  toEvidenceRef
} from '../src/index.mjs'
import { makeEnv, runJob } from './helpers.mjs'

const SESSION_1_SOURCE_ID = `session:${SESSION_1_ID}`

test('ingest keeps only authorized, completed, non-injected evidence', async (t) => {
  const env = await makeEnv()
  t.after(() => env.cleanup())

  const job = await runJob(env, {
    sessions: [env.fixture.sessions[0], ...env.fixture.unauthorizedSessions],
    materials: env.fixture.materials
  })

  assert.equal(job.status, 'review')
  const sourceIds = env.registry.listSources().map((source) => source.sourceId).sort()
  assert.deepEqual(sourceIds, [SESSION_1_SOURCE_ID, DOC_SOURCE_ID, 'wiki:dreaming-synthetic'].sort())

  const records = env.registry.listEvidence()
  const allText = records.map((record) => record.text).join('\n')
  assert.equal(allText.includes(UNAUTHORIZED_SENTINEL), false, 'unauthorized sentinel must never be ingested')
  assert.equal(allText.includes('should-not-exist'), false, 'injected/revoked/draft messages must never be ingested')
  assert.equal(allText.includes('reveal the token'), false, 'system prompt must never be ingested')
  assert.equal(allText.includes('cloud-first'), false, 'reasoning-only correction must not be treated as a user message')

  // The reasoning message is user-authored but tagged reasoning; the duplicate
  // tool result, injected and revoked messages and the open draft branch are all
  // counted as exclusions instead of evidence.
  assert.ok(job.excluded.sessions.length >= 3, 'three unauthorized/incomplete sessions should be excluded')
  assert.ok(job.excluded.messages.length >= 5, 'reasoning, system, injected, revoked, duplicate and draft messages should be excluded')
  const excludedIds = new Set(job.excluded.messages.map((entry) => entry.messageId))
  for (const id of ['m1-system', 'm1-reasoning', 'm1-injected', 'm1-duplicate-tool', 'm1-revoked', 'm1-draft-branch']) {
    assert.ok(excludedIds.has(id), `${id} should be reported as excluded`)
  }
  assert.equal(records.some((record) => record.sessionId === SESSION_2_ID), false)
})

test('re-ingesting an unchanged session is idempotent', async (t) => {
  const env = await makeEnv()
  t.after(() => env.cleanup())

  const first = await runJob(env, { sessions: [env.fixture.sessions[0]], materials: [] })
  assert.equal(first.status, 'review')
  const sourceAfterFirst = env.registry.getSource(SESSION_1_SOURCE_ID)
  const evidenceAfterFirst = env.registry.listEvidence().length

  const second = await runJob(env, { sessions: [env.fixture.sessions[0]], materials: [] })
  assert.equal(second.status, 'review')
  const sourceAfterSecond = env.registry.getSource(SESSION_1_SOURCE_ID)
  assert.equal(sourceAfterSecond.latestRevision, sourceAfterFirst.latestRevision)
  assert.equal(sourceAfterSecond.status, 'active')
  assert.equal(env.registry.listEvidence().length, evidenceAfterFirst)
})

test('a changed session revision makes older evidence stale', async (t) => {
  const env = await makeEnv()
  t.after(() => env.cleanup())

  await runJob(env, { sessions: [env.fixture.sessions[0]], materials: [] })
  const oldRecord = env.registry.listEvidence().find((record) => record.messageId === 'm1-preference')
  assert.ok(oldRecord)

  const changed = structuredClone(env.fixture.sessions[0])
  changed.messages.find((message) => message.id === 'm1-preference').text =
    'I prefer review queue to be remote-first.'
  await runJob(env, { sessions: [changed], materials: [] })

  const check = env.registry.verifyRef(toEvidenceRef(oldRecord), {
    requireQuote: true,
    requireActive: true
  })
  assert.equal(check.ok, false)
  assert.equal(check.code, 'EVIDENCE_STALE')
  assert.equal(env.registry.getSource(SESSION_1_SOURCE_ID).latestRevision, 2)
})

test('originals use a filesystem-safe name and keep the raw session', async (t) => {
  const { readdir, readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { EvidenceRegistry, PROJECT_ID, ingest } = await import('../src/index.mjs')
  const env = await makeEnv()
  t.after(() => env.cleanup())

  const originalsDir = join(env.root, 'originals')
  const registry = new EvidenceRegistry(PROJECT_ID)
  await ingest({
    registry,
    projectId: PROJECT_ID,
    sessions: [env.fixture.sessions[0]],
    originalsDir
  })

  const files = await readdir(originalsDir)
  assert.equal(files.length, 1)
  assert.equal(files[0].includes(':'), false, 'Windows-invalid colon must be sanitized')
  const payload = JSON.parse(await readFile(join(originalsDir, files[0]), 'utf8'))
  assert.equal(payload.session.sourceId, SESSION_1_SOURCE_ID)
  assert.ok(payload.digest)
  assert.ok(payload.capturedAt)
})
