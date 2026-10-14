'use strict';

const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const mode = process.env.RACK_EXE ? 'packaged' : 'development';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const artifacts = path.join(root, 'test-artifacts', 'v0.8.7', `local-image-drop-${mode}`, runId);
const profile = path.join(artifacts, 'profile');
const sources = path.join(artifacts, '本机图片 fixtures');
const report = {
  date: new Date().toISOString(), mode, profile, tests: [], pageErrors: [], dragInputs: [],
  clipboard: 'isolated mock; system clipboard and daily application untouched',
  dragOut: 'isolated native OLE stub; original-byte payload verified',
  fileRetention: 'all fixtures, profiles and reports retained; source images never changed',
  limits: ['CDP dispatch exercises Chromium file drag/drop with actual disk paths; Explorer native OLE targeting is not an automated manual test.',
    'Windows Explorer and WeChat manual dragging across real applications remains a manual check.']
};
let application, rack, cdp;
const originalHashes = new Map();
const watched = new WeakSet();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const observe = page => {
  if (watched.has(page)) return;
  watched.add(page);
  page.on('pageerror', error => report.pageErrors.push(error.message));
};

async function check(name, action) {
  try {
    const detail = await action();
    report.tests.push({ name, passed: true, detail });
    console.log(`通过：${name}`);
  } catch (error) {
    report.tests.push({ name, passed: false, error: error.message });
    throw error;
  }
}

async function launch() {
  const env = { ...process.env, RACK_TEST_MODE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.RACK_EXE || require('electron'),
    args: [...(process.env.RACK_EXE ? [] : [root]), '--rack-test', `--data-dir=${profile}`],
    env, cwd: root, timeout: 60000
  });
  application.on('window', observe);
  rack = await application.firstWindow();
  observe(rack);
  await rack.waitForFunction(() => typeof window.rack?.importLocalImages === 'function');
  cdp = await rack.context().newCDPSession(rack);
  await rack.evaluate(() => {
    window.__localImageDropObserved = [];
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
      document.addEventListener(type, event => window.__localImageDropObserved.push({
        type, trusted: event.isTrusted, files: event.dataTransfer?.files.length || 0,
        types: [...(event.dataTransfer?.types || [])]
      }), true);
    }
  });
}

async function runtime() {
  return application.evaluate(({ app }) => app.__rackTest.runtime());
}

async function waitRuntime(predicate, timeout = 7000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const state = await runtime();
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 35));
  }
  throw new Error(`状态未完成：${JSON.stringify(await runtime())}`);
}

async function snapshot() {
  return rack.evaluate(() => window.rack.getSnapshot());
}

