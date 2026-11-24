import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { filesFromArgv } from './open-files.mjs'

const cwd = path.join(tmpdir(), 'view-launch-test')

test('packaged launches resolve user files against the calling process directory', () => {
  assert.deepEqual(
    filesFromArgv(['View', 'photo #1.jpg', '--lang=en-US', '--', '-another.png'], cwd, false),
    [path.join(cwd, 'photo #1.jpg'), path.join(cwd, '-another.png')],
  )
})

test('development launches skip the app entry and Chromium switch values', () => {
  const sample = path.join(cwd, '旅 行 1.png')
  assert.deepEqual(
    filesFromArgv(
      ['electron', '--user-data-dir', '/tmp/view-profile', '.', pathToFileURL(sample).href, '旅 行 1.png'],
      cwd,
      true,
    ),
    [sample],
  )
  assert.deepEqual(filesFromArgv(['electron', '--headless', './bootstrap.cjs'], cwd, true), [])
})
