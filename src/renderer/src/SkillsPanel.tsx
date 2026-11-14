import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SkillInfo, SkillLibraryEntry } from '../../shared/protocol'

type SkillTab = 'installed' | 'library'
type OriginFilter = 'all' | 'builtin' | 'user'

const ORIGIN_LABELS: Record<OriginFilter, string> = {
  all: '全部',
  builtin: '系统',
  user: '个人'
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  const date = new Date(value)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function matches(skill: { name: string; description: string }, query: string): boolean {
  const text = query.trim().toLowerCase()
  if (text === '') return true
  return skill.name.toLowerCase().includes(text) || skill.description.toLowerCase().includes(text)
}

/**
 * Sidebar > 技能: search, enable/disable, inspect and create skills, plus a
 * bundled library of ready-to-install templates.
 */
export function SkillsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [library, setLibrary] = useState<SkillLibraryEntry[]>([])
  const [tab, setTab] = useState<SkillTab>('installed')
  const [origin, setOrigin] = useState<OriginFilter>('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [detail, setDetail] = useState<SkillInfo | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: '', description: '', body: '', explicit: false })

  const load = useCallback(async () => {
    setLoading(true)
    const [list, entries] = await Promise.all([
      window.openfuture.listSkills(),
      window.openfuture.skillLibrary()
    ])
    if (list.ok) setSkills(list.value)
    else setError(list.error.message)
    if (entries.ok) setLibrary(entries.value)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const installedCount = skills.filter((skill) => skill.enabled).length

  const visibleSkills = useMemo(() => {
    return skills.filter((skill) => {
      if (origin !== 'all' && skill.origin !== origin) return false
      return matches(skill, query)
    })
  }, [skills, origin, query])

  const visibleLibrary = useMemo(
    () => library.filter((entry) => matches(entry, query)),
    [library, query]
  )

  const applyList = (list: SkillInfo[], message: string): void => {
    setSkills(list)
    setError(null)
    setNotice(message)
  }

  const toggle = async (skill: SkillInfo): Promise<void> => {
    setBusy(skill.name)
    const result = await window.openfuture.setSkillEnabled(skill.name, !skill.enabled)
    setBusy(null)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    applyList(result.value, skill.enabled ? `已停用 ${skill.name}` : `已启用 ${skill.name}`)
    setDetail(null)
  }

  const remove = async (skill: SkillInfo): Promise<void> => {
    if (!window.confirm(`删除技能 ${skill.name}？这会移除 SKILL.md，无法撤销。`)) return
    setBusy(skill.name)
    const result = await window.openfuture.deleteSkill(skill.name)
    setBusy(null)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    applyList(result.value, `已删除 ${skill.name}`)
    setDetail(null)
  }

  const install = async (entry: SkillLibraryEntry): Promise<void> => {
    setBusy(entry.name)
    const result = await window.openfuture.installLibrarySkill(entry.name)
    setBusy(null)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    applyList(result.value, `已安装 ${entry.name}`)
    setTab('installed')
  }

  const save = async (): Promise<void> => {
    setBusy('create')
    const result = await window.openfuture.saveSkill({
      name: form.name.trim(),
      description: form.description.trim(),
      body: form.body,
      disableModelInvocation: form.explicit
    })
    setBusy(null)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    applyList(result.value, `已保存 ${form.name.trim()}`)
    setCreating(false)
    setForm({ name: '', description: '', body: '', explicit: false })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal skills-modal"
        role="dialog"
        aria-modal="true"
        aria-label="技能"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="skills-head">
          <div>
            <span className="modal-kicker">SKILLS</span>
            <h2>技能</h2>
            <p className="skills-sub">通过任务专用技能扩展 OpenFuture。模型在系统提示里看到名称与描述，按需读取正文。</p>
          </div>
          <div className="skills-tools">
            <label className="skills-search">
              <span aria-hidden="true">⌕</span>
              <input
                value={query}
                placeholder="搜索技能"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button type="button" className="ghost-button" onClick={() => void load()} disabled={loading}>
              刷新
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                setError(null)
                setCreating(true)
              }}
            >
              新建技能
            </button>
            <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
              ×
            </button>
          </div>
        </header>

        {error ? <p className="banner error-banner inline">{error}</p> : null}
        {notice ? <p className="banner notice-banner inline">{notice}</p> : null}

        <div className="skills-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'installed'}
            className={tab === 'installed' ? 'active' : ''}
            onClick={() => setTab('installed')}
          >
            已安装 <span>{installedCount}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'library'}
            className={tab === 'library' ? 'active' : ''}
            onClick={() => setTab('library')}
          >
            技能库 <span>{library.length}</span>
          </button>
          {tab === 'installed' ? (
            <div className="skills-origin">
              {(Object.keys(ORIGIN_LABELS) as OriginFilter[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={origin === key ? 'active' : ''}
                  onClick={() => setOrigin(key)}
                >
                  {ORIGIN_LABELS[key]}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="skills-body">
          {loading ? <p className="skills-empty">正在读取技能…</p> : null}

          {!loading && tab === 'installed' && visibleSkills.length === 0 ? (
            <p className="skills-empty">
              {query.trim() !== '' ? `没有匹配「${query.trim()}」的技能。` : '还没有技能。到「技能库」安装一个，或点「新建技能」。'}
            </p>
          ) : null}

          {!loading && tab === 'installed' ? (
            <div className="skills-grid">
              {visibleSkills.map((skill) => (
                <button
                  key={skill.name}
                  type="button"
                  className={`skills-card${skill.enabled ? '' : ' off'}${skill.origin === 'builtin' ? ' builtin' : ''}`}
                  onClick={() => setDetail(skill)}
                >
                  <span className={`skills-icon ${skill.origin}`} aria-hidden="true">
                    {skill.origin === 'builtin' ? '⌘' : '✦'}
                  </span>
                  <span className="skills-card-main">
                    <span className="skills-card-title">
                      {skill.name}
                      {skill.disableModelInvocation ? <em>仅显式调用</em> : null}
                    </span>
                    <span className="skills-card-desc">{skill.description}</span>
                    <span className="skills-card-meta">
                      {skill.origin === 'builtin' ? '系统' : '个人'} · {formatTime(skill.updatedAt)}
                    </span>
                  </span>
                  <span
                    className={`skills-toggle${skill.enabled ? ' on' : ''}`}
                    role="switch"
                    aria-checked={skill.enabled}
                    aria-label={skill.enabled ? '停用' : '启用'}
                    tabIndex={0}
                    onClick={(event) => {
                      event.stopPropagation()
                      void toggle(skill)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        event.stopPropagation()
                        void toggle(skill)
                      }
                    }}
                  >
                    {skill.enabled ? '✓' : '—'}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {!loading && tab === 'library' && visibleLibrary.length === 0 ? (
            <p className="skills-empty">
              {query.trim() !== '' ? `技能库里没有匹配「${query.trim()}」的条目。` : '技能库为空。'}
            </p>
          ) : null}

          {!loading && tab === 'library' ? (
            <div className="skills-grid">
              {visibleLibrary.map((entry) => (
                <article key={entry.name} className="skills-card library">
                  <span className="skills-icon builtin" aria-hidden="true">⌘</span>
                  <span className="skills-card-main">
                    <span className="skills-card-title">{entry.name}</span>
                    <span className="skills-card-desc">{entry.description}</span>
                    <span className="skills-card-meta">内置模板</span>
                  </span>
                  <button
                    type="button"
                    className="ghost-button skills-install"
                    disabled={busy === entry.name || entry.installed}
                    onClick={() => void install(entry)}
                  >
                    {entry.installed ? '已安装' : busy === entry.name ? '安装中…' : '安装'}
                  </button>
                </article>
              ))}
            </div>
          ) : null}
        </div>

        {detail ? (
          <div className="modal-backdrop skills-detail-backdrop" onClick={() => setDetail(null)}>
            <div className="modal skills-detail" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
              <header>
                <div>
                  <span className="modal-kicker">{detail.origin === 'builtin' ? 'BUILT-IN SKILL' : 'CUSTOM SKILL'}</span>
                  <h3>{detail.name}</h3>
                  <p>{detail.description}</p>
                </div>
                <button type="button" className="icon-button" aria-label="关闭" onClick={() => setDetail(null)}>
                  ×
                </button>
              </header>
              <p className="skills-detail-meta">
                {detail.enabled ? '已启用' : '已停用'} · {detail.disableModelInvocation ? '仅显式调用' : '可自动使用'} · 更新于{' '}
                {formatTime(detail.updatedAt)}
              </p>
              <pre className="skills-detail-body">{detail.body}</pre>
              <p className="skills-path" title={detail.filePath}>
                {detail.filePath}
              </p>
              <footer>
                <button type="button" className="ghost-button" onClick={() => void toggle(detail)} disabled={busy === detail.name}>
                  {detail.enabled ? '停用' : '启用'}
                </button>
                <button type="button" className="ghost-button" onClick={() => void navigator.clipboard.writeText(detail.filePath)}>
                  复制路径
                </button>
                <button type="button" className="ghost-button danger" onClick={() => void remove(detail)} disabled={busy === detail.name}>
                  删除
                </button>
              </footer>
            </div>
          </div>
        ) : null}

        {creating ? (
          <div className="modal-backdrop skills-detail-backdrop" onClick={() => setCreating(false)}>
            <div className="modal skills-detail" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
              <header>
                <div>
                  <span className="modal-kicker">NEW SKILL</span>
                  <h3>新建技能</h3>
                </div>
                <button type="button" className="icon-button" aria-label="关闭" onClick={() => setCreating(false)}>
                  ×
                </button>
              </header>
              <div className="skills-form">
                <label className="field">
                  <span>名称</span>
                  <input
                    value={form.name}
                    placeholder="release-notes"
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>描述</span>
                  <input
                    value={form.description}
                    placeholder="一句话说明何时使用"
                    onChange={(event) => setForm({ ...form, description: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>指令正文</span>
                  <textarea
                    rows={10}
                    value={form.body}
                    placeholder="步骤、约束、输出格式…"
                    onChange={(event) => setForm({ ...form, body: event.target.value })}
                  />
                </label>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={form.explicit}
                    onChange={(event) => setForm({ ...form, explicit: event.target.checked })}
                  />
                  仅显式调用（/skill:&lt;名字&gt;）
                </label>
              </div>
              <footer>
                <button type="button" className="ghost-button" onClick={() => setCreating(false)}>
                  取消
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy === 'create' || form.name.trim() === '' || form.body.trim() === ''}
                  onClick={() => void save()}
                >
                  {busy === 'create' ? '保存中…' : '保存技能'}
                </button>
              </footer>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
