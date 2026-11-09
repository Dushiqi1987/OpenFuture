/**
 * Public types for the Dreaming worker prototype.
 *
 * These are the worker-local contracts. The mainline adapter is expected to map
 * them to the shared OpenFuture protocol; see README.md ("Adapter boundary").
 */

export type SourceKind = 'session' | 'document' | 'wiki'
export type Basis = 'user-confirmed' | 'tool-result' | 'model-statement'
export type NoteType = 'fact' | 'preference' | 'decision' | 'rule' | 'lesson' | 'open-question'
export type CandidateType = 'preference' | 'decision' | 'correction' | 'fact' | 'rule' | 'lesson' | 'open-question'
export type DreamOpType = 'keep' | 'fix' | 'merge' | 'drop' | 'promote'
export type DreamingPhase = 'ingest' | 'light' | 'rem' | 'deep' | 'review' | 'verify'
export type JobStatus = 'queued' | 'running' | 'review' | 'applied' | 'rejected' | 'failed' | 'cancelled'
export type ConflictStatus = 'unresolved' | 'resolved-by-correction' | 'historical-after-revocation'

export type MemoryLocator =
  | { type: 'page'; page: number }
  | { type: 'lines'; startLine: number; endLine: number }
  | { type: 'chars'; start: number; end: number }
  | { type: 'message'; sessionId: string; messageId: string; charRange: { start: number; end: number } }

export interface MemoryEvidenceRef {
  projectId: string
  sourceId: string
  sourceRevision: number
  evidenceId: string
  locator: MemoryLocator
  quote?: string
  quoteHash?: string
}

export interface EvidenceRecord {
  projectId: string
  evidenceId: string
  sourceId: string
  sourceRevision: number
  sourceKind: SourceKind
  locator: MemoryLocator
  text: string
  role: 'user' | 'tool' | 'assistant' | 'document' | string
  sessionId?: string
  messageId?: string
  timestamp?: number
  quotedHash?: string
  quoteHash?: string
  quarantined?: boolean
  injectionFlags?: string[]
  meta?: Record<string, any>
  createdAt?: number
}

export interface SourceRecord {
  sourceId: string
  kind: SourceKind
  title?: string
  origin?: string
  status: 'active' | 'revoked'
  revokedAt?: number
  revokeReason?: string
  latestRevision: number
  authorized: boolean
  completed: boolean
  revisionCount: number
  createdAt: number
  updatedAt: number
}

export interface SessionMessageInput {
  id: string
  role: 'user' | 'tool' | 'assistant'
  text: string
  branchId?: string
  kind?: string
  reasoning?: boolean
  visibility?: string
  injected?: boolean
  revoked?: boolean
  toolCallId?: string
  timestamp?: number
  [key: string]: any
}

export interface SessionBranch {
  id: string
  status?: 'completed' | 'open' | 'running' | string
  authorized?: boolean
}

export interface SessionInput {
  sessionId: string
  sourceId?: string
  projectId: string
  title?: string
  status: 'completed' | 'running' | 'failed' | string
  completed?: boolean
  revision?: number
  authorization?: {
    authorized?: boolean
    projectId?: string
    revoked?: boolean
    allowedBranchIds?: string[]
  }
  branches?: SessionBranch[]
  messages: SessionMessageInput[]
  [key: string]: any
}

export interface MaterialInput {
  sourceId: string
  projectId: string
  kind?: 'document' | 'wiki'
  title?: string
  revision?: number
  status?: string
  authorization?: { authorized?: boolean; projectId?: string; revoked?: boolean }
  blocks?: Array<{ locator: MemoryLocator; text: string; [key: string]: any }>
  [key: string]: any
}

export interface Candidate {
  id: string
  type: CandidateType
  subject: string
  subjectKey?: string
  value: string
  previousValue?: string | null
  basis: Basis
  confidence?: number
  sessionId?: string
  messageId?: string
  evidenceIds: string[]
  evidenceRefs: MemoryEvidenceRef[]
  at?: number
}

export interface RejectedCandidate {
  index: number
  code: string
  message: string
  candidate?: any
}

export interface MemoryEntry {
  id: string
  projectId: string
  type: NoteType
  subject: string
  value: string
  title?: string
  body?: string
  promoted: boolean
  revision: number
  basis: Basis
  assertionRefs: MemoryEvidenceRef[]
  evidenceRefs: MemoryEvidenceRef[]
  createdAt?: number
  updatedAt?: number
  [key: string]: any
}

