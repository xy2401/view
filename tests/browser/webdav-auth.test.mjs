import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { byteRange } from '../../apps/desktop/src/sharing/byte-range.mjs'

const web = new URL('../../apps/web/dist/', import.meta.url)
const fixtures = new URL('./fixtures/', import.meta.url)

async function listen(t, handler) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  )
  return 'http://127.0.0.1:' + server.address().port
}

async function serveStatic(t, requests) {
  const files = new Set(await readdir(web, { recursive: true }))
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.css': 'text/css',
    '.woff': 'font/woff',
  }
  return listen(t, async (req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization })
    const pathname = new URL(req.url, 'http://localhost').pathname
    if (!pathname.startsWith('/view/')) return res.writeHead(404).end()
    const name = pathname.slice('/view/'.length) || 'index.html'
    if (!files.has(name)) return res.writeHead(404).end()
    const body = await readFile(new URL(name, web))
    res.writeHead(200, { 'Content-Type': types[extname(name)] ?? 'application/octet-stream' }).end(body)
  })
}

async function serveDav(t, app, authorization, requests) {
  // seek.webm is a three-second 48×32 VP8 test pattern generated with FFmpeg testsrc2.
  const items = new Map([
    ['photo.png', ['image/png', await readFile(new URL('magika/magika_test.png', fixtures))]],
    ['seek.webm', ['video/webm', await readFile(new URL('seek.webm', fixtures))]],
    ['notes.html', ['text/html', Buffer.from('<h1>Private DAV reading notes</h1>')]],
    ['plans/doc.pdf', ['application/pdf', await readFile(new URL('magika/magika_test.pdf', fixtures))]],
  ])
  const fileEntry = ([name, [mime, data]]) => `
    <d:response><d:href>/private/${name}</d:href>
      <d:propstat><d:prop><d:resourcetype/><d:getcontenttype>${mime}</d:getcontenttype>
      <d:getcontentlength>${data.length}</d:getcontentlength></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
  const folderEntry =
    '<d:response><d:href>/private/plans/</d:href><d:propstat><d:prop>' +
    '<d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'
  return listen(t, (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', app)
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, PROPFIND, GET, HEAD')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Depth, Content-Type, Range')
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, WWW-Authenticate')
    res.setHeader('Cache-Control', 'no-store')
    const { method, url, headers } = req
    const request = {
      method,
      url,
      auth: headers.authorization,
      range: headers.range,
      depth: headers.depth,
    }
    requests.push(request)
    if (method === 'OPTIONS') return res.writeHead(204).end()
    if (url === '/public/' && method === 'PROPFIND') {
      return res
        .writeHead(207, { 'Content-Type': 'application/xml' })
        .end('<d:multistatus xmlns:d="DAV:"/>')
    }
    if (!url.startsWith('/private/')) return res.writeHead(404).end()
    if (headers.authorization !== authorization) {
      return res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="View DAV test"' }).end()
    }
    if (method === 'PROPFIND' && ['/private/', '/private/plans/'].includes(url)) {
      const nested = url === '/private/plans/'
      const children = [...items].filter(([name]) => name.includes('/') === nested)
      const listing = children.map(fileEntry).join('') + (nested ? '' : folderEntry)
      return res
        .writeHead(207, { 'Content-Type': 'application/xml' })
        .end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">' + listing + '</d:multistatus>')
    }
    const item = items.get(url.slice('/private/'.length))
    if (!item || !['GET', 'HEAD'].includes(method)) return res.writeHead(404).end()
    const [type, file] = item
    const range = headers.range && byteRange(headers.range, file.length)
    if (headers.range && !range)
      return res.writeHead(416, { 'Content-Range': 'bytes */' + file.length }).end()
    const data = range ? file.subarray(range.start, range.end + 1) : file
    if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.length}`)
    request.status = range ? 206 : 200
    res.writeHead(request.status, {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Content-Length': data.length,
    })
    res.end(method === 'HEAD' ? undefined : data)
  })
}

async function addDav(page, name, url) {
  await page.getByRole('button', { name: '添加位置', exact: true }).click()
  const form = page.getByRole('dialog', { name: '添加位置' })
  await form.getByLabel('协议').selectOption('webdav')
  await form.getByLabel('目录地址').fill(url)
  await form.getByLabel('显示名称', { exact: false }).fill(name)
  await form.getByRole('button', { name: '添加位置' }).click()
}

