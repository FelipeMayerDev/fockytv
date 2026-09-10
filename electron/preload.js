const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('focky', {
  config:  ()   => ipcRenderer.invoke('config'),
  sources: ()   => ipcRenderer.invoke('sources'),
  pick:    (id) => ipcRenderer.invoke('pick', id),
  audioStart: o => ipcRenderer.invoke('audio-start', o),
  audioStop:  () => ipcRenderer.invoke('audio-stop'),
  onAudioMeta: fn => ipcRenderer.on('audio-meta', (_e, m) => fn(m)),
  onAudioPcm:  fn => ipcRenderer.on('audio-pcm', (_e, buf) => fn(buf)),
  onUpdate: fn => ipcRenderer.on('update', (_e, info) => fn(info)),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  rpc: a => ipcRenderer.invoke('rpc', a),
})