export interface ConflictSide {
  value: string
  valueKey: string
  evidenceIds: string[]
  evidenceRefs?: MemoryEvidenceRef[]
  sessionIds?: string[]
  basis?: Basis
  at?: number
}

export interface Conflict {
  id: string
  projectId: string
  subject: string
  subjectKey: string
  status: ConflictStatus
  sides: ConflictSide[]
  resolution?: { value: string; valueKey?: string; evidenceIds: string[]; at?: number }
  [key: string]: any
}

export interface DreamOp {
  id: string
  type: DreamOpType
  targetIds: string[]
  evidenceRefs: MemoryEvidenceRef[]
  evidenceIds?: string[]
  assertionRefs?: MemoryEvidenceRef[]
  assertionEvidenceIds?: string[]
  reason: string
  confidence?: number
  expectedRevision?: number
  payload?: { title?: string; body?: string; type?: NoteType; subject?: string; value?: string; promoted?: boolean }
  meta?: { conflictIds?: string[]; assertionEvidenceIds?: string[]; expectedRevisions?: Record<string, number>; [key: string]: any }
  basis?: Basis
  warnings?: string[]
}

export interface RejectedOp {
  index: number
  op?: any
  code: string
  message: string
  details?: any
}

export interface RemCluster {
  subject: string
  subjectKey: string
  entryId?: string | null
  entryValue?: string | null
  values: Array<{ value: string; valueKey?: string; evidenceIds: string[]; sessionIds?: string[]; basis?: Basis; at?: number }>
  evidenceIds: string[]
  sessionIds: string[]
  conflictId?: string | null
}

export interface RemResult {
  projectId: string
  clusters: RemCluster[]
  conflicts: Conflict[]
  themes: any[]
  collections: { crossSession: any[]; counterexamples: any[]; unresolved: any[] }
  stats: Record<string, any>
}

export interface PlanCheck {
  code: string
  message: string
  details?: any
  entryId?: string
  opId?: string
}

export interface PlanChecks {
  blocking: PlanCheck[]
  warnings: PlanCheck[]
  deleteRatio: number
  removedEntryIds: string[]
  maxDeleteRatio: number
}

export interface PlanDiff {
  added: MemoryEntry[]
  updated: MemoryEntry[]
  removed: MemoryEntry[]
  counts: { added: number; updated: number; removed: number }
}

export interface L3Render {
  ok: boolean
  text: string
  entries: MemoryEntry[]
  omitted: MemoryEntry[]
  truncated: boolean
  reason?: string | null
  stats: { lines: number; bytes: number; tokens: number; entries: number; omitted: number; entryIds: string[] }
  hash: string
}

export interface DreamPlan {
  planId: string
  planHash: string
  projectId: string
  jobId: string
  createdAt: string
  baseVersionId: string
  baseRevision: number
  budget: { maxLines: number; maxBytes: number; maxTokens: number }
  status: 'blocked' | 'no-changes' | 'pending-approval'
  ops: DreamOp[]
  rejectedOps: RejectedOp[]
  proposalNotes: string[]
  candidates: Candidate[]
  rem: RemResult
  entries: MemoryEntry[]
  changes: Record<string, any>
  operationLog: any[]
  diff: PlanDiff
  l3Preview: L3Render
  conflicts: Conflict[]
  checks: PlanChecks
  approval: { required: boolean; approvedBy: null | string; token: string; note?: string }
  model?: { provider: string; degraded: boolean; reason?: string | null } | null
  publishId: string
}

export interface L3Snapshot {
  text: string
  stats: { lines: number; bytes: number; tokens: number; entries: number; omitted: number; entryIds: string[] }
  hash: string
}

export interface MemoryVersion {
  versionId: string
  projectId: string
  revision: number
  parentVersionId: string | null
  parentRevision: number | null
  createdAt: string
  createdBy: string
  kind: 'init' | 'publish' | 'rollback'
  publishId: string
  planId?: string
  planHash: string
  jobId?: string
  entries: MemoryEntry[]
  conflicts: Conflict[]
  l3: L3Snapshot
  approval: { approvedBy: string | null; approvedAt: string | null }
  model?: any
  reason?: string
  checks?: PlanChecks
}

export interface AuditEvent {
  at: string
  action: 'init' | 'publish' | 'rollback'
  projectId: string
  revision: number
  parentRevision: number | null
  versionId: string
  publishId: string
  planHash: string
  actor: string
  reason?: string
  entryCount: number
  l3Hash: string
}

