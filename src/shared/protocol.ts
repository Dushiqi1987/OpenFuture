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
  | 'MARKET_UNAVAILABLE'
  | 'MARKET_INSTALL_FAILED'
  | 'CLOUD_AUTH'
  | 'CLOUD_UNAVAILABLE'
  | 'BROWSER_ERROR'
  | 'BROWSER_TIMEOUT'

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
  agentDesktop: boolean
  /** Experimental billion-context ACP compression; on by default. */
  contextCompression: boolean
  /** Cross-encoder quality rerank for same-language long documents; off by default. */
  memoryQualityRerank: boolean
  /** Parallel subagents (`delegate_tasks`); on by default. */
  subagents: boolean
  /** Maximum concurrent subagents, 1-4. */
  subagentConcurrency: number
  /** Serial group chat (`start_group_chat`); on by default. */
  groupChat: boolean
  /** Let the agent create and edit workspace files; on by default. */
  allowFileWrites: boolean
  /** Local appearance and input preferences. */
  ui: UiPreferences
  /** Extra model endpoints that group chat members can use. */
  groupModelProfiles: GroupModelProfile[]
  /** Which extra profile each group role uses; null means the default model. */
  groupChatModels: GroupChatMembers
  agentDir: string
  appVersion: string
}

export interface SetToolAccessInput {
  powershell: boolean
  computerUse?: boolean
  agentDesktop?: boolean
  contextCompression?: boolean
  subagents?: boolean
  subagentConcurrency?: number
  allowFileWrites?: boolean
  groupChat?: boolean
}

export type UiTheme = 'system' | 'dark' | 'light'
export type MessageDensity = 'comfortable' | 'compact'
export type SendShortcut = 'enter' | 'ctrl+enter'
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

/** Local UI preferences that do not require an agent restart. */
export interface UiPreferences {
  theme: UiTheme
  /** Renderer zoom factor; 1 is the default. */
  scale: number
  density: MessageDensity
  showTimestamps: boolean
  sendShortcut: SendShortcut
  /** Passed to `createAgentSession({ thinkingLevel })`. */
  thinkingLevel: ThinkingLevel
}

export type SetUiPreferencesInput = Partial<UiPreferences>

/** A separately configured endpoint used by one group chat role. */
export interface GroupModelProfile {
  id: string
  label: string
  baseUrl: string
  modelId: string
  contextWindow: number
  maxTokens: number
}

export interface GroupChatMembers {
  lead: string | null
  critic: string | null
  chair: string | null
}

