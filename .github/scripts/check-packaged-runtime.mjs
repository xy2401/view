// Run with the packaged Electron executable in Node mode so module resolution
// and native addons come from the downloadable app on the runner's architecture.
import assert from 'node:assert/strict'
import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

assert.ok(process.versions.electron, 'Run this check with the packaged Electron runtime')
const resources = process.resourcesPath
await access(join(resources, 'dist', 'index.html'))
const main = join(resources, 'app', 'src', 'main')
const { createThumbnailCache } = await import(pathToFileURL(join(main, 'thumbnail-cache.mjs')))
const { renderThumbnail } = await import(pathToFileURL(join(main, 'render-thumbnail.mjs')))
const input = await realpath(fileURLToPath(new URL('../../tests/browser/fixtures/magika/magika_test.png', import.meta.url)))
const directory = await mkdtemp(join(tmpdir(), 'view-ci-thumbnails-'))
let cache
try {
  cache = createThumbnailCache({ directory, generate: renderThumbnail })
  const thumbnail = await cache.get(dirname(input), input)
  assert.equal(thumbnail?.mime, 'image/webp', 'Packaged sharp must render the sample')
  assert.equal(thumbnail.data.toString('ascii', 8, 12), 'WEBP')
  cache.close()

  cache = createThumbnailCache({ directory, generate: async () => null })
  const restored = await cache.get(dirname(input), input)
  assert.deepEqual(restored?.data, thumbnail.data, 'SQLite must retain the thumbnail across cache restarts')
  console.log(`Verified packaged Electron ${process.versions.electron} on ${process.platform}-${process.arch}`)
} finally {
  cache?.close()
  await rm(directory, { recursive: true, force: true })
}
