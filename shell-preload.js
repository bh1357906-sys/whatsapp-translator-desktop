'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shellApi', {
  getState: () => ipcRenderer.invoke('acc:state'),
  onState: (fn) => ipcRenderer.on('acc:state', (e, s) => fn(s)),
  switchTo: (id) => ipcRenderer.invoke('acc:switch', id),
  add: (data) => ipcRenderer.invoke('acc:add', data),
  update: (id, data) => ipcRenderer.invoke('acc:update', { id, ...data }),
  remove: (id) => ipcRenderer.invoke('acc:remove', id),
  move: (id, delta) => ipcRenderer.invoke('acc:move', { id, delta }),
  reload: (id) => ipcRenderer.invoke('acc:reload', id),
  setOverlay: (on) => ipcRenderer.invoke('acc:overlay', !!on),
  testProxy: (proxy, accountId) => ipcRenderer.invoke('acc:test-proxy', { proxy, accountId }),
  parseProxy: (text, defaultType) => ipcRenderer.invoke('acc:parse-proxy', { text, defaultType }),
  openSettings: () => ipcRenderer.invoke('acc:open-settings'),
});
