import { useState } from 'react'
import { Globe, X } from 'lucide-react'
import { normalizeRemoteUrl, type Place } from '../sources'
import { Modal } from './Modal'

export function AddLocation({ onClose, onSave }: { onClose: () => void; onSave: (p: Place) => void }) {
  const [kind, setKind] = useState<'autoindex' | 'webdav'>('autoindex')
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  return (
    <Modal label="添加位置" onClose={onClose}>
      <div className="dialog-heading">
        <Globe size={21} />
        <h2>添加位置</h2>
        <button className="icon-btn" onClick={onClose} aria-label="关闭">
          <X />
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          try {
            const url = normalizeRemoteUrl(address.trim())
            onSave({ name: name.trim() || new URL(url).hostname, url, kind })
          } catch (err) {
            setError(err instanceof Error ? err.message : '地址无效')
          }
        }}
      >
        <label className="field">
          协议
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="autoindex">HTTP autoindex</option>
            <option value="webdav">WebDAV</option>
          </select>
        </label>
        <label className="field">
          目录地址
          <input
            autoFocus
            type="url"
            placeholder="https://example.com/photos/"
            required
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </label>
        <label className="field">
          显示名称（可选）
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="照片" />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary">添加位置</button>
        </div>
      </form>
    </Modal>
  )
}
