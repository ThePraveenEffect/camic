'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('camic', {
  discoverList: () => ipcRenderer.invoke('discover-list'),
  rescan: () => ipcRenderer.invoke('rescan'),
  connect: (o) => ipcRenderer.invoke('connect', o),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  stopStream: () => ipcRenderer.invoke('stop-stream'),
  switchCamera: () => ipcRenderer.invoke('switch-camera'),
  refocus: () => ipcRenderer.invoke('refocus'),
  setTorch: (on) => ipcRenderer.invoke('set-torch', on),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (s) => ipcRenderer.invoke('set-settings', s),
  trustedList: () => ipcRenderer.invoke('trusted-list'),
  on: (ch, cb) => ipcRenderer.on(ch, (e, ...args) => cb(...args)),
});
