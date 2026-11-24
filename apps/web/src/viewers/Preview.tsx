import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Maximize, X, ZoomIn, ZoomOut } from 'lucide-react'
import { type Entry } from '../sources'
import { FileIcon, mediaKind, readableSize } from '../browser/Files'
import { Modal } from '../locations/Modal'

const Pdf = lazy(() => import('./Pdf'))
const textLimit = 256 * 1024
function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [truncated, setTruncated] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok || !res.body) throw new Error('无法读取文本')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let result = '',
        size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = value.subarray(0, textLimit - size)
        size += chunk.length
        result += decoder.decode(chunk, { stream: true })
        if (chunk.length < value.length) {
          if (!controller.signal.aborted) setTruncated(true)
          await reader.cancel()
          break
        }
      }
      if (!controller.signal.aborted) setText(result + decoder.decode())
    }
    void load().catch(() => {
      if (!controller.signal.aborted) setError('无法读取文本')
    })
    return () => controller.abort()
  }, [url])
  if (error) return <p role="alert">{error}</p>
  return (
    <div className="text-preview">
      {truncated && <p>显示前 256 KB</p>}
      <pre>{text ?? '正在读取…'}</pre>
    </div>
  )
}

export function Preview({
  entry,
  entries,
  onSelect,
  onClose,
}: {
  entry: Entry
  entries: Entry[]
  onSelect: (e: Entry) => void
  onClose: () => void
}) {
  const [zoomWidth, setZoomWidth] = useState<number | null>(null)
  const image = useRef<HTMLImageElement>(null)
  function zoom(factor: number) {
    const node = image.current
    if (node?.naturalWidth) {
      setZoomWidth(
        Math.min(node.naturalWidth * 8, Math.max(1, node.getBoundingClientRect().width * factor)),
      )
    }
  }
  const [error, setError] = useState(false)
  const kind = mediaKind(entry.name)
  const siblings = entries.filter((e) => {
    const other = mediaKind(e.name)
    return (
      !e.directory &&
      (['image', 'video'].includes(kind) ? ['image', 'video'].includes(other) : other === kind)
    )
  })
  const index = siblings.findIndex((e) => e.url === entry.url)
  function step(offset: number) {
    const next = siblings[index + offset]
    if (next) onSelect(next)
  }
  return (
    <Modal label={'预览 ' + entry.name} onClose={onClose} className="preview-dialog">
      <div
        className="preview-content"
        onKeyDown={(e) => {
          if (['VIDEO', 'AUDIO', 'IFRAME'].includes((e.target as HTMLElement).tagName)) return
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault()
            step(e.key === 'ArrowRight' ? 1 : -1)
          }
        }}
      >
        <header className="preview-heading">
          <FileIcon entry={entry} />
          <h2>{entry.name}</h2>
          <button autoFocus className="icon-btn" aria-label="关闭预览" onClick={onClose}>
            <X />
          </button>
        </header>
        <div className="preview-stage">
          {error ? (
            <p role="alert">当前设备无法预览此文件。</p>
          ) : (
            <>
              {kind === 'image' && (
                <img
                  ref={image}
                  className={zoomWidth === null ? 'fit' : 'zoomed'}
                  src={entry.url}
                  alt={entry.name}
                  style={
                    zoomWidth === null
                      ? undefined
                      : {
                          width: zoomWidth,
                          maxWidth: 'none',
                          maxHeight: 'none',
                        }
                  }
                  onError={() => setError(true)}
                />
              )}
              {kind === 'video' && (
                <video controls playsInline src={entry.url} onError={() => setError(true)} />
              )}
              {kind === 'audio' && <audio controls src={entry.url} onError={() => setError(true)} />}
              {kind === 'pdf' && (
                <Suspense fallback={<p>正在读取 PDF…</p>}>
                  <Pdf url={entry.url} />
                </Suspense>
              )}
              {kind === 'text' && <TextPreview url={entry.url} />}
              {kind === 'other' && (
                <div className="unsupported">
                  <FileIcon entry={entry} />
                  <p>暂未支持此文件的预览</p>
                </div>
              )}
            </>
          )}
        </div>
        <footer className="preview-footer">
          <span>{readableSize(entry.size)}</span>
          {kind === 'image' && (
            <div className="view-controls">
              <button className="icon-btn" aria-label="缩小" onClick={() => zoom(0.8)}>
                <ZoomOut />
              </button>
              <button
                className="icon-btn"
                aria-label="原始尺寸"
                title="原始尺寸"
                onClick={() => setZoomWidth(image.current?.naturalWidth ?? null)}
              >
                1:1
              </button>
              <button className="icon-btn" aria-label="适应窗口" onClick={() => setZoomWidth(null)}>
                <Maximize />
              </button>
              <button className="icon-btn" aria-label="放大" onClick={() => zoom(1.25)}>
                <ZoomIn />
              </button>
            </div>
          )}
          <div className="view-controls">
            <button
              disabled={index <= 0}
              className="icon-btn"
              aria-label="上一个"
              onClick={() => step(-1)}
            >
              <ChevronLeft />
            </button>
            <span>
              {index + 1} / {siblings.length}
            </span>
            <button
              disabled={index >= siblings.length - 1}
              className="icon-btn"
              aria-label="下一个"
              onClick={() => step(1)}
            >
              <ChevronRight />
            </button>
          </div>
        </footer>
      </div>
    </Modal>
  )
}
