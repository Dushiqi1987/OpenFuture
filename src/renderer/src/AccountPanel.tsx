import { useCallback, useEffect, useRef, useState } from 'react'
import type { CloudAccountInfo, CloudQrPoll, CloudQrTicket, CloudStatus } from '../../shared/protocol'

interface AccountPanelProps {
  open: boolean
  onClose: () => void
}

type Tab = 'login' | 'qr'

function yuan(micros: number): string {
  return (micros / 1_000_000).toFixed(2)
}

function maskPhone(phone: string): string {
  return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone
}

/**
 * 账户中心：登录 / 注册引导 / 扫码登录 / 余额 / 设备 / 退出。
 * 头像点开就是这里，不再是“设置”。
 */
export function AccountPanel({ open, onClose }: AccountPanelProps): React.JSX.Element | null {
  const [status, setStatus] = useState<CloudStatus | null>(null)
  const [account, setAccount] = useState<CloudAccountInfo | null>(null)
  const [tab, setTab] = useState<Tab>('login')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [baseOpen, setBaseOpen] = useState(false)
  const [base, setBase] = useState('http://127.0.0.1:8090')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')

  const [qr, setQr] = useState<CloudQrTicket | null>(null)
  const [qrState, setQrState] = useState<'idle' | 'pending' | 'claimed' | 'expired'>('idle')
  const [qrLeft, setQrLeft] = useState(0)
  const pollRef = useRef<number | null>(null)

  const stopQr = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const refresh = useCallback(async () => {
    const res = await window.openfuture.cloudStatus()
    if (!res.ok) {
      setError(res.error.message)
      return
    }
    setStatus(res.value)
    setBase(res.value.base)
    if (res.value.signedIn) {
      const me = await window.openfuture.cloudAccount()
      if (me.ok) setAccount(me.value)
      else setError(me.error.message)
    } else {
      setAccount(null)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setError(null)
    setNotice(null)
    setQr(null)
    setQrState('idle')
    stopQr()
    void refresh()
  }, [open, refresh, stopQr])

  useEffect(() => {
    if (!open) {
      stopQr()
      return
    }
    return () => stopQr()
  }, [open, stopQr])

  useEffect(() => {
    if (qrState !== 'pending') return
    const timer = window.setInterval(() => setQrLeft((left) => Math.max(0, left - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [qrState])

  useEffect(() => {
    if (qrState === 'pending' && qrLeft === 0) setQrState('expired')
  }, [qrLeft, qrState])

  const startQr = useCallback(async () => {
    stopQr()
    setError(null)
    setNotice(null)
    setBusy(true)
    setTab('qr')
    try {
      const res = await window.openfuture.cloudQrStart()
      if (!res.ok) {
        setError(res.error.message)
        setQrState('idle')
        return
      }
      setQr(res.value)
      setQrLeft(res.value.expiresInSeconds)
      setQrState('pending')
      const ticket = res.value.ticket
      pollRef.current = window.setInterval(async () => {
        const poll = await window.openfuture.cloudQrPoll(ticket)
        if (!poll.ok) {
          setError(poll.error.message)
          setQrState('idle')
          stopQr()
          return
        }
        const value = poll.value as CloudQrPoll
        if (value.status === 'claimed') {
          stopQr()
          setQrState('claimed')
          setNotice('手机已确认，登录成功')
          void refresh()
        } else if (value.status === 'expired' || value.status === 'used') {
          stopQr()
          setQrState(value.status === 'expired' ? 'expired' : 'claimed')
        }
      }, 1600)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [refresh, stopQr])

  const submitLogin = useCallback(async () => {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      const res = await window.openfuture.cloudLogin(phone.trim(), password)
      if (!res.ok) {
        setError(res.error.message)
        return
      }
      setStatus(res.value)
      setPassword('')
      const me = await window.openfuture.cloudAccount()
      if (me.ok) setAccount(me.value)
      setNotice('登录成功')
    } finally {
      setBusy(false)
    }
  }, [password, phone])

  const saveBase = useCallback(async () => {
    setError(null)
    const res = await window.openfuture.cloudSetBase(base)
    if (!res.ok) {
      setError(res.error.message)
      return
    }
    setStatus(res.value)
    setBase(res.value.base)
    setNotice('服务器地址已保存')
  }, [base])

  const logout = useCallback(async () => {
    setBusy(true)
    try {
      const res = await window.openfuture.cloudLogout()
      if (!res.ok) {
        setError(res.error.message)
        return
      }
      setStatus(res.value)
      setAccount(null)
      setNotice('已退出登录')
    } finally {
      setBusy(false)
    }
  }, [])

  if (!open) return null

  const signedIn = status?.signedIn === true

  return (
    <div className="modal-backdrop account-backdrop" onClick={onClose}>
      <div className="account-panel" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="账户信息">
        <header className="account-head">
          <div>
            <div className="account-kicker">ACCOUNT</div>
            <h2>账户信息</h2>
          </div>
          <button type="button" className="account-close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>

        {error ? <div className="account-alert error">{error}</div> : null}
        {notice ? <div className="account-alert ok">{notice}</div> : null}

        {signedIn && account ? (
          <div className="account-body">
            <div className="account-profile">
              <div className="account-avatar">{(account.nickname || account.phone || '我').slice(0, 1)}</div>
              <div className="account-identity">
                <b>{account.nickname || '未设置昵称'}</b>
                <span>{maskPhone(account.phone)}</span>
              </div>
              <div className="account-balance">
                <em>余额</em>
                <b>¥{account.balanceYuan}</b>
              </div>
            </div>

            <div className="account-actions">
              <button type="button" className="account-primary" onClick={() => void window.openfuture.cloudOpenPage('account')}>
                充值 / 流水
              </button>
              <button type="button" className="account-secondary" onClick={() => void window.openfuture.cloudOpenPage('admin')}>
                管理后台
              </button>
              <button type="button" className="account-ghost" disabled={busy} onClick={() => void logout()}>
                退出登录
              </button>
            </div>

            <div className="account-devices">
              <div className="account-section-title">
                已登录设备 <span>{account.devices.length}</span>
              </div>
              {account.devices.length === 0 ? (
                <div className="account-empty">还没有设备记录。手机扫码或配对后会出现在这里。</div>
              ) : (
                <ul>
                  {account.devices.map((device) => (
                    <li key={device.id}>
                      <span className={`account-dot${device.revoked ? ' revoked' : ''}`} />
                      <b>{device.name || '未命名设备'}</b>
                      <em>{device.kind === 'PC' ? '电脑' : '手机'} · {device.platform || '未知系统'}</em>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="account-foot">
              账号由管理平台统一管理 · 服务地址 {status?.base}
            </div>
          </div>
        ) : (
          <div className="account-body">
            <div className="account-tabs">
              <button type="button" className={tab === 'login' ? 'active' : ''} onClick={() => setTab('login')}>
                账号密码
              </button>
              <button type="button" className={tab === 'qr' ? 'active' : ''} onClick={() => void startQr()}>
                手机扫码
              </button>
            </div>

            {tab === 'login' ? (
              <div className="account-form">
                <label>
                  <span>手机号</span>
                  <input
                    value={phone}
                    inputMode="numeric"
                    placeholder="11 位手机号"
                    onChange={(event) => setPhone(event.target.value)}
                  />
                </label>
                <label>
                  <span>密码</span>
                  <input
                    type="password"
                    value={password}
                    placeholder="至少 6 位"
                    onChange={(event) => setPassword(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void submitLogin()
                    }}
                  />
                </label>
                <button type="button" className="account-primary" disabled={busy} onClick={() => void submitLogin()}>
                  {busy ? '登录中…' : '登录'}
                </button>
                <div className="account-hint">
                  没有账号？在手机浏览器打开
                  <code>{status?.base ?? base}/app.html</code>
                  注册并充值。
                </div>
              </div>
            ) : (
              <div className="account-qr">
                {qr ? (
                  <>
                    <img src={qr.imageDataUrl} alt="登录二维码" />
                    <div className={`account-qr-state ${qrState}`}>
                      {qrState === 'pending'
                        ? `等待手机扫码 · ${qrLeft}s`
                        : qrState === 'claimed'
                          ? '已确认，正在登录…'
                          : qrState === 'expired'
                            ? '二维码已过期'
                            : '正在生成…'}
                    </div>
                    <div className="account-qr-code">
                      扫码不便时，在手机 App「账户」里输入：<b>{qr.code}</b>
                    </div>
                    <button type="button" className="account-ghost" onClick={() => void startQr()}>
                      刷新二维码
                    </button>
                  </>
                ) : (
                  <div className="account-empty">正在向账号服务申请二维码…</div>
                )}
                <p className="account-hint">用手机相机扫码，会在 OpenFuture App 里确认登录。</p>
              </div>
            )}

            <div className="account-server">
              <button type="button" className="account-link" onClick={() => setBaseOpen((v) => !v)}>
                服务器地址：{status?.base ?? base} {baseOpen ? '▴' : '▾'}
              </button>
              {baseOpen ? (
                <div className="account-server-row">
                  <input value={base} onChange={(event) => setBase(event.target.value)} />
                  <button type="button" className="account-secondary" onClick={() => void saveBase()}>
                    保存
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
