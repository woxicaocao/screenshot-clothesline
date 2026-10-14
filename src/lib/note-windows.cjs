'use strict';
const path = require('node:path');
const { normalizeNoteInput, DEFAULT_NOTE } = require('./notes-repository.cjs');

const copy = value => JSON.parse(JSON.stringify(value));
const validPoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y)
  && Math.abs(point.x) < 1_000_000 && Math.abs(point.y) < 1_000_000;

class NoteWindows {
  constructor({ BrowserWindow, screen, repository, rendererDir, preload, icon, getRackBounds,
    onChange = () => {}, suspend = () => {}, onError = () => {}, canOpen = () => true }) {
    this.BrowserWindow = BrowserWindow; this.screen = screen; this.repository = repository;
    this.rendererDir = rendererDir; this.preload = preload; this.icon = icon;
    this.getRackBounds = getRackBounds; this.onChange = onChange; this.suspend = suspend;
    this.onError = onError; this.canOpen = canOpen;
    this.entries = new Map();
    this.deletions = new Map();
  }

  _source(event) {
    const entry = [...this.entries.values()].find(item => !item.window.isDestroyed()
      && event.sender === item.window.webContents && event.senderFrame === item.window.webContents.mainFrame);
    if (!entry) throw new Error('不允许的便签窗口请求。');
    return entry;
  }

  _position(saved) {
    const rack = this.getRackBounds();
    const position = saved || { x: rack.x + 60 + this.entries.size * 24, y: rack.y + 90 + this.entries.size * 20 };
    const display = this.screen.getDisplayNearestPoint({ x: Math.round(position.x), y: Math.round(position.y) });
    const area = display.workArea;
    const width = Math.max(1, Math.min(saved?.width || 380, area.width - 24));
    const height = Math.max(1, Math.min(saved?.height || 430, area.height - 24));
    return { x: Math.round(Math.max(area.x, Math.min(position.x, area.x + area.width - width))),
      y: Math.round(Math.max(area.y, Math.min(position.y, area.y + area.height - height))), width: Math.round(width), height: Math.round(height) };
  }

