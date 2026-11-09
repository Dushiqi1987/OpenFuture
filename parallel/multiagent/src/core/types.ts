/**
 * M0 domain model: typed task graph, role cards, runtime-assigned identities,
 * inbox messages, immutable artifact references and board DTOs.
 *
 * The model is deliberately data-only (JSON serialisable) so the same shape can
 * be persisted to a JSON snapshot now and moved to SQLite in the desktop app
 * without changing the scheduler or the Pi adapter.
 */

export const PLAN_SCHEMA_VERSION = '1.0' as const
export const BOARD_SCHEMA_VERSION = '1.0' as const
export const DESKTOP_SCHEMA_VERSION = '1.0' as const
export const MAX_PARALLEL_WORKERS = 3

export type RoleId = 'researcher' | 'backend' | 'frontend' | 'tester'

export type IntentKind =
  | 'question'
  | 'research'
  | 'analysis'
  | 'backend'
  | 'frontend'
  | 'test-integration'

export type MemoryView = 'off' | 'rag' | 'wiki'

export type ToolName = 'read' | 'write' | 'network' | 'shell' | 'git' | 'test'

export type TaskState =
  | 'planned'
  | 'ready'
  | 'running'
  | 'needs_input'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'reviewed'
  | 'integrated'

export type RunStatus = 'created' | 'running' | 'completed' | 'failed' | 'cancelled'

export type MessageType = 'request' | 'reply' | 'contract' | 'artifact' | 'blocker' | 'review'

export type ArtifactKind =
  | 'research-report'
  | 'contract'
  | 'code-diff'
  | 'test-report'
  | 'review'
  | 'generic'

export type CheckStatus = 'passed' | 'failed'

export interface SourceQuestion {
  id: string
  index: number
  text: string
}

export interface Intent {
  id: string
  kind: IntentKind
  text: string
  sourceQuestionIds: string[]
  taskIds: string[]
}

export interface RunBudget {
  maxTokens: number
  maxTurns: number
  /** Hard ceiling enforced by the scheduler; the design caps the first release at 3. */
  maxConcurrency: number
}

export interface TaskBudget {
  maxTurns: number
  maxTokens: number
  timeoutMs: number
  maxAttempts: number
  /** A waiting task releases its worker slot, but the peer request still expires. */
  requestTimeoutMs: number
}

export interface ArtifactExpectation {
  name: string
  kind: ArtifactKind
  version?: string
  required?: boolean
}

export interface ArtifactInput {
  name: string
  version?: string
  kind?: ArtifactKind
  required?: boolean
}

export interface TaskSpec {
  id: string
  intentId: string
  title: string
  role: RoleId
  dependsOn: string[]
  inputArtifacts: ArtifactInput[]
  outputs: ArtifactExpectation[]
  acceptance: string[]
  memoryView: MemoryView
  /** Repository-relative POSIX globs. Empty for read-only roles. */
  writeScope: string[]
  budget: TaskBudget
  baseRevision: string
}

export interface Plan {
  schemaVersion: typeof PLAN_SCHEMA_VERSION
  planId: string
  projectId: string
  runId: string
  mainGoal: string
  confidence: number
  createdAt: number
  sourceQuestions: SourceQuestion[]
  intents: Intent[]
  tasks: TaskSpec[]
  budget: RunBudget
}

export interface ProjectPolicy {
  projectId: string
  name: string
  rootPath: string
  baseRevision: string
  /** Readable repository-relative scopes. */
  allowedReadPaths: string[]
  /** Writable repository-relative scopes. */
  allowedWritePaths: string[]
  /** The tester may write only inside the isolated integration copy. */
  integrationRoot: string
  allowedTools: ToolName[]
  memoryViews: MemoryView[]
  maxConcurrency: number
  budget: RunBudget
  allowResearchNetwork: boolean
  /** Prototype-only baseline used by the virtual integration repository. */
  baselineFiles?: Record<string, string>
}

export interface RoleCard {
  id: RoleId
  displayName: string
  specialty: string
  duties: string[]
  language: string
  outputContract: string
  tools: ToolName[]
  memoryView: MemoryView
  writeScopes: string[]
  integrationOnly: boolean
  model: { providerId: string; modelId: string; temperature: number }
  budget: TaskBudget
}

export interface TrimRecord {
  field: 'tool' | 'write' | 'memory' | 'network'
  requested: string
  granted: string[]
  reason: string
}

export interface EffectivePermissions {
  roleId: RoleId
  tools: ToolName[]
  writeScopes: string[]
  memoryView: MemoryView
  integrationOnly: boolean
  trimmed: TrimRecord[]
  denied: TrimRecord[]
}

export type PlanIssueSeverity = 'error' | 'warning' | 'confirmation'

export interface PlanIssue {
  severity: PlanIssueSeverity
  code: string
  message: string
  taskId?: string
  intentId?: string
}

export interface PlanValidation {
  ok: boolean
  issues: PlanIssue[]
  needsConfirmation: boolean
  effectivePermissions: Partial<Record<RoleId, EffectivePermissions>>
}

