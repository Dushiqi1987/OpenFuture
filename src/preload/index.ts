import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentDesktopState,
  AgentEventPayload,
  BrowserCommand,
  BrowserCommandResult,
  AgentSummary,
  AutomationListResult,
  AutomationRun,
  AutomationTask,
  CreateAutomationInput,
  CorrectNoteInput,
  CreateNoteInput,
  DecideProposalInput,
  DreamApplyInput,
  DreamJob,
  DreamQuality,
  DreamRevokeInput,
  DreamScheduleInput,
  DreamScheduleState,
  DreamRollbackInput,
  DreamState,
  DreamVersion,
  GenerateWikiInput,
  GroupChatMembers,
  GroupChatRecord,
  GroupChatSummary,
  McpConfigState,
  McpServerInput,
  SaveSkillInput,
  SkillInfo,
  SkillLibraryEntry,
  ResolveLinkResult,
  RemoteAccessStatus,
  CloudAccountInfo,
  CloudQrPoll,
  CloudQrTicket,
  CloudStatus,
  RemoteActivity,
  UserPromptAnswerInput,
  ImportSessionEvidenceInput,
  ImportSourcesInput,
  ImportSourceInput,
  IpcResult,
  KnowledgeGraph,
  KnowledgeGraphInput,
  MemoryDiagnostics,
  MemoryMode,
  MemoryNote,
  MemoryProposal,
  MemorySearchHit,
  MemorySearchInput,
  MemorySearchResult,
  MemorySource,
  MemoryMetrics,
  MemoryWorkspaceState,
  OpenFutureApi,
  PluginAdaptResult,
  PluginMarketState,
  OpenSessionInput,
  OpenSessionResult,
  ProjectConversation,
  ProjectInfo,
  ProjectListResult,
  ProjectSelectResult,
  SaveGroupModelProfileInput,
  SetProjectMemoryPresetInput,
  ConversationListResult,
  CreateConversationInput,
  CreateProjectInput,
  OpenConversationInput,
  OpenConversationResult,
  PublicSettings,
  SaveModelInput,
  SendMessageMode,
  SessionSummary,
  AgentGoal,
  GoalStartInput,
  GoalUpdateInput,
  StartGroupChatInput,
  StartGroupChatResult,
  TeamRunSummary,
  SetToolAccessInput,
  SetUiPreferencesInput,
  UpdateAutomationInput,
  UpdateConversationInput,
  UpdateNoteInput,
  WikiPage
} from '../shared/protocol'
import { IpcChannels } from '../shared/protocol'