export interface SaveGroupModelProfileInput {
  /** Omit to create a new profile. */
  id?: string
  label: string
  baseUrl: string
  modelId: string
  /** Required on create; omit to keep the stored key on edit. */
  apiKey?: string
  contextWindow?: number
  maxTokens?: number
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
  /** Named agent role for this conversation; absent means a normal chat. */
  agentName?: string
  /** Persona injected into the system prompt for agent conversations. */
  agentPrompt?: string
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

// ---------------------------------------------------------------------------
// Automation tasks (scheduled prompts delivered into a project conversation)
// ---------------------------------------------------------------------------

export type AutomationScheduleKind = 'once' | 'interval' | 'daily' | 'weekly'
export type AutomationTaskStatus = 'active' | 'paused' | 'ended'
export type AutomationRunStatus = 'running' | 'succeeded' | 'failed'

export interface AutomationTask {
  id: string
  title: string
  prompt: string
  projectId: string
  projectName?: string
  scheduleKind: AutomationScheduleKind
  /** ISO timestamp; once only. */
  runAt?: string
  /** Interval minutes; interval only. */
  everyMinutes?: number
  /** HH:mm local time; daily/weekly. */
  timeOfDay?: string
  /** 0=Sunday … 6=Saturday; weekly only. */
  weekday?: number
  status: AutomationTaskStatus
  /** When set, the run is appended to this existing project conversation. */
  targetConversationId?: string
  /** ISO timestamp of the next planned delivery. */
  nextRunAt?: string
  lastRunAt?: string
  lastError?: string
  createdAt: number
  updatedAt: number
}

export interface AutomationRun {
  id: string
  taskId: string
  startedAt: number
  finishedAt?: number
  status: AutomationRunStatus
  output?: string
  error?: string
  conversationId?: string
  sessionId?: string
}

export interface CreateAutomationInput {
  title: string
  prompt: string
  projectId: string
  /** Optional existing conversation in the same project. */
  targetConversationId?: string
  scheduleKind: AutomationScheduleKind
  runAt?: string
  everyMinutes?: number
  timeOfDay?: string
  weekday?: number
}

export interface UpdateAutomationInput {
  id: string
  title?: string
  prompt?: string
  projectId?: string
  targetConversationId?: string
  scheduleKind?: AutomationScheduleKind
  runAt?: string
  everyMinutes?: number
  timeOfDay?: string
  weekday?: number
  status?: 'active' | 'paused'
}

export interface AutomationRunInput {
  id: string
}

export interface AutomationListResult {
  tasks: AutomationTask[]
  /** Most recent runs across all tasks, newest first. */
  runs: AutomationRun[]
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
  agentName?: string
  agentPrompt?: string
}

/** A conversation promoted to a named agent role. */
export interface AgentSummary {
  conversationId: string
  projectId: string
  projectName: string
  name: string
  prompt: string
  title: string
  piSessionId?: string
  updatedAt: number
}

/** Role prompt injected into the agent host system prompt. */
export interface AgentRole {
  name: string
  prompt: string
}

/** One tool exposed by the optional Computer Use MCP bridge. */
export interface AgentDesktopState {
  installed: boolean
  version: string | null
  path: string
  supported: boolean
}

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
  /** Renderer-only delivery state for optimistic user messages while busy. */
  pending?: 'queued' | 'steer'
}

export interface OpenSessionInput {
  /** Open an existing session by id; omit to start a new session. */
  sessionId?: string
}

export interface OpenSessionResult {
  sessionId: string
  sessionFile?: string
  pluginLoadErrors?: Record<string, string>
  model?: string
  fallbackMessage?: string
  messages: ChatMessage[]
}

/** Streaming events emitted by the agent host and forwarded to the renderer. */
export type SendMessageMode = 'prompt' | 'steer' | 'followUp'

export type SubagentTaskStatus =
  | 'queued'
  | 'running'
  | 'tool'
  | 'done'
  | 'failed'
  | 'aborted'
  | 'timeout'

/**
 * Progress of one in-process subagent. The agent host runs child Pi sessions
 * for `delegate_tasks`, so a single assistant turn can own several parallel
 * workers; the renderer shows them as live activity rows.
 */
export interface SubagentTaskState {
  taskId: string
  title: string
  status: SubagentTaskStatus
  /** Current tool name while `status` is 'tool'; short error text otherwise. */
  detail?: string
  durationMs?: number
}

/**
 * One workspace file the model created or edited during a turn. The renderer
 * groups these into the Codex-style "已编辑 N 个文件" card.
 */
export interface FileChange {
  /** Workspace-relative path with forward slashes. */
  path: string
  added: number
  removed: number
  kind: 'create' | 'edit' | 'delete'
}

/** Serial group chat: the lead works, the critic reviews, turns never overlap. */
export type GroupChatStage = 'work' | 'critique' | 'response' | 'chair'

export type GroupChatStatus = 'running' | 'consensus' | 'unresolved' | 'stalled' | 'aborted' | 'failed'

export interface GroupChatRole {
  id: string
  label: string
}

export interface GroupChatSummary {
  chatId: string
  goal: string
  status: GroupChatStatus
  rounds: number
  members: GroupChatMembers
  createdAt: number
  updatedAt: number
  messageCount: number
}

export interface GroupChatRecord extends GroupChatSummary {
  messages: GroupChatMessage[]
  error?: string
}

export interface GroupChatMessage {
  seq: number
  roleId: string
  roleLabel: string
  stage: GroupChatStage
  text: string
  /** Evidence lines (E1 read(…)) produced during this turn. */
  tools: string[]
}

