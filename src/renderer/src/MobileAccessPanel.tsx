import { useCallback, useEffect, useState } from 'react'
import type { RemoteAccessStatus } from '../../shared/protocol'

/** Desktop side of the phone bridge: address, pairing code and paired devices. */
export function MobileAccessPanel(): React.JSX.Element {
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  const load = useCallback(async (rotate = false): Promise<void> => {
    const result = rotate ? await window.openfuture.remoteNewCode() : await window.openfuture.remoteStatus()
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setError(null)
    setStatus(result.value)
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [load])

  useEffect(() => {
    if (!status || !status.running) return
    // The code expires after ten minutes; refresh the card so the desktop never
    // shows a code the phone can no longer use.
    const timer = window.setInterval(() => void load(), 30_000)
    return () => window.clearInterval(timer)
  }, [status, load])

  const remaining = status ? Math.max(0, status.codeExpiresAt - now) : 0
  const minutes = Math.floor(remaining / 60_000)
  const seconds = Math.floor((remaining % 60_000) / 1_000)
  const primary = status?.urls[0] ?? `http://127.0.0.1:${status?.port ?? 8787}`

  return (
    <div className="mobile-access">
      <div className="section-title">手机访问</div>
      <p className="field-hint" style={{ marginTop: 0 }}>
        电脑和手机连同一个 Wi-Fi，用手机浏览器打开下面的地址，输入配对码即可。配对一次后手机会记住这台电脑。
      </p>

      {error ? <div className="inline-error">{error}</div> : null}

      {!status ? (
        <div className="field-hint">正在读取手机访问状态…</div>
      ) : (
        <>
          <div className="mobile-url-row">
            <code>{primary}</code>
            {status.urls.length > 1 ? (
              <span className="field-hint">另有 {status.urls.length - 1} 个网卡地址</span>
            ) : null}
          </div>

          <div className="pair-code-card">
            <div>
              <span className="field-hint">配对码（一次性，用后自动更换）</span>
              <div className="pair-code">
                {status.code.split('').map((digit, index) => (
                  <span key={index}>{digit}</span>
                ))}
              </div>
            </div>
            <div className="pair-code-side">
              <span className="field-hint">{minutes}:{String(seconds).padStart(2, '0')} 后失效</span>
              <button type="button" className="secondary-button" onClick={() => void load(true)}>
                换一个
              </button>
            </div>
          </div>

          <div className="section-title" style={{ marginTop: 18 }}>
            已配对设备（{status.devices.length}）
          </div>
          {status.devices.length === 0 ? (
            <div className="field-hint">还没有手机配对。第一次连接时会出现在这里。</div>
          ) : (
            <ul className="device-list">
              {status.devices.map((device) => (
                <li key={`${device.name}-${device.createdAt}`}>
                  <span>{device.name}</span>
                  <small>
                    {new Date(device.createdAt).toLocaleDateString('zh-CN')} 配对
                    {device.lastSeenAt
                      ? ` · ${new Date(device.lastSeenAt).toLocaleTimeString('zh-CN', {
                          hour: '2-digit',
                          minute: '2-digit'
                        })} 在线`
                      : ''}
                  </small>
                </li>
              ))}
            </ul>
          )}

          <p className="field-hint">
            端口 {status.port}。临时关闭：设置环境变量 <code>OF_REMOTE=0</code> 后重启 OpenFuture；关闭后手机无法连接，但数据仍在本机。
          </p>
        </>
      )}
    </div>
  )
}
