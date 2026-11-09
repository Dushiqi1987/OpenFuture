/**
 * Super-Agent planning: classify each user question, propose a typed task
 * graph, then validate it before anything is persisted or executed.
 *
 * The heuristic proposer is intentionally small: in production the proposal
 * would come from the model, but it still has the exact same data shape and
 * must pass the same validator. Fixtures can therefore exercise the real
 * planning contract without a model call.
 */

import { TeamError } from './errors.ts'
import {
  DEFAULT_ROLE_CARDS,
  ROLE_IDS,
  isRoleId,
  normalizeScope,
  resolveAllPermissions,
  anyScopeOverlap,
  scopeCoveredBy,
  taskWriteScopeDenied
} from './roles.ts'
import {
  MAX_PARALLEL_WORKERS,
  PLAN_SCHEMA_VERSION,
  isWriteTask,
  type ArtifactExpectation,
  type ArtifactInput,
  type Intent,
  type IntentKind,
  type Plan,
  type PlanIssue,
  type PlanValidation,
  type ProjectPolicy,
  type RoleCard,
  type RoleId,
  type RunBudget,
  type SourceQuestion,
  type TaskBudget,
  type TaskSpec
} from './types.ts'
import { createIdFactory, createSequentialIdFactory, type Clock, type IdFactory, systemClock } from './util.ts'

export interface PlanningRequest {
  project: ProjectPolicy
  questions: SourceQuestion[]
  mode: 'auto' | 'team' | 'single'
  mainGoal?: string
  confidence?: number
  now?: number
}

export interface PlanningDecision {
  route: 'single-agent' | 'team' | 'needs-confirmation'
  reason: string
  plan?: Plan
  validation?: PlanValidation
  /** Set when the planner could only offer a draft after a validation error. */
  fallbackToSingleAgent?: boolean
}

export interface SuperAgentOptions {
  cards?: Record<RoleId, RoleCard>
  idFactory?: IdFactory
  clock?: Clock
  confidenceThreshold?: number
}

const INTENT_KEYWORDS: Array<{ kind: Exclude<IntentKind, 'question'>; pattern: RegExp }> = [
  {
    kind: 'test-integration',
    pattern: /测试|集成|回归|验收|端到端|试合|e2e|integration|regression|acceptance|test suite/i
  },
  {
    kind: 'frontend',
    pattern: /前端|页面|界面|组件|交互|设置页|ui|frontend|react|页面样式/i
  },
  {
    kind: 'backend',
    pattern: /后端|服务端|服务|接口|合同|openapi|数据库|迁移|存储|api|backend|server/i
  },
  {
    kind: 'research',
    pattern: /调研|研究|检索|资料|竞品|出处|文献|引用|research|survey|search|source/i
  },
  {
    kind: 'analysis',
    pattern: /分析|评估|对比|取舍|风险|设计|analysis|evaluate|trade-?off/i
  }
]

const ROLE_FOR_KIND: Record<Exclude<IntentKind, 'question'>, RoleId> = {
  research: 'researcher',
  analysis: 'researcher',
  backend: 'backend',
  frontend: 'frontend',
  'test-integration': 'tester'
}

export function classifyIntent(text: string): IntentKind {
  for (const entry of INTENT_KEYWORDS) {
    if (entry.pattern.test(text)) return entry.kind
  }
  return 'question'
}

function roleForKind(kind: IntentKind): RoleId {
  if (kind === 'question') return 'researcher'
  return ROLE_FOR_KIND[kind]
}

function taskIdFor(questionId: string, kind: IntentKind): string {
  const suffix = kind === 'test-integration' ? 'test' : kind
  return `task-${questionId}-${suffix}`
}

