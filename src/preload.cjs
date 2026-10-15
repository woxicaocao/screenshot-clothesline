'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 仅响应主进程的单张解码请求；不提供页面可调用的文件或任意图片解码接口。
ipcRenderer.on('rack:decode-local-webp', async (_event, payload) => {
  let bitmap, canvas;
  const requestId = payload?.requestId;
  if (typeof requestId !== 'string') return;
  try {
    const { width, height, bytes } = payload;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
      || width * height > 40_000_000 || !(bytes instanceof Uint8Array) || !bytes.byteLength
      || bytes.byteLength > 40 * 1024 * 1024) throw new Error('invalid WebP request');
    bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
    if (!(bitmap.width === width && bitmap.height === height || bitmap.width === height && bitmap.height === width)) {
      throw new Error('invalid decoded dimensions');
    }
    canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas unavailable');
    context.drawImage(bitmap, 0, 0);
    bitmap.close(); bitmap = null;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob || blob.size > 128 * 1024 * 1024) throw new Error('decoded image too large');
    const png = new Uint8Array(await blob.arrayBuffer());
    ipcRenderer.send('rack:decoded-local-webp', { requestId, bytes: png });
  } catch {
    ipcRenderer.send('rack:decoded-local-webp', { requestId, error: true });
  } finally {
    bitmap?.close();
    if (canvas) { canvas.width = canvas.height = 0; }
  }
});

async function importLocalImages(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('请从文件夹拖入本机图片。');
  if (files.length > 100) throw new Error('一次最多拖入 100 张图片，请分批添加。');
  const paths = files.map(file => {
    let filePath;
    try { filePath = webUtils.getPathForFile(file); }
    catch { throw new Error('无法读取拖入的图片，请从本机文件夹重新拖入。'); }
    if (!filePath) throw new Error('请从本机文件夹拖入图片；网页图片请复制后粘贴。');
    return filePath;
  });
  return ipcRenderer.invoke('rack:import-local-images', paths);
}

contextBridge.exposeInMainWorld('rack', {
  getSnapshot: () => ipcRenderer.invoke('rack:get-snapshot'),
  applyLayout: operation => ipcRenderer.invoke('rack:apply-layout', operation),
  setOrganizeActive: active => ipcRenderer.send('rack:organize-active', active === true),
  openGroup: id => ipcRenderer.invoke('rack:open-group', id),
  showGroupMenu: id => ipcRenderer.send('rack:group-menu', id),
  pasteClipboard: () => ipcRenderer.invoke('rack:paste-clipboard'),
  importLocalImages,
  setFileDropActive: (active) => ipcRenderer.send('rack:set-file-drop-active', active === true),
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
