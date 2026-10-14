'use strict';

const { dimensionsFor, displayFactor, geometryForScale, drawnSize, scaleLimitForDisplay, minScaleForDisplay, workAreaFor, fitScaleForDisplay, visibleAreaFor,
  MAX_DRAWN_PIXELS, MAX_DRAWN_EDGE, FRAME_EDGES, frameBoundsFromPoint, frameSizeForDisplay } = require('./photo-window-geometry.cjs');

function validPoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) < 1_000_000 && Math.abs(point.y) < 1_000_000;
}

class PhotoWindows {
  constructor({ screen, Menu, onError = () => {}, popupMenus = true }) {
    this.screen = screen;
    this.Menu = Menu;
    this.onError = onError;
    this.popupMenus = popupMenus;
    this.entries = new Map();
    this.lastMenu = null;
  }

  register(window, photo, { floating = false, scale } = {}) {
    dimensionsFor(photo);
    if (typeof photo.id !== 'string' || !photo.id) throw new TypeError('图片编号无效。');
    if (!window || window.isDestroyed()) throw new Error('图片窗口已经关闭。');
    if (this.entries.has(window.id)) throw new Error('图片窗口已经注册。');
    const bounds = window.getBounds(), display = this._display(bounds);
    if (scale === undefined) scale = Math.min(1, (bounds.width - 2) / photo.width, (bounds.height - 2) / photo.height);
    if (!Number.isFinite(scale) || scale <= 0) throw new TypeError('图片缩放比例无效。');
    const limit = scaleLimitForDisplay(photo, display);
    const entry = { window, photo: { id: photo.id, ...dimensionsFor(photo) }, floating: !!floating,
      scale: Math.max(minScaleForDisplay(photo, display, limit), Math.min(scale, limit)), mode: 'fit', requestedSize: null,
      revision: 0, drag: null, frameResize: null, timer: null, listeners: [] };
    this.entries.set(window.id, entry);
    for (const name of ['move', 'resize', 'always-on-top-changed']) this._listen(entry, name, () => this._touch(entry));
    this._listen(entry, 'blur', () => this._endInteractions(entry));
    this._listen(entry, 'closed', () => this.unregister(window));
    const geometry = geometryForScale(entry.photo, entry.scale);
    entry.requestedSize = { width: geometry.width, height: geometry.height };
    try { window.setBounds({ ...bounds, width: geometry.width, height: geometry.height }); }
    catch (error) { this.unregister(window); throw error; }
    entry.scale = Math.min(entry.scale, this._contentFitScale(entry, this._contentBounds(entry)));
    this._touch(entry);
    return this._state(entry);
  }

  unregister(window) {
    const entry = this.entries.get(window?.id);
    if (!entry || entry.window !== window) return;
    clearTimeout(entry.timer);
    for (const [name, listener] of entry.listeners) window.removeListener(name, listener);
    entry.drag = null;
    entry.frameResize = null;
    this.entries.delete(window.id);
    if (this.lastMenu?.windowId === window.id) this.lastMenu = null;
  }

  dispose() { for (const entry of [...this.entries.values()]) this.unregister(entry.window); }

  _listen(entry, name, listener) { entry.window.on(name, listener); entry.listeners.push([name, listener]); }

  _source(event) {
    const entry = [...this.entries.values()].find(candidate => !candidate.window.isDestroyed()
      && event?.sender === candidate.window.webContents && event?.senderFrame === candidate.window.webContents.mainFrame);
    if (!entry) throw new Error('不允许的图片窗口请求。');
    return entry;
  }

