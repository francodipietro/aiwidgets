const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopWidgets', {
  state: () => ipcRenderer.invoke('desktop-widget:state'),
  refresh: () => ipcRenderer.invoke('desktop-widget:refresh'),
  toggleVisible: () => ipcRenderer.invoke('desktop-widget:toggle-visible'),
  setEditing: (editing) => ipcRenderer.invoke('desktop-widget:set-editing', editing),
  anchor: () => ipcRenderer.invoke('desktop-widget:anchor'),
  resize: (delta) => ipcRenderer.invoke('desktop-widget:resize', delta),
  resizePanel: (height) => ipcRenderer.send('desktop-widget:resize-panel', height),
  openSettings: () => ipcRenderer.invoke('desktop-widget:open-settings'),
  exit: () => ipcRenderer.invoke('desktop-widget:exit'),
  onState: (callback) => ipcRenderer.on('desktop-widget:state', (_event, state) => callback(state)),
});
