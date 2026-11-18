import { useEffect, useState } from 'react'
import { MobileAccessPanel } from './MobileAccessPanel'
import type {
  AgentDesktopState,
  McpServerInfo,
  McpTransport,
  MessageDensity,
  PublicSettings,
  SendShortcut,
  SkillInfo,
  ThinkingLevel,
  UiTheme
} from '../../shared/protocol'

interface SettingsDialogProps {
  open: boolean
  settings: PublicSettings | null
  onClose: () => void
  onSaved: (settings: PublicSettings, notice: string) => void
}

type SectionId = 'appearance' | 'model' | 'chat' | 'tools' | 'mobile' | 'mcp' | 'skills' | 'about'

const SECTIONS: Array<{ id: SectionId; label: string; hint: string }> = [
  { id: 'appearance', label: '外观', hint: '主题、界面缩放、消息密度' },
  { id: 'model', label: '模型与密钥', hint: 'OpenAI 兼容端点与凭据' },
  { id: 'chat', label: '对话与输入', hint: '发送快捷键、思考等级、上下文压缩' },
  { id: 'tools', label: '工具与权限', hint: 'PowerShell、Computer Use、多 Agent' },
  { id: 'mobile', label: '手机访问', hint: '局域网内用手机查看项目、继续会话' },
  { id: 'mcp', label: 'MCP 服务', hint: '连接外部工具服务器，工具名 mcp__<服务>__<工具>' },
  { id: 'skills', label: '技能', hint: 'SKILL.md 指令包，模型可自动使用或 /skill:<名字> 调用' },
  { id: 'about', label: '关于', hint: '版本、数据目录、密钥' }
]

const SCALES: Array<{ value: number; label: string }> = [
  { value: 0.9, label: '小（90%）' },
  { value: 1, label: '标准（100%）' },
  { value: 1.1, label: '大（110%）' },
  { value: 1.25, label: '特大（125%）' }
]

const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: '关闭（最快）',
  low: '低',
  medium: '中（推荐）',
  high: '高（更慢、更深入）'
}

