'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('st:get'),
  set: (s) => ipcRenderer.invoke('st:set', s),
  test: (s) => ipcRenderer.invoke('st:test', s),
  checkUpdate: () => ipcRenderer.invoke('st:check-update'),
});
