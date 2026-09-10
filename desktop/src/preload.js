const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('beam', {
  getState: () => ipcRenderer.invoke('beam:getState'),
  openFile: (p) => ipcRenderer.send('beam:openFile', p),
  openFolder: () => ipcRenderer.send('beam:openFolder'),
  onTransferStart: (cb) => ipcRenderer.on('transfer:start', (_e, d) => cb(d)),
  onTransferProgress: (cb) => ipcRenderer.on('transfer:progress', (_e, d) => cb(d)),
  onTransferDone: (cb) => ipcRenderer.on('transfer:done', (_e, d) => cb(d)),
  onTransferError: (cb) => ipcRenderer.on('transfer:error', (_e, d) => cb(d)),
  // Electron 33 removed File.path; this is the supported replacement.
  pathForFile: (file) => webUtils.getPathForFile(file),
  startDrag: (paths) => ipcRenderer.send('drag:start', paths),
  listLocal: (dirPath) => ipcRenderer.invoke('local:listDir', dirPath),
  thumb: (filePath, size) => ipcRenderer.invoke('local:thumb', filePath, size),
  onApprovalPending: (cb) => ipcRenderer.on('approval:pending', (_e, d) => cb(d)),
  onApprovalResolved: (cb) => ipcRenderer.on('approval:resolved', (_e, d) => cb(d)),
  onApprovalAuto: (cb) => ipcRenderer.on('approval:auto', (_e, d) => cb(d)),
  history: () => ipcRenderer.invoke('history:list'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
});

contextBridge.exposeInMainWorld('cable', {
  listDevices: () => ipcRenderer.invoke('cable:listDevices'),
  listDir: (device, dirPath) => ipcRenderer.invoke('cable:listDir', device, dirPath),
  index: (device) => ipcRenderer.invoke('cable:index', device),
  copy: (device, items) => ipcRenderer.invoke('cable:copy', device, items),
  push: (device, localPaths, remoteDir) =>
    ipcRenderer.invoke('cable:push', device, localPaths, remoteDir),
  prepareDrag: (device, item) => ipcRenderer.invoke('cable:prepareDrag', device, item),
  mkdir: (device, parentPath, name) =>
    ipcRenderer.invoke('cable:mkdir', device, parentPath, name),
  rename: (device, item, newName) =>
    ipcRenderer.invoke('cable:rename', device, item, newName),
  move: (device, items, destDir) =>
    ipcRenderer.invoke('cable:move', device, items, destDir),
  remove: (device, items) => ipcRenderer.invoke('cable:delete', device, items),
  onProgress: (cb) => ipcRenderer.on('cable:progress', (_e, d) => cb(d)),
});

contextBridge.exposeInMainWorld('wifi', {
  scan: () => ipcRenderer.invoke('wifi:scan'),
  connect: (address) => ipcRenderer.invoke('wifi:connect', address),
  known: () => ipcRenderer.invoke('wifi:known'),
  forget: (key) => ipcRenderer.invoke('wifi:forget', key),
  onFound: (cb) => ipcRenderer.on('wifi:found', (_e, d) => cb(d)),
  send: (device, localPaths) => ipcRenderer.invoke('wifi:send', device, localPaths),
  onProgress: (cb) => ipcRenderer.on('wifi:progress', (_e, d) => cb(d)),
});
