'use strict';

// 只创建隔离测试数据；图片/便签的移除全部经过用户要求的应用删除入口。
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const mode = process.env.RACK_EXE ? 'packaged' : 'development';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const artifacts = path.join(root, 'test-artifacts', `v${version}`, `group-refresh-${mode}`, runId);
const profile = path.join(artifacts, 'profile');
const fixtureDir = path.join(artifacts, 'fixtures');
const report = { version, date: new Date().toISOString(), mode, executable: process.env.RACK_EXE || require('electron'),
  scaleRequested: process.env.RACK_SCALE || null, profile, tests: [], pageErrors: [],
  clipboard: '仅使用隔离 app.__rackTest PNG 输入，不读取或改写系统剪贴板。',
  retention: 'fixtures、profile、报告和实际截图保留。应用内删除仅针对本次测试创建并明确确认的组及其成员。',
  limits: ['截图使用合成素材，不包含日常剪贴板图片或用户便签。',
    '显示缩放可用 RACK_SCALE 独立验证；此脚本不替代真实不同 DPI 显示器之间的人工移动。'] };
const observed = new WeakSet(), diagnostics = [];
let application, rack, groupPage;
const delay = (ms = 35) => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hook = (name, ...args) => application.evaluate(({ app }, { name, args }) => app.__rackTest[name](...args), { name, args });
const snapshot = () => rack.evaluate(() => window.rack.getSnapshot());
const apply = operation => rack.evaluate(operation => window.rack.applyLayout(operation), operation);
const runtime = () => hook('runtime');
const getGroup = () => groupPage.evaluate(() => window.groupBrowser.getGroup());

async function persistReport() {
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
}

function observe(page) {
  if (observed.has(page)) return;
  observed.add(page);
  page.on('pageerror', error => report.pageErrors.push({ url: page.url(), error: error.message }));
}

async function check(name, action) {
  const started = Date.now();
  try {
    const detail = await action();
    report.tests.push({ name, passed: true, durationMs: Date.now() - started, detail });
    console.log(`通过：${name}`);
  } catch (error) {
    report.tests.push({ name, passed: false, durationMs: Date.now() - started, error: error.stack });
    if (rack && !rack.isClosed()) await rack.screenshot({ path: path.join(artifacts, 'failure-rack.png'), omitBackground: true }).catch(() => {});
    if (groupPage && !groupPage.isClosed()) await groupPage.screenshot({ path: path.join(artifacts, 'failure-group.png') }).catch(() => {});
    throw error;
  } finally { await persistReport(); }
}

async function poll(read, accept, label, timeout = 10000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (accept(value)) return value;
    await delay();
  }
  throw new Error(`等待${label}超时：${JSON.stringify(value)}`);
}

async function launch() {
  const env = { ...process.env, RACK_TEST_MODE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.RACK_EXE || require('electron'),
    args: [...(process.env.RACK_EXE ? [] : [root]), '--rack-test', `--data-dir=${profile}`,
      ...(process.env.RACK_SCALE ? [`--force-device-scale-factor=${process.env.RACK_SCALE}`] : [])],
    env, cwd: root, timeout: 60000 });
  application.on('window', observe);
  application.process().stderr?.on('data', chunk => { diagnostics.push(chunk.toString()); if (diagnostics.length > 70) diagnostics.shift(); });
  rack = await application.firstWindow(); observe(rack);
  await rack.waitForFunction(() => typeof window.rack?.applyLayout === 'function');
  await poll(() => application.evaluate(({ app }) => typeof app.__rackTest?.lastGroupDeleteResult === 'function'), Boolean, '整组删除测试接口');
  await rack.evaluate(() => window.rack.setAutoHide(false));
}

async function closeApplication() {
  if (!application) return;
  await application.close(); application = null; groupPage = null;
}

async function openGroup(id) {
  const existing = application.windows().find(page => page.url().endsWith('/group.html'));
  const pending = existing ? null : application.waitForEvent('window');
  await rack.evaluate(id => window.rack.openGroup(id), id);
  groupPage = existing || await pending; observe(groupPage);
  await groupPage.waitForFunction(() => document.getElementById('groupName') && !document.getElementById('groupName').disabled
    && document.querySelector('.group-member'));
  await poll(getGroup, value => value.id === id, '组面板切换');
  await groupPage.bringToFront();
  return groupPage;
}

