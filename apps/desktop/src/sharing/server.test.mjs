import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { startSharing } from './server.mjs'

test('browse the authenticated virtual root and revoke access to an existing file URL', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'view-sharing-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const webRoot = path.join(directory, 'web')
  const photoRoot = path.join(directory, 'photos')
  const folder = path.join(photoRoot, '旅行 合照')
  await Promise.all([mkdir(webRoot), mkdir(folder, { recursive: true })])
  await Promise.all([
    writeFile(path.join(webRoot, 'index.html'), '<title>View</title>'),
    writeFile(path.join(folder, 'index.html'), '<title>File</title>'),
    writeFile(path.join(folder, 'film.mp4'), '0123456789'),
    writeFile(path.join(folder, 'empty.txt'), ''),
  ])
  let shares = [{ id: 'root-a', name: 'A & B', path: photoRoot }]
  const key = 'a-test-key'
  const server = await startSharing({
    webRoot,
    getShares: () => shares,
    accessKey: key,
    host: '127.0.0.1',
  })
  t.after(() => server.stop())
  const url = 'http://127.0.0.1:' + server.port
  const login = (data) =>
    fetch(url + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  assert.match(await (await fetch(url)).text(), /<title>View<\/title>/)
  assert.deepEqual(await (await fetch(url + '/view-runtime.json')).json(), { mode: 'hosted' })
  const album = '/files/root-a/' + encodeURIComponent('旅行 合照') + '/'
  const movie = album + 'film.mp4'
  assert.equal((await fetch(url + '/files/')).status, 401)
  assert.equal((await fetch(url + movie)).status, 401)
  assert.equal((await login({ key: 'wrong' })).status, 401)
  const loginResponse = await login({ key })
  assert.equal(loginResponse.status, 204)
  const cookieHeader = loginResponse.headers.get('set-cookie')
  assert.match(cookieHeader, /HttpOnly/)
  const cookie = cookieHeader.split(';')[0]
  const read = (resource, options = {}) =>
    fetch(url + resource, {
      ...options,
      headers: { Cookie: cookie, ...options.headers },
    })
  const index = await read('/files/')
  const virtualRoot = await index.text()
  assert.match(virtualRoot, /href="root-a\/"/)
  assert.match(virtualRoot, /A &amp; B/)
  assert.equal(index.headers.get('cache-control'), 'no-store')
  const firstDirectory = await (await read('/files/root-a/')).text()
  assert.ok(firstDirectory.includes('href="' + encodeURIComponent('旅行 合照') + '/"'))
  const listing = await (await read(album)).text()
  assert.match(listing, /href="index.html"/)
  const document = await read(album + 'index.html')
  assert.equal(document.headers.get('content-disposition'), 'attachment')
  assert.equal(await document.text(), '<title>File</title>')
  const range = await read(movie, { headers: { Range: 'bytes=3-6' } })
  assert.equal(range.status, 206)
  assert.equal(range.headers.get('content-range'), 'bytes 3-6/10')
  assert.equal(range.headers.get('content-type'), 'video/mp4')
  assert.equal(await range.text(), '3456')
  assert.equal(await (await read(movie, { headers: { Range: 'bytes=-2' } })).text(), '89')
  const head = await read(movie, { method: 'HEAD' })
  assert.equal(head.headers.get('content-length'), '10')
  assert.equal(await head.text(), '')
  const badRange = await read(movie, { headers: { Range: 'bytes=10-' } })
  assert.equal(badRange.status, 416)
  assert.equal(badRange.headers.get('content-range'), 'bytes */10')
  assert.equal(await (await read(album + 'empty.txt')).text(), '')

  if (process.platform !== 'win32') {
    await symlink(path.join(webRoot, 'index.html'), path.join(folder, 'outside.html'))
    assert.doesNotMatch(await (await read(album)).text(), /outside.html/)
    assert.equal((await read(album + 'outside.html')).status, 404)
  }

  shares = []
  assert.doesNotMatch(await (await read('/files/')).text(), /root-a/)
  for (const resource of [album, movie]) assert.equal((await read(resource)).status, 404)
  assert.equal((await read(movie, { headers: { Range: 'bytes=3-' } })).status, 404)
  const pairingToken = server.createPairingToken()
  assert.equal((await login({ pairingToken })).status, 204)
  assert.equal((await login({ pairingToken })).status, 401)
})