async function waitCount(count) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const current = await snapshot();
    if (current.photos.length === count) return current;
    if (!current.state.importing && current.status?.level === 'error') {
      throw new Error(`图片数量应为 ${count}，实际 ${current.photos.length}：${current.status.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 35));
  }
  throw new Error(`图片数量未达到 ${count}：${JSON.stringify(await snapshot())}`);
}

async function makeFixtures() {
  await fs.mkdir(sources, { recursive: true });
  const definitions = [
    { name: '本机图片 01.PNG', mime: 'image/png', color: '#d9e2d1', title: '本机图片，直接拖进来', subtitle: 'PNG · 保留原图 · 小缩略图', width: 1000, height: 620 },
    { name: '本机图片 02.JPEG', mime: 'image/jpeg', color: '#e8caa2', title: '灵感，随手挂起来', subtitle: 'JPEG · 一次拖入多张', width: 900, height: 700 },
    { name: '本机图片 03.webp', mime: 'image/webp', color: '#bfd5dc', title: '参考图片，随时看', subtitle: 'WebP · 点击看原图', width: 760, height: 960 },
    { name: '本机图片 04.png', mime: 'image/png', color: '#ead5dc', title: '暂停，也能手动添加', subtitle: '原文件始终保留', width: 900, height: 580 },
    { name: '本机图片 05.png', mime: 'image/png', color: '#ece2bc', title: '保存失败，可以重新拖入', subtitle: '挂图成功后才显示', width: 840, height: 540 }
  ];
  for (const definition of definitions) {
    const data = await rack.evaluate(definition => {
      const canvas = document.createElement('canvas');
      canvas.width = definition.width; canvas.height = definition.height;
      const context = canvas.getContext('2d');
      context.fillStyle = definition.color;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = 'rgba(255,253,247,.8)';
      context.fillRect(45, 45, canvas.width - 90, canvas.height - 90);
      context.fillStyle = '#39352e';
      context.font = 'bold 44px Microsoft YaHei, sans-serif';
      context.fillText(definition.title, 76, canvas.height / 2 - 12, canvas.width - 152);
      context.font = '24px Microsoft YaHei, sans-serif';
      context.fillStyle = '#685f51';
      context.fillText(definition.subtitle, 76, canvas.height / 2 + 45, canvas.width - 152);
      const result = canvas.toDataURL(definition.mime, .92);
      canvas.width = canvas.height = 1;
      return result;
    }, definition);
    assert(data.startsWith(`data:${definition.mime};base64,`), `画布必须实际导出 ${definition.mime}`);
    const file = path.join(sources, definition.name);
    const bytes = Buffer.from(data.split(',')[1], 'base64');
    await fs.writeFile(file, bytes, { flag: 'wx' });
    originalHashes.set(file, hash(bytes));
    definition.file = file;
  }
  const text = path.join(sources, '不是图片.txt');
  const invalid = path.join(sources, '损坏的图片.png');
  await fs.writeFile(text, '本机文件拖入验证，不应作为图片保存。', { flag: 'wx' });
  await fs.writeFile(invalid, 'invalid png image', { flag: 'wx' });
  originalHashes.set(text, hash(await fs.readFile(text)));
  originalHashes.set(invalid, hash(await fs.readFile(invalid)));
  return { definitions, text, invalid };
}

async function fileInput(files, page = rack) {
  await page.evaluate(() => {
    let input = document.getElementById('localDropTestFileInput');
    if (!input) {
      input = document.createElement('input');
      input.id = 'localDropTestFileInput'; input.type = 'file'; input.multiple = true; input.hidden = true;
      document.body.append(input);
    }
  });
  await page.locator('#localDropTestFileInput').setInputFiles(files);
}

async function importFiles(files, page = rack) {
  await fileInput(files, page);
  return page.evaluate(() => window.rack.importLocalImages([...document.getElementById('localDropTestFileInput').files]));
}

async function dragEnter(files, point = { x: 35, y: 235 }) {
  const data = { items: [], files, dragOperationsMask: 1 };
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: point.x, y: point.y, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: point.x, y: point.y, data });
  try {
    await rack.locator('#fileDropOverlay').waitFor({ state: 'visible', timeout: 2000 });
    report.dragInputs.push({ method: 'Chromium CDP actual filesystem paths', files, point });
    return { method: 'cdp', data, point };
  } catch (error) {
    await cdp.send('Input.dispatchDragEvent', { type: 'dragCancel', x: point.x, y: point.y, data }).catch(() => {});
    await fileInput(files);
    await rack.evaluate(point => {
      const data = new DataTransfer();
      for (const file of document.getElementById('localDropTestFileInput').files) data.items.add(file);
      window.__localDropData = data;
      const target = document.elementFromPoint(point.x, point.y) || document.body;
      for (const type of ['dragenter', 'dragover']) target.dispatchEvent(new DragEvent(type, {
        dataTransfer: data, clientX: point.x, clientY: point.y, bubbles: true, cancelable: true
      }));
    }, point);
    await rack.locator('#fileDropOverlay').waitFor({ state: 'visible' });
    report.dragInputs.push({ method: 'OS-backed File from file input + DOM DataTransfer fallback', files, point, reason: error.message });
    return { method: 'input', point };
  }
}

async function drop(drag) {
  if (drag.method === 'cdp') {
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: drag.point.x, y: drag.point.y, data: drag.data });
  } else {
    await rack.evaluate(point => {
      (document.elementFromPoint(point.x, point.y) || document.body).dispatchEvent(new DragEvent('drop', {
        dataTransfer: window.__localDropData, clientX: point.x, clientY: point.y, bubbles: true, cancelable: true
      }));
      window.__localDropData = null;
    }, drag.point);
  }
  await rack.locator('#fileDropOverlay').waitFor({ state: 'hidden' });
  await waitRuntime(state => !state.fileDropActive && !state.importing);
}

async function cancel(drag) {
  if (drag.method === 'cdp') await cdp.send('Input.dispatchDragEvent', { type: 'dragCancel', x: drag.point.x, y: drag.point.y, data: drag.data });
  // Chromium dragCancel does not promise a DOM dragleave; explicitly exercise the renderer leave cleanup as well.
  await rack.evaluate(() => {
    document.documentElement.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: null }));
    window.__localDropData = null;
  });
  await rack.locator('#fileDropOverlay').waitFor({ state: 'hidden' });
  await waitRuntime(state => !state.fileDropActive && !state.importing);
}

async function run() {
  await fs.mkdir(artifacts, { recursive: true });
  await launch();
  const fixtures = await makeFixtures();
  await check('启动仅有衣架，使用隔离数据目录且没有读取源图挂图', async () => {
    const state = await runtime();
    assert.equal(state.dataDir, profile);
    assert.equal((await snapshot()).photos.length, 0);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    assert.equal(await rack.locator('#fileDropOverlay').isVisible(), false);
    assert((await rack.locator('#emptyState').textContent()).includes('本机图片'));
    const empty = await rack.locator('#emptyState').boundingBox();
    await rack.mouse.move(empty.x + empty.width / 2, empty.y + empty.height / 2);
    await waitRuntime(state => !state.ignoringMouseEvents);
    assert.equal(await rack.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-interactive]'),
      { x: empty.x + empty.width / 2, y: empty.y + empty.height / 2 }), true);
    return { profile, windows: 1, sourceFiles: fixtures.definitions.length };
  });
  await check('可见绳线可接收首次拖入，附近透明空白保持点击穿透', async () => {
    const points = await rack.locator('.rope-base').evaluate(rope => {
      const local = rope.getPointAtLength(rope.getTotalLength() * .2);
      const point = new DOMPoint(local.x, local.y).matrixTransform(rope.getScreenCTM());
      const blank = { x: point.x, y: point.y - 10 };
      const hit = (x, y) => {
        const element = document.elementFromPoint(x, y);
        return { interactive: !!element?.closest('[data-interactive]'), tag: element?.tagName, className: element?.getAttribute('class') };
      };
      return { rope: { x: point.x, y: point.y }, blank, ropeHit: hit(point.x, point.y), blankHit: hit(blank.x, blank.y) };
    });
    assert.equal(points.ropeHit.interactive, true);
    assert.equal(points.blankHit.interactive, false);
    await rack.mouse.move(points.rope.x, points.rope.y);
    await waitRuntime(state => !state.ignoringMouseEvents);
    const drag = await dragEnter([fixtures.definitions[0].file], points.rope);
    await waitRuntime(state => state.fileDropActive && !state.ignoringMouseEvents);
    await cancel(drag);
    await rack.mouse.move(points.blank.x, points.blank.y);
    await waitRuntime(state => state.ignoringMouseEvents);
    assert.equal((await snapshot()).photos.length, 0);
    return { points, dragMethod: drag.method, canceledWithoutImport: true };
  });
  await check('暂停时从透明空白拖入 PNG／JPEG／WebP，多图保存原始字节并只显示小缩略图', async () => {
    await rack.evaluate(() => window.rack.setPaused(true));
    await rack.evaluate(() => window.rack.setInteractive(false));
    await waitRuntime(state => state.ignoringMouseEvents);
    const drag = await dragEnter(fixtures.definitions.slice(0, 3).map(value => value.file));
    const entered = await waitRuntime(state => state.fileDropActive && !state.ignoringMouseEvents);
    await rack.screenshot({ path: path.join(artifacts, 'local-image-drop-overlay.png'), omitBackground: true });
    await drop(drag);
    await waitCount(3);
    const current = await snapshot();
    assert.equal(current.state.paused, true);
    const encodings = [];
    for (const definition of fixtures.definitions.slice(0, 3)) {
      const photo = current.photos.find(photo => photo.width === definition.width && photo.height === definition.height);
      assert(photo, `未找到 ${definition.name}：${JSON.stringify(current)}`);
      const saved = path.join(profile, 'photos', `${photo.id}.${photo.format}`);
      assert.equal(hash(await fs.readFile(saved)), originalHashes.get(definition.file));
      const thumbnail = path.join(profile, 'thumbnails', `${photo.id}.png`);
      const size = await application.evaluate(({ nativeImage }, file) => nativeImage.createFromPath(file).getSize(), thumbnail);
      assert(size.width <= 288 && size.height <= 176 && size.width > 0 && size.height > 0);
      const imageUrl = await rack.locator(`[data-photo-id="${photo.id}"] img`).getAttribute('src');
      assert.equal(imageUrl, photo.thumbnailUrl);
      encodings.push({ name: definition.name, format: photo.format, width: photo.width, height: photo.height, thumbnail: size, unchangedBytes: true });
    }
    await rack.screenshot({ path: path.join(artifacts, 'local-images-three.png'), omitBackground: true });
    return { dragMethod: drag.method, initialTransparentDropPoint: drag.point, entered: { fileDropActive: entered.fileDropActive, ignoringMouseEvents: entered.ignoringMouseEvents }, encodings };
  });
  await check('重复拖入不重复挂图，同批重复也共用原图与缩略图', async () => {
    const result = await importFiles([fixtures.definitions[0].file, fixtures.definitions[0].file, fixtures.definitions[1].file]);
    assert.equal(result.added, 0); assert.equal(result.duplicates, 3); assert.equal(result.failed, 0);
    assert.equal((await snapshot()).photos.length, 3);
    assert.equal((await fs.readdir(path.join(profile, 'photos'))).length, 3);
    assert.equal((await fs.readdir(path.join(profile, 'thumbnails'))).length, 3);
    return result;
  });
  await check('混合拖入继续保存有效图片，无效文本与损坏图片显示原因且不挂图', async () => {
    const drag = await dragEnter([fixtures.text, fixtures.definitions[3].file, fixtures.invalid], { x: 170, y: 125 });
    await drop(drag); await waitCount(4);
    const result = await importFiles([fixtures.text, fixtures.invalid]);
    assert.equal(result.added, 0); assert.equal(result.failed, 2); assert.equal(result.errors.length, 2);
    assert(result.errors.every(error => typeof error.name === 'string' && typeof error.message === 'string'));
    assert.equal((await snapshot()).photos.length, 4);
    assert((await rack.locator('#errorMessage').textContent()).length > 0);
    return result;
  });
  await check('保存失败不产生照片卡，保留原文件，再次拖入能够成功', async () => {
    await application.evaluate(({ app }) => app.__rackTest.failNextLocalImageSave());
    const failed = await importFiles([fixtures.definitions[4].file]);
    assert.equal(failed.added, 0); assert.equal(failed.failed, 1);
    assert.equal((await snapshot()).photos.length, 4);
    assert.equal(hash(await fs.readFile(fixtures.definitions[4].file)), originalHashes.get(fixtures.definitions[4].file));
    const retry = await importFiles([fixtures.definitions[4].file]);
    assert.equal(retry.added, 1); assert.equal(retry.failed, 0);
    await waitCount(5);
    return { failed, retry };
  });
  await check('内存构造的网页 File 没有真实路径，不允许伪造本机文件', async () => {
    const result = await rack.evaluate(async () => {
      try { await window.rack.importLocalImages([new File(['fake'], 'fake.png', { type: 'image/png' })]); return { rejected: false }; }
      catch (error) { return { rejected: true, message: error.message }; }
    });
    assert.equal(result.rejected, true); assert(result.message.includes('本机文件夹'));
    assert.equal((await snapshot()).photos.length, 5);
    return result;
  });
  await check('导入的 JPEG／WebP 原图预览和拖出仍使用原格式原始字节', async () => {
    const results = [];
    for (const definition of fixtures.definitions.slice(1, 3)) {
      const photo = (await snapshot()).photos.find(photo => photo.width === definition.width && photo.height === definition.height);
      const opened = application.waitForEvent('window');
      await rack.evaluate(id => window.rack.openPreview(id), photo.id);
      const preview = await opened; observe(preview);
      await preview.waitForFunction(() => document.getElementById('previewImage')?.naturalWidth > 0);
      const dimensions = await preview.locator('#previewImage').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight, src: image.src }));
      assert.equal(dimensions.width, definition.width); assert.equal(dimensions.height, definition.height); assert.equal(dimensions.src, photo.url);
      const closed = preview.waitForEvent('close');
      await preview.evaluate(() => window.rack.closePreview()).catch(error => { if (!preview.isClosed()) throw error; });
      await closed;
      await rack.evaluate(id => window.rack.preparePhotoDrag(id), photo.id);
      await rack.evaluate(id => window.rack.dragPhoto(id), photo.id);
      const state = await waitRuntime(state => state.lastNativeDrag?.id === photo.id && !state.nativeDragging);
      assert.equal(state.lastNativeDrag.nativeCalled, false);
      assert.equal(path.extname(state.lastNativeDrag.file), `.${photo.format}`);
      assert.equal(hash(await fs.readFile(state.lastNativeDrag.file)), originalHashes.get(definition.file));
      results.push({ original: definition.name, preview: dimensions, export: state.lastNativeDrag.file, originalBytes: true });
    }
    return { results, realChatSend: 'not performed' };
  });
  await check('拖入悬停临时暂停自动隐藏，取消或拖入完成后恢复收起及顶部展开', async () => {
    await rack.evaluate(() => window.rack.setAutoHide(false));
    const state = await runtime();
    const inside = { x: state.expandedBounds.x + 50, y: state.expandedBounds.y + 100 };
    const outside = { x: inside.x, y: state.expandedBounds.y + state.expandedBounds.height + 100 };
    await application.evaluate(({ app }, point) => app.__rackTest.setAutoHideCursor(point), inside);
    await rack.evaluate(() => window.rack.setAutoHideSpeed('medium'));
    await rack.evaluate(() => window.rack.setAutoHide(true));
    const entered = await dragEnter([fixtures.definitions[0].file]);
    await waitRuntime(state => state.fileDropActive);
    const suspended = await application.evaluate(({ app }, point) => app.__rackTest.autoHideTick(point, 1500), outside);
    assert.equal(suspended.suspended, true); assert.equal(suspended.collapsed, false);
    await cancel(entered);
    const recovered = await application.evaluate(({ app }, { outside, inside }) => {
      const before = app.__rackTest.autoHideTick(outside);
      const due = app.__rackTest.autoHideTick(outside, 1001);
      const current = app.__rackTest.runtime();
      const top = { x: inside.x, y: current.displayBounds.y + 2 };
      const revealed = app.__rackTest.autoHideTick(top);
      app.__rackTest.autoHideTick(inside);
      return { before, due, revealed };
    }, { outside, inside });
    assert.equal(recovered.before.suspended, false); assert.equal(recovered.due.collapsed, true); assert.equal(recovered.revealed.collapsed, false);
    const completed = await dragEnter([fixtures.definitions[0].file]);
    await drop(completed);
    assert.equal((await runtime()).autoHide.suspended, false);
    await rack.evaluate(() => window.rack.setAutoHide(false));
    await rack.evaluate(() => window.rack.setInteractive(false));
    await waitRuntime(state => state.ignoringMouseEvents && !state.fileDropActive && !state.importing);
    return { source: 'Chromium drag input + isolated controller clock/cursor', suspended, recovered, transparentAfterDrop: true };
  });
  await check('导入悬停超时和窗口失焦都清理临时状态，不挡住桌面', async () => {
    const drag = await dragEnter([fixtures.definitions[0].file]);
    await waitRuntime(state => state.fileDropActive);
    await rack.locator('#fileDropOverlay').waitFor({ state: 'hidden', timeout: 4500 });
    await waitRuntime(state => !state.fileDropActive && !state.importing);
    await cancel(drag);
    const another = await dragEnter([fixtures.definitions[0].file]);
    await rack.evaluate(() => window.dispatchEvent(new Event('blur')));
    await rack.locator('#fileDropOverlay').waitFor({ state: 'hidden' });
    await waitRuntime(state => !state.fileDropActive && !state.importing);
    await cancel(another);
    return { hoverTimeoutReleased: true, blurReleased: true };
  });
  await check('所有源文件哈希未改变，没有原图常驻衣架页面，也没有页面报错', async () => {
    for (const [file, before] of originalHashes) assert.equal(hash(await fs.readFile(file)), before, `源文件被改动：${file}`);
    const urls = await rack.locator('.photo-card img').evaluateAll(images => images.map(image => image.src));
    assert(urls.length > 0 && urls.every(url => url.startsWith('rack-image://thumbnail/')));
    assert.deepEqual(report.pageErrors, []);
    await rack.locator('#pauseButton').hover();
    await rack.screenshot({ path: path.join(artifacts, 'local-images-on-clothesline.png'), omitBackground: true });
    return { sourceHashesChecked: originalHashes.size, onlyThumbnailUrls: urls, pageErrors: 0 };
  });
  const before = (await snapshot()).photos.map(photo => photo.id).sort();
  await application.close(); application = null;
  await check('关闭并重启后保留本机图片及暂停状态，不再导入相同图片', async () => {
    await launch();
    const current = await snapshot();
    assert.deepEqual(current.photos.map(photo => photo.id).sort(), before);
    assert.equal(current.state.paused, true);
    const repeated = await importFiles([fixtures.definitions[0].file]);
    assert.equal(repeated.duplicates, 1); assert.equal(repeated.added, 0);
    assert.equal((await runtime()).fileDropActive, false);
    assert.equal((await runtime()).importing, false);
    return { persistedPhotos: current.photos.length, paused: current.state.paused, repeated };
  });
}

run().then(() => { report.passed = true; }).catch(error => {
  report.passed = false; report.error = error.stack; process.exitCode = 1; console.error(error);
}).finally(async () => {
  if (application) await application.close().catch(() => {});
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`本机图片拖入验证记录：${path.join(artifacts, 'verification.json')}`);
});