/**
 * Incremental group-chat progress. The renderer keeps one panel per chat id and
 * appends `message` events, so transcripts never have to be re-sent whole.
 */
export type GroupChatEvent =
  | { type: 'start'; chatId: string; goal: string; roles: GroupChatRole[]; rounds: number }
  | { type: 'message'; chatId: string; message: GroupChatMessage }
  | {
      type: 'end'
      chatId: string
      status: GroupChatStatus
      rounds: number
      durationMs: number
      error?: string
    }

/**
 * Plugin market (DSH plugin catalog).
 *
 * DSH plugins are npm packages / release tarballs that target the DSH host
 * API. The market only downloads and unpacks them; `pluginAdapt` hands their
 * sources to the model, which writes a Pi extension this app can load.
 */
export type PluginAdaptPhase = 'queued' | 'running' | 'done' | 'failed'

export interface PluginAdaptProgress {
  id: string
  name: string
  phase: PluginAdaptPhase
  message?: string
}

export interface MarketEntry {
  id: string
  name: string
  owner: string
  description: string
  descriptionEn: string
  category: string
  npm: string | null
  version: string | null
  stars: number | null
  downloads: number | null
  install: string | null
  homepage: string | null
  tarball: string | null
}

export interface InstalledPluginInfo {
  id: string
  catalogId?: string
  name: string
  owner?: string
  version: string | null
  installedAt: number
  dir: string
  sourceUrl: string | null
  adapted: boolean
}

export interface AdaptedPluginInfo {
  id: string
  name: string
  file: string
  enabled: boolean
  adaptedAt: number
  note?: string
  /** npm packages the adapted code imports (`// deps:` header), installed on demand. */
  requires: string[]
  /** True once the declared dependencies exist in the plugin directory. */
  depsInstalled: boolean
  loadError?: string
}

export interface PluginMarketState {
  fetchedAt: number
  source: string
  entries: MarketEntry[]
  installed: InstalledPluginInfo[]
  adapted: AdaptedPluginInfo[]
  /** Set when the catalog could not be refreshed; installed/adapted stay usable. */
  catalogError?: string
}

export interface PluginAdaptResult {
  adapted: AdaptedPluginInfo | null
  error?: string
}

export type AgentStreamEvent =
  | { type: 'status'; state: 'streaming' | 'idle' | 'aborted' }
  | { type: 'session-invalidated' }
  | { type: 'assistant-start'; id: string }
  | { type: 'user-message'; message: ChatMessage }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'thinking-delta'; id: string; delta: string }
  | { type: 'assistant-message'; message: ChatMessage }
  | { type: 'skill'; name: string }
  | { type: 'tool-start'; toolCallId: string; name: string; args?: string }
  | {
      type: 'tool-end'
      toolCallId: string
      name: string
      isError: boolean
      result?: string
      durationMs?: number
    }
  | { type: 'citations'; citations: MemoryCitation[] }
  | { type: 'subagent'; task: SubagentTaskState }
  | { type: 'group'; event: GroupChatEvent }
  | { type: 'plugin'; event: PluginAdaptProgress }
  | { type: 'file-change'; change: FileChange }
  | { type: 'prompt'; prompt: UserPromptRequest }
  | { type: 'prompt-done'; id: string; answer?: string; cancelled?: boolean }
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
export type MemorySearchEngine = 'fts5' | 'hybrid' | 'qmd' | 'wiki'

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
  /** Documents embedded into the semantic vector index. */
  semanticDocCount?: number
  /** Documents in the lexical search index (evidence + notes + wiki). */
  indexedDocCount?: number
  /** True when the embedding model finished loading in this host. */
  semanticReady?: boolean
  rerankerReady?: boolean
  /** True when the quality cross-encoder rerank is enabled. */
  qualityRerank?: boolean
  embeddingModel?: string
  rerankerModel?: string
}

export interface MemorySearchEvent {
  query: string
  hits: number
  topScore: number
  durationMs: number
  at: number
  engine?: MemorySearchEngine
}

