import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { renderThumbnail } from './render-thumbnail.mjs'

test('raster thumbnails honor EXIF orientation, retain alpha and leave small images at their native size', async (t) => {
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), 'view-images-')))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const filename = path.join(folder, '照片.jpg')
  const jpeg = await sharp({ create: { width: 800, height: 400, channels: 3, background: 'navy' } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer()
  await writeFile(filename, jpeg)
  const thumb = await renderThumbnail(filename)
  const metadata = await sharp(thumb.data).metadata()
  assert.deepEqual([thumb.mime, metadata.width, metadata.height], ['image/webp', 160, 320])
  assert.deepEqual(await readFile(filename), jpeg)

  const png = await sharp({ create: { width: 16, height: 8, channels: 4, background: '#44884455' } })
    .png()
    .toBuffer()
  await writeFile(filename, png)
  const small = await sharp((await renderThumbnail(filename)).data).metadata()
  assert.deepEqual([small.width, small.height, small.hasAlpha], [16, 8, true])
  await writeFile(filename, '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>')
  await assert.rejects(renderThumbnail(filename))
})
