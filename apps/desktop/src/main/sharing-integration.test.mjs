import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openLibrary } from './library.mjs'
import { startSharing } from '../sharing/server.mjs'

test('five saved favorites and seven HTTP shares remain independent after restart', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'view-locations-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const config = path.join(dir, 'locations.json')
  const library = await openLibrary(config)
  for (const name of 'ABCDEFGHIJ') {
    const location = path.join(dir, name)
    await mkdir(location)
    const { url } = await library.select(location)
    if ('ABCDE'.includes(name)) await library.setFlag(url, 'favorite', true)
    if ('CDEFGHI'.includes(name)) await library.setFlag(url, 'shared', true)
  }
  await writeFile(path.join(dir, 'D', 'notes.txt'), 'shared')
  const restored = await openLibrary(config)
  const favorites = Object.fromEntries(restored.state().favorites.map(({ name, url }) => [name, url]))
  assert.deepEqual(Object.keys(favorites).sort(), [...'ABCDE'])

  const webRoot = path.join(dir, 'web-dist')
  await mkdir(webRoot)
  const service = await startSharing({
    webRoot,
    getShares: restored.shares,
    accessKey: 'sample-key',
    host: '127.0.0.1',
  })
  t.after(() => service.stop())
  const origin = 'http://127.0.0.1:' + service.port
  const roots = origin + '/files/'
  assert.equal((await fetch(roots)).status, 401)
  const login = await fetch(origin + '/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'sample-key' }),
  })
  assert.equal(login.status, 204)
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] }
  async function readRoots() {
    const response = await fetch(roots, { headers })
    assert.equal(response.status, 200)
    const links = (await response.text()).matchAll(/<a href="([^"]+)"[^>]*>([A-J])<\/a>/g)
    return Object.fromEntries(Array.from(links, ([, href, name]) => [name, new URL(href, roots)]))
  }
  const links = await readRoots()
  assert.deepEqual(Object.keys(links).sort(), [...'CDEFGHI'])
  const oldFile = new URL('notes.txt', links.D)
  assert.equal(await (await fetch(oldFile, { headers })).text(), 'shared')
  await restored.setFlag(favorites.C, 'favorite', false)
  assert.equal(restored.state().favorites.length, 4)
  assert.deepEqual(await readRoots(), links)
  await restored.setFlag(favorites.D, 'shared', false)
  assert.deepEqual(Object.keys(await readRoots()).sort(), [...'CEFGHI'])
  assert.deepEqual(
    restored
      .state()
      .favorites.map((p) => p.name)
      .sort(),
    [...'ABDE'],
  )
  assert.equal((await fetch(links.D, { headers })).status, 404)
  assert.equal((await fetch(oldFile, { headers: { ...headers, Range: 'bytes=0-2' } })).status, 404)
})
