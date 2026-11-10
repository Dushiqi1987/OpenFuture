/**
 * Shared contract between the Electron main process, the preload bridge,
 * the agent host utility process and the renderer.
 *
 * The renderer only ever receives the DTOs declared in this file. It never
 * sees Pi types, file-system paths we do not intend to expose, or credentials.
 */

export const PROTOCOL_VERSION = 1

export type IpcErrorCode =
  | 'VALIDATION'
  | 'NO_WORKSPACE'
  | 'NO_MODEL'
  | 'BUSY'
  | 'HOST_UNAVAILABLE'
  | 'SESSION_NOT_FOUND'
  | 'PI_ERROR'
  | 'INTERNAL'

export interface IpcError {
  code: IpcErrorCode
  message: string
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError }

export type CredentialState = 'none' | 'bound' | 'needs-rebind'

export interface ModelSettings {
  providerId: string
  baseUrl: string
  modelId: string
  displayName: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
}

export interface PublicSettings {
  version: number
  workspace: string | null
  model: ModelSettings | null
  apiKeyConfigured: boolean
  /** Whether the stored key is bound to the current endpoint. */
  credentialState: CredentialState
  /** High-risk tool access; off by default and only changed explicitly. */
  allowPowerShell: boolean
  /** Windows desktop automation via a local MCP server; off by default. */
  computerUse: boolean
  agentDir: string
  appVersion: string
}

export interface SetToolAccessInput {
  powershell: boolean
  computerUse?: boolean
}

export interface SaveModelInput {
  baseUrl: string
  modelId: string
  displayName?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  /** Omit or leave empty to keep the key only when the endpoint is unchanged. */
  apiKey?: string
}

export interface SessionSummary {
  id: string
  name?: string
  firstMessage: string
  created: string
  modified: string
  messageCount: number
}

// ---------------------------------------------------------------------------
// v0.2 A: projects, project-scoped conversations and migration
// ---------------------------------------------------------------------------

export type ProjectMemoryPreset = 'off' | 'rag' | 'wiki' | 'dreaming' | 'both'

export interface ProjectConversation {
  id: string
  projectId: string
  /** Pi session id; absent until the first message creates one. */
  piSessionId?: string
  title: string
  modelOverrideRef?: string
  createdAt: number
  updatedAt: number
  /** Text kept while switching projects, never sent to the model. */
  draft?: string
}

export interface ProjectInfo {
  id: string
  name: string
  canonicalRoot: string
  memoryPreset: ProjectMemoryPreset
  defaultModelRef: string | null
  createdAt: number
  archivedAt: number | null
  available: boolean
  conversationCount: number
  lastConversationId: string | null
}

export interface ProjectListResult {
  projects: ProjectInfo[]
  activeProjectId: string | null
  migrationNotice?: string
}

export interface CreateProjectInput {
  name: string
  rootPath: string
  memoryPreset?: ProjectMemoryPreset
  defaultModelRef?: string | null
}

export interface ProjectSelectResult {
  project: ProjectInfo
  conversations: ProjectConversation[]
}

export interface ConversationListResult {
  projectId: string
  conversations: ProjectConversation[]
}

export interface CreateConversationInput {
  projectId: string
  title?: string
}

export interface OpenConversationInput {
  projectId: string
  conversationId: string
}

export interface OpenConversationResult extends OpenSessionResult {
  projectId: string
  conversationId: string
}

export interface RenameProjectInput {
  projectId: string
  name: string
}

export interface SetProjectMemoryPresetInput {
  projectId: string
  preset: ProjectMemoryPreset
}

export interface ArchiveProjectInput {
  projectId: string
  archived: boolean
}

export interface UpdateConversationInput {
  projectId: string
  conversationId: string
  title?: string
  draft?: string
}

/** One tool exposed by the optional Computer Use MCP bridge. */
export interface ComputerToolInfo {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
}

export type ComputerToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface ComputerToolResult {
  content: ComputerToolContent[]
  isError?: boolean
}