async function createGroup(ids, name) {
  let state = await apply({ type: 'group', sourceId: ids[1], targetId: ids[0] });
  const created = state.items.find(item => item.type === 'group' && item.memberIds.includes(ids[0]));
  assert(created, '实际 IPC 必须创建组');
  for (const id of ids.slice(2)) await apply({ type: 'group', sourceId: id, targetId: created.id });
  await apply({ type: 'rename', groupId: created.id, name });
  return created.id;
}

async function readJSON(file) { return JSON.parse(await fs.readFile(path.join(profile, file), 'utf8')); }

async function photoFiles(id) {
  const result = {};
  for (const folder of ['photos', 'thumbnails', 'exports']) {
    const names = await fs.readdir(path.join(profile, folder)).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    result[folder] = names.filter(name => name.startsWith(`${id}.`));
  }
  return result;
}

async function assertPhotoPresent(id, present) {
  const index = await readJSON('index.json');
  assert.equal(index.photos.some(photo => photo.id === id), present, `照片索引状态：${id}`);
  const files = await photoFiles(id);
  if (present) {
    assert(files.photos.length > 0, '保留原图'); assert(files.thumbnails.length > 0, '保留缩略图');
  } else assert(Object.values(files).every(names => names.length === 0), `仅删除指定成员的原图/缩略图/导出缓存：${JSON.stringify(files)}`);
  return files;
}

async function assertNotesPresent(ids, present) {
  const notes = await readJSON('notes.json');
  for (const id of ids) assert.equal(notes.notes.some(note => note.id === id), present, `便签正文索引状态：${id}`);
}

async function dataFingerprint() {
  const result = {};
  for (const file of ['index.json', 'notes.json', 'layout.json']) result[file] = digest(await fs.readFile(path.join(profile, file)));
  const index = await readJSON('index.json');
  for (const photo of index.photos) {
    for (const [folder, name] of [['photos', photo.fileName], ['thumbnails', photo.thumbnailName]]) {
      result[`${folder}/${name}`] = digest(await fs.readFile(path.join(profile, folder, name)));
    }
  }
  return result;
}

async function groupMenu(id, source = 'rack') {
  if (source === 'rack') await rack.evaluate(id => window.rack.showGroupMenu(id), id);
  else if (source === 'api') await groupPage.evaluate(() => window.groupBrowser.showGroupMenu());
  else throw new Error(`未知菜单来源：${source}`);
  return poll(() => hook('groupMenu'), value => value?.id === id, '当前组菜单');
}

async function chooseDelete(id, response, source = 'rack') {
  await hook('setGroupDeleteConfirmation', response);
  const menu = await groupMenu(id, source);
  assert(menu.labels.includes('重命名')); assert(menu.labels.includes('解散组')); assert(menu.labels.includes('删除整个组'));
  const result = await hook('chooseGroupMenu', '删除整个组');
  const confirmation = await hook('lastGroupDeleteConfirmation');
  assert.equal(confirmation.id, id); assert.equal(confirmation.response, response ? 1 : 0);
  return { result, confirmation, menu };
}

async function openPhoto(id) {
  const existing = new Set(application.windows());
  await groupPage.evaluate(id => window.groupBrowser.openItem(id), id);
  const page = await poll(async () => application.windows().find(page => !existing.has(page) && page.url().endsWith('/preview.html')), Boolean, '成员原图窗口');
  observe(page);
  await page.waitForFunction(() => document.getElementById('previewImage')?.naturalWidth > 0);
  return page;
}

async function openNote(id) {
  const existing = new Set(application.windows());
  await groupPage.evaluate(id => window.groupBrowser.openItem(id), id);
  const page = await poll(async () => application.windows().find(page => !existing.has(page) && page.url().endsWith('/note.html')), Boolean, '成员便签窗口');
  observe(page);
  await page.waitForFunction(() => document.getElementById('noteInput') && !document.getElementById('noteInput').disabled);
  return page;
}

