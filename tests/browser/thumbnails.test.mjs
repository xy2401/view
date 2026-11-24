import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startSharing } from '../../apps/desktop/src/sharing/server.mjs'

const webRoot = fileURLToPath(new URL('../../apps/web/dist/', import.meta.url))
const original = new URL('./fixtures/magika/magika_test.png', import.meta.url)
const thumbnail = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNwSxEBAAGyAL8qPndSAAAAAElFTkSuQmCC',
  'base64',
)

test('hosted grid loads only nearby advertised thumbnails; a failed thumbnail can still open the original', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'view-thumbnails-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const png = await readFile(original)
  const files = Array.from({ length: 72 }, (_, i) => String(i + 1).padStart(3, '0') + '.png')
  files[0] = '001 unavailable.png'
  files[1] = '002 photo #1.png'
  await Promise.all(files.map((name) => writeFile(join(folder, name), png)))
  const note = '000 notes.txt'
  await writeFile(join(folder, note), 'An entry without a thumbnail.')

  const key = randomUUID()
  const generated = []
  const shares = [{ id: 'photos', name: '相册', path: folder }]
  const server = await startSharing({
    host: '127.0.0.1',
    webRoot,
    accessKey: key,
    getShares: () => shares,
    getThumbnail: async (file) => {
      const name = basename(file)
      generated.push(name)
      return name === files[0] ? null : { data: thumbnail, mime: 'image/png' }
    },
  })
  t.after(() => server.stop())
  const browser = await chromium.launch({ executablePath: process.env.VIEW_CHROMIUM_PATH })
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 960, height: 640 } })
  t.after(() => context.close())
  const page = await context.newPage()
  const origin = 'http://127.0.0.1:' + server.port
  const requests = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/files/photos/') && !url.pathname.endsWith('/')) requests.push(url)
  })
  await page.goto(origin)
  await page.getByLabel('访问密钥', { exact: true }).fill(key)
  await page.getByRole('button', { name: '打开共享位置' }).click()
  const indexUrl = origin + '/files/photos/'
  const [index] = await Promise.all([
    page.waitForResponse(indexUrl),
    page.getByRole('main').getByRole('button', { name: /相册/ }).click(),
  ])
  const advertised = await page.evaluate(
    ({ markup, base }) => {
      const document = new DOMParser().parseFromString(markup, 'text/html')
      return Object.fromEntries(
        [...document.querySelectorAll('a[data-thumbnail]')].map((a) => [
          a.dataset.name,
          new URL(a.dataset.thumbnail, base).href,
        ]),
      )
    },
    { markup: await index.text(), base: indexUrl },
  )
  await page.getByRole('button', { name: /072\.png/ }).waitFor()
  assert.equal(Object.keys(advertised).length, files.length)
  assert.equal(advertised[note], undefined)
  assert.deepEqual(requests, [], 'List view should only read the directory index')
  assert.deepEqual(generated, [])

  const failed = page.waitForResponse(
    (res) => res.url().startsWith(advertised[files[0]]) && res.status() === 404,
  )
  await page.getByRole('button', { name: '网格视图' }).click()
  // Use the actual grid geometry so the test works with different column counts and fonts.
  const rows = await page.locator('button[data-entry-url]').evaluateAll((cards) =>
    cards.map((card) => ({
      name: decodeURIComponent(new URL(card.dataset.entryUrl).pathname.split('/').pop()),
      screens: card.querySelector('.thumbnail').getBoundingClientRect().top / innerHeight,
    })),
  )
  const next = rows.find((row) => row.screens > 1.05 && row.screens < 1.95)
  const distant = rows.filter((row) => row.screens > 2.5)
  assert(next && distant.length, 'Fixture must extend beyond two viewports')
  async function expectThumbnail(name) {
    const card = page.locator('button[data-entry-url]').filter({ hasText: name })
    const img = card.locator('.thumbnail img')
    await img.waitFor({ state: 'attached' })
    assert.deepEqual(
      await img.evaluate(async (node) => {
        await node.decode()
        return [node.naturalWidth, node.naturalHeight]
      }),
      [1, 1],
    )
  }
  await expectThumbnail(files[1])
  await expectThumbnail(next.name)
  await failed
  const failedCard = page.getByRole('button', { name: /001 unavailable/ })
  await failedCard.locator('.thumbnail img').waitFor({ state: 'detached' })
  await failedCard.locator('.thumbnail .file-icon').waitFor()
  await page
    .getByRole('button', { name: /000 notes/ })
    .locator('.thumbnail .file-icon')
    .waitFor()
  assert(
    distant.every(({ name }) => !generated.includes(name)),
    'Offscreen files were generated before scrolling',
  )

  const last = files.at(-1)
  await page.getByRole('button', { name: /072\.png/ }).scrollIntoViewIfNeeded()
  await expectThumbnail(last)
  assert(generated.includes(last))
  assert(!generated.includes(note))
  for (const url of requests) {
    const name = decodeURIComponent(url.pathname.split('/').pop())
    const supplied = new URL(advertised[name])
    assert.equal(url.origin + url.pathname, supplied.origin + supplied.pathname)
    assert.equal(
      url.searchParams.get('thumbnail'),
      '1',
      'Grid read the original instead of its advertised thumbnail',
    )
  }

  const fullUrl = indexUrl + encodeURIComponent(files[0])
  const readOriginal = page.waitForResponse((res) => res.url() === fullUrl && res.status() === 200)
  await failedCard.click()
  await readOriginal
  const preview = page.getByRole('dialog', { name: '预览 ' + files[0] })
  assert.deepEqual(
    await preview.getByRole('img', { name: files[0] }).evaluate(async (node) => {
      await node.decode()
      return [node.naturalWidth, node.naturalHeight]
    }),
    [960, 540],
  )
})
