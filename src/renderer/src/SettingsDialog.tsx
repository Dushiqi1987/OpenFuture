import { useEffect, useState } from 'react'
import type { PublicSettings } from '../../shared/protocol'

interface SettingsDialogProps {
  open: boolean
  settings: PublicSettings | null
  onClose: () => void
  onSaved: (settings: PublicSettings, notice: string) => void
}

export default function SettingsDialog({
  open,
  settings,
  onClose,
  onSaved
}: SettingsDialogProps): React.JSX.Element | null {
  const [baseUrl, setBaseUrl] = useState('')
  const [modelId, setModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [contextWindow, setContextWindow] = useState('128000')
  const [maxTokens, setMaxTokens] = useState('8192')
  const [reasoning, setReasoning] = useState(false)
  const [allowPowerShell, setAllowPowerShell] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const model = settings?.model
    setBaseUrl(model?.baseUrl ?? '')
    setModelId(model?.modelId ?? '')
    setDisplayName(model?.displayName ?? '')
    setContextWindow(String(model?.contextWindow ?? 128000))
    setMaxTokens(String(model?.maxTokens ?? 8192))
    setReasoning(model?.reasoning ?? false)
    setAllowPowerShell(settings?.allowPowerShell ?? false)
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

  if (!open) return null

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (saving) return
    setError(null)

    const trimmedBaseUrl = baseUrl.trim()
    const trimmedModelId = modelId.trim()
    if (!trimmedBaseUrl) {
      setError('请填写 Base URL')
      return
    }
    if (!trimmedModelId) {
      setError('请填写模型 ID')
      return
    }
    const parsedContext = Number(contextWindow)
    const parsedMaxTokens = Number(maxTokens)
    if (!Number.isInteger(parsedContext) || parsedContext < 1) {
      setError('上下文窗口必须是正整数')
      return
    }
    if (!Number.isInteger(parsedMaxTokens) || parsedMaxTokens < 1) {
      setError('最大输出 token 必须是正整数')
      return
    }

    setSaving(true)
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
      return
    }

    let nextSettings = result.value
    let notice = '模型设置已保存，Agent 进程已重启'
    if (settings && allowPowerShell !== settings.allowPowerShell) {
      const access = await window.openfuture.setToolAccess({ powershell: allowPowerShell })
      if (!access.ok) {
        setSaving(false)
        setError(access.error.message)
        return
      }
      nextSettings = access.value
      notice = allowPowerShell
        ? '已启用 PowerShell 工具，Agent 进程已重启'
        : '已关闭 PowerShell 工具，Agent 进程已重启'
    }
    setSaving(false)
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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="settings-panel" onClick={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <div>
            <h2>模型与密钥</h2>
            <p>接入任意 OpenAI Chat Completions 兼容服务，配置只保存在本机。</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <form className="settings-form" onSubmit={(event) => void handleSubmit(event)}>
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

          {error ? <div className="banner error-banner inline">{error}</div> : null}

          <div className="settings-actions">
            <button
              type="button"
              className="ghost-button danger"
              disabled={saving || !settings?.apiKeyConfigured}
              onClick={() => void handleClearKey()}
            >
              清除已保存的密钥
            </button>
            <div className="settings-actions-right">
              <button type="button" className="ghost-button" onClick={onClose} disabled={saving}>
                取消
              </button>
              <button type="submit" className="primary-button" disabled={saving}>
                {saving ? '保存中…' : '保存设置'}
              </button>
            </div>
          </div>

          <div className="settings-footnote">数据目录：{settings?.agentDir ?? '—'}</div>
        </form>
      </div>
    </div>
  )
}