export interface PolicyDecision {
  authorized: boolean
  projectId?: string
  revokedSourceIds?: string[]
  reason?: string
  [key: string]: any
}

export interface BudgetLimits {
  maxCallsPerRun?: number
  maxTokensPerRun?: number
  maxCallsPerDay?: number
  maxTokensPerDay?: number
}

export interface BudgetSnapshot {
  limits: Required<BudgetLimits>
  run: { calls: number; tokens: number }
  day: { calls: number; tokens: number }
}

export interface PipelineOptions {
  store: FileDreamStore | MemoryDreamStore
  registry?: EvidenceRegistry
  registryFactory?: (projectId: string) => EvidenceRegistry | Promise<EvidenceRegistry>
  model: any
  policyProvider?: (context: { projectId: string; phase: string; jobId: string | null }) => Promise<PolicyDecision> | PolicyDecision
  l3Budget?: { maxLines: number; maxBytes: number; maxTokens: number }
  maxDeleteRatio?: number
  maxAttempts?: number
  budgetLimits?: BudgetLimits
  sleep?: (ms: number, options?: { signal?: AbortSignal }) => Promise<void>
  backoffMs?: number
  originalsDir?: string | null
  clock?: () => number
}

export interface JobView {
  id: string
  projectId: string
  trigger: 'manual' | 'scheduled' | 'session-end' | 'recovery' | string
  phase: DreamingPhase | 'queued'
  status: JobStatus
  baseVersionId: string | null
  baseRevision: number | null
  attempts: number
  error?: { code?: string; message?: string } | null
  warning?: { code: string; message: string } | null
  ops: DreamOp[]
  evidenceRefs: MemoryEvidenceRef[]
  publishId: string | null
  degraded: boolean
  model?: any
  budget?: BudgetSnapshot
  checks?: any
  plan?: DreamPlan | null
  verification?: any
  wikiDraft?: any
  excluded: { sessions: any[]; messages: any[]; candidates: any[] }
  history?: any[]
}

export interface PublishResult {
  status: 'applied' | 'idempotent'
  version: MemoryVersion
  verification: any
  [key: string]: any
}

export interface AnswerResult {
  projectId: string
  versionId: string
  revision: number
  query: string
  matched: boolean
  answer: string
  entries: MemoryEntry[]
  citations: Array<{ entryId: string; evidenceIds: string[]; versionId: string; revision: number }>
  citationCheck: { ok: boolean; issues: any[] }
  excluded: any[]
}

export declare class EvidenceRegistry {
  constructor(projectId: string)
  readonly projectId: string
  addSource(input: {
    sourceId: string
    kind: SourceKind
    revision?: number
    title?: string
    origin?: string
    contentHash?: string
    authorized?: boolean
    completed?: boolean
    meta?: any
    at?: number
  }): any
  addEvidence(input: {
    sourceId: string
    sourceRevision: number
    locator: MemoryLocator
    text: string
    role?: string
    speaker?: string
    sessionId?: string
    messageId?: string
    timestamp?: number
    meta?: any
    at?: number
  }): any
  addSessionMessage(input: any): any
  revokeSource(sourceId: string, options?: { at?: number; reason?: string }): any
  getSource(sourceId: string): SourceRecord | null
  getEvidence(evidenceId: string): EvidenceRecord | null
  findEvidence(query: { sessionId?: string; messageId?: string; sourceId?: string }): EvidenceRecord[]
  listSources(): SourceRecord[]
  listEvidence(options?: { sourceIds?: string[]; includeQuarantined?: boolean }): EvidenceRecord[]
  verifyRef(ref: MemoryEvidenceRef, options?: { requireQuote?: boolean; requireActive?: boolean }): { ok: boolean; evidence?: EvidenceRecord; code?: string; message?: string }
  toEvidenceRef(record: EvidenceRecord): MemoryEvidenceRef
  snapshot(): any
}

