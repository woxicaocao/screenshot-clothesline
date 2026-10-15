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
  const autoHideOptions = autoHideButton.parentElement;
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
  const fileDropOverlay = document.getElementById('fileDropOverlay');
  const fileDropTitle = document.getElementById('fileDropTitle');
  const fileDropDescription = document.getElementById('fileDropDescription');
  const organizeInsertion = document.getElementById('organizeInsertion');
  const organizeHint = document.getElementById('organizeHint');
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
  let importPromise = null;
  let fileDropHover = false;
  let fileDropDepth = 0;
  let fileDropTimeout = null;
  let lastFileDropHeartbeat = 0;
  let organize = null;
  let organizeFrame = null;
  let layoutPending = false;
  let blockedClickId = null;
  let blockedClickUntil = 0;
  let blockedClickPointerId = null;
  let speedOpenTimer = null;
  let speedCloseTimer = null;
  let speedPointerOnButton = false;
  let speedPointerWithin = false;
  let speedKeyboardWithin = false;
  let speedPointerFocus = false;
  let speedSuppressed = false;

  function canShowAutoHideSpeed() {
    return state.autoHide && !state.autoHidden && !state.manuallyHidden && !state.dragging && !state.externalDragging && !state.importing
      && !drag && !organize && !layoutPending && !fileDropHover && !importPromise && !document.hidden;
  }

  function clearSpeedOpenTimer() {
    if (speedOpenTimer !== null) window.clearTimeout(speedOpenTimer);
    speedOpenTimer = null;
  }

  function clearSpeedCloseTimer() {
    if (speedCloseTimer !== null) window.clearTimeout(speedCloseTimer);
    speedCloseTimer = null;
  }

  function closeAutoHideSpeed(suppress = false) {
    clearSpeedOpenTimer();
    clearSpeedCloseTimer();
    if (suppress) speedSuppressed = true;
    autoHideSpeedControl.hidden = true;
    autoHideButton.setAttribute('aria-expanded', 'false');
    refreshInteractive();
  }

  function openAutoHideSpeed() {
    clearSpeedOpenTimer();
    clearSpeedCloseTimer();
    if (speedSuppressed || !canShowAutoHideSpeed()) return;
    autoHideSpeedControl.hidden = false;
    autoHideButton.setAttribute('aria-expanded', 'true');
    refreshInteractive();
  }

  function scheduleAutoHideSpeed() {
    clearSpeedCloseTimer();
    if (speedSuppressed || !canShowAutoHideSpeed() || !autoHideSpeedControl.hidden || speedOpenTimer !== null || (!speedPointerOnButton && !speedKeyboardWithin)) return;
    // Only a live hover/focus owns a timer. Snapshots do not restart its delay.
    speedOpenTimer = window.setTimeout(() => {
      speedOpenTimer = null;
      if (speedPointerOnButton || speedKeyboardWithin) openAutoHideSpeed();
    }, 500);
  }

  function scheduleSpeedClose() {
    if (!speedPointerOnButton && !speedKeyboardWithin) clearSpeedOpenTimer();
    if (speedPointerWithin || speedKeyboardWithin || speedCloseTimer !== null) return;
    // Keep the short trip from the button into the floating choices forgiving.
    speedCloseTimer = window.setTimeout(() => {
      speedCloseTimer = null;
      if (!speedPointerWithin && !speedKeyboardWithin) closeAutoHideSpeed();
    }, 160);
  }

  function resetAutoHideSpeed() {
    speedPointerOnButton = speedPointerWithin = speedKeyboardWithin = false;
    closeAutoHideSpeed(true);
  }

  autoHideButton.addEventListener('pointerenter', () => {
    speedPointerOnButton = speedPointerWithin = true;
    speedSuppressed = false;
    scheduleAutoHideSpeed();
  });
  autoHideButton.addEventListener('pointerleave', () => {
    speedPointerOnButton = false;
    if (!speedKeyboardWithin) clearSpeedOpenTimer();
  });
  autoHideOptions.addEventListener('pointerenter', () => { speedPointerWithin = true; clearSpeedCloseTimer(); });
  autoHideOptions.addEventListener('pointermove', () => { speedKeyboardWithin = false; speedPointerFocus = true; });
  autoHideOptions.addEventListener('pointerleave', () => {
    speedPointerOnButton = speedPointerWithin = false;
    scheduleSpeedClose();
  });
  autoHideOptions.addEventListener('focusin', event => {
    if (speedPointerFocus) return;
    speedKeyboardWithin = true;
    if (!autoHideOptions.contains(event.relatedTarget)) speedSuppressed = false;
    clearSpeedCloseTimer();
    if (event.target === autoHideButton) scheduleAutoHideSpeed();
  });
  autoHideOptions.addEventListener('focusout', event => {
    if (autoHideOptions.contains(event.relatedTarget)) return;
    speedKeyboardWithin = false;
    scheduleSpeedClose();
  });
  autoHideSpeedControl.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const index = Math.max(0, speedButtons.indexOf(document.activeElement));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? speedButtons.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + speedButtons.length) % speedButtons.length;
    speedButtons[next].focus();
  });
  document.addEventListener('keydown', event => {
    speedPointerFocus = false;
    if (autoHideOptions.contains(event.target)) speedKeyboardWithin = true;
  }, true);

  function safeDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function photoWidth(photo) {
    if (photo.type === 'group') return 182;
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
    if (photo.type === 'group') return makeGroupCard(photo, index);
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
    card.title = `${date ? dateFormatter.format(date) : '截图'} · ${photo.width} × ${photo.height}\n点击放大 · 拖图片主体导出原图 · 拖木夹整理／成组 · 右键更多`;
    card.setAttribute('aria-label', card.title);
    const clip = document.createElement('span');
    clip.className = 'wooden-clip';
    clip.setAttribute('aria-hidden', 'true');
    installOrganizeHandle(clip, photo.id);
    const imageWrap = document.createElement('span');
    imageWrap.className = 'photo-image-wrap';
    const image = document.createElement('img');
    if (photo.thumbnailUrl) image.src = photo.thumbnailUrl;
    image.alt = '已收集的图片';
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
      if (event.target.closest('.wooden-clip') || organize || layoutPending) return;
      photoDragStarted = false;
      if (event.button === 0 && api) api.preparePhotoDrag(photo.id).catch(() => {});
    });
    card.addEventListener('click', event => {
      if (consumeOrganizeClick(event, photo.id)) return;
      if (photoDragStarted) { event.preventDefault(); photoDragStarted = false; return; }
      runAction(() => api.openPreview(photo.id));
    });
    card.addEventListener('dragstart', event => {
      event.preventDefault();
      if (organize || event.target.closest('.wooden-clip')) return;
      photoDragStarted = true;
      closeAutoHideSpeed(true);
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
    card.title = '便签 · 点击打开编辑，可同时打开多张 · 拖木夹整理／成组 · 右键更多';
    const clip = document.createElement('span');
    clip.className = 'wooden-clip';
    clip.setAttribute('aria-hidden', 'true');
    installOrganizeHandle(clip, note.id);
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
    card.addEventListener('click', event => {
      if (!consumeOrganizeClick(event, note.id)) runAction(() => api.openNote(note.id));
    });
    card.addEventListener('contextmenu', event => {
      event.preventDefault();
      if (api) runAction(() => api.showNoteMenu(note.id));
    });
    updateNoteCard(card, note);
    positionCard(card, index);
    return card;
  }

  function updateGroupCard(card, group) {
    const isNote = group.kind === 'note';
    const groupCount = Number(group.count) || group.memberIds?.length || 0;
    card.classList.toggle('note-group', isNote);
    card.title = `${group.name} · ${groupCount} ${isNote ? '张便签' : '张图片'}\n点击浏览 · 拖木夹调整顺序 · 右键重命名／解散`;
    card.setAttribute('aria-label', card.title);
    card.querySelector('.group-name').textContent = group.name || (isNote ? '便签组' : '图片组');
    card.querySelector('.group-count').textContent = `${groupCount} ${isNote ? '张便签' : '张图片'}`;
    const covers = Array.isArray(group.covers) ? group.covers.slice(0, 3) : [];
    const signature = JSON.stringify(covers.map(cover => [cover.id, cover.thumbnailUrl, cover.color, cover.text]));
    if (card.dataset.coverSignature === signature) return;
    card.dataset.coverSignature = signature;
    const stack = card.querySelector('.group-stack');
    stack.replaceChildren();
    // Back-to-front order keeps the first member visible at the front of the stack.
    for (let index = Math.max(0, covers.length - 1); index >= 0; index -= 1) {
      const cover = covers[index];
      if (!cover) continue;
      const leaf = document.createElement('span');
      leaf.className = `group-leaf ${isNote ? 'group-note-leaf' : 'group-photo-leaf'}`;
      leaf.style.setProperty('--stack-index', String(index));
      if (isNote) {
        const color = /^#[\da-f]{6}$/i.test(cover.color || '') ? cover.color : '#fff2b8';
        leaf.style.backgroundColor = color;
        leaf.style.color = noteInk(color);
        leaf.textContent = (cover.text || '').slice(0, 90) || '空白便签';
      } else {
        const image = document.createElement('img');
        if (cover.thumbnailUrl) image.src = cover.thumbnailUrl;
        image.alt = '';
        image.draggable = false;
        image.decoding = 'async';
        leaf.append(image);
      }
      stack.append(leaf);
    }
  }

  function makeGroupCard(group, index) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'photo-card group-card';
    card.dataset.testid = 'group-card';
    card.dataset.interactive = '';
    card.dataset.groupId = group.id;
    card.dataset.itemType = 'group';
    card.draggable = false;
    const clip = document.createElement('span');
    clip.className = 'wooden-clip';
    clip.setAttribute('aria-hidden', 'true');
    installOrganizeHandle(clip, group.id);
    const stack = document.createElement('span');
    stack.className = 'group-stack';
    const caption = document.createElement('span');
    caption.className = 'group-caption';
    const name = document.createElement('span');
    name.className = 'group-name';
    const groupCount = document.createElement('span');
    groupCount.className = 'group-count';
    const number = document.createElement('span');
    number.className = 'photo-number';
    number.hidden = true;
    caption.append(name, groupCount, number);
    card.append(clip, stack, caption);
    card.addEventListener('click', event => {
      if (!consumeOrganizeClick(event, group.id)) runAction(() => api.openGroup(group.id));
    });
    card.addEventListener('contextmenu', event => {
      event.preventDefault();
      if (api) runAction(() => api.showGroupMenu(group.id));
    });
    updateGroupCard(card, group);
    positionCard(card, index);
    return card;
  }

  function consumeOrganizeClick(event, id) {
    if (!event.target.closest('.wooden-clip') && !(blockedClickId === id && (blockedClickPointerId !== null || performance.now() < blockedClickUntil))) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function setOrganizeActive(active) {
    if (api && typeof api.setOrganizeActive === 'function') api.setOrganizeActive(active);
  }

  function installOrganizeHandle(handle, id) {
    handle.title = '按住木夹左右整理；同类内容中央停留后松手成组';
    handle.draggable = false;
    handle.addEventListener('dragstart', event => { event.preventDefault(); event.stopPropagation(); });
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (!api || !api.applyLayout || organize || layoutPending || drag || state.externalDragging || fileDropHover || importPromise || state.autoHidden || state.manuallyHidden) return;
      const card = cards.get(id);
      if (!card || !byId.has(id)) return;
      const rect = card.getBoundingClientRect();
      closeAutoHideSpeed(true);
      organize = {
        id, handle, pointerId: event.pointerId,
        startX: event.clientX, startY: event.clientY,
        x: event.clientX, y: event.clientY,
        grabOffset: event.clientX - rect.left,
        started: false, target: null, hoverId: null, hoverSince: 0,
        lastHeartbeat: performance.now(), lastFrame: performance.now()
      };
      blockedClickId = id;
      blockedClickUntil = performance.now() + 600;
      photoDragStarted = false;
      rememberPointer(event);
      handle.setPointerCapture(event.pointerId);
      setPasteHover(false);
      setOrganizeActive(true);
      setInteractive(true);
      organizeFrame = window.requestAnimationFrame(organizeTick);
    });
    handle.addEventListener('pointermove', event => {
      if (!organize || organize.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      rememberPointer(event);
      organize.x = event.clientX;
      organize.y = event.clientY;
      if (!organize.started && Math.hypot(organize.x - organize.startX, organize.y - organize.startY) >= 4) {
        organize.started = true;
        document.body.classList.add('is-organizing');
      }
    });
    handle.addEventListener('pointerup', event => { void finishOrganize(event); });
    handle.addEventListener('pointercancel', event => { void finishOrganize(event, true); });
    handle.addEventListener('lostpointercapture', event => { void finishOrganize(event, true); });
  }

  function canGroup(source, target) {
    if (!source || !target || source.id === target.id || source.type === 'group') return false;
    const sourceKind = source.type === 'note' ? 'note' : 'photo';
    const targetKind = target.type === 'group' ? target.kind : target.type === 'note' ? 'note' : 'photo';
    return sourceKind === targetKind;
  }

  function updateOrganizeTarget(now) {
    if (!organize?.started) return;
    const current = organize;
    const source = photos[byId.get(current.id)];
    const rect = scroll.getBoundingClientRect();
    const x = current.x - rect.left + scroll.scrollLeft;
    const sourceCard = cards.get(current.id);
    if (sourceCard) {
      sourceCard.classList.add('is-organize-source');
      sourceCard.style.setProperty('--organize-x', `${x - current.grabOffset - offsets[byId.get(current.id)]}px`);
    }
    for (const card of cards.values()) card.classList.remove('is-group-target', 'is-group-waiting');
    if (!source || current.x < rect.left || current.x > rect.right || current.y < rect.top || current.y > rect.bottom) {
      current.target = null;
      current.hoverId = null;
      organizeInsertion.hidden = organizeHint.hidden = true;
      return;
    }
    let beforeIndex = indexAt(Math.max(0, x));
    if (x >= offsets[beforeIndex] + widths[beforeIndex] / 2) beforeIndex += 1;
    if (photos[beforeIndex]?.id === current.id) beforeIndex += 1;
    let lastIndex = photos.length - 1;
    if (photos[lastIndex]?.id === current.id) lastIndex -= 1;
    const before = photos[beforeIndex];
    const insertionX = before ? offsets[beforeIndex] - 12 : lastIndex >= 0 ? offsets[lastIndex] + widths[lastIndex] + 12 : 0;
    current.target = { type: 'move', id: current.id, beforeId: before?.id || null, groupId: null };
    organizeInsertion.style.left = `${Math.max(2, insertionX)}px`;
    organizeInsertion.hidden = false;
    organizeHint.textContent = '松手调整顺序';
    const hoverIndex = indexAt(Math.max(0, x));
    const target = photos[hoverIndex];
    const central = target && x >= offsets[hoverIndex] + widths[hoverIndex] * .28 && x <= offsets[hoverIndex] + widths[hoverIndex] * .72;
    if (central && canGroup(source, target)) {
      if (current.hoverId !== target.id) {
        current.hoverId = target.id;
        current.hoverSince = now;
      }
      const ready = now - current.hoverSince >= 350;
      cards.get(target.id)?.classList.add(ready ? 'is-group-target' : 'is-group-waiting');
      if (ready) {
        current.target = { type: 'group', sourceId: current.id, targetId: target.id };
        organizeInsertion.hidden = true;
        organizeHint.textContent = target.type === 'group' ? '松手加入此组' : '松手成组';
      } else {
        organizeHint.textContent = '停留片刻，叠放成组';
      }
    } else current.hoverId = null;
    organizeHint.style.left = `${Math.max(12, Math.min(window.innerWidth - 170, current.x - 74))}px`;
    organizeHint.style.top = `${Math.max(rect.top + 42, Math.min(rect.bottom - 31, current.y + 28))}px`;
    organizeHint.hidden = false;
  }

  function organizeTick(now) {
    organizeFrame = null;
    if (!organize) return;
    const current = organize;
    if (now - current.lastHeartbeat >= 400) {
      setOrganizeActive(true);
      current.lastHeartbeat = now;
    }
    if (current.started) {
      const rect = scroll.getBoundingClientRect();
      if (current.y >= rect.top && current.y <= rect.bottom) {
        const edge = Math.min(64, rect.width / 4);
        const direction = current.x < rect.left + edge ? -Math.min(1, (rect.left + edge - current.x) / edge)
          : current.x > rect.right - edge ? Math.min(1, (current.x - rect.right + edge) / edge) : 0;
        const elapsed = Math.min(40, Math.max(1, now - current.lastFrame));
        // The translated source can enlarge CSS scrollable overflow; only the full
        // persisted list determines the right edge, including virtualized cards.
        const logicalEnd = Math.max(scroll.clientWidth, (offsets.at(-1) || 0) + (widths.at(-1) || 0) + 10);
        const maxScroll = Math.max(0, logicalEnd - scroll.clientWidth);
        scroll.scrollLeft = Math.max(0, Math.min(maxScroll, scroll.scrollLeft + direction * elapsed * .65));
      }
      updateOrganizeTarget(now);
    }
    current.lastFrame = now;
    organizeFrame = window.requestAnimationFrame(organizeTick);
  }

  async function finishOrganize(event, cancelled = false) {
    if (!organize || (event && event.pointerId !== organize.pointerId)) return;
    if (event) {
      event.preventDefault();
      event.stopPropagation();
      rememberPointer(event);
      organize.x = event.clientX;
      organize.y = event.clientY;
    }
    if (!cancelled) updateOrganizeTarget(performance.now());
    const current = organize;
    const operation = current.started && !cancelled ? current.target : null;
    organize = null;
    if (organizeFrame !== null) window.cancelAnimationFrame(organizeFrame);
    organizeFrame = null;
    blockedClickId = current.id;
    blockedClickUntil = performance.now() + 600;
    blockedClickPointerId = cancelled ? current.pointerId : null;
    if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
    for (const card of cards.values()) {
      card.classList.remove('is-organize-source', 'is-group-target', 'is-group-waiting');
      card.style.removeProperty('--organize-x');
    }
    organizeInsertion.hidden = organizeHint.hidden = true;
    document.body.classList.remove('is-organizing');
    setOrganizeActive(false);
    scheduleRender();
    refreshInteractive();
    if (!operation) return;
    if (operation.type === 'move') {
      const sourceIndex = byId.get(operation.id);
      if ((photos[sourceIndex + 1]?.id || null) === operation.beforeId) return;
    }
    layoutPending = true;
    document.body.classList.add('is-layout-saving');
    try {
      // Persist first: a failed save leaves both the cards and their order untouched.
      await api.applyLayout(operation);
    } catch (error) {
      showError(error?.message || '布局保存失败，已恢复原来的排列');
    } finally {
      layoutPending = false;
      document.body.classList.remove('is-layout-saving');
    }
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
          else if (photo.type === 'group') updateGroupCard(card, photo);
        }
      }
    }
    // Pointer capture and the native source node survive virtualized edge scrolling.
    if (organize && byId.has(organize.id)) {
      visible.add(organize.id);
      const sourceCard = cards.get(organize.id);
      if (sourceCard) positionCard(sourceCard, byId.get(organize.id));
    }
    for (const [id, card] of cards) {
      if (!visible.has(id)) {
        for (const image of card.querySelectorAll('img')) image.removeAttribute('src');
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
    newLabel.textContent = hasNote ? `${pendingIds.size} 张新内容` : `${pendingIds.size} 张新图片`;
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
      if (initialized && photo.type !== 'group' && !oldIds.has(photo.id) && oldPosition > 28) pendingIds.add(photo.id);
    });
    track.style.width = `${Math.max(scroll.clientWidth, offset - 14)}px`;
    const preserveAnchor = initialized && (oldPosition > 28 || !!organize);
    const restoredPosition = preserveAnchor && anchor && byId.has(anchor.id)
      ? offsets[byId.get(anchor.id)] + anchorDelta : organize ? oldPosition : 0;
    for (const id of pendingIds) if (!byId.has(id)) pendingIds.delete(id);
    const autoHideWasEnabled = state.autoHide;
    state = {
      paused: !!snapshot.state?.paused,
      alwaysOnTop: !!snapshot.state?.alwaysOnTop,
      autoHide: !!snapshot.state?.autoHide,
      autoHideSpeed: ['fast', 'medium', 'slow'].includes(snapshot.state?.autoHideSpeed) ? snapshot.state.autoHideSpeed : 'medium',
      autoHidden: !!snapshot.state?.autoHidden,
      manuallyHidden: !!snapshot.state?.manuallyHidden,
      dragging: !!snapshot.state?.dragging,
      externalDragging: !!snapshot.state?.externalDragging,
      importing: !!snapshot.state?.importing,
      pasteShortcutAvailable: !!snapshot.state?.pasteShortcutAvailable,
      pasteShortcutBlocked: !!snapshot.state?.pasteShortcutBlocked
    };
    if (state.autoHidden || state.manuallyHidden) {
      setPasteHover(false);
      clearFileDropHover();
      void finishOrganize(null, true);
    }
    if (organize && !byId.has(organize.id)) void finishOrganize(null, true);
    app.hidden = state.autoHidden;
    expandedScrollLeft = restoredPosition;
    if (!state.autoHidden) scroll.scrollLeft = restoredPosition;
    autoHideTab.hidden = !state.autoHidden;
    document.body.classList.toggle('is-auto-hidden', state.autoHidden);
    document.body.classList.toggle('is-dragging', !!drag || state.dragging);
    const noteCount = Number.isFinite(snapshot.counts?.notes) ? snapshot.counts.notes : photos.filter(photo => photo.type === 'note').length;
    const photoCount = Number.isFinite(snapshot.counts?.photos) ? snapshot.counts.photos : photos.filter(photo => photo.type !== 'note' && photo.type !== 'group').length;
    const groupCount = Number.isFinite(snapshot.counts?.groups) ? snapshot.counts.groups : photos.filter(photo => photo.type === 'group').length;
    count.textContent = `${noteCount ? `${photoCount} 图 · ${noteCount} 便签` : `${photoCount} 张`}${groupCount ? ` · ${groupCount} 组` : ''}`;
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
    autoHideButton.setAttribute('aria-description', `鼠标离开${speedDescription}收起到屏幕顶部${state.autoHide ? '；悬停半秒设置隐藏时间，或按向下键打开设置' : ''}`);
    // The native title tooltip otherwise appears over the choices at the same delay.
    if (state.autoHide) autoHideButton.removeAttribute('title');
    else autoHideButton.title = `开启自动隐藏：鼠标离开${speedDescription}收起到屏幕顶部`;
    if (!canShowAutoHideSpeed()) closeAutoHideSpeed(true);
    else if (!autoHideWasEnabled) {
      // Turning it on while the pointer is already over the button starts a
      // fresh 500 ms delay; a previously disabled hover must not count.
      speedSuppressed = false;
      scheduleAutoHideSpeed();
    }
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
    if (!api || pastePromise || importPromise || fileDropHover || state.autoHidden || state.manuallyHidden || state.dragging || drag || organize || layoutPending) return;
    pastePromise = runAction(() => api.pasteClipboard(), pasteButton);
    pastePromise.finally(() => { pastePromise = null; });
  }

  function setInteractive(next) {
    if (drag || organize || fileDropHover || importPromise) next = true;
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
    if (drag || organize || fileDropHover || importPromise) { setInteractive(true); return; }
    if (!pointerPosition || state.autoHidden || state.manuallyHidden) { setInteractive(false); return; }
    const x = pointerPosition.x - window.screenX;
    const y = pointerPosition.y - window.screenY;
    const element = document.elementFromPoint(x, y);
    setInteractive(!!element?.closest('[data-interactive]'));
  }

  function hasFileDrag(event) {
    return Array.from(event.dataTransfer?.types || []).includes('Files');
  }

  function updateFileDrop() {
    const active = fileDropHover || !!importPromise;
    if (active) closeAutoHideSpeed(true);
    fileDropOverlay.hidden = !active;
    document.body.classList.toggle('is-file-drop-active', active);
    document.body.classList.toggle('is-importing', !!importPromise);
    fileDropTitle.textContent = importPromise ? '正在把图片挂上来…' : '松手，把图片挂上来';
    fileDropDescription.textContent = importPromise
      ? '保存本地副本 · 原文件保留'
      : 'PNG / JPG / JPEG / WebP · 可一次拖入多张';
    if (api) api.setFileDropActive(active);
    lastFileDropHeartbeat = performance.now();
    refreshInteractive();
  }

  function clearFileDropHover() {
    if (fileDropTimeout !== null) window.clearTimeout(fileDropTimeout);
    fileDropTimeout = null;
    fileDropDepth = 0;
    if (!fileDropHover) return;
    fileDropHover = false;
    updateFileDrop();
  }

  function keepFileDropHover(event) {
    rememberPointer(event);
    setPasteHover(false);
    if (!fileDropHover) {
      fileDropHover = true;
      updateFileDrop();
    } else if (api && performance.now() - lastFileDropHeartbeat >= 400) {
      api.setFileDropActive(true);
      lastFileDropHeartbeat = performance.now();
    }
    if (fileDropTimeout !== null) window.clearTimeout(fileDropTimeout);
    // Only a live drag has a timer; abandoned drags cannot leave the rack suspended.
    fileDropTimeout = window.setTimeout(clearFileDropHover, 1600);
  }

  async function importDroppedFiles(files) {
    if (!api || importPromise) return;
    clearFileDropHover();
    errorMessage.hidden = true;
    importPromise = (async () => {
      try {
        const result = await api.importLocalImages(files);
        if (result?.failed || result?.error || result?.unavailable) showError(result.message || '图片未能导入，请检查后重新拖入。');
        else if (result?.message) statusText.textContent = result.message;
      } catch (error) {
        showError(error?.message || '导入图片失败，请从本机文件夹重新拖入。');
      }
    })();
    updateFileDrop();
    try { await importPromise; }
    finally {
      importPromise = null;
      updateFileDrop();
    }
  }

  document.addEventListener('dragenter', event => {
    event.preventDefault();
    if (!hasFileDrag(event) || state.externalDragging || drag || organize || state.manuallyHidden) return;
    fileDropDepth += 1;
    keepFileDropHover(event);
  });
  document.addEventListener('dragover', event => {
    event.preventDefault();
    const accepted = hasFileDrag(event) && !state.externalDragging && !drag && !organize && !state.manuallyHidden && !importPromise;
    if (event.dataTransfer) event.dataTransfer.dropEffect = accepted ? 'copy' : 'none';
    if (accepted) keepFileDropHover(event);
  });
  document.addEventListener('dragleave', event => {
    if (!fileDropHover) return;
    fileDropDepth = Math.max(0, fileDropDepth - 1);
    if (fileDropDepth === 0 || event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight) clearFileDropHover();
  });
  document.addEventListener('drop', event => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files || []);
    clearFileDropHover();
    if (!files.length || state.externalDragging || drag || organize || state.manuallyHidden) return;
    if (importPromise) { showError('上一批图片正在导入，请完成后再拖入。'); return; }
    void importDroppedFiles(files);
  });
  document.addEventListener('dragend', clearFileDropHover);

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
      if (event.button !== 0 || drag || organize || !api || state.autoHidden) return;
      event.preventDefault();
      rememberPointer(event);
      handle.setPointerCapture(event.pointerId);
      closeAutoHideSpeed(true);
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
    setPasteHover(!organize && !state.autoHidden && !state.manuallyHidden && event.clientX >= 0 && event.clientY >= 0 && event.clientX < window.innerWidth && event.clientY < window.innerHeight);
    refreshInteractive();
  }, { passive: true });
  document.addEventListener('pointerdown', event => {
    speedPointerFocus = true;
    speedKeyboardWithin = false;
    if (!autoHideOptions.contains(event.target)) closeAutoHideSpeed(true);
    // A new physical press ends any cancelled gesture whose release occurred
    // outside this window; it must not suppress a later deliberate click.
    if (!organize) blockedClickPointerId = null;
  }, true);
  document.addEventListener('pointerup', event => {
    if (blockedClickPointerId !== event.pointerId) return;
    blockedClickPointerId = null;
    blockedClickUntil = performance.now() + 600;
  }, true);
  document.addEventListener('mouseleave', () => { setPasteHover(false); if (!drag && !organize) setInteractive(false); });
  document.documentElement.addEventListener('pointerleave', () => setPasteHover(false));
  window.addEventListener('blur', () => { resetAutoHideSpeed(); setPasteHover(false); clearFileDropHover(); void finishOrganize(null, true); if (!drag) setInteractive(false); });
  window.addEventListener('pagehide', () => { resetAutoHideSpeed(); setPasteHover(false); clearFileDropHover(); void finishOrganize(null, true); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { resetAutoHideSpeed(); setPasteHover(false); clearFileDropHover(); void finishOrganize(null, true); } });
  document.addEventListener('wheel', event => {
    if (!event.target.closest('#photoScroll') || event.ctrlKey) return;
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
    speedPointerFocus = false;
    if (event.key === 'Escape' && (!autoHideSpeedControl.hidden || speedOpenTimer !== null)) {
      event.preventDefault();
      event.stopPropagation();
      const returnFocus = autoHideSpeedControl.contains(document.activeElement);
      closeAutoHideSpeed(true);
      if (returnFocus) autoHideButton.focus({ preventScroll: true });
      return;
    }
    if (event.key === 'ArrowDown' && !event.altKey && !event.ctrlKey && !event.metaKey && event.target === autoHideButton && canShowAutoHideSpeed()) {
      event.preventDefault();
      speedKeyboardWithin = true;
      speedSuppressed = false;
      openAutoHideSpeed();
      speedButtons.find(button => button.getAttribute('aria-pressed') === 'true')?.focus({ preventScroll: true });
      return;
    }
    if (event.key === 'Escape' && organize) {
      event.preventDefault();
      void finishOrganize(null, true);
      return;
    }
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
    resetAutoHideSpeed();
    setPasteHover(false);
    clearFileDropHover();
    if (api) api.setFileDropActive(false);
    void finishOrganize(null, true);
    setOrganizeActive(false);
    finishDrag();
    if (unsubscribe) unsubscribe();
    if (unsubscribePhotoDrag) unsubscribePhotoDrag();
  });
  renderVisible();
})();
