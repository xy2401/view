import path from 'node:path'
import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { byteRange } from '../sharing/byte-range.mjs'

const types = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/plain',
  json: 'text/plain',
}

export async function fileResponse(request, library) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
  let handle
  try {
    const target = await library.resolveUrl(request.url)
    handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
    )
    const info = await handle.stat()
    const current = await stat(await library.resolveUrl(request.url))
    if (!info.isFile() || current.dev !== info.dev || current.ino !== info.ino) {
      return new Response(null, { status: 404 })
    }
    const ext = path.extname(target).slice(1).toLowerCase()
    const type = Object.hasOwn(types, ext) ? types[ext] : 'application/octet-stream'
    const headers = new Headers({
      'Content-Type': type,
      'Content-Length': String(info.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': 'view-app://app',
      'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    })
    let range
    if (request.headers.has('range')) {
      range = byteRange(request.headers.get('range'), info.size)
      if (!range)
        return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + info.size } })
      const { start, end } = range
      headers.set('Content-Range', 'bytes ' + start + '-' + end + '/' + info.size)
      headers.set('Content-Length', String(end - start + 1))
    }
    let stream = null
    if (request.method === 'GET' && info.size) {
      stream = Readable.toWeb(handle.createReadStream(range))
      handle = null // the read stream owns the descriptor
    }
    return new Response(stream, { status: range ? 206 : 200, headers })
  } catch {
    return new Response(null, { status: 404 })
  } finally {
    await handle?.close()
  }
}

export function createAssetHandler(webRoot, net) {
  return async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'app' || request.method !== 'GET') return new Response(null, { status: 404 })
    try {
      const pathname = decodeURIComponent(url.pathname)
      const filename = path.resolve(webRoot, '.' + (pathname === '/' ? '/index.html' : pathname))
      const relative = path.relative(webRoot, filename)
      if (relative.startsWith('..') || path.isAbsolute(relative))
        return new Response(null, { status: 404 })
      return await net.fetch(pathToFileURL(filename).href)
    } catch {
      return new Response(null, { status: 404 })
    }
  }
}
