import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises'
import { openLibrary } from './library.mjs'
import { fileResponse } from './protocols.mjs'

async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'view-desktop-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const config = path.join(dir, 'config', 'locations.json')
  const album = path.join(dir, '旅行 #1')
  await mkdir(album)
  return { dir, album, config, library: await openLibrary(config) }
}

test('nested bookmarks and shares persist independently, without persisting the temporary parent grant', async (t) => {
  const { dir, album, config, library } = await fixture(t)
  const parent = await library.select(dir)
  const [child] = await library.list(parent.url)
  assert.ok(child.url.endsWith('/'))
  assert.equal((await library.select(album)).url, child.url)
  await Promise.all([
    library.setFlag(child.url, 'shared', true),
    library.setFlag(child.url, 'favorite', true),
  ])
  assert.deepEqual(library.state().favorites, library.state().shares)
  assert.equal(library.state().favorites[0].url, child.url)
  assert.deepEqual(
    library.shares().map((share) => share.path),
    [album],
  )
  const restored = await openLibrary(config)
  const restoredChild = restored.state().favorites[0]
  await assert.rejects(restored.list(parent.url))
  await restored.setFlag(restoredChild.url, 'favorite', false)
  assert.equal(restored.state().shares[0].url, restoredChild.url)
  await rm(album, { recursive: true })
  await restored.setFlag(restoredChild.url, 'shared', false)
  assert.equal((await openLibrary(config)).shares().length, 0)
})

test('file protocol streams selected bytes and restricts access to the opened root', async (t) => {
  const { dir, album, library } = await fixture(t)
  const name = '合照 %23.txt'
  await writeFile(path.join(album, name), '0123456789')
  await writeFile(path.join(dir, 'outside'), 'outside')
  const folder = await library.select(album)
  const [file] = await library.list(folder.url)
  assert.equal(file.name, name)
  assert.equal(file.size, 10)
  assert.ok(Number.isFinite(Date.parse(file.modified)))
  const part = await fileResponse(new Request(file.url, { headers: { Range: 'bytes=2-5' } }), library)
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('Content-Range'), 'bytes 2-5/10')
  assert.equal(await part.text(), '2345')
  const invalid = await fileResponse(new Request(file.url, { headers: { Range: 'bytes=99-' } }), library)
  assert.equal(invalid.status, 416)
  const unknown = await fileResponse(new Request('view-file://unknown/private.txt'), library)
  assert.equal(unknown.status, 404)
  if (process.platform !== 'win32') {
    await symlink(path.join(dir, 'outside'), path.join(album, 'link'))
    assert.equal((await fileResponse(new Request(folder.url + 'link'), library)).status, 404)
  }
})

test('opening a file grants its parent for sibling navigation, with the same URLs as directory browsing', async (t) => {
  const { album, config, library } = await fixture(t)
  const filename = path.join(album, '旅行 #1.txt')
  await writeFile(filename, 'one')
  await writeFile(path.join(album, '另一张.txt'), 'two')
  const target = await library.openFile(filename)
  const siblings = await library.list(target.folder.url)
  assert.deepEqual(target.folder, await library.select(album))
  assert.deepEqual(
    target.file,
    siblings.find((item) => item.name === '旅行 #1.txt'),
  )
  assert.equal(siblings.length, 2)
  assert.equal(await library.resolveUrl(target.file.url), filename)
  assert.deepEqual(library.state(), { favorites: [], shares: [] })
  await assert.rejects((await openLibrary(config)).list(target.folder.url))
  await assert.rejects(library.openFile(album), /普通文件/)
})

test('local thumbnail URLs preserve the originals and use the imported directory as the cache root', async (t) => {
  const { dir, album, library, config } = await fixture(t)
  const picture = path.join(album, '照片 #1%.jpg')
  const note = path.join(album, 'notes.txt')
  await Promise.all([writeFile(picture, 'image fixture'), writeFile(note, 'notes')])
  const parent = await library.select(dir)
  const folder = await library.select(album)
  const entries = await library.list(folder.url)
  const image = entries.find((item) => item.name === path.basename(picture))
  assert.equal(image.thumbnailUrl, image.url + '?thumbnail=1')
  assert.equal(await library.resolveUrl(image.url), picture)
  assert.equal(await library.resolveUrl(image.thumbnailUrl), picture)
  assert.equal(library.thumbnailRoot(picture), dir)
  assert.ok(!entries.find((item) => item.name === 'notes.txt').thumbnailUrl)
  assert.ok(
    !(await library.list(parent.url)).find((item) => item.name === path.basename(album)).thumbnailUrl,
  )
  assert.deepEqual((await library.openFile(picture)).file, image)
  await assert.rejects(readFile(config), { code: 'ENOENT' })

  await library.setFlag(folder.url, 'shared', true)
  const restored = await openLibrary(config)
  assert.equal(restored.thumbnailRoot(picture), dir)
  assert.equal(restored.thumbnailRoot(path.join(dir, 'other.jpg')), null)
  await assert.rejects(restored.resolveUrl(parent.url))
  assert.equal(restored.shares()[0].path, album)
})

test('a later parent import promotes legacy nested cache ownership without granting parent access on restart', async (t) => {
  const { dir, album, config } = await fixture(t)
  const photo = path.join(album, 'photo.jpg')
  await writeFile(photo, 'test')
  // An earlier version stored only the directory itself and these two flags.
  await mkdir(path.dirname(config))
  await writeFile(
    config,
    JSON.stringify([
      {
        id: 'de659378-fa4b-49b7-8d02-a93585864686',
        path: album,
        favorite: true,
        shared: false,
      },
    ]),
  )
  const retired = []
  const library = await openLibrary(config, { onThumbnailRootRemoved: (root) => retired.push(root) })
  const [favorite] = library.state().favorites
  assert.equal(library.thumbnailRoot(photo), album)
  const { file } = await library.openFile(photo)
  const [parent] = await Promise.all([
    library.select(dir),
    library.setFlag(favorite.url, 'shared', true),
  ])
  assert.equal(await library.resolveUrl(file.url), photo)
  assert.equal(library.thumbnailRoot(photo), dir)
  await library.select(album)
  assert.deepEqual(retired, [album])

  const restored = await openLibrary(config)
  assert.equal(restored.thumbnailRoot(photo), dir)
  assert.equal(restored.thumbnailRoot(path.join(dir, 'another-folder', 'other.jpg')), null)
  await assert.rejects(restored.resolveUrl(parent.url))
  assert.deepEqual(restored.state().favorites, restored.state().shares)
  assert.equal(restored.shares()[0].path, album)
})
