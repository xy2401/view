import assert from 'node:assert/strict'
import test from 'node:test'
import { readMagikaSample } from './magikaSample.ts'

const url = 'http://view.test/files/photos/mystery'
const signal = () => new AbortController().signal

function contents(size) {
  return Uint8Array.from({ length: size }, (_, index) => (index * 17 + Math.floor(index / 256)) % 251)
}

function rangeResponse(bytes, range, headers = {}) {
  const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range)
  const from = Number(start)
  const to = Math.min(Number(end), bytes.length - 1)
  if (from > to)
    return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + bytes.length } })
  return new Response(bytes.slice(from, to + 1), {
    status: 206,
    headers: { 'Content-Range': `bytes ${from}-${to}/${bytes.length}`, ...headers },
  })
}

test('a range-capable service supplies the exact two model windows', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch')
  for (const size of [0, 1, 4095, 4096, 4097, 8191, 8192, 8193, 260_017]) {
    const bytes = contents(size)
    const requested = []
    mock.mock.mockImplementation(async (input, options) => {
      assert.equal(input, url)
      assert.ok(options.signal)
      const range = options.headers.Range
      requested.push(range)
      return rangeResponse(bytes, range)
    })
    const sample = await readMagikaSample(url, signal())
    const expected =
      size <= 8192 ? bytes : Uint8Array.from([...bytes.slice(0, 4096), ...bytes.slice(-4096)])
    assert.deepEqual(sample, expected)
    assert.deepEqual(
      requested,
      size <= 4096
        ? ['bytes=0-4095']
        : ['bytes=0-4095', `bytes=${Math.max(4096, size - 4096)}-${size - 1}`],
    )
  }
})

test('an ordinary 200 is read only through the maximum complete-file size', async (t) => {
  const small = contents(8192)
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response(small))
  assert.deepEqual(await readMagikaSample(url, signal()), small)

  let consumed = 0
  let cancelled = false
  mock.mock.mockImplementation(
    async () =>
      new Response(
        new ReadableStream({
          type: 'bytes',
          pull(controller) {
            const view = controller.byobRequest.view
            const count = Math.min(view.byteLength, 2048)
            consumed += count
            controller.byobRequest.respond(count)
          },
          cancel() {
            cancelled = true
          },
        }),
      ),
  )
  await assert.rejects(readMagikaSample(url, signal()), /超过取样上限/)
  assert.equal(cancelled, true)
  assert.equal(consumed, 8193)
})

test('CORS responses with hidden Content-Range use full length from HEAD', async (t) => {
  const bytes = contents(64_027)
  const calls = []
  const mock = t.mock.method(globalThis, 'fetch', async (_input, options) => {
    if (options.method === 'HEAD') {
      calls.push('HEAD')
      return new Response(null, { headers: { 'Content-Length': String(bytes.length) } })
    }
    calls.push(options.headers.Range)
    const response = rangeResponse(bytes, options.headers.Range)
    response.headers.delete('Content-Range')
    Object.defineProperty(response, 'type', { value: 'cors' })
    return response
  })
  assert.deepEqual(
    await readMagikaSample(url, signal()),
    Uint8Array.from([...bytes.slice(0, 4096), ...bytes.slice(-4096)]),
  )
  assert.deepEqual(calls, ['bytes=0-4095', 'HEAD', 'bytes=59931-64026'])

  mock.mock.mockImplementation(async (_input, options) => {
    if (options.method === 'HEAD') return new Response(null, { status: 405 })
    if (!options.headers) return new Response(contents(5678))
    const response = rangeResponse(contents(5678), options.headers.Range)
    response.headers.delete('Content-Range')
    Object.defineProperty(response, 'type', { value: 'cors' })
    return response
  })
  assert.deepEqual(await readMagikaSample(url, signal()), contents(5678))
})

test('invalid lengths, mismatched range positions, file changes and auth failures do not reach inference', async (t) => {
  const bytes = contents(10000)
  const wrongTailResponses = [
    () => rangeResponse(bytes, 'bytes=0-4095'),
    () =>
      new Response(new Uint8Array(4095), {
        status: 206,
        headers: { 'Content-Range': 'bytes 5904-9999/10000' },
      }),
    () => rangeResponse(bytes, 'bytes=5904-9999', { ETag: '"new"' }),
    () => rangeResponse(bytes, 'bytes=5904-9999', { 'Content-Range': 'bytes 5904-9999/12345' }),
    () => rangeResponse(bytes, 'bytes=5904-9999', { 'Content-Length': '4097' }),
    () => new Response(bytes),
  ]
  const mock = t.mock.method(globalThis, 'fetch')
  for (const wrongTail of wrongTailResponses) {
    mock.mock.mockImplementation(async (_input, opts) =>
      opts.headers.Range === 'bytes=0-4095'
        ? rangeResponse(bytes, opts.headers.Range, { ETag: '"old"' })
        : wrongTail(),
    )
    await assert.rejects(readMagikaSample(url, signal()))
  }
  mock.mock.mockImplementation(async () => new Response(null, { status: 401 }))
  await assert.rejects(readMagikaSample(url, signal()), { status: 401 })
})

test('the unread response is cancelled before retrying a complete small file', async (t) => {
  for (const status of [206, 416]) {
    let released = false
    const mock = t.mock.method(globalThis, 'fetch', async (_input, options) => {
      if (options.headers?.Range) {
        return new Response(
          new ReadableStream({
            cancel() {
              released = true
            },
          }),
          { status },
        )
      }
      assert.equal(released, true)
      return new Response(contents(200))
    })
    assert.deepEqual(await readMagikaSample(url, signal()), contents(200))
    mock.mock.restore()
  }
})

test('aborts release the underlying stream and do not return partial bytes', async (t) => {
  const controller = new AbortController()
  let cancelled = false
  const mock = t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          pull() {
            setTimeout(() => controller.abort(), 0)
          },
          cancel() {
            cancelled = true
          },
        }),
      ),
  )
  await assert.rejects(readMagikaSample(url, controller.signal), { name: 'AbortError' })
  assert.equal(cancelled, true)
  await assert.rejects(readMagikaSample(url, controller.signal), { name: 'AbortError' })
  assert.equal(mock.mock.callCount(), 1)
})
