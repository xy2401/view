import { app, BrowserWindow, dialog, ipcMain, net, protocol, session } from 'electron'
import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startSharing } from '../sharing/server.mjs'
import { openLibrary } from './library.mjs'
import { createAssetHandler, fileResponse } from './protocols.mjs'

const appUrl = 'view-app://app/index.html'
const preload = fileURLToPath(new URL('../preload/index.cjs', import.meta.url))
const webRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'dist')
  : fileURLToPath(new URL('../../../web/dist/', import.meta.url))
let window
let server
let serviceQueue = Promise.resolve()

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

async function initialize() {
  const library = await openLibrary(path.join(app.getPath('userData'), 'locations.json'))
  protocol.handle('view-app', createAssetHandler(webRoot, net))
  protocol.handle('view-file', (request) => fileResponse(request, library))
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
      const service = await startSharing({ webRoot, getShares: library.shares, accessKey: key })
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

  await createWindow()
  app.on('activate', () => {
    if (!window) void createWindow()
  })
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore()
    window?.focus()
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
