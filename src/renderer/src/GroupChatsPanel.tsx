import { useCallback, useEffect, useState } from 'react'
import type {
  GroupChatMembers,
  GroupChatRecord,
  GroupChatStatus,
  GroupChatSummary,
  PublicSettings
} from '../../shared/protocol'

const STATUS_LABELS: Record<GroupChatStatus, string> = {
  running: '进行中',
  consensus: '已达成共识',
  unresolved: '未收敛',
  stalled: '停滞',
  aborted: '已取消',
  failed: '失败'
}

const STAGE_LABELS: Record<string, string> = {
  work: '工作汇报',
  critique: '质疑',
  response: '回应',
  chair: '共识'
}

const ROLE_LABELS: Array<{ id: keyof GroupChatMembers; label: string; hint: string }> = [
  { id: 'lead', label: '主研', hint: '调查与汇报，可用只读工具' },
  { id: 'critic', label: '评审', hint: '只读工具 + 提出质疑与立场' },
  { id: 'chair', label: '主持', hint: '汇总共识，不调用工具' }
]

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  const date = new Date(value)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function memberLabel(members: GroupChatMembers, id: string | null, settings: PublicSettings | null): string {
  if (!id) return '默认模型'
  const profile = settings?.groupModelProfiles.find((item) => item.id === id)
  return profile ? profile.label : id
}

/**
 * Sidebar > 群聊: list past serial discussions, inspect transcripts, and bind a
 * different model profile to each participant (Qwen as lead, DeepSeek as critic…).
 */
