'use strict';

const path = require('node:path');
const { placeAvoidingRack } = require('./avoid-rack.cjs');
const { MAX_BATCH_PHOTOS } = require('./layout-repository.cjs');
const copy = value => JSON.parse(JSON.stringify(value));

class GroupWindows {
  constructor({ BrowserWindow, screen, rendererDir, preload, icon, getRackBounds, getGroup,
    onApply, onOpenItem, onPreparePhotoDrag, onDragPhoto, onPreparePhotoBatch, onDragPhotos,
    onMemberMenu, onGroupMenu = () => {},
    onOrganizeActive = () => {}, onError = () => {}, canOpen = () => true }) {
    Object.assign(this, { BrowserWindow, screen, rendererDir, preload, icon, getRackBounds, getGroup,
      onApply, onOpenItem, onPreparePhotoDrag, onDragPhoto, onPreparePhotoBatch, onDragPhotos,
      onMemberMenu, onGroupMenu, onOrganizeActive, onError, canOpen });
    this.entry = null;
  }

  _current(entry = this.entry) {
    if (!entry || entry.window.isDestroyed()) return null;
    return this.getGroup(entry.groupId);
  }

  source(event) {
    const entry = this.entry;
    if (!entry || entry.window.isDestroyed() || event?.sender !== entry.window.webContents
      || event.senderFrame !== entry.window.webContents.mainFrame) throw new Error('不允许的组窗口请求。');
    const group = this._current(entry);
    if (!group) throw new Error('这个组已经取消，请回到衣架查看。');
    return { ...entry, group };
  }

  _member(event, id, photoOnly = false) {
    const source = this.source(event);
    const item = source.group.items.find(member => member.id === id);
    if (!item || photoOnly && item.type !== 'photo') throw new Error('只能操作当前组中的成员。');
    return { ...source, item };
  }

