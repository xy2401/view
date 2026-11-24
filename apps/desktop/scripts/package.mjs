import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packager } from '@electron/packager'

const require = createRequire(import.meta.url)
const { version: electronVersion } = require('electron/package.json')
const desktopDir = fileURLToPath(new URL('../', import.meta.url))
const webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url))
const outputDir = fileURLToPath(new URL('../../../dist/desktop/', import.meta.url))
const { version } = JSON.parse(await readFile(join(desktopDir, 'package.json'), 'utf8'))
const stage = await mkdtemp(join(tmpdir(), 'view-package-'))

function isRuntimeSource(path) {
  const name = basename(path)
  return !['test', 'tests', '__tests__'].includes(name) && !/\.(test|spec)\.[^.]+$/.test(name)
}

try {
  const manifest = {
    name: 'view',
    productName: 'View',
    version,
    private: true,
    main: 'src/main/index.mjs',
  }
  await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2))
  for (const name of ['main', 'sharing', 'preload']) {
    await cp(join(desktopDir, 'src', name), join(stage, 'src', name), {
      recursive: true,
      filter: isRuntimeSource,
    })
  }
  const paths = await packager({
    dir: stage,
    out: outputDir,
    name: 'View',
    electronVersion,
    // The HTTP server streams the same web assets through ordinary file descriptors.
    extraResource: webDist,
    // The electron install script and Packager use the same @electron/get cache.
    download: { cacheRoot: process.env.electron_config_cache },
    overwrite: true,
    prune: false,
  })
  for (const path of paths) console.log(path)
} finally {
  await rm(stage, { recursive: true, force: true })
}
