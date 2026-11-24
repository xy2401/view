import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { channel } from 'node:diagnostics_channel'
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startSharing } from '../../apps/desktop/src/sharing/server.mjs'

const webRoot = fileURLToPath(new URL('../../apps/web/dist/', import.meta.url))
const fixtures = new URL('./fixtures/magika/', import.meta.url)
const key = randomUUID()
const pdf = 'document.jpg'
const image = 'photo'
const filePath = (name) => '/files/samples/' + name
const modelDir = '/models/standard_v3_3/'
let browser, folder, server, origin

before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'view-browser-'))
  await copyFile(new URL('magika_test.pdf', fixtures), join(folder, pdf))
  await copyFile(new URL('magika_test.png', fixtures), join(folder, image))
  server = await startSharing({
    host: '127.0.0.1', webRoot, accessKey: key,
    getShares: () => [{ id: 'samples', name: '预览样本', path: folder }],
  })
  origin = 'http://127.0.0.1:' + server.port
  browser = await chromium.launch({ executablePath: process.env.VIEW_CHROMIUM_PATH })
})

after(async () => {
  try {
    await browser?.close()
    await server?.stop()
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true })
  }
})

async function openFolder(t) {
  const context = await browser.newContext()
  t.after(() => context.close())
  const external = []
  await context.route(/^https?:/, async (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue()
    external.push(route.request().url())
    await route.abort()
  })
  t.after(() => assert.deepEqual(external, [], 'The preview must work entirely on this origin'))

  // Also observe real HTTP responses to dedicated workers, independently of browser instrumentation.
  const responses = []
  const completed = channel('http.server.response.finish')
  function record({ request, response }) {
    if (request.socket.localPort === server.port) {
      responses.push({ path: request.url, range: request.headers.range, status: response.statusCode })
    }
  }
  completed.subscribe(record)
  t.after(() => completed.unsubscribe(record))
  const page = await context.newPage()
  await page.goto(origin)
  await page.getByLabel('访问密钥', { exact: true }).fill(key)
  await page.getByRole('button', { name: '打开共享位置' }).click()
  await page.getByRole('main').getByRole('button', { name: /预览样本/ }).click()
  await page.getByRole('button', { name: /document\.jpg/ }).waitFor()
  assert(responses.some((r) => r.path === '/files/' && r.status === 401))
  assert(responses.some((r) => r.path === '/files/' && r.status === 200))
  assert(!responses.some((r) => [filePath(pdf), filePath(image)].includes(r.path)), 'Listing read file contents')
  return { page, responses }
}

async function assertDecodedPng(page, name) {
  const bitmap = page.getByRole('img', { name, exact: true })
  await bitmap.waitFor()
  assert.deepEqual(await bitmap.evaluate(async (img) => {
    await img.decode()
    return [img.naturalWidth, img.naturalHeight]
  }), [960, 540])
}

test('a PDF named .jpg opens in the PDF viewer and renders its real page', async (t) => {
  const { page, responses } = await openFolder(t)
  await page.getByRole('button', { name: /document\.jpg/ }).click()
  await page.getByText('第 1 / 1 页', { exact: true }).waitFor()
  // A newly inserted canvas has no pixels until the PDF worker finishes drawing.
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas[aria-label="第 1 页"]')
    if (!canvas) return false
    const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    return rgba.some((value, index) => index % 4 === 0 && value < 128 && rgba[index + 3] === 255)
  })
  assert(responses.some((r) => r.path === filePath(pdf) && r.range === 'bytes=0-4095' && r.status === 206))
  assert(!responses.some((r) => r.path.startsWith(modelDir)))
})

test('an extensionless PNG decodes and Magika identifies it on demand from two 4 KiB ranges', async (t) => {
  const { page, responses } = await openFolder(t)
  await page.getByRole('button', { name: /photo/ }).click()
  await assertDecodedPng(page, image)
  assert(responses.some((r) => r.path === filePath(image) && r.range === 'bytes=0-4095' && r.status === 206))
  assert(!responses.some((r) => r.path.startsWith(modelDir)), 'Preview eagerly loaded Magika')

  const start = responses.length
  await page.getByRole('button', { name: '识别格式' }).click()
  const dialog = page.getByRole('dialog', { name: '识别文件格式' })
  await dialog.getByText('PNG', { exact: true }).waitFor({ timeout: 90_000 })
  const inference = responses.slice(start)
  const { size } = await stat(join(folder, image))
  assert.deepEqual(inference.filter((r) => r.path === filePath(image)).map((r) => [r.status, r.range]), [
    [206, 'bytes=0-4095'], [206, `bytes=${size - 4096}-${size - 1}`],
  ])
  const modelRequests = inference.filter((r) => r.path.startsWith(modelDir) && r.status === 200)
  assert.deepEqual(new Set(modelRequests.map((r) => r.path.slice(modelDir.length))), new Set([
    'config.min.json', 'model.json', 'group1-shard1of1.bin',
  ]))
})

test('static Web decodes a mislabeled CORS image and still embeds a correctly labeled non-CORS image', async (t) => {
  const png = await readFile(new URL('magika_test.png', fixtures))
  const requests = []
  const files = createServer((req, res) => {
    const { url, headers } = req
    if (url !== '/ordinary.png') res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end('<h1>Index of /</h1><a href="scan.txt">scan.txt</a><a href="ordinary.png">ordinary.png</a>')
      return
    }
    if (url !== '/scan.txt' && url !== '/ordinary.png') {
      res.writeHead(404).end()
      return
    }
    res.setHeader('Content-Type', url === '/scan.txt' ? 'text/plain' : 'image/png')
    const probe = headers.range === 'bytes=0-4095'
    const body = probe ? png.subarray(0, 4096) : png
    if (probe) res.setHeader('Content-Range', `bytes 0-4095/${png.length}`)
    res.setHeader('Content-Length', body.length)
    requests.push({ url, probe, origin: headers.origin })
    res.writeHead(probe ? 206 : 200).end(body)
  })
  await new Promise((resolve, reject) => files.once('error', reject).listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => {
    files.close(error => error ? reject(error) : resolve())
    files.closeAllConnections()
  }))

  const context = await browser.newContext()
  t.after(() => context.close())
  const page = await context.newPage()
  await page.route(origin + '/view-runtime.json', route => route.fulfill({ json: { mode: 'static' } }))
  await page.goto(origin)
  await page.getByRole('button', { name: '添加位置' }).click()
  const form = page.getByRole('dialog', { name: '添加位置' })
  await form.getByLabel('目录地址').fill('http://127.0.0.1:' + files.address().port + '/')
  await form.getByRole('button', { name: '添加位置' }).click()
  await page.getByRole('button', { name: /scan\.txt/ }).click()
  await assertDecodedPng(page, 'scan.txt')
  assert(requests.some(r => r.url === '/scan.txt' && r.probe && r.origin === origin))
  await page.getByRole('button', { name: '关闭预览' }).click()
  await page.getByRole('button', { name: /ordinary\.png/ }).click()
  await assertDecodedPng(page, 'ordinary.png')
})