export interface TaskError {
  code: string
  message: string
  retryable: boolean
  retryAfterMs?: number
  escalatedToSuperAgent?: boolean
}

export interface AttemptRecord {
  attempt: number
  startedAt: number
  finishedAt?: number
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  error?: TaskError
  progress: TaskProgress[]
}

export interface TaskProgress {
  at: number
  message: string
  fraction?: number
}

export interface TaskWait {
  correlationId: string
  since: number
  timeoutAt: number
}

export interface FileChange {
  path: string
  content: string
  baseHash?: string
  deleted?: boolean
}

export interface CheckResult {
  id: string
  status: CheckStatus
  detail?: string
}

export interface TaskRecord extends TaskSpec {
  projectId: string
  runId: string
  agentId: string
  state: TaskState
  attempt: number
  attempts: AttemptRecord[]
  producedArtifacts: ArtifactRef[]
  resolvedInputs: ArtifactRef[]
  fileChanges: FileChange[]
  checks: CheckResult[]
  progress: TaskProgress[]
  waiting?: TaskWait
  retryNotBefore?: number
  error?: TaskError
  startedAt?: number
  finishedAt?: number
  reviewedAt?: number
  integratedAt?: number
  recovered?: boolean
}

export interface ArtifactRef {
  id: string
  runId: string
  projectId: string
  taskId: string
  name: string
  version: string
  kind: ArtifactKind
  mediaType: string
  sha256: string
  bytes: number
  createdAt: number
  uri: string
}

export interface ArtifactDraft {
  name: string
  version: string
  kind: ArtifactKind
  mediaType?: string
  content: string
}

export interface TaskResult {
  summary: string
  fileChanges?: FileChange[]
  checks?: CheckResult[]
  notes?: string[]
}

export interface InboxMessage {
  id: string
  runId: string
  projectId: string
  taskId?: string
  clientMessageId: string
  fromAgentId: string
  toAgentId: string
  /** Denormalised for traceability and role-based addressing in tests. */
  fromRole: RoleId
  toRole: RoleId
  correlationId: string
  type: MessageType
  body: string
  artifactRefs: string[]
  createdAt: number
  seq: number
  deliveredAt?: number
  ackedAt?: number
  /** Set when the message was returned as a duplicate clientMessageId. */
  duplicate?: boolean
}

export interface AgentRegistration {
  agentId: string
  taskId: string
  role: RoleId
}

export interface AgentSendInput {
  /** Exactly one of toAgentId / toRole. Role addressing fails if ambiguous. */
  toAgentId?: string
  toRole?: RoleId
  clientMessageId?: string
  correlationId?: string
  type: MessageType
  body: string
  artifactRefs?: string[]
}

export type RunEventType =
  | 'run.created'
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.recovered'
  | 'plan.received'
  | 'plan.accepted'
  | 'plan.rejected'
  | 'plan.needs_confirmation'
  | 'task.ready'
  | 'task.state'
  | 'task.progress'
  | 'task.attempt'
  | 'task.retry_scheduled'
  | 'task.waiting'
  | 'task.wait_resolved'
  | 'task.cancelled'
  | 'inbox.message'
  | 'inbox.duplicate'
  | 'inbox.delivered'
  | 'inbox.acked'
  | 'inbox.wait_registered'
  | 'inbox.wait_timeout'
  | 'inbox.wait_cycle_rejected'
  | 'artifact.published'
  | 'artifact.contract_changed'
  | 'integration.started'
  | 'integration.applied'
  | 'integration.conflict'
  | 'integration.check'
  | 'integration.passed'
  | 'integration.blocked'
  | 'integration.failed'

export interface RunEvent {
  schemaVersion: typeof BOARD_SCHEMA_VERSION
  seq: number
  runId: string
  projectId: string
  at: number
  type: RunEventType
  taskId?: string
  payload: Record<string, unknown>
}

export interface IntegrationConflict {
  path: string
  firstTaskId: string
  secondTaskId: string
  reason: 'duplicate-write' | 'base-hash-mismatch' | 'out-of-scope' | 'permission-denied'
  detail: string
}

export interface IntegrationCheck {
  id: string
  taskId?: string
  status: CheckStatus
  detail?: string
}

export interface IntegrationReport {
  schemaVersion: typeof BOARD_SCHEMA_VERSION
  runId: string
  status: 'passed' | 'blocked' | 'failed'
  startedAt: number
  finishedAt: number
  applied: Array<{ taskId: string; files: string[] }>
  conflicts: IntegrationConflict[]
  checks: IntegrationCheck[]
  evidence: {
    baselineRevision: string
    integrationRevision: string
    files: number
    artifacts: string[]
  }
  blockers: string[]
}

export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'reviewed',
  'integrated'
]

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state)
}

export function isDependencySatisfied(state: TaskState): boolean {
  return state === 'succeeded' || state === 'reviewed' || state === 'integrated'
}

export function isFailureState(state: TaskState): boolean {
  return state === 'failed' || state === 'cancelled'
}

export function isWriteTask(role: RoleId): boolean {
  return role === 'backend' || role === 'frontend'
}

export function isCodeTask(task: TaskSpec): boolean {
  return isWriteTask(task.role)
}