  _display(bounds) {
    const display = this.screen.getDisplayMatching?.(bounds)
      || this.screen.getDisplayNearestPoint?.({ x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) })
      || this.screen.getPrimaryDisplay?.();
    workAreaFor(display);
    return display;
  }

  _contentBounds(entry) {
    return entry.window.getContentBounds?.() || entry.window.getBounds();
  }

  _contentFitScale(entry, content) {
    if (content.width <= 2 || content.height <= 2) throw new Error('系统返回的图片窗口客户区过小。');
    return Math.min((content.width - 2) / entry.photo.width, (content.height - 2) / entry.photo.height);
  }

  _visibleArea(content, matchedDisplay) {
    const displays = this.screen.getAllDisplays?.() || [matchedDisplay];
    const candidates = displays.map(display => ({ display, area: workAreaFor(display) }))
      .map(candidate => ({ ...candidate, visible: visibleAreaFor(content, candidate.area) }))
      .filter(candidate => candidate.visible.width >= Math.min(64, content.width, candidate.area.width)
        && candidate.visible.height >= Math.min(48, content.height, candidate.area.height));
    candidates.sort((left, right) => right.visible.width * right.visible.height - left.visible.width * left.visible.height);
    return candidates[0]?.visible || visibleAreaFor(content, workAreaFor(matchedDisplay));
  }

  _state(entry) {
    const bounds = entry.window.getBounds(), content = this._contentBounds(entry), display = this._display(bounds);
    const scaleLimit = scaleLimitForDisplay(entry.photo, display);
    const scale = entry.mode === 'frame' ? Math.min(this._contentFitScale(entry, content), scaleLimit)
      : Math.min(entry.scale, this._contentFitScale(entry, content));
    const width = entry.photo.width * scale, height = entry.photo.height * scale;
    return { id: entry.photo.id, windowId: entry.window.id, floating: entry.floating, scale,
      mode: entry.mode, revision: entry.revision, bounds: { ...bounds }, alwaysOnTop: entry.window.isAlwaysOnTop(), dragging: !!entry.drag, resizing: !!entry.frameResize,
      visibleArea: this._visibleArea(content, display), image: { x: (content.width - width) / 2, y: (content.height - height) / 2, width, height },
      scaleLimit, minScale: minScaleForDisplay(entry.photo, display, scaleLimit), displayScaleFactor: displayFactor(display), drawnSize: drawnSize(content, display) };
  }

  _touch(entry) {
    if (!this.entries.has(entry.window.id) || entry.window.isDestroyed()) return;
    entry.revision += 1;
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (!this.entries.has(entry.window.id) || entry.window.isDestroyed() || entry.window.webContents.isDestroyed?.()) return;
      try { entry.window.webContents.send('rack:preview-state', this._state(entry)); }
      catch (error) { this.onError(error, entry.window); }
    }, 16);
    entry.timer.unref?.();
  }

  getState(event) { return this._state(this._source(event)); }

  stateFor(window) {
    const entry = this.entries.get(window?.id);
    if (!entry || entry.window !== window || window.isDestroyed()) throw new Error('图片窗口尚未注册。');
    return this._state(entry);
  }

  setAlwaysOnTop(event, value) {
    const entry = this._source(event);
    if (typeof value !== 'boolean') throw new TypeError('置顶状态必须为布尔值。');
    entry.window.setAlwaysOnTop(value);
    this._endInteractions(entry);
    this._touch(entry);
    return this._state(entry);
  }

  _eventFor(entry) { return { sender: entry.window.webContents, senderFrame: entry.window.webContents.mainFrame }; }

  _areas(display) {
    const all = this.screen.getAllDisplays?.() || [display];
    return all.map(workAreaFor);
  }

  _repairInvisible(bounds, display) {
    if (this._areas(display).some(area => {
      const visible = visibleAreaFor(bounds, area);
      return visible.width >= Math.min(64, bounds.width, area.width) && visible.height >= Math.min(48, bounds.height, area.height);
    })) return bounds;
    const area = workAreaFor(display);
    return this._keepControlArea(bounds, area);
  }

  _keepControlArea(bounds, area) {
    const width = Math.min(64, bounds.width, area.width), height = Math.min(48, bounds.height, area.height);
    return { ...bounds,
      x: Math.round(Math.max(area.x + width - bounds.width, Math.min(bounds.x, area.x + area.width - width))),
      y: Math.round(Math.max(area.y + height - bounds.height, Math.min(bounds.y, area.y + area.height - height))) };
  }

  _strictestLimit(entry, extraDisplay, nativeExtra = {}) {
    const displays = this.screen.getAllDisplays?.() || [extraDisplay];
    return Math.min(scaleLimitForDisplay(entry.photo, extraDisplay, nativeExtra), ...displays.map(display => scaleLimitForDisplay(entry.photo, display, nativeExtra)));
  }

  _boundsForScale(entry, scale, origin, content, anchor, cursor, fitArea, display) {
    const geometry = geometryForScale(entry.photo, scale);
    let x = origin.x + (origin.width - geometry.width) / 2, y = origin.y + (origin.height - geometry.height) / 2;
    if (anchor) {
      x = cursor.x - anchor.x * geometry.image.width - geometry.image.x - (content.x - origin.x);
      y = cursor.y - anchor.y * geometry.image.height - geometry.image.y - (content.y - origin.y);
    }
    let bounds = { x: Math.round(x), y: Math.round(y), width: geometry.width, height: geometry.height };
    if (fitArea) {
      bounds.x = Math.round(Math.max(fitArea.x, Math.min(bounds.x, fitArea.x + fitArea.width - bounds.width)));
      bounds.y = Math.round(Math.max(fitArea.y, Math.min(bounds.y, fitArea.y + fitArea.height - bounds.height)));
    } else bounds = this._repairInvisible(bounds, display);
    return bounds;
  }

  _applyResize(entry, requested, mode, anchor, fitArea = null) {
    const origin = entry.window.getBounds(), content = this._contentBounds(entry), initialDisplay = this._display(origin);
    const cursor = anchor ? this.screen.getCursorScreenPoint() : null;
    if (anchor && !validPoint(cursor)) throw new Error('无法读取当前鼠标位置。');
    let limit = scaleLimitForDisplay(entry.photo, initialDisplay), planned, stable = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const scale = Math.max(minScaleForDisplay(entry.photo, initialDisplay, limit), Math.min(requested, limit));
      const bounds = this._boundsForScale(entry, scale, origin, content, anchor, cursor, fitArea, initialDisplay);
      const targetDisplay = this._display(bounds), targetLimit = scaleLimitForDisplay(entry.photo, targetDisplay);
      planned = { scale, bounds };
      if (targetLimit >= limit) { stable = true; break; }
      limit = targetLimit;
    }
    if (!stable) {
      limit = Math.min(limit, this._strictestLimit(entry, initialDisplay));
      const scale = Math.max(minScaleForDisplay(entry.photo, initialDisplay, limit), Math.min(requested, limit));
      planned = { scale, bounds: this._boundsForScale(entry, scale, origin, content, anchor, cursor, fitArea, initialDisplay) };
    }
    const oldMeta = { scale: entry.scale, mode: entry.mode, requestedSize: entry.requestedSize,
      drag: entry.drag, frameResize: entry.frameResize };
    let applied = false;
    try {
      entry.window.setBounds(planned.bounds);
      applied = true;
      let actualBounds = entry.window.getBounds(), actualContent = this._contentBounds(entry), actualDisplay = this._display(actualBounds);
      const actualLimit = scaleLimitForDisplay(entry.photo, actualDisplay), pixels = drawnSize(actualContent, actualDisplay);
      if (planned.scale > actualLimit || pixels.width > MAX_DRAWN_EDGE || pixels.height > MAX_DRAWN_EDGE || pixels.area > MAX_DRAWN_PIXELS) {
        // 原生窗口在非整数 DPI 下可能比请求多 1 DIP；仅在实测超限时预留该余量。
        const nativeExtra = { width: Math.max(0, actualContent.width - planned.bounds.width),
          height: Math.max(0, actualContent.height - planned.bounds.height) };
        limit = Math.min(limit, this._strictestLimit(entry, actualDisplay, nativeExtra));
        const scale = Math.max(minScaleForDisplay(entry.photo, actualDisplay, limit), Math.min(requested, limit));
        planned = { scale, bounds: this._boundsForScale(entry, scale, origin, content, anchor, cursor, fitArea, initialDisplay) };
        entry.window.setBounds(planned.bounds);
        actualBounds = entry.window.getBounds(); actualContent = this._contentBounds(entry); actualDisplay = this._display(actualBounds);
      }
      const finalPixels = drawnSize(actualContent, actualDisplay);
      if (finalPixels.width > MAX_DRAWN_EDGE || finalPixels.height > MAX_DRAWN_EDGE || finalPixels.area > MAX_DRAWN_PIXELS) throw new Error('系统未能将图片窗口调整到安全的绘制尺寸。');
      entry.scale = Math.min(planned.scale, scaleLimitForDisplay(entry.photo, actualDisplay), this._contentFitScale(entry, actualContent));
      entry.mode = mode;
      entry.requestedSize = { width: planned.bounds.width, height: planned.bounds.height };
      entry.drag = null;
      entry.frameResize = null;
    } catch (error) {
      if (applied) {
        try { entry.window.setBounds({ ...origin, ...oldMeta.requestedSize }); }
        catch (rollbackError) { this.onError(rollbackError, entry.window); }
      }
      Object.assign(entry, oldMeta);
      throw error;
    }
    this._touch(entry);
    return this._state(entry);
  }

  resize(event, payload) {
    const entry = this._source(event);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('图片尺寸请求无效。');
    const hasMode = Object.hasOwn(payload, 'mode'), hasScale = Object.hasOwn(payload, 'scale');
    if (hasMode === hasScale || Object.keys(payload).some(key => !['mode', 'scale', 'anchor'].includes(key))) throw new TypeError('请指定缩放比例或适应/原始大小模式。');
    if (hasMode && (!['fit', 'actual'].includes(payload.mode) || Object.hasOwn(payload, 'anchor'))) throw new TypeError('图片缩放模式无效。');
    if (hasScale && (!Number.isFinite(payload.scale) || payload.scale <= 0)) throw new TypeError('图片缩放比例必须是有效的正数。');
    const anchor = payload.anchor;
    if (anchor !== undefined && (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || anchor.x < 0 || anchor.x > 1 || anchor.y < 0 || anchor.y > 1)) throw new TypeError('图片缩放锚点无效。');
    const display = this._display(entry.window.getBounds());
    const requested = hasMode ? payload.mode === 'fit' ? fitScaleForDisplay(entry.photo, display) : 1 : payload.scale;
    return this._applyResize(entry, requested, hasMode ? payload.mode : 'manual', anchor, payload.mode === 'fit' ? workAreaFor(display) : null);
  }

  beginDrag(event) {
    const entry = this._source(event), point = this.screen.getCursorScreenPoint();
    if (!validPoint(point)) throw new Error('无法读取当前鼠标位置。');
    entry.frameResize = null;
    entry.drag = { point: { ...point }, bounds: entry.window.getBounds() };
    this._touch(entry);
    return this._state(entry);
  }

  moveDrag(event) {
    const entry = this._source(event);
    if (!entry.drag) return this._state(entry);
    const point = this.screen.getCursorScreenPoint();
    if (!validPoint(point)) throw new Error('无法读取当前鼠标位置。');
    const { bounds, point: origin } = entry.drag;
    const display = this.screen.getDisplayNearestPoint(point), area = workAreaFor(display);
    const current = entry.window.getBounds();
    // 高 DPI 原生回读可能多出 1 DIP；不能把已取整尺寸逐次反馈为下一次请求。
    const target = this._keepControlArea({ ...current, ...entry.requestedSize,
      x: Math.round(bounds.x + point.x - origin.x), y: Math.round(bounds.y + point.y - origin.y) }, area);
    const previousMeta = { scale: entry.scale, mode: entry.mode, requestedSize: entry.requestedSize,
      drag: entry.drag, frameResize: entry.frameResize };
    let moved = false;
    try {
      // Windows 高 DPI 下省略尺寸的 bounds 请求可能反复扩大无边框窗口；
      // 普通拖移明确保留当前尺寸，跨屏绘制上限仍由下方实际显示器检查处理。
      entry.window.setBounds(target); moved = true;
      const actual = entry.window.getBounds(), content = this._contentBounds(entry), matched = this._display(actual);
      const pixels = drawnSize(content, matched), limit = scaleLimitForDisplay(entry.photo, matched);
      if (pixels.width > MAX_DRAWN_EDGE || pixels.height > MAX_DRAWN_EDGE || pixels.area > MAX_DRAWN_PIXELS || entry.mode !== 'frame' && entry.scale > limit) {
        const fraction = { x: Math.max(0, Math.min(1, (point.x - actual.x) / actual.width)),
          y: Math.max(0, Math.min(1, (point.y - actual.y) / actual.height)) };
        if (entry.mode === 'frame') {
          this._applyFrameChange(entry, targetDisplay => {
            const size = frameSizeForDisplay(actual.width, actual.height, targetDisplay);
            return this._repairInvisible({ ...size, x: Math.round(point.x - fraction.x * size.width),
              y: Math.round(point.y - fraction.y * size.height) }, targetDisplay);
          });
        } else {
          const state = this._state(entry);
          const anchor = { x: Math.max(0, Math.min(1, (point.x - content.x - state.image.x) / state.image.width)),
            y: Math.max(0, Math.min(1, (point.y - content.y - state.image.y) / state.image.height)) };
          this._applyResize(entry, Math.min(state.scale, limit), entry.mode, anchor);
        }
        const latestPoint = this.screen.getCursorScreenPoint();
        entry.drag = { point: validPoint(latestPoint) ? { ...latestPoint } : { ...point }, bounds: entry.window.getBounds() };
      }
    } catch (error) {
      if (moved) {
        try { entry.window.setBounds({ ...current, ...previousMeta.requestedSize }); }
        catch (rollbackError) { this.onError(rollbackError, entry.window); }
      }
      Object.assign(entry, previousMeta);
      throw error;
    }
    this._touch(entry);
    return this._state(entry);
  }

  _endDrag(entry) { if (entry.drag) { entry.drag = null; this._touch(entry); } }
  endDrag(event) { const entry = this._source(event); this._endDrag(entry); return this._state(entry); }

  _endInteractions(entry) {
    if (entry.drag || entry.frameResize) { entry.drag = null; entry.frameResize = null; this._touch(entry); }
  }

  beginFrameResize(event, edge) {
    const entry = this._source(event);
    if (!FRAME_EDGES.includes(edge)) throw new TypeError('图片窗口边框方向无效。');
    const point = this.screen.getCursorScreenPoint();
    if (!validPoint(point)) throw new Error('无法读取当前鼠标位置。');
    entry.drag = null;
    entry.frameResize = { edge, point: { ...point }, bounds: entry.window.getBounds() };
    this._touch(entry);
    return this._state(entry);
  }

  _frameTarget(entry, session, point, display) {
    return this._repairInvisible(frameBoundsFromPoint(session.bounds, session.point, point, session.edge, display), display);
  }

  moveFrameResize(event) {
    const entry = this._source(event);
    if (!entry.frameResize) return this._state(entry);
    const point = this.screen.getCursorScreenPoint();
    if (!validPoint(point)) throw new Error('无法读取当前鼠标位置。');
    const session = entry.frameResize;
    return this._applyFrameChange(entry, display => this._frameTarget(entry, session, point, display));
  }

  _applyFrameChange(entry, targetForDisplay) {
    const previous = entry.window.getBounds();
    let strictDisplay = this._display(previous), target, stable = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      target = targetForDisplay(strictDisplay);
      const display = this._display(target);
      if (displayFactor(display) <= displayFactor(strictDisplay)) { stable = true; break; }
      strictDisplay = display;
    }
    if (!stable) {
      for (const display of this.screen.getAllDisplays?.() || []) if (displayFactor(display) > displayFactor(strictDisplay)) strictDisplay = display;
      target = targetForDisplay(strictDisplay);
    }
    const oldMeta = { scale: entry.scale, mode: entry.mode, requestedSize: entry.requestedSize,
      drag: entry.drag, frameResize: entry.frameResize };
    let applied = false;
    try {
      entry.window.setBounds(target); applied = true;
      let actual = entry.window.getBounds(), content = this._contentBounds(entry), display = this._display(actual);
      let pixels = drawnSize(content, display);
      if (pixels.width > MAX_DRAWN_EDGE || pixels.height > MAX_DRAWN_EDGE || pixels.area > MAX_DRAWN_PIXELS) {
        const nativeExtra = { extraWidth: Math.max(0, Math.ceil(content.width - target.width)),
          extraHeight: Math.max(0, Math.ceil(content.height - target.height)) };
        if (displayFactor(display) > displayFactor(strictDisplay)) strictDisplay = display;
        for (const candidate of this.screen.getAllDisplays?.() || []) if (displayFactor(candidate) > displayFactor(strictDisplay)) strictDisplay = candidate;
        target = targetForDisplay(strictDisplay);
        const edge = entry.frameResize?.edge || '';
        const size = frameSizeForDisplay(target.width, target.height, strictDisplay, { ...nativeExtra,
          horizontalOnly: /[ew]/.test(edge) && !/[ns]/.test(edge), verticalOnly: /[ns]/.test(edge) && !/[ew]/.test(edge) });
        target = this._repairInvisible({ ...target,
          x: target.x + (edge.includes('w') ? target.width - size.width : 0),
          y: target.y + (edge.includes('n') ? target.height - size.height : 0), ...size }, strictDisplay);
        entry.window.setBounds(target);
        actual = entry.window.getBounds(); content = this._contentBounds(entry); display = this._display(actual); pixels = drawnSize(content, display);
      }
      if (pixels.width > MAX_DRAWN_EDGE || pixels.height > MAX_DRAWN_EDGE || pixels.area > MAX_DRAWN_PIXELS) throw new Error('系统未能将图片窗口调整到安全的绘制尺寸。');
      entry.scale = Math.min(this._contentFitScale(entry, content), scaleLimitForDisplay(entry.photo, display));
      entry.mode = 'frame'; entry.drag = null;
      entry.requestedSize = { width: target.width, height: target.height };
    } catch (error) {
      if (applied) {
        try { entry.window.setBounds({ ...previous, ...oldMeta.requestedSize }); }
        catch (rollbackError) { this.onError(rollbackError, entry.window); }
      }
      Object.assign(entry, oldMeta);
      throw error;
    }
    this._touch(entry);
    return this._state(entry);
  }

  endFrameResize(event) {
    const entry = this._source(event);
    if (entry.frameResize) { entry.frameResize = null; this._touch(entry); }
    return this._state(entry);
  }

  refreshDisplays() {
    const states = [];
    for (const entry of this.entries.values()) {
      if (entry.window.isDestroyed()) continue;
      this._endInteractions(entry);
      const bounds = entry.window.getBounds(), display = this._display(bounds), limit = scaleLimitForDisplay(entry.photo, display);
      const pixels = drawnSize(this._contentBounds(entry), display);
      const repaired = this._repairInvisible(bounds, display);
      if (entry.scale > limit || pixels.width > MAX_DRAWN_EDGE || pixels.height > MAX_DRAWN_EDGE || pixels.area > MAX_DRAWN_PIXELS) {
        if (entry.mode === 'frame') {
          states.push(this._applyFrameChange(entry, targetDisplay => {
            const size = frameSizeForDisplay(bounds.width, bounds.height, targetDisplay);
            return this._repairInvisible({ ...size, x: Math.round(bounds.x + (bounds.width - size.width) / 2),
              y: Math.round(bounds.y + (bounds.height - size.height) / 2) }, targetDisplay);
          }));
        } else states.push(this._applyResize(entry, Math.min(entry.scale, limit), entry.mode, null));
      } else {
        if (Object.keys(repaired).some(key => repaired[key] !== bounds[key])) entry.window.setBounds({ ...repaired, ...entry.requestedSize });
        entry.drag = null;
        this._touch(entry);
        states.push(this._state(entry));
      }
    }
    return states;
  }

  showMenu(event) {
    const entry = this._source(event);
    this._endInteractions(entry);
    const action = callback => () => { try { return callback(); } catch (error) { this.onError(error, entry.window); } };
    const template = [
      { label: '放大', click: action(() => this.resize(this._eventFor(entry), { scale: this._state(entry).scale * 1.25 })) },
      { label: '缩小', click: action(() => this.resize(this._eventFor(entry), { scale: this._state(entry).scale / 1.25 })) },
      { label: '适应屏幕', click: action(() => this.resize(this._eventFor(entry), { mode: 'fit' })) },
      { label: '1:1', click: action(() => this.resize(this._eventFor(entry), { mode: 'actual' })) },
      { type: 'separator' },
      { label: '置顶', type: 'checkbox', checked: entry.window.isAlwaysOnTop(), click: item => {
        try { return this.setAlwaysOnTop(this._eventFor(entry), item.checked); } catch (error) { this.onError(error, entry.window); }
      } },
      { label: '关闭', click: action(() => entry.window.close()) }
    ];
    const menu = this.Menu.buildFromTemplate(template);
    this.lastMenu = { windowId: entry.window.id, menu, actions: new Map(template.filter(item => item.label).map(item => [item.label, item.click])) };
    if (this.popupMenus) menu.popup({ window: entry.window });
    return this.getLastMenu();
  }

  getLastMenu() { return this.lastMenu ? { windowId: this.lastMenu.windowId,
    labels: this.lastMenu.menu.items.map(item => item.label).filter(Boolean),
    checked: Object.fromEntries(this.lastMenu.menu.items.filter(item => item.type === 'checkbox').map(item => [item.label, item.checked])) } : null; }

  chooseMenu(windowId, label) {
    if (this.lastMenu?.windowId !== windowId || !this.entries.has(windowId)) throw new Error('图片菜单窗口不匹配。');
    const item = this.lastMenu.menu.items.find(candidate => candidate.label === label);
    const callback = this.lastMenu.actions.get(label);
    if (!item || typeof callback !== 'function') throw new Error('图片菜单项目无效。');
    if (item.type === 'checkbox') item.checked = !this.entries.get(windowId).window.isAlwaysOnTop();
    return callback(item, this.entries.get(windowId).window);
  }
}

module.exports = { PhotoWindows };