async function run() {
  await fs.mkdir(fixtureDir, { recursive: true });
  await launch();
  let photoIds, noteIds, photoGroupId, noteGroupId, partialGroupId;
  let photoPages, notePages, outsidePhotoDigest, outsideNote;

  await check('隔离启动并创建 5 张合成参考图，系统剪贴板保持不变', async () => {
    assert.equal((await runtime()).dataDir, profile); assert.equal((await snapshot()).counts.photos, 0);
    const dataURLs = await rack.evaluate(() => Array.from({ length: 5 }, (_, index) => {
      const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 720;
      const ctx = canvas.getContext('2d');
      const palettes = [['#c5d0ae','#627453','#e5d8b7'],['#dac8b8','#97654d','#b6c5b1'],['#c6d9dd','#4c777a','#e2dbc0'],['#ded2af','#8d7951','#a6b995'],['#d9c9d5','#86647a','#beccb1']];
      const colors = palettes[index];
      ctx.fillStyle = '#f6f0e4'; ctx.fillRect(0,0,960,720);
      ctx.fillStyle = colors[0]; ctx.fillRect(36,36,888,648);
      ctx.fillStyle = colors[2]; ctx.beginPath(); ctx.ellipse(660,480,220,150,-.2,0,Math.PI*2); ctx.fill();
      ctx.fillStyle = colors[1]; ctx.beginPath(); ctx.moveTo(120,590); ctx.lineTo(420,150); ctx.lineTo(720,590); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fbf6ea'; ctx.beginPath(); ctx.arc(720,170,70,0,Math.PI*2); ctx.fill();
      ctx.fillStyle = '#3b3b30'; ctx.font = 'bold 36px Microsoft YaHei';
      ctx.fillText(['午后的一点灵感','沿途的颜色','留住温柔时刻','桌边的小风景','组外图片 · 请保留'][index],72,645);
      return canvas.toDataURL('image/png');
    }));
    for (let index = 0; index < dataURLs.length; index += 1) {
      await fs.writeFile(path.join(fixtureDir, `参考-${index + 1}.png`), Buffer.from(dataURLs[index].split(',')[1], 'base64'), { flag: 'wx' });
      await hook('setClipboardImage', dataURLs[index]); await hook('poll');
      await poll(snapshot, state => state.counts.photos === index + 1, '收集测试图片');
    }
    await rack.evaluate(() => window.rack.setPaused(true));
    photoIds = (await snapshot()).photos.map(photo => photo.id);
    const index = await readJSON('index.json'), outside = index.photos.find(photo => photo.id === photoIds[4]);
    outsidePhotoDigest = digest(await fs.readFile(path.join(profile, 'photos', outside.fileName)));
    return { photos: photoIds, fixtures: fixtureDir, testClipboardOnly: true };
  });

  await check('创建 3 张不同颜色便签及两类分组，组外内容独立保留', async () => {
    for (let index = 0; index < 3; index += 1) {
      const opened = application.waitForEvent('window'); await rack.evaluate(() => window.rack.addNote());
      const page = await opened; observe(page);
      await page.waitForFunction(() => document.getElementById('noteInput') && !document.getElementById('noteInput').disabled);
      await page.locator('#noteInput').fill(['灵感清单\n奶油白，鼠尾草绿，还有自然原木色。\n把散落的想法，整理成喜欢的样子。',
        '今天想做的事\n收集参考，留一点空白。\n慢慢来，也会有新的发现。', '组外便签 · 请保留\n这段内容不应受到整组删除影响。'][index]);
      await page.locator('#noteFontSize').selectOption('32');
      await page.locator('#noteCustomColor').evaluate((input, color) => { input.value = color; input.dispatchEvent(new Event('input', { bubbles: true })); },
        ['#fff0b8', '#dbe9d5', '#dce7f1'][index]);
      const closed = page.waitForEvent('close'); await page.locator('#noteCloseButton').click(); await closed;
    }
    noteIds = (await hook('notes')).map(note => note.id);
    assert.equal(noteIds.length, 3);
    outsideNote = (await hook('notes')).find(note => note.id === noteIds[2]);
    photoGroupId = await createGroup(photoIds.slice(0, 4), '日常灵感 · 图片集');
    noteGroupId = await createGroup(noteIds.slice(0, 2), '桌边的灵感');
    const state = await snapshot(); assert.equal(state.counts.groups, 2);
    return { photoGroupId, noteGroupId, outsidePhoto: photoIds[4], outsideNote: noteIds[2], counts: state.counts };
  });

  await check('新版图片组使用缩略图、响应网格且无横向溢出，拍摄真实界面', async () => {
    await openGroup(photoGroupId);
    await groupPage.waitForFunction(() => [...document.querySelectorAll('.photo-thumbnail')].every(image => image.complete && image.naturalWidth > 0));
    const detail = await groupPage.evaluate(() => {
      const grid = document.getElementById('groupGrid'), scroll = document.getElementById('groupScroll');
      return { viewport: innerWidth, columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        scrollOverflowX: getComputedStyle(scroll).overflowX, scrollOverflowY: getComputedStyle(scroll).overflowY,
        images: [...document.querySelectorAll('.photo-thumbnail')].map(image => ({ url: image.src, width: image.naturalWidth, height: image.naturalHeight })),
        title: document.title, background: getComputedStyle(document.body).backgroundColor,
        titleBarHeight: document.querySelector('.window-titlebar')?.getBoundingClientRect().height || 0,
        titleBarOverlay: navigator.windowControlsOverlay ? { visible: navigator.windowControlsOverlay.visible,
          area: (() => { const rect = navigator.windowControlsOverlay.getTitlebarAreaRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })() } : null };
    });
    assert(detail.columns >= 2); assert.equal(detail.pageOverflow, false);
    assert.equal(detail.scrollOverflowX, 'hidden'); assert.equal(detail.scrollOverflowY, 'auto');
    assert.equal(detail.titleBarOverlay?.visible, true, 'Windows 原生窗口按钮使用预留标题栏区域');
    assert(detail.titleBarHeight >= 32 && detail.titleBarHeight <= 44);
    assert.equal(detail.titleBarOverlay.area.height, detail.titleBarHeight);
    assert(detail.images.every(image => image.url.startsWith('rack-image://thumbnail/') && image.width < 960));
    assert.equal(detail.images.length, 4);
    await groupPage.screenshot({ path: path.join(artifacts, 'polished-photo-group.png') });
    const native = await application.browserWindow(groupPage), original = await native.evaluate(window => window.getBounds());
    const widths = [];
    for (const width of [500, 320, original.width]) {
      await native.evaluate((window, width) => window.setBounds({ ...window.getBounds(), width }), width);
      await delay(100);
      widths.push(await groupPage.evaluate(() => ({ viewport: innerWidth, columns: getComputedStyle(document.getElementById('groupGrid')).gridTemplateColumns.split(' ').length,
        overflow: document.documentElement.scrollWidth > innerWidth })));
    }
    assert(widths[0].columns <= detail.columns); assert.equal(widths[1].columns, 1); assert(widths.every(value => !value.overflow));
    return { ...detail, widths };
  });

  await check('便签组复用窗口，摘要固定 14px，完整编辑字号仍为 32px', async () => {
    const windowId = (await hook('groupRuntime'))[0].windowId;
    await openGroup(noteGroupId);
    assert.equal((await hook('groupRuntime'))[0].windowId, windowId);
    assert.equal((await hook('groupRuntime')).length, 1);
    const fontSizes = await groupPage.locator('.note-summary').evaluateAll(elements => elements.map(element => getComputedStyle(element).fontSize));
    assert.deepEqual(fontSizes, ['14px', '14px']);
    await groupPage.screenshot({ path: path.join(artifacts, 'polished-note-group.png') });
    const page = await openNote(noteIds[0]); assert.equal(await page.locator('#noteFontSize').inputValue(), '32');
    const closed = page.waitForEvent('close'); await page.locator('#noteCloseButton').click(); await closed;
    return { windowId, fontSizes, editorFontSize: 32 };
  });

  await check('组窗口独立置顶仅影响当前组，按钮与实际状态一致', async () => {
    await openGroup(photoGroupId);
    const photoPage = await openPhoto(photoIds[0]);
    await photoPage.evaluate(() => window.rack.setPreviewAlwaysOnTop(false));
    const before = await runtime();
    assert.equal(await rack.evaluate(() => typeof window.groupBrowser), 'undefined', '衣架页面没有组窗口置顶接口');
    const native = await application.browserWindow(groupPage);
    await native.evaluate(window => { window.__groupPinEvents = []; window.on('always-on-top-changed', (_event, value) => window.__groupPinEvents.push(value)); });
    const states = [];
    for (const requested of [true, false]) {
      const returned = await groupPage.evaluate(value => window.groupBrowser.setAlwaysOnTop(value), requested);
      const actual = await native.evaluate(window => window.isAlwaysOnTop());
      const pressed = await poll(() => groupPage.locator('#groupPin').getAttribute('aria-pressed'), value => value === String(actual), '置顶按钮状态');
      assert.equal(actual, requested); assert.equal(returned, actual);
      assert.equal(pressed, String(actual));
      const after = await runtime(); assert.equal(after.alwaysOnTop, before.alwaysOnTop);
      assert.deepEqual(after.imagePreviews.map(item => ({ id: item.id, alwaysOnTop: item.alwaysOnTop })),
        before.imagePreviews.map(item => ({ id: item.id, alwaysOnTop: item.alwaysOnTop })));
      states.push({ requested, returned, actual, ariaPressed: pressed });
    }
    await groupPage.bringToFront(); await groupPage.locator('#groupPin').click();
    await poll(() => native.evaluate(window => window.isAlwaysOnTop()), value => value === true, '实际点击置顶按钮');
    await poll(() => groupPage.locator('#groupPin').getAttribute('aria-pressed'), value => value === 'true', '置顶按钮已按下');
    await groupPage.locator('#groupPin').click();
    await poll(() => native.evaluate(window => window.isAlwaysOnTop()), value => value === false, '实际点击取消置顶');
    const events = await native.evaluate(window => window.__groupPinEvents);
    const closed = photoPage.waitForEvent('close'); await photoPage.evaluate(() => window.rack.closePreview()); await closed;
    return { states, nativeEvents: events, rackAndPhotoUnaffected: true };
  });

  await check('顶部更多菜单和组内空白右键都提供整组操作，成员右键保持成员操作', async () => {
    await openGroup(photoGroupId);
    await groupPage.locator('#groupMenu').click();
    const toolbarMenu = await poll(() => hook('groupMenu'), value => value?.id === photoGroupId, '更多菜单');
    assert(toolbarMenu.labels.includes('删除整个组'));
    await groupPage.locator('#groupScroll').evaluate(element => {
      element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    });
    const blankMenu = await poll(() => hook('groupMenu'), value => value?.id === photoGroupId, '空白右键组菜单');
    assert(blankMenu.labels.includes('删除整个组'));
    await groupPage.locator('.group-member').first().click({ button: 'right' });
    const member = await poll(() => hook('groupMemberMenu'), value => value?.groupId === photoGroupId, '成员右键菜单');
    assert(member.labels.includes('移出此组')); assert(member.labels.includes('删除')); assert(!member.labels.includes('删除整个组'));
    return { toolbarMenu, blankMenu, member };
  });

  await check('取消整组删除时布局、原图、缩略图与便签正文逐字节保持不变', async () => {
    const before = await dataFingerprint(); const state = await snapshot();
    const outcome = await chooseDelete(photoGroupId, false, 'api');
    assert.equal(outcome.result.cancelled, true); assert.equal(outcome.confirmation.count, 4);
    assert.deepEqual(await dataFingerprint(), before); assert.deepEqual((await snapshot()).items, state.items);
    assert.equal((await hook('groupRuntime'))[0].groupId, photoGroupId);
    return { ...outcome, unchangedFiles: Object.keys(before).length };
  });

  await check('两张图片整组删除不因中途单成员塌缩而漏删，同时关闭成员窗口及清缓存', async () => {
    await groupPage.evaluate(({ groupId, id }) => window.groupBrowser.applyLayout({ type: 'remove', groupId, id }), { groupId: photoGroupId, id: photoIds[2] });
    await groupPage.evaluate(({ groupId, id }) => window.groupBrowser.applyLayout({ type: 'remove', groupId, id }), { groupId: photoGroupId, id: photoIds[3] });
    await poll(getGroup, group => group.items.length === 2, '两成员图片组');
    await groupPage.bringToFront();
    await groupPage.screenshot({ path: path.join(artifacts, 'polished-two-photo-group.png') });
    photoPages = [await openPhoto(photoIds[0]), await openPhoto(photoIds[1])];
    await groupPage.evaluate(id => window.groupBrowser.showMemberMenu(id), photoIds[0]);
    await poll(() => hook('groupMemberMenu'), value => value?.id === photoIds[0], '悬浮成员菜单');
    await hook('chooseGroupMemberMenu', '悬浮');
    await poll(runtime, state => state.floating.some(item => item.id === photoIds[0]), '悬浮成员窗口');
    await groupPage.evaluate(id => window.groupBrowser.preparePhotoDrag(id), photoIds[0]);
    const outcome = await chooseDelete(photoGroupId, true);
    assert.deepEqual(new Set(outcome.result.deletedIds), new Set(photoIds.slice(0, 2)));
    assert.deepEqual(outcome.result.remainingIds, []); assert.equal(outcome.confirmation.count, 2);
    await poll(() => hook('groupRuntime'), value => value.length === 0, '删除后销毁组面板');
    await poll(runtime, value => !value.imagePreviews.length && !value.floating.length && value.preparedDragCount === 0, '成员原图/悬浮/拖出准备清理');
    assert(photoPages.every(page => page.isClosed()));
    for (const id of photoIds.slice(0, 2)) await assertPhotoPresent(id, false);
    for (const id of photoIds.slice(2)) await assertPhotoPresent(id, true);
    return { ...outcome, originalThumbnailAndExportRemoved: true, memberWindowsClosed: true };
  });

  await check('便签整组删除首次失败保留全部正文及窗口，确认重试后完整删除两成员', async () => {
    await openGroup(noteGroupId);
    notePages = [await openNote(noteIds[0]), await openNote(noteIds[1])];
    await hook('failNextNoteDelete');
    const failure = await chooseDelete(noteGroupId, true, 'api');
    assert.equal(failure.result.deletedIds.length, 0); assert(failure.result.failedId);
    assert.deepEqual(new Set(failure.result.remainingIds), new Set(noteIds.slice(0, 2)));
    await assertNotesPresent(noteIds, true); assert(notePages.every(page => !page.isClosed()));
    assert((await snapshot()).items.some(item => item.id === noteGroupId));
    const retry = await chooseDelete(noteGroupId, true, 'api');
    assert.deepEqual(new Set(retry.result.deletedIds), new Set(noteIds.slice(0, 2)));
    await poll(() => hook('groupRuntime'), value => !value.length, '便签组销毁');
    await poll(() => hook('noteRuntime'), value => !value.some(note => noteIds.slice(0, 2).includes(note.noteId)), '成员便签窗口销毁');
    assert(notePages.every(page => page.isClosed()));
    await assertNotesPresent(noteIds.slice(0, 2), false); await assertNotesPresent([noteIds[2]], true);
    return { failure, retry, failedContentPreserved: true, retryDeletedEveryMember: true };
  });

  await check('图片整组删除中途失败立即停止，真实余项回衣架，单项重试可完成', async () => {
    partialGroupId = await createGroup(photoIds.slice(2, 4), '删除失败恢复测试'); await openGroup(partialGroupId);
    const order = (await getGroup()).memberIds;
    await hook('failNextPhotoDelete', 1);
    const failure = await chooseDelete(partialGroupId, true);
    assert.deepEqual(failure.result.deletedIds, [order[0]]); assert.equal(failure.result.failedId, order[1]);
    assert.deepEqual(failure.result.remainingIds, [order[1]]);
    await assertPhotoPresent(order[0], false); await assertPhotoPresent(order[1], true);
    const state = await snapshot(); assert(!state.items.some(item => item.id === partialGroupId));
    assert(state.items.some(item => item.id === order[1] && item.type === 'photo'));
    await poll(() => hook('groupRuntime'), value => !value.length, '剩一项组面板销毁');
    const retry = await hook('deletePhoto', order[1]); assert.equal(retry.deleted, true);
    await assertPhotoPresent(order[1], false); await assertPhotoPresent(photoIds[4], true);
    return { failure, retry, realRemainingItemPreserved: true, noStaleGroup: true };
  });

  await check('组外图片与便签完整保留，重启不复活已删除内容，页面错误为零', async () => {
    const before = await snapshot(); assert.deepEqual(before.counts, { photos: 1, notes: 1, groups: 0 });
    const index = await readJSON('index.json'), outside = index.photos[0];
    assert.equal(outside.id, photoIds[4]); assert.equal(digest(await fs.readFile(path.join(profile, 'photos', outside.fileName))), outsidePhotoDigest);
    assert.deepEqual((await hook('notes')).find(note => note.id === noteIds[2]), outsideNote);
    await rack.bringToFront(); await rack.screenshot({ path: path.join(artifacts, 'outside-content-preserved.png'), omitBackground: true });
    await closeApplication(); await launch();
    const after = await snapshot(); assert.deepEqual(after.items, before.items); assert.deepEqual(after.counts, before.counts);
    for (const id of photoIds.slice(0, 4)) await assertPhotoPresent(id, false);
    await assertNotesPresent(noteIds.slice(0, 2), false); await assertNotesPresent([noteIds[2]], true);
    assert.deepEqual(report.pageErrors, []);
    return { counts: after.counts, outsidePhoto: photoIds[4], outsideNote: noteIds[2], restartVerified: true, pageErrors: report.pageErrors };
  });
}

run().then(async () => {
  report.passed = true; await persistReport(); console.log(`全部通过；报告与截图：${artifacts}`);
}).catch(async error => {
  report.passed = false; report.error = error.stack; report.diagnostics = diagnostics;
  await persistReport(); console.error(error.stack); process.exitCode = 1;
}).finally(async () => { await closeApplication().catch(error => console.error(error.message)); });
