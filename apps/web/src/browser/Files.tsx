import { Folder } from 'lucide-react'
import SetiIcon from './SetiIcon'
import { useEffect, useRef, useState } from 'react'
import type { Entry } from '../sources'

const extensions = {
  image: ['avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'webp'],
  video: ['m4v', 'mov', 'mp4', 'ogv', 'webm'],
  audio: ['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'wav'],
  pdf: ['pdf'],
  text: [
    'c',
    'cc',
    'conf',
    'cpp',
    'css',
    'csv',
    'go',
    'h',
    'html',
    'ini',
    'java',
    'js',
    'json',
    'jsx',
    'log',
    'md',
    'mjs',
    'py',
    'rs',
    'sh',
    'toml',
    'ts',
    'tsx',
    'txt',
    'xml',
    'yaml',
    'yml',
  ],
}

export type MediaKind = keyof typeof extensions | 'other'
export function mediaKind(name: string): MediaKind {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return (
    (Object.keys(extensions) as (keyof typeof extensions)[]).find((key) =>
      extensions[key].includes(ext),
    ) ?? 'other'
  )
}

export function readableSize(size?: number) {
  if (size == null) return '—'
  if (size < 1024) return size + ' B'
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
  if (size < 1024 ** 3) return (size / 1024 ** 2).toFixed(1) + ' MB'
  return (size / 1024 ** 3).toFixed(1) + ' GB'
}

export function FileIcon({ entry }: { entry: Entry }) {
  const kind = entry.directory ? 'folder' : mediaKind(entry.name)
  return (
    <span className={'file-icon ' + kind}>
      {entry.directory ? <Folder size={22} /> : <SetiIcon name={entry.name} />}
    </span>
  )
}

function Thumbnail({
  entry,
  nearby,
  allowOriginal,
}: {
  entry: Entry
  nearby: boolean
  allowOriginal: boolean
}) {
  const [failedSource, setFailedSource] = useState<string>()
  if (!nearby || entry.directory) return <FileIcon entry={entry} />

  let source: string
  if (entry.thumbnailUrl) {
    const thumbnail = new URL(entry.thumbnailUrl)
    if (entry.size !== undefined || entry.modified !== undefined) {
      thumbnail.searchParams.set('v', (entry.size ?? '') + ':' + (entry.modified ?? ''))
    }
    source = thumbnail.href
  } else if (allowOriginal && mediaKind(entry.name) === 'image') {
    source = entry.url
  } else {
    return <FileIcon entry={entry} />
  }
  if (failedSource === source) return <FileIcon entry={entry} />
  return (
    <img alt="" key={source} decoding="async" src={source} onError={() => setFailedSource(source)} />
  )
}

function useNearbyEntries(entries: Entry[], grid: boolean) {
  const container = useRef<HTMLDivElement>(null)
  const [nearby, setNearby] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    const parent = container.current
    if (!grid || !parent || !window.IntersectionObserver) return
    let active = true
    let observer: IntersectionObserver
    function observe() {
      observer?.disconnect()
      observer = new IntersectionObserver(
        (changes, current) => {
          if (!active || current !== observer) return
          setNearby((previous) => {
            const next = new Set(previous)
            for (const change of changes) {
              const url = (change.target as HTMLElement).dataset.entryUrl!
              if (change.isIntersecting) next.add(url)
              else next.delete(url)
            }
            return next
          })
        },
        { rootMargin: window.innerHeight + 'px 0px' },
      )
      parent!.querySelectorAll('[data-entry-url]').forEach((tile) => observer.observe(tile))
    }
    observe()
    window.addEventListener('resize', observe)
    return () => {
      active = false
      observer.disconnect()
      window.removeEventListener('resize', observe)
      setNearby(new Set())
    }
  }, [entries, grid])
  return { container, nearby }
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
function modified(value?: string) {
  const time = value ? Date.parse(value) : NaN
  return Number.isFinite(time) ? dateFormat.format(time) : '—'
}

export function Files({
  entries,
  layout,
  allowOriginalThumbnails,
  selected,
  onOpen,
}: {
  entries: Entry[]
  layout: 'list' | 'grid'
  allowOriginalThumbnails: boolean
  selected: string | null
  onOpen: (e: Entry) => void
}) {
  const { container, nearby } = useNearbyEntries(entries, layout === 'grid')
  return (
    <div ref={container} className={layout === 'grid' ? 'entry-grid' : 'entry-list'}>
      {layout === 'list' && (
        <div className="entry-row entry-header">
          <span>名称</span>
          <span>修改日期</span>
          <span>大小</span>
        </div>
      )}
      {entries.map((entry) => (
        <button
          key={entry.url}
          type="button"
          data-entry-url={entry.url}
          className={
            (layout === 'grid' ? 'entry-card' : 'entry-row') +
            (selected === entry.url ? ' selected' : '')
          }
          onClick={() => onOpen(entry)}
        >
          {layout === 'grid' && (
            <span className="thumbnail">
              <Thumbnail
                entry={entry}
                nearby={nearby.has(entry.url)}
                allowOriginal={allowOriginalThumbnails}
              />
            </span>
          )}
          <span className="entry-name">
            {layout === 'list' && <FileIcon entry={entry} />}
            <span>{entry.name}</span>
          </span>
          {layout === 'list' && <span className="entry-meta">{modified(entry.modified)}</span>}
          <span className="entry-meta">
            {entry.directory ? (layout === 'grid' ? '文件夹' : '—') : readableSize(entry.size)}
          </span>
        </button>
      ))}
    </div>
  )
}
