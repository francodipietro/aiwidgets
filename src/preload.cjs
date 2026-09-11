const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiwidgets', {
  read: () => ipcRenderer.invoke('usage:read'),
  saveEnabledProviders: (providerIds, completeOnboarding = false) => ipcRenderer.invoke('providers:save-enabled', providerIds, completeOnboarding),
  collectorInfo: () => ipcRenderer.invoke('collector:info'),
  openProvider: (providerId, source) => ipcRenderer.invoke('collector:open', providerId, source),
  refreshProviders: () => ipcRenderer.invoke('collector:refresh'),
  refreshProvider: (providerId) => ipcRenderer.invoke('collector:refresh-provider', providerId),
  disconnectProvider: (providerId, clearUsage) => ipcRenderer.invoke('collector:disconnect', providerId, clearUsage),
  resetOnboarding: (clearUsage) => ipcRenderer.invoke('onboarding:reset', clearUsage),
  resizeControl: (height) => ipcRenderer.send('window:resize-control', height),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),
  onUsageChanged: (callback) => ipcRenderer.on('usage:changed', callback),
  onCollectorChanged: (callback) => ipcRenderer.on('collector:changed', callback)
});
