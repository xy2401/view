import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { byteRange } from './byte-range.mjs'
import { supportsThumbnail } from './thumbnail-types.mjs'

const SESSION_SECONDS = 12 * 60 * 60
const contentTypes = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  woff: 'font/woff',
  woff2: 'font/woff2',
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function send(response, status, content, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(content) })
  response.end(content)
}

function matches(left, right) {
  return (
    typeof left === 'string' &&
    timingSafeEqual(
      createHash('sha256').update(left).digest(),
      createHash('sha256').update(right).digest(),
    )
  )
}

function sessions(accessKey) {
  const secret = randomBytes(32)
  let pairing
  const sign = (token) => createHmac('sha256', secret).update(token).digest('base64url')
  return {
    createPairingToken() {
      pairing = { value: randomBytes(24).toString('base64url'), expires: Date.now() + 120_000 }
      return pairing.value
    },
    login(credentials) {
      const paired =
        pairing && pairing.expires > Date.now() && matches(credentials?.pairingToken, pairing.value)
      if (!paired && !matches(credentials?.key, accessKey))
        throw new HttpError(401, 'Invalid access key')
      if (paired) pairing = undefined
      const token = [Date.now() + SESSION_SECONDS * 1000, randomBytes(18).toString('base64url')].join(
        '.',
      )
      return (
        'view_session=' +
        token +
        '.' +
        sign(token) +
        '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' +
        SESSION_SECONDS
      )
    },
    authorized(cookie = '') {
      const token = /(?:^|;\s*)view_session=(\d+\.[\w-]+)\.([\w-]+)(?:;|$)/.exec(cookie)
      return token && Number(token[1].split('.')[0]) > Date.now() && matches(token[2], sign(token[1]))
    },
  }
}