export declare class FileDreamStore {
  constructor(options: { root: string; clock?: () => number })
  ensureProject(projectId: string, options?: { actor?: string }): Promise<MemoryVersion>
  getActive(projectId: string): Promise<MemoryVersion>
  getVersion(projectId: string, revision: number): Promise<MemoryVersion>
  listVersions(projectId: string): Promise<Array<{ revision: number; versionId: string; kind: string; createdAt: string }>>
  commit(projectId: string, input: { expectedRevision: number; version: MemoryVersion; approval?: any }): Promise<{ kind: 'applied' | 'idempotent'; version: MemoryVersion }>
  readAudit(projectId: string, options?: { limit?: number }): Promise<AuditEvent[]>
  simulateCrashAfterVersion(projectId: string, version: MemoryVersion): Promise<void>
  statProject(projectId: string): Promise<{ dir: string; versionFiles: number; size: number }>
  close(): Promise<void>
}

export declare class MemoryDreamStore {
  ensureProject(projectId: string): Promise<MemoryVersion>
  getActive(projectId: string): Promise<MemoryVersion>
  getVersion(projectId: string, revision: number): Promise<MemoryVersion>
  listVersions(projectId: string): Promise<any[]>
  readAudit(projectId: string, options?: { limit?: number }): Promise<AuditEvent[]>
  close(): Promise<void>
}

export declare class DreamingPipeline {
  constructor(options: PipelineOptions)
  readonly store: any
  createJob(input: any): Promise<JobView>
  start(input: any): Promise<JobView>
  getJob(jobId: string): JobView | null
  listJobs(): Array<{ id: string; projectId: string; status: JobStatus; phase: DreamingPhase }>
  run(jobId: string, options?: { signal?: AbortSignal }): Promise<JobView>
  resume(jobId: string): Promise<JobView>
  cancel(jobId: string): Promise<JobView>
  reject(jobId: string, options?: { rejectedBy?: string; reason?: string }): Promise<JobView>
  publish(jobId: string, approval: { approvedBy: string; approvalToken: string; note?: string }, options?: { signal?: AbortSignal }): Promise<PublishResult>
  rollback(input: { projectId: string; toRevision: number; approvedBy: string; reason: string; publishId?: string | null; signal?: AbortSignal | null }): Promise<any>
  getL3(projectId: string, options?: { budget?: { maxLines: number; maxBytes: number; maxTokens: number } }): Promise<any>
  answer(input: { projectId: string; query: string; limit?: number }): Promise<AnswerResult>
  verifyProject(projectId: string): Promise<any>
  close(): Promise<void>
}

export declare class DreamingScheduler {
  constructor(options: {
    pipeline: DreamingPipeline
    enabled?: boolean
    projects?: Record<string, any>
    policyProvider?: ((context: any) => Promise<PolicyDecision> | PolicyDecision) | null
    sourcesProvider: (projectId: string) => Promise<{ sessions: SessionInput[]; materials?: MaterialInput[] }>
    clock?: () => number
    intervalMs?: number
    logger?: ((event: any) => void) | null
  })
  registerProject(projectId: string, config?: any): any
  setProjectEnabled(projectId: string, enabled: boolean): any
  tick(options?: { signal?: AbortSignal | null }): Promise<{ skipped: any; started: any[]; status: any }>
  start(): any
  stop(): any
  status(): any
}

export declare class ModelClient {
  constructor(options: { baseUrl: string; token: string; timeoutMs?: number; fetchImpl?: typeof fetch; name?: string })
  extract(input: { projectId: string; evidence: EvidenceRecord[]; signal?: AbortSignal }): Promise<{ candidates: any[]; notes: any[]; provider?: string; degraded?: boolean }>
  adjudicate(input: { projectId: string; candidates: any[]; entries: any[]; conflicts: any[]; signal?: AbortSignal }): Promise<{ ops: any[]; notes: any[]; provider?: string; degraded?: boolean }>
  health(): Promise<{ ok: boolean; provider: string; degraded: boolean; error?: string }>
}

export declare function startMockModelServer(options?: {
  port?: number
  host?: string
  token?: string
  model?: any
}): Promise<{ server: any; port: number; host: string; token: string; url: string; model: any; listen(): Promise<any>; close(): Promise<void> }>

export declare function createMockModelServer(options?: {
  port?: number
  host?: string
  token?: string
  model?: any
}): { server: any; port: number; host: string; token: string; url: string; model: any; listen(): Promise<any>; close(): Promise<void> }

export declare const MOCK_MODEL_PORT: number
export declare const PROJECT_ID: string
export declare const OTHER_PROJECT_ID: string
export declare const SESSION_1_ID: string
export declare const SESSION_2_ID: string
export declare const DOC_SOURCE_ID: string
export declare const UNAUTHORIZED_SENTINEL: string
export declare const SYNTHETIC_BASE_TIME: number
