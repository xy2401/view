import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

export default function Pdf({ url }: { url: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const controller = new AbortController()
    let task: ReturnType<typeof getDocument> | undefined
    async function load() {
      let source: { data: Uint8Array } | { url: string }
      if (new URL(url).protocol === 'view-file:') {
        // PDF.js's network loader accepts HTTP URLs. Electron serves local bytes
        // through its scoped file protocol, which the renderer can fetch directly.
        const res = await fetch(url, { signal: controller.signal })
        if (!res.ok) throw new Error('无法读取 PDF')
        source = { data: new Uint8Array(await res.arrayBuffer()) }
      } else source = { url }
      if (controller.signal.aborted) return
      task = getDocument({ ...source, isEvalSupported: false, useWasm: false })
      const result = await task.promise
      if (!controller.signal.aborted) setDoc(result)
    }
    void load().catch(() => {
      if (!controller.signal.aborted) setError('无法打开 PDF，文件可能已损坏或受密码保护。')
    })
    return () => {
      controller.abort()
      void task?.destroy()
    }
  }, [url])

  useEffect(() => {
    if (!doc || !container.current) return
    const viewer = container.current
    let active = true
    let task: RenderTask | undefined
    async function draw() {
      const pdfPage = await doc!.getPage(page)
      if (!active) return
      const raw = pdfPage.getViewport({ scale: 1 })
      const width = Math.max(200, Math.min(1000, viewer.clientWidth - 16))
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const viewport = pdfPage.getViewport({ scale: (width * ratio) / raw.width })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      canvas.style.width = width + 'px'
      canvas.style.maxWidth = '100%'
      canvas.setAttribute('aria-label', '第 ' + page + ' 页')
      viewer.replaceChildren(canvas)
      task = pdfPage.render({ canvas, viewport })
      await task.promise
    }
    void draw().catch(() => {
      if (active) setError('无法渲染这一页。')
    })
    return () => {
      active = false
      task?.cancel()
    }
  }, [doc, page])
  if (error) return <p role="alert">{error}</p>
  return (
    <section className="pdf-preview">
      {!doc && <p role="status">正在读取 PDF…</p>}
      {doc && (
        <div className="pdf-pagination">
          <button
            className="icon-btn"
            aria-label="上一页"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft />
          </button>
          <span>
            第 {page} / {doc.numPages} 页
          </span>
          <button
            className="icon-btn"
            aria-label="下一页"
            disabled={page >= doc.numPages}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight />
          </button>
        </div>
      )}
      <div ref={container} className="pdf-page" />
    </section>
  )
}