  _photoBatch(event, ids) {
    const source = this.source(event);
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_BATCH_PHOTOS
      || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) {
      throw new TypeError(`每次只能操作 1 到 ${MAX_BATCH_PHOTOS} 张不重复的图片。`);
    }
    const selected = new Set(ids);
    const members = source.group.items.filter(item => selected.has(item.id));
    if (source.group.kind !== 'photo' || members.length !== ids.length || members.some(item => item.type !== 'photo')) {
      throw new Error('只能批量操作当前图片组中的图片。');
    }
    return { ...source, ids: members.map(item => item.id) };
  }

  _validatePhotoBatch(event, original) {
    const current = this._photoBatch(event, original.ids);
    if (current.window !== original.window || current.groupId !== original.groupId
      || current.batchScope !== original.batchScope) {
      throw new Error('组窗口已切换，请重新选择图片。');
    }
    return true;
  }

  _organize(active) {
    if (!this.entry) return;
    if (!active && !this.entry.organizing) return;
    this.entry.organizing = active;
    // 心跳也转发给主进程，长拖动不会被整理会话的超时保护提前解除。
    this.onOrganizeActive(active);
  }

  async open(id, options = {}) {
    if (!this.canOpen()) throw new Error('程序正在退出，请稍后打开组。');
    if (!this.getGroup(id)) throw new Error('找不到这个组。');
    let entry = this.entry;
    if (entry && !entry.window.isDestroyed()) {
      this._organize(false);
      entry.groupId = id;
      // 即使切走后又切回同一组，旧批量拖出请求也不能继续使用。
      entry.batchScope = {};
      await entry.ready;
    } else {
      const rack = this.getRackBounds();
      const area = this.screen.getDisplayNearestPoint({ x: Math.round(rack.x + rack.width / 2),
        y: Math.round(rack.y + rack.height / 2) }).workArea;
      const bounds = placeAvoidingRack({ rack, workArea: area, width: 680, height: 420, minWidth: 270, minHeight: 220 });
      const window = new this.BrowserWindow({ ...bounds, minWidth: Math.min(270, bounds.width), minHeight: Math.min(220, bounds.height),
        frame: true, titleBarStyle: 'hidden', titleBarOverlay: { color: '#f5f3ec', symbolColor: '#5e6557', height: 40 },
        show: false, resizable: true, maximizable: false, fullscreenable: false,
        alwaysOnTop: false, backgroundColor: '#f5f3ec', autoHideMenuBar: true, icon: this.icon,
        title: '组浏览 · 截图晾衣架',
        webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false } });
      entry = { window, groupId: id, ready: null, organizing: false, batchScope: {} };
      this.entry = entry;
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.on('blur', () => {
        if (this.entry === entry) this._organize(false);
        if (!window.isDestroyed()) window.webContents.send('group:cancel-organize');
      });
      window.on('closed', () => {
        if (this.entry === entry) { this._organize(false); this.entry = null; }
      });
      entry.ready = window.loadFile(path.join(this.rendererDir, 'group.html'));
      try { await entry.ready; }
      catch (error) { if (!window.isDestroyed()) window.destroy(); throw error; }
    }
    if (this.entry !== entry || entry.window.isDestroyed()) return;
    if (!this._current(entry)) { this.close(); return; }
    this.publish();
    entry.window.show(); entry.window.focus();
    if (options.rename) entry.window.webContents.send('group:focus-name');
  }

  _view(group, window) { return { ...copy(group), alwaysOnTop: window.isAlwaysOnTop() }; }

  get(event) {
    const { group, window } = this.source(event);
    return this._view(group, window);
  }

  setAlwaysOnTop(event, value) {
    if (typeof value !== 'boolean') throw new TypeError('置顶状态无效。');
    const { window } = this.source(event);
    window.setAlwaysOnTop(value);
    this.publish();
    return window.isAlwaysOnTop();
  }

  async apply(event, operation) {
    const { group } = this.source(event);
    if (!operation || typeof operation !== 'object' || Array.isArray(operation) || operation.groupId !== group.id) {
      throw new Error('只能整理当前打开的组。');
    }
    const ids = new Set(group.items.map(item => item.id));
    let safe;
    if (operation.type === 'move' && ids.has(operation.id)
      && (operation.beforeId === null || ids.has(operation.beforeId))) {
      safe = { type: 'move', id: operation.id, beforeId: operation.beforeId, groupId: group.id };
    } else if (operation.type === 'move-many') {
      const source = this._photoBatch(event, operation.ids);
      if (operation.beforeId !== null && (!ids.has(operation.beforeId) || source.ids.includes(operation.beforeId))) {
        throw new Error('批量排序位置必须是当前组内未选中的图片。');
      }
      safe = { type: 'move-many', groupId: group.id, ids: source.ids, beforeId: operation.beforeId };
    } else if (operation.type === 'rename' && typeof operation.name === 'string') {
      safe = { type: 'rename', groupId: group.id, name: operation.name };
    } else if (operation.type === 'remove' && ids.has(operation.id)) {
      safe = { type: 'remove', groupId: group.id, id: operation.id };
    } else throw new Error('组窗口只能排序、重命名或移出当前组中的成员。');
    try {
      const snapshot = await this.onApply(safe);
      this.publish();
      return snapshot;
    } catch (error) {
      // 不乐观改内存；磁盘失败时广播原组，让页面恢复已提交的顺序。
      this.publish();
      throw error;
    }
  }

  openItem(event, id) { return this.onOpenItem(this._member(event, id).item); }

  async preparePhotoDrag(event, id) {
    this._member(event, id, true);
    await this.onPreparePhotoDrag(id);
    this._member(event, id, true);
    return true;
  }

  async dragPhoto(event, id) {
    const { window } = this._member(event, id, true);
    this._organize(false);
    try { await this.onDragPhoto(window.webContents, id); }
    finally {
      if (!window.isDestroyed()) window.webContents.send('rack:photo-drag-ended', this.screen.getCursorScreenPoint?.() || null);
    }
  }

  async preparePhotoBatch(event, ids) {
    const source = this._photoBatch(event, ids);
    await this.onPreparePhotoBatch([...source.ids]);
    this._validatePhotoBatch(event, source);
    return true;
  }

  async dragPhotos(event, ids) {
    const source = this._photoBatch(event, ids);
    this._organize(false);
    try {
      // main 在准备完导出文件之后、同步调用 startDrag 之前再次调用 validate。
      await this.onDragPhotos(source.window.webContents, [...source.ids], () => this._validatePhotoBatch(event, source));
    } finally {
      const entry = this.entry;
      if (entry && entry.window === source.window && entry.groupId === source.groupId
        && entry.batchScope === source.batchScope && !source.window.isDestroyed()) {
        source.window.webContents.send('rack:photo-drag-ended', this.screen.getCursorScreenPoint?.() || null);
      }
    }
  }

  memberMenu(event, id) {
    const { group, window } = this._member(event, id);
    return this.onMemberMenu(group.id, id, window);
  }

  menu(event) {
    const { group, window } = this.source(event);
    this._organize(false);
    return this.onGroupMenu(group.id, window);
  }

  setOrganizeActive(event, active) {
    if (typeof active !== 'boolean') throw new TypeError('整理状态无效。');
    if (!active) {
      // 解散或移出最后成员会先取消组再关闭窗口，卸载时的清理请求无需仍有组。
      // 只接收当前窗口主 frame；旧窗口迟到的 false 不得解除新窗口正在进行的整理。
      const entry = this.entry;
      if (entry && !entry.window.isDestroyed() && event?.sender === entry.window.webContents
        && event.senderFrame === entry.window.webContents.mainFrame) this._organize(false);
      return;
    }
    this.source(event);
    this._organize(active);
  }

  publish() {
    const entry = this.entry;
    if (!entry || entry.window.isDestroyed()) return;
    const group = this._current(entry);
    if (!group) { this.close(); return; }
    entry.window.setTitle(`${group.name} · 截图晾衣架`);
    entry.window.webContents.send('group:updated', this._view(group, entry.window));
  }

  close(event) {
    if (event) this.source(event);
    const entry = this.entry;
    if (!entry || entry.window.isDestroyed()) return;
    this._organize(false);
    entry.window.close();
  }

  runtime() {
    const entry = this.entry;
    return !entry || entry.window.isDestroyed() ? [] : [{ windowId: entry.window.id, groupId: entry.groupId,
      visible: entry.window.isVisible(), bounds: entry.window.getBounds(), organizing: entry.organizing,
      alwaysOnTop: entry.window.isAlwaysOnTop() }];
  }
}

module.exports = { GroupWindows };
