import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

function within(root, target) {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

function nameOf(directory) {
  return path.basename(directory) || directory
}

function validRecord(record) {
  return (
    record &&
    typeof record.id === 'string' &&
    /^[a-f0-9-]{36}$/.test(record.id) &&
    typeof record.path === 'string' &&
    path.isAbsolute(record.path) &&
    typeof record.favorite === 'boolean' &&
    typeof record.shared === 'boolean'
  )
}

export async function openLibrary(configPath) {
  let saved = []
  try {
    saved = JSON.parse(await readFile(configPath, 'utf8'))
    if (!Array.isArray(saved) || !saved.every(validRecord)) {
      throw new Error('无法读取已保存的位置配置')
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  // Grants live for this desktop session. Only favorites and shares survive a restart.
  const grants = new Map(saved.map((record) => [record.id, record.path]))
  let pending = Promise.resolve()

  function urlFor(target, directory) {
    for (const [id, root] of grants) {
      if (!within(root, target)) continue
      const suffix = path.relative(root, target).split(path.sep).map(encodeURIComponent).join('/')
      return 'view-file://' + id + '/' + suffix + (suffix && directory ? '/' : '')
    }
    throw new Error('请先打开所在文件夹')
  }

  function place(target) {
    return { name: nameOf(target), url: urlFor(target, true) }
  }

  async function resolveUrl(input) {
    const url = new URL(input)
    const root = grants.get(url.hostname)
    if (url.protocol !== 'view-file:' || url.username || url.password || url.port || !root) {
      throw new Error('无权访问此位置')
    }
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (
      segments.some(
        (s) =>
          s === '.' ||
          s === '..' ||
          s.includes('\0') ||
          s.includes('/') ||
          (process.platform === 'win32' && /[\\:]/.test(s)),
      )
    ) {
      throw new Error('无效的文件路径')
    }
    const target = await realpath(path.join(root, ...segments))
    if (!within(root, target)) throw new Error('文件位于已打开的目录之外')
    return target
  }

  async function setFlag(url, field, value) {
    if (!['favorite', 'shared'].includes(field) || typeof value !== 'boolean')
      throw new Error('无效的设置')
    // A removed or disconnected drive can still be unpinned or unshared.
    const stored = !value && saved.find((record) => urlFor(record.path, true) === url)
    const dir = stored ? stored.path : await resolveUrl(url)
    if (!stored && !(await stat(dir)).isDirectory()) throw new Error('请选择文件夹')
    const update = pending.then(async () => {
      const previous = saved.find((record) => record.path === dir)
      if ((previous?.[field] ?? false) === value) return
      const id = previous?.id ?? [...grants].find(([, root]) => root === dir)?.[0] ?? randomUUID()
      const record = { id, path: dir, favorite: false, shared: false, ...previous, [field]: value }
      const updated = saved.filter((item) => item.path !== dir)
      if (record.favorite || record.shared) updated.push(record)
      await mkdir(path.dirname(configPath), { recursive: true })
      const tmp = configPath + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(tmp, JSON.stringify(updated), { mode: 0o600, flag: 'wx' })
        await rename(tmp, configPath)
      } finally {
        await rm(tmp, { force: true })
      }
      saved = updated
    })
    pending = update.catch(() => {})
    return update
  }

  return {
    setFlag,
    resolveUrl,
    async select(directory) {
      const root = await realpath(directory)
      if (!(await stat(root)).isDirectory()) throw new Error('请选择文件夹')
      if (![...grants.values()].some((parent) => within(parent, root))) grants.set(randomUUID(), root)
      return place(root)
    },
    async list(url) {
      const dir = await resolveUrl(url)
      const files = (await readdir(dir, { withFileTypes: true })).filter(
        (file) => file.isDirectory() || file.isFile(),
      )
      const result = []
      for (let i = 0; i < files.length; i += 32) {
        const entries = await Promise.all(
          files.slice(i, i + 32).map(async (file) => {
            const target = path.join(dir, file.name)
            try {
              const metadata = await lstat(target)
              if (!metadata.isDirectory() && !metadata.isFile()) return null
              return {
                name: file.name,
                directory: metadata.isDirectory(),
                url: urlFor(target, metadata.isDirectory()),
                size: metadata.isFile() ? metadata.size : undefined,
                modified: metadata.mtime.toISOString(),
              }
            } catch (error) {
              if (error.code === 'ENOENT') return null
              if (error.code === 'EACCES' || error.code === 'EPERM') {
                return {
                  name: file.name,
                  directory: file.isDirectory(),
                  url: urlFor(target, file.isDirectory()),
                }
              }
              throw error
            }
          }),
        )
        result.push(...entries.filter(Boolean))
      }
      return result
    },
    state() {
      return {
        favorites: saved.filter((r) => r.favorite).map((r) => place(r.path)),
        shares: saved.filter((r) => r.shared).map((r) => place(r.path)),
      }
    },
    shares() {
      return saved
        .filter((r) => r.shared)
        .map(({ id, path: dir }) => ({ id, name: nameOf(dir), path: dir }))
    },
  }
}
