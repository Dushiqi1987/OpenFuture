import { useEffect, useMemo, useState } from 'react'
import type {
  DreamJob,
  DreamQuality,
  DreamScheduleState,
  DreamState,
  IpcResult,
  MemoryMode,
  MemoryNote,
  MemoryNoteType,
  MemoryProposal,
  MemorySearchHit,
  MemorySource,
  MemoryWorkspaceState,
  PublicSettings,
  TeamRunSummary,
  WikiPage
} from '../../shared/protocol'

interface MemoryPanelProps {
  open: boolean
  settings: PublicSettings | null
  projectName?: string
  onClose: () => void
  onModeChanged: (mode: MemoryMode) => void
}

type Tab = 'overview' | 'sources' | 'search' | 'notes' | 'wiki' | 'proposals' | 'team'

const MODE_LABELS: Record<MemoryMode, string> = {
  off: '关闭',
  rag: 'RAG',
  wiki: 'Wiki',
  both: '组合'
}

const NOTE_TYPES: Array<{ value: MemoryNoteType; label: string }> = [
  { value: 'fact', label: '事实' },
  { value: 'preference', label: '偏好' },
  { value: 'decision', label: '决策' },
  { value: 'rule', label: '规则' },
  { value: 'lesson', label: '经验' }
]

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

