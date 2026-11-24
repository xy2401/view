import { useEffect, useState } from 'react'
import { ScanSearch, X } from 'lucide-react'
import { mediaKind, type MediaKind } from '../browser/Files'
import { Modal } from '../locations/Modal'
import { readMagikaSample } from '../sources/magikaSample'
import type { FormatResult } from './identify.worker'

type Props = { url: string; currentKind: MediaKind; onOpenAs: (kind: MediaKind) => void }
const viewerName = { image: '图片', video: '视频', audio: '音频', pdf: 'PDF', text: '文本' }

export function IdentifyFormat({ url, currentKind, onOpenAs }: Props) {
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<FormatResult | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open || result) return
    const controller = new AbortController()
    let worker: Worker | undefined
    async function identify() {
      const sample = await readMagikaSample(url, controller.signal)
      if (controller.signal.aborted) return
      worker = new Worker(new URL('./identify.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<FormatResult | { error: string }>) => {
        if (controller.signal.aborted) return
        if ('error' in event.data) setError(event.data.error)
        else setResult(event.data)
        worker?.terminate()
      }
      worker.onerror = () => {
        if (!controller.signal.aborted) setError('无法加载格式识别工具。')
        worker?.terminate()
      }
      const modelBase = new URL('./models/standard_v3_3/', document.baseURI).href
      worker.postMessage({ modelBase, sample }, [sample.buffer])
    }
    void identify().catch((cause: unknown) => {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : '无法读取文件样本。')
      }
    })
    return () => {
      controller.abort()
      worker?.terminate()
    }
  }, [open, result, url])

  let suggested = result ? mediaKind('file.' + result.label) : 'other'
  if (suggested === 'other' && result?.isText) suggested = 'text'
  return (
    <>
      <button
        className="btn"
        onClick={() => {
          setError('')
          setOpen(true)
        }}
      >
        <ScanSearch size={16} />
        识别格式
      </button>
      {open && (
        <Modal label="识别文件格式" onClose={() => setOpen(false)}>
          <div onKeyDown={(event) => event.stopPropagation()}>
            <div className="dialog-heading">
              <h2>识别文件格式</h2>
              <button className="icon-btn" aria-label="关闭格式识别" onClick={() => setOpen(false)}>
                <X />
              </button>
            </div>
            {error ? (
              <p role="alert">{error}</p>
            ) : result ? (
              <p role="status">
                {result.label === 'unknown' || result.label === 'undefined' ? (
                  'Magika 未能确定文件格式。'
                ) : (
                  <>
                    Magika 识别结果　<strong>{result.label.toUpperCase()}</strong>
                  </>
                )}
              </p>
            ) : (
              <p role="status">正在本机识别文件格式…</p>
            )}
            {result && suggested !== 'other' && suggested !== currentKind && (
              <button
                className="btn primary"
                onClick={() => {
                  onOpenAs(suggested)
                  setOpen(false)
                }}
              >
                以{viewerName[suggested]}打开
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  )
}
