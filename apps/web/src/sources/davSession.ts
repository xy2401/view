import { isSafeDavPath, normalizeRemoteUrl } from './remote'

interface DavSession {
  authorization: string
  handleByFile: Map<string, string>
  fileByHandle: Map<string, string>
}

// Only the owning window holds these grants. A new tab or page reload starts empty.
const sessions = new Map<string, DavSession>()
const pending = new Map<string, symbol>()
let preparing: Promise<void> | undefined

function appUrl(relative: string) {
  return new URL(relative, document.baseURI)
}

function scopedUrl(rootUrl: string, requestedUrl: string | URL) {
  const root = new URL(normalizeRemoteUrl(rootUrl))
  const file = new URL(requestedUrl)
  if (
    file.origin !== root.origin ||
    file.username ||
    file.password ||
    !file.pathname.startsWith(root.pathname) ||
    !isSafeDavPath(file.pathname)
  ) {
    throw new Error('文件地址超出了 WebDAV 位置。')
  }
  file.hash = ''
  return file.href
}

function onWorkerRequest(event: MessageEvent) {
  if (event.data?.type !== 'view-dav-read' || !event.ports[0]) return
  const controller = navigator.serviceWorker.controller
  if (!controller || event.source !== controller || controller.scriptURL !== appUrl('view-dav-sw.js').href)
    return
  const reply = event.ports[0]
  for (const session of sessions.values()) {
    const url = session.fileByHandle.get(event.data.handle)
    if (url) {
      reply.postMessage({ url, authorization: session.authorization })
      reply.close()
      return
    }
  }
  reply.postMessage(null)
  reply.close()
}

async function prepareWorker() {
  if (!window.isSecureContext || !navigator.serviceWorker || !/^https?:$/.test(location.protocol)) {
    throw new Error('需要通过 HTTPS 或 localhost 打开 View 才能连接需要账户的 WebDAV。')
  }
  const workers = navigator.serviceWorker
  const script = appUrl('view-dav-sw.js').href
  const scope = appUrl('./').href
  workers.addEventListener('message', onWorkerRequest)
  if (workers.controller?.scriptURL === script) return
  const existing = await workers.getRegistration(scope)
  if (
    existing?.scope === scope &&
    [existing.installing, existing.waiting, existing.active].some(
      (worker) => worker && worker.scriptURL !== script,
    )
  ) {
    throw new Error('此站点目录已有其他 Service Worker，请将 View 部署到独立目录。')
  }
  const registration = await workers.register(script, { scope, updateViaCache: 'none' })
  if (workers.controller?.scriptURL === script) return
  await new Promise<void>((resolve, reject) => {
    function change() {
      if (workers.controller?.scriptURL === script) {
        cleanup()
        resolve()
      }
    }
    function cleanup() {
      window.clearTimeout(timeout)
      workers.removeEventListener('controllerchange', change)
    }
    const timeout = window.setTimeout(() => {
      cleanup()
      reject(new Error('WebDAV 媒体服务启动超时，请检查浏览器的 Service Worker 权限。'))
    }, 10000)
    workers.addEventListener('controllerchange', change)
    registration.active?.postMessage({ type: 'view-dav-claim' })
    change()
  })
}

export async function openDavSession(
  rootUrl: string,
  username: string,
  password: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const root = normalizeRemoteUrl(rootUrl)
  if (!isSafeDavPath(new URL(root).pathname)) throw new Error('WebDAV 位置包含无效的路径段。')
  if (username.includes(':')) throw new Error('WebDAV 用户名不能含冒号。')
  const attempt = Symbol()
  pending.set(root, attempt)
  try {
    preparing ??= prepareWorker().finally(() => {
      preparing = undefined
    })
    await preparing
    signal?.throwIfAborted()
    if (pending.get(root) !== attempt) throw new DOMException('连接已取消。', 'AbortError')
    const bytes = new TextEncoder().encode(username + ':' + password)
    const authorization = 'Basic ' + btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    sessions.set(root, { authorization, handleByFile: new Map(), fileByHandle: new Map() })
  } finally {
    if (pending.get(root) === attempt) pending.delete(root)
  }
}

export function closeDavSession(rootUrl: string): void {
  const root = normalizeRemoteUrl(rootUrl)
  pending.delete(root)
  sessions.delete(root)
}

export function hasDavSession(rootUrl: string): boolean {
  return sessions.has(normalizeRemoteUrl(rootUrl))
}

export function davFetch(
  rootUrl: string,
  requestedUrl: string | URL,
  options: RequestInit = {},
): Promise<Response> {
  const session = sessions.get(normalizeRemoteUrl(rootUrl))
  if (!session) return fetch(requestedUrl, { ...options, credentials: 'omit', cache: 'no-store' })
  const target = scopedUrl(rootUrl, requestedUrl)
  if (options.method?.toUpperCase() !== 'PROPFIND') throw new Error('WebDAV 目录请求必须使用 PROPFIND。')
  const headers = new Headers(options.headers)
  headers.set('Authorization', session.authorization)
  return fetch(target, {
    ...options,
    headers,
    credentials: 'omit',
    mode: 'cors',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  })
}

export function davFileUrl(rootUrl: string, fileUrl: string): string {
  const session = sessions.get(normalizeRemoteUrl(rootUrl))
  if (!session) return fileUrl
  const file = scopedUrl(rootUrl, fileUrl)
  let handle = session.handleByFile.get(file)
  if (!handle) {
    handle = crypto.randomUUID()
    session.handleByFile.set(file, handle)
    session.fileByHandle.set(handle, file)
  }
  return appUrl('__view_dav__/' + handle).href
}
