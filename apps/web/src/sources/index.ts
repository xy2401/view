import { davProperties, normalizeRemoteUrl, parseAutoindex, parseWebdav } from './remote'
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
    if (place.kind === 'webdav') {
      options.method = 'PROPFIND'
      options.headers = { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }
      options.body = davProperties
    }
    const response = await fetch(requested, options)
    if (!response.ok) throw new SourceError(`读取目录失败（HTTP ${response.status}）。`, response.status)
    const base = insidePlace(place, response.url || requested.href)
    const content = await response.text()
    entries = place.kind === 'webdav' ? parseWebdav(content, base) : parseAutoindex(content, base)
  }
  return entries.sort(
    (a, b) => Number(b.directory) - Number(a.directory) || byName.compare(a.name, b.name),
  )
}
