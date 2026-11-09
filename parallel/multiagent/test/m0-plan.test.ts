import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SuperAgent,
  createSyntheticPlan,
  defaultProjectPolicy,
  validatePlan
} from '../src/core/plan.ts'
import { DEFAULT_ROLE_CARDS, matchesScope, resolveAllPermissions } from '../src/core/roles.ts'
import type { Plan } from '../src/core/types.ts'
import { createSequentialIdFactory } from '../src/core/util.ts'

const clock = { now: () => 1_700_000_000_000 }

function planner(prefix = 'plan-test'): SuperAgent {
  return new SuperAgent({ idFactory: createSequentialIdFactory(prefix), clock })
}

function issueCodes(plan: Plan, project = defaultProjectPolicy()): string[] {
  return validatePlan(plan, project).issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code)
}

test('a single work question is routed to one agent', () => {
  const project = defaultProjectPolicy()
  const decision = planner().plan({
    project,
    mode: 'auto',
    questions: [{ id: 'q1', index: 0, text: '修复后端 /api/settings 的 500 错误' }]
  })

  assert.equal(decision.route, 'single-agent')
  assert.match(decision.reason, /单 Agent/)
  assert.equal(decision.plan, undefined)
})

test('a single pure question stays single-agent in auto mode', () => {
  const project = defaultProjectPolicy()
  const decision = planner().plan({
    project,
    mode: 'auto',
    questions: [{ id: 'q1', index: 0, text: '这个项目支持哪些部署方式？' }]
  })

  assert.equal(decision.route, 'single-agent')
})

test('multi-question planning is traceable from questions to tasks', () => {
  const { plan, validation } = createSyntheticPlan()

  assert.equal(validation.ok, true, JSON.stringify(validation.issues, null, 2))
  assert.equal(plan.tasks.length, 4)
  assert.equal(plan.intents.length, 4)

  for (const question of plan.sourceQuestions) {
    const intents = plan.intents.filter((intent) => intent.sourceQuestionIds.includes(question.id))
    assert.equal(intents.length, 1, `question ${question.id} must map to exactly one intent`)
    const intent = intents[0]
    assert.ok(intent)
    assert.equal(intent.sourceQuestionIds.length, 1)
    assert.deepEqual(intent.taskIds, plan.tasks.filter((task) => task.intentId === intent.id).map((task) => task.id))
  }

  const taskIds = new Set(plan.tasks.map((task) => task.id))
  for (const task of plan.tasks) {
    assert.ok(plan.intents.some((intent) => intent.id === task.intentId), `${task.id} has a known intent`)
    for (const dependency of task.dependsOn) {
      assert.ok(taskIds.has(dependency), `${task.id} depends on ${dependency}, which exists`)
    }
  }

  const backend = plan.tasks.filter((task) => task.role === 'backend').map((task) => task.id)
  const frontend = plan.tasks.find((task) => task.role === 'frontend')
  const tester = plan.tasks.find((task) => task.role === 'tester')
  assert.ok(frontend)
  assert.ok(tester)
  for (const backendId of backend) assert.ok(frontend.dependsOn.includes(backendId))
  for (const task of plan.tasks) {
    if (task.role !== 'tester') assert.ok(tester.dependsOn.includes(task.id))
  }
})

test('project policy trims tool, memory and write permissions per role', () => {
  const project = defaultProjectPolicy({
    allowResearchNetwork: false,
    memoryViews: ['off', 'rag'],
    allowedWritePaths: ['contracts/**']
  })
  const permissions = resolveAllPermissions(project, DEFAULT_ROLE_CARDS)

  assert.equal(permissions.researcher.tools.includes('network'), false)
  assert.equal(permissions.researcher.memoryView, 'rag')
  assert.equal(permissions.tester.integrationOnly, true)
  assert.deepEqual(permissions.tester.writeScopes, [])
  for (const role of ['researcher', 'backend', 'frontend', 'tester'] as const) {
    for (const scope of permissions[role].writeScopes) {
      assert.ok(matchesScope('contracts/**', scope), `${role} write scope ${scope} stays inside contracts/**`)
    }
  }
  assert.deepEqual(permissions.backend.writeScopes, ['contracts/**'])
})

test('a read-only tester cannot declare a write scope', () => {
  const { plan, project } = createSyntheticPlan()
  const bad = structuredClone(plan)
  const tester = bad.tasks.find((task) => task.role === 'tester')
  assert.ok(tester)
  tester.writeScope = ['src/server/**']

  const validation = validatePlan(bad, project)
  assert.equal(validation.ok, false)
  assert.ok(validation.issues.some((issue) => issue.code === 'write-scope-forbidden' && issue.severity === 'error'))
})

test('a write scope outside the role policy is rejected', () => {
  const { plan, project } = createSyntheticPlan()
  const bad = structuredClone(plan)
  const backend = bad.tasks.find((task) => task.role === 'backend')
  assert.ok(backend)
  backend.writeScope = ['src/outside/**']

  const codes = issueCodes(bad, project)
  assert.ok(codes.includes('write-outside-policy'), codes.join(','))
})

test('a memory view outside the project policy is rejected', () => {
  const { plan } = createSyntheticPlan()
  const project = defaultProjectPolicy({ memoryViews: ['off'] })
  const codes = issueCodes(plan, project)
  assert.ok(codes.includes('memory-denied'), codes.join(','))
})

test('removing the test tool from the policy is rejected for the tester role', () => {
  const { plan } = createSyntheticPlan()
  const project = defaultProjectPolicy({ allowedTools: ['read', 'write', 'network', 'shell', 'git'] })
  const codes = issueCodes(plan, project)
  assert.ok(codes.includes('tool-denied'), codes.join(','))
})

test('research network permission is trimmed rather than granting network', () => {
  const { plan } = createSyntheticPlan()
  const project = defaultProjectPolicy({ allowResearchNetwork: false })
  const validation = validatePlan(plan, project)

  assert.equal(validation.ok, true, JSON.stringify(validation.issues, null, 2))
  const researcher = validation.effectivePermissions.researcher
  assert.ok(researcher)
  assert.equal(researcher.tools.includes('network'), false)
  assert.ok(validation.issues.some((issue) => issue.code === 'research-network-unavailable'))
})
