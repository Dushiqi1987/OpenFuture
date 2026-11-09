import assert from 'node:assert/strict'
import test from 'node:test'

import { errorCode } from '../src/core/errors.ts'
import { Inbox } from '../src/core/inbox.ts'
import { createSequentialIdFactory } from '../src/core/util.ts'

function makeInbox(): Inbox {
  return new Inbox({
    runId: 'run-inbox-test',
    projectId: 'project-inbox-test',
    idFactory: createSequentialIdFactory('inbox')
  })
}

function registerPair(inbox: Inbox): void {
  inbox.register({ agentId: 'agent-research', taskId: 'task-research', role: 'researcher' })
  inbox.register({ agentId: 'agent-backend', taskId: 'task-backend', role: 'backend' })
}

test('request/reply flow delivers a traceable message', async () => {
  const inbox = makeInbox()
  registerPair(inbox)

  const replyPromise = inbox.waitForMessages('agent-backend', { timeoutMs: 500, correlationId: 'corr-research' })
  const sent = inbox.send('agent-research', {
    toAgentId: 'agent-backend',
    clientMessageId: 'msg-1',
    correlationId: 'corr-research',
    type: 'reply',
    body: 'research complete'
  })

  assert.equal(sent.duplicate, false)
  const outcome = await replyPromise
  assert.equal(outcome.messages.length, 1)
  const delivered = outcome.messages[0]
  assert.ok(delivered)
  assert.equal(delivered.id, sent.message.id)
  assert.equal(delivered.correlationId, 'corr-research')
  assert.ok(delivered.deliveredAt)
  assert.equal(inbox.pendingCount('agent-backend'), 0)

  inbox.ack('agent-backend', delivered.id)
  assert.ok(inbox.list().find((message) => message.id === delivered.id)?.ackedAt)
})

test('duplicate clientMessageId is deduplicated and reported', () => {
  const inbox = makeInbox()
  registerPair(inbox)

  const input = {
    toAgentId: 'agent-backend',
    clientMessageId: 'stable-key',
    type: 'request' as const,
    body: 'please investigate'
  }
  const first = inbox.send('agent-research', input)
  const second = inbox.send('agent-research', input)

  assert.equal(first.duplicate, false)
  assert.equal(second.duplicate, true)
  assert.equal(second.message.id, first.message.id)
  assert.equal(second.message.duplicate, true)
  assert.equal(inbox.exportMessages().length, 1)
})

test('non-request messages require a correlation id', () => {
  const inbox = makeInbox()
  registerPair(inbox)

  assert.throws(
    () =>
      inbox.send('agent-backend', {
        toAgentId: 'agent-research',
        correlationId: '',
        type: 'reply',
        body: 'orphan reply'
      }),
    (error) => errorCode(error) === 'inbox-correlation-required'
  )
})

test('a role is ambiguous when more than one agent registered for it', () => {
  const inbox = makeInbox()
  inbox.register({ agentId: 'backend-a', taskId: 'task-a', role: 'backend' })
  inbox.register({ agentId: 'backend-b', taskId: 'task-b', role: 'backend' })
  inbox.register({ agentId: 'agent-research', taskId: 'task-research', role: 'researcher' })

  assert.throws(
    () => inbox.send('agent-research', { toRole: 'backend', type: 'request', body: 'who owns this?' }),
    (error) => errorCode(error) === 'inbox-ambiguous-role'
  )
})

test('an unregistered sender or target is rejected', () => {
  const inbox = makeInbox()
  registerPair(inbox)

  assert.throws(
    () =>
      inbox.send('ghost-agent', {
        toAgentId: 'agent-backend',
        type: 'request',
        body: 'cross-project message'
      }),
    (error) => errorCode(error) === 'inbox-unknown-sender'
  )

  assert.throws(
    () =>
      inbox.send('agent-research', {
        toAgentId: 'ghost-agent',
        type: 'request',
        body: 'wrong project target'
      }),
    (error) => errorCode(error) === 'inbox-unknown-target'
  )
})

test('waiting for a message times out with retryable inbox-timeout', async () => {
  const inbox = makeInbox()
  inbox.register({ agentId: 'agent-backend', taskId: 'task-backend', role: 'backend' })

  await assert.rejects(
    inbox.waitForMessages('agent-backend', { timeoutMs: 25, correlationId: 'never' }),
    (error) => errorCode(error) === 'inbox-timeout'
  )
  assert.equal(inbox.waitingAgentIds.length, 0)
})

test('mutual waits are rejected as a cycle', async () => {
  const inbox = makeInbox()
  registerPair(inbox)
  const abort = new AbortController()

  const first = inbox.waitForMessages('agent-research', {
    timeoutMs: 500,
    correlationId: 'research-corr',
    consumes: ['backend-corr'],
    issues: ['research-corr'],
    signal: abort.signal
  })
  const second = inbox.waitForMessages('agent-backend', {
    timeoutMs: 500,
    correlationId: 'backend-corr',
    consumes: ['research-corr'],
    issues: ['backend-corr']
  })

  await assert.rejects(second, (error) => errorCode(error) === 'inbox-wait-cycle')
  abort.abort()
  await assert.rejects(first, (error) => errorCode(error) === 'aborted' || errorCode(error) === 'inbox-wait-cycle')
  assert.equal(inbox.waitingAgentIds.length, 0)
})
