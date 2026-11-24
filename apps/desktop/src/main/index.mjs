import { app, BrowserWindow, dialog, ipcMain, net, protocol, session } from 'electron'
import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startSharing } from '../sharing/server.mjs'
import { openLibrary } from './library.mjs'
import { filesFromArgv } from './open-files.mjs'
import { createAssetHandler, fileResponse } from './protocols.mjs'
import { createThumbnailCache } from './thumbnail-cache.mjs'

const appUrl = 'view-app://app/index.html'
const preload = fileURLToPath(new URL('../preload/index.cjs', import.meta.url))
const webRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'dist')
  : fileURLToPath(new URL('../../../web/dist/', import.meta.url))
let window
let server
let serviceQueue = Promise.resolve()
const pendingFiles = []
let windowReady = false

function focusWindow() {
  if (!windowReady) return
  if (window) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  } else {
    void createWindow()
  }
}

function queueOpenFiles(files) {
  for (const file of files) {
    if (typeof file === 'string' && path.isAbsolute(file) && !pendingFiles.includes(file)) {
      pendingFiles.push(file)
    }
  }
  focusWindow()
  if (pendingFiles.length && window) window.webContents.send('view:openTarget')
}

// Finder can deliver the initial document before the application is ready.
app.on('open-file', (event, filename) => {
  event.preventDefault()
  queueOpenFiles([filename])
})

protocol.registerSchemesAsPrivileged(
  ['view-app', 'view-file'].map((scheme) => ({
    scheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  })),
)

function queueService(operation) {
  const result = serviceQueue.then(operation)
  serviceQueue = result.catch(() => {})
  return result
}

function lanAddress() {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((item) => item && !item.internal && item.family === 'IPv4')
  return (
    (
      addresses.find((item) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)) ??
      addresses[0]
    )?.address ?? '127.0.0.1'
  )
}

function createWindow() {
  window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 620,
    minHeight: 440,
    title: 'View',
    backgroundColor: '#fbfaf7',
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.on('closed', () => {
    window = null
  })
  return window.loadURL(appUrl)
}

function thumbnailDirectory() {
  const home = app.getPath('home')
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'View', 'thumbnails')
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    return path.join(local, 'View', 'Cache', 'thumbnails')
  }
  const cache = process.env.XDG_CACHE_HOME
  return path.join(
    cache && path.isAbsolute(cache) ? cache : path.join(home, '.cache'),
    'View',
    'thumbnails',
  )
}

async function initialize() {
  const thumbnailCacheDirectory = thumbnailDirectory()
  const thumbnails = createThumbnailCache({
    directory: thumbnailCacheDirectory,
    generate: async (filename) => (await import('./render-thumbnail.mjs')).renderThumbnail(filename),
  })
  app.once('will-quit', () => thumbnails.close())
  const library = await openLibrary(path.join(app.getPath('userData'), 'locations.json'), {
    onThumbnailRootRemoved: (root) => thumbnails.discardRoot(root),
  })
  function getThumbnail(filename, signal) {
    const root = library.thumbnailRoot(filename)
    return root ? thumbnails.get(root, filename, signal) : null
  }
  protocol.handle('view-app', createAssetHandler(webRoot, net))
  protocol.handle('view-file', (request) => fileResponse(request, library, getThumbnail))
  function allowsUiPermission(contents, permission, url) {
    return (
      contents === window?.webContents &&
      typeof url === 'string' &&
      (url === 'view-app://app' || url.startsWith('view-app://app/')) &&
      ['clipboard-sanitized-write', 'fullscreen'].includes(permission)
    )
  }
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(details.isMainFrame && allowsUiPermission(contents, permission, details.requestingUrl)),
  )
  session.defaultSession.setPermissionCheckHandler(allowsUiPermission)

  function register(name, fn) {
    ipcMain.handle('view:' + name, (event, ...args) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url.split(/[?#]/)[0] !== appUrl
      )
        throw new Error('此页面无权调用桌面操作')
      return fn(...args)
    })
  }

  register('state', () => ({ ...library.state(), server: server?.info ?? null }))
  register('openFile', async () => {
    const result = await dialog.showOpenDialog(window, { title: '打开文件', properties: ['openFile'] })
    return result.canceled || !result.filePaths.length ? null : library.openFile(result.filePaths[0])
  })
  register('nativeDrop', (filename) => queueOpenFiles([filename]))
  register('takeOpenTarget', async () => {
    let unavailable
    while (pendingFiles.length) {
      const filename = pendingFiles.shift()
      try {
        return await library.openFile(filename)
      } catch {
        unavailable = path.basename(filename)
      }
    }
    if (unavailable) throw new Error('无法打开文件：' + unavailable)
    return null
  })
  register('openFolder', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '打开文件夹',
      properties: ['openDirectory'],
    })
    return result.canceled || !result.filePaths.length ? null : library.select(result.filePaths[0])
  })
  register('list', (url) => library.list(url))
  register('setFavorite', (url, value) => library.setFlag(url, 'favorite', value))
  register('setShared', (url, value) => library.setFlag(url, 'shared', value))
  register('startServer', () =>
    queueService(async () => {
      if (server) return
      const key = randomBytes(12).toString('base64url')
      const service = await startSharing({
        webRoot,
        getShares: library.shares,
        accessKey: key,
        thumbnailCacheDirectory,
        getThumbnail: (filename, _shareRoot, signal) => getThumbnail(filename, signal),
      })
      server = { service, info: { url: 'http://' + lanAddress() + ':' + service.port + '/', key } }
    }),
  )
  register('stopServer', () =>
    queueService(async () => {
      if (!server) return
      await server.service.stop()
      server = null
    }),
  )
  register('pairingUrl', () => {
    if (!server) throw new Error('请先启动共享服务')
    return server.info.url + '#pair=' + encodeURIComponent(server.service.createPairingToken())
  })

  windowReady = true
  await createWindow()
  app.on('activate', focusWindow)
}

const launchFiles = filesFromArgv(process.argv, process.cwd(), process.defaultApp)
if (app.requestSingleInstanceLock({ files: launchFiles })) {
  queueOpenFiles(launchFiles)
  app.on('second-instance', (_event, argv, cwd, data) => {
    // Chromium can reorder argv for forwarded instances. Prefer the paths
    // the second process already resolved relative to its own working directory.
    queueOpenFiles(
      Array.isArray(data?.files) ? data.files : filesFromArgv(argv, cwd, process.defaultApp),
    )
  })
  app
    .whenReady()
    .then(initialize)
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
} else {
  app.quit()
}
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('will-quit', () => {
  void server?.service.stop()
})
