import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Maximize, X, ZoomIn, ZoomOut } from 'lucide-react'
import { type Entry } from '../sources'
import { FileIcon, mediaKind, readableSize, type MediaKind } from '../browser/Files'
import { detectKind } from '../sources/detect'
import { IdentifyFormat } from './IdentifyFormat'
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

interface PreviewProps {
  entry: Entry
  entries: Entry[]
  onSelect: (e: Entry) => void
  onClose: () => void
}

export function Preview(props: PreviewProps) {
  // Remember only the kind of entries seen during this open preview. It helps
  // the previous/next buttons group renamed files and never skips a fresh read.
  const [observed] = useState(() => new Map<string, MediaKind>())
  return <FilePreview key={props.entry.url} {...props} observed={observed} />
}

function FilePreview({
  entry,
  entries,
  onSelect,
  onClose,
  observed,
}: PreviewProps & { observed: Map<string, MediaKind> }) {
  const [kind, setKind] = useState<MediaKind | null>(null)
  const [mediaCrossOrigin, setMediaCrossOrigin] = useState<'anonymous'>()
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    async function identify() {
      let detected: MediaKind | null = null
      try {
        detected = await detectKind(entry.url, controller.signal)
        if (controller.signal.aborted) return
        const url = new URL(entry.url)
        if ((url.protocol === 'https:' || url.protocol === 'http:') && url.origin !== location.origin) {
          // Keep the successful CORS mode when media has a misleading Content-Type.
          setMediaCrossOrigin('anonymous')
        }
      } catch (err) {
        if (controller.signal.aborted) return
        const status = err instanceof Error && 'status' in err ? err.status : undefined
        if (status === 401 || status === 403 || status === 404 || status === 410) {
          setError('此文件不存在或无法访问。')
          return
        }
        // A remote server can permit media embedding while disallowing fetch.
        // The name still gives us a viewer to try in that case.
      }
      if (controller.signal.aborted) return
      const resolved = detected ?? mediaKind(entry.name)
      observed.set(entry.url, resolved)
      setKind(resolved)
    }
    void identify()
    return () => controller.abort()
  }, [entry.url, entry.name, observed])
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
  const siblings = entries.filter((e) => {
    if (e.directory) return false
    if (e.url === entry.url) return true
    const other = observed.get(e.url) ?? mediaKind(e.name)
    return kind === 'image' || kind === 'video' ? other === 'image' || other === 'video' : other === kind
  })
  if (!siblings.some((e) => e.url === entry.url)) siblings.push(entry)
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
          const target = e.target as HTMLElement
          if (target.closest('dialog') !== e.currentTarget.closest('dialog')) return
          if (['VIDEO', 'AUDIO', 'IFRAME'].includes(target.tagName)) return
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
            <p role="alert">{error}</p>
          ) : kind === null ? (
            <p role="status">正在识别文件…</p>
          ) : (
            <>
              {kind === 'image' && (
                <img
                  ref={image}
                  className={zoomWidth === null ? 'fit' : 'zoomed'}
                  crossOrigin={mediaCrossOrigin}
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
                  onError={() => setError('当前设备无法预览此文件。')}
                />
              )}
              {kind === 'video' && (
                <video
                  controls
                  playsInline
                  crossOrigin={mediaCrossOrigin}
                  src={entry.url}
                  onError={() => setError('当前设备无法预览此文件。')}
                />
              )}
              {kind === 'audio' && (
                <audio
                  controls
                  crossOrigin={mediaCrossOrigin}
                  src={entry.url}
                  onError={() => setError('当前设备无法预览此文件。')}
                />
              )}
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
          {kind !== null && (
            <IdentifyFormat
              url={entry.url}
              currentKind={kind}
              onOpenAs={(next) => {
                if (next === 'other') return
                observed.set(entry.url, next)
                setError('')
                setKind(next)
              }}
            />
          )}
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
