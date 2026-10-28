const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('get-settings'),
  set: (s) => ipcRenderer.invoke('set-settings', s),
});
