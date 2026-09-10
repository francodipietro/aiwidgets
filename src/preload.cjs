const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiwidgets', {
  read: () => ipcRenderer.invoke('usage:read'),
  saveEnabledProviders: (providerIds) => ipcRenderer.invoke('providers:save-enabled', providerIds),
  collectorInfo: () => ipcRenderer.invoke('collector:info'),
  openProvider: (providerId, source) => ipcRenderer.invoke('collector:open', providerId, source),
  refreshProviders: () => ipcRenderer.invoke('collector:refresh'),
  resizeControl: (height) => ipcRenderer.send('window:resize-control', height),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),
  onUsageChanged: (callback) => ipcRenderer.on('usage:changed', callback),
  onCollectorChanged: (callback) => ipcRenderer.on('collector:changed', callback)
});
