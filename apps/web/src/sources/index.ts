import { davProperties, normalizeRemoteUrl, parseAutoindex, parseWebdav } from './remote'
import { davFetch, davFileUrl, hasDavSession } from './davSession'
import type { Entry, Place } from './types'

export type { DesktopState, Entry, LocationRef, Place } from './types'
export { normalizeRemoteUrl } from './remote'

export class SourceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function insidePlace(place: Place, url: string): URL {
  const root = new URL(normalizeRemoteUrl(place.url))
  const requested = new URL(normalizeRemoteUrl(url))
  if (requested.origin !== root.origin || !requested.pathname.startsWith(root.pathname)) {
    throw new Error('目录地址超出了当前位置。')
  }
  return requested
}

export async function listEntries(place: Place, url: string, signal?: AbortSignal): Promise<Entry[]> {
  let entries: Entry[]
  if (place.kind === 'local') {
    if (!window.viewDesktop) throw new Error('请在桌面应用中打开本地目录。')
    entries = await window.viewDesktop.list(url)
  } else {
    const requested = insidePlace(place, url)
    const options: RequestInit = { signal, cache: 'no-store' }
    const isDav = place.kind === 'webdav'
    const authenticated = isDav && hasDavSession(place.url)
    const response = isDav
      ? await davFetch(place.url, requested.href, {
          ...options,
          method: 'PROPFIND',
          headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
          body: davProperties,
        })
      : await fetch(requested, options)
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      if (isDav && response.status === 401) throw new SourceError('WebDAV 需要身份验证。', 401)
      if (isDav && response.status === 403) throw new SourceError('WebDAV 拒绝访问此目录，请检查账户权限。', 403)
      throw new SourceError(`读取目录失败（HTTP ${response.status}）。`, response.status)
    }
    const base = insidePlace(place, response.url || requested.href)
    const content = await response.text()
    entries = isDav
      ? parseWebdav(content, base, authenticated).map((entry) =>
          entry.directory ? entry : { ...entry, url: davFileUrl(place.url, entry.url) },
        )
      : parseAutoindex(content, base, place.kind === 'hosted')
  }
  return entries.sort(
    (a, b) => Number(b.directory) - Number(a.directory) || byName.compare(a.name, b.name),
  )
}
