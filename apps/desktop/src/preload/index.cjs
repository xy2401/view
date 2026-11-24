const { contextBridge, ipcRenderer, webUtils } = require('electron')

// Keep native paths inside the isolated preload. A synthetic renderer event
// or JavaScript-created File must never grant access to a directory.
window.addEventListener(
  'dragover',
  (event) => {
    if (event.isTrusted && event.dataTransfer?.types.includes('Files')) event.preventDefault()
  },
  true,
)
window.addEventListener(
  'drop',
  (event) => {
    if (!event.isTrusted || !event.dataTransfer?.files.length) return
    event.preventDefault()
    const path = webUtils.getPathForFile(event.dataTransfer.files[0])
    if (path) void ipcRenderer.invoke('view:nativeDrop', path).catch(console.error)
  },
  true,
)

contextBridge.exposeInMainWorld('viewDesktop', {
  state: () => ipcRenderer.invoke('view:state'),
  openFile: () => ipcRenderer.invoke('view:openFile'),
  takeOpenTarget: () => ipcRenderer.invoke('view:takeOpenTarget'),
  onOpenTarget(callback) {
    const notify = () => callback()
    ipcRenderer.on('view:openTarget', notify)
    return () => ipcRenderer.removeListener('view:openTarget', notify)
  },
  openFolder: () => ipcRenderer.invoke('view:openFolder'),
  list: (url) => ipcRenderer.invoke('view:list', url),
  setFavorite: (url, value) => ipcRenderer.invoke('view:setFavorite', url, value),
  setShared: (url, value) => ipcRenderer.invoke('view:setShared', url, value),
  startServer: () => ipcRenderer.invoke('view:startServer'),
  stopServer: () => ipcRenderer.invoke('view:stopServer'),
  pairingUrl: () => ipcRenderer.invoke('view:pairingUrl'),
})
