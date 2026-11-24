import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startSharing } from '../../apps/desktop/src/sharing/server.mjs'

test('a native file opens independently of its delayed or unreadable parent directory', async (t) => {
  const server = await startSharing({
    host: '127.0.0.1',
    webRoot: fileURLToPath(new URL('../../apps/web/dist/', import.meta.url)),
    getShares: () => [],
    accessKey: randomUUID(),
  })
  t.after(() => server.stop())
  const browser = await chromium.launch({ executablePath: process.env.VIEW_CHROMIUM_PATH })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.route('**/native-file/note.txt', (route) =>
    route.fulfill({
      contentType: 'text/plain',
      body: 'A readable document.',
    }),
  )
  await page.addInitScript(() => {
    const folder = { name: 'Documents', url: 'view-file://test/' }
    const file = { name: 'note.txt', url: location.origin + '/native-file/note.txt', directory: false }
    const initial = [{ folder, file }]
    window.viewDesktop = {
      state: async () => ({ favorites: [], shares: [], server: null }),
      takeOpenTarget: async () => initial.shift() ?? null,
      onOpenTarget: () => () => {},
      openFile: async () => ({ folder, file }),
      list: () =>
        new Promise((resolve, reject) => {
          window.finishListing = (allowed) => {
            delete window.finishListing
            if (allowed) resolve([file])
            else reject(new Error('Directory listing denied'))
          }
        }),
    }
  })
  await page.goto('http://127.0.0.1:' + server.port)
  const viewer = page.getByRole('dialog', { name: '预览 note.txt' })
  const contents = viewer.getByText('A readable document.')
  await contents.waitFor()
  await page.keyboard.press('Escape')
  await viewer.waitFor({ state: 'hidden' })

  // Completing the cold-start listing must focus the file without reopening the preview.
  await page.evaluate(() => window.finishListing(true))
  await page.waitForFunction(() => document.activeElement?.matches('button.entry-row.selected'))
  assert.equal(await viewer.count(), 0)
  assert.match(await page.locator('button.entry-row.selected').textContent(), /note\.txt/)

  await page.getByRole('button', { name: '打开文件', exact: true }).click()
  await contents.waitFor()
  await page.evaluate(() => window.finishListing(false))
  await page.locator('.empty-state').getByText('Directory listing denied').waitFor()
  assert(await contents.isVisible())
  await page.keyboard.press('Escape')
  await page.getByRole('heading', { name: '无法读取目录' }).waitFor()
})
