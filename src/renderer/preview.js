'use strict';

(() => {
  const api = window.rack;
  const stage = document.getElementById('imageStage');
  const world = document.getElementById('imageWorld');
  const image = document.getElementById('previewImage');
  const loading = document.getElementById('loadingMessage');
  const errorMessage = document.getElementById('previewError');
  const capturedAt = document.getElementById('capturedAt');
  const dimensions = document.getElementById('imageDimensions');
  const zoomLevel = document.getElementById('zoomLevel');
  const fitButton = document.getElementById('fitButton');
  const actualButton = document.getElementById('actualButton');
  const zoomIn = document.getElementById('zoomIn');
  const zoomOut = document.getElementById('zoomOut');
  const pinButton = document.getElementById('previewPinButton');
  const closeButton = document.getElementById('closeButton');
  const footer = document.querySelector('.preview-footer');
  const interactiveSelector = 'button, a, input, textarea, select, [contenteditable], [role="button"], [data-interactive]';
  const resizeEdgeSelector = '[data-preview-resize-edge]';
  const resizeCursors = Object.freeze({ n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' });
  let photo;
  let state;
  let loaded = false;
  let closing = false;
  let disposed = false;
  let drag;
  let moveFrame = null;
  let layoutFrame = null;
  let resizePromise = null;
  let latestResize = null;
  let requestedScale = null;
  let pinPromise = null;
  let unsubscribe;

  const live = () => !disposed && !closing;
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(value, maximum));
  const validRect = rect => rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))
    && rect.width > 0 && rect.height > 0;

  function showError(message, fatal = false) {
    if (!live()) return;
    const text = message || '暂时无法完成操作，请重试。';
    if (fatal) {
      loading.textContent = text;
      loading.classList.add('is-error');
      loading.hidden = false;
      world.hidden = true;
    } else {
      errorMessage.textContent = text;
      errorMessage.title = text;
      errorMessage.hidden = false;
    }
  }

  function clearError() { if (live()) errorMessage.hidden = true; }

  function scaleBounds() {
    const maximum = Number.isFinite(state?.scaleLimit) && state.scaleLimit > 0 ? state.scaleLimit : 16;
    const minimum = Number.isFinite(state?.minScale) && state.minScale > 0 ? Math.min(state.minScale, maximum) : .001;
    return { minimum, maximum };
  }

  function constrainedScale(value) {
    const { minimum, maximum } = scaleBounds();
    return clamp(value, minimum, maximum);
  }

  function renderState() {
    if (!state || disposed) return;
    // 主进程坐标以原生 DIP 为准；客户区边界的取整差异只在这里映射。
    const ratioX = innerWidth / state.bounds.width, ratioY = innerHeight / state.bounds.height;
    const imageRect = state.image, visible = state.visibleArea;
    world.style.left = `${imageRect.x * ratioX - stage.offsetLeft}px`;
    world.style.top = `${imageRect.y * ratioY - stage.offsetTop}px`;
    world.style.width = `${imageRect.width * ratioX}px`;
    world.style.height = `${imageRect.height * ratioY}px`;
    const left = clamp(visible.x * ratioX, 0, innerWidth), top = clamp(visible.y * ratioY, 0, innerHeight);
    const right = clamp((visible.x + visible.width) * ratioX, left, innerWidth);
    const bottom = clamp((visible.y + visible.height) * ratioY, top, innerHeight);
    const visibleWidth = Math.max(0, right - left - 2), visibleHeight = Math.max(0, bottom - top - 2);
    const styles = document.body.style;
    styles.setProperty('--visible-left', `${left + 1}px`);
    styles.setProperty('--visible-top', `${top + 1}px`);
    styles.setProperty('--visible-right', `${Math.max(1, innerWidth - right + 1)}px`);
    styles.setProperty('--visible-bottom', `${Math.max(1, innerHeight - bottom + 1)}px`);
    styles.setProperty('--visible-width', `${visibleWidth}px`);
    styles.setProperty('--visible-height', `${visibleHeight}px`);
    const compact = visible.width * ratioX < 240 || visible.height * ratioY < 96;
    document.body.classList.toggle('is-compact', compact);
    document.body.classList.toggle('has-small-visible-area', visible.width * ratioX < 400);
    footer.hidden = compact;
    zoomLevel.textContent = `${Number((state.scale * 100).toFixed(1))}%`;
    fitButton.classList.toggle('is-active', state.mode === 'fit');
    actualButton.classList.toggle('is-active', state.mode === 'actual');
    for (const button of [zoomIn, zoomOut, fitButton, actualButton]) button.disabled = !loaded || !live();
    pinButton.disabled = !live() || !!pinPromise;
    pinButton.classList.toggle('is-pinned', state.alwaysOnTop);
    pinButton.setAttribute('aria-pressed', String(state.alwaysOnTop));
    pinButton.title = state.alwaysOnTop ? '取消置顶（仅当前图片）' : '置顶（仅当前图片）';
    pinButton.setAttribute('aria-label', pinButton.title);
    document.getElementById('previewSource').textContent = state.alwaysOnTop
      ? '当前图片已置顶 · 按住移动' : '按住图片移动 · 滚轮同步缩放';
  }

  function applyState(next) {
    if (!live()) return false;
    if (!next || !validRect(next.bounds) || !validRect(next.image) || !validRect(next.visibleArea)
      || !Number.isFinite(next.scale) || next.scale <= 0 || !Number.isSafeInteger(next.revision)
      || !['fit', 'actual', 'manual', 'frame'].includes(next.mode) || typeof next.alwaysOnTop !== 'boolean') {
      showError('图片窗口状态暂时无法读取，请关闭后重试。');
      return false;
    }
    if (photo && next.id !== photo.id) return false;
    if (state && next.revision < state.revision) return false;
    state = next;
    // 屏幕/DPI 改变会调整限值；待发送目标也及时收紧，避免反向滚轮被旧越界意图吞掉。
    if (requestedScale !== null) requestedScale = constrainedScale(requestedScale);
    if (Number.isFinite(latestResize?.scale)) {
      latestResize = { ...latestResize, scale: constrainedScale(latestResize.scale) };
      requestedScale = latestResize.scale;
    }
    renderState();
    return true;
  }

  function stopDrag(event, flushMove = false) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    const current = drag;
    drag = null;
    if (moveFrame !== null) {
      cancelAnimationFrame(moveFrame);
      moveFrame = null;
      if (flushMove && live()) {
        try { current.kind === 'resize' ? api.movePreviewResize() : api.movePreviewDrag(); }
        catch (error) { showError(error?.message); }
      }
    }
    document.body.classList.remove('is-dragging', 'is-resizing');
    document.body.style.removeProperty('--preview-resize-cursor');
    try { if (document.body.hasPointerCapture(current.pointerId)) document.body.releasePointerCapture(current.pointerId); }
    catch { /* 失去捕获或窗口关闭时，仍须结束主进程拖动。 */ }
    try { current.kind === 'resize' ? api.endPreviewResize() : api.endPreviewDrag(); }
    catch (error) { showError(error?.message); }
  }

  function pumpResize() {
    if (!live() || !loaded || !latestResize || resizePromise) return;
    const payload = latestResize;
    latestResize = null;
    resizePromise = Promise.resolve().then(() => api.resizePreview(payload)).then(next => {
      if (!live()) return;
      if (applyState(next)) clearError();
      // 无后续用户意图时，以真正提交的缩放值继续滚动；不能覆盖新排队目标。
      if (!latestResize && state) requestedScale = state.scale;
    }).catch(error => showError(error?.message || '图片和窗口未能缩放，请重试。')).finally(() => {
      resizePromise = null;
      if (!live()) { latestResize = null; requestedScale = null; return; }
      if (latestResize) pumpResize();
      else requestedScale = null;
    });
  }

  function requestResize(payload) {
    if (!live() || !loaded || !state) return;
    stopDrag();
    latestResize = Number.isFinite(payload.scale) ? { ...payload, scale: constrainedScale(payload.scale) } : payload;
    requestedScale = Number.isFinite(latestResize.scale) ? latestResize.scale : payload.mode === 'actual' ? constrainedScale(1) : null;
    pumpResize();
  }

  function zoom(factor, anchor) {
    if (!live() || !loaded || !state) return;
    const base = constrainedScale(requestedScale ?? state.scale);
    const scale = constrainedScale(base * factor);
    if (Math.abs(scale - base) < .0000001) return;
    requestResize({ scale, ...(anchor ? { anchor } : {}) });
  }

  function close() {
    if (!live() || !api) return;
    stopDrag();
    closing = true;
    latestResize = null;
    requestedScale = null;
    renderState();
    Promise.resolve().then(() => api.closePreview()).catch(error => {
      if (disposed) return;
      closing = false;
      renderState();
      showError(error?.message || '关闭图片窗口失败，请重试。');
    });
  }

  function togglePin() {
    if (!live() || !state || pinPromise) return;
    stopDrag();
    const value = !state.alwaysOnTop;
    pinPromise = Promise.resolve().then(() => api.setPreviewAlwaysOnTop(value)).then(next => {
      if (applyState(next)) clearError();
    }).catch(error => showError(error?.message || '置顶状态未能修改，请重试。')).finally(() => {
      pinPromise = null;
      if (!disposed) renderState();
    });
    renderState();
  }

  closeButton.addEventListener('click', close);
  pinButton.addEventListener('click', togglePin);
  zoomIn.addEventListener('click', () => zoom(1.25));
  zoomOut.addEventListener('click', () => zoom(1 / 1.25));
  fitButton.addEventListener('click', () => requestResize({ mode: 'fit' }));
  actualButton.addEventListener('click', () => requestResize({ mode: 'actual' }));

  document.body.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag || !live() || !api || event.target.closest(interactiveSelector)) return;
    const handle = event.target.closest(resizeEdgeSelector);
    const edge = handle?.dataset.previewResizeEdge;
    if (handle && !Object.hasOwn(resizeCursors, edge)) return;
    const kind = handle ? 'resize' : 'move';
    event.preventDefault();
    try {
      document.body.setPointerCapture(event.pointerId);
      drag = { pointerId: event.pointerId, kind, edge };
      document.body.classList.toggle('is-dragging', kind === 'move');
      document.body.classList.toggle('is-resizing', kind === 'resize');
      if (kind === 'resize') {
        latestResize = null; requestedScale = null;
        document.body.style.setProperty('--preview-resize-cursor', resizeCursors[edge]);
        api.beginPreviewResize(edge);
      } else api.beginPreviewDrag();
    } catch (error) { stopDrag(); showError(error?.message || '暂时无法调整窗口，请重试。'); }
  });
  document.body.addEventListener('pointermove', event => {
    if (drag && event.pointerId === drag.pointerId && !(event.buttons & 1)) { stopDrag(); return; }
    if (!drag || event.pointerId !== drag.pointerId || moveFrame !== null || !live()) return;
    moveFrame = requestAnimationFrame(() => {
      moveFrame = null;
      if (!drag || !live()) return;
      try { drag.kind === 'resize' ? api.movePreviewResize() : api.movePreviewDrag(); }
      catch (error) { stopDrag(); showError(error?.message); }
    });
  });
  document.body.addEventListener('pointerup', event => stopDrag(event, true));
  document.body.addEventListener('pointercancel', event => stopDrag(event));
  document.body.addEventListener('lostpointercapture', event => stopDrag(event));
  window.addEventListener('blur', () => stopDrag());

  document.body.addEventListener('wheel', event => {
    event.preventDefault();
    if (!live() || !loaded || !state) return;
    const rect = image.getBoundingClientRect();
    const delta = (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX)
      * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? 300 : 1);
    const anchor = { x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((event.clientY - rect.top) / rect.height, 0, 1) };
    zoom(Math.exp(-clamp(delta, -240, 240) * .002), anchor);
  }, { passive: false });
  document.body.addEventListener('dblclick', event => {
    if (event.target.closest(interactiveSelector) || event.target.closest(resizeEdgeSelector)) return;
    event.preventDefault();
    requestResize({ mode: state?.mode === 'actual' ? 'fit' : 'actual' });
  });
  document.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (!live() || !api) return;
    stopDrag();
    Promise.resolve().then(() => api.showPreviewMenu()).catch(error => showError(error?.message || '暂时无法打开图片菜单。'));
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.25); }
    else if (event.key === '-' || event.key === '_') { event.preventDefault(); zoom(1 / 1.25); }
    else if (event.key === '0') { event.preventDefault(); requestResize({ mode: 'fit' }); }
    else if (event.key === '1') { event.preventDefault(); requestResize({ mode: 'actual' }); }
  });
  window.addEventListener('resize', () => {
    if (layoutFrame !== null || disposed) return;
    layoutFrame = requestAnimationFrame(() => { layoutFrame = null; renderState(); });
  });
  window.addEventListener('beforeunload', () => {
    stopDrag();
    closing = true; disposed = true; latestResize = null;
    if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
    if (unsubscribe) unsubscribe();
  });

  async function load() {
    if (!api) { showError('请在截图晾衣架中打开这张图片', true); return; }
    try {
      unsubscribe = api.onPreviewState(next => applyState(next));
      photo = await api.getPreview();
      if (!live()) return;
      if (!photo?.url) throw new Error('这张截图暂时无法读取');
      if (!applyState(photo.state) && !state) throw new Error('图片窗口状态暂时无法读取');
      const floating = photo.floating === true;
      document.body.classList.toggle('is-floating', floating);
      document.getElementById('previewTitle').textContent = floating ? '悬浮图片' : '截图预览';
      closeButton.title = floating ? '关闭悬浮 · Esc（衣架上的截图仍保留）' : '关闭预览 · Esc';
      closeButton.setAttribute('aria-label', floating ? '关闭悬浮图片' : '关闭预览');
      const date = new Date(photo.capturedAt);
      if (Number.isFinite(date.getTime())) {
        capturedAt.textContent = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
      }
      await new Promise((resolve, reject) => {
        const success = () => { image.removeEventListener('error', failure); resolve(); };
        const failure = () => { image.removeEventListener('load', success); reject(new Error('无法读取截图原图，请关闭后重试')); };
        image.addEventListener('load', success, { once: true });
        image.addEventListener('error', failure, { once: true });
        image.src = photo.url;
      });
      if (!live()) return;
      const width = image.naturalWidth || Number(photo.width), height = image.naturalHeight || Number(photo.height);
      if (!width || !height) throw new Error('截图尺寸无效');
      loaded = true;
      dimensions.textContent = `${width.toLocaleString('zh-CN')} × ${height.toLocaleString('zh-CN')} px`;
      document.title = `${floating ? '悬浮图片' : '截图预览'} · ${width} × ${height}`;
      loading.hidden = true;
      world.hidden = false;
      renderState();
      clearError();
    } catch (error) { showError(error?.message, !loaded); }
  }
  load();
})();