export default function SettingsDialog({
  open,
  settings,
  onClose,
  onSaved
}: SettingsDialogProps): React.JSX.Element | null {
  const [section, setSection] = useState<SectionId>('appearance')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelId, setModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [contextWindow, setContextWindow] = useState('128000')
  const [maxTokens, setMaxTokens] = useState('8192')
  const [reasoning, setReasoning] = useState(false)
  const [allowPowerShell, setAllowPowerShell] = useState(false)
  const [computerUse, setComputerUse] = useState(false)
  const [agentDesktop, setAgentDesktop] = useState(false)
  const [desktopState, setDesktopState] = useState<AgentDesktopState | null>(null)
  const [desktopBusy, setDesktopBusy] = useState(false)
  const [desktopError, setDesktopError] = useState<string | null>(null)
  const [contextCompression, setContextCompression] = useState(true)
  const [subagents, setSubagents] = useState(true)
  const [subagentConcurrency, setSubagentConcurrency] = useState(3)
  const [groupChat, setGroupChat] = useState(true)
  const [allowFileWrites, setAllowFileWrites] = useState(true)
  const [uiTheme, setUiTheme] = useState<UiTheme>('system')
  const [uiScale, setUiScale] = useState(1)
  const [uiDensity, setUiDensity] = useState<MessageDensity>('comfortable')
  const [uiTimestamps, setUiTimestamps] = useState(true)
  const [uiShortcut, setUiShortcut] = useState<SendShortcut>('enter')
  const [uiThinking, setUiThinking] = useState<ThinkingLevel>('medium')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([])
  const [mcpConfigPath, setMcpConfigPath] = useState('')
  const [mcpError, setMcpError] = useState<string | null>(null)
  const [mcpName, setMcpName] = useState('')
  const [mcpTransport, setMcpTransport] = useState<McpTransport>('stdio')
  const [mcpCommand, setMcpCommand] = useState('')
  const [mcpArgs, setMcpArgs] = useState('')
  const [mcpUrl, setMcpUrl] = useState('')
  const [mcpDescription, setMcpDescription] = useState('')
  const [mcpTimeout, setMcpTimeout] = useState('60')
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [skillsError, setSkillsError] = useState<string | null>(null)
  const [skillName, setSkillName] = useState('')
  const [skillDescription, setSkillDescription] = useState('')
  const [skillBody, setSkillBody] = useState('')
  const [skillExplicit, setSkillExplicit] = useState(false)
  const [entityBusy, setEntityBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    const model = settings?.model
    const ui = settings?.ui
    setBaseUrl(model?.baseUrl ?? '')
    setModelId(model?.modelId ?? '')
    setDisplayName(model?.displayName ?? '')
    setContextWindow(String(model?.contextWindow ?? 128000))
    setMaxTokens(String(model?.maxTokens ?? 8192))
    setReasoning(model?.reasoning ?? false)
    setAllowPowerShell(settings?.allowPowerShell ?? false)
    setComputerUse(settings?.computerUse ?? false)
    setAgentDesktop(settings?.agentDesktop ?? false)
    setContextCompression(settings?.contextCompression ?? true)
    setSubagents(settings?.subagents ?? true)
    setSubagentConcurrency(settings?.subagentConcurrency ?? 3)
    setGroupChat(settings?.groupChat ?? true)
    setAllowFileWrites(settings?.allowFileWrites ?? true)
    setUiTheme(ui?.theme ?? 'system')
    setUiScale(ui?.scale ?? 1)
    setUiDensity(ui?.density ?? 'comfortable')
    setUiTimestamps(ui?.showTimestamps ?? true)
    setUiShortcut(ui?.sendShortcut ?? 'enter')
    setUiThinking(ui?.thinkingLevel ?? 'medium')
    setApiKey('')
    setError(null)
    setSaving(false)
  }, [open, settings])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      const [mcpResult, skillsResult, desktopResult] = await Promise.all([
        window.openfuture.mcpState(),
        window.openfuture.listSkills(),
        window.openfuture.agentDesktopState()
      ])
      if (!cancelled && desktopResult.ok) setDesktopState(desktopResult.value)
      if (cancelled) return
      if (mcpResult.ok) {
        setMcpServers(mcpResult.value.servers)
        setMcpConfigPath(mcpResult.value.path)
        setMcpError(mcpResult.value.errors[0] ?? null)
      } else {
        setMcpError(mcpResult.error.message)
      }
      if (skillsResult.ok) setSkills(skillsResult.value)
      else setSkillsError(skillsResult.error.message)
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  if (!open) return null

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (saving) return
    setError(null)

    const trimmedBaseUrl = baseUrl.trim()
    const trimmedModelId = modelId.trim()
    const parsedContext = Number(contextWindow)
    const parsedMaxTokens = Number(maxTokens)
    // Appearance-only saves must not force the user to configure a model.
    const modelTouched =
      trimmedBaseUrl !== '' || trimmedModelId !== '' || apiKey.trim() !== ''
    if (modelTouched) {
      if (!trimmedBaseUrl) {
        setError('请填写 Base URL')
        setSection('model')
        return
      }
      if (!trimmedModelId) {
        setError('请填写模型 ID')
        setSection('model')
        return
      }
      if (!Number.isInteger(parsedContext) || parsedContext < 1) {
        setError('上下文窗口必须是正整数')
        setSection('model')
        return
      }
      if (!Number.isInteger(parsedMaxTokens) || parsedMaxTokens < 1) {
        setError('最大输出 token 必须是正整数')
        setSection('model')
        return
      }
    }

    setSaving(true)
    const changes: string[] = []
    const model = settings?.model
    const ui = settings?.ui
    const modelChanged =
      modelTouched &&
      (!model ||
        model.baseUrl !== trimmedBaseUrl ||
        model.modelId !== trimmedModelId ||
        (model.displayName ?? '') !== displayName.trim() ||
        model.contextWindow !== parsedContext ||
        model.maxTokens !== parsedMaxTokens ||
        model.reasoning !== reasoning ||
        apiKey.trim() !== '')
    const uiChanged =
      !ui ||
      ui.theme !== uiTheme ||
      ui.scale !== uiScale ||
      ui.density !== uiDensity ||
      ui.showTimestamps !== uiTimestamps ||
      ui.sendShortcut !== uiShortcut ||
      ui.thinkingLevel !== uiThinking
    const toolChanged =
      !settings ||
      allowPowerShell !== settings.allowPowerShell ||
      computerUse !== settings.computerUse ||
      agentDesktop !== settings.agentDesktop ||
      contextCompression !== settings.contextCompression ||
      subagents !== settings.subagents ||
      subagentConcurrency !== settings.subagentConcurrency ||
      groupChat !== settings.groupChat ||
      allowFileWrites !== settings.allowFileWrites

    let nextSettings = settings

    if (modelChanged) {
      const result = await window.openfuture.saveModel({
        baseUrl: trimmedBaseUrl,
        modelId: trimmedModelId,
        displayName: displayName.trim() || undefined,
        contextWindow: parsedContext,
        maxTokens: parsedMaxTokens,
        reasoning,
        apiKey: apiKey.trim() || undefined
      })
      if (!result.ok) {
        setSaving(false)
        setError(result.error.message)
        setSection('model')
        return
      }
      nextSettings = result.value
      changes.push('模型设置已保存')
    }

    if (uiChanged) {
      const result = await window.openfuture.setUiPreferences({
        theme: uiTheme,
        scale: uiScale,
        density: uiDensity,
        showTimestamps: uiTimestamps,
        sendShortcut: uiShortcut,
        thinkingLevel: uiThinking
      })
      if (!result.ok) {
        setSaving(false)
        setError(result.error.message)
        setSection('appearance')
        return
      }
      nextSettings = result.value
      changes.push('界面偏好已保存')
      if (ui?.thinkingLevel !== uiThinking) changes.push(`思考等级改为 ${uiThinking}`)
    }

    if (toolChanged) {
      const access = await window.openfuture.setToolAccess({
        powershell: allowPowerShell,
        computerUse,
        agentDesktop,
        contextCompression,
        subagents,
        subagentConcurrency,
        groupChat,
        allowFileWrites
      })
      if (!access.ok) {
        setSaving(false)
        setError(access.error.message)
        setSection('tools')
        return
      }
      nextSettings = access.value
      const toolChanges: string[] = []
      if (settings && allowPowerShell !== settings.allowPowerShell) {
        toolChanges.push(allowPowerShell ? '已启用 PowerShell 工具' : '已关闭 PowerShell 工具')
      }
      if (settings && computerUse !== settings.computerUse) {
        toolChanges.push(computerUse ? '已启用 Computer Use' : '已关闭 Computer Use')
      }
      if (settings && agentDesktop !== settings.agentDesktop) {
        toolChanges.push(agentDesktop ? '已启用 Agent Desktop' : '已关闭 Agent Desktop')
      }
      if (settings && contextCompression !== settings.contextCompression) {
        toolChanges.push(contextCompression ? '已启用上下文压缩' : '已关闭上下文压缩')
      }
      if (settings && subagents !== settings.subagents) {
        toolChanges.push(subagents ? '已启用并行子 Agent' : '已关闭并行子 Agent')
      } else if (subagents && settings && subagentConcurrency !== settings.subagentConcurrency) {
        toolChanges.push(`子 Agent 并发数改为 ${subagentConcurrency}`)
      }
      if (settings && groupChat !== settings.groupChat) {
        toolChanges.push(groupChat ? '已启用群聊 Agent' : '已关闭群聊 Agent')
      }
      if (settings && allowFileWrites !== settings.allowFileWrites) {
        toolChanges.push(allowFileWrites ? '已允许 Agent 修改文件' : '已禁止 Agent 修改文件')
      }
      changes.push(...toolChanges)
    }

    setSaving(false)
    if (!nextSettings) {
      onClose()
      return
    }
    const notice = changes.length > 0 ? `${changes.join('，')}，已生效` : '设置已是最新'
    onSaved(nextSettings, notice)
  }

  const handleClearKey = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    const result = await window.openfuture.clearApiKey()
    setSaving(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setApiKey('')
    onSaved(result.value, '已清除保存的 API Key')
  }

  const saveMcpServer = async (): Promise<void> => {
    if (entityBusy) return
    setEntityBusy(true)
    setMcpError(null)
    const args = mcpArgs.split(/\s+/).filter((item) => item !== '')
    const result = await window.openfuture.saveMcpServer({
      name: mcpName.trim(),
      transport: mcpTransport,
      command: mcpTransport === 'stdio' ? mcpCommand.trim() : undefined,
      args: mcpTransport === 'stdio' && args.length > 0 ? args : undefined,
      url: mcpTransport === 'url' ? mcpUrl.trim() : undefined,
      description: mcpDescription.trim() || undefined,
      timeout: Number(mcpTimeout) || undefined,
      enabled: true
    })
    setEntityBusy(false)
    if (!result.ok) {
      setMcpError(result.error.message)
      return
    }
    setMcpServers(result.value.servers)
    setMcpConfigPath(result.value.path)
    setMcpError(result.value.errors[0] ?? null)
    setMcpName('')
    setMcpCommand('')
    setMcpArgs('')
    setMcpUrl('')
    setMcpDescription('')
  }

  const toggleMcpServer = async (server: McpServerInfo): Promise<void> => {
    if (entityBusy) return
    setEntityBusy(true)
    const result = await window.openfuture.setMcpServerEnabled(server.name, !server.enabled)
    setEntityBusy(false)
    if (!result.ok) {
      setMcpError(result.error.message)
      return
    }
    setMcpServers(result.value.servers)
    setMcpError(result.value.errors[0] ?? null)
  }

  const removeMcpServer = async (name: string): Promise<void> => {
    if (entityBusy) return
    setEntityBusy(true)
    const result = await window.openfuture.deleteMcpServer(name)
    setEntityBusy(false)
    if (!result.ok) {
      setMcpError(result.error.message)
      return
    }
    setMcpServers(result.value.servers)
    setMcpError(result.value.errors[0] ?? null)
  }

  const saveSkill = async (): Promise<void> => {
    if (entityBusy) return
    setEntityBusy(true)
    setSkillsError(null)
    const result = await window.openfuture.saveSkill({
      name: skillName.trim(),
      description: skillDescription.trim(),
      body: skillBody,
      disableModelInvocation: skillExplicit
    })
    setEntityBusy(false)
    if (!result.ok) {
      setSkillsError(result.error.message)
      return
    }
    setSkills(result.value)
    setSkillName('')
    setSkillDescription('')
    setSkillBody('')
    setSkillExplicit(false)
  }

  const removeSkill = async (name: string): Promise<void> => {
    if (entityBusy) return
    setEntityBusy(true)
    const result = await window.openfuture.deleteSkill(name)
    setEntityBusy(false)
    if (!result.ok) {
      setSkillsError(result.error.message)
      return
    }
    setSkills(result.value)
  }

  const active = SECTIONS.find((item) => item.id === section) ?? { id: section, label: '', hint: '' }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="settings-panel settings-shell" onClick={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <div>
            <h2>设置</h2>
            <p>{active.hint}；配置只保存在本机。</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分类">
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`settings-nav-item${item.id === section ? ' active' : ''}`}
                onClick={() => {
                  setSection(item.id)
                  setError(null)
                }}
              >
                <span>{item.label}</span>
                <small>{item.hint}</small>
              </button>
            ))}
          </nav>

          <form className="settings-form settings-content" onSubmit={(event) => void handleSubmit(event)}>
            {section === 'appearance' ? (
              <>
                <label className="field">
                  <span className="field-label">主题</span>
                  <select value={uiTheme} onChange={(event) => setUiTheme(event.target.value as UiTheme)}>
                    <option value="system">跟随系统</option>
                    <option value="dark">深色</option>
                    <option value="light">浅色</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">界面缩放</span>
                  <select value={uiScale} onChange={(event) => setUiScale(Number(event.target.value))}>
                    {SCALES.map((scale) => (
                      <option key={scale.value} value={scale.value}>
                        {scale.label}
                      </option>
                    ))}
                  </select>
                  <span className="field-hint">缩放立即作用于当前窗口，重启后保持。</span>
                </label>
                <label className="field">
                  <span className="field-label">消息密度</span>
                  <select value={uiDensity} onChange={(event) => setUiDensity(event.target.value as MessageDensity)}>
                    <option value="comfortable">舒适（默认）</option>
                    <option value="compact">紧凑</option>
                  </select>
                </label>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={uiTimestamps}
                    onChange={(event) => setUiTimestamps(event.target.checked)}
                  />
                  <span>在消息旁显示时间</span>
                </label>
              </>
            ) : null}

            {section === 'model' ? (
              <>
                <label className="field">
                  <span className="field-label">模型预设</span>
                  <select
                    value=""
                    disabled={saving}
                    onChange={(event) => {
                      const go = event.target.value === 'opencode-go'
                      if (!event.target.value) return
                      setBaseUrl(go ? 'https://opencode.ai/inference/go/openai/v1' : 'https://dashscope.aliyuncs.com/compatible-mode/v1')
                      setModelId(go ? 'deepseek-v4.1-flash' : 'qwen3.7-flash')
                      setDisplayName(go ? 'DeepSeek V4.1 Flash · OpenCode Go' : 'Qwen3.7 Flash')
                      setContextWindow(go ? '1000000' : '131072')
                      setMaxTokens(go ? '384000' : '65536')
                      setReasoning(true)
                      setApiKey('')
                      setError(null)
                    }}
                  >
                    <option value="">选择模型预设</option>
                    <option value="opencode-go">OpenCode Go · DeepSeek V4.1 Flash</option>
                    <option value="qwen">DashScope · Qwen3.7 Flash</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Base URL</span>
                  <input
                    type="url"
                    value={baseUrl}
                    placeholder="https://api.example.com/v1"
                    spellCheck={false}
                    onChange={(event) => setBaseUrl(event.target.value)}
                  />
                  <span className="field-hint">不要带 /chat/completions 后缀，例如 https://api.openai.com/v1</span>
                </label>

                <div className="field-row">
                  <label className="field">
                    <span className="field-label">模型 ID</span>
                    <input
                      type="text"
                      value={modelId}
                      placeholder="gpt-4.1"
                      spellCheck={false}
                      onChange={(event) => setModelId(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">显示名称（可选）</span>
                    <input
                      type="text"
                      value={displayName}
                      placeholder="默认与模型 ID 相同"
                      onChange={(event) => setDisplayName(event.target.value)}
                    />
                  </label>
                </div>

                <div className="field-row">
                  <label className="field">
                    <span className="field-label">上下文窗口（token）</span>
                    <input
                      type="number"
                      min={1}
                      value={contextWindow}
                      onChange={(event) => setContextWindow(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">最大输出 token</span>
                    <input
                      type="number"
                      min={1}
                      value={maxTokens}
                      onChange={(event) => setMaxTokens(event.target.value)}
                    />
                  </label>
                </div>

                <label className="field">
                  <span className="field-label">API Key</span>
                  <input
                    type="password"
                    value={apiKey}
                    autoComplete="new-password"
                    placeholder={
                      settings?.credentialState === 'bound'
                        ? '已绑定当前端点（留空保持不变）'
                        : settings?.credentialState === 'needs-rebind'
                          ? '重新输入与当前端点匹配的 Key'
                          : '输入 API Key（将与当前端点绑定）'
                    }
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                  <span className="field-hint">
                    密钥与规范化后的 Base URL 绑定，整体经 Windows DPAPI（safeStorage）加密，不写入模型配置；更改端点必须重新输入 Key。
                  </span>
                  {settings?.credentialState === 'needs-rebind' ? (
                    <span className="field-hint danger-hint">
                      检测到旧版或未绑定的密钥，请重新输入与当前端点匹配的 API Key 后才能发送消息。
                    </span>
                  ) : null}
                </label>

                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={reasoning}
                    onChange={(event) => setReasoning(event.target.checked)}
                  />
                  <span>该模型支持推理/思考内容</span>
                </label>
              </>
            ) : null}

            {section === 'chat' ? (
              <>
                <label className="field">
                  <span className="field-label">发送快捷键</span>
                  <select
                    value={uiShortcut}
                    onChange={(event) => setUiShortcut(event.target.value as SendShortcut)}
                  >
                    <option value="enter">Enter 发送，Shift+Enter 换行</option>
                    <option value="ctrl+enter">Ctrl+Enter 发送，Enter 换行</option>
                  </select>
                  <span className="field-hint">发送中以 Ctrl/Cmd+Enter 发送会进入“引导”模式。</span>
                </label>
                <label className="field">
                  <span className="field-label">思考等级</span>
                  <select
                    value={uiThinking}
                    onChange={(event) => setUiThinking(event.target.value as ThinkingLevel)}
                  >
                    {(Object.keys(THINKING_LABELS) as ThinkingLevel[]).map((level) => (
                      <option key={level} value={level}>
                        {THINKING_LABELS[level]}
                      </option>
                    ))}
                  </select>
                  <span className="field-hint">新会话按该等级思考；修改后 Agent 进程会重启一次。</span>
                </label>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={contextCompression}
                    onChange={(event) => setContextCompression(event.target.checked)}
                  />
                  <span>启用上下文压缩（ACP）</span>
                </label>
                <p className="field-hint">压缩会保留最近对话并归档旧消息，关闭后所有历史原样发送给模型。</p>
              </>
            ) : null}

            {section === 'tools' ? (
              <>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={computerUse}
                    onChange={(event) => setComputerUse(event.target.checked)}
                  />
                  <span>启用 Computer Use（桌面自动化，实验性）</span>
                </label>
                <p className="field-hint">
                  通过 windows-mcp 控制鼠标、键盘与截图；启动约需 10–20 秒，失败不会阻塞会话，可随时在界面开关。
                </p>

                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={agentDesktop}
                    onChange={(event) => setAgentDesktop(event.target.checked)}
                  />
                  <span>启用 Agent Desktop（无障碍树，推荐）</span>
                </label>
                <p className="field-hint">
                  Agent Desktop 通过系统无障碍树读取界面并返回 @ref，比截图识别更快更稳；安装后工具名以
                  computer_desktop_ 开头，可与上面的截图后端同时启用。
                </p>
                <div className="settings-entity">
                  <div className="settings-entity-main">
                    <strong>
                      {desktopState?.installed
                        ? `已安装 v${desktopState.version ?? '?'}`
                        : '尚未安装'}
                    </strong>
                    <span className="settings-entity-meta">
                      {desktopState?.path ?? '下载到用户数据目录'}
                    </span>
                  </div>
                  <div className="settings-entity-actions">
                    <button
                      type="button"
                      className="primary-button"
                      disabled={desktopBusy}
                      onClick={async () => {
                        setDesktopBusy(true)
                        setDesktopError(null)
                        const result = await window.openfuture.installAgentDesktop()
                        setDesktopBusy(false)
                        if (result.ok) setDesktopState(result.value)
                        else setDesktopError(result.error.message)
                      }}
                    >
                      {desktopBusy ? '安装中…' : desktopState?.installed ? '重新安装' : '安装 Agent Desktop'}
                    </button>
                  </div>
                </div>
                {desktopError ? <p className="field-hint danger-hint">{desktopError}</p> : null}

                <label className="checkbox-field danger-check">
                  <input
                    type="checkbox"
                    checked={allowPowerShell}
                    onChange={(event) => setAllowPowerShell(event.target.checked)}
                  />
                  <span>允许 Agent 使用 PowerShell（高风险）</span>
                </label>
                <p className="field-hint danger-hint">
                  PowerShell 可以读写文件、执行系统命令。默认关闭；仅在需要时开启，Agent 进程会随之重启。
                </p>

                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={allowFileWrites}
                    onChange={(event) => setAllowFileWrites(event.target.checked)}
                  />
                  <span>允许 Agent 修改文件（write / edit）</span>
                </label>
                <p className="field-hint">
                  开启后，模型可以新建或改写工作区内的文件；每次改动都会在回答里显示「已编辑 N
                  个文件」和逐文件增删行数。写操作仍受工作区策略限制（不能越出工作区、不能碰密钥与应用配置目录）。
                </p>

                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={subagents}
                    onChange={(event) => setSubagents(event.target.checked)}
                  />
                  <span>启用并行子 Agent（delegate_tasks）</span>
                </label>
                <label className="field">
                  <span className="field-label">子 Agent 并发数</span>
                  <select
                    value={subagentConcurrency}
                    disabled={!subagents}
                    onChange={(event) => setSubagentConcurrency(Number(event.target.value))}
                  >
                    {[1, 2, 3, 4].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="field-hint">
                  开启后，主 Agent 可一次派发最多 4 个自包含子任务并行执行，结果显示在输入框上方。子 Agent
                  共享同一工作区且不继承对话历史，不要并发写同一批文件；子 Agent 仍以当前会话角色身份作答。
                </p>

                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={groupChat}
                    onChange={(event) => setGroupChat(event.target.checked)}
                  />
                  <span>启用群聊 Agent（start_group_chat）</span>
                </label>
                <p className="field-hint">
                  开启后，主 Agent 可发起一场「主研 + 评审 + 主持」的串行群聊：主研先调查并汇报，评审逐条质疑，主研回应修订，最多
                  3 轮，最后综合成共识或未收敛结论。群聊只开放只读工具，结果与每一轮发言显示在输入框上方。
                </p>
              </>
            ) : null}

            {section === 'mobile' ? <MobileAccessPanel /> : null}

            {section === 'mcp' ? (
              <>
                <p className="field-hint">
                  配置保存在 <code>{mcpConfigPath || '…'}</code>。启用后工具以{' '}
                  <code>mcp__&lt;服务&gt;__&lt;工具&gt;</code> 出现在新会话里；保存后会重载 Agent 进程。
                </p>
                {mcpError ? <p className="banner error-banner inline">{mcpError}</p> : null}
                <div className="settings-entity-list">
                  {mcpServers.length === 0 ? (
                    <p className="settings-empty">还没有配置 MCP 服务。</p>
                  ) : null}
                  {mcpServers.map((server) => (
                    <div className="settings-entity" key={server.name}>
                      <div className="settings-entity-main">
                        <strong>{server.name}</strong>
                        <span className="settings-entity-meta">
                          {server.transport === 'stdio'
                            ? `${server.command ?? ''} ${(server.args ?? []).join(' ')}`.trim()
                            : (server.url ?? '')}
                        </span>
                        {server.description ? (
                          <span className="settings-entity-meta">{server.description}</span>
                        ) : null}
                      </div>
                      <div className="settings-entity-actions">
                        <label className="checkbox-field">
                          <input
                            type="checkbox"
                            checked={server.enabled}
                            disabled={entityBusy}
                            onChange={() => void toggleMcpServer(server)}
                          />
                          <span>{server.enabled ? '已启用' : '已停用'}</span>
                        </label>
                        <button
                          type="button"
                          className="ghost-button danger"
                          disabled={entityBusy}
                          onClick={() => void removeMcpServer(server.name)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="settings-entity-add">
                  <h3>添加 MCP 服务</h3>
                  <div className="field-row">
                    <label className="field">
                      <span className="field-label">名称</span>
                      <input
                        type="text"
                        value={mcpName}
                        placeholder="demo"
                        spellCheck={false}
                        onChange={(event) => setMcpName(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">传输方式</span>
                      <select
                        value={mcpTransport}
                        onChange={(event) => setMcpTransport(event.target.value as McpTransport)}
                      >
                        <option value="stdio">stdio（本地命令）</option>
                        <option value="url">url（HTTP）</option>
                      </select>
                    </label>
                  </div>
                  {mcpTransport === 'stdio' ? (
                    <div className="field-row">
                      <label className="field">
                        <span className="field-label">命令</span>
                        <input
                          type="text"
                          value={mcpCommand}
                          placeholder="npx"
                          spellCheck={false}
                          onChange={(event) => setMcpCommand(event.target.value)}
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">参数（空格分隔）</span>
                        <input
                          type="text"
                          value={mcpArgs}
                          placeholder="-y @modelcontextprotocol/server-filesystem D:\data"
                          spellCheck={false}
                          onChange={(event) => setMcpArgs(event.target.value)}
                        />
                      </label>
                    </div>
                  ) : (
                    <label className="field">
                      <span className="field-label">URL</span>
                      <input
                        type="url"
                        value={mcpUrl}
                        placeholder="https://example.com/mcp"
                        spellCheck={false}
                        onChange={(event) => setMcpUrl(event.target.value)}
                      />
                    </label>
                  )}
                  <div className="field-row">
                    <label className="field">
                      <span className="field-label">描述（可选）</span>
                      <input
                        type="text"
                        value={mcpDescription}
                        placeholder="给模型看的用途说明"
                        onChange={(event) => setMcpDescription(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">超时（秒）</span>
                      <input
                        type="number"
                        min={5}
                        value={mcpTimeout}
                        onChange={(event) => setMcpTimeout(event.target.value)}
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={entityBusy || mcpName.trim() === ''}
                    onClick={() => void saveMcpServer()}
                  >
                    {entityBusy ? '保存中…' : '添加服务'}
                  </button>
                </div>
              </>
            ) : null}

            {section === 'skills' ? (
              <>
                <p className="field-hint">
                  技能是带 frontmatter 的 <code>SKILL.md</code>：模型会在系统提示里看到名称与描述，
                  需要时读取正文；勾选「仅显式调用」后只能用 <code>/skill:&lt;名字&gt;</code> 触发。
                  搜索、启停、详情与内置技能库在左侧栏「技能」面板。
                </p>
                {skillsError ? <p className="banner error-banner inline">{skillsError}</p> : null}
                <div className="settings-entity-list">
                  {skills.length === 0 ? <p className="settings-empty">还没有技能。</p> : null}
                  {skills.filter((skill) => skill.enabled).map((skill) => (
                    <div className="settings-entity" key={skill.name}>
                      <div className="settings-entity-main">
                        <strong>{skill.name}</strong>
                        <span className="settings-entity-meta">{skill.description}</span>
                        <span className="settings-entity-meta">
                          {skill.disableModelInvocation ? '仅显式调用' : '模型可自动使用'} ·{' '}
                          {new Date(skill.updatedAt).toLocaleString()}
                        </span>
                      </div>
                      <div className="settings-entity-actions">
                        <button
                          type="button"
                          className="ghost-button danger"
                          disabled={entityBusy}
                          onClick={() => void removeSkill(skill.name)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="settings-entity-add">
                  <h3>新建技能</h3>
                  <div className="field-row">
                    <label className="field">
                      <span className="field-label">名称</span>
                      <input
                        type="text"
                        value={skillName}
                        placeholder="release-notes"
                        spellCheck={false}
                        onChange={(event) => setSkillName(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">描述</span>
                      <input
                        type="text"
                        value={skillDescription}
                        placeholder="一句话说明何时使用"
                        onChange={(event) => setSkillDescription(event.target.value)}
                      />
                    </label>
                  </div>
                  <label className="field">
                    <span className="field-label">指令正文</span>
                    <textarea
                      rows={6}
                      value={skillBody}
                      placeholder="步骤、约束、输出格式…"
                      onChange={(event) => setSkillBody(event.target.value)}
                    />
                  </label>
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={skillExplicit}
                      onChange={(event) => setSkillExplicit(event.target.checked)}
                    />
                    <span>仅显式调用（/skill:{skillName.trim() || '<名字>'}）</span>
                  </label>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={
                      entityBusy ||
                      skillName.trim() === '' ||
                      skillDescription.trim() === '' ||
                      skillBody.trim() === ''
                    }
                    onClick={() => void saveSkill()}
                  >
                    {entityBusy ? '保存中…' : '保存技能'}
                  </button>
                </div>
              </>
            ) : null}

            {section === 'about' ? (
              <>
                <div className="settings-about">
                  <div>
                    <span className="field-label">OpenFuture</span>
                    <p>{settings?.appVersion ?? '—'} · 协议 v{settings?.version ?? '—'}</p>
                  </div>
                  <div>
                    <span className="field-label">数据目录</span>
                    <p className="settings-path">{settings?.agentDir ?? '—'}</p>
                  </div>
                  <div>
                    <span className="field-label">密钥状态</span>
                    <p>
                      {settings?.credentialState === 'bound'
                        ? '已绑定当前端点'
                        : settings?.credentialState === 'needs-rebind'
                          ? '需要重新绑定'
                          : '尚未配置'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="ghost-button danger"
                  disabled={saving || !settings?.apiKeyConfigured}
                  onClick={() => void handleClearKey()}
                >
                  清除已保存的密钥
                </button>
                <p className="field-hint">清除后发送消息前需要重新输入 API Key。</p>
              </>
            ) : null}

            {error ? <div className="banner error-banner inline">{error}</div> : null}

            <div className="settings-actions">
              <div className="settings-actions-right">
                <button type="button" className="ghost-button" onClick={onClose} disabled={saving}>
                  取消
                </button>
                <button type="submit" className="primary-button" disabled={saving}>
                  {saving ? '保存中…' : '保存设置'}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
