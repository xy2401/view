import { createHash } from 'node:crypto'
import { constants, mkdirSync, rmSync } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Bump this when the thumbnail dimensions, encoding or orientation rules change.
const profile = 'v1'
const maxDecoders = 2
const maxOpenDatabases = 8

function validImage(value) {
  return (
    value?.data instanceof Uint8Array &&
    value.data.length > 0 &&
    ['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(value.mime)
  )
}

async function stampOf(filename) {
  if ((await realpath(filename)) !== filename) return null
  const handle = await open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  )
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile()) return null
    return [profile, info.size, info.mtimeNs, info.ctimeNs, info.dev, info.ino].join(':')
  } finally {
    await handle.close()
  }
}

export function createThumbnailCache({ directory, generate }) {
  const databases = new Map()
  const retired = new Set()
  const pending = new Map()
  const waiting = new Set()
  let active = 0
  let closed = false

  function releaseDatabase(root) {
    databases.get(root)?.close()
    databases.delete(root)
  }

  function databasePath(root) {
    return path.join(directory, createHash('sha256').update(root).digest('hex') + '.sqlite')
  }

  function withDatabase(root, action) {
    const filename = databasePath(root)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let db = databases.get(root)
        if (db) databases.delete(root)
        else {
          if (databases.size >= maxOpenDatabases) releaseDatabase(databases.keys().next().value)
          mkdirSync(directory, { recursive: true, mode: 0o700 })
          db = new DatabaseSync(filename)
          databases.set(root, db)
          db.exec(
            'CREATE TABLE IF NOT EXISTS thumbnails (path TEXT PRIMARY KEY, stamp TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL)',
          )
        }
        databases.set(root, db)
        return action(db)
      } catch (error) {
        releaseDatabase(root)
        // Only rebuild databases SQLite positively identified as corrupt or non-SQLite.
        // A locked or read-only cache may be retried on a later request.
        if (attempt || ![11, 26].includes(error.errcode & 0xff)) return null
        try {
          rmSync(filename, { force: true })
        } catch {
          return null
        }
      }
    }
  }

  async function render(job) {
    const thumb = await generate(job.filename)
    if (closed || !job.clients.size || !validImage(thumb)) return null
    if ((await stampOf(job.filename)) !== job.stamp || closed || !job.clients.size) return null
    withDatabase(job.root, (db) =>
      db
        .prepare('INSERT OR REPLACE INTO thumbnails(path, stamp, mime, data) VALUES (?, ?, ?, ?)')
        .run(job.relative, job.stamp, thumb.mime, thumb.data),
    )
    return { data: Buffer.from(thumb.data), mime: thumb.mime }
  }

  function pump() {
    while (!closed && active < maxDecoders && waiting.size) {
      const job = waiting.values().next().value
      waiting.delete(job)
      active++
      void render(job)
        .catch(() => null)
        .then((value) => {
          for (const finish of job.clients) finish(value)
          pending.delete(job.key)
          active--
          pump()
        })
    }
  }

  return {
    async get(root, filename, signal) {
      if (closed || retired.has(root) || signal?.aborted) return null
      if (!path.isAbsolute(root) || !path.isAbsolute(filename)) return null
      const relative = path.relative(root, filename)
      if (
        !relative ||
        relative === '..' ||
        relative.startsWith('..' + path.sep) ||
        path.isAbsolute(relative)
      )
        return null
      let stamp
      try {
        stamp = await stampOf(filename)
      } catch {
        return null
      }
      if (!stamp || closed || retired.has(root) || signal?.aborted) return null
      const key = JSON.stringify([root, relative, stamp])
      let job = pending.get(key)
      if (!job) {
        const hit = withDatabase(root, (db) =>
          db
            .prepare('SELECT mime, data FROM thumbnails WHERE path = ? AND stamp = ?')
            .get(relative, stamp),
        )
        if (validImage(hit)) return { data: Buffer.from(hit.data), mime: hit.mime }
        job = { key, root, filename, relative, stamp, clients: new Set() }
        pending.set(key, job)
        waiting.add(job)
      }
      return new Promise((resolve) => {
        const finish = (value) => {
          signal?.removeEventListener('abort', cancel)
          job.clients.delete(finish)
          resolve(value)
        }
        const cancel = () => {
          finish(null)
          if (!job.clients.size && waiting.delete(job)) pending.delete(key)
        }
        job.clients.add(finish)
        signal?.addEventListener('abort', cancel, { once: true })
        pump()
      })
    },

    discardRoot(root) {
      retired.add(root)
      for (const job of pending.values()) {
        if (job.root !== root) continue
        waiting.delete(job)
        pending.delete(job.key)
        // An active decoder may still finish; render() drops results without consumers.
        for (const finish of job.clients) finish(null)
      }
      releaseDatabase(root)
      try {
        rmSync(databasePath(root), { force: true })
      } catch {
        // A read-only or locked derivative remains inactive even if it cannot be unlinked.
      }
    },

    close() {
      closed = true
      for (const job of pending.values()) {
        for (const finish of job.clients) finish(null)
      }
      waiting.clear()
      pending.clear()
      for (const root of databases.keys()) releaseDatabase(root)
    },
  }
}
