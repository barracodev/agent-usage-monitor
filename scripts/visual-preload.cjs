const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('usageMonitor', {
  read: () => ipcRenderer.invoke('qa:read'),
  openInstall: () => Promise.resolve(),
  layout: layout => ipcRenderer.invoke('qa:layout', layout),
  waitForMotion: () => Promise.resolve(),
  move: (x, y) => ipcRenderer.invoke('qa:move', x, y),
  onUpdate: () => {},
  onGlass: () => {},
});
