import assert from 'node:assert/strict'
import test from 'node:test'

import { buildBoard, formatBoard } from '../src/core/board.ts'
import { isTerminalTaskState } from '../src/core/types.ts'
import { makeSyntheticFixture } from './helpers.ts'

test('synthetic four-role run completes with dependency barriers, inbox trace and integrated evidence', async (t) => {
  const fixture = await makeSyntheticFixture()
  t.after(async () => await fixture.cleanup())

  const result = await fixture.runtime.run()

  assert.equal(result.status, 'completed')
  assert.equal(result.tasks.length, 4)
  assert.ok(result.durationMs >= 0)
  assert.ok(result.maxConcurrency >= 1 && result.maxConcurrency <= 3)
  assert.equal(result.integration?.status, 'passed')
  assert.ok(result.integration?.evidence.integrationRevision)
  assert.equal(result.integration?.evidence.files, 6)

  const research = result.tasks.find((task) => task.role === 'researcher')
  const backend = result.tasks.find((task) => task.role === 'backend')
  const frontend = result.tasks.find((task) => task.role === 'frontend')
  const tester = result.tasks.find((task) => task.role === 'tester')
  assert.ok(research && backend && frontend && tester)

  assert.equal(research.state, 'succeeded')
  assert.equal(backend.state, 'integrated')
  assert.equal(frontend.state, 'integrated')
  assert.equal(tester.state, 'succeeded')
  assert.equal(backend.integratedAt !== undefined, true)
  assert.equal(frontend.integratedAt !== undefined, true)
  for (const task of result.tasks) assert.equal(isTerminalTaskState(task.state), true)

  assert.ok(backend.startedAt !== undefined && backend.finishedAt !== undefined)
  assert.ok(frontend.startedAt !== undefined && frontend.finishedAt !== undefined)
  assert.ok(tester.startedAt !== undefined)
  assert.ok(research.startedAt !== undefined && research.finishedAt !== undefined)

  // Research and backend are ready together: their execution windows overlap.
  assert.ok(backend.startedAt <= research.finishedAt, 'backend starts before research finishes')
  assert.ok(research.startedAt <= backend.finishedAt, 'research overlaps backend')
  // Frontend waits for the backend artifact/contract.
  assert.ok(frontend.startedAt >= backend.finishedAt, 'frontend starts after backend finishes')
  assert.ok(frontend.dependsOn.includes(backend.id))
  // The independent integration gate runs before the tester.
  assert.ok(result.integration?.finishedAt !== undefined)
  assert.ok(tester.startedAt >= result.integration.finishedAt, 'tester starts after integration gate')

  const request = result.messages.find(
    (message) => message.type === 'request' && message.fromRole === 'backend' && message.toRole === 'researcher'
  )
  assert.ok(request, 'backend sent a research request')
  const reply = result.messages.find(
    (message) => message.type === 'reply' && message.fromRole === 'researcher' && message.toRole === 'backend'
  )
  assert.ok(reply, 'researcher replied')
  assert.equal(reply.correlationId, request.correlationId)
  assert.ok(reply.body.length > 0)
  const researchArtifact = research.producedArtifacts.find((artifact) => artifact.name === 'research-report')
  assert.ok(researchArtifact)
  assert.ok(reply.artifactRefs.includes(researchArtifact.id))
  const reportText = await fixture.runtime.artifacts.readText(researchArtifact)
  assert.match(reportText, /https:\/\//)
  assert.ok(request.correlationId.length > 0)

  for (const task of result.tasks) {
    for (const ref of task.producedArtifacts) {
      const text = await fixture.runtime.artifacts.readText(ref)
      assert.ok(text.length > 0, `${ref.name} has content`)
      assert.equal(await fixture.runtime.artifacts.verify(ref), true)
    }
  }

  assert.equal(result.events[0]?.type, 'run.created')
  assert.ok(result.events.some((event) => event.type === 'run.completed'))
  assert.ok(result.events.some((event) => event.type === 'integration.passed'))
  assert.ok(result.events.some((event) => event.type === 'inbox.delivered'))
  for (let index = 1; index < result.events.length; index += 1) {
    assert.equal(result.events[index]?.seq, (result.events[index - 1]?.seq ?? 0) + 1)
  }

  const board = buildBoard(result)
  assert.equal(board.summary.total, 4)
  assert.equal(board.traceability.length, 4)
  assert.equal(board.lanes.length, 4)
  assert.equal(board.summary.integrated, 2)
  assert.equal(board.summary.failed, 0)
  const rendered = formatBoard(board)
  assert.match(rendered, /Traceability|可追溯/i)
  assert.match(rendered, /researcher/)
  assert.match(rendered, /tester/)
})
