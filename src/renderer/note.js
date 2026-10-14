'use strict';

(() => {
  const api = window.rack;
  const input = document.getElementById('noteInput');
  const title = document.getElementById('noteTitle');
  const status = document.getElementById('noteSaveStatus');
  const errorMessage = document.getElementById('noteError');
  const characterCount = document.getElementById('noteCharacterCount');
  const colorName = document.getElementById('noteColorName');
  const colorsHost = document.getElementById('noteColors');
  const fontSize = document.getElementById('noteFontSize');
  const pinButton = document.getElementById('notePinButton');
  const pinLabel = document.getElementById('notePinLabel');
  const closeButton = document.getElementById('noteCloseButton');
  const dragHandle = document.getElementById('noteDragHandle');
  const presets = [
    { color: '#fff2b8', name: '奶油黄' },
    { color: '#f9dfe1', name: '浅樱粉' },
    { color: '#e1ead7', name: '鼠尾草绿' },
    { color: '#dce9f1', name: '雾蓝' },
    { color: '#f8f4e9', name: '米白' }
  ];
  const colorButtons = [];
  let note = { id: null, text: '', color: '#fff2b8', fontSize: 14, alwaysOnTop: false };
  let ready = false;
  let revision = 0;
  let savedRevision = 0;
  let saveRunning = null;
  let closeRunning = null;
  let pinRunning = null;
  let loadPromise;
  let drag = null;
  let unsubscribeFlush;

  function inkForColor(color) {
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

  function validFontSize(value) {
    return Number.isSafeInteger(value) && value >= 14 && value <= 32;
  }

  function characterLength(value) {
    let length = 0;
    // 与 Array.from 一样按 Unicode 码点计数，输入长便签时不创建整段字符数组。
    for (const character of value) length += 1;
    return length;
  }

  function retainFontOption(value) {
    if ([...fontSize.options].some(option => Number(option.value) === value)) return;
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = `${value} px`;
    const next = [...fontSize.options].find(existing => Number(existing.value) > value);
    fontSize.insertBefore(option, next || null);
  }

  function payload() {
    return { text: input.value, color: note.color, fontSize: note.fontSize, alwaysOnTop: note.alwaysOnTop };
  }

  function showError(message) {
    errorMessage.textContent = message || '保存未完成，内容已保留，请重新关闭便签重试';
    errorMessage.hidden = false;
    status.textContent = '内容已保留，请重试';
  }

  function clearError() {
    errorMessage.hidden = true;
    status.textContent = note.id ? '关闭后保存到晾衣架' : '关闭后自动挂回衣架';
  }

  function updateAppearance() {
    const ink = inkForColor(note.color);
    document.documentElement.style.setProperty('--note-color', note.color);
    document.documentElement.style.setProperty('--note-ink', ink);
    document.documentElement.style.setProperty('--note-font-size', `${note.fontSize}px`);
    retainFontOption(note.fontSize);
    fontSize.value = String(note.fontSize);
    pinButton.setAttribute('aria-pressed', String(note.alwaysOnTop));
    pinButton.setAttribute('aria-label', note.alwaysOnTop ? '取消这张便签置顶' : '将这张便签置顶');
    pinButton.title = note.alwaysOnTop ? '取消这张便签置顶' : '仅将这张便签置顶';
    pinLabel.textContent = note.alwaysOnTop ? '已置顶' : '置顶';
    const selected = presets.find(preset => preset.color === note.color);
    colorName.textContent = selected ? selected.name : `自定义 ${note.color.toUpperCase()}`;
    for (const button of colorButtons) button.setAttribute('aria-pressed', String(button.dataset.color === note.color));
    customColor.value = note.color;
    customLabel.classList.toggle('is-selected', !selected);
    characterCount.textContent = `${characterLength(input.value).toLocaleString('zh-CN')} 字`;
  }

  function setClosing(closing) {
    document.body.classList.toggle('is-saving', closing);
    for (const control of document.querySelectorAll('button,textarea,select,input')) control.disabled = closing || !ready;
    if (closing) status.textContent = '正在保存…';
  }

  function pumpSave() {
    if (!ready || !api || saveRunning || closeRunning || pinRunning) return saveRunning;
    saveRunning = (async () => {
      while (savedRevision < revision) {
        const sentRevision = revision;
        const draft = payload();
        try {
          await api.saveNote(draft);
          savedRevision = sentRevision;
        } catch (error) {
          showError(error?.message || '暂存失败，内容已保留，关闭时会重新保存');
          break;
        }
      }
    })().finally(() => { saveRunning = null; });
    return saveRunning;
  }

  function changed() {
    if (!ready || closeRunning) return;
    revision += 1;
    clearError();
    updateAppearance();
    pumpSave();
  }

  function close() {
    if (!api || closeRunning) return closeRunning;
    finishDrag();
    setClosing(true);
    closeRunning = (async () => {
      try {
        if (loadPromise) await loadPromise;
        if (!ready) throw new Error('便签尚未读取完成，内容已保留，请稍后重试');
        setClosing(true);
        if (pinRunning) await pinRunning;
        if (saveRunning) await saveRunning;
        await api.closeNote(payload());
      } catch (error) {
        showError(error?.message || '保存未完成，内容已保留，请重新关闭便签重试');
        setClosing(false);
        input.focus();
      }
    })().finally(() => { closeRunning = null; });
    return closeRunning;
  }

  for (const preset of presets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'color-choice';
    button.dataset.color = preset.color;
    button.style.setProperty('--choice-color', preset.color);
    button.style.setProperty('--choice-ink', inkForColor(preset.color));
    button.title = preset.name;
    button.setAttribute('aria-label', preset.name);
    button.setAttribute('aria-pressed', 'false');
    button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 8 3 3 5-6"/></svg>';
    button.addEventListener('click', () => { note.color = preset.color; changed(); });
    colorsHost.append(button);
    colorButtons.push(button);
  }
  const customLabel = document.createElement('label');
  customLabel.className = 'custom-color';
  customLabel.title = '自定义纸张颜色';
  const customColor = document.createElement('input');
  customColor.type = 'color';
  customColor.id = 'noteCustomColor';
  customColor.value = note.color;
  customColor.setAttribute('aria-label', '自定义便签颜色');
  const customSymbol = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  customSymbol.setAttribute('viewBox', '0 0 16 16');
  customSymbol.setAttribute('aria-hidden', 'true');
  const customPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  customPath.setAttribute('d', 'M8 3v10M3 8h10');
  customSymbol.append(customPath);
  customLabel.append(customSymbol, customColor);
  colorsHost.append(customLabel);
  customColor.addEventListener('input', () => {
    if (/^#[\da-f]{6}$/i.test(customColor.value)) { note.color = customColor.value.toLowerCase(); changed(); }
  });
  fontSize.addEventListener('change', () => {
    const nextSize = Number(fontSize.value);
    if (validFontSize(nextSize)) { note.fontSize = nextSize; changed(); }
  });
  input.addEventListener('input', changed);
  pinButton.addEventListener('click', () => {
    if (!api || !ready || closeRunning || pinRunning) return;
    pinButton.disabled = true;
    const previous = note.alwaysOnTop;
    const next = !previous;
    note.alwaysOnTop = next;
    updateAppearance();
    pinRunning = (async () => {
      try {
        if (saveRunning) await saveRunning;
        await api.setNoteAlwaysOnTop(next);
        changed();
      } catch (error) {
        note.alwaysOnTop = previous;
        updateAppearance();
        showError(error?.message || '置顶未完成，请重试');
      }
    })().finally(() => {
      pinRunning = null;
      if (!closeRunning) { pinButton.disabled = false; pumpSave(); }
    });
  });
  closeButton.addEventListener('click', close);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); close(); }
  });

  dragHandle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !api || drag || closeRunning || event.target.closest('button')) return;
    event.preventDefault();
    dragHandle.setPointerCapture(event.pointerId);
    drag = { pointerId: event.pointerId };
    dragHandle.classList.add('is-dragging');
    api.beginNoteDrag({ x: event.screenX, y: event.screenY });
  });
  dragHandle.addEventListener('pointermove', event => {
    if (drag?.pointerId !== event.pointerId) return;
    api.moveNoteDrag({ x: event.screenX, y: event.screenY });
  });
  function finishDrag(event) {
    if (!drag || (event && drag.pointerId !== event.pointerId)) return;
    const current = drag;
    drag = null;
    if (dragHandle.hasPointerCapture(current.pointerId)) dragHandle.releasePointerCapture(current.pointerId);
    dragHandle.classList.remove('is-dragging');
    if (api) api.endNoteDrag();
  }
  dragHandle.addEventListener('pointerup', finishDrag);
  dragHandle.addEventListener('pointercancel', finishDrag);
  dragHandle.addEventListener('lostpointercapture', finishDrag);

  async function load() {
    if (!api || typeof api.getNote !== 'function') { showError('请在截图晾衣架中打开便签'); return; }
    try {
      const stored = await api.getNote();
      note = {
        id: typeof stored?.id === 'string' ? stored.id : null,
        text: typeof stored?.text === 'string' ? stored.text : '',
        color: /^#[\da-f]{6}$/i.test(stored?.color || '') ? stored.color.toLowerCase() : '#fff2b8',
        fontSize: validFontSize(Number(stored?.fontSize)) ? Number(stored.fontSize) : 14,
        alwaysOnTop: !!stored?.alwaysOnTop
      };
      input.value = note.text;
      title.textContent = note.id ? '便签' : '新便签';
      document.title = `${note.id ? '便签' : '新便签'} · 截图晾衣架`;
      ready = true;
      setClosing(!!closeRunning);
      updateAppearance();
      clearError();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    } catch (error) { showError(error?.message || '便签读取失败，请关闭后重试'); }
  }
  if (api && typeof api.onNoteFlush === 'function') unsubscribeFlush = api.onNoteFlush(close);
  window.addEventListener('pagehide', () => { finishDrag(); if (unsubscribeFlush) unsubscribeFlush(); });
  setClosing(false);
  loadPromise = load();
})();
