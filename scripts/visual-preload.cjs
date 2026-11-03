const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('usageMonitor', {
  read: () => ipcRenderer.invoke('qa:read'),
  openInstall: () => Promise.resolve(),
  layout: layout => ipcRenderer.invoke('qa:layout', layout),
  waitForMotion: () => ipcRenderer.invoke('qa:motion'),
  frame: (id, progress, complete) => ipcRenderer.send('qa:frame', id, progress, complete),
  hitTest: interactive => ipcRenderer.invoke('qa:hit-test', interactive),
  onSurface: listener => ipcRenderer.on('monitor:surface', (_event, motion) => listener(motion)),
  move: (x, y) => ipcRenderer.invoke('qa:move', x, y),
  onUpdate: listener => ipcRenderer.on('qa:update', (_event, data) => listener(data)),
  onGlass: listener => ipcRenderer.on('qa:glass', (_event, contrast) => listener(contrast)),
});
