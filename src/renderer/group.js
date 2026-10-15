'use strict';

(() => {
  const api = window.groupBrowser;
  const grid = document.getElementById('groupGrid');
  const scroll = document.getElementById('groupScroll');
  const name = document.getElementById('groupName');
  const count = document.getElementById('groupCount');
  const titlebar = document.getElementById('windowTitlebar');
  const help = document.getElementById('groupHelp');
  const more = document.getElementById('groupMenu');
  const pin = document.getElementById('groupPin');
  const pinLabel = document.getElementById('groupPinLabel');
  const empty = document.getElementById('groupEmpty');
  const status = document.getElementById('groupStatus');
  const errorMessage = document.getElementById('groupError');
  const selectionTools = document.getElementById('groupSelectionTools');
  const selectionCount = document.getElementById('selectionCount');
  const clearSelectionButton = document.getElementById('clearSelection');
  const selectionBox = document.getElementById('selectionBox');
  const cards = new Map();
  const selectedIds = new Set();
  let group = null;
  let signature = '';
  let organizing = null;
  let boxing = null;
  let selectionAnchor = null;
  let pendingRender = null;
  let photoDragCandidate = null;
  let saving = false;
  let pinChanging = false;
  let photoDragStarted = false;
  let suppressClickUntil = 0;
  let suppressPointerClick = false;
  let dragFrame = 0;
  let heartbeat = null;
  const unsubscribers = [];

  function layoutTitlebar() {
    let available = Math.max(0, window.innerWidth - 138);
    try {
      const area = navigator.windowControlsOverlay?.getTitlebarAreaRect();
      if (area && Number.isFinite(area.width) && area.width > 0 && Number.isFinite(area.x)) {
        available = area.width;
        titlebar.style.setProperty('--titlebar-area-left', `${area.x}px`);
        titlebar.style.setProperty('--titlebar-area-width', `${area.width}px`);
      }
    } catch { /* 尚未显示时先按原生按钮的保守预留宽度排版。 */ }
    titlebar.dataset.compact = String(available < 450);
    titlebar.dataset.narrow = String(available < 300);
    titlebar.dataset.tight = String(available < 200);
  }

  function showError(error, statusText = '未能保存，原布局已保留') {
    errorMessage.textContent = String(error?.message || error || '操作未完成，请重试。')
      .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    errorMessage.hidden = false;
    status.textContent = statusText;
  }

  function clearError() { errorMessage.hidden = true; status.textContent = '整理会自动保存'; }

  function renderPin(alwaysOnTop) {
    pin.setAttribute('aria-pressed', String(alwaysOnTop === true));
    pinLabel.textContent = alwaysOnTop ? '已置顶' : '置顶';
    pin.title = alwaysOnTop ? '取消当前组窗口置顶' : '置顶当前组窗口';
    pin.setAttribute('aria-label', pin.title);
  }

  function setControlsDisabled() {
    name.disabled = saving;
    more.disabled = saving || !group;
    pin.disabled = saving || pinChanging || !group;
    clearSelectionButton.disabled = saving || Boolean(organizing || boxing);
  }

  function selectedInOrder() {
    return group?.kind === 'photo' ? group.items.filter(item => selectedIds.has(item.id)).map(item => item.id) : [];
  }

  function renderSelection() {
    const selectable = group?.kind === 'photo';
    for (const [id, card] of cards) {
      const selected = selectable && selectedIds.has(id);
      card.classList.toggle('is-selected', selected);
      if (selectable) card.setAttribute('aria-selected', String(selected));
      else card.removeAttribute('aria-selected');
    }
    selectionTools.hidden = !selectable || selectedIds.size === 0;
    document.body.classList.toggle('has-photo-selection', selectable && selectedIds.size > 0);
    selectionCount.textContent = `已选 ${selectedIds.size} 张`;
    selectionCount.dataset.count = String(selectedIds.size);
    clearSelectionButton.disabled = saving || Boolean(organizing || boxing);
  }

  function setSelection(ids) {
    selectedIds.clear();
    if (group?.kind === 'photo') {
      const allowed = new Set(group.items.map(item => item.id));
      for (const id of ids) if (allowed.has(id)) selectedIds.add(id);
    }
    renderSelection();
  }

  function clickPhoto(event, id) {
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey) return false;
    event.preventDefault();
    const order = group.items.map(item => item.id);
    if (event.shiftKey) {
      const from = Math.max(0, order.indexOf(selectionAnchor || id)), to = order.indexOf(id);
      const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
      setSelection(event.ctrlKey || event.metaKey ? [...selectedIds, ...range] : range);
    } else {
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id); else next.add(id);
      setSelection(next); selectionAnchor = id;
    }
    return true;
  }

  function inkForColor(color) {
    const hex = /^#[\da-f]{6}$/i.test(color || '') ? color : '#fff2b8';
    const luminance = value => {
      const linear = [1, 3, 5].map(start => parseInt(value.slice(start, start + 2), 16) / 255)
        .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
      return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
    };
    const background = luminance(hex);
    const contrast = value => {
      const foreground = luminance(value);
      return (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05);
    };
    return contrast('#39352e') >= 4.5 ? '#39352e' : contrast('#fffdf7') >= 4.5 ? '#fffdf7' : '#000000';
  }

  async function runAction(action) {
    try { await action(); }
    catch (error) { showError(error); }
  }

  function render(next) {
    if (!next || !Array.isArray(next.items)) return;
    renderPin(next.alwaysOnTop);
    // 置顶只是当前窗口状态，不重建图片网格，避免打断拖动、组名编辑或滚动位置。
    const nextSignature = JSON.stringify({ ...next, alwaysOnTop: undefined });
    if (nextSignature === signature) { group = next; return; }
    const changedGroup = group?.id !== next.id;
    const sameMembers = !changedGroup && group.items.length === next.items.length
      && group.items.every((item, index) => item.id === next.items[index].id);
    if ((organizing || boxing || photoDragStarted) && sameMembers) {
      // 仅内容或组名更新时等当前手势结束再刷新；置顶快照在上方已单独处理。
      pendingRender = next; return;
    }
    cancelGestures(false);
    group = next; signature = nextSignature;
    if (!sameMembers) { photoDragCandidate = null; photoDragStarted = false; }
    if (changedGroup) { selectedIds.clear(); selectionAnchor = null; photoDragCandidate = null; }
    else {
      const allowed = new Set(group.items.map(item => item.id));
      for (const id of selectedIds) if (!allowed.has(id)) selectedIds.delete(id);
      if (!allowed.has(selectionAnchor)) selectionAnchor = null;
    }
    if (changedGroup || document.activeElement !== name) name.value = group.name;
    setControlsDisabled();
    const countValue = document.createElement('span'); countValue.className = 'count-value';
    const countUnit = document.createElement('span'); countUnit.className = 'count-unit';
    countValue.textContent = String(group.items.length);
    countUnit.textContent = ` ${group.kind === 'note' ? '张便签' : '张图片'}`;
    count.replaceChildren(countValue, countUnit);
    count.setAttribute('aria-label', `${group.items.length} ${group.kind === 'note' ? '张便签' : '张图片'}`);
    count.title = count.getAttribute('aria-label');
    const tips = group.kind === 'note' ? ['点击编辑便签', '拖木夹排序', '右键移出或删除']
      : ['空白处框选多张', '拖木夹排序', '拖图片导出原图'];
    help.replaceChildren();
    tips.forEach((tip, index) => {
      if (index) { const dot = document.createElement('i'); dot.setAttribute('aria-hidden', 'true'); help.append(dot); }
      const label = document.createElement('span'); label.textContent = tip; help.append(label);
    });
    grid.dataset.count = String(group.items.length);
    grid.setAttribute('role', group.kind === 'photo' ? 'listbox' : 'list');
    if (group.kind === 'photo') grid.setAttribute('aria-multiselectable', 'true');
    else grid.removeAttribute('aria-multiselectable');
    document.title = `${group.name} · 截图晾衣架`;
    grid.replaceChildren(); cards.clear();
    group.items.forEach((item, index) => {
      const card = document.createElement('article');
      card.className = `group-member ${item.type === 'note' ? 'note-member' : 'photo-member'}`;
      card.dataset.itemId = item.id;
      card.dataset.testid = 'group-member';
      card.setAttribute('role', group.kind === 'photo' ? 'option' : 'listitem');
      const clip = document.createElement('button');
      clip.className = 'wooden-clip'; clip.type = 'button'; clip.draggable = false;
      clip.setAttribute('aria-label', `拖动木夹调整第 ${index + 1} 项的顺序`);
      clip.title = '拖动木夹排序';
      clip.addEventListener('pointerdown', event => beginOrganize(event, item.id, clip));
      clip.addEventListener('dragstart', event => event.preventDefault());
      clip.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
      const open = document.createElement('button');
      open.className = 'member-open'; open.type = 'button';
      open.dataset.testid = item.type === 'note' ? 'group-note' : 'group-photo';
      open.setAttribute('aria-label', item.type === 'note' ? '打开完整便签编辑窗口' : `打开原图 ${item.width} × ${item.height}`);
      const caption = document.createElement('span'); caption.className = 'member-caption';
      if (item.type === 'note') {
        const color = /^#[\da-f]{6}$/i.test(item.color || '') ? item.color : '#fff2b8';
        card.style.setProperty('--note-color', color); card.style.setProperty('--note-ink', inkForColor(color));
        const summary = document.createElement('span'); summary.className = 'note-summary';
        summary.textContent = String(item.text || '').slice(0, 700) || '空白便签';
        open.append(summary);
        caption.textContent = '点击编辑完整便签';
      } else {
        open.draggable = true;
        const image = document.createElement('img'); image.className = 'photo-thumbnail';
        // 浏览器只读取受限的缩略图协议，不为了预览加载原图或创建图片副本。
        if (typeof item.thumbnailUrl === 'string' && item.thumbnailUrl.startsWith('rack-image://thumbnail/')) image.src = item.thumbnailUrl;
        image.alt = '组内图片缩略图'; image.loading = 'lazy'; image.decoding = 'async'; image.draggable = true;
        open.append(image);
        caption.textContent = `${item.width} × ${item.height} · 拖出原图`;
        open.addEventListener('pointerdown', event => {
          if (event.button !== 0 || organizing || boxing || saving) return;
          photoDragStarted = false;
          photoDragCandidate = null;
          if (event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (!selectedIds.has(item.id)) setSelection([]);
          selectionAnchor = item.id;
          const ids = selectedIds.has(item.id) ? selectedInOrder() : [item.id];
          const candidate = { groupId: group.id, ids, error: null, nativeRequested: false };
          photoDragCandidate = candidate;
          const prepare = ids.length > 1 ? api.preparePhotoBatch(ids) : api.preparePhotoDrag(item.id);
          candidate.ready = prepare.catch(error => {
            candidate.error = error;
            if (photoDragCandidate === candidate) {
              showError(error, '未能准备原图，请重试');
              if (photoDragStarted) finishPhotoDrag(); else photoDragCandidate = null;
            }
          });
        });
        open.addEventListener('dragstart', event => {
          event.preventDefault();
          // 准备失败也属于一次拖动，松手时不能误打开原图。
          suppressPointerClick = true; suppressClickUntil = Date.now() + 500;
          const candidate = photoDragCandidate;
          if (organizing || boxing || saving || !candidate || candidate.groupId !== group?.id) return;
          photoDragStarted = true;
          void candidate.ready.then(() => {
            if (candidate.error || photoDragCandidate !== candidate || candidate.groupId !== group?.id) return;
            candidate.nativeRequested = true;
            if (candidate.ids.length > 1) api.dragPhotos(candidate.ids);
            else api.dragPhoto(candidate.ids[0]);
          });
        });
        open.addEventListener('dragend', finishPhotoDrag);
      }
      open.append(caption);
      open.addEventListener('click', event => {
        if (saving || organizing || boxing || photoDragStarted || suppressPointerClick || Date.now() < suppressClickUntil) { event.preventDefault(); return; }
        if (group?.kind === 'photo' && clickPhoto(event, item.id)) return;
        runAction(() => api.openItem(item.id));
      });
      card.addEventListener('contextmenu', event => {
        event.preventDefault(); cancelGestures();
        runAction(() => api.showMemberMenu(item.id));
      });
      card.append(clip, open); grid.append(card); cards.set(item.id, card);
    });
    empty.hidden = group.items.length > 0;
    empty.textContent = '组里暂无内容';
    renderSelection();
    if (changedGroup) scroll.scrollTop = 0;
  }

  async function apply(operation) {
    if (saving) return;
    saving = true; setControlsDisabled(); document.body.classList.add('is-saving'); clearError();
    status.textContent = '正在保存…';
    try {
      await api.applyLayout(operation);
      render(await api.getGroup());
      status.textContent = '整理已保存';
    } catch (error) {
      try { render(await api.getGroup()); } catch {}
      if (group) name.value = group.name;
      showError(error);
    } finally {
      saving = false; setControlsDisabled(); document.body.classList.remove('is-saving');
    }
  }

  function clearMarkers() {
    for (const card of cards.values()) card.classList.remove('insert-before', 'insert-after');
  }

  function targetAt(x, y) {
    if (!organizing || !group) return null;
    const source = new Set(organizing.ids);
    const members = group.items.filter(item => !source.has(item.id));
    if (!members.length) return null;
    let nearest = null, distance = Infinity;
    for (const item of members) {
      const card = cards.get(item.id), rect = card.getBoundingClientRect();
      const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
      const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
      const value = dx * dx + dy * dy * 2;
      if (value < distance) { distance = value; nearest = { item, card, rect }; }
    }
    if (!nearest) return null;
    const before = y < nearest.rect.top || y <= nearest.rect.bottom && x < nearest.rect.left + nearest.rect.width / 2;
    const index = members.findIndex(item => item.id === nearest.item.id);
    return { card: nearest.card, before, beforeId: before ? nearest.item.id : members[index + 1]?.id || null };
  }

  function updateTarget() {
    if (!organizing?.active) return;
    const rect = scroll.getBoundingClientRect();
    clearMarkers();
    if (organizing.x < rect.left - 30 || organizing.x > rect.right + 30
      || organizing.y < rect.top - 48 || organizing.y > rect.bottom + 48) { organizing.target = null; return; }
    const target = targetAt(organizing.x, organizing.y);
    organizing.target = target;
    if (target) target.card.classList.add(target.before ? 'insert-before' : 'insert-after');
  }

  function edgeScroll() {
    if (!organizing?.active) return;
    const rect = scroll.getBoundingClientRect(), y = organizing.y, edge = Math.min(44, rect.height / 3);
    const velocity = y < rect.top + edge ? -Math.min(14, (rect.top + edge - y) / 3)
      : y > rect.bottom - edge ? Math.min(14, (y - rect.bottom + edge) / 3) : 0;
    if (velocity) { scroll.scrollTop += velocity; updateTarget(); }
    dragFrame = requestAnimationFrame(edgeScroll);
  }

  function beginOrganize(event, id, clip) {
    if (event.button !== 0 || saving || !group || photoDragStarted) return;
    event.preventDefault(); event.stopPropagation(); cancelGestures();
    if (group.kind === 'photo' && !selectedIds.has(id)) { setSelection([id]); selectionAnchor = id; }
    const ids = group.kind === 'photo' ? selectedInOrder() : [id];
    organizing = { id, ids, groupId: group.id, pointerId: event.pointerId, clip, x: event.clientX, y: event.clientY,
      startX: event.clientX, startY: event.clientY, active: false, target: null };
    clip.setPointerCapture(event.pointerId);
    setControlsDisabled();
  }

  function moveOrganize(event) {
    if (!organizing || event.pointerId !== organizing.pointerId) return;
    organizing.x = event.clientX; organizing.y = event.clientY;
    if (!organizing.active && Math.hypot(organizing.x - organizing.startX, organizing.y - organizing.startY) >= 5) {
      organizing.active = true;
      for (const id of organizing.ids) cards.get(id)?.classList.add('is-drag-source');
      grid.classList.add('is-organizing');
      api.setOrganizeActive(true);
      heartbeat = setInterval(() => api.setOrganizeActive(true), 600);
      dragFrame = requestAnimationFrame(edgeScroll);
      status.textContent = organizing.ids.length > 1 ? `正在移动 ${organizing.ids.length} 张图片，松手后保存顺序` : '拖到目标两侧后松手排序';
    }
    updateTarget();
  }

  function flushRender() {
    const next = pendingRender; pendingRender = null;
    if (next && !organizing && !boxing) render(next);
  }

  function cancelOrganize(flush = true) {
    const previous = organizing; organizing = null;
    if (!previous) return;
    cancelAnimationFrame(dragFrame); dragFrame = 0; clearInterval(heartbeat); heartbeat = null;
    clearMarkers(); grid.classList.remove('is-organizing');
    for (const id of previous.ids) cards.get(id)?.classList.remove('is-drag-source');
    if (previous.clip.hasPointerCapture(previous.pointerId)) previous.clip.releasePointerCapture(previous.pointerId);
    if (previous.active) { api.setOrganizeActive(false); suppressPointerClick = true; suppressClickUntil = Date.now() + 200; }
    if (!saving && errorMessage.hidden) status.textContent = '整理会自动保存';
    setControlsDisabled();
    if (flush) flushRender();
  }

  function endOrganize(event) {
    if (!organizing || event.pointerId !== organizing.pointerId) return;
    const previous = organizing;
    updateTarget();
    const target = previous.target;
    cancelOrganize();
    if (!previous.active || !target || group?.id !== previous.groupId) return;
    const source = new Set(previous.ids), members = group.items.filter(item => !source.has(item.id));
    const insertion = target.beforeId === null ? members.length : members.findIndex(item => item.id === target.beforeId);
    if (insertion < 0) return;
    const order = [...members.slice(0, insertion).map(item => item.id), ...previous.ids, ...members.slice(insertion).map(item => item.id)];
    if (order.every((id, index) => id === group.items[index]?.id)) return;
    void apply(previous.ids.length > 1
      ? { type: 'move-many', ids: previous.ids, beforeId: target.beforeId, groupId: group.id }
      : { type: 'move', id: previous.id, beforeId: target.beforeId, groupId: group.id });
  }

  function contentPoint(x, y) {
    const rect = scroll.getBoundingClientRect();
    const bottom = Math.max(scroll.clientHeight, grid.offsetTop + grid.offsetHeight + 20);
    return { x: Math.max(0, Math.min(scroll.clientWidth, x - rect.left)),
      y: Math.max(0, Math.min(bottom, y - rect.top + scroll.scrollTop)) };
  }

  function updateBox() {
    if (!boxing?.active || group?.kind !== 'photo') return;
    const end = contentPoint(boxing.x, boxing.y);
    const area = { left: Math.min(boxing.start.x, end.x), top: Math.min(boxing.start.y, end.y),
      right: Math.max(boxing.start.x, end.x), bottom: Math.max(boxing.start.y, end.y) };
    Object.assign(selectionBox.style, { left: `${area.left}px`, top: `${area.top}px`,
      width: `${area.right - area.left}px`, height: `${area.bottom - area.top}px` });
    selectionBox.hidden = false;
    const rect = scroll.getBoundingClientRect(), hits = new Set();
    for (const item of group.items) {
      const card = cards.get(item.id)?.getBoundingClientRect();
      if (!card) continue;
      const left = card.left - rect.left, top = card.top - rect.top + scroll.scrollTop;
      if (left < area.right && left + card.width > area.left && top < area.bottom && top + card.height > area.top) hits.add(item.id);
    }
    const next = boxing.mode === 'replace' ? new Set() : new Set(boxing.initial);
    for (const id of hits) {
      if (boxing.mode === 'toggle' && next.has(id)) next.delete(id); else next.add(id);
    }
    setSelection(next);
  }

  function boxEdgeScroll() {
    if (!boxing?.active) return;
    const rect = scroll.getBoundingClientRect(), edge = Math.min(44, rect.height / 3), y = boxing.y;
    const velocity = y < rect.top + edge ? -Math.min(14, (rect.top + edge - y) / 3)
      : y > rect.bottom - edge ? Math.min(14, (y - rect.bottom + edge) / 3) : 0;
    if (velocity) { scroll.scrollTop += velocity; updateBox(); }
    dragFrame = requestAnimationFrame(boxEdgeScroll);
  }

  function beginBox(event) {
    if (event.button !== 0 || saving || photoDragStarted || group?.kind !== 'photo'
      || event.target.closest('.member-open,.wooden-clip,button,input')) return;
    const rect = scroll.getBoundingClientRect();
    // 原生滚动条仍由系统操作，只有内容空白和卡片间隙开始框选。
    if (event.clientX >= rect.left + scroll.clientWidth) return;
    event.preventDefault(); cancelGestures();
    scroll.focus({ preventScroll: true });
    if (saving) return;
    boxing = { groupId: group.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      startX: event.clientX, startY: event.clientY, start: contentPoint(event.clientX, event.clientY),
      initial: new Set(selectedIds), active: false, mode: event.ctrlKey || event.metaKey ? 'toggle' : event.shiftKey ? 'add' : 'replace' };
    scroll.setPointerCapture(event.pointerId); setControlsDisabled();
  }

  function moveBox(event) {
    if (!boxing || event.pointerId !== boxing.pointerId) return;
    boxing.x = event.clientX; boxing.y = event.clientY;
    if (!boxing.active && Math.hypot(boxing.x - boxing.startX, boxing.y - boxing.startY) >= 4) {
      boxing.active = true; scroll.classList.add('is-selecting'); api.setOrganizeActive(true);
      heartbeat = setInterval(() => api.setOrganizeActive(true), 600);
      dragFrame = requestAnimationFrame(boxEdgeScroll);
      status.textContent = '框选后，拖图片可批量导出，拖木夹可批量排序';
    }
    updateBox();
  }

  function cancelBox(restore = true, flush = true) {
    const previous = boxing; boxing = null;
    if (!previous) return;
    cancelAnimationFrame(dragFrame); dragFrame = 0; clearInterval(heartbeat); heartbeat = null;
    selectionBox.hidden = true; scroll.classList.remove('is-selecting');
    if (scroll.hasPointerCapture(previous.pointerId)) scroll.releasePointerCapture(previous.pointerId);
    if (restore && group?.id === previous.groupId) setSelection(previous.initial);
    if (previous.active) { api.setOrganizeActive(false); suppressPointerClick = true; suppressClickUntil = Date.now() + 200; }
    if (!saving && errorMessage.hidden) status.textContent = '整理会自动保存';
    setControlsDisabled();
    if (flush) flushRender();
  }

  function endBox(event) {
    if (!boxing || event.pointerId !== boxing.pointerId) return;
    const previous = boxing;
    if (previous.active) updateBox();
    else if (previous.mode === 'replace') { setSelection([]); selectionAnchor = null; }
    if (previous.active && selectedIds.size) selectionAnchor = selectedInOrder()[0];
    cancelBox(false);
  }

  function cancelGestures(flush = true) {
    cancelOrganize(false); cancelBox(true, false);
    if (flush) flushRender(); else pendingRender = null;
  }

  function finishPhotoDrag() {
    photoDragStarted = false; photoDragCandidate = null; suppressClickUntil = Date.now() + 250; flushRender();
  }

  function saveName() {
    if (!group || saving) return;
    const value = name.value.trim();
    if (!value) { name.value = group.name; return; }
    if (value !== group.name) void apply({ type: 'rename', groupId: group.id, name: value });
  }

  function showGroupMenu() {
    if (!group || saving) return;
    cancelGestures();
    runAction(() => api.showGroupMenu());
  }

  async function togglePin() {
    if (!group || saving || pinChanging) return;
    const requested = pin.getAttribute('aria-pressed') !== 'true';
    pinChanging = true; setControlsDisabled();
    try {
      const actual = await api.setAlwaysOnTop(requested);
      if (typeof actual !== 'boolean') throw new Error('未能读取窗口置顶状态，请重试。');
      renderPin(actual);
      if (actual !== requested) throw new Error('系统未能切换窗口置顶状态，请重试。');
      clearError(); status.textContent = actual ? '当前组窗口已置顶' : '已取消当前组窗口置顶';
    } catch (error) { showError(error, '置顶状态未能切换'); }
    finally { pinChanging = false; setControlsDisabled(); }
  }

  more.addEventListener('click', showGroupMenu);
  pin.addEventListener('click', togglePin);
  clearSelectionButton.addEventListener('click', () => {
    if (saving || organizing || boxing) return;
    setSelection([]); selectionAnchor = null; photoDragCandidate = null;
  });
  document.addEventListener('contextmenu', event => {
    if (event.defaultPrevented || event.target.closest('.group-member,input')) return;
    event.preventDefault(); showGroupMenu();
  });

  name.addEventListener('blur', saveName);
  name.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); name.blur(); }
    if (event.key === 'Escape') { event.stopPropagation(); name.value = group?.name || ''; name.blur(); }
  });
  window.addEventListener('pointermove', moveOrganize);
  window.addEventListener('pointermove', moveBox);
  window.addEventListener('pointerdown', () => {
    // 只抑制上一段拖动产生的尾随 click；下一次明确按下可立即选择或打开。
    if (!organizing && !boxing && !photoDragStarted) { suppressClickUntil = 0; suppressPointerClick = false; }
  }, { capture: true });
  window.addEventListener('pointerup', endOrganize);
  window.addEventListener('pointerup', endBox);
  window.addEventListener('pointerup', () => {
    if (!photoDragCandidate || photoDragCandidate.nativeRequested) return;
    // 大原图准备期间松手即取消，避免读取结束后突然触发原生拖出。
    if (photoDragStarted) finishPhotoDrag(); else photoDragCandidate = null;
  });
  window.addEventListener('pointercancel', () => cancelGestures());
  window.addEventListener('lostpointercapture', event => {
    if (organizing?.pointerId === event.pointerId || boxing?.pointerId === event.pointerId) cancelGestures();
  });
  scroll.addEventListener('pointerdown', beginBox);
  window.addEventListener('blur', () => {
    cancelGestures(); photoDragStarted = false; photoDragCandidate = null; flushRender();
  });
  window.addEventListener('keydown', event => {
    const editing = event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"]');
    if (!editing && (event.key === 'Enter' || event.key === ' ') && !organizing && !boxing && !photoDragStarted) {
      suppressPointerClick = false; suppressClickUntil = 0;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && group?.kind === 'photo' && !editing) {
      event.preventDefault();
      if (!saving && !organizing && !boxing && !photoDragStarted) { setSelection(group.items.map(item => item.id)); selectionAnchor = group.items[0]?.id || null; }
      return;
    }
    if (event.key !== 'Escape') return;
    if (organizing || boxing) { event.preventDefault(); cancelGestures(); }
    else if (photoDragStarted) { event.preventDefault(); finishPhotoDrag(); }
    else if (selectedIds.size && !editing) { event.preventDefault(); setSelection([]); selectionAnchor = null; }
    else runAction(() => api.close());
  });
  window.addEventListener('dragover', event => event.preventDefault());
  window.addEventListener('drop', event => event.preventDefault());
  scroll.addEventListener('scroll', () => { updateTarget(); updateBox(); }, { passive: true });
  window.addEventListener('resize', () => { layoutTitlebar(); if (organizing) updateTarget(); if (boxing) updateBox(); });
  const controlsOverlay = navigator.windowControlsOverlay;
  controlsOverlay?.addEventListener('geometrychange', layoutTitlebar);
  layoutTitlebar();
  if (api) {
    unsubscribers.push(api.onGroup(render), api.onFocusName(() => { name.focus(); name.select(); }),
      api.onCancelOrganize(() => { cancelGestures(); photoDragCandidate = null; photoDragStarted = false; flushRender(); }), api.onPhotoDragEnd(finishPhotoDrag));
    runAction(async () => render(await api.getGroup()));
  } else showError('组浏览接口不可用，请关闭后重新打开。');
  window.addEventListener('beforeunload', () => {
    cancelGestures(false); photoDragCandidate = null; controlsOverlay?.removeEventListener('geometrychange', layoutTitlebar);
    unsubscribers.forEach(unsubscribe => unsubscribe());
  });
})();
