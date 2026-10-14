'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('appreciation', {
  close: () => ipcRenderer.invoke('rack:close-appreciation')
});