  async open(id = null) {
    if (!this.canOpen()) throw new Error('程序正在退出，请稍后添加便签。');
    if (id && this.deletions.has(id)) throw new Error('便签正在删除，请稍后重试。');
    if (id) {
      const existing = [...this.entries.values()].find(entry => entry.noteId === id && !entry.window.isDestroyed());
      if (existing) { await existing.ready; if (this.deletions.has(id)) throw new Error('便签正在删除，请稍后重试。');
        if (!existing.window.isDestroyed()) { existing.window.show(); existing.window.focus(); } return; }
    }
    const stored = id ? this.repository.getNote(id) : null;
    if (id && !stored) throw new Error('找不到这张便签。');
    const draft = stored ? copy(stored) : { ...DEFAULT_NOTE, text: '', bounds: null };
    const bounds = this._position(draft.bounds);
    const window = new this.BrowserWindow({ ...bounds, minWidth: Math.min(320, bounds.width), minHeight: Math.min(360, bounds.height),
      frame: false, show: false, resizable: true, maximizable: false, fullscreenable: false,
      backgroundColor: draft.color, alwaysOnTop: draft.alwaysOnTop, title: '便签 · 截图晾衣架',
      autoHideMenuBar: true, icon: this.icon,
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false } });
    const entry = { window, draft, noteId: id, drag: null, closing: false, deleting: false, closePromise: null, flush: null, ready: null };
    // 便签是独立编辑窗口；开关和保存便签不暂停或重置衣架的自动隐藏。
    this.entries.set(window.id, entry);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('close', event => { event.preventDefault(); void this.requestFlush(entry).catch(error => this.onError(error)); });
    const rememberBounds = () => { if (!entry.closing && !window.isDestroyed()) entry.draft.bounds = window.getBounds(); };
    window.on('move', rememberBounds); window.on('resize', rememberBounds);
    window.on('closed', () => {
      this.entries.delete(window.id);
      this._settleFlush(entry, new Error('便签窗口已关闭。'));
      this.onChange();
    });
    entry.ready = window.loadFile(path.join(this.rendererDir, 'note.html')).then(() => {
      if (!window.isDestroyed() && !entry.deleting) { window.setAlwaysOnTop(entry.draft.alwaysOnTop); window.show(); window.focus(); }
    });
    try { await entry.ready; }
    catch (error) { if (!window.isDestroyed()) window.destroy(); throw error; }
  }

  get(event) {
    const entry = this._source(event);
    return { ...copy(entry.draft), id: entry.noteId, bounds: entry.window.getBounds() };
  }

  _update(entry, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('便签内容无效。');
    const normalized = normalizeNoteInput({ text: payload.text, color: payload.color,
      fontSize: payload.fontSize, alwaysOnTop: payload.alwaysOnTop, bounds: entry.window.getBounds() });
    entry.draft = { ...entry.draft, ...normalized };
    entry.window.setAlwaysOnTop(normalized.alwaysOnTop);
    return normalized;
  }

  save(event, payload) {
    const entry = this._source(event);
    if (entry.deleting) throw new Error('便签正在删除，请稍后重试。');
    if (entry.closing) throw new Error('便签正在保存并关闭。');
    this._update(entry, payload);
    return { ...copy(entry.draft), id: entry.noteId };
  }

  setAlwaysOnTop(event, value) {
    if (typeof value !== 'boolean') throw new TypeError('置顶开关无效。');
    const entry = this._source(event);
    if (entry.deleting) throw new Error('便签正在删除，请稍后重试。');
    if (entry.closing) throw new Error('便签正在关闭。');
    entry.draft.alwaysOnTop = value; entry.window.setAlwaysOnTop(value);
    return value;
  }

  close(event, payload) {
    const entry = this._source(event);
    if (entry.deleting) throw new Error('便签正在删除，请稍后重试。');
    if (entry.closePromise) return entry.closePromise;
    const normalized = this._update(entry, payload);
    entry.closing = true; entry.drag = null;
    entry.closePromise = Promise.resolve().then(async () => {
      try {
        const result = await this.repository.saveNote({ ...normalized, ...(entry.noteId ? { id: entry.noteId } : {}) });
        this._settleFlush(entry, null, result);
        this.onChange(result);
        if (!entry.window.isDestroyed()) entry.window.destroy();
        return result;
      } catch (error) {
        entry.closing = false; entry.closePromise = null;
        this._settleFlush(entry, error); this.onError(error);
        throw error;
      }
    });
    return entry.closePromise;
  }

  delete(id) {
    if (this.deletions.has(id)) return this.deletions.get(id);
    // getNote 对标识先验证；真正删改仍由仓库串行执行，避免旧 save 复活记录。
    this.repository.getNote(id);
    const matching = [...this.entries.values()].filter(entry => entry.noteId === id);
    for (const entry of matching) { entry.deleting = true; entry.drag = null; }
    const pending = Promise.resolve().then(async () => {
      try {
        // 已经提交的关闭保存先结束；保存失败不撤销用户明确的删除意图。
        await Promise.all(matching.map(entry => entry.closePromise?.catch(() => {})));
        const result = await this.repository.deleteNote(id);
        for (const entry of matching) {
          this._settleFlush(entry, null, result);
          if (!entry.window.isDestroyed()) entry.window.destroy();
        }
        this.onChange(result);
        return result;
      } catch (error) {
        for (const entry of matching) {
          entry.deleting = false;
          this._settleFlush(entry, error);
          // 删除失败保留草稿；若加载恰在删除中完成，恢复可见窗口。
          void entry.ready.then(() => { if (!entry.window.isDestroyed()) entry.window.show(); }).catch(() => {});
        }
        throw error;
      } finally {
        this.deletions.delete(id);
      }
    });
    this.deletions.set(id, pending);
    return pending;
  }

  _settleFlush(entry, error, value) {
    if (!entry.flush) return;
    const pending = entry.flush; entry.flush = null; clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve(value);
  }

  async requestFlush(entry) {
    if (entry.window.isDestroyed()) return;
    if (entry.deleting) return this.deletions.get(entry.noteId);
    if (entry.closePromise) return entry.closePromise;
    if (entry.flush) return entry.flush.promise;
    await entry.ready;
    if (entry.window.isDestroyed()) return;
    if (entry.deleting) return this.deletions.get(entry.noteId);
    if (entry.flush) return entry.flush.promise;
    const pending = {};
    pending.promise = new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject; });
    pending.timer = setTimeout(() => this._settleFlush(entry, new Error('便签窗口暂时没有响应，请保留窗口并重试关闭。')), 8000);
    entry.flush = pending;
    entry.window.webContents.send('rack:flush-note');
    return pending.promise;
  }

  async flushAll() {
    // 等待每个编辑窗主动提交最新输入；失败时保留该窗口，调用者不得继续退出。
    await Promise.all([...this.entries.values()].map(entry => this.requestFlush(entry)));
  }

  beginDrag(event, point) {
    const entry = this._source(event);
    if (entry.deleting) throw new Error('便签正在删除，请稍后重试。');
    if (!validPoint(point) || entry.closing) return;
    entry.drag = { point: { ...point }, bounds: entry.window.getBounds() };
  }

  moveDrag(event, point) {
    const entry = this._source(event);
    if (entry.deleting) throw new Error('便签正在删除，请稍后重试。');
    if (!entry.drag || !validPoint(point) || entry.closing) return;
    const area = this.screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }).workArea;
    const { bounds, point: origin } = entry.drag;
    const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
    entry.window.setBounds({ x: Math.round(Math.max(area.x, Math.min(bounds.x + point.x - origin.x, area.x + area.width - width))),
      y: Math.round(Math.max(area.y, Math.min(bounds.y + point.y - origin.y, area.y + area.height - height))), width, height });
    entry.draft.bounds = entry.window.getBounds();
  }

  endDrag(event) {
    const entry = this._source(event);
    if (entry.deleting) throw new Error('便签正在删除，请稍后重试。');
    entry.drag = null;
  }

  runtime() {
    return [...this.entries.values()].filter(entry => !entry.window.isDestroyed()).map(entry => ({ windowId: entry.window.id,
      noteId: entry.noteId, visible: entry.window.isVisible(), alwaysOnTop: entry.window.isAlwaysOnTop(), bounds: entry.window.getBounds(), closing: entry.closing, deleting: entry.deleting }));
  }
}

module.exports = { NoteWindows };
