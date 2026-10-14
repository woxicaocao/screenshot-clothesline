'use strict';

const { app, BrowserWindow, Tray, Menu, clipboard, nativeImage, ipcMain, protocol, screen, dialog, globalShortcut } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PhotoRepository } = require('./lib/repository.cjs');
const { NotesRepository } = require('./lib/notes-repository.cjs');
const { NoteWindows } = require('./lib/note-windows.cjs');
const { PhotoWindows } = require('./lib/photo-windows.cjs');
const { ClipboardCollector } = require('./lib/collector.cjs');
const { createClipboardReader, normalizeImage } = require('./lib/electron-image.cjs');
const { AutoHideController } = require('./lib/auto-hide.cjs');
const { HoverPasteController } = require('./lib/hover-paste.cjs');
const { rackSizeForDisplay } = require('./lib/window-size.cjs');
const { inspectEncodedImage, mimeForFile } = require('./lib/image-format.cjs');
const { LocalImageImporter, MAX_LOCAL_FILES } = require('./lib/local-image-import.cjs');
const { RendererImageDecoder } = require('./lib/renderer-image-decoder.cjs');

app.setName('screenshot-clothesline');
// 静态图片挂件使用软件合成，降低常驻GPU资源；特殊显卡可用此开关恢复。
if (!app.commandLine.hasSwitch('hardware-acceleration')) app.disableHardwareAcceleration();
// 此工具按需打开少量图片窗口，无需常驻备用渲染进程。
// 保留已有命令行配置，仅关闭 Electron 官方列出的备用进程功能。
const disabledFeatures = new Set(app.commandLine.getSwitchValue('disable-features').split(',').filter(Boolean));
disabledFeatures.add('SpareRendererForSitePerProcess');
app.commandLine.appendSwitch('disable-features', [...disabledFeatures].join(','));
protocol.registerSchemesAsPrivileged([{ scheme: 'rack-image', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const testMode = process.env.RACK_TEST_MODE === '1' && process.argv.includes('--rack-test');
if (testMode) {
  const argument = process.argv.find((value) => value.startsWith('--data-dir='));
  if (argument) app.setPath('userData', path.resolve(argument.slice('--data-dir='.length)));
}

let repository;
let notesRepository;
let noteWindows;
let photoWindows;
let testPreviewCursorPoint = null;
let preparingExit = false;
let collector;
let rackWindow;
let appreciationWindow;
let appreciationReadiness;
let tray;
let status = { level: 'info', message: '' };
let quitting = false;
let moveTimer;
let ignoringMouseEvents = false;
let testClipboardBytes = null;
let useTestClipboard = false;
let stateChanges = Promise.resolve();
let autoHideController;
let autoHideTimer;
let expandedBounds;
let changingWindowBounds = false;
let dragSession = null;
let requestedInteractive = false;
let testCursorPoint = null;
let testClock = null;
const HIDE_DELAYS = Object.freeze({ fast: 0, medium: 1000, slow: 2000 });
const HIDE_LABELS = Object.freeze({ fast: '快 · 立即', medium: '中 · 1 秒', slow: '慢 · 2 秒' });
const suspensionReasons = new Set();
const previewWindows = new Map();
const previewReadiness = new WeakMap();
const floatingWindows = new Map();
const floatingReadiness = new WeakMap();
const preparedDrags = new Map();
const MAX_PREPARED_DRAGS = 2;
let nativeDragging = false;
let nativeDraggingId = null;
let lastNativeDrag = null;
let lastPhotoMenu = null;
let lastPhotoMenuId = null;
let lastNoteMenu = null;
let lastNoteMenuId = null;
let deleteCleanupTimer = null;
let deleteCleanupBusy = false;
let hoverPasteController;
let manualPastePromise = null;
let pasteHover = false;
let localImageImporter;
let localWebpDecoder;
let localImportPromise = null;
let fileDropActive = false;
let fileDropDeadline = 0;
const FILE_DROP_IDLE_TIMEOUT = 2500;

function suspendRack(reason, active) {
  if (active) suspensionReasons.add(reason);
  else suspensionReasons.delete(reason);
  autoHideController?.setSuspended(suspensionReasons.size > 0);
  updateHoverPaste();
}

function reportActionError(error, message) {
  console.error('[晾衣架操作失败]', error);
  status = { level: 'error', message };
  publish();
}

function findPhoto(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('图片编号无效。');
  const photo = repository.getPhoto(id);
  if (!photo) throw new Error('这张图片已不在衣架上。');
  return photo;
}

function autoHideState() {
  return autoHideController?.getState() || { enabled: false, collapsed: false, dragging: false, suspended: false, manuallyHidden: false };
}

function changeWindowBounds(bounds) {
  changingWindowBounds = true;
  try { rackWindow.setBounds(bounds); }
  finally { changingWindowBounds = false; }
}

function enqueueStateChange(operation) {
  const change = stateChanges.then(() => quitting ? snapshot() : operation());
  stateChanges = change.catch(() => {});
  return change;
}

function publicPhoto(photo) {
  return {
    type: 'photo',
    id: photo.id,
    capturedAt: photo.capturedAt,
    width: photo.width,
    height: photo.height,
    format: path.extname(photo.fileName).slice(1),
    url: `rack-image://photo/${photo.id}`,
    thumbnailUrl: `rack-image://thumbnail/${photo.id}`
  };
}

function publicNote(note) {
  return { type: 'note', id: note.id, text: note.text.slice(0, 700), color: note.color,
    fontSize: note.fontSize, alwaysOnTop: note.alwaysOnTop, capturedAt: note.createdAt,
    createdAt: note.createdAt, updatedAt: note.updatedAt };
}

function canPasteClipboard() {
  return !quitting && rackWindow && !rackWindow.isDestroyed() && rackWindow.isVisible()
    && !autoHideState().collapsed && !autoHideState().manuallyHidden
    && !dragSession && !nativeDragging
    // 临时操作暂停期间不接管粘贴；兼容旧的便签专用标记。
    && ![...suspensionReasons].some(reason => typeof reason !== 'string' || !reason.startsWith('note:'));
}

function pasteEligibility() {
  if (!pasteHover || !canPasteClipboard()) return false;
  const point = testCursorPoint || screen.getCursorScreenPoint();
  const bounds = rackWindow.getBounds();
  if (!validPoint(point) || point.x < bounds.x || point.x >= bounds.x + bounds.width
    || point.y < bounds.y || point.y >= bounds.y + bounds.height) return false;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed() && focused.isVisible() && noteWindows?.entries.has(focused.id)
    && (!rackWindow.isAlwaysOnTop() || focused.isAlwaysOnTop())) {
    const editor = focused.getBounds();
    // 便签盖住衣架时，陈旧或转发的悬停消息不能抢走正文的 Ctrl+V。
    if (point.x >= editor.x && point.x < editor.x + editor.width
      && point.y >= editor.y && point.y < editor.y + editor.height) return false;
  }
  return true;
}

function updateHoverPaste() { hoverPasteController?.update(); }

function pasteClipboard() {
  if (manualPastePromise) return manualPastePromise;
  if (!canPasteClipboard()) return Promise.resolve({ added: false, unavailable: true });
  suspendRack('paste-clipboard', true);
  manualPastePromise = enqueueStateChange(async () => {
    try {
      const result = await collector.collectCurrent();
      status = { level: result ? 'info' : 'error', message: result
        ? (result.added ? '已粘贴图片到晾衣架' : '这张图片已经在晾衣架上')
        : '剪贴板里没有图片，请右键选择“复制图片”后再粘贴。' };
      publish();
      return result ? { added: result.added, photo: publicPhoto(result.photo) } : { added: false, empty: true };
    } catch (error) {
      reportActionError(error, '图片未能粘贴，请重新复制后再按 Ctrl+V 重试。');
      return { added: false, error: true };
    }
  }).finally(() => {
    manualPastePromise = null;
    suspendRack('paste-clipboard', false);
    updateHoverPaste();
  });
  return manualPastePromise;
}

function setFileDropActive(active) {
  // 外部拖入仅在衣架显示时接管透明区域；衣架拖出原图不得被反向接管。
  if (active && (quitting || preparingExit || nativeDragging || !rackWindow?.isVisible()
    || autoHideState().manuallyHidden)) return;
  fileDropDeadline = active ? Date.now() + FILE_DROP_IDLE_TIMEOUT : 0;
  if (fileDropActive === active) return;
  fileDropActive = active;
  suspendRack('local-file-drop', active);
  applyInteractive(requestedInteractive);
  publish();
}

function importLocalImages(filePaths) {
  const unavailable = message => ({ added: 0, duplicates: 0, failed: 0, total: 0, errors: [], unavailable: true, message });
  if (quitting || preparingExit || !localImageImporter) return Promise.resolve(unavailable('程序正在退出，请稍后重试。'));
  if (localImportPromise) return Promise.resolve(unavailable('正在挂上上一批图片，请稍后再拖入。'));
  setFileDropActive(false);
  if (!Array.isArray(filePaths) || filePaths.length === 0 || filePaths.length > MAX_LOCAL_FILES
    || filePaths.some(filePath => typeof filePath !== 'string' || !filePath || filePath.length > 32767)) {
    status = { level: 'error', message: '请从本机文件夹拖入 1 至 100 张图片，一次最多 100 张。' };
    publish();
    return Promise.resolve({ added: 0, duplicates: 0, failed: 0, total: 0, errors: [], error: true, message: status.message });
  }
  suspendRack('local-file-import', true);
  localImportPromise = enqueueStateChange(async () => {
    status = { level: 'info', message: '正在挂上本机图片…' };
    publish();
    try {
      const result = await localImageImporter.importFiles(filePaths);
      status = { level: result.failed ? 'error' : 'info', message: result.message };
      publish();
      return result;
    } catch (error) {
      status = { level: 'error', message: error.message || '本机图片未能添加，请重新拖入重试。' };
      publish();
      return { added: 0, duplicates: 0, failed: 0, total: 0, errors: [], error: true, message: status.message };
    }
  }).finally(() => {
    localImportPromise = null;
    suspendRack('local-file-import', false);
    applyInteractive(requestedInteractive);
    publish();
  });
  return localImportPromise;
}

function snapshot() {
  const settings = repository.getSettings();
  const photos = repository.getPhotos().map(publicPhoto);
  return {
    photos,
    items: [...photos, ...(notesRepository?.getNoteSummaries() || []).map(publicNote)]
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt) || a.id.localeCompare(b.id)),
    state: { paused: settings.paused, alwaysOnTop: settings.alwaysOnTop, autoHide: settings.autoHide, autoHideSpeed: settings.autoHideSpeed, autoHidden: autoHideState().collapsed, manuallyHidden: autoHideState().manuallyHidden, dragging: !!dragSession, externalDragging: nativeDragging, importing: !!localImportPromise, fileDropActive, pasteShortcutAvailable: !!hoverPasteController?.getState().registered, pasteShortcutBlocked: !!hoverPasteController?.getState().failed },
    status,
    version: app.getVersion()
  };
}

