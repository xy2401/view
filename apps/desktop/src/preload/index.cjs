const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('viewDesktop', {
  state: () => ipcRenderer.invoke('view:state'),
  openFolder: () => ipcRenderer.invoke('view:openFolder'),
  list: (url) => ipcRenderer.invoke('view:list', url),
  setFavorite: (url, value) => ipcRenderer.invoke('view:setFavorite', url, value),
  setShared: (url, value) => ipcRenderer.invoke('view:setShared', url, value),
  startServer: () => ipcRenderer.invoke('view:startServer'),
  stopServer: () => ipcRenderer.invoke('view:stopServer'),
  pairingUrl: () => ipcRenderer.invoke('view:pairingUrl'),
})
