import { PDFDataRangeTransport } from 'pdfjs-dist'

const chunkSize = 64 * 1024

/** The local file protocol guarantees single-range responses and exposes Content-Range. */
async function readRange(url: string, begin: number, end: number, signal: AbortSignal) {
  const response = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` }, signal })
  const bounds = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '')
  const length = Number(bounds?.[3])
  const expectedEnd = Math.min(end, length)
  if (
    response.status !== 206 ||
    !Number.isSafeInteger(length) ||
    Number(bounds?.[1]) !== begin ||
    Number(bounds?.[2]) !== expectedEnd - 1 ||
    Number(response.headers.get('Content-Length')) !== expectedEnd - begin
  ) {
    await response.body?.cancel()
    throw new Error('无法读取 PDF 片段')
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength !== expectedEnd - begin) throw new Error('PDF 片段不完整')
  return { length, bytes }
}

export async function localPdfSource(url: string, signal: AbortSignal, onError: () => void) {
  const first = await readRange(url, 0, chunkSize, signal)
  if (first.bytes.byteLength === first.length) return { data: first.bytes }

  class LocalPdfRanges extends PDFDataRangeTransport {
    requestDataRange(begin: number, end: number) {
      void this.read(begin, end).catch(() => {
        if (!signal.aborted) onError()
      })
    }
    private async read(begin: number, end: number) {
      // PDF.js can coalesce many adjacent chunks for an object spanning multiple pages.
      // Each file read stays bounded; PDF.js expects one contiguous result per request.
      const data = end - begin > chunkSize ? new Uint8Array(end - begin) : null
      for (let at = begin; at < end; at += chunkSize) {
        const part = await readRange(url, at, Math.min(at + chunkSize, end), signal)
        if (part.length !== this.length) throw new Error('文件大小已变化')
        signal.throwIfAborted()
        if (data) data.set(part.bytes, at - begin)
        else this.onDataRange(begin, part.bytes)
      }
      if (data) this.onDataRange(begin, data)
    }
  }

  return {
    range: new LocalPdfRanges(first.length, first.bytes, true),
    rangeChunkSize: chunkSize,
    disableStream: true,
    disableAutoFetch: true,
  }
}
