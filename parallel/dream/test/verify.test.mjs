import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROJECT_ID,
  buildL3Snapshot,
  ingest,
  renderL3,
  validateCandidates,
  verifyPublishedVersion
} from '../src/index.mjs'
import { makeEnv, runJob, publishJob } from './helpers.mjs'

test('candidate validation rejects fabricated evidence and cross-project references', async (t) => {
  const env = await makeEnv()
  t.after(() => env.cleanup())
  ingest({ registry: env.registry, projectId: PROJECT_ID, sessions: [env.fixture.sessions[0]], materials: [] })
  const extracted = await env.model.extract({
    projectId: PROJECT_ID,
    evidence: env.registry.listEvidence({ includeQuarantined: false })
  })
  assert.ok(extracted.candidates.length >= 3)
  const raw = structuredClone(extracted.candidates)
  const fabricated = structuredClone(raw[0])
  fabricated.evidenceIds = ['ev_fabricated_candidate']
  const validated = validateCandidates({
    projectId: PROJECT_ID,
    registry: env.registry,
    rawCandidates: [fabricated, ...raw],
    now: Date.now()
  })
  assert.ok(validated.rejected.length >= 1)
  assert.ok(validated.rejected.some((candidate) => candidate.code === 'EVIDENCE_UNKNOWN'))
  assert.ok(validated.candidates.length >= 3)
  for (const candidate of validated.candidates) {
    assert.equal(candidate.projectId, PROJECT_ID)
    assert.ok(candidate.evidenceIds.every((id) => !id.includes('fabricated')))
  }
})

test('verifyPublishedVersion flags stale evidence after a source revision changes', async (t) => {
  const env = await makeEnv()
  t.after(() => env.cleanup())
  const job = await runJob(env, { sessions: [env.fixture.sessions[0]], materials: [] })
  await publishJob(env, job)
  const before = await env.pipeline.verifyProject(PROJECT_ID)
  assert.equal(before.ok, true)

  const changed = structuredClone(env.fixture.sessions[0])
  changed.messages.find((message) => message.id === 'm1-preference').text =
    'I prefer review queue to be local-first. (edited)'
  ingest({ registry: env.registry, projectId: PROJECT_ID, sessions: [changed], materials: [] })

  const after = await env.pipeline.verifyProject(PROJECT_ID)
  assert.equal(after.ok, false)
  assert.ok(after.invalidated.length > 0)
  const l3 = await env.pipeline.getL3(PROJECT_ID)
  assert.equal(l3.text.includes('review queue'), false)

  const tampered = structuredClone(await env.active())
  tampered.entries[0].assertionRefs = [
    { ...tampered.entries[0].assertionRefs[0], evidenceId: 'ev_fabricated_in_published' }
  ]
  const report = verifyPublishedVersion({ projectId: PROJECT_ID, registry: env.registry, version: tampered })
  assert.equal(report.ok, false)
  assert.ok(report.issues.some((issue) => issue.code === 'EVIDENCE_UNKNOWN'))
})

test('L3 enforces lines, bytes and tokens and refuses to truncate silently', () => {
  const entries = Array.from({ length: 6 }, (_, index) => ({
    id: `mem_test_${index}`,
    projectId: PROJECT_ID,
    type: 'preference',
    subject: `subject ${index}`,
    value: `value ${index} ${'x'.repeat(40)}`,
    promoted: true
  }))
  const budget = { maxLines: 3, maxBytes: 4096, maxTokens: 800 }
  const rendered = renderL3(entries, budget)
  assert.equal(rendered.ok, false)
  assert.equal(rendered.truncated, true)
  assert.ok(rendered.stats.lines <= 3)
  assert.ok(rendered.entries.length < entries.length)
  assert.ok(rendered.hash)

  assert.throws(
    () => buildL3Snapshot(entries, budget),
    (error) => error.code === 'L3_BUDGET'
  )

  const byteLimited = renderL3(entries, { maxLines: 40, maxBytes: 80, maxTokens: 800 })
  assert.equal(byteLimited.ok, false)
  assert.ok(byteLimited.stats.bytes <= 80)

  const tokenLimited = renderL3(entries, { maxLines: 40, maxBytes: 4096, maxTokens: 10 })
  assert.equal(tokenLimited.ok, false)
  assert.ok(tokenLimited.stats.tokens <= 10)
})