export function GroupChatsPanel({
  settings,
  onSettings,
  onHostRestart,
  onClose
}: {
  settings: PublicSettings | null
  onSettings: (settings: PublicSettings) => void
  /** Profile edits rewrite models.json, so main restarts the host process. */
  onHostRestart: () => void
  onClose: () => void
}): React.JSX.Element {
  const [chats, setChats] = useState<GroupChatSummary[]>([])
  const [selected, setSelected] = useState<GroupChatRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [members, setMembers] = useState<GroupChatMembers>(
    settings?.groupChatModels ?? { lead: null, critic: null, chair: null }
  )
  const [editingId, setEditingId] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelId, setModelId] = useState('')
  const [apiKey, setApiKey] = useState('')

  const loadChats = useCallback(async (): Promise<void> => {
    setLoading(true)
    const result = await window.openfuture.listGroupChats()
    setLoading(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setChats(result.value)
    if (result.value.length > 0) {
      const first = result.value[0]!
      const detail = await window.openfuture.getGroupChat(first.chatId)
      if (detail.ok) setSelected(detail.value)
    }
  }, [])

  useEffect(() => {
    void loadChats()
  }, [loadChats])

  useEffect(() => {
    setMembers(settings?.groupChatModels ?? { lead: null, critic: null, chair: null })
  }, [settings?.groupChatModels])

  const openChat = async (chatId: string): Promise<void> => {
    const detail = await window.openfuture.getGroupChat(chatId)
    if (detail.ok) setSelected(detail.value)
    else setError(detail.error.message)
  }

  const saveMembers = async (next: GroupChatMembers): Promise<void> => {
    setMembers(next)
    setBusy(true)
    const result = await window.openfuture.setGroupChatMembers(next)
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    onSettings(result.value)
  }

  const resetProfileForm = (): void => {
    setEditingId(null)
    setLabel('')
    setBaseUrl('')
    setModelId('')
    setApiKey('')
  }

  const editProfile = (id: string): void => {
    const profile = settings?.groupModelProfiles.find((item) => item.id === id)
    if (!profile) return
    setEditingId(profile.id)
    setLabel(profile.label)
    setBaseUrl(profile.baseUrl)
    setModelId(profile.modelId)
    setApiKey('')
  }

  const submitProfile = async (): Promise<void> => {
    if (label.trim() === '' || modelId.trim() === '' || baseUrl.trim() === '') {
      setError('请填写名称、接口地址与模型 ID')
      return
    }
    setBusy(true)
    setError(null)
    const result = await window.openfuture.saveGroupModelProfile({
      ...(editingId ? { id: editingId } : {}),
      label: label.trim(),
      baseUrl: baseUrl.trim(),
      modelId: modelId.trim(),
      ...(apiKey.trim() !== '' ? { apiKey: apiKey.trim() } : {})
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    onSettings(result.value)
    onHostRestart()
    resetProfileForm()
  }

  const removeProfile = async (id: string): Promise<void> => {
    setBusy(true)
    const result = await window.openfuture.deleteGroupModelProfile(id)
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    onSettings(result.value)
    onHostRestart()
    if (editingId === id) resetProfileForm()
  }

  return (
    <div className="dsh-modal-backdrop" onClick={onClose}>
      <div
        className="dsh-modal group-chats-modal"
        role="dialog"
        aria-modal="true"
        aria-label="群聊"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dsh-modal-head">
          <div>
            <span className="dsh-modal-kicker">GROUP CHAT</span>
            <h2>群聊</h2>
          </div>
          <button type="button" className="dsh-modal-close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="group-chats-layout">
          <aside className="group-chats-list">
            <div className="group-chats-list-head">
              <b>历史讨论</b>
              <button type="button" className="dsh-panel-link" onClick={() => void loadChats()}>
                刷新
              </button>
            </div>
            {loading ? <p className="dsh-panel-note">正在加载…</p> : null}
            {!loading && chats.length === 0 ? (
              <p className="dsh-panel-note">还没有群聊。回到对话，点输入框左侧「◈ 群聊」发起一场。</p>
            ) : null}
            {chats.map((chat) => (
              <button
                type="button"
                key={chat.chatId}
                className={`group-chats-item${selected?.chatId === chat.chatId ? ' active' : ''}`}
                onClick={() => void openChat(chat.chatId)}
              >
                <span className="group-chats-item-title">{chat.goal}</span>
                <span className="group-chats-item-meta">
                  <span className={`group-chats-status ${chat.status}`}>{STATUS_LABELS[chat.status]}</span>
                  <span>{chat.messageCount} 条</span>
                  <span>{formatTime(chat.updatedAt)}</span>
                </span>
              </button>
            ))}
          </aside>

          <section className="group-chats-detail">
            <div className="group-chats-section">
              <div className="group-chats-section-head">
                <b>成员与模型</b>
                <span className="dsh-panel-note">
                  每个角色可以绑定一个额外模型；未绑定的角色使用主模型。
                </span>
              </div>
              {ROLE_LABELS.map((role) => (
                <label className="group-chats-member" key={role.id}>
                  <span className="group-chats-member-label">
                    {role.label}
                    <em>{role.hint}</em>
                  </span>
                  <select
                    value={members[role.id] ?? ''}
                    disabled={busy}
                    onChange={(event) => {
                      const next = { ...members, [role.id]: event.target.value || null }
                      void saveMembers(next)
                    }}
                  >
                    <option value="">默认模型</option>
                    {(settings?.groupModelProfiles ?? []).map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.label}（{profile.modelId}）
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              {selected ? (
                <p className="dsh-panel-note">
                  这场群聊实际使用：
                  {ROLE_LABELS.map((role) => `${role.label} ${memberLabel(selected.members, selected.members[role.id], settings)}`).join(' · ')}
                </p>
              ) : null}
            </div>

            <div className="group-chats-section">
              <div className="group-chats-section-head">
                <b>额外模型</b>
                <span className="dsh-panel-note">密钥只保存在本机（safeStorage 加密）。</span>
              </div>
              {(settings?.groupModelProfiles ?? []).map((profile) => (
                <div className="group-chats-profile" key={profile.id}>
                  <span className="group-chats-profile-name">{profile.label}</span>
                  <span className="group-chats-profile-meta">
                    {profile.modelId} · {profile.baseUrl}
                  </span>
                  <button type="button" className="dsh-panel-link" onClick={() => editProfile(profile.id)}>
                    编辑
                  </button>
                  <button
                    type="button"
                    className="dsh-panel-link danger"
                    disabled={busy}
                    onClick={() => void removeProfile(profile.id)}
                  >
                    删除
                  </button>
                </div>
              ))}
              <div className="group-chats-profile-form">
                <input
                  className="group-chats-input"
                  placeholder="显示名称，例如 通义千问"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
                <input
                  className="group-chats-input"
                  placeholder="接口地址，例如 https://dashscope.aliyuncs.com/compatible-mode/v1"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
                <input
                  className="group-chats-input"
                  placeholder="模型 ID，例如 qwen3-max"
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                />
                <input
                  className="group-chats-input"
                  type="password"
                  placeholder={editingId ? 'API Key（留空表示不修改）' : 'API Key'}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <div className="group-chats-form-actions">
                  <button type="button" className="primary-button" disabled={busy} onClick={() => void submitProfile()}>
                    {editingId ? '保存修改' : '添加模型'}
                  </button>
                  {editingId ? (
                    <button type="button" className="dsh-panel-link" onClick={resetProfileForm}>
                      取消
                    </button>
                  ) : null}
                </div>
              </div>
            </div>

            {error ? <p className="form-error">{error}</p> : null}

            <div className="group-chats-section group-chats-transcript">
              <div className="group-chats-section-head">
                <b>{selected ? selected.goal : '讨论记录'}</b>
                {selected ? (
                  <span className="dsh-panel-note">
                    {STATUS_LABELS[selected.status]} · {selected.rounds} 轮 · {selected.messageCount} 条
                  </span>
                ) : null}
              </div>
              {selected?.error ? <p className="form-error">{selected.error}</p> : null}
              {selected && selected.messages.length === 0 ? (
                <p className="dsh-panel-note">这场讨论没有留下发言。</p>
              ) : null}
              {(selected?.messages ?? []).map((message) => (
                <article className={`group-chats-message role-${message.roleId}`} key={message.seq}>
                  <header>
                    <span className="group-chats-seq">#{message.seq}</span>
                    <span className={`group-chats-stage ${message.stage}`}>
                      {STAGE_LABELS[message.stage] ?? message.stage}
                    </span>
                    <span className="group-chats-role">{message.roleLabel}</span>
                    {message.tools.length > 0 ? (
                      <span className="group-chats-tools">{message.tools.length} 次工具</span>
                    ) : null}
                  </header>
                  <div className="group-chats-body">{message.text}</div>
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
