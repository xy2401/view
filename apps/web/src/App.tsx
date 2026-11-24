import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  CircleAlert,
  FileStack,
  Folder,
  FolderOpen,
  Globe2,
  Grid2X2,
  House,
  KeyRound,
  LayoutGrid,
  List,
  Menu,
  Monitor,
  Plus,
  RefreshCw,
  Share2,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import { listEntries, normalizeRemoteUrl, type DesktopState, type Entry, type Place } from './sources'
import { Files } from './browser/Files'
import { AddLocation } from './locations/AddLocation'
import { Sharing } from './locations/Sharing'
import { Preview } from './viewers/Preview'

type Mode = 'static' | 'hosted' | 'desktop'
type Crumb = { name: string; url: string }
type Directory = { place: Place; trail: Crumb[] }
const remoteKey = 'view.remote-locations.v1'
function localPlace(p: Crumb): Place {
  return { ...p, kind: 'local' }
}
function placesFromStorage(): Place[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(remoteKey) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        (p) =>
          p &&
          typeof p.name === 'string' &&
          typeof p.url === 'string' &&
          (p.kind === 'autoindex' || p.kind === 'webdav'),
      )
      .flatMap((p) => {
        try {
          return [{ name: p.name, kind: p.kind, url: normalizeRemoteUrl(p.url) }]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}
function message(err: unknown) {
  return err instanceof Error ? err.message : '操作失败，请重试。'
}
function isUnauthorized(err: unknown) {
  return err instanceof Error && 'status' in err && err.status === 401
}
function hostedRoot(): Place {
  return { name: '共享位置', kind: 'autoindex', url: new URL('/files/', location.href).href }
}
async function authenticate(body: { key: string } | { pairingToken: string }) {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok)
    throw new Error(
      res.status === 401 || res.status === 403
        ? '密钥或配对码无效，请重新输入。'
        : '暂时无法登录，请重试。',
    )
}
async function detectRuntime(): Promise<{ mode: Mode; notice?: string }> {
  if (window.viewDesktop) return { mode: 'desktop' }
  const res = await fetch('./view-runtime.json', { cache: 'no-store' })
  if (!res.ok) throw new Error('无法加载运行配置，请刷新页面。')
  if ((await res.json()).mode !== 'hosted') return { mode: 'static' }
  const pair = new URLSearchParams(location.hash.slice(1)).get('pair')
  if (pair) {
    history.replaceState(null, '', location.pathname + location.search)
    try {
      await authenticate({ pairingToken: pair })
    } catch (err) {
      return { mode: 'hosted', notice: message(err) }
    }
  }
  return { mode: 'hosted' }
}
let boot: ReturnType<typeof detectRuntime> | undefined
function bootstrap() {
  boot ??= detectRuntime().catch((err) => {
    boot = undefined
    throw err
  })
  return boot
}

function Empty({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode
  title: string
  description?: string
  children?: ReactNode
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {children}
    </div>
  )
}
function placeKind(p: Place) {
  return p.kind === 'local' ? '本地文件夹' : p.kind === 'webdav' ? 'WebDAV' : 'HTTP autoindex'
}
function Home({
  places,
  mode,
  onOpen,
  onRemove,
  onAdd,
}: {
  places: Place[]
  mode: Mode
  onOpen: (p: Place) => void
  onRemove: (p: Place) => void
  onAdd: () => void
}) {
  if (!places.length)
    return (
      <Empty
        icon={<FolderOpen size={40} />}
        title={
          mode === 'hosted'
            ? '还没有共享文件夹'
            : mode === 'desktop'
              ? '还没有收藏的文件夹'
              : '还没有添加位置'
        }
        description={
          mode === 'hosted'
            ? '在电脑的 View 中开启文件夹的 HTTP 共享。'
            : mode === 'desktop'
              ? '打开一个本地文件夹，点收藏即可固定在这里。'
              : '添加 HTTP autoindex 或 WebDAV 地址，开始浏览文件。'
        }
      >
        {mode !== 'hosted' && (
          <button className="btn primary" onClick={onAdd}>
            {mode === 'desktop' ? <FolderOpen size={17} /> : <Plus size={17} />}
            {mode === 'desktop' ? '打开文件夹' : '添加位置'}
          </button>
        )}
      </Empty>
    )
  return (
    <div className="location-grid">
      {places.map((p) => (
        <div className="location-card" key={p.kind + p.url}>
          <button className="location-open" onClick={() => onOpen(p)}>
            <span className="location-icon">
              {mode === 'hosted' || p.kind === 'local' ? <Folder /> : <Globe2 />}
            </span>
            <span>
              <strong>{p.name}</strong>
              <small>{mode === 'hosted' ? '共享文件夹' : placeKind(p)}</small>
            </span>
            <ChevronRight size={16} />
          </button>
          {mode === 'static' && (
            <button
              className="icon-btn remove-place"
              title="移除位置"
              aria-label={'移除位置 ' + p.name}
              onClick={() => onRemove(p)}
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

export default function App() {
  const [mode, setMode] = useState<Mode | null>(null)
  const [places, setPlaces] = useState<Place[]>([])
  const [desktop, setDesktop] = useState<DesktopState | null>(null)
  const [directory, setDirectory] = useState<Directory | null>(null)
  const [section, setSection] = useState<'home' | 'sharing'>('home')
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [rootLoading, setRootLoading] = useState(true)
  const [rootError, setRootError] = useState('')
  const [error, setError] = useState('')
  const [dirError, setDirError] = useState('')
  const [locked, setLocked] = useState(false)
  const [key, setKey] = useState('')
  const [version, setVersion] = useState(0)
  const [dirVersion, setDirVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const [showAdd, setShowAdd] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const [layout, setLayout] = useState<'list' | 'grid'>('list')
  const [preview, setPreview] = useState<Entry | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const current = directory?.trail.at(-1)
  const pageTitle = current?.name ?? (section === 'sharing' ? '共享管理' : '文件位置')
  const bridge = window.viewDesktop

  function home(next: 'home' | 'sharing' = 'home') {
    setNavOpen(false)
    setDirectory(null)
    setSection(next)
    setPreview(null)
    setSelected(null)
    setError('')
    setDirError('')
  }
  function open(p: Place) {
    setNavOpen(false)
    setSection('home')
    setDirectory({ place: p, trail: [{ name: p.name, url: p.url }] })
    setSelected(null)
    setEntries([])
    setPreview(null)
    setError('')
    setDirError('')
    setLoading(true)
  }
  function crumb(index: number) {
    if (!directory) return
    if (index === directory.trail.length - 1) return
    if (index < 0) {
      home()
      return
    }
    setEntries([])
    setSelected(null)
    setLoading(true)
    setDirError('')
    setDirectory({ ...directory, trail: directory.trail.slice(0, index + 1) })
  }
  const sessionLost = useCallback(() => {
    setLocked(true)
    setPlaces([])
    setDirectory(null)
    setPreview(null)
    setEntries([])
    setRootLoading(false)
  }, [])

  useEffect(() => {
    if (mode) return
    let active = true
    bootstrap()
      .then(({ mode: detected, notice }) => {
        if (active) {
          setMode(detected)
          if (notice) setError(notice)
        }
      })
      .catch((err) => {
        if (active) {
          setError(message(err))
          setRootLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [mode, version])

  useEffect(() => {
    if (!mode) return
    const controller = new AbortController()
    async function loadPlaces() {
      setRootLoading(true)
      setRootError('')
      if (mode === 'desktop') {
        const state = await bridge!.state()
        if (!controller.signal.aborted) {
          setDesktop(state)
          setPlaces(state.favorites.map(localPlace))
        }
      } else if (mode === 'hosted') {
        const root = hostedRoot()
        const roots = await listEntries(root, root.url, controller.signal)
        if (!controller.signal.aborted) {
          setLocked(false)
          setPlaces(roots.filter((e) => e.directory).map((e) => ({ ...root, name: e.name, url: e.url })))
        }
      } else setPlaces(placesFromStorage())
    }
    void loadPlaces()
      .catch((err) => {
        if (controller.signal.aborted) return
        if (mode === 'hosted' && isUnauthorized(err)) sessionLost()
        else setRootError(message(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setRootLoading(false)
      })
    return () => controller.abort()
  }, [bridge, mode, version, sessionLost])

  useEffect(() => {
    if (!directory || !current) return
    const controller = new AbortController()
    setLoading(true)
    setDirError('')
    void listEntries(directory.place, current.url, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setEntries(result)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        setEntries([])
        if (mode === 'hosted' && isUnauthorized(err)) sessionLost()
        else setDirError(message(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [directory, current, mode, dirVersion, sessionLost])

  async function run(action: () => Promise<unknown>) {
    if (running.current) return
    running.current = true
    setBusy(true)
    setError('')
    try {
      await action()
      if (bridge) {
        const state = await bridge.state()
        setDesktop(state)
        setPlaces(state.favorites.map(localPlace))
      }
    } catch (err) {
      setError(message(err))
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  function add() {
    if (bridge)
      void run(async () => {
        const p = await bridge.openFolder()
        if (p) open(localPlace(p))
      })
    else setShowAdd(true)
  }
  function savePlaces(list: Place[]) {
    localStorage.setItem(remoteKey, JSON.stringify(list))
    setPlaces(list)
  }
  function removePlace(p: Place) {
    try {
      savePlaces(places.filter((v) => v.url !== p.url || v.kind !== p.kind))
    } catch {
      setError('浏览器无法保存位置，请检查存储权限。')
    }
  }
  function openEntry(entry: Entry) {
    if (!directory) return
    if (!entry.directory) {
      setSelected(entry.url)
      setPreview(entry)
      return
    }
    setEntries([])
    setDirError('')
    setSelected(null)
    setLoading(true)
    setDirectory({ ...directory, trail: [...directory.trail, { name: entry.name, url: entry.url }] })
  }
  function closePreview() {
    setPreview(null)
    if (selected)
      requestAnimationFrame(() => {
        const target = document.querySelector<HTMLButtonElement>(
          '[data-entry-url="' + CSS.escape(selected) + '"]',
        )
        target?.focus({ preventScroll: true })
        target?.scrollIntoView({ block: 'nearest' })
      })
  }
  const isFavorite = desktop?.favorites.some((p) => p.url === current?.url)
  const isShared = desktop?.shares.some((p) => p.url === current?.url)
  function refresh() {
    setError('')
    setVersion((v) => v + 1)
    if (directory) setDirVersion((v) => v + 1)
  }
  const modeName = mode === 'desktop' ? '桌面端' : mode === 'hosted' ? '局域网共享' : '网页版'
  return (
    <div className={'app-shell' + (navOpen ? ' nav-open' : '')}>
      {navOpen && (
        <button className="nav-scrim" onClick={() => setNavOpen(false)} aria-label="关闭导航" />
      )}
      <aside className="sidebar" aria-label="导航">
        <button className="brand" onClick={() => home()}>
          <span className="brand-mark">
            <FileStack size={25} />
          </span>
          <span>View</span>
        </button>
        <nav className="sidebar-nav">
          <button
            className={'nav-item' + (!directory && section === 'home' ? ' active' : '')}
            onClick={() => home()}
          >
            <LayoutGrid size={18} />
            所有位置
          </button>
          {mode === 'desktop' && (
            <button
              className={'nav-item' + (section === 'sharing' ? ' active' : '')}
              onClick={() => home('sharing')}
            >
              <Share2 size={18} />
              共享管理
            </button>
          )}
        </nav>
        <div className="sidebar-label">
          {mode === 'desktop' ? '收藏文件夹' : mode === 'hosted' ? '共享文件夹' : '已添加的位置'}
        </div>
        <div className="saved-places">
          {places.map((p) => (
            <button
              key={p.kind + p.url}
              className={'sidebar-place' + (directory?.place.url === p.url ? ' active' : '')}
              onClick={() => open(p)}
            >
              <Folder size={16} />
              <span>{p.name}</span>
            </button>
          ))}
          {!places.length && <span className="sidebar-empty">暂无位置</span>}
        </div>
        <div className="sidebar-footer">
          <Monitor size={16} />
          <span>{modeName}</span>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-btn mobile-menu"
              aria-label="打开导航"
              onClick={() => setNavOpen(true)}
            >
              <Menu />
            </button>
            {directory && (
              <button
                className="icon-btn"
                title="返回上一级"
                aria-label="返回上一级"
                onClick={() => crumb(directory.trail.length - 2)}
              >
                <ArrowLeft />
              </button>
            )}
            <button className="crumb-home" onClick={() => home()}>
              <House size={16} />
              <span>位置</span>
            </button>
            {section === 'sharing' && (
              <>
                <ChevronRight size={13} />
                <span>共享管理</span>
              </>
            )}
            {directory?.trail.map((c, i) => (
              <span className="crumb" key={c.url}>
                <ChevronRight size={13} />
                <button onClick={() => crumb(i)}>{c.name}</button>
              </span>
            ))}
          </div>
          <div className="toolbar-actions">
            <button className="icon-btn" aria-label="刷新" title="刷新" onClick={refresh}>
              <RefreshCw size={17} />
            </button>
          </div>
        </header>
        <div className="page-body">
          <div className="page-heading">
            <div>
              <h1>{locked ? '访问共享位置' : pageTitle}</h1>
              {current && (
                <p>
                  {directory?.place.kind === 'local'
                    ? '本地文件夹'
                    : mode === 'hosted'
                      ? '共享文件夹'
                      : directory
                        ? placeKind(directory.place)
                        : ''}
                </p>
              )}
            </div>
            {!directory &&
              places.length > 0 &&
              section === 'home' &&
              !locked &&
              (mode === 'static' || mode === 'desktop') && (
                <button className="btn primary" onClick={add} disabled={busy}>
                  {bridge ? <FolderOpen size={16} /> : <Plus size={16} />}
                  {bridge ? '打开文件夹' : '添加位置'}
                </button>
              )}
            {current && bridge && (
              <div className="toolbar-actions">
                <button
                  className={'btn' + (isFavorite ? ' toggled' : '')}
                  disabled={busy}
                  aria-pressed={!!isFavorite}
                  onClick={() => void run(() => bridge.setFavorite(current.url, !isFavorite))}
                >
                  <Star size={16} />
                  {isFavorite ? '已收藏' : '收藏'}
                </button>
                <button
                  className={'btn' + (isShared ? ' toggled' : '')}
                  disabled={busy}
                  aria-pressed={!!isShared}
                  onClick={() => void run(() => bridge.setShared(current.url, !isShared))}
                >
                  <Share2 size={16} />
                  {isShared ? '已共享' : 'HTTP 共享'}
                </button>
              </div>
            )}
          </div>
          {error && (
            <div className="error" role="alert">
              <CircleAlert size={16} />
              <span>{error}</span>
              <button className="icon-btn" aria-label="关闭提示" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {locked && (
            <form
              className="login-panel"
              onSubmit={(e) => {
                e.preventDefault()
                void run(async () => {
                  await authenticate({ key })
                  setKey('')
                  setVersion((v) => v + 1)
                })
              }}
            >
              <KeyRound size={26} />
              <h2>输入访问密钥</h2>
              <label className="field">
                访问密钥
                <input
                  autoFocus
                  required
                  value={key}
                  type="password"
                  onChange={(e) => setKey(e.target.value)}
                  autoComplete="current-password"
                />
              </label>
              <button className="btn primary" disabled={busy}>
                打开共享位置
                <ArrowRight size={16} />
              </button>
            </form>
          )}
          {!locked && !mode && (
            <p className="status" role="status">
              {rootLoading ? '正在加载…' : '请刷新后重试。'}
            </p>
          )}
          {!locked && mode && section === 'sharing' && desktop && (
            <Sharing state={desktop} busy={busy} run={(a) => void run(a)} />
          )}
          {!locked && mode && !directory && section === 'home' && (
            <section className="home-section">
              {places.length > 0 && (
                <div className="section-heading">
                  <h2>
                    {mode === 'desktop' ? '我的收藏' : mode === 'hosted' ? '共享文件夹' : '我的位置'}
                  </h2>
                  <span className="count">{places.length}</span>
                </div>
              )}
              {rootLoading ? (
                <p role="status" className="status">
                  正在读取位置…
                </p>
              ) : rootError ? (
                <Empty icon={<CircleAlert />} title="无法读取位置" description={rootError}>
                  <button className="btn" onClick={refresh}>
                    重试
                  </button>
                </Empty>
              ) : (
                <Home mode={mode} places={places} onOpen={open} onRemove={removePlace} onAdd={add} />
              )}
            </section>
          )}
          {directory && !locked && (
            <section className="folder-section">
              <div className="section-heading">
                <h2>文件</h2>
                <span className="count">{entries.length}</span>
                <div className="view-controls">
                  <button
                    className={'icon-btn' + (layout === 'list' ? ' active' : '')}
                    aria-label="列表视图"
                    aria-pressed={layout === 'list'}
                    onClick={() => setLayout('list')}
                  >
                    <List size={17} />
                  </button>
                  <button
                    className={'icon-btn' + (layout === 'grid' ? ' active' : '')}
                    aria-label="网格视图"
                    aria-pressed={layout === 'grid'}
                    onClick={() => setLayout('grid')}
                  >
                    <Grid2X2 size={17} />
                  </button>
                </div>
              </div>
              {loading ? (
                <p role="status" className="status">
                  正在读取目录…
                </p>
              ) : dirError ? (
                <Empty icon={<CircleAlert />} title="无法读取目录" description={dirError}>
                  <button className="btn" onClick={refresh}>
                    重试
                  </button>
                </Empty>
              ) : entries.length ? (
                <Files entries={entries} layout={layout} selected={selected} onOpen={openEntry} />
              ) : (
                <Empty icon={<FolderOpen />} title="空文件夹" />
              )}
            </section>
          )}
        </div>
      </main>
      {showAdd && (
        <AddLocation
          onClose={() => setShowAdd(false)}
          onSave={(p) => {
            const existing = places.findIndex((v) => v.url === p.url && v.kind === p.kind)
            const list = [...places]
            if (existing < 0) list.push(p)
            else list[existing] = p
            savePlaces(list)
            setShowAdd(false)
            open(p)
          }}
        />
      )}
      {preview && (
        <Preview
          entry={preview}
          entries={entries}
          onSelect={(e) => {
            setPreview(e)
            setSelected(e.url)
          }}
          onClose={closePreview}
        />
      )}
    </div>
  )
}