async function credentialsFrom(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new HttpError(415, 'Expected JSON')
  }
  let bytes = 0
  const chunks = []
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 4096) throw new HttpError(413, 'Request too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}

function decodePath(url) {
  const pathname = url.split('?')[0]
  if (!pathname.startsWith('/') || pathname.includes('//')) throw new HttpError(400, 'Invalid path')
  const segments = pathname
    .split('/')
    .filter(Boolean)
    .map((part) => {
      let segment
      try {
        segment = decodeURIComponent(part)
      } catch {
        throw new HttpError(400, 'Invalid path encoding')
      }
      if (
        /[/\\\0]/.test(segment) ||
        segment === '.' ||
        segment === '..' ||
        (process.platform === 'win32' && /[:<>|"?*]|[. ]$/.test(segment))
      ) {
        throw new HttpError(400, 'Invalid path segment')
      }
      return segment
    })
  return { pathname, segments }
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

// Resolve existing ancestors when a configured directory has not been created yet.
async function realLocation(candidate) {
  try {
    return await realpath(candidate)
  } catch (error) {
    if (error.code !== 'ENOENT' || path.dirname(candidate) === candidate) throw error
    return path.join(await realLocation(path.dirname(candidate)), path.basename(candidate))
  }
}

async function resolveInside(root, segments, excludedRoot) {
  const canonicalRoot = await realpath(root)
  if (excludedRoot && contained(excludedRoot, canonicalRoot)) throw new HttpError(404, 'Not found')
  let target = canonicalRoot
  if (excludedRoot && contained(canonicalRoot, excludedRoot)) {
    // Check each directory so that entering a symlink to the cache is also denied.
    for (const segment of segments) {
      target = await realpath(path.join(target, segment))
      if (contained(excludedRoot, target) || !contained(canonicalRoot, target))
        throw new HttpError(404, 'Not found')
    }
  } else {
    target = await realpath(path.join(canonicalRoot, ...segments))
    if (!contained(canonicalRoot, target)) throw new HttpError(404, 'Not found')
  }
  return { target, canonicalRoot }
}

async function visibleShares(shares, excludedRoot) {
  if (!excludedRoot) return shares
  const visible = []
  for (const share of shares) {
    try {
      if (!contained(excludedRoot, await realLocation(share.path))) visible.push(share)
    } catch (error) {
      if (!['ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(error.code)) throw error
    }
  }
  return visible
}

function escapeHTML(value) {
  const entities = { '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }
  return value.replace(/[&"<>]/g, (ch) => entities[ch])
}

function sendIndex(response, name, entries) {
  const links = entries.map(({ name, href, thumbnail, size, modified }) => {
    const preview = thumbnail
      ? ` data-thumbnail="${escapeHTML(thumbnail)}" data-size="${size}" data-modified="${modified}"`
      : ''
    return `<li><a href="${escapeHTML(href)}" data-name="${escapeHTML(name)}"${preview}>${escapeHTML(name)}</a></li>`
  })
  const title = 'Index of ' + escapeHTML(name)
  const body =
    '<!doctype html><html><head><meta charset="utf-8"><meta name="view-directory-index" content="1"><title>' +
    title +
    '</title></head><body><h1>' +
    title +
    '</h1><ul>' +
    links.join('\n') +
    '</ul></body></html>'
  response.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'")
  send(response, 200, body, 'text/html; charset=utf-8')
}

async function readEntry(item, target, root, withThumbnails, excludedRoot) {
  let itemPath = path.join(target, item.name)
  if (excludedRoot && contained(excludedRoot, itemPath)) return null
  let info = item
  const eligible = withThumbnails && supportsThumbnail(item.name)
  try {
    if (item.isSymbolicLink()) {
      itemPath = await realpath(itemPath)
      if (!contained(root, itemPath) || (excludedRoot && contained(excludedRoot, itemPath))) return null
      info = await stat(itemPath)
    } else if (item.isFile() && eligible) {
      info = await lstat(itemPath)
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(error.code)) throw error
    // A metadata lookup failure should not hide an ordinary file from the directory list.
    return item.isFile() ? { name: item.name, href: encodeURIComponent(item.name) } : null
  }
  if (!info.isDirectory() && !info.isFile()) return null
  const href = encodeURIComponent(item.name) + (info.isDirectory() ? '/' : '')
  const entry = { name: item.name, href }
  if (info.isFile() && eligible && supportsThumbnail(itemPath)) {
    entry.thumbnail = href + '?thumbnail=1'
    entry.size = info.size
    entry.modified = info.mtime.toISOString()
  }
  return entry
}

async function readEntries(target, root, withThumbnails, excludedRoot) {
  const items = await readdir(target, { withFileTypes: true })
  const entries = []
  // Bound stat concurrency when an album contains thousands of pictures.
  for (let offset = 0; offset < items.length; offset += 32) {
    const batch = items.slice(offset, offset + 32)
    const results = await Promise.all(
      batch.map((item) => readEntry(item, target, root, withThumbnails, excludedRoot)),
    )
    entries.push(...results.filter(Boolean))
  }
  return entries
}

async function sendFile(request, response, target, root, shared, excludedRoot) {
  const handle = await open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  )
  try {
    const info = await handle.stat()
    const resolved = await realpath(target)
    const current = await stat(resolved)
    if (
      !info.isFile() ||
      !contained(root, resolved) ||
      (excludedRoot && contained(excludedRoot, resolved)) ||
      current.dev !== info.dev ||
      current.ino !== info.ino
    ) {
      throw new HttpError(404, 'Not found')
    }
    const ext = path.extname(target).slice(1).toLowerCase()
    let type = Object.hasOwn(contentTypes, ext) ? contentTypes[ext] : 'application/octet-stream'
    if (shared) {
      response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'")
      if (!/^(image\/(?!svg)|audio\/|video\/|text\/plain|application\/pdf)/.test(type)) {
        response.setHeader('Content-Disposition', 'attachment')
        type = 'application/octet-stream'
      }
    }
    response.setHeader('Accept-Ranges', 'bytes')
    let range
    if (request.headers.range !== undefined) {
      range = byteRange(request.headers.range, info.size)
      if (!range) {
        response.setHeader('Content-Range', 'bytes */' + info.size)
        throw new HttpError(416, 'Range not satisfiable')
      }
      response.setHeader('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + info.size)
    }
    response.writeHead(range ? 206 : 200, {
      'Content-Type': type,
      'Content-Length': range ? range.end - range.start + 1 : info.size,
    })
    if (request.method === 'HEAD' || info.size === 0) response.end()
    else await pipeline(handle.createReadStream({ ...range, autoClose: false }), response)
  } finally {
    await handle.close()
  }
}

export async function startSharing({
  webRoot,
  getShares,
  getThumbnail,
  thumbnailCacheDirectory,
  accessKey,
  host = '0.0.0.0',
  port = 0,
}) {
  if (typeof accessKey !== 'string' || !accessKey) throw new Error('A sharing access key is required')
  const auth = sessions(accessKey)
  const appRoot = await realpath(webRoot)

  async function route(request, response) {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    const { pathname, segments } = decodePath(request.url)
    if (pathname === '/api/session' && request.method === 'POST') {
      response.setHeader('Set-Cookie', auth.login(await credentialsFrom(request)))
      response.writeHead(204).end()
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD')
      throw new HttpError(405, 'Method not allowed')
    if (pathname === '/view-runtime.json') {
      send(response, 200, JSON.stringify({ mode: 'hosted' }), 'application/json')
      return
    }
    const shared = segments[0] === 'files'
    if (shared && !auth.authorized(request.headers.cookie))
      throw new HttpError(401, 'Authentication required')
    const excludedRoot =
      thumbnailCacheDirectory && (await realLocation(path.resolve(thumbnailCacheDirectory)))
    if (!shared) {
      if (!segments.length) segments.push('index.html')
      const { target, canonicalRoot } = await resolveInside(appRoot, segments, excludedRoot)
      if (!(await stat(target)).isFile()) throw new HttpError(404, 'Not found')
      await sendFile(request, response, target, canonicalRoot, false, excludedRoot)
      return
    }
    const thumbnail = new URLSearchParams(request.url.slice(pathname.length)).get('thumbnail') === '1'
    if (thumbnail && (!getThumbnail || segments.length < 3))
      throw new HttpError(404, 'Thumbnail unavailable')
    const shares = await getShares()
    if (segments.length === 1) {
      if (!pathname.endsWith('/')) {
        response.writeHead(308, { Location: pathname + '/' }).end()
        return
      }
      sendIndex(
        response,
        '/files/',
        (await visibleShares(shares, excludedRoot)).map(({ name, id }) => ({
          name,
          href: encodeURIComponent(id) + '/',
        })),
      )
      return
    }
    const share = shares.find((item) => item.id === segments[1])
    if (!share) throw new HttpError(404, 'Not found')
    const sharePath = share.path
    const relative = segments.slice(2)
    const { canonicalRoot, target } = await resolveInside(sharePath, relative, excludedRoot)
    const info = await stat(target)
    if (info.isDirectory()) {
      if (thumbnail) throw new HttpError(404, 'Thumbnail unavailable')
      if (!pathname.endsWith('/')) {
        response.writeHead(308, { Location: pathname + '/' }).end()
        return
      }
      sendIndex(
        response,
        [share.name, ...segments.slice(2)].join('/'),
        await readEntries(target, canonicalRoot, Boolean(getThumbnail), excludedRoot),
      )
      return
    }
    if (!info.isFile() || pathname.endsWith('/')) throw new HttpError(404, 'Not found')
    if (thumbnail) {
      if (!supportsThumbnail(segments.at(-1)) || !supportsThumbnail(target))
        throw new HttpError(404, 'Thumbnail unavailable')
      const controller = new AbortController()
      if (response.destroyed) return
      const abort = () => controller.abort()
      response.once('close', abort)
      try {
        const image = await getThumbnail(target, canonicalRoot, controller.signal)
        if (!image) throw new HttpError(404, 'Thumbnail unavailable')
        const current = await resolveInside(sharePath, relative, excludedRoot)
        if (current.target !== target || current.canonicalRoot !== canonicalRoot)
          throw new HttpError(404, 'Not found')
        // The share can disappear while the generator is queued or decoding.
        if (!(await getShares()).some((item) => item.id === segments[1] && item.path === sharePath)) {
          throw new HttpError(404, 'Not found')
        }
        response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'")
        send(response, 200, image.data, image.mime)
      } finally {
        response.off('close', abort)
      }
      return
    }
    await sendFile(request, response, target, canonicalRoot, true, excludedRoot)
  }

  const server = createServer((request, response) => {
    route(request, response).catch((error) => {
      if (response.destroyed || response.headersSent) return response.destroy()
      if (error instanceof HttpError) return send(response, error.status, error.message)
      if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(error.code))
        return send(response, 404, 'Not found')
      send(response, 500, 'Unable to read this resource')
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    port: server.address().port,
    createPairingToken: auth.createPairingToken,
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