function publish() {
  if (rackWindow && !rackWindow.isDestroyed()) rackWindow.webContents.send('rack:snapshot', snapshot());
  updateTrayMenu();
}

function reportError(error) {
  console.error('[晾衣架]', error);
  status = { level: 'error', message: '暂时没能保存图片，稍后会重试。' };
  publish();
}

function applyInteractive(interactive) {
  if (!rackWindow || rackWindow.isDestroyed()) return;
  requestedInteractive = interactive;
  const nextIgnoring = !(interactive || dragSession || fileDropActive);
  if (nextIgnoring === ignoringMouseEvents) return;
  ignoringMouseEvents = nextIgnoring;
  rackWindow.setIgnoreMouseEvents(nextIgnoring, { forward: true });
}

function boundedPosition(saved) {
  const hasPosition = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y);
  // 旧设置中的1680是逻辑宽度；选屏只看位置，避免过时宽度把窗口匹配到邻屏。
  const display = hasPosition
    ? screen.getDisplayNearestPoint({ x: Math.round(saved.x), y: Math.round(saved.y) })
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const size = rackSizeForDisplay(display);
  const candidate = hasPosition
    ? { x: Math.round(saved.x), y: Math.round(saved.y), ...size }
    : { x: area.x + Math.round((area.width - size.width) / 2), y: area.y + 24, ...size };
  candidate.x = Math.max(area.x, Math.min(candidate.x, area.x + area.width - candidate.width));
  candidate.y = Math.max(area.y, Math.min(candidate.y, area.y + area.height - candidate.height));
  return candidate;
}

