const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('focky', {
  config:  ()   => ipcRenderer.invoke('config'),
  sources: ()   => ipcRenderer.invoke('sources'),
  pick:    (id) => ipcRenderer.invoke('pick', id),
})
