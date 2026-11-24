import type { MediaKind } from '../browser/Files'

const limit = 4096

export async function readPrefix(url: string, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted()
  const response = await fetch(url, { headers: { Range: `bytes=0-${limit - 1}` }, signal })
  if (response.status === 416 && response.headers.get('Content-Range') === 'bytes */0') {
    await response.body?.cancel()
    return new Uint8Array()
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw Object.assign(new Error(`无法读取文件（HTTP ${response.status}）。`), {
      status: response.status,
    })
  }

  const reader = response.body.getReader()
  const sample = new Uint8Array(limit)
  let length = 0
  try {
    while (length < limit) {
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      const part = value.subarray(0, limit - length)
      sample.set(part, length)
      length += part.length
    }
    return sample.subarray(0, length)
  } finally {
    try {
      await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

function containerKind(bytes: Uint8Array, header: string): MediaKind | null {
  if (header.slice(4, 8) === 'ftyp' && bytes.length >= 16) {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
    if (size < 16 || (size - 16) % 4 !== 0) return null
    const brands = [header.slice(8, 12)]
    for (let i = 16; i + 4 <= Math.min(size, bytes.length); i += 4) {
      brands.push(header.slice(i, i + 4))
    }
    if (brands.some((brand) => brand === 'avif' || brand === 'avis')) return 'image'
    if (brands.some((brand) => ['M4A ', 'M4B ', 'F4A '].includes(brand))) return 'audio'
    if (brands.some((brand) => ['M4V ', 'avc1', 'avc3'].includes(brand))) return 'video'
  }
  if (header.startsWith('RIFF')) {
    const format = header.slice(8, 12)
    if (format === 'WEBP') return 'image'
    if (format === 'WAVE') return 'audio'
    if (format === 'AVI ') return 'video'
  }
  if (header.startsWith('OggS') && bytes.length >= 27 && bytes[4] === 0) {
    const packet = header.slice(27 + bytes[26])
    if (packet.startsWith('OpusHead') || packet.startsWith('\x01vorbis')) return 'audio'
    if (packet.startsWith('\x80theora')) return 'video'
  }
  return null
}

export function classifyPrefix(input: Uint8Array): MediaKind | null {
  const bytes = input.subarray(0, limit)
  if (!bytes.length) return null
  // Preserve byte values for four-character tags and signatures; UTF-8 is checked separately below.
  const header = String.fromCharCode(...bytes)
  if (header.startsWith('\x89PNG\r\n\x1a\n') || header.startsWith('\xff\xd8\xff')) return 'image'
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image'
  if (header.startsWith('BM') && bytes.length >= 18) {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if ([12, 40, 52, 56, 64, 108, 124].includes(data.getUint32(14, true))) return 'image'
  }
  if (/^%PDF-\d\.\d/.test(header)) return 'pdf'
  if (header.startsWith('fLaC')) return 'audio'
  if (header.startsWith('ID3') && bytes.length >= 10 && bytes[3] >= 2 && bytes[3] <= 4) return 'audio'
  const container = containerKind(bytes, header)
  if (container) return container

  if (
    /^PK(?:\x03\x04|\x05\x06|\x07\x08)/.test(header) ||
    header.startsWith('7z\xbc\xaf\x27\x1c') ||
    header.startsWith('Rar!\x1a\x07') ||
    header.startsWith('\x1f\x8b\x08') ||
    header.startsWith('\x7fELF')
  )
    return 'other'

  try {
    // A valid multi-byte character may straddle the end of a full-sized sample.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, {
      stream: bytes.length === limit,
    })
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) return null
    return /[\p{L}\p{N}]/u.test(text) ? 'text' : null
  } catch {
    return null
  }
}

export async function detectKind(url: string, signal: AbortSignal): Promise<MediaKind | null> {
  return classifyPrefix(await readPrefix(url, signal))
}