async function persistPosition() {
  if (rackWindow && !rackWindow.isDestroyed()) {
    const bounds = autoHideState().collapsed ? expandedBounds : rackWindow.getBounds();
    expandedBounds = boundedPosition(bounds);
    if (!autoHideState().collapsed && ['x', 'y', 'width', 'height'].some(key => bounds[key] !== expandedBounds[key])) {
      changeWindowBounds(expandedBounds);
    }
    await repository.updateSettings({ bounds: expandedBounds });
  }
}

function queuePositionSave() {
  if (quitting || changingWindowBounds || autoHideState().collapsed || dragSession) return;
  expandedBounds = rackWindow.getBounds();
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => persistPosition().catch(reportError), 350);
}

function restoreRack() {
  if (!rackWindow || rackWindow.isDestroyed()) return;
  autoHideController?.setManuallyHidden(false);
  autoHideController?.reveal();
  expandedBounds = boundedPosition(expandedBounds || rackWindow.getBounds());
  changeWindowBounds(expandedBounds);
  rackWindow.show();
  rackWindow.focus();
}

function hideRack() {
  setFileDropActive(false);
  endDrag();
  autoHideController?.setManuallyHidden(true);
  rackWindow.hide();
  pasteHover = false;
  updateHoverPaste();
}

function collapseRack() {
  if (!rackWindow || rackWindow.isDestroyed()) return;
  clearTimeout(moveTimer);
  const display = screen.getDisplayMatching(expandedBounds);
  // 仅保留顶部 12 DIP 小标签，不把这个临时坐标写进位置设置。
  applyInteractive(false);
  rackWindow.setAlwaysOnTop(true);
  changeWindowBounds({ ...expandedBounds, y: display.bounds.y - expandedBounds.height + 12 });
}

function expandRack() {
  if (!rackWindow || rackWindow.isDestroyed()) return;
  expandedBounds = boundedPosition(expandedBounds);
  rackWindow.setAlwaysOnTop(repository.getSettings().alwaysOnTop);
  changeWindowBounds(expandedBounds);
  if (!autoHideState().manuallyHidden) {
    rackWindow.showInactive();
    rackWindow.moveTop();
  }
}

function setAutoHide(value) {
  if (typeof value !== 'boolean') throw new TypeError('autoHide must be boolean');
  return enqueueStateChange(async () => {
    try {
      await repository.updateSettings({ autoHide: value });
      autoHideController.setEnabled(value);
      publish();
      return snapshot();
    } catch (error) {
      reportError(error);
      throw error;
    }
  });
}

function setAutoHideSpeed(speed) {
  if (!Object.hasOwn(HIDE_DELAYS, speed)) throw new Error('请选择快、中或慢档。');
  return enqueueStateChange(async () => {
    await repository.updateSettings({ autoHideSpeed: speed });
    autoHideController.setDelayMs(HIDE_DELAYS[speed]);
    publish();
    return snapshot();
  });
}

function preparePhotoDrag(id) {
  const photo = findPhoto(id);
  const cached = preparedDrags.get(id);
  if (cached) {
    preparedDrags.delete(id);
    preparedDrags.set(id, cached);
    return cached;
  }
  if (!preparedDrags.has(id)) {
    const preparation = (async () => {
      const file = await repository.prepareExport(id);
      const thumbnail = nativeImage.createFromPath(path.join(app.getPath('userData'), 'thumbnails', photo.thumbnailName));
      const icon = thumbnail.isEmpty() ? nativeImage.createFromPath(path.join(__dirname, 'assets', 'app.png')) : thumbnail;
      const size = icon.getSize();
      const factor = Math.min(1, 128 / size.width, 96 / size.height);
      return { file, icon: icon.resize({ width: Math.max(1, Math.round(size.width * factor)), height: Math.max(1, Math.round(size.height * factor)) }) };
    })();
    preparedDrags.set(id, preparation);
    // 只为最近操作的两张图保留拖放图标；PNG导出文件继续保留在本地。
    // 正在进行的拖放另有局部引用，不会因缓存淘汰而失去原生图标。
    while (preparedDrags.size > MAX_PREPARED_DRAGS) preparedDrags.delete(preparedDrags.keys().next().value);
    preparation.catch(() => { if (preparedDrags.get(id) === preparation) preparedDrags.delete(id); });
  }
  return preparedDrags.get(id);
}

async function dragPhoto(webContents, id) {
  findPhoto(id);
  if (nativeDragging || quitting) return;
  endDrag();
  nativeDragging = true; nativeDraggingId = id;
  suspendRack('native-drag', true);
  applyInteractive(true);
  publish();
  try {
    const item = await preparePhotoDrag(id);
    findPhoto(id);
    if (quitting || webContents.isDestroyed()) return;
    lastNativeDrag = { id, file: item.file, iconSize: item.icon.getSize(), prepared: true, nativeCalled: !testMode };
    // Electron 44 的 Windows OLE 拖放同步结束后才返回；COPY/LINK 不移动衣架原图。
    // https://github.com/electron/electron/blob/v44.7.0/shell/browser/ui/drag_util_views.cc
    if (!testMode) webContents.startDrag(item);
  } finally {
    nativeDragging = false; nativeDraggingId = null;
    suspendRack('native-drag', false);
    autoHideController.reveal();
    applyInteractive(false);
    publish();
  }
}

function startDeleteCleanup() {
  if (deleteCleanupTimer || quitting) return;
  deleteCleanupTimer = setInterval(async () => {
    if (quitting || deleteCleanupBusy || nativeDragging) return;
    deleteCleanupBusy = true;
    try {
      const { remaining } = await repository.retryPendingDeletes();
      if (remaining === 0) {
        clearInterval(deleteCleanupTimer); deleteCleanupTimer = null;
        if (status.kind === 'delete-pending') { status = { level: 'info', message: '截图缓存已清理' }; publish(); }
      }
    } catch (error) { console.error('[缓存清理重试]', error); }
    finally { deleteCleanupBusy = false; }
  }, 2000);
  deleteCleanupTimer.unref();
}

