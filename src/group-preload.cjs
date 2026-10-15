'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

// 组浏览器仅暴露当前组所需的操作；成员权限仍由主进程逐次校验。
contextBridge.exposeInMainWorld('groupBrowser', {
  getGroup: () => ipcRenderer.invoke('group:get'),
  applyLayout: operation => ipcRenderer.invoke('group:apply', operation),
  openItem: id => ipcRenderer.invoke('group:open-item', id),
  preparePhotoDrag: id => ipcRenderer.invoke('group:prepare-drag', id),
  dragPhoto: id => ipcRenderer.send('group:drag-photo', id),
  preparePhotoBatch: ids => ipcRenderer.invoke('group:prepare-batch-drag', ids),
  dragPhotos: ids => ipcRenderer.send('group:drag-photos', ids),
  showMemberMenu: id => ipcRenderer.send('group:member-menu', id),
  showGroupMenu: () => ipcRenderer.send('group:menu'),
  setAlwaysOnTop: value => ipcRenderer.invoke('group:set-always-on-top', value),
  close: () => ipcRenderer.invoke('group:close'),
  setOrganizeActive: active => ipcRenderer.send('group:organize-active', active === true),
  onGroup: callback => subscribe('group:updated', callback),
  onFocusName: callback => subscribe('group:focus-name', callback),
  onCancelOrganize: callback => subscribe('group:cancel-organize', callback),
  onPhotoDragEnd: callback => subscribe('rack:photo-drag-ended', callback),
});