test(
  'Basic WebDAV signs in per location and streams private previews through the local worker',
  { timeout: 90_000 },
  async (t) => {
    const appRequests = [],
      davRequests = []
    const app = await serveStatic(t, appRequests)
    const user = 'reader-' + randomUUID()
    const password = randomUUID()
    const token = Buffer.from(user + ':' + password).toString('base64')
    const dav = await serveDav(t, app, 'Basic ' + token, davRequests)
    const browser = await chromium.launch({ executablePath: process.env.VIEW_CHROMIUM_PATH })
    t.after(() => browser.close())
    const context = await browser.newContext()
    t.after(() => context.close())
    const page = await context.newPage()
    const urls = []
    const workerResponses = []
    context.on('request', (request) => urls.push(request.url()))
    page.on('response', (response) => {
      if (response.fromServiceWorker()) workerResponses.push(response)
    })
    await page.goto(app + '/view/')
    await addDav(page, '收藏文档', dav + '/private/')
    const login = page.getByRole('form', { name: 'WebDAV 登录' })
    async function signIn(secret) {
      await login.getByLabel('用户名').fill(user)
      await login.getByLabel('密码').fill(secret)
      await login.getByRole('button', { name: '登录', exact: true }).click()
    }
    await signIn('incorrect')
    await login.getByRole('alert').filter({ hasText: '用户名或密码有误' }).waitFor()
    await signIn(password)
    await page.getByRole('button', { name: /photo\.png/ }).click()
    assert(davRequests.some((r) => r.method === 'PROPFIND' && !r.auth))
    assert(
      davRequests.some((r) => r.method === 'PROPFIND' && r.depth === '1' && r.auth === 'Basic ' + token),
    )
    const img = page.getByRole('img', { name: 'photo.png' })
    await img.waitFor()
    assert.deepEqual(
      await img.evaluate(async (node) => {
        await node.decode()
        return [node.naturalWidth, node.naturalHeight]
      }),
      [960, 540],
    )
    assert(workerResponses.some((r) => r.status() === 200 && r.request().resourceType() === 'image'))
    const imageUrl = await img.getAttribute('src')
    assert.equal(
      await page.evaluate(async () => (await navigator.serviceWorker.ready).scope),
      app + '/view/',
    )
    const close = page.getByRole('button', { name: '关闭预览' })
    await close.click()

    await page.getByRole('button', { name: /plans/ }).click()
    await page.getByRole('button', { name: /doc\.pdf/ }).click()
    await page.getByText('第 1 / 1 页', { exact: true }).waitFor()
    await page.waitForFunction(() => {
      const canvas = document.querySelector('canvas[aria-label="第 1 页"]')
      if (!canvas) return false
      const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      return rgba.some((v, i) => i % 4 === 0 && v < 128 && rgba[i + 3] === 255)
    })
    assert(
      davRequests.some(
        (r) => r.method === 'PROPFIND' && r.url === '/private/plans/' && r.auth === 'Basic ' + token,
      ),
    )
    await close.click()
    await page.getByRole('button', { name: '返回上一级' }).click()

    await page.getByRole('button', { name: /seek\.webm/ }).click()
    const video = page.locator('video')
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2)
    await video.evaluate(
      (node) =>
        new Promise((resolve) => {
          node.addEventListener('seeked', resolve, { once: true })
          node.currentTime = 2
        }),
    )
    assert.deepEqual(
      await video.evaluate((node) => [node.videoWidth, node.videoHeight, node.currentTime]),
      [48, 32, 2],
    )
    assert(workerResponses.some((r) => r.status() === 206 && r.request().resourceType() === 'media'))
    assert(
      davRequests.some(
        (r) =>
          r.url === '/private/seek.webm' &&
          r.status === 206 &&
          r.range !== 'bytes=0-4095' &&
          r.auth === 'Basic ' + token,
      ),
    )
    await close.click()

    await page.getByRole('button', { name: /notes\.html/ }).click()
    await page.getByText('<h1>Private DAV reading notes</h1>', { exact: true }).waitFor()
    const note = workerResponses.findLast(
      (r) => r.status() === 200 && r.request().resourceType() === 'fetch',
    )
    assert(note && new URL(note.url()).origin === app)
    const headers = await note.allHeaders()
    assert.equal(headers['content-type'], 'application/octet-stream')
    assert.equal(headers['x-content-type-options'], 'nosniff')
    assert.match(headers['content-security-policy'], /sandbox/)
    await close.click()

    // A second location on the same DAV host must get its own independent session.
    await page.getByRole('button', { name: '所有位置' }).click()
    await addDav(page, '公共文档', dav + '/public/')
    await page.getByRole('heading', { name: '空文件夹' }).waitFor()
    assert(davRequests.some((r) => r.method === 'PROPFIND' && r.url === '/public/'))
    assert(davRequests.every((r) => !r.auth || r.url.startsWith('/private/')))
    assert(appRequests.every((r) => !r.auth))

    await page.reload()
    await page
      .getByRole('main')
      .getByRole('button', { name: /^收藏文档/ })
      .click()
    await login.waitFor()
    const stored = await page.evaluate(() => [
      JSON.stringify(localStorage),
      JSON.stringify(sessionStorage),
    ])
    assert(stored[0].includes('收藏文档'))
    stored.push(JSON.stringify(await context.storageState({ indexedDB: true })))
    for (const value of [
      ...stored,
      ...urls,
      ...appRequests.map((r) => r.url),
      ...davRequests.map((r) => r.url),
    ]) {
      assert(
        ![user, password, token].some((secret) => value.includes(secret)),
        'Credentials must stay out of storage and URLs',
      )
    }
    await signIn(password)
    await page.getByRole('button', { name: /photo\.png/ }).waitFor()
    assert.equal(await page.evaluate(async (url) => (await fetch(url)).status, imageUrl), 401)
    const photoUrl = await page
      .getByRole('button', { name: /photo\.png/ })
      .getAttribute('data-entry-url')
    const otherTab = await context.newPage()
    await otherTab.goto(app + '/view/')
    await otherTab
      .getByRole('main')
      .getByRole('button', { name: /^收藏文档/ })
      .click()
    const otherLogin = otherTab.getByRole('form', { name: 'WebDAV 登录' })
    await otherLogin.getByLabel('用户名').fill(user)
    await otherLogin.getByLabel('密码').fill(password)
    await otherLogin.getByRole('button', { name: '登录', exact: true }).click()
    await otherTab.getByRole('button', { name: /photo\.png/ }).waitFor()
    assert.equal(await otherTab.evaluate(async (url) => (await fetch(url)).status, photoUrl), 401)
    await otherTab.close()
    await page.getByRole('button', { name: '退出登录' }).click()
    await login.waitFor()
    assert.equal(await page.evaluate(async (url) => (await fetch(url)).status, photoUrl), 401)
  },
)