/** Live retrieval metrics recorded from every memory search (panel and agent). */
export interface MemoryMetrics {
  searches: number
  hitRate: number
  p50Ms: number
  p95Ms: number
  lastSearchAt: number | null
  recent: MemorySearchEvent[]
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

export interface ImportSourcesInput {
  /** Absolute file paths; when omitted the user picks a folder in a dialog. */
  paths?: string[]
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

// ---------------------------------------------------------------------------
// Knowledge graph: vector constellation across one or more memory workspaces
// ---------------------------------------------------------------------------

/** `workspace` maps the active project; `all` bridges every indexed project. */
export type KnowledgeGraphScope = 'workspace' | 'all'

/** Which embedding space produced the constellation. */
export type KnowledgeGraphSpace = 'semantic' | 'hashed'

/** Sources are beacons in the map even though they are not retrieval hits. */
export type KnowledgeGraphNodeKind = MemoryHitKind | 'source'

export type KnowledgeGraphEdgeKind = 'similar' | 'bridge' | 'evidence' | 'cites' | 'source'

export interface KnowledgeGraphNode {
  /** Globally unique across workspaces: `${workspaceId}:${kind}:${id}`. */
  key: string
  id: string
  kind: KnowledgeGraphNodeKind
  title: string
  excerpt: string
  workspaceId: string
  workspaceName: string
  noteType?: MemoryNoteType
  /** Projected sky coordinate in [-1, 1]; y grows downwards on screen. */
  x: number
  y: number
  /** Depth along the third principal axis, same scale; toward the viewer. */
  z: number
  /** Constellation index, matching KnowledgeGraphCluster.id. */
  cluster: number
  /** Number of distinct neighbours (structural + similarity). */
  degree: number
  /** 0..1 importance used for the star radius. */
  weight: number
  /** Mean cosine to its similarity neighbours (0 when it has none). */
  similarity: number
  /** True when the node sits on a real vector (not anchored to neighbours). */
  semantic: boolean
  createdAt: number
}

export interface KnowledgeGraphEdge {
  source: string
  target: string
  kind: KnowledgeGraphEdgeKind
  /** 0..1 strength used for line opacity/width. */
  weight: number
  similarity: number
  /** Similarity edge whose endpoints live in different workspaces. */
  crossWorkspace: boolean
}

export interface KnowledgeGraphCluster {
  id: number
  label: string
  keywords: string[]
  size: number
  /** Centroid in the same coordinate space as the nodes. */
  x: number
  y: number
  z: number
  workspaceIds: string[]
}

export interface KnowledgeGraphStats {
  nodeCount: number
  edgeCount: number
  bridgeCount: number
  clusterCount: number
  /** Nodes placed by a real vector in the selected space. */
  semanticCount: number
  /** Nodes resolved from their neighbours (sources and unembedded docs). */
  anchoredCount: number
  workspaceCount: number
  isolated: number
  space: KnowledgeGraphSpace
  dim: number
  model: string
  /** Effective cosine floor used for similarity edges. */
  threshold: number
  /** Recommended floor for this space, shown in the panel slider. */
  suggestedThreshold: number
  /** Indexed documents in scope, before the node cap. */
  totalDocs: number
  truncated: boolean
  generatedAt: number
}

export interface KnowledgeGraph {
  scope: KnowledgeGraphScope
  nodes: KnowledgeGraphNode[]
  edges: KnowledgeGraphEdge[]
  clusters: KnowledgeGraphCluster[]
  stats: KnowledgeGraphStats
  /** Variance explained by the two projected axes (0..1). */
  coverage?: number
  /** Non-fatal hints, e.g. "vectors are still warming up". */
  notes?: string[]
}

export interface KnowledgeGraphInput {
  scope?: KnowledgeGraphScope
  /** Soft cap for stars; defaults to 320 on the host. */
  maxNodes?: number
  /** Absolute cosine floor; omit to let the host pick the default for the space. */
  minSimilarity?: number
  kinds?: KnowledgeGraphNodeKind[]
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

export interface StartGroupChatInput {
  goal: string
  constraints?: string
  focus?: string
  /** Rounds of work/critique; 1-3, default 2. */
  rounds?: number
  /** Conversation that hosts the chat; defaults to the active one. */
  sessionId?: string
}

export interface StartGroupChatResult {
  /** The chat runs in the background; progress arrives as `group` events. */
  accepted: boolean
}

export type McpTransport = 'stdio' | 'url'

export interface McpServerInput {
  name: string
  transport: McpTransport
  /** Executable for stdio servers, e.g. `npx`. */
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** Endpoint for HTTP/SSE servers. */
  url?: string
  headers?: Record<string, string>
  description?: string
  /** Connection timeout in seconds (5-3600). */
  timeout?: number
  enabled?: boolean
}

export interface McpServerInfo extends McpServerInput {
  enabled: boolean
}

export interface McpConfigState {
  /** Path of the `mcp.json` the agent reads. */
  path: string
  servers: McpServerInfo[]
  errors: string[]
}

export interface SkillInfo {
  name: string
  description: string
  /** Markdown body after the frontmatter (shown in the detail view). */
  body: string
  filePath: string
  dir: string
  /** False when the skill folder sits in `skills-disabled` and is not loaded. */
  enabled: boolean
  /** Built-in templates ship with the app; `user` skills are created by hand. */
  origin: 'builtin' | 'user'
  disableModelInvocation: boolean
  updatedAt: number
}

/** One entry of the bundled skill library, before/after installation. */
export interface SkillLibraryEntry {
  name: string
  description: string
  installed: boolean
}

/** Result of turning a path/URL found in a message into something openable. */
/** One choice offered by the model in an `ask_user` prompt. */
export interface UserPromptOption {
  label: string
  description?: string
}

export type UserPromptKind = 'choice' | 'confirm'

/** A pending question the model wants the user to answer before continuing. */
export interface UserPromptRequest {
  id: string
  kind: UserPromptKind
  question: string
  options: UserPromptOption[]
  allowCustom: boolean
}

export interface UserPromptAnswerInput {
  id: string
  /** Conversation that owns the pending prompt. */
  sessionId?: string
  optionIndex?: number
  text?: string
  cancelled?: boolean
}

export interface ResolveLinkResult {
  kind: 'url' | 'file' | 'missing'
  /** file:// URL for files, absolute http(s) URL for links. */
  url?: string
  path?: string
  isHtml?: boolean
  error?: string
}

/** Agent-driven browser commands, relayed main → renderer (see BrowserPane). */
export type BrowserCommandAction =
  | 'open'
  | 'read'
  | 'screenshot'
  | 'click'
  | 'type'
  | 'press'
  | 'scroll'
  | 'back'
  | 'forward'
  | 'reload'
  | 'state'

export interface BrowserCommand {
  id: string
  action: BrowserCommandAction
  url?: string
  label?: string
  text?: string
  selector?: string
  submit?: boolean
  key?: string
  deltaY?: number
  maxChars?: number
}

export interface BrowserCommandResult {
  url: string
  title: string
  text?: string
  /** PNG data URL; the main process persists it and hands the agent a path. */
  screenshot?: string
  /** Renderer asks main to capture this guest (webview capture is unreliable). */
  captureId?: number
  matched?: string
}

export interface SaveSkillInput {
  name: string
  description: string
  /** Markdown body after the frontmatter. */
  body: string
  disableModelInvocation?: boolean
}

/** Something the phone did that the desktop window should reflect. */
export type RemoteActivity =
  | { kind: 'conversation'; projectId: string; conversationId: string }
  | { kind: 'open'; projectId: string; conversationId: string; sessionId: string }
  | {
      kind: 'message'
      projectId: string
      conversationId: string
      sessionId: string
      text: string
      at: number
    }

export interface CloudUserView {
  id: number
  phone: string
  nickname: string
  balanceMicros: number
  balanceYuan?: string
}

export interface CloudDeviceView {
  id: number
  name: string
  platform: string
  kind: string
  revoked: boolean
}

export interface CloudAccountInfo extends CloudUserView {
  balanceYuan: string
  email: string
  createdAt: string
  deviceCount: number
  devices: CloudDeviceView[]
}

export interface CloudStatus {
  base: string
  signedIn: boolean
  user: CloudUserView | null
}

export interface CloudQrTicket {
  ticket: string
  code: string
  expiresAt: string
  expiresInSeconds: number
  /** 主进程取回的 PNG，已转成 data URL，渲染进程直接显示 */
  imageDataUrl: string
}

export interface CloudQrPoll {
  status: 'pending' | 'claimed' | 'expired' | 'used'
}

export interface RemoteAccessStatus {
  running: boolean
  port: number
  urls: string[]
  /** Short-lived pairing code shown on the desktop; rotates after use. */
  code: string
  codeExpiresAt: number
  devices: Array<{ name: string; createdAt: number; lastSeenAt: number }>
}

export interface OpenFutureApi {
  mcpState(): Promise<IpcResult<McpConfigState>>
  saveMcpServer(input: McpServerInput): Promise<IpcResult<McpConfigState>>
  deleteMcpServer(name: string): Promise<IpcResult<McpConfigState>>
  setMcpServerEnabled(name: string, enabled: boolean): Promise<IpcResult<McpConfigState>>
  answerPrompt(input: UserPromptAnswerInput): Promise<IpcResult<null>>
  resolveLink(target: string): Promise<IpcResult<ResolveLinkResult>>
  openExternalTarget(target: string): Promise<IpcResult<null>>
  /** Renderer side of the agent-driven browser: subscribe to commands and reply. */
  onBrowserCommand(listener: (command: BrowserCommand) => void): () => void
  browserReply(
    id: string,
    ok: boolean,
    value?: BrowserCommandResult,
    error?: string
  ): void
  listSkills(): Promise<IpcResult<SkillInfo[]>>
  skillLibrary(): Promise<IpcResult<SkillLibraryEntry[]>>
  installLibrarySkill(name: string): Promise<IpcResult<SkillInfo[]>>
  setSkillEnabled(name: string, enabled: boolean): Promise<IpcResult<SkillInfo[]>>
  saveSkill(input: SaveSkillInput): Promise<IpcResult<SkillInfo[]>>
  deleteSkill(name: string): Promise<IpcResult<SkillInfo[]>>
  listTeamRuns(): Promise<IpcResult<TeamRunSummary[] | null>>
  /** Manual entry: start a serial group chat without waiting for the model to pick the tool. */
  startGroupChat(input: StartGroupChatInput): Promise<IpcResult<StartGroupChatResult>>
  saveGroupModelProfile(input: SaveGroupModelProfileInput): Promise<IpcResult<PublicSettings>>
  deleteGroupModelProfile(id: string): Promise<IpcResult<PublicSettings>>
  setGroupChatMembers(members: GroupChatMembers): Promise<IpcResult<PublicSettings>>
  listGroupChats(): Promise<IpcResult<GroupChatSummary[]>>
  getGroupChat(chatId: string): Promise<IpcResult<GroupChatRecord | null>>
  /** DSH plugin catalog: cached entries plus local install/adaptation state. */
  pluginMarket(force?: boolean): Promise<IpcResult<PluginMarketState>>
  installPlugin(id: string): Promise<IpcResult<PluginMarketState>>
  removePlugin(id: string): Promise<IpcResult<PluginMarketState>>
  adaptPlugin(id: string): Promise<IpcResult<PluginAdaptResult>>
  readAdaptedPlugin(id: string): Promise<IpcResult<string>>
  /** Install the npm packages the adapted code declares (`// deps:` header). */
  installPluginDependencies(id: string): Promise<IpcResult<PluginMarketState>>
  setPluginEnabled(id: string, enabled: boolean): Promise<IpcResult<PluginMarketState>>
  removeAdaptedPlugin(id: string): Promise<IpcResult<PluginMarketState>>
  getSettings(): Promise<IpcResult<PublicSettings>>
  chooseWorkspace(): Promise<IpcResult<PublicSettings>>
  clearWorkspace(): Promise<IpcResult<PublicSettings>>
  saveModel(input: SaveModelInput): Promise<IpcResult<PublicSettings>>
  agentDesktopState(): Promise<IpcResult<AgentDesktopState>>
  installAgentDesktop(): Promise<IpcResult<AgentDesktopState>>
  setToolAccess(input: SetToolAccessInput): Promise<IpcResult<PublicSettings>>
  setUiPreferences(input: SetUiPreferencesInput): Promise<IpcResult<PublicSettings>>
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
  deleteConversation(input: {
    projectId: string
    conversationId: string
  }): Promise<IpcResult<void>>
  agentsList(): Promise<IpcResult<AgentSummary[]>>
  automationList(): Promise<IpcResult<AutomationListResult>>
  automationCreate(input: CreateAutomationInput): Promise<IpcResult<AutomationTask>>
  automationUpdate(input: UpdateAutomationInput): Promise<IpcResult<AutomationTask>>
  automationDelete(input: AutomationRunInput): Promise<IpcResult<void>>
  automationSetActive(input: { id: string; active: boolean }): Promise<IpcResult<AutomationTask>>
  automationRunNow(input: AutomationRunInput): Promise<IpcResult<AutomationTask>>
  automationRuns(taskId?: string): Promise<IpcResult<AutomationRun[]>>
  listSessions(): Promise<IpcResult<SessionSummary[]>>
  openSession(input: OpenSessionInput): Promise<IpcResult<OpenSessionResult>>
  sendMessage(text: string, mode?: SendMessageMode, sessionId?: string): Promise<IpcResult<void>>
  stop(sessionId?: string): Promise<IpcResult<void>>
  closeSession(sessionId?: string): Promise<IpcResult<void>>
  memoryDiagnostics(): Promise<IpcResult<MemoryDiagnostics>>
  memoryState(): Promise<IpcResult<MemoryWorkspaceState>>
  memorySetMode(mode: MemoryMode): Promise<IpcResult<MemoryWorkspaceState>>
  memoryImportSource(input: ImportSourceInput): Promise<IpcResult<MemorySource | null>>
  memoryImportFiles(input?: ImportSourcesInput): Promise<IpcResult<MemorySource[]>>
  memoryImportSessionEvidence(
    input?: ImportSessionEvidenceInput
  ): Promise<IpcResult<MemorySource | null>>
  memoryListSources(): Promise<IpcResult<MemorySource[]>>
  /** Live retrieval counters (searches, hit rate, latency) for the panel. */
  memoryMetrics(): Promise<IpcResult<MemoryMetrics>>
  /** Embed existing indexed documents that have no vector yet. */
  memoryEmbedPending(): Promise<IpcResult<{ pending: number; started: boolean }>>
  memoryQualitySet(enabled: boolean): Promise<IpcResult<{ enabled: boolean; rerankerReady: boolean }>>
  memoryRevokeSource(id: string): Promise<IpcResult<void>>
  memorySearch(input: MemorySearchInput): Promise<IpcResult<MemorySearchResult>>
  /** Vector constellation of one workspace or of every indexed workspace. */
  memoryGraph(input?: KnowledgeGraphInput): Promise<IpcResult<KnowledgeGraph>>
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
  remoteStatus(): Promise<IpcResult<RemoteAccessStatus>>
  remoteNewCode(): Promise<IpcResult<RemoteAccessStatus>>
  cloudStatus(): Promise<IpcResult<CloudStatus>>
  cloudSetBase(base: string): Promise<IpcResult<CloudStatus>>
  cloudLogin(phone: string, password: string): Promise<IpcResult<CloudStatus>>
  cloudLogout(): Promise<IpcResult<CloudStatus>>
  cloudAccount(): Promise<IpcResult<CloudAccountInfo>>
  cloudQrStart(): Promise<IpcResult<CloudQrTicket>>
  cloudQrPoll(ticket: string): Promise<IpcResult<CloudQrPoll>>
  cloudOpenPage(kind: 'account' | 'admin'): Promise<IpcResult<null>>
  onRemoteActivity(listener: (activity: RemoteActivity) => void): () => void
  onAgentEvent(listener: (payload: AgentEventPayload) => void): () => void
  onHostLog(listener: (line: string) => void): () => void
}

export const IpcChannels = {
  mcpState: 'openfuture:mcp:state',
  mcpSaveServer: 'openfuture:mcp:save-server',
  mcpDeleteServer: 'openfuture:mcp:delete-server',
  mcpSetEnabled: 'openfuture:mcp:set-enabled',
  promptAnswer: 'openfuture:prompt:answer',
  linkResolve: 'openfuture:link:resolve',
  linkOpenExternal: 'openfuture:link:open-external',
  browserCommand: 'openfuture:browser:command',
  browserReply: 'openfuture:browser:reply',
  skillsList: 'openfuture:skills:list',
  skillsSave: 'openfuture:skills:save',
  skillsDelete: 'openfuture:skills:delete',
  skillsLibrary: 'openfuture:skills:library',
  skillsInstall: 'openfuture:skills:install',
  skillsSetEnabled: 'openfuture:skills:set-enabled',
  teamRunsList: 'openfuture:team:runs-list',
  groupChatStart: 'openfuture:group-chat:start',
  groupModelSave: 'openfuture:group-chat:model-save',
  groupModelDelete: 'openfuture:group-chat:model-delete',
  groupChatMembersSet: 'openfuture:group-chat:members-set',
  groupChatsList: 'openfuture:group-chat:list',
  groupChatsGet: 'openfuture:group-chat:get',
  pluginMarket: 'openfuture:plugin:market',
  pluginInstall: 'openfuture:plugin:install',
  pluginRemove: 'openfuture:plugin:remove',
  pluginAdapt: 'openfuture:plugin:adapt',
  pluginReadAdapted: 'openfuture:plugin:read-adapted',
  pluginDepsInstall: 'openfuture:plugin:deps-install',
  pluginSetEnabled: 'openfuture:plugin:set-enabled',
  pluginRemoveAdapted: 'openfuture:plugin:remove-adapted',
  settingsGet: 'openfuture:settings:get',
  workspaceChoose: 'openfuture:settings:choose-workspace',
  workspaceClear: 'openfuture:settings:clear-workspace',
  modelSave: 'openfuture:settings:save-model',
  toolAccessSet: 'openfuture:settings:set-tool-access',
  agentDesktopState: 'openfuture:computer:agent-desktop-state',
  agentDesktopInstall: 'openfuture:computer:agent-desktop-install',
  uiPreferencesSet: 'openfuture:settings:set-ui-preferences',
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
  conversationsDelete: 'openfuture:conversations:delete',
  agentsList: 'openfuture:agents:list',
  automationList: 'openfuture:automation:list',
  automationCreate: 'openfuture:automation:create',
  automationUpdate: 'openfuture:automation:update',
  automationDelete: 'openfuture:automation:delete',
  automationSetActive: 'openfuture:automation:set-active',
  automationRunNow: 'openfuture:automation:run-now',
  automationRuns: 'openfuture:automation:runs',
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
  memoryImportFiles: 'openfuture:memory:import-files',
  memoryListSources: 'openfuture:memory:list-sources',
  memoryMetrics: 'openfuture:memory:metrics',
  memoryEmbedPending: 'openfuture:memory:embed-pending',
  memoryQualitySet: 'openfuture:memory:quality-set',
  memoryRevokeSource: 'openfuture:memory:revoke-source',
  memorySearch: 'openfuture:memory:search',
  memoryGraph: 'openfuture:memory:graph',
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
  remoteStatus: 'openfuture:remote:status',
  remoteNewCode: 'openfuture:remote:new-code',
  cloudStatus: 'openfuture:cloud:status',
  cloudSetBase: 'openfuture:cloud:set-base',
  cloudLogin: 'openfuture:cloud:login',
  cloudLogout: 'openfuture:cloud:logout',
  cloudAccount: 'openfuture:cloud:account',
  cloudQrStart: 'openfuture:cloud:qr-start',
  cloudQrPoll: 'openfuture:cloud:qr-poll',
  cloudOpenPage: 'openfuture:cloud:open-page',
  remoteActivity: 'openfuture:remote:activity',
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
