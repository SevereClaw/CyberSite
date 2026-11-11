const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('cs', {
  get: () => ipcRenderer.invoke('get'),
  save: cfg => ipcRenderer.invoke('save', cfg),
  importConfig: file => ipcRenderer.invoke('import', file),
  exportConfig: () => ipcRenderer.invoke('export'),
  restart: () => ipcRenderer.invoke('restart'),
  open: url => ipcRenderer.invoke('open', url),
  openData: () => ipcRenderer.invoke('openData'),
  win: a => ipcRenderer.invoke('win', a),
  installUpdate: () => ipcRenderer.invoke('installUpdate'),
  pathOf: file => (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : file.path),
  onState: cb => ipcRenderer.on('state', (_e, s) => cb(s)),
  onLog: cb => ipcRenderer.on('log', (_e, l) => cb(l)),
});