function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => {
    listener(payload)
  }
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const api: OpenFutureApi = {
  getSettings: () => invoke<PublicSettings>(IpcChannels.settingsGet),
  remoteStatus: () => invoke<RemoteAccessStatus>(IpcChannels.remoteStatus),
  remoteNewCode: () => invoke<RemoteAccessStatus>(IpcChannels.remoteNewCode),
  cloudStatus: () => invoke<CloudStatus>(IpcChannels.cloudStatus),
  cloudSetBase: (base: string) => invoke<CloudStatus>(IpcChannels.cloudSetBase, base),
  cloudLogin: (phone: string, password: string) =>
    invoke<CloudStatus>(IpcChannels.cloudLogin, { phone, password }),
  cloudSendSms: (phone: string) =>
    invoke<{ sent: boolean; devCode?: string }>(IpcChannels.cloudSendSms, phone),
  cloudLoginSms: (phone: string, code: string) =>
    invoke<CloudStatus>(IpcChannels.cloudLoginSms, { phone, code }),
  cloudLogout: () => invoke<CloudStatus>(IpcChannels.cloudLogout),
  cloudAccount: () => invoke<CloudAccountInfo>(IpcChannels.cloudAccount),
  cloudQrStart: () => invoke<CloudQrTicket>(IpcChannels.cloudQrStart),
  cloudQrPoll: (ticket: string) => invoke<CloudQrPoll>(IpcChannels.cloudQrPoll, ticket),
  cloudOpenPage: (kind: 'account' | 'admin') => invoke<null>(IpcChannels.cloudOpenPage, kind),
  chooseWorkspace: () => invoke<PublicSettings>(IpcChannels.workspaceChoose),
  clearWorkspace: () => invoke<PublicSettings>(IpcChannels.workspaceClear),
  saveModel: (input: SaveModelInput) => invoke<PublicSettings>(IpcChannels.modelSave, input),
  setToolAccess: (input: SetToolAccessInput) => invoke<PublicSettings>(IpcChannels.toolAccessSet, input),
  agentDesktopState: () => invoke<AgentDesktopState>(IpcChannels.agentDesktopState),
  installAgentDesktop: () => invoke<AgentDesktopState>(IpcChannels.agentDesktopInstall),
  setUiPreferences: (input: SetUiPreferencesInput) => invoke<PublicSettings>(IpcChannels.uiPreferencesSet, input),
  clearApiKey: () => invoke<PublicSettings>(IpcChannels.apiKeyClear),
  listSessions: () => invoke<SessionSummary[]>(IpcChannels.sessionsList),
  openSession: (input: OpenSessionInput) => invoke<OpenSessionResult>(IpcChannels.sessionOpen, input),
  listProjects: () => invoke<ProjectListResult>(IpcChannels.projectsList),
  listTeamRuns: () => invoke<TeamRunSummary[] | null>(IpcChannels.teamRunsList),
  startGroupChat: (input: StartGroupChatInput) =>
    invoke<StartGroupChatResult>(IpcChannels.groupChatStart, input),
  saveGroupModelProfile: (input: SaveGroupModelProfileInput) =>
    invoke<PublicSettings>(IpcChannels.groupModelSave, input),
  deleteGroupModelProfile: (id: string) =>
    invoke<PublicSettings>(IpcChannels.groupModelDelete, id),
  setGroupChatMembers: (members: GroupChatMembers) =>
    invoke<PublicSettings>(IpcChannels.groupChatMembersSet, members),
  listGroupChats: () => invoke<GroupChatSummary[]>(IpcChannels.groupChatsList),
  getGroupChat: (chatId: string) => invoke<GroupChatRecord>(IpcChannels.groupChatsGet, chatId),
  pluginMarket: (force?: boolean) => invoke<PluginMarketState>(IpcChannels.pluginMarket, force === true),
  installPlugin: (id: string) => invoke<PluginMarketState>(IpcChannels.pluginInstall, id),
  removePlugin: (id: string) => invoke<PluginMarketState>(IpcChannels.pluginRemove, id),
  adaptPlugin: (id: string) => invoke<PluginAdaptResult>(IpcChannels.pluginAdapt, id),
  readAdaptedPlugin: (id: string) => invoke<string>(IpcChannels.pluginReadAdapted, id),
  installPluginDependencies: (id: string) =>
    invoke<PluginMarketState>(IpcChannels.pluginDepsInstall, { id }),
  setPluginEnabled: (id: string, enabled: boolean) =>
    invoke<PluginMarketState>(IpcChannels.pluginSetEnabled, { id, enabled }),
  removeAdaptedPlugin: (id: string) => invoke<PluginMarketState>(IpcChannels.pluginRemoveAdapted, id),
  mcpState: () => invoke<McpConfigState>(IpcChannels.mcpState),
  saveMcpServer: (input: McpServerInput) => invoke<McpConfigState>(IpcChannels.mcpSaveServer, input),
  deleteMcpServer: (name: string) => invoke<McpConfigState>(IpcChannels.mcpDeleteServer, name),
  setMcpServerEnabled: (name: string, enabled: boolean) =>
    invoke<McpConfigState>(IpcChannels.mcpSetEnabled, { name, enabled }),
  answerPrompt: (input: UserPromptAnswerInput) => invoke<null>(IpcChannels.promptAnswer, input),
  resolveLink: (target: string) => invoke<ResolveLinkResult>(IpcChannels.linkResolve, target),
  openExternalTarget: (target: string) => invoke<null>(IpcChannels.linkOpenExternal, target),
  listSkills: () => invoke<SkillInfo[]>(IpcChannels.skillsList),
  skillLibrary: () => invoke<SkillLibraryEntry[]>(IpcChannels.skillsLibrary),
  installLibrarySkill: (name: string) => invoke<SkillInfo[]>(IpcChannels.skillsInstall, name),
  setSkillEnabled: (name: string, enabled: boolean) =>
    invoke<SkillInfo[]>(IpcChannels.skillsSetEnabled, { name, enabled }),
  saveSkill: (input: SaveSkillInput) => invoke<SkillInfo[]>(IpcChannels.skillsSave, input),
  deleteSkill: (name: string) => invoke<SkillInfo[]>(IpcChannels.skillsDelete, name),
  chooseProjectFolder: () => invoke<string | null>(IpcChannels.projectsChooseFolder),
  createProject: (input: CreateProjectInput) =>
    invoke<ProjectSelectResult>(IpcChannels.projectsCreate, input),
  selectProject: (projectId: string) =>
    invoke<ProjectSelectResult>(IpcChannels.projectsSelect, projectId),
  renameProject: (input: { projectId: string; name: string }) =>
    invoke<ProjectInfo>(IpcChannels.projectsRename, input),
  archiveProject: (input: { projectId: string; archived: boolean }) =>
    invoke<ProjectInfo>(IpcChannels.projectsArchive, input),
  setProjectMemoryPreset: (input: SetProjectMemoryPresetInput) =>
    invoke<ProjectInfo>(IpcChannels.projectsSetMemoryPreset, input),
  relocateProject: (projectId: string) =>
    invoke<ProjectInfo>(IpcChannels.projectsRelocate, projectId),
  revealProject: (projectId: string) => invoke<void>(IpcChannels.projectsReveal, projectId),
  listConversations: (projectId: string) =>
    invoke<ConversationListResult>(IpcChannels.conversationsList, projectId),
  createConversation: (input: CreateConversationInput) =>
    invoke<ProjectConversation>(IpcChannels.conversationsCreate, input),
  openConversation: (input: OpenConversationInput) =>
    invoke<OpenConversationResult>(IpcChannels.conversationsOpen, input),
  updateConversation: (input: UpdateConversationInput) =>
    invoke<ProjectConversation>(IpcChannels.conversationsUpdate, input),
  deleteConversation: (input: { projectId: string; conversationId: string }) =>
    invoke<void>(IpcChannels.conversationsDelete, input),
  agentsList: () => invoke<AgentSummary[]>(IpcChannels.agentsList),
  automationList: () => invoke<AutomationListResult>(IpcChannels.automationList),
  automationCreate: (input: CreateAutomationInput) =>
    invoke<AutomationTask>(IpcChannels.automationCreate, input),
  automationUpdate: (input: UpdateAutomationInput) =>
    invoke<AutomationTask>(IpcChannels.automationUpdate, input),
  automationDelete: (input: { id: string }) => invoke<void>(IpcChannels.automationDelete, input),
  automationSetActive: (input: { id: string; active: boolean }) =>
    invoke<AutomationTask>(IpcChannels.automationSetActive, input),
  automationRunNow: (input: { id: string }) =>
    invoke<AutomationTask>(IpcChannels.automationRunNow, input),
  automationRuns: (taskId?: string) =>
    invoke<AutomationRun[]>(IpcChannels.automationRuns, { taskId }),
  sendMessage: (text: string, mode?: SendMessageMode, sessionId?: string) =>
    invoke<void>(IpcChannels.sessionSend, { text, mode, sessionId }),
  stop: (sessionId?: string) => invoke<void>(IpcChannels.sessionStop, { sessionId }),
  closeSession: (sessionId?: string) => invoke<void>(IpcChannels.sessionClose, sessionId),
  memoryDiagnostics: () => invoke<MemoryDiagnostics>(IpcChannels.memoryDiagnostics),
  memoryState: () => invoke<MemoryWorkspaceState>(IpcChannels.memoryState),
  memorySetMode: (mode: MemoryMode) => invoke<MemoryWorkspaceState>(IpcChannels.memorySetMode, mode),
  memoryImportSource: (input: ImportSourceInput) =>
    invoke<MemorySource | null>(IpcChannels.memoryImportSource, input),
  memoryImportSessionEvidence: (input?: ImportSessionEvidenceInput) =>
    invoke<MemorySource | null>(IpcChannels.memoryImportSessionEvidence, input),
  memoryImportFiles: (input?: ImportSourcesInput) =>
    invoke<MemorySource[]>(IpcChannels.memoryImportFiles, input),
  memoryListSources: () => invoke<MemorySource[]>(IpcChannels.memoryListSources),
  memoryMetrics: () => invoke<MemoryMetrics>(IpcChannels.memoryMetrics),
  memoryEmbedPending: () => invoke<{ pending: number; started: boolean }>(IpcChannels.memoryEmbedPending),
  memoryQualitySet: (enabled: boolean) =>
    invoke<{ enabled: boolean; rerankerReady: boolean }>(IpcChannels.memoryQualitySet, enabled),
  goalGet: () => invoke<AgentGoal | null>(IpcChannels.goalGet),
  goalStart: (input: GoalStartInput) => invoke<AgentGoal>(IpcChannels.goalStart, input),
  goalUpdate: (input: GoalUpdateInput) => invoke<AgentGoal | null>(IpcChannels.goalUpdate, input),
  goalClear: () => invoke<null>(IpcChannels.goalClear),
  memoryRevokeSource: (id: string) => invoke<void>(IpcChannels.memoryRevokeSource, id),
  memorySearch: (input: MemorySearchInput) => invoke<MemorySearchResult>(IpcChannels.memorySearch, input),
  memoryGraph: (input?: KnowledgeGraphInput) =>
    invoke<KnowledgeGraph>(IpcChannels.memoryGraph, input ?? {}),
  memoryGet: (id: string) => invoke<MemorySearchHit | null>(IpcChannels.memoryGet, id),
  memoryListNotes: () => invoke<MemoryNote[]>(IpcChannels.memoryListNotes),
  memoryCreateNote: (input: CreateNoteInput) => invoke<MemoryNote>(IpcChannels.memoryCreateNote, input),
  memoryCorrectNote: (input: CorrectNoteInput) =>
    invoke<MemoryProposal>(IpcChannels.memoryCorrectNote, input),
  memoryUpdateNote: (input: UpdateNoteInput) => invoke<MemoryNote>(IpcChannels.memoryUpdateNote, input),
  memoryRevokeNote: (id: string) => invoke<void>(IpcChannels.memoryRevokeNote, id),
  memoryGenerateWiki: (input?: GenerateWikiInput) =>
    invoke<WikiPage[]>(IpcChannels.memoryGenerateWiki, input),
  memoryListWiki: () => invoke<WikiPage[]>(IpcChannels.memoryListWiki),
  memoryPublishWiki: (input: { id: string; revision: number }) =>
    invoke<WikiPage>(IpcChannels.memoryPublishWiki, input),
  memoryRevokeWiki: (id: string) => invoke<void>(IpcChannels.memoryRevokeWiki, id),
  memoryListProposals: () => invoke<MemoryProposal[]>(IpcChannels.memoryListProposals),
  memoryDecideProposal: (input: DecideProposalInput) =>
    invoke<MemoryProposal>(IpcChannels.memoryDecideProposal, input),
  dreamStart: () => invoke<DreamJob>(IpcChannels.dreamStart),
  dreamInspect: (jobId: string) => invoke<DreamJob | null>(IpcChannels.dreamInspect, jobId),
  dreamApply: (input: DreamApplyInput) => invoke<DreamVersion>(IpcChannels.dreamApply, input),
  dreamReject: (jobId: string) => invoke<DreamJob>(IpcChannels.dreamReject, jobId),
  dreamState: () => invoke<DreamState>(IpcChannels.dreamState),
  dreamRollback: (input?: DreamRollbackInput) =>
    invoke<DreamVersion | null>(IpcChannels.dreamRollback, input ?? {}),
  dreamRevoke: (input: DreamRevokeInput) => invoke<DreamVersion>(IpcChannels.dreamRevoke, input),
  dreamQuality: () => invoke<DreamQuality>(IpcChannels.dreamQuality),
  dreamSchedule: () => invoke<DreamScheduleState>(IpcChannels.dreamSchedule),
  dreamSetSchedule: (input: DreamScheduleInput) =>
    invoke<DreamScheduleState>(IpcChannels.dreamSetSchedule, input),
  onRemoteActivity: (listener: (activity: RemoteActivity) => void) =>
    subscribe(IpcChannels.remoteActivity, listener),
  onBrowserCommand: (listener: (command: BrowserCommand) => void) =>
    subscribe(IpcChannels.browserCommand, listener),
  browserReply: (id: string, ok: boolean, value?: BrowserCommandResult, error?: string): void => {
    ipcRenderer.send(IpcChannels.browserReply, { id, ok, value, error })
  },
  onAgentEvent: (listener: (payload: AgentEventPayload) => void) => subscribe(IpcChannels.agentEvent, listener),
  onHostLog: (listener: (line: string) => void) => subscribe(IpcChannels.hostLog, listener)
}

contextBridge.exposeInMainWorld('openfuture', api)