function truncate(text: string, max = 72): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`
}

function acceptanceFor(kind: IntentKind): string[] {
  switch (kind) {
    case 'research':
      return ['每条结论附可核验出处', '标注可信度与未知项', '不发送项目私密内容']
    case 'backend':
      return ['先发布 versioned openapi.json 合同', '服务测试通过并附证据', '合同变更通知前端与测试']
    case 'frontend':
      return ['只消费指定版本的接口合同', '页面/组件测试证据', '报告使用的合同版本']
    case 'test-integration':
      return ['独立集成副本应用差异且无冲突', '构建与回归通过或给出阻塞项', '失败项带负责人和证据']
    case 'analysis':
      return ['给出可选方案、取舍和风险', '结论可追溯到输入资料']
    case 'question':
      return ['回答原始问题', '如有不确定项明确说明']
  }
}

function outputsFor(kind: IntentKind): ArtifactExpectation[] {
  switch (kind) {
    case 'research':
      return [{ name: 'research-report', kind: 'research-report', required: true }]
    case 'backend':
      return [
        { name: 'openapi.json', kind: 'contract', required: true },
        { name: 'backend-notes', kind: 'generic' }
      ]
    case 'frontend':
      return [
        { name: 'web-build', kind: 'code-diff', required: true },
        { name: 'frontend-report', kind: 'test-report' }
      ]
    case 'test-integration':
      return [{ name: 'test-report', kind: 'test-report', required: true }]
    default:
      return []
  }
}

function budgetFor(card: RoleCard): TaskBudget {
  return { ...card.budget }
}

function inputsFor(
  kind: IntentKind,
  context: { backendTaskIds: string[]; allOtherTaskIds: string[] }
): ArtifactInput[] {
  if (kind === 'frontend') {
    return [
      {
        name: 'openapi.json',
        kind: 'contract',
        required: context.backendTaskIds.length > 0
      }
    ]
  }
  if (kind === 'test-integration') {
    return [
      { name: 'openapi.json', kind: 'contract', required: context.backendTaskIds.length > 0 },
      { name: 'web-build', kind: 'code-diff', required: true },
      { name: 'research-report', kind: 'research-report', required: false }
    ]
  }
  return []
}

export class SuperAgent {
  private readonly cards: Record<RoleId, RoleCard>
  private readonly ids: IdFactory
  private readonly clock: Clock
  private readonly confidenceThreshold: number

  constructor(options: SuperAgentOptions = {}) {
    this.cards = options.cards ?? DEFAULT_ROLE_CARDS
    this.ids = options.idFactory ?? createIdFactory()
    this.clock = options.clock ?? systemClock
    this.confidenceThreshold = options.confidenceThreshold ?? 0.6
  }

  plan(request: PlanningRequest): PlanningDecision {
    if (request.mode === 'single') {
      return { route: 'single-agent', reason: '用户明确选择单 Agent 路径' }
    }
    if (request.questions.length === 0) {
      return { route: 'single-agent', reason: '没有可拆解的独立问题' }
    }

    const kinds = request.questions.map((question) => classifyIntent(question.text))
    const workKinds = kinds.filter((kind) => kind !== 'question' && kind !== 'analysis')
    const singleQuestion = request.questions.length === 1

    if (request.mode === 'auto' && singleQuestion && workKinds.length === 0) {
      return { route: 'single-agent', reason: '单个问题由同一助手一次回答，无需团队' }
    }
    if (request.mode === 'auto' && workKinds.length === 0) {
      return { route: 'single-agent', reason: '问题之间无角色差异或并行收益，合并给同一助手' }
    }
    if (request.mode === 'auto' && singleQuestion && workKinds.length === 1) {
      return { route: 'single-agent', reason: '单问题即使涉及文件改动也按单 Agent 路径处理' }
    }

    const plan = this.buildPlan(request, kinds)
    const validation = validatePlan(plan, request.project, this.cards)
    if (!validation.ok) {
      return {
        route: 'needs-confirmation',
        reason: '计划未通过运行时校验，保留草稿并建议单 Agent 或人工编辑',
        plan,
        validation,
        fallbackToSingleAgent: true
      }
    }
    if (validation.needsConfirmation || plan.confidence < this.confidenceThreshold) {
      return {
        route: 'needs-confirmation',
        reason: '意图边界置信度不足，需要用户确认计划',
        plan,
        validation
      }
    }
    return { route: 'team', reason: '存在角色差异与依赖关系，交由团队调度', plan, validation }
  }

  private buildPlan(request: PlanningRequest, kinds: IntentKind[]): Plan {
    const runId = this.ids.run()
    const planId = this.ids.plan()
    const now = request.now ?? this.clock.now()
    const questions = request.questions.map((question, index) => ({ ...question, index }))

    const intents: Intent[] = []
    const tasks: TaskSpec[] = []
    const taskByQuestion = new Map<string, TaskSpec>()

    for (const question of questions) {
      const kind = kinds[question.index] ?? classifyIntent(question.text)
      const role = roleForKind(kind)
      const card = this.cards[role]
      const taskId = taskIdFor(question.id, kind)
      const intentId = `intent-${question.id}`
      const task: TaskSpec = {
        id: taskId,
        intentId,
        title: `${card.displayName}：${truncate(question.text)}`,
        role,
        dependsOn: [],
        inputArtifacts: [],
        outputs: outputsFor(kind),
        acceptance: acceptanceFor(kind),
        memoryView: card.memoryView,
        writeScope: isWriteTask(role) ? [...card.writeScopes] : [],
        budget: budgetFor(card),
        baseRevision: request.project.baseRevision
      }
      tasks.push(task)
      taskByQuestion.set(question.id, task)
      intents.push({
        id: intentId,
        kind,
        text: question.text,
        sourceQuestionIds: [question.id],
        taskIds: [taskId]
      })
    }

    const backendTaskIds = tasks.filter((task) => task.role === 'backend').map((task) => task.id)
    const testerTasks = tasks.filter((task) => task.role === 'tester')
    const nonTesterTasks = tasks.filter((task) => task.role !== 'tester')

    for (const task of tasks) {
      const kind = intents.find((intent) => intent.id === task.intentId)?.kind ?? 'question'
      if (task.role === 'frontend') {
        task.dependsOn = [...backendTaskIds]
      } else if (task.role === 'tester') {
        task.dependsOn = nonTesterTasks.map((other) => other.id)
      }
      task.inputArtifacts = inputsFor(kind, {
        backendTaskIds,
        allOtherTaskIds: nonTesterTasks.map((other) => other.id)
      })
    }

    // A tester task must cover the union of the source questions so an original
    // question cannot disappear behind the integration task.
    if (testerTasks.length > 0) {
      const testIntents = intents.filter((intent) => intent.kind === 'test-integration')
      if (testIntents.length > 1) {
        const first = testIntents[0]
        if (first) {
          for (const extra of testIntents.slice(1)) {
            first.taskIds.push(...extra.taskIds)
            first.sourceQuestionIds.push(...extra.sourceQuestionIds)
          }
        }
      }
    }

    const planBudget: RunBudget = {
      maxTokens: Math.max(request.project.budget.maxTokens, tasks.reduce((sum, task) => sum + task.budget.maxTokens, 0)),
      maxTurns: Math.max(request.project.budget.maxTurns, tasks.reduce((sum, task) => sum + task.budget.maxTurns, 0)),
      maxConcurrency: Math.min(
        MAX_PARALLEL_WORKERS,
        Math.max(1, Math.min(request.project.maxConcurrency, request.project.budget.maxConcurrency))
      )
    }

    return {
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId,
      projectId: request.project.projectId,
      runId,
      mainGoal:
        request.mainGoal?.trim() ||
        `完成 ${questions.length} 项请求：${truncate(questions[0]?.text ?? '未命名请求', 48)}`,
      confidence: request.confidence ?? this.defaultConfidence(kinds),
      createdAt: now,
      sourceQuestions: questions,
      intents,
      tasks,
      budget: planBudget
    }
  }

  private defaultConfidence(kinds: IntentKind[]): number {
    const distinct = new Set(kinds.filter((kind) => kind !== 'question')).size
    if (distinct === 0) return 0.9
    if (distinct >= 3) return 0.93
    if (distinct === 2) return 0.9
    return 0.84
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidatePlanOptions {
  cards?: Record<RoleId, RoleCard>
  now?: number
}

export function validatePlan(
  plan: Plan,
  project: ProjectPolicy,
  cardsOrOptions?: Record<RoleId, RoleCard> | ValidatePlanOptions
): PlanValidation {
  const options: ValidatePlanOptions =
    cardsOrOptions && 'cards' in cardsOrOptions ? cardsOrOptions : { cards: cardsOrOptions as Record<RoleId, RoleCard> | undefined }
  const cards = options.cards ?? DEFAULT_ROLE_CARDS
  const issues: PlanIssue[] = []
  const add = (issue: PlanIssue): void => {
    issues.push(issue)
  }
  const error = (code: string, message: string, ids: { taskId?: string; intentId?: string } = {}): void => {
    add({ severity: 'error', code, message, ...ids })
  }
  const warning = (code: string, message: string, ids: { taskId?: string; intentId?: string } = {}): void => {
    add({ severity: 'warning', code, message, ...ids })
  }
  const confirmation = (code: string, message: string, ids: { taskId?: string; intentId?: string } = {}): void => {
    add({ severity: 'confirmation', code, message, ...ids })
  }

  if (!plan || typeof plan !== 'object') {
    return {
      ok: false,
      issues: [{ severity: 'error', code: 'plan-invalid', message: 'plan must be an object' }],
      needsConfirmation: false,
      effectivePermissions: {}
    }
  }

  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) {
    error('plan-schema', `unsupported plan schema ${String(plan.schemaVersion)}`)
  }
  if (!plan.planId || !plan.projectId || !plan.runId || !plan.mainGoal.trim()) {
    error('plan-required', 'planId, projectId, runId and mainGoal are required')
  }
  if (plan.projectId !== project.projectId) {
    error('project-mismatch', `plan project ${plan.projectId} does not match ${project.projectId}`)
  }
  if (!Number.isFinite(plan.confidence) || plan.confidence < 0 || plan.confidence > 1) {
    error('plan-confidence', 'confidence must be between 0 and 1')
  }
  if (plan.confidence < 0.6) {
    confirmation('low-confidence', `plan confidence ${plan.confidence.toFixed(2)} is below the confirmation threshold`)
  }

  const taskIds = new Set<string>()
  for (const task of plan.tasks) {
    if (taskIds.has(task.id)) error('duplicate-task-id', `duplicate task id ${task.id}`, { taskId: task.id })
    taskIds.add(task.id)
  }
  const intentIds = new Set<string>()
  for (const intent of plan.intents) {
    if (intentIds.has(intent.id)) {
      error('duplicate-intent-id', `duplicate intent id ${intent.id}`, { intentId: intent.id })
    }
    intentIds.add(intent.id)
  }

  // Traceability: every original question must reach at least one task.
  const questionIds = new Set<string>()
  for (const question of plan.sourceQuestions) {
    if (!question.id || questionIds.has(question.id)) {
      error('duplicate-question-id', `duplicate or empty question id ${question.id}`)
    }
    questionIds.add(question.id)
  }
  const tracedQuestions = new Set<string>()
  for (const intent of plan.intents) {
    if (intent.sourceQuestionIds.length === 0) {
      error('intent-untraceable', `intent ${intent.id} has no source question`, { intentId: intent.id })
    }
    for (const questionId of intent.sourceQuestionIds) {
      if (!questionIds.has(questionId)) {
        error('unknown-question', `intent ${intent.id} references unknown question ${questionId}`, {
          intentId: intent.id
        })
      }
      tracedQuestions.add(questionId)
    }
    if (intent.taskIds.length === 0) {
      warning('intent-empty', `intent ${intent.id} has no task`, { intentId: intent.id })
    }
    for (const taskId of intent.taskIds) {
      if (!taskIds.has(taskId)) {
        error('unknown-task', `intent ${intent.id} references unknown task ${taskId}`, { intentId: intent.id })
      }
    }
  }
  for (const question of plan.sourceQuestions) {
    if (!tracedQuestions.has(question.id)) {
      error('untraceable-question', `question ${question.id} is not traceable to any task`)
    }
  }

  const taskById = new Map(plan.tasks.map((task) => [task.id, task]))
  const roleByTask = new Map<string, RoleId>()
  for (const task of plan.tasks) {
    roleByTask.set(task.id, task.role)
    const intent = plan.intents.find((candidate) => candidate.id === task.intentId)
    if (!intent) {
      error('unknown-intent', `task ${task.id} references unknown intent ${task.intentId}`, { taskId: task.id })
    } else if (!intent.taskIds.includes(task.id)) {
      error('intent-task-mismatch', `intent ${intent.id} does not list task ${task.id}`, {
        taskId: task.id,
        intentId: intent.id
      })
    }
    if (!isRoleId(task.role)) {
      error('unknown-role', `task ${task.id} has unknown role ${String(task.role)}`, { taskId: task.id })
    }
  }

  // Dependencies: existence, self-cycle, acyclicity.
  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        error('dependency-cycle', `task ${task.id} depends on itself`, { taskId: task.id })
      } else if (!taskById.has(dependency)) {
        error('unknown-dependency', `task ${task.id} depends on unknown task ${dependency}`, { taskId: task.id })
      }
    }
  }
  const cycle = findDependencyCycle(plan.tasks)
  if (cycle) {
    error('dependency-cycle', `dependency cycle: ${cycle.join(' -> ')}`, { taskId: cycle[0] })
  }

  const permissions = resolveAllPermissions(project, cards)
  const outputProducer = new Map<string, TaskSpec>()
  for (const task of plan.tasks) {
    for (const output of task.outputs) {
      const existing = outputProducer.get(output.name)
      if (existing && existing.id !== task.id) {
        error('artifact-name-conflict', `artifact ${output.name} is produced by ${existing.id} and ${task.id}`, {
          taskId: task.id
        })
      } else {
        outputProducer.set(output.name, task)
      }
    }
  }

  for (const task of plan.tasks) {
    const ids = { taskId: task.id }
    if (!task.title.trim()) error('task-title', `task ${task.id} has an empty title`, ids)
    if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) {
      warning('task-acceptance', `task ${task.id} has no acceptance criteria`, ids)
    }

    // Budgets.
    const budget = task.budget
    if (!Number.isFinite(budget.timeoutMs) || budget.timeoutMs < 100) {
      error('budget-invalid', `task ${task.id} timeoutMs must be >= 100`, ids)
    }
    if (!Number.isInteger(budget.maxAttempts) || budget.maxAttempts < 1 || budget.maxAttempts > 5) {
      error('budget-invalid', `task ${task.id} maxAttempts must be between 1 and 5`, ids)
    }
    if (!Number.isFinite(budget.maxTokens) || budget.maxTokens <= 0) {
      error('budget-invalid', `task ${task.id} maxTokens must be positive`, ids)
    }
    if (task.baseRevision !== project.baseRevision) {
      error('base-revision-mismatch', `task ${task.id} base revision is stale`, ids)
    }

    // Memory scope.
    if (task.memoryView !== 'off' && !project.memoryViews.includes(task.memoryView)) {
      error('memory-denied', `task ${task.id} requests memory view ${task.memoryView} outside the project policy`, ids)
    }

    // Write scopes.
    const normalizedScopes: string[] = []
    for (const scope of task.writeScope) {
      try {
        normalizedScopes.push(normalizeScope(scope))
      } catch (scopeError) {
        error(
          'write-scope-invalid',
          `task ${task.id} has invalid write scope: ${scopeError instanceof Error ? scopeError.message : String(scopeError)}`,
          ids
        )
      }
    }
    if (normalizedScopes.length > 0) {
      if (!isWriteTask(task.role)) {
        error('write-scope-forbidden', `role ${task.role} is read-only but task ${task.id} declares write scopes`, ids)
      } else if (isRoleId(task.role)) {
        const denied = taskWriteScopeDenied(normalizedScopes, permissions[task.role])
        if (denied) {
          error('write-outside-policy', `task ${task.id}: ${denied}`, ids)
        }
      }
    }
    if (isWriteTask(task.role) && normalizedScopes.length === 0) {
      warning('write-scope-empty', `write task ${task.id} has no write scope`, ids)
    }

    // Required tools for the role's stated work.
    if (isRoleId(task.role)) {
      const effective = permissions[task.role]
      if (task.role === 'researcher' && !effective.tools.includes('network')) {
        warning('research-network-unavailable', `task ${task.id} cannot use the network; RAG-only research expected`, ids)
      }
      if (task.role === 'tester' && !effective.tools.includes('test')) {
        error('tool-denied', `tester task ${task.id} lost the test tool after permission convergence`, ids)
      }
    }
  }

  // Unique file owner: no two tasks may write an overlapping path.
  const writeTasks = plan.tasks.filter((task) => task.writeScope.length > 0)
  for (let leftIndex = 0; leftIndex < writeTasks.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < writeTasks.length; rightIndex += 1) {
      const left = writeTasks[leftIndex]
      const right = writeTasks[rightIndex]
      if (!left || !right) continue
      if (anyScopeOverlap(left.writeScope, right.writeScope)) {
        error(
          'write-scope-overlap',
          `tasks ${left.id} and ${right.id} claim overlapping write scopes; assign a single owner`,
          { taskId: left.id }
        )
      }
    }
  }

  // Artifact inputs must resolve to a producer and an ancestor dependency.
  for (const task of plan.tasks) {
    for (const input of task.inputArtifacts) {
      const producer = outputProducer.get(input.name)
      if (!producer) {
        if (input.required) {
          error('input-artifact-missing', `task ${task.id} requires missing artifact ${input.name}`, { taskId: task.id })
        }
        continue
      }
      if (producer.id === task.id) continue
      if (!isAncestor(task.id, producer.id, taskById)) {
        if (input.required) {
          error(
            'input-artifact-not-ancestor',
            `task ${task.id} requires ${input.name} from ${producer.id} but does not depend on it`,
            { taskId: task.id }
          )
        } else {
          warning(
            'input-artifact-unordered',
            `task ${task.id} has an optional input from ${producer.id} that may arrive via inbox`,
            { taskId: task.id }
          )
        }
      }
      if (input.version) {
        const expected = producer.outputs.find((output) => output.name === input.name)
        if (expected?.version && expected.version !== input.version) {
          error(
            'artifact-version-mismatch',
            `task ${task.id} wants ${input.name}@${input.version} but ${producer.id} plans ${expected.version}`,
            { taskId: task.id }
          )
        }
      }
    }
  }

  // Budget sufficiency and concurrency ceiling.
  const totalTokens = plan.tasks.reduce((sum, task) => sum + task.budget.maxTokens, 0)
  const totalTurns = plan.tasks.reduce((sum, task) => sum + task.budget.maxTurns, 0)
  if (totalTokens > plan.budget.maxTokens) {
    error('budget-exceeded', `tasks need ${totalTokens} tokens but the run budget is ${plan.budget.maxTokens}`)
  }
  if (totalTurns > plan.budget.maxTurns) {
    error('budget-exceeded', `tasks need ${totalTurns} turns but the run budget is ${plan.budget.maxTurns}`)
  }
  if (plan.budget.maxConcurrency > MAX_PARALLEL_WORKERS) {
    error(
      'max-concurrency-exceeds-cap',
      `plan requests ${plan.budget.maxConcurrency} workers; the first release caps at ${MAX_PARALLEL_WORKERS}`
    )
  }
  if (plan.budget.maxConcurrency > project.maxConcurrency) {
    warning(
      'concurrency-trimmed',
      `plan requests ${plan.budget.maxConcurrency} workers but the project allows ${project.maxConcurrency}`
    )
  }

  const rolesInPlan = new Set(plan.tasks.map((task) => task.role))
  const effectivePermissions: Partial<Record<RoleId, ReturnType<typeof resolveAllPermissions>[RoleId]>> = {}
  for (const role of ROLE_IDS) {
    if (rolesInPlan.has(role)) effectivePermissions[role] = permissions[role]
  }

  return {
    ok: !issues.some((issue) => issue.severity === 'error'),
    issues,
    needsConfirmation: issues.some((issue) => issue.severity === 'confirmation'),
    effectivePermissions
  }
}

function findDependencyCycle(tasks: readonly TaskSpec[]): string[] | null {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []

  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id)
      return [...stack.slice(start), id]
    }
    if (visited.has(id)) return null
    const task = byId.get(id)
    if (!task) return null
    visiting.add(id)
    stack.push(id)
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) continue
      const found = visit(dependency)
      if (found) return found
    }
    stack.pop()
    visiting.delete(id)
    visited.add(id)
    return null
  }

  for (const task of tasks) {
    const found = visit(task.id)
    if (found) return found
  }
  return null
}

export function isAncestor(taskId: string, candidateAncestorId: string, tasks: Map<string, TaskSpec>): boolean {
  const visited = new Set<string>()
  const queue = [...(tasks.get(taskId)?.dependsOn ?? [])]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || visited.has(current)) continue
    if (current === candidateAncestorId) return true
    visited.add(current)
    const task = tasks.get(current)
    if (task) queue.push(...task.dependsOn)
  }
  return false
}

export function defaultProjectPolicy(overrides: Partial<ProjectPolicy> = {}): ProjectPolicy {
  return {
    projectId: 'project-openfuture-demo',
    name: 'OpenFuture Demo',
    rootPath: 'D:/OpenFuture-parallel/multiagent/.scratch/multiagent/project',
    baseRevision: '1338eca',
    allowedReadPaths: ['**'],
    allowedWritePaths: ['src/**', 'contracts/**', 'tests/**', 'docs/**'],
    integrationRoot: '.scratch/multiagent/integration',
    allowedTools: ['read', 'write', 'network', 'shell', 'git', 'test'],
    memoryViews: ['off', 'rag'],
    maxConcurrency: 3,
    budget: { maxTokens: 120_000, maxTurns: 80, maxConcurrency: 3 },
    allowResearchNetwork: true,
    baselineFiles: {},
    ...overrides
  }
}

export function createSyntheticPlan(
  overrides: {
    project?: Partial<ProjectPolicy>
    questions?: SourceQuestion[]
    now?: number
  } = {}
): { project: ProjectPolicy; plan: Plan; validation: PlanValidation } {
  const project = defaultProjectPolicy(overrides.project)
  const questions = overrides.questions ?? [
    { id: 'q1', index: 0, text: '调研本地优先 Agent 的竞品并给出处' },
    { id: 'q2', index: 1, text: '实现后端 OpenAPI 合同和服务' },
    { id: 'q3', index: 2, text: '按合同实现前端设置页' },
    { id: 'q4', index: 3, text: '独立集成并跑回归测试' }
  ]
  const agent = new SuperAgent({
    idFactory: createSequentialIdFactory('synthetic'),
    clock: { now: () => overrides.now ?? 1_700_000_000_000 }
  })
  const decision = agent.plan({ project, questions, mode: 'team' })
  if (!decision.plan) throw new TeamError('planning-failed', decision.reason)
  return { project, plan: decision.plan, validation: decision.validation ?? validatePlan(decision.plan, project) }
}

export function buildBudgetForRole(role: RoleId, cards: Record<RoleId, RoleCard> = DEFAULT_ROLE_CARDS): TaskBudget {
  return { ...cards[role].budget }
}

export function ensureValidPlan(
  plan: Plan,
  project: ProjectPolicy,
  cards: Record<RoleId, RoleCard> = DEFAULT_ROLE_CARDS
): PlanValidation {
  const validation = validatePlan(plan, project, cards)
  if (!validation.ok) {
    const first = validation.issues.find((issue) => issue.severity === 'error')
    throw new TeamError('plan-invalid', first?.message ?? 'plan failed validation', {
      issues: validation.issues
    })
  }
  return validation
}