function deletePhoto(id) {
  return enqueueStateChange(async () => {
    findPhoto(id);
    if (nativeDragging && nativeDraggingId === id) throw new Error('请先完成图片拖放，再删除它。');
    const wasPaused = repository.getSettings().paused;
    suspendRack('delete-photo', true);
    collector.forgetPhoto(id);
    await collector.setPaused(true);
    try {
      const result = await repository.deletePhoto(id);
      collector.forgetPhoto(id);
      preparedDrags.delete(id);
      const preview = previewWindows.get(id);
      if (preview && !preview.isDestroyed()) preview.close();
      const floating = floatingWindows.get(id);
      if (floating && !floating.isDestroyed()) floating.close();
      // 原图记录已移除，清掉浏览器的临时图像缓存，避免旧响应继续留存。
      // 浏览器缓存清理失败不能覆盖已经提交的删除结果或跳过文件清理重试。
      try { await rackWindow.webContents.session.clearCache(); }
      catch (error) { console.error('[浏览器图片缓存清理失败]', error); }
      status = result.cleanupPending
        ? { level: 'error', kind: 'delete-pending', message: '图片已移除，缓存暂时被占用，稍后继续清理。' }
        : { level: 'info', message: '已删除这张图片及缓存' };
      if (result.cleanupPending) startDeleteCleanup();
      publish();
      return result;
    } finally {
      await collector.setPaused(wasPaused);
      suspendRack('delete-photo', false);
      publish();
    }
  });
}

async function openFloating(id) {
  const photo = findPhoto(id);
  const existing = floatingWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    const ready = await floatingReadiness.get(existing);
    if (ready && !existing.isDestroyed()) { existing.show(); existing.focus(); }
    return;
  }
  const area = screen.getDisplayMatching(expandedBounds).workArea;
  const factor = Math.min(1, Math.min(600, area.width - 2) / photo.width, Math.min(420, area.height - 2) / photo.height);
  const width = Math.max(64, Math.min(area.width, Math.round(photo.width * factor) + 2));
  const height = Math.max(48, Math.min(area.height, Math.round(photo.height * factor) + 2));
  const floating = new BrowserWindow({
    x: Math.max(area.x, Math.min(expandedBounds.x + 50, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(expandedBounds.y + 100, area.y + area.height - height)),
    width, height, minWidth: 64, minHeight: 48,
    resizable: false, maximizable: false, fullscreenable: false, useContentSize: true, thickFrame: false,
    frame: false, backgroundColor: '#17201e', alwaysOnTop: true, show: false,
    title: '悬浮图片 · 截图晾衣架', autoHideMenuBar: true, icon: path.join(__dirname, 'assets', 'app.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
  });
  let resolveReady;
  floatingReadiness.set(floating, new Promise((resolve) => { resolveReady = resolve; }));
  floatingWindows.set(id, floating);
  photoWindows.register(floating, photo, { floating: true, scale: factor });
  secureWindow(floating);
  floating.on('closed', () => {
    resolveReady(false);
    if (floatingWindows.get(id) === floating) floatingWindows.delete(id);
  });
  floating.once('ready-to-show', () => {
    if (floating.isDestroyed()) { resolveReady(false); return; }
    floating.setAlwaysOnTop(true);
    floating.showInactive();
    resolveReady(true);
  });
  try { await floating.loadFile(path.join(__dirname, 'renderer', 'preview.html')); }
  catch (error) { if (!floating.isDestroyed()) floating.close(); throw error; }
}

function showPhotoMenu(id) {
  findPhoto(id);
  const menu = Menu.buildFromTemplate([
    { label: '悬浮', click: () => openFloating(id).catch((error) => reportActionError(error, '暂时无法打开悬浮图片，请重试。')) },
    { label: '删除', click: () => deletePhoto(id).catch((error) => reportActionError(error, error.message || '暂时无法删除图片，请重试。')) }
  ]);
  lastPhotoMenuId = id;
  lastPhotoMenu = menu;
  // 每个 popup 单独持有暂停，旧菜单稍后关闭不会解除新菜单的暂停。
  const reason = Symbol('photo-menu');
  const release = () => suspendRack(reason, false);
  suspendRack(reason, true);
  if (testMode) { release(); return; }
  try { menu.popup({ window: rackWindow, callback: release }); }
  catch (error) { release(); throw error; }
}

async function deleteNote(id) {
  if (quitting || preparingExit) throw new Error('程序正在退出，请稍后重试删除便签。');
  return enqueueStateChange(async () => {
    const result = await noteWindows.delete(id);
    status = { level: 'info', message: result.deleted ? '已删除这张便签及保存内容' : '这张便签已经删除' };
    publish();
    return result;
  });
}

function showNoteMenu(id) {
  if (!notesRepository.getNote(id)) throw new Error('找不到这张便签。');
  const menu = Menu.buildFromTemplate([
    { label: '删除', click: () => deleteNote(id).catch(error => reportActionError(error, error.message || '便签未能删除，内容已保留，请重试。')) }
  ]);
  lastNoteMenu = menu; lastNoteMenuId = id;
  const reason = Symbol('note-menu');
  const release = () => suspendRack(reason, false);
  suspendRack(reason, true);
  if (testMode) { release(); return; }
  try { menu.popup({ window: rackWindow, callback: release }); }
  catch (error) { release(); throw error; }
}

function validPoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) < 1_000_000 && Math.abs(point.y) < 1_000_000;
}

function beginDrag(point) {
  if (!validPoint(point) || !rackWindow.isVisible() || quitting) return;
  clearTimeout(moveTimer);
  autoHideController.setDragging(true);
  dragSession = { point: { ...point }, bounds: { ...expandedBounds } };
  applyInteractive(true);
  publish();
}

function moveDrag(point) {
  if (!dragSession || !validPoint(point) || quitting) return;
  const display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) });
  const area = display.workArea;
  const { width, height } = rackSizeForDisplay(display);
  const x = Math.round(dragSession.bounds.x + point.x - dragSession.point.x);
  const y = Math.round(dragSession.bounds.y + point.y - dragSession.point.y);
  changeWindowBounds({
    x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - height)),
    width, height
  });
  expandedBounds = rackWindow.getBounds();
}

function endDrag() {
  if (!dragSession) return;
  dragSession = null;
  autoHideController?.setDragging(false);
  applyInteractive(requestedInteractive);
  queuePositionSave();
  publish();
}

function recheckDisplay() {
  photoWindows?.refreshDisplays();
  if (!rackWindow || rackWindow.isDestroyed()) return;
  endDrag();
  expandedBounds = boundedPosition(expandedBounds);
  if (autoHideState().collapsed) collapseRack();
  else changeWindowBounds(expandedBounds);
  persistPosition().catch(reportError);
}

