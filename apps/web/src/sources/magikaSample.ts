// standard_v3_3 only examines these two windows. Short files retain their original length.
const windowSize = 4096
const sampleLimit = 2 * windowSize

async function discard(response: Response) {
  await response.body?.cancel().catch(() => {})
}

function request(url: string, signal: AbortSignal, range?: string) {
  return fetch(url, { signal, headers: range ? { Range: range } : undefined })
}

function httpError(response: Response) {
  return Object.assign(new Error(`无法读取文件（HTTP ${response.status}）。`), {
    status: response.status,
  })
}

function lengthHeader(response: Response) {
  const raw = response.headers.get('Content-Length')
  if (raw === null) return null
  const length = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(length)) throw new Error('文件长度无效。')
  return length
}

function sameVersion(first: Response, second: Response) {
  for (const key of ['ETag', 'Last-Modified']) {
    const a = first.headers.get(key)
    const b = second.headers.get(key)
    if (a && b && a !== b) throw new Error('取样期间文件已变化。')
  }
}

async function readBounded(response: Response, limit: number, signal: AbortSignal) {
  signal.throwIfAborted()
  // Fetch transparently decompresses whole responses; their Content-Length describes the wire body.
  const encoding = response.headers.get('Content-Encoding')
  const declared = !encoding || encoding === 'identity' ? lengthHeader(response) : null
  if (declared !== null && declared > limit)
    throw new Error('服务器未提供可验证的范围读取；文件超过取样上限。')
  if (!response.body) throw new Error('文件响应缺少内容。')

  // A byte-stream reader can also bound the final read to a single overflow byte.
  // Older browsers supply chunk streams; in that case reject an overflowing chunk immediately.
  let byob: ReadableStreamBYOBReader | undefined
  try {
    byob = response.body.getReader({ mode: 'byob' })
  } catch {
    /* Only a default reader is supported. */
  }
  const fallback = byob ? undefined : response.body.getReader()
  const reader = byob ?? fallback!
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  const bytes = new Uint8Array(limit)
  let offset = 0
  try {
    while (true) {
      const result = byob ? await byob.read(new Uint8Array(limit - offset + 1)) : await fallback!.read()
      signal.throwIfAborted()
      if (result.done) break
      if (offset + result.value.length > limit) throw new Error('服务器响应超过取样上限。')
      bytes.set(result.value, offset)
      offset += result.value.length
    }
    if (declared !== null && offset !== declared) throw new Error('文件响应长度不符。')
    return bytes.subarray(0, offset)
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function bounds(response: Response) {
  if (response.status !== 206) throw httpError(response)
  const encoding = response.headers.get('Content-Encoding')
  if (encoding && encoding !== 'identity') throw new Error('无法验证已压缩的文件片段。')
  const raw = response.headers.get('Content-Range')
  if (raw === null) return null
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(raw)
  if (!match) throw new Error('文件范围无效。')
  const start = Number(match[1])
  const end = Number(match[2])
  const total = match[3] === '*' ? null : Number(match[3])
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end < start ||
    (total !== null && (!Number.isSafeInteger(total) || end >= total))
  )
    throw new Error('文件范围无效。')
  return { start, end, total }
}

async function completeFile(url: string, signal: AbortSignal) {
  const response = await request(url, signal)
  try {
    if (response.status !== 200 || response.headers.has('Content-Range')) throw httpError(response)
    return await readBounded(response, sampleLimit, signal)
  } finally {
    await discard(response)
  }
}

async function headLength(url: string, signal: AbortSignal, first: Response) {
  // CORS exposes Content-Length by default but may hide Content-Range on a valid 206.
  let response: Response
  try {
    response = await fetch(url, { method: 'HEAD', signal })
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof TypeError) return null // Some remote origins only permit GET.
    throw error
  }
  try {
    if (response.status !== 200 || response.headers.has('Content-Range')) return null
    sameVersion(first, response)
    if (
      response.headers.get('Content-Encoding') &&
      response.headers.get('Content-Encoding') !== 'identity'
    )
      return null
    return lengthHeader(response)
  } finally {
    await discard(response)
  }
}

export async function readMagikaSample(url: string, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted()
  const first = await request(url, signal, `bytes=0-${windowSize - 1}`)
  try {
    if (first.status === 416) {
      const range = first.headers.get('Content-Range')
      if (range === 'bytes */0') return new Uint8Array()
      if (range === null) {
        await discard(first)
        return await completeFile(url, signal)
      }
      throw httpError(first)
    }
    if (first.status === 200) {
      if (first.headers.has('Content-Range')) throw new Error('完整文件响应包含意外的范围标记。')
      return await readBounded(first, sampleLimit, signal)
    }

    const head = bounds(first)
    if (head && (head.start !== 0 || head.end >= windowSize)) throw new Error('返回了错误的文件头范围。')
    if (!head && first.type !== 'cors') {
      await discard(first)
      return await completeFile(url, signal)
    }
    const prefix = await readBounded(first, windowSize, signal)
    const total = head?.total ?? (await headLength(url, signal, first))
    if (total === null) return await completeFile(url, signal)
    const prefixSize = Math.min(total, windowSize)
    if (!prefixSize || (head && head.end !== prefixSize - 1))
      throw new Error('文件头范围与文件长度不符。')
    if (prefix.length !== prefixSize) throw new Error('文件头不完整。')
    if (prefix.length === total) return prefix

    const start = Math.max(windowSize, total - windowSize)
    const last = await request(url, signal, `bytes=${start}-${total - 1}`)
    try {
      sameVersion(first, last)
      if (last.status === 200 && !last.headers.has('Content-Range')) {
        const complete = await readBounded(last, sampleLimit, signal)
        if (complete.length !== total || !prefix.every((byte, i) => byte === complete[i]))
          throw new Error('取样期间文件已变化。')
        return complete
      }
      const tail = bounds(last)
      if (
        (!tail && last.type !== 'cors') ||
        (tail &&
          (tail.start !== start ||
            tail.end !== total - 1 ||
            (tail.total !== null && tail.total !== total)))
      ) {
        throw new Error('文件尾部范围不符。')
      }
      const suffix = await readBounded(last, total - start, signal)
      if (suffix.length !== total - start) throw new Error('文件尾部不完整。')
      const sample = new Uint8Array(prefix.length + suffix.length)
      sample.set(prefix)
      sample.set(suffix, prefix.length)
      return sample
    } finally {
      await discard(last)
    }
  } finally {
    await discard(first)
  }
}
