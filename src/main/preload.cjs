const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usageMonitor', Object.freeze({
  read: force => ipcRenderer.invoke('monitor:read', force === true),
  openInstall: provider => ipcRenderer.invoke('monitor:open-install', provider),
  layout: layout => ipcRenderer.invoke('monitor:layout', layout),
  waitForMotion: () => ipcRenderer.invoke('monitor:motion'),
  move: (x, y) => ipcRenderer.invoke('monitor:move', x, y),
  onUpdate: listener => { ipcRenderer.on('monitor:update', (_event, data) => listener(data)); },
  onGlass: listener => { ipcRenderer.on('monitor:glass', (_event, contrast) => listener(contrast)); },
}));
