import { Folder } from 'lucide-react'
import SetiIcon from './SetiIcon'
import { useState } from 'react'
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

function Thumbnail({ entry }: { entry: Entry }) {
  const [failed, setFailed] = useState(false)
  if (entry.directory || mediaKind(entry.name) !== 'image' || failed) return <FileIcon entry={entry} />
  return <img loading="lazy" alt="" src={entry.url} onError={() => setFailed(true)} />
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
  selected,
  onOpen,
}: {
  entries: Entry[]
  layout: 'list' | 'grid'
  selected: string | null
  onOpen: (e: Entry) => void
}) {
  return (
    <div className={layout === 'grid' ? 'entry-grid' : 'entry-list'}>
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
              <Thumbnail entry={entry} />
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
