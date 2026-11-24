import { useEffect, useRef, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { listEntries, type Entry, type Place } from '../sources'
import { closeDavSession, openDavSession } from '../sources/davSession'

export function DavLogin({
  place,
  url,
  notice,
  onSuccess,
}: {
  place: Place
  url: string
  notice: string
  onSuccess: (entries: Entry[]) => void
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const attempt = useRef<AbortController | null>(null)
  useEffect(() => () => attempt.current?.abort(), [])

  async function login() {
    if (attempt.current) return
    const controller = new AbortController()
    attempt.current = controller
    const discard = () => closeDavSession(place.url)
    controller.signal.addEventListener('abort', discard, { once: true })
    setBusy(true)
    setError('')
    try {
      await openDavSession(place.url, username, password, controller.signal)
      const entries = await listEntries(place, url, controller.signal)
      if (!controller.signal.aborted) {
        controller.signal.removeEventListener('abort', discard)
        onSuccess(entries)
      }
    } catch (err) {
      if (controller.signal.aborted) return
      closeDavSession(place.url)
      if (err instanceof Error && 'status' in err && err.status === 401) {
        setError('用户名或密码有误，请重新输入。')
        setPassword('')
      } else {
        setError(err instanceof Error ? err.message : '登录失败，请重试。')
      }
    } finally {
      controller.signal.removeEventListener('abort', discard)
      if (!controller.signal.aborted) {
        attempt.current = null
        setBusy(false)
      }
    }
  }
  return (
    <form
      className="login-panel"
      aria-label="WebDAV 登录"
      onSubmit={(event) => {
        event.preventDefault()
        void login()
      }}
    >
      <KeyRound size={26} />
      <h2>登录 WebDAV</h2>
      <p className="dav-address">{place.url}</p>
      <label className="field">
        用户名
        <input
          autoFocus
          required
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>
      <label className="field">
        密码
        <input
          required
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {(error || notice) && (
        <p className="error" role="alert">
          {error || notice}
        </p>
      )}
      <button className="btn primary" disabled={busy}>
        {busy ? '正在登录…' : '登录'}
      </button>
    </form>
  )
}
