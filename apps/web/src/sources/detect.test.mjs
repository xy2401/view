import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyPrefix, detectKind, readPrefix } from './detect.ts'

test('recognizes signatures independently of a filename', () => {
  const cases = [
    ['\x89PNG\r\n\x1a\n', 'image'],
    ['\xff\xd8\xff\xe0', 'image'],
    ['GIF89a', 'image'],
    ['RIFF....WEBP', 'image'],
    ['%PDF-1.7\n', 'pdf'],
    ['RIFF....WAVE', 'audio'],
    ['fLaC', 'audio'],
    ['RIFF....AVI ', 'video'],
    ['PK\x03\x04', 'other'],
    ['\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00avifmif1', 'image'],
    ['\x00\x00\x00\x10ftypM4A \x00\x00\x00\x00', 'audio'],
    ['\x00\x00\x00\x10ftypisom\x00\x00\x00\x00', null],
  ]
  for (const [header, expected] of cases) {
    assert.equal(classifyPrefix(Buffer.from(header, 'latin1')), expected)
  }
  const bmp = Buffer.alloc(54)
  bmp.write('BM')
  bmp.writeUInt32LE(40, 14)
  assert.equal(classifyPrefix(bmp), 'image')
  assert.equal(classifyPrefix(Buffer.from('BM notes')), 'text')
})

test('accepts UTF-8 text, including a character split at the sample limit', () => {
  assert.equal(classifyPrefix(Buffer.from('文件浏览器\n')), 'text')
  assert.equal(classifyPrefix(Buffer.from('a'.repeat(4095) + '图')), 'text')
  assert.equal(classifyPrefix(Buffer.from([0x61, 0x00, 0x62])), null)
  assert.equal(classifyPrefix(Buffer.from([0x61, 0xfe])), null)
  assert.equal(classifyPrefix(new Uint8Array()), null)
})

test('requests the first 4 KiB and cancels a full response from a server ignoring Range', async (t) => {
  let pulls = 0
  let cancelled = false
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.headers.Range, 'bytes=0-4095')
    return new Response(
      new ReadableStream(
        {
          pull(controller) {
            pulls++
            controller.enqueue(new Uint8Array(16384).fill(65))
          },
          cancel() {
            cancelled = true
          },
        },
        { highWaterMark: 0 },
      ),
    )
  })
  const bytes = await readPrefix('https://example.test/big.txt', new AbortController().signal)
  assert.equal(bytes.length, 4096)
  assert.equal(pulls, 1)
  assert.equal(cancelled, true)
})

test('detects a falsely named partial response across chunk boundaries', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from('%PD'))
            controller.enqueue(Buffer.from('F-1.5\n'))
            controller.close()
          },
        }),
        { status: 206 },
      ),
  )
  assert.equal(await detectKind('https://example.test/trip.jpg', new AbortController().signal), 'pdf')
})

test('empty-file ranges are unknown, unauthorized reads retain their status', async (t) => {
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */0' } }),
  )
  const signal = new AbortController().signal
  assert.equal(await detectKind('https://example.test/empty', signal), null)
  fetch.mock.mockImplementation(() => Promise.resolve(new Response(null, { status: 401 })))
  await assert.rejects(readPrefix('https://example.test/private', signal), { status: 401 })
})

test('pre-aborted preview skips network access', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('unexpected fetch')
  })
  await assert.rejects(readPrefix('https://example.test/skipped', AbortSignal.abort()), {
    name: 'AbortError',
  })
  assert.equal(fetch.mock.callCount(), 0)
})