function setPaused(paused) {
  if (typeof paused !== 'boolean') throw new TypeError('paused must be boolean');
  return enqueueStateChange(async () => {
  const previous = repository.getSettings().paused;
  try {
    await collector.setPaused(paused);
    await repository.updateSettings({ paused });
    status = { level: 'info', message: paused ? '收集已暂停' : '继续收集新图片' };
    publish();
    return snapshot();
  } catch (error) {
    await collector.setPaused(previous);
    reportError(error);
    throw error;
  }
  });
}

function setAlwaysOnTop(value) {
  if (typeof value !== 'boolean') throw new TypeError('value must be boolean');
  return enqueueStateChange(async () => {
  try {
    await repository.updateSettings({ alwaysOnTop: value });
    rackWindow.setAlwaysOnTop(value || autoHideState().collapsed);
    publish();
    return snapshot();
  } catch (error) {
    reportError(error);
    throw error;
  }
  });
}

function updateTrayMenu() {
  if (!tray || !repository) return;
  const settings = repository.getSettings();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示晾衣架', click: restoreRack },
    { label: settings.paused ? '继续收集图片' : '暂停收集图片', click: () => setPaused(!repository.getSettings().paused).catch(() => {}) },
    { label: '始终置顶', type: 'checkbox', checked: settings.alwaysOnTop, click: (item) => setAlwaysOnTop(item.checked).catch(() => {}) },
    { label: '自动隐藏', type: 'checkbox', checked: settings.autoHide, click: (item) => setAutoHide(item.checked).catch(() => {}) },
    ...(settings.autoHide ? [{ label: `隐藏速度：${HIDE_LABELS[settings.autoHideSpeed]}`, submenu: Object.keys(HIDE_DELAYS).map((speed) => ({ label: HIDE_LABELS[speed], type: 'radio', checked: settings.autoHideSpeed === speed, click: () => setAutoHideSpeed(speed).catch((error) => reportActionError(error, '隐藏速度未能保存，请重试。')) })) }] : []),
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
}

function secureWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
}

