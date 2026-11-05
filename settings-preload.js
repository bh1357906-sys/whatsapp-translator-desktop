'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('st:get'),
  set: (s) => ipcRenderer.invoke('st:set', s),
  test: (s) => ipcRenderer.invoke('st:test', s),
  testStt: (s) => ipcRenderer.invoke('st:test-stt', s),
  testTts: (s) => ipcRenderer.invoke('st:test-tts', s),
  checkUpdate: () => ipcRenderer.invoke('st:check-update'),
  testApiProxy: (p) => ipcRenderer.invoke('st:test-api-proxy', p),
  clearCache: () => ipcRenderer.invoke('st:clear-cache'),
});