export default function MemoryPanel({
  open,
  settings,
  projectName,
  onClose,
  onModeChanged
}: MemoryPanelProps): React.JSX.Element | null {
  const [state, setState] = useState<MemoryWorkspaceState | null>(null)
  const [sources, setSources] = useState<MemorySource[]>([])
  const [notes, setNotes] = useState<MemoryNote[]>([])
  const [wiki, setWiki] = useState<WikiPage[]>([])
  const [proposals, setProposals] = useState<MemoryProposal[]>([])
  const [dream, setDream] = useState<DreamState | null>(null)
  const [job, setJob] = useState<DreamJob | null>(null)
  const [quality, setQuality] = useState<DreamQuality | null>(null)
  const [schedule, setSchedule] = useState<DreamScheduleState | null>(null)
  const [autoDream, setAutoDream] = useState(false)
  const [intervalMinutes, setIntervalMinutes] = useState(240)
  const [tab, setTab] = useState<Tab>('overview')
  const [teamRuns, setTeamRuns] = useState<TeamRunSummary[]>([])
  const [teamStatus, setTeamStatus] = useState('')
  const [teamRefresh, setTeamRefresh] = useState(0)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MemorySearchHit[]>([])
  const [searchMode, setSearchMode] = useState<MemoryMode | null>(null)
  const [searchEngine, setSearchEngine] = useState<'fts5' | 'qmd' | 'wiki'>('fts5')
  const [searchEngineNote, setSearchEngineNote] = useState('')
  const [wikiEngine, setWikiEngine] = useState<'off' | 'mcp'>('off')
  const [wikiNote, setWikiNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [noteType, setNoteType] = useState<MemoryNoteType>('fact')
  const [noteTitle, setNoteTitle] = useState('')
  const [noteBody, setNoteBody] = useState('')

  const workspaceReady = Boolean(settings?.workspace)
  useEffect(() => {
    if (!open || !workspaceReady || tab !== 'team') return
    let active = true
    setTeamRuns([])
    setTeamStatus('正在读取运行记录…')
    void window.openfuture.listTeamRuns().then(unwrap).then((runs) => {
      if (!active) return
      setTeamRuns(runs ?? [])
      setTeamStatus(runs === null ? '当前项目尚未配置多 Agent 桥接。' : runs.length ? '' : '当前项目没有运行记录。')
    }).catch(() => {
      if (active) setTeamStatus('无法读取多 Agent 运行记录，请检查本地桥接。')
    })
    return () => { active = false }
  }, [open, workspaceReady, settings?.workspace, projectName, tab, teamRefresh])

  const load = async (): Promise<void> => {
    if (!settings?.workspace) return
    try {
      setBusy(true)
      setError(null)
      const [nextState, nextSources, nextNotes, nextWiki, nextProposals, nextDream, nextQuality, nextSchedule] =
        await Promise.all([
          window.openfuture.memoryState().then(unwrap),
          window.openfuture.memoryListSources().then(unwrap),
          window.openfuture.memoryListNotes().then(unwrap),
          window.openfuture.memoryListWiki().then(unwrap),
          window.openfuture.memoryListProposals().then(unwrap),
          window.openfuture.dreamState().then(unwrap),
          window.openfuture.dreamQuality().then(unwrap),
          window.openfuture.dreamSchedule().then(unwrap)
        ])
      setState(nextState)
      setSearchEngine(nextState.searchEngine ?? 'fts5')
      setWikiEngine(nextState.wikiEngine ?? 'off')
      setSources(nextSources)
      setNotes(nextNotes)
      setWiki(nextWiki)
      setProposals(nextProposals)
      setDream(nextDream)
      setQuality(nextQuality)
      setSchedule(nextSchedule)
      setAutoDream(nextSchedule.autoDream)
      setIntervalMinutes(nextSchedule.intervalMinutes)
      onModeChanged(nextState.mode)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (open && workspaceReady) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, settings?.workspace])

  const activeSources = useMemo(() => sources.filter((source) => source.status === 'active'), [sources])
  const pendingProposals = proposals.filter((proposal) => proposal.status === 'pending')

  async function run(action: () => Promise<void>): Promise<void> {
    try {
      setBusy(true)
      setError(null)
      await action()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    } finally {
      setBusy(false)
    }
  }

  async function changeMode(mode: MemoryMode): Promise<void> {
    await run(async () => {
      const next = unwrap(await window.openfuture.memorySetMode(mode))
      setState(next)
      onModeChanged(next.mode)
    })
  }

  async function importSource(): Promise<void> {
    await run(async () => {
      const imported = unwrap(await window.openfuture.memoryImportSource({}))
      if (!imported) return
      await load()
      setTab('sources')
    })
  }

  async function importSessionEvidence(): Promise<void> {
    await run(async () => {
      const imported = unwrap(await window.openfuture.memoryImportSessionEvidence({}))
      if (!imported) return
      await load()
      setTab('sources')
    })
  }

  async function revokeSource(id: string): Promise<void> {
    await run(async () => {
      unwrap(await window.openfuture.memoryRevokeSource(id))
      await load()
    })
  }

  async function search(): Promise<void> {
    if (!query.trim()) return
    await run(async () => {
      const result = unwrap(await window.openfuture.memorySearch({ query, limit: 10 }))
      setHits(result.hits)
      setSearchMode(result.mode)
      setSearchEngine(result.engine ?? 'fts5')
      setSearchEngineNote(result.engineNote ?? '')
      setWikiEngine(result.wikiEngine ?? 'off')
      setWikiNote(result.wikiNote ?? '')
      setTab('search')
    })
  }

  async function saveNote(): Promise<void> {
    if (!noteTitle.trim() || !noteBody.trim()) {
      setError('笔记标题与正文不能为空')
      return
    }
    await run(async () => {
      if (editingId) {
        unwrap(
          await window.openfuture.memoryUpdateNote({
            id: editingId,
            type: noteType,
            title: noteTitle,
            body: noteBody
          })
        )
      } else {
        unwrap(
          await window.openfuture.memoryCreateNote({
            type: noteType,
            title: noteTitle,
            body: noteBody
          })
        )
      }
      cancelEdit()
      await load()
    })
  }

  function editNote(note: MemoryNote): void {
    setEditingId(note.id)
    setNoteType(note.type)
    setNoteTitle(note.title)
    setNoteBody(note.body)
    setTab('notes')
  }

  async function correctNote(note: MemoryNote): Promise<void> {
    const corrected = window.prompt('输入纠正后的笔记正文（标题保持不变）', note.body)
    if (!corrected || !corrected.trim()) return
    const suggested = hits
      .filter((hit) => hit.kind === 'evidence')
      .map((hit) => hit.id)
      .join(',')
    const evidence = window.prompt('输入支撑纠正的证据 ID（逗号分隔；可先检索资料）', suggested)
    if (!evidence || !evidence.trim()) {
      setError('纠正笔记必须引用至少一条有效证据')
      return
    }
    const evidenceIds = evidence
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    await run(async () => {
      unwrap(
        await window.openfuture.memoryCorrectNote({
          noteId: note.id,
          body: corrected.trim(),
          evidenceIds
        })
      )
      await load()
      setTab('proposals')
    })
  }

  function cancelEdit(): void {
    setEditingId(null)
    setNoteType('fact')
    setNoteTitle('')
    setNoteBody('')
  }

  async function revokeNote(id: string): Promise<void> {
    await run(async () => {
      unwrap(await window.openfuture.memoryRevokeNote(id))
      await load()
    })
  }

  async function generateWiki(): Promise<void> {
    await run(async () => {
      unwrap(await window.openfuture.memoryGenerateWiki({}))
      await load()
      setTab('wiki')
    })
  }

  async function publishWiki(page: WikiPage): Promise<void> {
    await run(async () => {
      unwrap(await window.openfuture.memoryPublishWiki({ id: page.id, revision: page.revision }))
      await load()
    })
  }

  async function revokeWiki(id: string): Promise<void> {
    await run(async () => {
      unwrap(await window.openfuture.memoryRevokeWiki(id))
      await load()
    })
  }

  async function decideProposal(id: string, approve: boolean): Promise<void> {
    await run(async () => {
      unwrap(await window.openfuture.memoryDecideProposal({ id, approve }))
      await load()
    })
  }

  async function startDream(): Promise<void> {
    await run(async () => {
      const next = unwrap(await window.openfuture.dreamStart())
      setJob(next)
      setTab('overview')
    })
  }

  async function applyDream(): Promise<void> {
    if (!job) return
    await run(async () => {
      const publishId = `publish-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      unwrap(await window.openfuture.dreamApply({ jobId: job.id, publishId }))
      setJob(null)
      await load()
    })
  }

  async function rejectDream(): Promise<void> {
    if (!job) return
    await run(async () => {
      unwrap(await window.openfuture.dreamReject(job.id))
      setJob(null)
      await load()
    })
  }

  async function rollbackDream(versionId?: string): Promise<void> {
    await run(async () => {
      unwrap(await window.openfuture.dreamRollback(versionId ? { versionId } : {}))
      await load()
    })
  }

  async function revokeDream(versionId: string): Promise<void> {
    await run(async () => {
      unwrap(await window.openfuture.dreamRevoke({ versionId }))
      await load()
    })
  }

  async function verifyQuality(): Promise<void> {
    await run(async () => {
      setQuality(unwrap(await window.openfuture.dreamQuality()))
    })
  }

  async function saveSchedule(): Promise<void> {
    await run(async () => {
      const next = unwrap(
        await window.openfuture.dreamSetSchedule({ autoDream, intervalMinutes })
      )
      setSchedule(next)
      setAutoDream(next.autoDream)
      setIntervalMinutes(next.intervalMinutes)
    })
  }

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="memory-panel" onClick={(event) => event.stopPropagation()}>
        <div className="memory-header">
          <div>
            <div className="memory-title">{projectName ? `${projectName} · 记忆库` : '记忆库'}</div>
            <div className="memory-subtitle">
              {settings?.workspace ?? '未选择工作区'} · L0 证据 / L1 笔记 / L2 Wiki
            </div>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            关闭
          </button>
        </div>

        {!workspaceReady ? (
          <div className="memory-empty">请先选择一个工作区。</div>
        ) : (
          <>
            <div className="memory-tabs">
              {(
                [
                  ['overview', '总览'],
                  ['sources', `资料 ${activeSources.length}`],
                  ['search', '检索'],
                  ['notes', `笔记 ${notes.length}`],
                  ['wiki', `Wiki ${wiki.length}`],
                  ['proposals', `候选 ${pendingProposals.length}`],
                  ['team', '协作运行']
                ] as Array<[Tab, string]>
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  className={`memory-tab${tab === value ? ' active' : ''}`}
                  onClick={() => setTab(value)}
                >
                  {label}
                </button>
              ))}
            </div>

            {error ? <div className="memory-error">{error}</div> : null}

            <div className="memory-body">
              {tab === 'team' ? (
                <section>
                  <button type="button" className="ghost-button" onClick={() => setTeamRefresh((value) => value + 1)}>
                    刷新运行记录
                  </button>
                  {teamStatus && <p className="memory-empty" role="status">{teamStatus}</p>}
                  {teamRuns.length > 0 && (
                    <ul>
                      {teamRuns.map((run) => (
                        <li key={run.runId}>
                          <strong>{run.mainGoal}</strong> · {run.status} · {run.tasks} 项任务
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ) : null}
              {tab === 'overview' ? (
                <div className="memory-section">
                  <div className="memory-mode-row">
                    {(['off', 'rag', 'wiki', 'both'] as MemoryMode[]).map((mode) => (
                      <button
                        type="button"
                        key={mode}
                        className={`mode-button${state?.mode === mode ? ' active' : ''}`}
                        disabled={busy}
                        onClick={() => void changeMode(mode)}
                      >
                        {MODE_LABELS[mode]}
                      </button>
                    ))}
                  </div>
                  <div className="memory-stats">
                    <div className="memory-stat">
                      <span className="memory-stat-value">{state?.sourceCount ?? 0}</span>
                      <span className="memory-stat-label">资料</span>
                    </div>
                    <div className="memory-stat">
                      <span className="memory-stat-value">{state?.evidenceCount ?? 0}</span>
                      <span className="memory-stat-label">证据段</span>
                    </div>
                    <div className="memory-stat">
                      <span className="memory-stat-value">{state?.noteCount ?? 0}</span>
                      <span className="memory-stat-label">L1 笔记</span>
                    </div>
                    <div className="memory-stat">
                      <span className="memory-stat-value">{state?.wikiPublishedCount ?? 0}</span>
                      <span className="memory-stat-label">已发布 Wiki</span>
                    </div>
                    <div className="memory-stat">
                      <span className="memory-stat-value">{state?.pendingProposalCount ?? 0}</span>
                      <span className="memory-stat-label">待审候选</span>
                    </div>
                  </div>
                  <p className="memory-hint">
                    关闭模式不注入任何记忆；RAG 检索证据/笔记/Wiki；Wiki 只检索已发布页面；组合检索全部。
                    修改模式后，下一次打开会话时生效。
                  </p>
                  <div className="memory-actions">
                    <button type="button" className="primary-button" disabled={busy} onClick={() => void importSource()}>
                      导入资料
                    </button>
                    <button type="button" className="ghost-button" disabled={busy} onClick={() => void importSessionEvidence()}>
                      导入当前会话
                    </button>
                    <button type="button" className="ghost-button" disabled={busy} onClick={() => void load()}>
                      刷新
                    </button>
                  </div>
                  <div className="dream-section">
                    <div className="memory-card-top">
                      <span className="memory-card-title">Dreaming · L3 启动摘要</span>
                      <span className={`memory-badge ${dream?.active ? 'active' : ''}`}>
                        {dream?.active ? dream.active.label : '未发布'}
                      </span>
                    </div>
                    <p className="memory-hint">
                      Ingest → Light → REM → Deep → Promote。模型只提交结构化裁决；发布由你确认，删除比例上限 25%。
                    </p>
                    <div className="memory-actions">
                      <button type="button" className="primary-button" disabled={busy} onClick={() => void startDream()}>
                        开始 Dreaming
                      </button>
                      {dream?.active ? (
                        <button type="button" className="ghost-button" disabled={busy} onClick={() => void rollbackDream()}>
                          回滚上一版
                        </button>
                      ) : null}
                      <button type="button" className="ghost-button" disabled={busy} onClick={() => void verifyQuality()}>
                        重新校验
                      </button>
                    </div>
                    {quality ? (
                      <div className={`dream-quality ${quality.verified ? 'ok' : 'warn'}`}>
                        <div className="memory-card-top">
                          <span className="memory-card-title">Verify · 质量门</span>
                          <span className={`memory-badge ${quality.verified ? 'active' : 'review'}`}>
                            {quality.verified ? '通过' : '待改进'}
                          </span>
                        </div>
                        <div className="dream-checks">
                          {quality.checks.map((check) => (
                            <div className="dream-check" key={check.name}>
                              <span className={`memory-badge ${check.ok ? 'active' : 'rejected'}`}>
                                {check.ok ? 'OK' : 'FAIL'}
                              </span>
                              <span>{check.detail}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {schedule ? (
                      <div className="dream-schedule">
                        <div className="memory-card-top">
                          <span className="memory-card-title">空闲调度与预算</span>
                          <span className="memory-card-meta">
                            今日 {schedule.tokensToday} / {schedule.dailyBudget} token
                          </span>
                        </div>
                        <div className="dream-schedule-row">
                          <label className="danger-check">
                            <input
                              type="checkbox"
                              checked={autoDream}
                              onChange={(event) => setAutoDream(event.target.checked)}
                            />
                            自动 Dreaming（每 {intervalMinutes} 分钟检查）
                          </label>
                          <input
                            className="memory-input dream-interval"
                            type="number"
                            min={5}
                            max={1440}
                            value={intervalMinutes}
                            onChange={(event) => setIntervalMinutes(Number(event.target.value))}
                          />
                          <button type="button" className="ghost-button small" disabled={busy} onClick={() => void saveSchedule()}>
                            保存调度
                          </button>
                        </div>
                        <div className="memory-card-meta">
                          单次预算 {schedule.perRunBudget} token · 上次运行{' '}
                          {schedule.lastRunAt ? new Date(schedule.lastRunAt).toLocaleString() : '—'}
                        </div>
                      </div>
                    ) : null}
                    {job && job.status === 'review' ? (
                      <div className="dream-review">
                        <div className="memory-card-meta">
                          {job.ops.length} 项裁决 · 删除比例 {(job.deleteRatio * 100).toFixed(0)}% · 待确认
                        </div>
                        <div className="dream-ops">
                          {job.ops.map((op) => (
                            <div className="dream-op" key={op.id}>
                              <span className={`memory-badge ${op.type}`}>{op.type}</span>
                              <span>{op.reason}</span>
                              <span className="memory-card-meta">conf {op.confidence.toFixed(2)}</span>
                            </div>
                          ))}
                        </div>
                        <pre className="dream-preview">{job.l3Preview}</pre>
                        <div className="memory-actions">
                          <button type="button" className="primary-button" disabled={busy} onClick={() => void applyDream()}>
                            发布为 L3
                          </button>
                          <button type="button" className="ghost-button" disabled={busy} onClick={() => void rejectDream()}>
                            拒绝
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {dream && dream.versions.length > 0 ? (
                      <div className="dream-versions">
                        {dream.versions.map((version) => (
                          <div className="memory-card" key={version.id}>
                            <div className="memory-card-top">
                              <span className="memory-card-title">{version.label}</span>
                              <span className={`memory-badge ${version.status}`}>{version.status}</span>
                            </div>
                            <div className="memory-card-meta">
                              {version.summary} · {version.opsCount} 项 · {version.publishId}
                            </div>
                            <div className="memory-actions">
                              {version.status !== 'active' ? (
                                <button
                                  type="button"
                                  className="ghost-button small"
                                  disabled={busy}
                                  onClick={() => void rollbackDream(version.id)}
                                >
                                  回滚到此版
                                </button>
                              ) : null}
                              {version.status !== 'revoked' ? (
                                <button
                                  type="button"
                                  className="ghost-button small"
                                  disabled={busy}
                                  onClick={() => void revokeDream(version.id)}
                                >
                                  撤销
                                </button>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {tab === 'sources' ? (
                <div className="memory-section">
                  <div className="memory-actions">
                    <button type="button" className="primary-button" disabled={busy} onClick={() => void importSource()}>
                      导入资料
                    </button>
                    <button type="button" className="ghost-button" disabled={busy} onClick={() => void importSessionEvidence()}>
                      导入当前会话
                    </button>
                  </div>
                  {sources.length === 0 ? <div className="memory-empty">还没有资料。导入 Markdown/文本后会自动切分为证据段。</div> : null}
                  {sources.map((source) => (
                    <div className="memory-card" key={source.id}>
                      <div className="memory-card-top">
                        <span className="memory-card-title">{source.title}</span>
                        <span className={`memory-badge ${source.status}`}>{source.status === 'active' ? '生效' : '已撤销'}</span>
                      </div>
                      <div className="memory-card-meta">
                        {source.origin} · {source.evidenceCount} 段 · rev {source.revision}
                      </div>
                      {source.status === 'active' ? (
                        <button type="button" className="ghost-button small" onClick={() => void revokeSource(source.id)}>
                          撤销来源
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}

              {tab === 'search' ? (
                <div className="memory-section">
                  <div className="memory-search-row">
                    <input
                      value={query}
                      placeholder="检索记忆（中文短词会用字面匹配兜底）"
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void search()
                      }}
                    />
                    <button type="button" className="primary-button" disabled={busy} onClick={() => void search()}>
                      检索
                    </button>
                  </div>
                  {searchMode ? (
                    <div className="memory-hint">
                      当前模式：{MODE_LABELS[searchMode]} · {hits.length} 条结果 · 检索引擎：{searchEngine.toUpperCase()} · Wiki 引擎：
                      {wikiEngine === 'mcp' ? 'pi-llm-wiki' : '未配置'}
                      {searchEngineNote ? `（${searchEngineNote}）` : ''}
                      {wikiNote ? `（${wikiNote}）` : ''}
                    </div>
                  ) : null}
                  {hits.length === 0 && searchMode ? <div className="memory-empty">没有命中。先导入资料或调整模式。</div> : null}
                  {hits.map((hit) => (
                    <div className="memory-card" key={`${hit.kind}-${hit.id}`}>
                      <div className="memory-card-top">
                        <span className="memory-card-title">{hit.title}</span>
                        <span className="memory-badge">{hit.kind}</span>
                        {hit.engine ? <span className="memory-badge">{hit.engine.toUpperCase()}</span> : null}
                      </div>
                      <div className="memory-excerpt">{hit.excerpt}</div>
                      <div className="memory-card-meta">{hit.citation.label}</div>
                    </div>
                  ))}
                </div>
              ) : null}

              {tab === 'notes' ? (
                <div className="memory-section">
                  <div className="memory-form">
                    <div className="memory-form-row">
                      <select value={noteType} onChange={(event) => setNoteType(event.target.value as MemoryNoteType)}>
                        {NOTE_TYPES.map((type) => (
                          <option key={type.value} value={type.value}>
                            {type.label}
                          </option>
                        ))}
                      </select>
                      <input
                        value={noteTitle}
                        placeholder="笔记标题"
                        onChange={(event) => setNoteTitle(event.target.value)}
                      />
                    </div>
                    <textarea
                      value={noteBody}
                      rows={4}
                      placeholder="Markdown 笔记内容"
                      onChange={(event) => setNoteBody(event.target.value)}
                    />
                    <div className="memory-actions">
                      <button type="button" className="primary-button" disabled={busy} onClick={() => void saveNote()}>
                        {editingId ? '保存修改' : '新建笔记'}
                      </button>
                      {editingId ? (
                        <button type="button" className="ghost-button" onClick={cancelEdit}>
                          取消编辑
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {notes.map((note) => (
                    <div className="memory-card" key={note.id}>
                      <div className="memory-card-top">
                        <span className="memory-card-title">{note.title}</span>
                        <span className={`memory-badge ${note.status}`}>{note.status === 'active' ? '生效' : '已撤销'}</span>
                      </div>
                      <div className="memory-excerpt">{note.body.slice(0, 240)}</div>
                      <div className="memory-card-meta">
                        {note.type} · rev {note.revision}
                      </div>
                      {note.status === 'active' ? (
                        <div className="memory-actions">
                          <button type="button" className="ghost-button small" onClick={() => editNote(note)}>
                            编辑
                          </button>
                          <button type="button" className="ghost-button small" onClick={() => void correctNote(note)}>
                            纠正
                          </button>
                          <button type="button" className="ghost-button small" onClick={() => void revokeNote(note.id)}>
                            撤销
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}

              {tab === 'wiki' ? (
                <div className="memory-section">
                  <div className="memory-actions">
                    <button type="button" className="primary-button" disabled={busy} onClick={() => void generateWiki()}>
                      从最近 12 份有效资料生成综述
                    </button>
                  </div>
                  {wiki.length === 0 ? <div className="memory-empty">还没有 Wiki 页面。生成草稿后需要人工审核发布。</div> : null}
                  {wiki.map((page) => (
                    <div className="memory-card" key={page.id}>
                      <div className="memory-card-top">
                        <span className="memory-card-title">{page.title}</span>
                        <span className={`memory-badge ${page.status}`}>
                          {page.status === 'published' ? '已发布' : page.status === 'draft' ? '草稿' : '已撤销'}
                        </span>
                      </div>
                      {page.stale ? <div className="memory-warning">来源已撤销，页面已过期</div> : null}
                      <div className="memory-excerpt">{page.body.slice(0, 320)}</div>
                      {page.status === 'draft' ? (
                        <details>
                          <summary>查看完整草稿和发布差异</summary>
                          <pre className="memory-excerpt">{page.body}</pre>
                          {page.reviewDiff ? <pre className="memory-excerpt">{page.reviewDiff}</pre> : null}
                        </details>
                      ) : null}
                      <div className="memory-card-meta">
                        slug {page.slug} · rev {page.revision} · {page.sourceIds.length} 个来源
                      </div>
                      {page.status === 'draft' && !page.stale ? (
                        <button type="button" className="primary-button small" disabled={busy} onClick={() => void publishWiki(page)}>
                          审核并发布
                        </button>
                      ) : null}
                      {page.status !== 'revoked' ? (
                        <button type="button" className="ghost-button small" onClick={() => void revokeWiki(page.id)}>
                          撤销
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}

              {tab === 'proposals' ? (
                <div className="memory-section">
                  {proposals.length === 0 ? <div className="memory-empty">还没有候选。Agent 可通过 memory_propose 提交，发布前需要你批准。</div> : null}
                  {proposals.map((proposal) => (
                    <div className="memory-card" key={proposal.id}>
                      <div className="memory-card-top">
                        <span className="memory-card-title">{proposal.title}</span>
                        <span className={`memory-badge ${proposal.status}`}>
                          {proposal.status === 'pending'
                            ? '待审'
                            : proposal.status === 'approved'
                              ? '已批准'
                              : proposal.status === 'stale'
                                ? '需重新预览'
                                : '已拒绝'}
                        </span>
                      </div>
                      <div className="memory-excerpt">{proposal.body}</div>
                      <div className="memory-card-meta">
                        {proposal.kind === 'fix' ? `纠正现有笔记 ${proposal.targetNoteId?.slice(0, 18) ?? ''} · ` : ''}
                        {proposal.evidenceIds.length} 条证据
                      </div>
                      {proposal.status === 'pending' ? (
                        <div className="memory-actions">
                          <button type="button" className="primary-button small" onClick={() => void decideProposal(proposal.id, true)}>
                            {proposal.kind === 'fix' ? '批准纠正' : '批准为 L1 笔记'}
                          </button>
                          <button type="button" className="ghost-button small" onClick={() => void decideProposal(proposal.id, false)}>
                            拒绝
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