async function openAppreciation() {
  if (quitting || preparingExit) return;
  endDrag();
  const existing = appreciationWindow;
  if (existing && !existing.isDestroyed()) {
    const ready = await appreciationReadiness;
    if (ready && !existing.isDestroyed()) { existing.show(); existing.focus(); }
    return;
  }
  const area = screen.getDisplayMatching(expandedBounds).workArea;
  const width = Math.min(380, area.width - 40), height = Math.min(466, area.height - 70);
  const current = new BrowserWindow({
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width, height, useContentSize: true, backgroundColor: '#faf9f5',
    title: '赞赏 · 截图晾衣架', show: false, autoHideMenuBar: true,
    resizable: false, maximizable: false, fullscreenable: false,
    icon: path.join(__dirname, 'assets', 'app.ico'),
    webPreferences: { preload: path.join(__dirname, 'appreciation-preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
  });
  let resolveReady;
  appreciationReadiness = new Promise(resolve => { resolveReady = resolve; });
  appreciationWindow = current;
  secureWindow(current);
  current.on('closed', () => {
    resolveReady(false);
    if (appreciationWindow === current) { appreciationWindow = null; appreciationReadiness = null; }
  });
  current.once('ready-to-show', () => {
    if (current.isDestroyed()) { resolveReady(false); return; }
    if (quitting || preparingExit) { current.close(); return; }
    current.show();
    resolveReady(true);
  });
  // 按需创建并在关闭后销毁；赞赏窗口不暂停衣架的自动隐藏。
  try { await current.loadFile(path.join(__dirname, 'renderer', 'appreciation.html')); }
  catch (error) { if (!current.isDestroyed()) current.close(); throw error; }
}

async function openPreview(id) {
  const photo = findPhoto(id);
  endDrag();
  const existing = previewWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    const ready = await previewReadiness.get(existing);
    if (ready && !existing.isDestroyed()) { existing.show(); existing.focus(); }
    return;
  }
  const workArea = screen.getDisplayMatching(expandedBounds).workArea;
  const maxWidth = Math.min(1080, workArea.width - 40);
  const maxHeight = Math.min(760, workArea.height - 40);
  const factor = Math.min(1, (maxWidth - 2) / photo.width, (maxHeight - 2) / photo.height);
  const width = Math.max(64, Math.min(maxWidth, Math.round(photo.width * factor) + 2));
  const height = Math.max(48, Math.min(maxHeight, Math.round(photo.height * factor) + 2));
  const currentPreview = new BrowserWindow({
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width, height,
    minWidth: 64, minHeight: 48, frame: false, backgroundColor: '#17201e',
    resizable: false, maximizable: false, fullscreenable: false, useContentSize: true, thickFrame: false,
    title: '截图晾衣架 · 图片预览', show: false, autoHideMenuBar: true, icon: path.join(__dirname, 'assets', 'app.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
  });
  let resolveReady;
  previewReadiness.set(currentPreview, new Promise((resolve) => { resolveReady = resolve; }));
  previewWindows.set(id, currentPreview);
  photoWindows.register(currentPreview, photo, { floating: false, scale: factor });
  // 图片是独立参考窗口；打开、置顶或关闭图片都不改变衣架的自动隐藏计时。
  secureWindow(currentPreview);
  currentPreview.on('closed', () => {
    resolveReady(false);
    if (previewWindows.get(id) === currentPreview) {
      previewWindows.delete(id);
    }
  });
  currentPreview.once('ready-to-show', () => {
    if (currentPreview.isDestroyed()) { resolveReady(false); return; }
    currentPreview.show();
    resolveReady(true);
  });
  try { await currentPreview.loadFile(path.join(__dirname, 'renderer', 'preview.html')); }
  catch (error) { if (!currentPreview.isDestroyed()) currentPreview.close(); throw error; }
}

function registerIPC() {
  const fromRack = (event) => rackWindow && event.sender === rackWindow.webContents && event.senderFrame === rackWindow.webContents.mainFrame;
  const previewSource = (event) => [...previewWindows.entries()].find(([, window]) => !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame);
  const floatingSource = (event) => [...floatingWindows.entries()].find(([, window]) => !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame);
  const requireRack = (event) => { if (!fromRack(event)) throw new Error('不允许的窗口请求。'); };
  ipcMain.handle('rack:get-snapshot', (event) => { requireRack(event); return snapshot(); });
  ipcMain.handle('rack:paste-clipboard', event => { requireRack(event); return pasteClipboard(); });
  ipcMain.handle('rack:import-local-images', (event, filePaths) => { requireRack(event); return importLocalImages(filePaths); });
  ipcMain.on('rack:decoded-local-webp', (event, payload) => {
    if (fromRack(event)) localWebpDecoder?.accept(event, payload);
  });
  ipcMain.on('rack:set-file-drop-active', (event, active) => {
    if (fromRack(event) && typeof active === 'boolean') setFileDropActive(active);
  });
  ipcMain.handle('rack:open-appreciation', event => { requireRack(event); return openAppreciation(); });
  ipcMain.handle('rack:close-appreciation', event => {
    const current = appreciationWindow;
    if (!current || current.isDestroyed() || event.sender !== current.webContents
      || event.senderFrame !== current.webContents.mainFrame) throw new Error('不允许的窗口请求。');
    current.close();
  });
  ipcMain.on('rack:set-paste-hover', (event, value) => {
    if (!fromRack(event) || typeof value !== 'boolean') return;
    pasteHover = value;
    updateHoverPaste();
  });
  ipcMain.handle('rack:set-paused', (event, value) => { requireRack(event); return setPaused(value); });
  ipcMain.handle('rack:set-always-on-top', (event, value) => { requireRack(event); return setAlwaysOnTop(value); });
  ipcMain.handle('rack:set-auto-hide', (event, value) => { requireRack(event); return setAutoHide(value); });
  ipcMain.handle('rack:set-auto-hide-speed', (event, speed) => { requireRack(event); return setAutoHideSpeed(speed); });
  ipcMain.handle('rack:prepare-photo-drag', async (event, id) => { requireRack(event); await preparePhotoDrag(id); return true; });
  ipcMain.on('rack:drag-photo', (event, id) => {
    if (!fromRack(event)) return;
    dragPhoto(event.sender, id)
      .catch((error) => reportActionError(error, '暂时无法拖出这张图片，请重试。'))
      .finally(() => {
        // 并行请求早退时由仍在进行的原生拖放负责结束，避免提前恢复点击穿透。
        if (nativeDragging) return;
        applyInteractive(false);
        if (!event.sender.isDestroyed()) event.sender.send('rack:photo-drag-ended', screen.getCursorScreenPoint());
      });
  });
  ipcMain.on('rack:photo-menu', (event, id) => { if (fromRack(event)) { try { showPhotoMenu(id); } catch (error) { reportActionError(error, error.message); } } });
  ipcMain.on('rack:note-menu', (event, id) => { if (fromRack(event)) { try { showNoteMenu(id); } catch (error) { reportActionError(error, error.message); } } });
  ipcMain.handle('rack:hide', (event) => { requireRack(event); hideRack(); });
  ipcMain.handle('rack:open-preview', (event, id) => { requireRack(event); return openPreview(id); });
  ipcMain.handle('rack:add-note', (event) => { requireRack(event); endDrag(); return noteWindows.open(); });
  ipcMain.handle('rack:open-note', (event, id) => { requireRack(event); endDrag(); return noteWindows.open(id); });
  ipcMain.handle('rack:get-note', event => noteWindows.get(event));
  ipcMain.handle('rack:save-note', (event, payload) => noteWindows.save(event, payload));
  ipcMain.handle('rack:close-note', (event, payload) => noteWindows.close(event, payload));
  ipcMain.handle('rack:set-note-always-on-top', (event, value) => noteWindows.setAlwaysOnTop(event, value));
  for (const [channel, method] of [['rack:begin-note-drag', 'beginDrag'], ['rack:move-note-drag', 'moveDrag'], ['rack:end-note-drag', 'endDrag']]) {
    ipcMain.on(channel, (event, point) => {
      try { noteWindows[method](event, point); }
      catch (error) { console.error('[便签窗口请求]', error.message); }
    });
  }
  ipcMain.on('rack:set-interactive', (event, value) => {
    if (fromRack(event) && typeof value === 'boolean') applyInteractive(value);
  });
  ipcMain.on('rack:begin-drag', (event, point) => { if (fromRack(event)) beginDrag(point); });
  ipcMain.on('rack:move-drag', (event, point) => { if (fromRack(event)) moveDrag(point); });
  ipcMain.on('rack:end-drag', (event) => { if (fromRack(event)) endDrag(); });
  ipcMain.handle('rack:get-preview', (event) => {
    const preview = previewSource(event);
    const floating = floatingSource(event);
    if (!preview && !floating) throw new Error('不允许的窗口请求。');
    const photo = repository.getPhoto(floating ? floating[0] : preview[0]);
    return photo ? { ...publicPhoto(photo), floating: !!floating, state: photoWindows.getState(event) } : null;
  });
  ipcMain.handle('rack:resize-preview', (event, payload) => photoWindows.resize(event, payload));
  ipcMain.handle('rack:set-preview-always-on-top', (event, value) => photoWindows.setAlwaysOnTop(event, value));
  ipcMain.handle('rack:preview-menu', event => photoWindows.showMenu(event));
  for (const [channel, method] of [['rack:begin-preview-drag', 'beginDrag'], ['rack:move-preview-drag', 'moveDrag'], ['rack:end-preview-drag', 'endDrag']]) {
    ipcMain.on(channel, event => {
      try { photoWindows[method](event); }
      catch (error) { console.error('[图片窗口请求]', error.message); }
    });
  }
  for (const [channel, method] of [['rack:begin-preview-resize', 'beginFrameResize'], ['rack:move-preview-resize', 'moveFrameResize'], ['rack:end-preview-resize', 'endFrameResize']]) {
    ipcMain.on(channel, (event, edge) => {
      try { photoWindows[method](event, edge); }
      catch (error) { console.error('[图片边框请求]', error.message); }
    });
  }
  ipcMain.handle('rack:close-preview', (event) => {
    const preview = previewSource(event);
    const floating = floatingSource(event);
    if (floating) floating[1].close();
    else if (preview) preview[1].close();
    else throw new Error('不允许的窗口请求。');
  });
}

async function serveImage(request) {
  try {
    const url = new URL(request.url);
    if (request.method !== 'GET' || !['photo', 'thumbnail'].includes(url.hostname)) return new Response(null, { status: 403 });
    const id = url.pathname.slice(1);
    if (!/^[a-f0-9]{64}$/.test(id)) return new Response(null, { status: 404 });
    const photo = repository.getPhoto(id);
    if (!photo) return new Response(null, { status: 404 });
    const thumbnail = url.hostname === 'thumbnail';
    const fileName = thumbnail ? photo.thumbnailName : photo.fileName;
    if (path.basename(fileName) !== fileName) return new Response(null, { status: 403 });
    const imagePath = thumbnail ? await repository.ensureCompactThumbnail(id, async bytes => {
      const header = inspectEncodedImage(bytes, 'image/png');
      if (header.width <= 288 && header.height <= 176) return { buffer: bytes, changed: false };
      const native = nativeImage.createFromBuffer(bytes);
      if (native.isEmpty()) throw new Error('缩略图无法读取。');
      const size = native.getSize();
      const factor = Math.min(1, 288 / size.width, 176 / size.height);
      return factor === 1 ? { buffer: bytes, changed: false } : { buffer: native.resize({ width: Math.max(1, Math.round(size.width * factor)), height: Math.max(1, Math.round(size.height * factor)), quality: 'best' }).toPNG(), changed: true };
    }) : path.join(app.getPath('userData'), 'photos', fileName);
    const data = await fs.readFile(imagePath);
    return new Response(data, { headers: { 'Content-Type': thumbnail ? 'image/png' : mimeForFile(fileName), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) {
    console.error('[图片读取失败]', error.message);
    return new Response(null, { status: 404 });
  }
}

async function launch() {
  photoWindows = new PhotoWindows({
    screen: {
      getCursorScreenPoint: () => testPreviewCursorPoint || screen.getCursorScreenPoint(),
      getDisplayNearestPoint: point => screen.getDisplayNearestPoint(point),
      getDisplayMatching: bounds => screen.getDisplayMatching(bounds),
      getAllDisplays: () => screen.getAllDisplays()
    },
    Menu, popupMenus: !testMode,
    onError: error => reportActionError(error, '图片窗口操作失败，请重试。')
  });
  repository = new PhotoRepository(app.getPath('userData'));
  await repository.init();
  localWebpDecoder = new RendererImageDecoder({ getWindow: () => rackWindow, nativeImage });
  localImageImporter = new LocalImageImporter({ nativeImage, repository, onPhoto: publish,
    decodeWebp: (bytes, header) => localWebpDecoder.decode(bytes, header) });
  notesRepository = new NotesRepository(app.getPath('userData'));
  await notesRepository.init();
  const systemReadImage = createClipboardReader(clipboard, nativeImage);
  const testReadImage = testMode ? createClipboardReader({
    read: async () => testClipboardBytes ? [{
      types: ['image/png'],
      getType: async () => new Blob([testClipboardBytes], { type: 'image/png' })
    }] : []
  }, nativeImage) : null;
  collector = new ClipboardCollector({
    readImage: async () => useTestClipboard ? testReadImage() : systemReadImage(),
    repository,
    intervalMs: 800,
    onPhoto: () => { status = { level: 'info', message: '' }; publish(); },
    onError: reportError
  });
  if (testMode) useTestClipboard = true;
  protocol.handle('rack-image', serveImage);
  const settings = repository.getSettings();
  expandedBounds = boundedPosition(settings.bounds);
  rackWindow = new BrowserWindow({
    ...expandedBounds, frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, maximizable: false, fullscreenable: false, hasShadow: false, thickFrame: false, useContentSize: true,
    skipTaskbar: true, show: false, alwaysOnTop: settings.alwaysOnTop, title: '截图晾衣架', icon: path.join(__dirname, 'assets', 'app.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
  });
  expandedBounds = rackWindow.getBounds();
  autoHideController = new AutoHideController({
    getExpandedBounds: () => expandedBounds,
    getDisplayBounds: () => screen.getDisplayMatching(expandedBounds).bounds,
    onCollapse: collapseRack,
    onExpand: expandRack,
    onChange: () => { updateHoverPaste(); publish(); },
    delayMs: HIDE_DELAYS[settings.autoHideSpeed],
    edgeSize: 8,
    now: () => testClock ?? Date.now()
  });
  autoHideController.setEnabled(settings.autoHide);
  hoverPasteController = new HoverPasteController({
    globalShortcut, getEligibility: pasteEligibility, onPaste: pasteClipboard,
    onChange: publish,
    onError: error => reportActionError(error, '粘贴失败，请重新复制图片后重试。')
  });
  noteWindows = new NoteWindows({
    BrowserWindow, screen, repository: notesRepository,
    rendererDir: path.join(__dirname, 'renderer'), preload: path.join(__dirname, 'preload.cjs'),
    icon: path.join(__dirname, 'assets', 'app.ico'), getRackBounds: () => expandedBounds,
    suspend: suspendRack, canOpen: () => !quitting && !preparingExit,
    onChange: result => {
      if (result) status = { level: 'info', message: result.deleted ? '已删除这张便签及保存内容' : result.added ? '便签已挂到晾衣架' : '便签已保存' };
      publish();
    },
    onError: error => reportActionError(error, '便签未能保存，内容和窗口已保留，请重试关闭。')
  });
  secureWindow(rackWindow);
  rackWindow.on('move', queuePositionSave);
  rackWindow.on('resize', queuePositionSave);
  rackWindow.on('hide', () => { setFileDropActive(false); pasteHover = false; updateHoverPaste(); });
  rackWindow.on('blur', () => { pasteHover = false; updateHoverPaste(); });
  rackWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); hideRack(); } });
  rackWindow.once('ready-to-show', () => {
    applyInteractive(false); rackWindow.showInactive();
    autoHideTimer = setInterval(() => {
      if (quitting || rackWindow.isDestroyed()) return;
      // 与已有轻量轮询复用；拖放中取消、失焦或漏发 dragleave 时自动恢复。
      if (fileDropActive && Date.now() >= fileDropDeadline) setFileDropActive(false);
      autoHideController.tick(testCursorPoint || screen.getCursorScreenPoint());
      updateHoverPaste();
    }, 50);
    autoHideTimer.unref();
  });
  registerIPC();
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(trayIcon);
  tray.setToolTip('截图晾衣架 · 把灵感晾起来');
  tray.on('double-click', restoreRack);
  updateTrayMenu();
  await collector.start({ paused: settings.paused });
  if (testMode) {
    app.__rackTest = {
      setClipboardImage: (dataURL) => {
        const encoded = typeof dataURL === 'string' ? /^data:image\/png;base64,(.*)$/s.exec(dataURL) : null;
        testClipboardBytes = encoded ? Buffer.from(encoded[1], 'base64') : null;
      },
      poll: () => collector.pollOnce(),
      hoverPaste: (point, hovering = true) => { testCursorPoint = point; pasteHover = hovering; updateHoverPaste(); return hoverPasteController.getState(); },
      triggerPaste: () => hoverPasteController.trigger(),
      pasteState: () => hoverPasteController.getState(),
      snapshot,
      notes: () => notesRepository.getNotes(),
      noteRuntime: () => noteWindows.runtime(),
      failNextNoteSave: () => {
        const save = notesRepository.saveNote.bind(notesRepository);
        notesRepository.saveNote = payload => { notesRepository.saveNote = save; return Promise.reject(new Error('测试：便签保存失败')); };
      },
      failNextNoteDelete: () => {
        const remove = notesRepository.deleteNote.bind(notesRepository);
        notesRepository.deleteNote = id => { notesRepository.deleteNote = remove; return Promise.reject(new Error('测试：便签删除失败')); };
      },
      failNextLocalImageSave: () => {
        const save = repository.savePhoto.bind(repository);
        repository.savePhoto = image => { repository.savePhoto = save; return Promise.reject(new Error('测试：本机图片保存失败')); };
      },
      noteMenu: () => lastNoteMenu ? { id: lastNoteMenuId, labels: lastNoteMenu.items.map(item => item.label) } : null,
      chooseNoteMenu: label => {
        const item = lastNoteMenu?.items.find(entry => entry.label === label);
        if (!item) throw new Error('测试便签菜单项不存在');
        return item.click(item, rackWindow);
      },
      deleteNote,
      restore: restoreRack,
      runtime: () => ({ visible: rackWindow.isVisible(), alwaysOnTop: rackWindow.isAlwaysOnTop(), ignoringMouseEvents, fileDropActive, importing: !!localImportPromise, bounds: rackWindow.getBounds(), expandedBounds, autoHide: autoHideState(), displayBounds: screen.getDisplayMatching(expandedBounds).bounds, imagePreviews: [...previewWindows.entries()].filter(([, window]) => !window.isDestroyed()).map(([id, window]) => ({ id, visible: window.isVisible(), alwaysOnTop: window.isAlwaysOnTop(), bounds: window.getBounds() })), floating: [...floatingWindows.entries()].filter(([, window]) => !window.isDestroyed()).map(([id, window]) => ({ id, visible: window.isVisible(), alwaysOnTop: window.isAlwaysOnTop(), bounds: window.getBounds() })), nativeDragging, preparedDragCount: preparedDrags.size, hardwareAcceleration: app.isHardwareAccelerationEnabled(), lastNativeDrag, lastPhotoMenu: lastPhotoMenu ? { id: lastPhotoMenuId, labels: lastPhotoMenu.items.map((item) => item.label) } : null, trayCreated: !!tray, dataDir: app.getPath('userData') }),
      workArea: () => screen.getDisplayMatching(expandedBounds).workArea,
      physicalWindow: () => {
        const bounds = rackWindow.getBounds();
        const display = screen.getDisplayMatching(bounds);
        return { bounds, physicalBounds: screen.dipToScreenRect(rackWindow, bounds), scaleFactor: display.scaleFactor, displayBounds: display.bounds };
      },
      choosePhotoMenu: (label) => {
        const item = lastPhotoMenu?.items.find((entry) => entry.label === label);
        if (!item) throw new Error('测试菜单项不存在');
        return item.click(item, rackWindow);
      },
      deletePhoto,
      setPreviewCursor: point => {
        if (point !== null && (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) throw new TypeError('测试鼠标坐标无效');
        testPreviewCursorPoint = point;
      },
      previewMenu: () => photoWindows.getLastMenu(),
      choosePreviewMenu: label => {
        const menu = photoWindows.getLastMenu();
        if (!menu) throw new Error('测试图片窗口菜单不存在');
        return photoWindows.chooseMenu(menu.windowId, label);
      },
      retryDeletes: () => repository.retryPendingDeletes(),
      setAutoHideCursor: (point) => { testCursorPoint = point; testClock = null; },
      autoHideTick: (point, advanceMs = 0) => {
        testCursorPoint = point;
        testClock = (testClock ?? Date.now()) + advanceMs;
        autoHideController.tick(point, testClock);
        updateHoverPaste();
        return autoHideState();
      },
      persistPosition,
      clipboardAPI: async () => ({ read: typeof clipboard.read, items: (await clipboard.read()).map((item) => ({ types: item.types })) })
    };
  }
  const cleanup = await repository.retryPendingDeletes();
  if (cleanup.remaining > 0) startDeleteCleanup();
  screen.on('display-removed', recheckDisplay);
  screen.on('display-added', recheckDisplay);
  screen.on('display-metrics-changed', recheckDisplay);
  await rackWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', restoreRack);
  app.whenReady().then(launch).catch((error) => {
    console.error(error);
    dialog.showErrorBox('晾衣架暂时无法启动', `请确认本地数据目录可访问。已有图片不会被删除。\n\n${error.message}`);
    app.exit(1);
  });
  app.on('before-quit', (event) => {
    if (quitting || !repository) return;
    event.preventDefault();
    if (preparingExit) return;
    preparingExit = true;
    (async () => {
      try {
        await noteWindows?.flushAll();
        // 已提交的便签删除必须在进入 quitting 前完成，避免排队操作被跳过。
        await stateChanges;
      } catch (error) {
        preparingExit = false;
        reportActionError(error, '有便签暂时没能保存，窗口已保留。请重试关闭便签后再退出。');
        return;
      }
      quitting = true;
      setFileDropActive(false);
      clearTimeout(moveTimer);
      clearInterval(autoHideTimer);
      clearInterval(deleteCleanupTimer);
      hoverPasteController?.dispose();
      photoWindows?.dispose();
      endDrag();
      autoHideController?.dispose();
      collector?.stop();
      await stateChanges;
      await persistPosition().catch(error => console.error(error));
      app.quit();
    })().catch(error => console.error('[退出保存]', error));
  });
  app.on('will-quit', () => hoverPasteController?.dispose());
}
