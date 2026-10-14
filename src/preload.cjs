'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rack', {
  getSnapshot: () => ipcRenderer.invoke('rack:get-snapshot'),
  pasteClipboard: () => ipcRenderer.invoke('rack:paste-clipboard'),
  addNote: () => ipcRenderer.invoke('rack:add-note'),
  openAppreciation: () => ipcRenderer.invoke('rack:open-appreciation'),
  openNote: (id) => ipcRenderer.invoke('rack:open-note', id),
  showNoteMenu: (id) => ipcRenderer.send('rack:note-menu', id),
  getNote: () => ipcRenderer.invoke('rack:get-note'),
  saveNote: (payload) => ipcRenderer.invoke('rack:save-note', payload),
  closeNote: (payload) => ipcRenderer.invoke('rack:close-note', payload),
  setNoteAlwaysOnTop: (value) => ipcRenderer.invoke('rack:set-note-always-on-top', value),
  beginNoteDrag: (point) => ipcRenderer.send('rack:begin-note-drag', point),
  moveNoteDrag: (point) => ipcRenderer.send('rack:move-note-drag', point),
  endNoteDrag: () => ipcRenderer.send('rack:end-note-drag'),
  onNoteFlush: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = () => callback();
    ipcRenderer.on('rack:flush-note', listener);
    return () => ipcRenderer.removeListener('rack:flush-note', listener);
  },
  setPasteHover: (hovering) => ipcRenderer.send('rack:set-paste-hover', hovering),
  onSnapshot: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('rack:snapshot', listener);
    return () => ipcRenderer.removeListener('rack:snapshot', listener);
  },
  setPaused: (paused) => ipcRenderer.invoke('rack:set-paused', paused),
  setAlwaysOnTop: (value) => ipcRenderer.invoke('rack:set-always-on-top', value),
  setAutoHide: (value) => ipcRenderer.invoke('rack:set-auto-hide', value),
  setAutoHideSpeed: (speed) => ipcRenderer.invoke('rack:set-auto-hide-speed', speed),
  preparePhotoDrag: (id) => ipcRenderer.invoke('rack:prepare-photo-drag', id),
  dragPhoto: (id) => ipcRenderer.send('rack:drag-photo', id),
  showPhotoMenu: (id) => ipcRenderer.send('rack:photo-menu', id),
  onPhotoDragEnd: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, point) => callback(point);
    ipcRenderer.on('rack:photo-drag-ended', listener);
    return () => ipcRenderer.removeListener('rack:photo-drag-ended', listener);
  },
  beginDrag: (point) => ipcRenderer.send('rack:begin-drag', point),
  moveDrag: (point) => ipcRenderer.send('rack:move-drag', point),
  endDrag: () => ipcRenderer.send('rack:end-drag'),
  hide: () => ipcRenderer.invoke('rack:hide'),
  openPreview: (id) => ipcRenderer.invoke('rack:open-preview', id),
  setInteractive: (interactive) => ipcRenderer.send('rack:set-interactive', interactive),
  getPreview: () => ipcRenderer.invoke('rack:get-preview'),
  resizePreview: (payload) => ipcRenderer.invoke('rack:resize-preview', payload),
  setPreviewAlwaysOnTop: (value) => ipcRenderer.invoke('rack:set-preview-always-on-top', value),
  beginPreviewDrag: () => ipcRenderer.send('rack:begin-preview-drag'),
  movePreviewDrag: () => ipcRenderer.send('rack:move-preview-drag'),
  endPreviewDrag: () => ipcRenderer.send('rack:end-preview-drag'),
  beginPreviewResize: (edge) => ipcRenderer.send('rack:begin-preview-resize', edge),
  movePreviewResize: () => ipcRenderer.send('rack:move-preview-resize'),
  endPreviewResize: () => ipcRenderer.send('rack:end-preview-resize'),
  showPreviewMenu: () => ipcRenderer.invoke('rack:preview-menu'),
  onPreviewState: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('rack:preview-state', listener);
    return () => ipcRenderer.removeListener('rack:preview-state', listener);
  },
  closePreview: () => ipcRenderer.invoke('rack:close-preview')
});
