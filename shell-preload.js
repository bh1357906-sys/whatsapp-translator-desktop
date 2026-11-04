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
  checkIP: (id) => ipcRenderer.invoke('acc:check-ip', id),
  setOverlay: (on) => ipcRenderer.invoke('acc:overlay', !!on),
  testProxy: (proxy, accountId) => ipcRenderer.invoke('acc:test-proxy', { proxy, accountId }),
  parseProxy: (text, defaultType) => ipcRenderer.invoke('acc:parse-proxy', { text, defaultType }),
  openSettings: () => ipcRenderer.invoke('acc:open-settings'),
  groupCollapse: (name, collapsed) => ipcRenderer.invoke('acc:group-collapse', { name, collapsed }),
  groupRename: (name, newName) => ipcRenderer.invoke('acc:group-rename', { name, newName }),
  groupMove: (name, delta) => ipcRenderer.invoke('acc:group-move', { name, delta }),
  groupRemove: (name) => ipcRenderer.invoke('acc:group-remove', name),
  groupAdd: (name) => ipcRenderer.invoke('acc:group-add', name),
  getUiLang: () => ipcRenderer.invoke('acc:ui-lang'),
  onUiLang: (fn) => ipcRenderer.on('acc:ui-lang', (e, l) => fn(l)),
});