export interface MessageUsage {
  /** Uncached prompt tokens. */
  input: number
  /** Generated completion tokens, including reasoning when the provider reports it. */
  output: number
  /** Prompt tokens served from the provider's prefix cache. */
  cacheRead: number
  /** Prompt tokens written to the provider's prefix cache. */
  cacheWrite: number
  reasoning?: number
  totalTokens: number
  /** Wall-clock duration of the provider request, when reported. */
  durationMs?: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** Persisted reasoning block, restored when a session is reopened. */
  thinking?: string
  timestamp: number
  toolNames?: string[]
  /** Memory/wiki sources used while producing this assistant turn. */
  citations?: MemoryCitation[]
  /** Provider usage for assistant messages; restored from session history. */
  usage?: MessageUsage
}

export interface OpenSessionInput {
  /** Open an existing session by id; omit to start a new session. */
  sessionId?: string
}

export interface OpenSessionResult {
  sessionId: string
  sessionFile?: string
  model?: string
  fallbackMessage?: string
  messages: ChatMessage[]
}

/** Streaming events emitted by the agent host and forwarded to the renderer. */
export type AgentStreamEvent =
  | { type: 'status'; state: 'streaming' | 'idle' | 'aborted' }
  | { type: 'assistant-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'thinking-delta'; id: string; delta: string }
  | { type: 'assistant-message'; message: ChatMessage }
  | { type: 'tool-start'; toolCallId: string; name: string }
  | { type: 'tool-end'; toolCallId: string; name: string; isError: boolean }
  | { type: 'citations'; citations: MemoryCitation[] }
  | { type: 'error'; message: string }
  | { type: 'settled'; aborted: boolean }

export interface AgentEventPayload {
  sessionId: string
  event: AgentStreamEvent
}

/** Result of the memory host's SQLite/FTS5 self-check (P0 verification). */
export interface MemoryDiagnostics {
  ok: boolean
  sqliteVersion: string
  fts5: boolean
  tokenizer: string
  sampleMatches: number
  checkedAt: number
  detail: string
}

// ---------------------------------------------------------------------------
// P1: memory layers, RAG and published wiki
// ---------------------------------------------------------------------------

export type MemoryMode = 'off' | 'rag' | 'wiki' | 'both'

/** Lexical engine that produced a hit. QMD and LLM Wiki are optional; FTS5 is the offline fallback. */
export type MemorySearchEngine = 'fts5' | 'qmd' | 'wiki'

/** Optional external wiki integration. */
export type MemoryWikiEngine = 'off' | 'mcp'

export type MemoryNoteType = 'fact' | 'preference' | 'decision' | 'rule' | 'lesson'

export interface MemoryWorkspaceState {
  workspaceId: string
  mode: MemoryMode
  sourceCount: number
  evidenceCount: number
  noteCount: number
  wikiDraftCount: number
  wikiPublishedCount: number
  pendingProposalCount: number
  ftsReady: boolean
  /** Engine used for evidence retrieval: QMD when its optional module is configured. */
  searchEngine?: MemorySearchEngine
  /** External pi-llm-wiki MCP bridge, when configured. */
  wikiEngine?: MemoryWikiEngine
}

export interface MemorySource {
  id: string
  title: string
  origin: string
  kind: string
  revision: number
  hash: string
  status: 'active' | 'revoked'
  evidenceCount: number
  createdAt: number
}

export interface MemoryCitation {
  label: string
  sourceId?: string
  sourceTitle?: string
  origin?: string
  locator?: string
  noteId?: string
  wikiId?: string
}

export interface L3Entry {
  id: string
  kind: 'note' | 'source'
  refId: string
  revision: number
  title: string
  body: string
}

export interface L3Context {
  workspaceId: string
  versionId: string | null
  revision: number
  entries: L3Entry[]
  text: string
  needsReview: boolean
  verifiedAt: number | null
}

export type MemoryHitKind = 'evidence' | 'note' | 'wiki'

export interface MemorySearchHit {
  id: string
  kind: MemoryHitKind
  title: string
  excerpt: string
  citation: MemoryCitation
  score: number
  engine?: MemorySearchEngine
  /** Full controlled body for detail reads (Wiki/note); excerpt stays short. */
  body?: string
}

export interface MemoryNote {
  id: string
  type: MemoryNoteType
  title: string
  body: string
  revision: number
  status: 'active' | 'revoked'
  createdAt: number
  updatedAt: number
}

export interface WikiPage {
  id: string
  title: string
  slug: string
  status: 'draft' | 'published' | 'revoked'
  revision: number
  body: string
  sourceIds: string[]
  stale: boolean
  createdAt: number
  updatedAt: number
  reviewDiff?: string
}

export interface MemoryProposal {
  id: string
  kind: 'note' | 'fix'
  type: MemoryNoteType
  title: string
  body: string
  evidenceIds: string[]
  targetNoteId?: string
  targetRevision?: number
  status: 'pending' | 'approved' | 'rejected' | 'stale'
  createdAt: number
  decidedAt?: number
}

export interface CorrectNoteInput {
  noteId: string
  /** Corrected body; the title is kept unless a dedicated edit changes it. */
  body: string
  evidenceIds: string[]
  reason?: string
}

export interface ImportSourceInput {
  title?: string
  /** Existing workspace file selected by the user; the main process reads it. */
  filePath?: string
}

export interface ImportSessionEvidenceInput {
  /** Pi session id; defaults to the currently open session. */
  sessionId?: string
  title?: string
}

export interface MemorySearchInput {
  query: string
  limit?: number
}

export interface MemorySearchResult {
  query: string
  hits: MemorySearchHit[]
  mode: MemoryMode
  /** Evidence engine for this query; FTS5 when QMD is absent or fails. */
  engine?: MemorySearchEngine
  /** Non-fatal adapter warning, e.g. QMD unavailable. */
  engineNote?: string
  /** External wiki bridge state for this query. */
  wikiEngine?: MemoryWikiEngine
  /** Non-fatal external wiki warning. */
  wikiNote?: string
}

export interface CreateNoteInput {
  type: MemoryNoteType
  title: string
  body: string
}

export interface UpdateNoteInput {
  id: string
  type?: MemoryNoteType
  title?: string
  body?: string
}

export interface GenerateWikiInput {
  /** Optional source ids; defaults to every active source in the workspace. */
  sourceIds?: string[]
}

export interface DecideProposalInput {
  id: string
  approve: boolean
}

export type DreamPhase = 'ingest' | 'light' | 'rem' | 'deep' | 'promote'
export type DreamOpType = 'keep' | 'fix' | 'merge' | 'drop' | 'promote' | 'demote'

export interface DreamOpPayload {
  type?: MemoryNoteType
  title?: string
  body?: string
}

export interface DreamOp {
  id: string
  type: DreamOpType
  targetIds: string[]
  evidenceRefs: string[]
  reason: string
  confidence: number
  expectedRevision: number
  payload?: DreamOpPayload
}

export interface DreamJob {
  id: string
  status: 'review' | 'applied' | 'rejected' | 'failed'
  phase: DreamPhase
  ops: DreamOp[]
  deleteRatio: number
  l3Preview: string
  createdAt: number
  updatedAt: number
  publishId?: string
  error?: string
}

export interface DreamVersion {
  id: string
  publishId: string
  label: string
  status: 'active' | 'superseded' | 'revoked'
  summary: string
  l3Content: string
  opsCount: number
  createdAt: number
}

export interface DreamState {
  active: DreamVersion | null
  versions: DreamVersion[]
}

export interface DreamApplyInput {
  jobId: string
  publishId: string
}

export interface DreamRollbackInput {
  versionId?: string
}

export interface DreamRevokeInput {
  versionId: string
}

export interface DreamQualityCheck {
  name: string
  ok: boolean
  detail: string
}

export interface DreamQuality {
  duplicateRate: number
  staleRate: number
  sourceCoverage: number
  l3Lines: number
  l3Bytes: number
  l3Tokens: number
  deleteRatio: number
  verified: boolean
  checks: DreamQualityCheck[]
}

export interface DreamScheduleState {
  autoDream: boolean
  intervalMinutes: number
  lastRunAt: number | null
  nextRunAt: number | null
  tokensToday: number
  perRunBudget: number
  dailyBudget: number
}

export interface DreamScheduleInput {
  autoDream: boolean
  intervalMinutes: number
}

export interface TeamRunSummary {
  runId: string
  mainGoal: string
  status: string
  tasks: number
}

export interface OpenFutureApi {
  listTeamRuns(): Promise<IpcResult<TeamRunSummary[] | null>>
  getSettings(): Promise<IpcResult<PublicSettings>>
  chooseWorkspace(): Promise<IpcResult<PublicSettings>>
  clearWorkspace(): Promise<IpcResult<PublicSettings>>
  saveModel(input: SaveModelInput): Promise<IpcResult<PublicSettings>>
  setToolAccess(input: SetToolAccessInput): Promise<IpcResult<PublicSettings>>
  clearApiKey(): Promise<IpcResult<PublicSettings>>
  listProjects(): Promise<IpcResult<ProjectListResult>>
  chooseProjectFolder(): Promise<IpcResult<string | null>>
  createProject(input: CreateProjectInput): Promise<IpcResult<ProjectSelectResult>>
  selectProject(projectId: string): Promise<IpcResult<ProjectSelectResult>>
  renameProject(input: RenameProjectInput): Promise<IpcResult<ProjectInfo>>
  archiveProject(input: ArchiveProjectInput): Promise<IpcResult<ProjectInfo>>
  setProjectMemoryPreset(input: SetProjectMemoryPresetInput): Promise<IpcResult<ProjectInfo>>
  relocateProject(projectId: string): Promise<IpcResult<ProjectInfo>>
  revealProject(projectId: string): Promise<IpcResult<void>>
  listConversations(projectId: string): Promise<IpcResult<ConversationListResult>>
  createConversation(input: CreateConversationInput): Promise<IpcResult<ProjectConversation>>
  openConversation(input: OpenConversationInput): Promise<IpcResult<OpenConversationResult>>
  updateConversation(input: UpdateConversationInput): Promise<IpcResult<ProjectConversation>>
  listSessions(): Promise<IpcResult<SessionSummary[]>>
  openSession(input: OpenSessionInput): Promise<IpcResult<OpenSessionResult>>
  sendMessage(text: string): Promise<IpcResult<void>>
  stop(): Promise<IpcResult<void>>
  closeSession(): Promise<IpcResult<void>>
  memoryDiagnostics(): Promise<IpcResult<MemoryDiagnostics>>
  memoryState(): Promise<IpcResult<MemoryWorkspaceState>>
  memorySetMode(mode: MemoryMode): Promise<IpcResult<MemoryWorkspaceState>>
  memoryImportSource(input: ImportSourceInput): Promise<IpcResult<MemorySource | null>>
  memoryImportSessionEvidence(
    input?: ImportSessionEvidenceInput
  ): Promise<IpcResult<MemorySource | null>>
  memoryListSources(): Promise<IpcResult<MemorySource[]>>
  memoryRevokeSource(id: string): Promise<IpcResult<void>>
  memorySearch(input: MemorySearchInput): Promise<IpcResult<MemorySearchResult>>
  memoryGet(id: string): Promise<IpcResult<MemorySearchHit | null>>
  memoryListNotes(): Promise<IpcResult<MemoryNote[]>>
  memoryCreateNote(input: CreateNoteInput): Promise<IpcResult<MemoryNote>>
  memoryCorrectNote(input: CorrectNoteInput): Promise<IpcResult<MemoryProposal>>
  memoryUpdateNote(input: UpdateNoteInput): Promise<IpcResult<MemoryNote>>
  memoryRevokeNote(id: string): Promise<IpcResult<void>>
  memoryGenerateWiki(input?: GenerateWikiInput): Promise<IpcResult<WikiPage[]>>
  memoryListWiki(): Promise<IpcResult<WikiPage[]>>
  memoryPublishWiki(input: { id: string; revision: number }): Promise<IpcResult<WikiPage>>
  memoryRevokeWiki(id: string): Promise<IpcResult<void>>
  memoryListProposals(): Promise<IpcResult<MemoryProposal[]>>
  memoryDecideProposal(input: DecideProposalInput): Promise<IpcResult<MemoryProposal>>
  dreamStart(): Promise<IpcResult<DreamJob>>
  dreamInspect(jobId: string): Promise<IpcResult<DreamJob | null>>
  dreamApply(input: DreamApplyInput): Promise<IpcResult<DreamVersion>>
  dreamReject(jobId: string): Promise<IpcResult<DreamJob>>
  dreamState(): Promise<IpcResult<DreamState>>
  dreamRollback(input?: DreamRollbackInput): Promise<IpcResult<DreamVersion | null>>
  dreamRevoke(input: DreamRevokeInput): Promise<IpcResult<DreamVersion>>
  dreamQuality(): Promise<IpcResult<DreamQuality>>
  dreamSchedule(): Promise<IpcResult<DreamScheduleState>>
  dreamSetSchedule(input: DreamScheduleInput): Promise<IpcResult<DreamScheduleState>>
  onAgentEvent(listener: (payload: AgentEventPayload) => void): () => void
  onHostLog(listener: (line: string) => void): () => void
}

export const IpcChannels = {
  teamRunsList: 'openfuture:team:runs-list',
  settingsGet: 'openfuture:settings:get',
  workspaceChoose: 'openfuture:settings:choose-workspace',
  workspaceClear: 'openfuture:settings:clear-workspace',
  modelSave: 'openfuture:settings:save-model',
  toolAccessSet: 'openfuture:settings:set-tool-access',
  apiKeyClear: 'openfuture:settings:clear-api-key',
  projectsList: 'openfuture:projects:list',
  projectsChooseFolder: 'openfuture:projects:choose-folder',
  projectsCreate: 'openfuture:projects:create',
  projectsSelect: 'openfuture:projects:select',
  projectsRename: 'openfuture:projects:rename',
  projectsArchive: 'openfuture:projects:archive',
  projectsSetMemoryPreset: 'openfuture:projects:set-memory-preset',
  projectsRelocate: 'openfuture:projects:relocate',
  projectsReveal: 'openfuture:projects:reveal',
  conversationsList: 'openfuture:conversations:list',
  conversationsCreate: 'openfuture:conversations:create',
  conversationsOpen: 'openfuture:conversations:open',
  conversationsUpdate: 'openfuture:conversations:update',
  sessionsList: 'openfuture:sessions:list',
  sessionOpen: 'openfuture:session:open',
  sessionSend: 'openfuture:session:send',
  sessionStop: 'openfuture:session:stop',
  sessionClose: 'openfuture:session:close',
  memoryDiagnostics: 'openfuture:memory:diagnostics',
  memoryState: 'openfuture:memory:state',
  memorySetMode: 'openfuture:memory:set-mode',
  memoryImportSource: 'openfuture:memory:import-source',
  memoryImportSessionEvidence: 'openfuture:memory:import-session-evidence',
  memoryListSources: 'openfuture:memory:list-sources',
  memoryRevokeSource: 'openfuture:memory:revoke-source',
  memorySearch: 'openfuture:memory:search',
  memoryGet: 'openfuture:memory:get',
  memoryListNotes: 'openfuture:memory:list-notes',
  memoryCreateNote: 'openfuture:memory:create-note',
  memoryCorrectNote: 'openfuture:memory:correct-note',
  memoryUpdateNote: 'openfuture:memory:update-note',
  memoryRevokeNote: 'openfuture:memory:revoke-note',
  memoryGenerateWiki: 'openfuture:memory:generate-wiki',
  memoryListWiki: 'openfuture:memory:list-wiki',
  memoryPublishWiki: 'openfuture:memory:publish-wiki',
  memoryRevokeWiki: 'openfuture:memory:revoke-wiki',
  memoryListProposals: 'openfuture:memory:list-proposals',
  memoryDecideProposal: 'openfuture:memory:decide-proposal',
  dreamStart: 'openfuture:dream:start',
  dreamInspect: 'openfuture:dream:inspect',
  dreamApply: 'openfuture:dream:apply',
  dreamReject: 'openfuture:dream:reject',
  dreamState: 'openfuture:dream:state',
  dreamRollback: 'openfuture:dream:rollback',
  dreamRevoke: 'openfuture:dream:revoke',
  dreamQuality: 'openfuture:dream:quality',
  dreamSchedule: 'openfuture:dream:schedule',
  dreamSetSchedule: 'openfuture:dream:set-schedule',
  agentEvent: 'openfuture:agent:event',
  hostLog: 'openfuture:agent:log'
} as const

/** Internal agent-host RPC: memory tool calls bridged through the main process. */
export interface AgentToolRequest {
  kind: 'tool-request'
  id: number
  tool: string
  params: unknown
}

export interface AgentToolResponse {
  kind: 'tool-response'
  id: number
  ok: boolean
  value?: unknown
  error?: { code: string; message: string }
}
