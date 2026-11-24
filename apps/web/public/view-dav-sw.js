// Subrequests belong to their initiating page's worker scope. Only virtual file URLs are intercepted.
const fileBase = new URL('__view_dav__/', self.registration.scope).href
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('message', (event) => {
  if (event.data?.type === 'view-dav-claim') event.waitUntil(self.clients.claim())
})

function safeHeaders() {
  return new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
}

function failure(status) {
  return new Response('无法读取此 WebDAV 文件。', { status, headers: safeHeaders() })
}

async function askOwner(clientId, handle, signal) {
  if (!clientId || signal.aborted) return null
  const client = await self.clients.get(clientId)
  if (client?.type !== 'window' || !client.url.startsWith(self.registration.scope)) return null
  const channel = new MessageChannel()
  return new Promise((resolve) => {
    function finish(grant) {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      channel.port1.close()
      resolve(grant)
    }
    const cancel = () => finish(null)
    const timer = setTimeout(cancel, 5000)
    channel.port1.onmessage = (event) => finish(event.data)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) return cancel()
    client.postMessage({ type: 'view-dav-read', handle }, [channel.port2])
  })
}

function requestUpstream(grant, method, range, signal) {
  const headers = new Headers({ Authorization: grant.authorization })
  if (range) headers.set('Range', range)
  return fetch(grant.url, {
    method,
    headers,
    signal,
    credentials: 'omit',
    mode: 'cors',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  })
}

async function partialRange(upstream, grant, requested, signal) {
  const exposed = upstream.headers.get('Content-Range')
  if (exposed) return /^bytes \d+-\d+\/(?:\d+|\*)$/i.test(exposed) ? exposed : null
  // Content-Range can be hidden by CORS. Reconstruct it only from matching, explicit lengths.
  const length = upstream.headers.get('Content-Length')
  if (!/^\d+$/.test(length ?? '')) return null
  const head = await requestUpstream(grant, 'HEAD', null, signal)
  const total = Number(head.headers.get('Content-Length'))
  if (head.status !== 200 || !Number.isSafeInteger(total) || total <= 0) return null
  for (const key of ['ETag', 'Last-Modified']) {
    if (
      head.headers.has(key) &&
      upstream.headers.has(key) &&
      head.headers.get(key) !== upstream.headers.get(key)
    )
      return null
  }
  const [, first, last] = requested
  const start = first ? Number(first) : Math.max(0, total - Number(last))
  const end = first && last ? Math.min(total - 1, Number(last)) : total - 1
  return end >= start && end - start + 1 === Number(length) ? `bytes ${start}-${end}/${total}` : null
}

async function serve(event, handle) {
  const request = event.request
  // Navigation and executable destinations must never get a response body under the app's origin.
  if (
    !/^[0-9a-f-]{36}$/.test(handle) ||
    request.mode === 'navigate' ||
    !['', 'image', 'video', 'audio'].includes(request.destination)
  )
    return failure(403)
  if (!['GET', 'HEAD'].includes(request.method)) return failure(405)
  const grant = await askOwner(event.clientId, handle, request.signal)
  if (!grant || typeof grant.url !== 'string' || typeof grant.authorization !== 'string') return failure(401)
  const target = new URL(grant.url)
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password)
    return failure(403)
  const range = request.headers.get('Range')
  const requested = range && /^bytes=(\d*)-(\d*)$/i.exec(range)
  if (range && (!requested || (!requested[1] && !requested[2]))) return failure(416)
  const upstream = await requestUpstream(grant, request.method, range, request.signal)
  const headers = safeHeaders()
  // Do not forward cookies, authentication challenges, redirects, or headers which grant permissions.
  if (upstream.status === 416) {
    const size = upstream.headers.get('Content-Range')
    if (/^bytes \*\/\d+$/.test(size ?? '')) headers.set('Content-Range', size)
  }
  if (![200, 206].includes(upstream.status)) {
    await upstream.body?.cancel()
    return new Response(null, { status: upstream.status, headers })
  }
  const encoding = upstream.headers.get('Content-Encoding')
  if (upstream.status === 206) {
    const bounds =
      requested && (!encoding || encoding === 'identity')
        ? await partialRange(upstream, grant, requested, request.signal)
        : null
    if (!bounds) {
      await upstream.body?.cancel()
      return failure(502)
    }
    headers.set('Content-Range', bounds)
  }
  const length = upstream.headers.get('Content-Length')
  if ((!encoding || encoding === 'identity') && /^\d+$/.test(length ?? ''))
    headers.set('Content-Length', length)
  if (upstream.status === 206 || upstream.headers.get('Accept-Ranges') === 'bytes')
    headers.set('Accept-Ranges', 'bytes')
  for (const name of ['ETag', 'Last-Modified']) {
    if (upstream.headers.has(name)) headers.set(name, upstream.headers.get(name))
  }
  const type = upstream.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() || ''
  if (
    /^(?:image|audio|video)\/[a-z0-9.+-]+$/.test(type) ||
    ['text/plain', 'application/pdf'].includes(type)
  ) {
    headers.set('Content-Type', type)
  } else {
    headers.set('Content-Type', 'application/octet-stream')
    headers.set('Content-Disposition', 'attachment')
  }
  return new Response(upstream.body, { status: upstream.status, headers })
}

self.addEventListener('fetch', (event) => {
  if (event.request.url.startsWith(fileBase)) {
    const handle = event.request.url.slice(fileBase.length)
    event.respondWith(serve(event, handle).catch(() => failure(502)))
  }
})
