import type { Entry } from './types'

// An authenticated server may decode a path repeatedly. Keep each credentialed request in scope.
function safeSegment(segment: string): boolean {
  let value = segment
  for (let depth = 0; depth < 5; depth++) {
    if (value === '.' || value === '..' || /[/\\\x00-\x1f\x7f]/.test(value)) return false
    const decoded = value.replace(/%([\da-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    if (decoded === value) return true
    value = decoded
  }
  return false
}

export function isSafeDavPath(pathname: string): boolean {
  return pathname.split('/').every(safeSegment)
}

export function normalizeRemoteUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('请输入完整的 HTTP 或 HTTPS 目录地址。')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('请使用不含用户名和密码的 HTTP 或 HTTPS 地址。')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  url.hash = ''
  return url.href
}

// Listings may also contain links to parents, sorting controls and unrelated pages.
export function directChild(href: string, base: URL): URL | null {
  if (!href.trim()) return null
  let url: URL
  try {
    url = new URL(href, base)
  } catch {
    return null
  }
  if (url.origin !== base.origin || url.protocol !== base.protocol || url.username || url.password)
    return null
  if (!url.pathname.startsWith(base.pathname)) return null
  const segment = url.pathname.slice(base.pathname.length).replace(/\/$/, '')
  if (!segment || segment.includes('/') || /%2f|%5c/i.test(segment)) return null
  url.hash = ''
  return url
}

function filename(url: URL): string {
  const segment = url.pathname.replace(/\/$/, '').split('/').pop()!
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function setMetadata(entry: Entry, size?: string | null, modified?: string | null) {
  if (!entry.directory && size && /^\d+$/.test(size) && Number.isSafeInteger(Number(size))) {
    entry.size = Number(size)
  }
  if (modified && Number.isFinite(Date.parse(modified))) {
    entry.modified = new Date(modified).toISOString()
  }
}

export function hostedThumbnail(href: string | undefined, file: URL, base: URL): string | undefined {
  if (!href || file.search || file.pathname.endsWith('/')) return
  const expected = new URL(file)
  expected.search = 'thumbnail=1'
  // Accept only the derivative of this exact file. Never forward an arbitrary URL from a listing.
  try {
    if (new URL(href, base).href === expected.href) return expected.href
  } catch {
    // Ignore malformed optional metadata. The file itself still belongs in the listing.
  }
}

export function parseAutoindex(html: string, base: URL, hosted = false): Entry[] {
  const template = document.createElement('template')
  template.innerHTML = html
  const page = template.content
  const isViewListing = !!page.querySelector('meta[name="view-directory-index"][content="1"]')
  const hasIndexTitle = Array.from(page.querySelectorAll('title, h1')).some((heading) =>
    /^(?:index of|directory listing (?:of|for))(?:\s|$)/i.test(heading.textContent?.trim() ?? ''),
  )
  if (!isViewListing && !hasIndexTitle) throw new Error('暂不支持此目录页格式。')

  const entries = new Map<string, Entry>()
  for (const anchor of page.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const url = directChild(anchor.getAttribute('href')!, base)
    if (!url) continue
    const entry: Entry = {
      url: url.href,
      directory: url.pathname.endsWith('/'),
      name: isViewListing ? anchor.dataset.name || filename(url) : filename(url),
    }
    if (isViewListing) {
      setMetadata(entry, anchor.dataset.size, anchor.dataset.modified)
      if (hosted) entry.thumbnailUrl = hostedThumbnail(anchor.dataset.thumbnail, url, base)
    }
    entries.set(entry.url, entry)
  }
  return Array.from(entries.values())
}

function davChildren(element: Element, name: string): Element[] {
  return Array.from(element.children).filter(
    (child) => child.namespaceURI === 'DAV:' && child.localName === name,
  )
}

function isSuccess(status?: string | null): boolean {
  return !!status && /^HTTP\/\S+\s+2\d\d\b/i.test(status.trim())
}

export function parseWebdav(xml: string, base: URL, authenticated = false): Entry[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const root = doc.documentElement
  if (root.localName !== 'multistatus' || root.namespaceURI !== 'DAV:') {
    throw new Error('服务器没有返回有效的 WebDAV 目录。')
  }
  const entries = new Map<string, Entry>()
  for (const response of davChildren(root, 'response')) {
    const url = directChild(davChildren(response, 'href')[0]?.textContent ?? '', base)
    if (!url || (authenticated && !isSafeDavPath(url.pathname))) continue
    const responseStatus = davChildren(response, 'status')[0]
    if (responseStatus && !isSuccess(responseStatus.textContent)) continue
    const props = davChildren(response, 'propstat')
      .filter((stat) => isSuccess(davChildren(stat, 'status')[0]?.textContent))
      .flatMap((stat) => davChildren(stat, 'prop'))
    if (!props.length) continue
    const property = (name: string) => props.flatMap((prop) => davChildren(prop, name))[0]
    const resourceType = property('resourcetype')
    const directory = resourceType
      ? davChildren(resourceType, 'collection').length > 0
      : url.pathname.endsWith('/')
    if (directory && !url.pathname.endsWith('/')) url.pathname += '/'
    const entry: Entry = {
      name: property('displayname')?.textContent || filename(url),
      url: url.href,
      directory,
    }
    setMetadata(
      entry,
      property('getcontentlength')?.textContent,
      property('getlastmodified')?.textContent,
    )
    entries.set(entry.url, entry)
  }
  return Array.from(entries.values())
}

export const davProperties = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>`
