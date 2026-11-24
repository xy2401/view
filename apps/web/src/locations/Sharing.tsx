import { useEffect, useState } from 'react'
import { Copy, Eye, EyeOff, Folder, Link, Power, QrCode, X } from 'lucide-react'
import type { DesktopState } from '../sources'

interface Props {
  state: DesktopState
  busy: boolean
  run: (action: () => Promise<unknown>) => void
}
export function Sharing({ state, busy, run }: Props) {
  const [qr, setQr] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [message, setMessage] = useState('')
  const bridge = window.viewDesktop!
  useEffect(() => {
    setQr('')
    setShowKey(false)
    setMessage('')
  }, [state.server?.url, state.server?.key])
  useEffect(() => {
    if (!qr) return
    const timer = window.setTimeout(() => setQr(''), 120_000)
    return () => clearTimeout(timer)
  }, [qr])
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setMessage('已复制')
    } catch {
      setMessage('请选择并复制下方的地址或密钥。')
    }
  }
  return (
    <>
      <section className="sharing-panel">
        <div className="section-heading">
          <h2>局域网服务</h2>
          <span className="status">{state.server ? '运行中' : '已停止'}</span>
        </div>
        {state.server ? (
          <>
            <div className="connection-item">
              <span>访问地址</span>
              <code>{state.server.url}</code>
              <button
                className="icon-btn"
                title="复制地址"
                aria-label="复制地址"
                onClick={() => void copy(state.server!.url)}
              >
                <Copy />
              </button>
            </div>
            <div className="connection-item">
              <span>访问密钥</span>
              <code>{showKey ? state.server.key : '••••••••'}</code>
              <button
                className="icon-btn"
                aria-label={showKey ? '隐藏密钥' : '显示密钥'}
                onClick={() => setShowKey((v) => !v)}
              >
                {showKey ? <EyeOff /> : <Eye />}
              </button>
              <button
                className="icon-btn"
                aria-label="复制密钥"
                onClick={() => void copy(state.server!.key)}
              >
                <Copy />
              </button>
            </div>
            <div className="form-actions">
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const { toDataURL } = await import('qrcode')
                    setQr(await toDataURL(await bridge.pairingUrl(), { width: 208, margin: 2 }))
                  })
                }
              >
                <QrCode size={16} />
                扫码连接
              </button>
              <button className="btn" disabled={busy} onClick={() => run(() => bridge.stopServer())}>
                <Power size={16} />
                停止服务
              </button>
            </div>
            {qr && (
              <figure className="pair-code">
                <img src={qr} alt="共享服务配对二维码" width={208} height={208} />
                <figcaption>用 iPad 扫码，配对码两分钟内有效。</figcaption>
              </figure>
            )}
          </>
        ) : (
          <>
            <p>开启服务后，可用同一局域网中的浏览器查看已共享文件夹。</p>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => run(() => bridge.startServer())}
            >
              <Link size={16} />
              开启共享服务
            </button>
          </>
        )}
        {message && <p role="status">{message}</p>}
      </section>
      <section className="home-section">
        <div className="section-heading">
          <h2>已共享文件夹</h2>
          <span>{state.shares.length}</span>
        </div>
        {state.shares.length ? (
          <div className="entry-list">
            {state.shares.map((place) => (
              <div key={place.url} className="shared-row">
                <Folder size={18} />
                <span>{place.name}</span>
                <button
                  className="icon-btn"
                  aria-label={'关闭共享 ' + place.name}
                  title="关闭共享"
                  disabled={busy}
                  onClick={() => run(() => bridge.setShared(place.url, false))}
                >
                  <X />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">在文件夹内点「HTTP 共享」即可添加。</p>
        )}
      </section>
    </>
  )
}
