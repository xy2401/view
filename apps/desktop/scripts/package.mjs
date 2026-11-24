import { chmod, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packager } from '@electron/packager'

const require = createRequire(import.meta.url)
const { version: electronVersion } = require('electron/package.json')
const desktopDir = fileURLToPath(new URL('../', import.meta.url))
const webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url))
const outputDir = fileURLToPath(new URL('../../../dist/desktop/', import.meta.url))
const stage = await mkdtemp(join(tmpdir(), 'view-package-'))

try {
  // Deploy the locked production graph for the host, including sharp's optional
  // platform binary and libvips. A hoisted stage packages cleanly on Windows too.
  const cli = process.env.npm_execpath ?? 'pnpm'
  const args = [
    '--filter',
    '@view/desktop',
    '--config.inject-workspace-packages=true',
    '--config.node-linker=hoisted',
    'deploy',
    '--prod',
    stage,
  ]
  const jsCli = /\.[cm]?js$/i.test(cli)
  execFileSync(jsCli ? process.execPath : cli, jsCli ? [cli, ...args] : args, {
    cwd: desktopDir,
    stdio: 'inherit',
  })
  const manifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'))
  manifest.name = 'view'
  delete manifest.scripts
  await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2))
  const paths = await packager({
    dir: stage,
    out: outputDir,
    name: 'View',
    electronVersion,
    appBundleId: 'io.github.xy2401.view',
    extendInfo: {
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'View documents and media',
          CFBundleTypeRole: 'Viewer',
          LSHandlerRank: 'Alternate',
          LSItemContentTypes: [
            'public.image',
            'public.movie',
            'public.audio',
            'public.text',
            'com.adobe.pdf',
            'public.data',
          ],
        },
      ],
    },
    // The HTTP server streams the same web assets through ordinary file descriptors.
    extraResource: webDist,
    // Native addons and their adjacent dynamic libraries must be real files.
    asar: false,
    ignore: [/^\/pnpm-(lock|workspace)\.yaml$/, /^\/node_modules\/\./],
    // The electron install script and Packager use the same @electron/get cache.
    download: { cacheRoot: process.env.electron_config_cache },
    overwrite: true,
    prune: false,
  })
  for (const path of paths) {
    if (process.platform === 'linux') {
      const installer = join(path, 'install-open-with.sh')
      await cp(join(desktopDir, 'scripts', 'install-open-with.sh'), installer)
      await chmod(installer, 0o755)
    }
    console.log(path)
  }
} finally {
  await rm(stage, { recursive: true, force: true })
}
