import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createThumbnailCache } from './thumbnail-cache.mjs'

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'view-thumb-')))
  const caches = []
  t.after(async () => {
    for (const cache of caches) cache.close()
    await rm(base, { recursive: true, force: true })
  })
  const directory = path.join(base, 'cache')
  const root = path.join(base, 'photos')
  await mkdir(root)
  async function file(relative) {
    const filename = path.join(root, relative)
    await mkdir(path.dirname(filename), { recursive: true })
    await writeFile(filename, 'source')
    return filename
  }
  function openCache(generate) {
    const cache = createThumbnailCache({ directory, generate })
    caches.push(cache)
    return cache
  }
  return { directory, root, file, openCache }
}

function image(text) {
  return { data: Buffer.from(text), mime: 'image/jpeg' }
}

test('creates one SQLite file per requested root and reuses only current thumbnails across restarts', async (t) => {
  const { root, directory, file, openCache } = await fixture(t)
  const first = await file('a/name.jpg')
  const second = await file('b/name.jpg')
  await file('a/unseen.jpg')
  let renders = 0
  const generate = async () => image('render-' + ++renders)
  const cache = openCache(generate)
  await assert.rejects(access(directory), { code: 'ENOENT' })
  assert.equal(await cache.get(root, path.join(root, '..', 'outside')), null)
  await assert.rejects(access(directory), { code: 'ENOENT' })
  assert.deepEqual(await cache.get(root, first), image('render-1'))
  assert.deepEqual(await cache.get(root, second), image('render-2'))
  cache.close()

  const [dbName] = await readdir(directory)
  assert.match(dbName, /^[a-f0-9]{64}\.sqlite$/)
  const db = new DatabaseSync(path.join(directory, dbName), { readOnly: true })
  try {
    assert.deepEqual(
      db
        .prepare('SELECT path FROM thumbnails ORDER BY path')
        .all()
        .map((r) => r.path),
      [path.join('a', 'name.jpg'), path.join('b', 'name.jpg')],
    )
  } finally {
    db.close()
  }
  const restored = openCache(generate)
  assert.deepEqual(await restored.get(root, first), image('render-1'))
  await utimes(first, new Date(1000), new Date(1000))
  assert.deepEqual(await restored.get(root, first), image('render-3'))
  assert.deepEqual(await restored.get(path.dirname(first), first), image('render-4'))
  assert.equal((await readdir(directory)).length, 2)
  assert.deepEqual((await readdir(path.dirname(first))).sort(), ['name.jpg', 'unseen.jpg'])
})

test('shares generations, bounds active decoders, and drops queued work whose consumer left', async (t) => {
  const { root, file, openCache } = await fixture(t)
  const [a, b, c] = await Promise.all(['a.jpg', 'b.jpg', 'c.jpg'].map(file))
  const running = []
  const entered = [Promise.withResolvers(), Promise.withResolvers()]
  const release = Promise.withResolvers()
  const cache = openCache(async (filename) => {
    running.push(filename)
    entered[running.length - 1]?.resolve()
    await release.promise
    return image(path.basename(filename))
  })
  const first = cache.get(root, a)
  await entered[0].promise
  const duplicate = cache.get(root, a)
  const second = cache.get(root, b)
  await entered[1].promise
  const controller = new AbortController()
  const subscribed = Promise.withResolvers()
  t.mock.method(controller.signal, 'addEventListener', function (...args) {
    subscribed.resolve()
    return AbortSignal.prototype.addEventListener.apply(this, args)
  })
  const canceled = cache.get(root, c, controller.signal)
  await subscribed.promise
  controller.abort()
  assert.equal(await canceled, null)
  assert.deepEqual(running, [a, b])
  release.resolve()
  assert.deepEqual(await Promise.all([first, duplicate, second]), [
    image('a.jpg'),
    image('a.jpg'),
    image('b.jpg'),
  ])
  assert.deepEqual(running, [a, b])
})

test('discards a thumbnail if its source changed during decode and recovers from corrupt cache bytes', async (t) => {
  const { root, directory, file, openCache } = await fixture(t)
  const filename = await file('image.jpg')
  const unstable = openCache(async () => {
    await writeFile(filename, 'replaced during render')
    return image('stale')
  })
  assert.equal(await unstable.get(root, filename), null)
  unstable.close()
  const [name] = await readdir(directory)
  await writeFile(path.join(directory, name), 'invalid SQLite bytes')
  const cache = openCache(async () => image('new'))
  assert.deepEqual(await cache.get(root, filename), image('new'))
  cache.close()
  let calls = 0
  const restored = openCache(async () => {
    calls++
    return null
  })
  assert.deepEqual(await restored.get(root, filename), image('new'))
  assert.equal(calls, 0)
})

test('retiring a nested root removes only its database and prevents late requests from recreating it', async (t) => {
  const { root, directory, file, openCache } = await fixture(t)
  const first = await file('child/first.jpg')
  const second = await file('child/second.jpg')
  const untouched = await file('sibling/untouched.jpg')
  const child = path.dirname(first)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const cache = openCache(async (filename) => {
    if (filename === second) {
      entered.resolve()
      await release.promise
    }
    return image(path.basename(filename))
  })
  await cache.get(child, first)
  const [childDatabase] = await readdir(directory)
  await cache.get(path.dirname(untouched), untouched)
  const active = cache.get(child, second)
  await entered.promise
  const checkingStamp = cache.get(child, first)

  cache.discardRoot(child)
  assert.deepEqual(await Promise.all([active, checkingStamp]), [null, null])
  await assert.rejects(access(path.join(directory, childDatabase)), { code: 'ENOENT' })
  assert.equal((await readdir(directory)).length, 1)

  release.resolve()
  assert.deepEqual(await cache.get(root, second), image('second.jpg'))
  assert.equal(await cache.get(child, first), null)
  await assert.rejects(access(path.join(directory, childDatabase)), { code: 'ENOENT' })
  assert.equal((await readdir(directory)).length, 2)
})
