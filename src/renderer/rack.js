'use strict';

(() => {
  const api = window.rack;
  const scroll = document.getElementById('photoScroll');
  const track = document.getElementById('photoTrack');
  const empty = document.getElementById('emptyState');
  const count = document.getElementById('photoCount');
  const statusText = document.getElementById('statusText');
  const dot = document.getElementById('collectionDot');
  const app = document.querySelector('.rack-app');
  const autoHideTab = document.getElementById('autoHideTab');
  const pauseButton = document.getElementById('pauseButton');
  const pauseLabel = document.getElementById('pauseLabel');
  const pinButton = document.getElementById('pinButton');
  const autoHideButton = document.getElementById('autoHideButton');
  const autoHideSpeedControl = document.getElementById('autoHideSpeedControl');
  const speedButtons = [...autoHideSpeedControl.querySelectorAll('[data-speed]')];
  const hideButton = document.getElementById('hideButton');
  const appreciationButton = document.getElementById('appreciationButton');
  const pasteButton = document.getElementById('pasteButton');
  const pasteHint = document.getElementById('pasteHint');
  const addNoteButton = document.getElementById('addNoteButton');
  const leftButton = document.getElementById('scrollLeft');
  const rightButton = document.getElementById('scrollRight');
  const newButton = document.getElementById('newPhotoButton');
  const newLabel = document.getElementById('newPhotoLabel');
  const errorMessage = document.getElementById('errorMessage');
  const cards = new Map();
  const pendingIds = new Set();
  const dateFormatter = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  let photos = [];
  let offsets = [];
  let widths = [];
  let byId = new Map();
  let state = { paused: false, alwaysOnTop: false, autoHide: false, autoHideSpeed: 'medium', autoHidden: false, manuallyHidden: false, dragging: false };
  let initialized = false;
  let renderQueued = false;
  let interactive = false;
  let pasteHover = false;
  let drag = null;
  let pointerPosition = null;
  let unsubscribe;
  let unsubscribePhotoDrag;
  let photoDragStarted = false;
  let expandedScrollLeft = 0;
  let pastePromise = null;

  function safeDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function photoWidth(photo) {
    if (photo.type === 'note') return 170;
    const ratio = Number(photo.width) / Number(photo.height);
    return Math.round(Math.max(128, Math.min(187, (Number.isFinite(ratio) ? ratio : 1.4) * 101 + 16)));
  }

  function indexAt(position) {
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (offsets[middle] <= position) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  function makeCard(photo, index) {
    if (photo.type === 'note') return makeNoteCard(photo, index);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'photo-card';
    card.dataset.testid = 'photo-card';
    card.dataset.interactive = '';
    card.dataset.photoId = photo.id;
    card.dataset.itemType = 'photo';
    card.draggable = true;
    const date = safeDate(photo.capturedAt);
    card.title = `${date ? dateFormatter.format(date) : '截图'} · ${photo.width} × ${photo.height}\n点击放大 · 拖到聊天／文件夹 · 右键更多`;
    card.setAttribute('aria-label', card.title);
    const clip = document.createElement('span');
    clip.className = 'wooden-clip';
    clip.setAttribute('aria-hidden', 'true');
    const imageWrap = document.createElement('span');
    imageWrap.className = 'photo-image-wrap';
    const image = document.createElement('img');
    if (photo.thumbnailUrl) image.src = photo.thumbnailUrl;
    image.alt = '已收集的截图';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.draggable = true;
    imageWrap.append(image);
    const caption = document.createElement('span');
    caption.className = 'photo-caption';
    const time = document.createElement('time');
    time.textContent = date ? dateFormatter.format(date).replace(' ', ' · ') : '刚刚收集';
    if (date) time.dateTime = date.toISOString();
    const number = document.createElement('span');
    number.className = 'photo-number';
    caption.append(time, number);
    card.append(clip, imageWrap, caption);
    card.addEventListener('pointerdown', event => {
      photoDragStarted = false;
      if (event.button === 0 && api) api.preparePhotoDrag(photo.id).catch(() => {});
    });
    card.addEventListener('click', event => {
      if (photoDragStarted) { event.preventDefault(); photoDragStarted = false; return; }
      runAction(() => api.openPreview(photo.id));
    });
    card.addEventListener('dragstart', event => {
      event.preventDefault();
      photoDragStarted = true;
      if (api) {
        setInteractive(true);
        runAction(() => api.dragPhoto(photo.id));
      }
    });
    card.addEventListener('dragend', () => {
      refreshInteractive();
    });
    card.addEventListener('contextmenu', event => {
      event.preventDefault();
      if (api) runAction(() => api.showPhotoMenu(photo.id));
    });
    positionCard(card, index);
    return card;
  }

  function noteInk(color) {
    const hex = /^#[\da-f]{6}$/i.test(color || '') ? color : '#fff2b8';
    const luminance = value => {
      const channels = [1, 3, 5].map(start => parseInt(value.slice(start, start + 2), 16) / 255);
      const linear = channels.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
      return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
    };
    const background = luminance(hex);
    const contrast = value => {
      const foreground = luminance(value);
      return (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05);
    };
    if (contrast('#39352e') >= 4.5) return '#39352e';
    if (contrast('#fffdf7') >= 4.5) return '#fffdf7';
    return '#000000';
  }

  function updateNoteCard(card, note) {
    const color = /^#[\da-f]{6}$/i.test(note.color || '') ? note.color : '#fff2b8';
    card.style.setProperty('--note-color', color);
    card.style.setProperty('--note-ink', noteInk(color));
    card.querySelector('.note-preview').textContent = typeof note.text === 'string' ? note.text : '';
    card.setAttribute('aria-label', `便签：${(note.text || '').slice(0, 80)}，点击打开编辑`);
    const date = safeDate(note.createdAt || note.capturedAt || note.updatedAt);
    const time = card.querySelector('time');
    time.textContent = date ? dateFormatter.format(date).replace(' ', ' · ') : '便签';
    if (date) time.dateTime = date.toISOString();
  }

  function makeNoteCard(note, index) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'photo-card note-card';
    card.dataset.testid = 'note-card';
    card.dataset.interactive = '';
    card.dataset.noteId = note.id;
    card.dataset.itemType = 'note';
    card.draggable = false;
    card.title = '便签 · 点击打开编辑，可同时打开多张 · 右键删除';
    const clip = document.createElement('span');
    clip.className = 'wooden-clip';
    clip.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'note-kind';
    label.textContent = '便签';
    const preview = document.createElement('span');
    preview.className = 'note-preview';
    const caption = document.createElement('span');
    caption.className = 'photo-caption';
    const time = document.createElement('time');
    const number = document.createElement('span');
    number.className = 'photo-number';
    caption.append(time, number);
    card.append(clip, label, preview, caption);
    card.addEventListener('click', () => runAction(() => api.openNote(note.id)));
    card.addEventListener('contextmenu', event => {
      event.preventDefault();
      if (api) runAction(() => api.showNoteMenu(note.id));
    });
    updateNoteCard(card, note);
    positionCard(card, index);
    return card;
  }

  function positionCard(card, index) {
    card.style.left = `${offsets[index]}px`;
    card.style.width = `${widths[index]}px`;
    card.style.setProperty('--rotation', `${[-1.7, 1.2, -0.6, 1.8, -1.1, 0.5][index % 6]}deg`);
    card.querySelector('.photo-number').textContent = String(photos.length - index).padStart(2, '0');
  }

  function renderVisible() {
    renderQueued = false;
    const left = scroll.scrollLeft - 220;
    const right = scroll.scrollLeft + scroll.clientWidth + 220;
    const visible = new Set();
    if (photos.length && !state.autoHidden && !state.manuallyHidden) {
      let index = indexAt(Math.max(0, left));
      for (; index < photos.length && offsets[index] < right; index += 1) {
        const photo = photos[index];
        if (offsets[index] + widths[index] < left) continue;
        visible.add(photo.id);
        let card = cards.get(photo.id);
        if (!card) {
          card = makeCard(photo, index);
          cards.set(photo.id, card);
          track.append(card);
        } else {
          positionCard(card, index);
          if (photo.type === 'note') updateNoteCard(card, photo);
        }
      }
    }
    for (const [id, card] of cards) {
      if (!visible.has(id)) {
        card.querySelector('img')?.removeAttribute('src');
        card.remove();
        cards.delete(id);
      }
    }
    leftButton.disabled = scroll.scrollLeft < 2 || !photos.length;
    rightButton.disabled = scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - 2 || !photos.length;
    leftButton.hidden = rightButton.hidden = !photos.length;
    if (scroll.scrollLeft < 28 && pendingIds.size) {
      pendingIds.clear();
      updateNewButton();
    }
  }

  function scheduleRender() {
    if (!renderQueued) {
      renderQueued = true;
      window.requestAnimationFrame(renderVisible);
    }
  }

  function updateNewButton() {
    newButton.hidden = pendingIds.size === 0;
    const hasNote = [...pendingIds].some(id => photos[byId.get(id)]?.type === 'note');
    newLabel.textContent = hasNote ? `${pendingIds.size} 张新内容` : `${pendingIds.size} 张新截图`;
  }

  function showError(message) {
    errorMessage.textContent = message || '操作未完成，请稍后重试';
    errorMessage.hidden = false;
  }

  function applySnapshot(snapshot) {
    if (!snapshot || (!Array.isArray(snapshot.items) && !Array.isArray(snapshot.photos))) return;
    const oldIds = new Set(photos.map(photo => photo.id));
    const oldPosition = state.autoHidden ? expandedScrollLeft : scroll.scrollLeft;
    const anchorIndex = photos.length ? indexAt(oldPosition) : 0;
    const anchor = photos[anchorIndex];
    const anchorDelta = anchor ? oldPosition - offsets[anchorIndex] : 0;
    photos = (Array.isArray(snapshot.items) ? snapshot.items : snapshot.photos).filter(photo => photo && typeof photo.id === 'string');
    byId = new Map();
    offsets = [];
    widths = [];
    let offset = 10;
    photos.forEach((photo, index) => {
      byId.set(photo.id, index);
      offsets.push(offset);
      const width = photoWidth(photo);
      widths.push(width);
      offset += width + 24;
      if (initialized && !oldIds.has(photo.id) && oldPosition > 28) pendingIds.add(photo.id);
    });
    track.style.width = `${Math.max(scroll.clientWidth, offset - 14)}px`;
    const restoredPosition = initialized && oldPosition > 28 && anchor && byId.has(anchor.id)
      ? offsets[byId.get(anchor.id)] + anchorDelta : 0;
    for (const id of pendingIds) if (!byId.has(id)) pendingIds.delete(id);
    state = {
      paused: !!snapshot.state?.paused,
      alwaysOnTop: !!snapshot.state?.alwaysOnTop,
      autoHide: !!snapshot.state?.autoHide,
      autoHideSpeed: ['fast', 'medium', 'slow'].includes(snapshot.state?.autoHideSpeed) ? snapshot.state.autoHideSpeed : 'medium',
      autoHidden: !!snapshot.state?.autoHidden,
      manuallyHidden: !!snapshot.state?.manuallyHidden,
      dragging: !!snapshot.state?.dragging,
      pasteShortcutAvailable: !!snapshot.state?.pasteShortcutAvailable,
      pasteShortcutBlocked: !!snapshot.state?.pasteShortcutBlocked
    };
    if (state.autoHidden || state.manuallyHidden) setPasteHover(false);
    app.hidden = state.autoHidden;
    expandedScrollLeft = restoredPosition;
    if (!state.autoHidden) scroll.scrollLeft = restoredPosition;
    autoHideTab.hidden = !state.autoHidden;
    document.body.classList.toggle('is-auto-hidden', state.autoHidden);
    document.body.classList.toggle('is-dragging', !!drag || state.dragging);
    const noteCount = photos.filter(photo => photo.type === 'note').length;
    count.textContent = noteCount ? `${photos.length - noteCount} 图 · ${noteCount} 便签` : `${photos.length} 张`;
    empty.hidden = photos.length > 0;
    pauseButton.setAttribute('aria-pressed', String(state.paused));
    pauseButton.setAttribute('aria-label', state.paused ? '继续自动收集' : '暂停自动收集');
    pauseButton.title = state.paused ? '继续收集，此刻剪贴板里已有的图片会跳过' : '暂停自动收集';
    pauseLabel.textContent = state.paused ? '继续' : '暂停';
    pasteHint.textContent = state.pasteShortcutBlocked ? '点击粘贴按钮挂图' : state.paused ? '暂停中 · 仍可 Ctrl+V 粘贴' : '悬停衣架 · Ctrl+V 粘贴';
    pasteButton.title = state.pasteShortcutBlocked
      ? 'Ctrl+V 暂时无法使用，请点击粘贴图片。暂停收集时仍可使用。'
      : '复制图片后，将鼠标移到晾衣架，按 Ctrl+V；也可以点击粘贴。暂停收集时仍可使用。';
    pasteButton.classList.toggle('shortcut-ready', state.pasteShortcutAvailable);
    pinButton.setAttribute('aria-pressed', String(state.alwaysOnTop));
    pinButton.title = state.alwaysOnTop ? '取消始终置顶' : '将晾衣架固定在所有窗口上方';
    autoHideButton.setAttribute('aria-pressed', String(state.autoHide));
    autoHideButton.setAttribute('aria-label', state.autoHide ? '关闭自动隐藏' : '开启自动隐藏');
    const speedDescription = { fast: '立即', medium: '1 秒后', slow: '2 秒后' }[state.autoHideSpeed];
    autoHideButton.title = state.autoHide ? `关闭自动隐藏（当前：鼠标离开${speedDescription}收起）` : `开启自动隐藏：鼠标离开${speedDescription}收起到屏幕顶部`;
    autoHideSpeedControl.hidden = !state.autoHide;
    for (const button of speedButtons) button.setAttribute('aria-pressed', String(button.dataset.speed === state.autoHideSpeed));
    dot.classList.toggle('paused', state.paused);
    dot.classList.toggle('error', snapshot.status?.level === 'error');
    statusText.textContent = snapshot.status?.message || (state.paused ? '已暂停收集' : photos.length ? '自动收集中' : '等一张新截图');
    if (snapshot.status?.level === 'error') showError(snapshot.status.message);
    else errorMessage.hidden = true;
    updateNewButton();
    initialized = true;
    renderVisible();
    refreshInteractive();
  }

  async function runAction(action, button) {
    if (!api) return;
    if (button) button.disabled = true;
    try { await action(); }
    catch (error) { showError(error?.message || '操作未完成，请稍后重试'); }
    finally { if (button) button.disabled = false; }
  }

  function pasteClipboard() {
    if (!api || pastePromise || state.autoHidden || state.manuallyHidden || state.dragging || drag) return;
    pastePromise = runAction(() => api.pasteClipboard(), pasteButton);
    pastePromise.finally(() => { pastePromise = null; });
  }

  function setInteractive(next) {
    if (drag) next = true;
    if (interactive === next) return;
    interactive = next;
    if (api) api.setInteractive(next);
  }

  function setPasteHover(next) {
    next = !!next;
    if (pasteHover === next) return;
    pasteHover = next;
    if (api && typeof api.setPasteHover === 'function') api.setPasteHover(next);
  }

  function rememberPointer(event) {
    pointerPosition = { x: event.screenX, y: event.screenY };
  }

  function refreshInteractive() {
    if (drag) { setInteractive(true); return; }
    if (!pointerPosition || state.autoHidden || state.manuallyHidden) { setInteractive(false); return; }
    const x = pointerPosition.x - window.screenX;
    const y = pointerPosition.y - window.screenY;
    const element = document.elementFromPoint(x, y);
    setInteractive(!!element?.closest('[data-interactive]'));
  }

  function finishDrag(event) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    if (event) rememberPointer(event);
    const current = drag;
    drag = null;
    document.body.classList.remove('is-dragging');
    if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
    if (api) api.endDrag();
    refreshInteractive();
  }

  for (const handle of document.querySelectorAll('[data-drag-handle]')) {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || drag || !api || state.autoHidden) return;
      event.preventDefault();
      rememberPointer(event);
      handle.setPointerCapture(event.pointerId);
      drag = { handle, pointerId: event.pointerId };
      setInteractive(true);
      document.body.classList.add('is-dragging');
      api.beginDrag({ x: event.screenX, y: event.screenY });
    });
    handle.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      rememberPointer(event);
      api.moveDrag({ x: event.screenX, y: event.screenY });
    });
    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
    handle.addEventListener('lostpointercapture', finishDrag);
  }
  document.addEventListener('pointermove', event => {
    rememberPointer(event);
    setPasteHover(!state.autoHidden && !state.manuallyHidden && event.clientX >= 0 && event.clientY >= 0 && event.clientX < window.innerWidth && event.clientY < window.innerHeight);
    refreshInteractive();
  }, { passive: true });
  document.addEventListener('mouseleave', () => { setPasteHover(false); if (!drag) setInteractive(false); });
  document.documentElement.addEventListener('pointerleave', () => setPasteHover(false));
  window.addEventListener('blur', () => { setPasteHover(false); if (!drag) setInteractive(false); });
  window.addEventListener('pagehide', () => setPasteHover(false));
  document.addEventListener('visibilitychange', () => { if (document.hidden) setPasteHover(false); });
  document.addEventListener('wheel', event => {
    if (!event.target.closest('.photo-card') || event.ctrlKey) return;
    event.preventDefault();
    const amount = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    scroll.scrollLeft += amount * (event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? scroll.clientWidth : 1);
  }, { passive: false });
  scroll.addEventListener('scroll', scheduleRender, { passive: true });
  new ResizeObserver(() => {
    if (photos.length) track.style.width = `${Math.max(scroll.clientWidth, offsets.at(-1) + widths.at(-1) + 10)}px`;
    scheduleRender();
  }).observe(scroll);
  leftButton.addEventListener('click', () => scroll.scrollBy({ left: -Math.max(180, scroll.clientWidth * .7), behavior: 'smooth' }));
  rightButton.addEventListener('click', () => scroll.scrollBy({ left: Math.max(180, scroll.clientWidth * .7), behavior: 'smooth' }));
  newButton.addEventListener('click', () => {
    pendingIds.clear();
    updateNewButton();
    scroll.scrollTo({ left: 0, behavior: 'smooth' });
  });
  pauseButton.addEventListener('click', () => runAction(() => api.setPaused(!state.paused), pauseButton));
  pinButton.addEventListener('click', () => runAction(() => api.setAlwaysOnTop(!state.alwaysOnTop), pinButton));
  autoHideButton.addEventListener('click', () => runAction(() => api.setAutoHide(!state.autoHide), autoHideButton));
  for (const button of speedButtons) {
    button.addEventListener('click', () => runAction(() => api.setAutoHideSpeed(button.dataset.speed), button));
  }
  hideButton.addEventListener('click', () => runAction(() => api.hide(), hideButton));
  appreciationButton.addEventListener('click', () => runAction(() => api.openAppreciation(), appreciationButton));
  pasteButton.addEventListener('click', pasteClipboard);
  addNoteButton.addEventListener('click', () => runAction(() => api.addNote(), addNoteButton));
  document.addEventListener('keydown', event => {
    if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && (event.code === 'KeyV' || event.key.toLowerCase() === 'v')) {
      event.preventDefault();
      if (!event.repeat) pasteClipboard();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      scroll.scrollBy({ left: event.key === 'ArrowLeft' ? -200 : 200, behavior: 'smooth' });
    } else if (event.key === 'Home') scroll.scrollTo({ left: 0, behavior: 'smooth' });
    else if (event.key === 'End') scroll.scrollTo({ left: scroll.scrollWidth, behavior: 'smooth' });
  });
  if (api) {
    unsubscribe = api.onSnapshot(applySnapshot);
    unsubscribePhotoDrag = api.onPhotoDragEnd(point => {
      pointerPosition = point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
      interactive = false;
      refreshInteractive();
    });
    api.getSnapshot().then(applySnapshot).catch(error => showError(error?.message || '读取截图失败，请从托盘重新打开晾衣架'));
  }
  window.addEventListener('beforeunload', () => {
    setPasteHover(false);
    finishDrag();
    if (unsubscribe) unsubscribe();
    if (unsubscribePhotoDrag) unsubscribePhotoDrag();
  });
  renderVisible();
})();
