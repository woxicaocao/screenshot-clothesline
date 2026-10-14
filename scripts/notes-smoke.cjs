'use strict';

const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const mode = process.env.RACK_EXE ? 'packaged' : 'development';
const artifacts = path.join(root, 'test-artifacts', 'v0.8.6', `notes-${mode}`);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const profile = path.join(artifacts, 'profiles', runId);
const verification = { date: new Date().toISOString(), mode, profile, tests: [],
  clipboard: 'isolated PNG fixture; real clipboard unchanged',
  manualChecks: ['跨应用实际置顶遮挡行为', '用户 Windows DPI 设置下的原生拖动手感'] };
const pageErrors = [], diagnostics = [], observedPages = new WeakSet();
let application, completed = false;

const pause = () => new Promise(resolve => setTimeout(resolve, 40));

async function imageWindowLayout(page, settleAttempt = 0) {
  await page.waitForFunction(async () => {
    const image = document.getElementById('previewImage'), world = document.getElementById('imageWorld');
    const state = (await window.rack.getPreview())?.state;
    if (!state || Math.abs(innerWidth - state.bounds.width) > 8 || Math.abs(innerHeight - state.bounds.height) > 8) return false;
    const rect = world?.getBoundingClientRect();
    const sx = innerWidth / state.bounds.width, sy = innerHeight / state.bounds.height, area = state.visibleArea;
    const left = Math.max(0, Math.min(innerWidth, area.x * sx)), top = Math.max(0, Math.min(innerHeight, area.y * sy));
    const right = Math.max(left, Math.min(innerWidth, (area.x + area.width) * sx));
    const bottom = Math.max(top, Math.min(innerHeight, (area.y + area.height) * sy));
    const expectedOffsets = { '--visible-left': left + 1, '--visible-top': top + 1,
      '--visible-right': Math.max(1, innerWidth - right + 1), '--visible-bottom': Math.max(1, innerHeight - bottom + 1) };
    // 大框收回时，工具的可见区域通知与客户区 resize 可能不在同一帧到达。
    const controlsSettled = Object.entries(expectedOffsets).every(([key, value]) =>
      Math.abs(parseFloat(document.body.style.getPropertyValue(key)) - value) < .1);
    return image?.naturalWidth > 0 && world && !world.hidden && world.getBoundingClientRect().width > 0
      && document.getElementById('loadingMessage').hidden && controlsSettled
      && Math.abs(rect.width - state.image.width * innerWidth / state.bounds.width) < 1
      && Math.abs(rect.height - state.image.height * innerHeight / state.bounds.height) < 1;
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const layout = await page.evaluate(async () => {
    const freshState = (await window.rack.getPreview()).state;
    const stage = document.getElementById('imageStage'), world = document.getElementById('imageWorld');
    const image = document.getElementById('previewImage');
    const bounds = element => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
    };
    const overlay = selector => {
      const element = document.querySelector(selector), style = getComputedStyle(element);
      return { ...bounds(element), position: style.position, opacity: Number(style.opacity),
        dragRegion: style.getPropertyValue('-webkit-app-region') };
    };
    const frames = [null, '::before', '::after'].map(pseudo => {
      const style = getComputedStyle(document.body, pseudo);
      return { pseudo, content: style.content, widths: ['Top', 'Right', 'Bottom', 'Left'].map(side => style[`border${side}Width`]),
        styles: ['Top', 'Right', 'Bottom', 'Left'].map(side => style[`border${side}Style`]),
        colors: ['Top', 'Right', 'Bottom', 'Left'].map(side => style[`border${side}Color`]) };
    });
    const viewport = document.documentElement.getBoundingClientRect();
    return { viewport: { width: viewport.width, height: viewport.height, innerWidth, innerHeight, scale: devicePixelRatio }, stage: { ...bounds(stage), clientWidth: stage.clientWidth,
      clientHeight: stage.clientHeight }, world: bounds(world), natural: { width: image.naturalWidth, height: image.naturalHeight },
      header: overlay('.preview-titlebar'), footer: overlay('.preview-footer'), frames, state: freshState,
      visibleOffsets: Object.fromEntries(['left', 'top', 'right', 'bottom'].map(side =>
        [side, parseFloat(document.body.style.getPropertyValue(`--visible-${side}`))])) };
  });
  const { viewport, stage, header, footer } = layout;
  const fresh = layout.state, sx = viewport.innerWidth / fresh.bounds.width, sy = viewport.innerHeight / fresh.bounds.height;
  const left = Math.max(0, Math.min(viewport.innerWidth, fresh.visibleArea.x * sx));
  const top = Math.max(0, Math.min(viewport.innerHeight, fresh.visibleArea.y * sy));
  const right = Math.max(left, Math.min(viewport.innerWidth, (fresh.visibleArea.x + fresh.visibleArea.width) * sx));
  const bottom = Math.max(top, Math.min(viewport.innerHeight, (fresh.visibleArea.y + fresh.visibleArea.height) * sy));
  const offsets = { left: left + 1, top: top + 1, right: Math.max(1, viewport.innerWidth - right + 1),
    bottom: Math.max(1, viewport.innerHeight - bottom + 1) };
  const settled = Math.abs(viewport.innerWidth - fresh.bounds.width) <= 8 && Math.abs(viewport.innerHeight - fresh.bounds.height) <= 8
    && Math.abs(layout.world.width - fresh.image.width * sx) < 1 && Math.abs(layout.world.height - fresh.image.height * sy) < 1
    && Math.abs(layout.world.x - fresh.image.x * sx) < 1 && Math.abs(layout.world.y - fresh.image.y * sy) < 1
    && Object.entries(offsets).every(([side, value]) => Math.abs(layout.visibleOffsets[side] - value) < .1);
  // 等待条件通过后，原生 resize 仍可能在截图读取前改变视口；对最终同帧快照再校验。
  if (!settled && settleAttempt < 20) {
    await new Promise(resolve => setTimeout(resolve, 40));
    return imageWindowLayout(page, settleAttempt + 1);
  }
  assert(settled, `原生窗口、图片和工具布局必须完成同步：${JSON.stringify(layout)}`);
  for (const gap of [stage.x, stage.y, viewport.width - stage.right, viewport.height - stage.bottom]) {
    assert(Math.abs(gap - 1) < .1, `图片舞台四边必须只留 1 px：${JSON.stringify(layout)}`);
  }
  assert(layout.frames.some(frame => (!frame.pseudo || !['none', 'normal'].includes(frame.content))
    && frame.widths.every(width => Math.abs(parseFloat(width) - Math.max(1, Math.floor(viewport.scale)) / viewport.scale) < .01) && frame.styles.every(style => style !== 'none')
    && frame.colors.every(color => !['transparent', 'rgba(0, 0, 0, 0)'].includes(color))), '窗口必须实际绘制四边 1 px CSS 外框');
  for (const overlay of [header, footer]) {
    assert(['absolute', 'fixed'].includes(overlay.position), '标题和缩放操作须覆盖图片，不占布局空间');
    if (overlay.height) assert(overlay.y >= stage.y - .1 && overlay.bottom <= stage.bottom + .1,
      `操作浮层须位于图片舞台内：${JSON.stringify(layout)}`);
  }
  assert.equal(header.dragRegion, 'no-drag', '整图拖动由受限 IPC 处理，标题区域不能另触发系统拖动');
  for (const selector of ['#previewPinButton', '#closeButton']) {
    const control = await page.locator(selector).evaluate(element => {
      const rect = element.getBoundingClientRect();
      let opacity = 1;
      for (let parent = element; parent; parent = parent.parentElement) opacity *= Number(getComputedStyle(parent).opacity);
      return { width: rect.width, height: rect.height, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, opacity,
        display: getComputedStyle(element).display, visibility: getComputedStyle(element).visibility };
    });
    assert(control.width > 0 && control.height > 0 && control.opacity > .99 && control.display !== 'none' && control.visibility !== 'hidden',
      `置顶和关闭必须常驻可见：${selector}/${JSON.stringify(control)}`);
    assert(control.x >= 0 && control.y >= 0 && control.right <= viewport.width + .1 && control.bottom <= viewport.height + .1);
  }
  return layout;
}

async function assertImageFit(page) {
  await page.keyboard.press('0');
  await page.waitForFunction(async () => {
    const stage = document.getElementById('imageStage'), image = document.getElementById('previewImage');
    const rect = document.getElementById('imageWorld').getBoundingClientRect();
    const state = (await window.rack.getPreview()).state;
    const scale = Math.min(stage.clientWidth / image.naturalWidth, stage.clientHeight / image.naturalHeight, 1);
    return state?.mode === 'fit' && !document.getElementById('imageWorld').hidden
      && Math.abs(rect.width - image.naturalWidth * scale) < 2 && Math.abs(rect.height - image.naturalHeight * scale) < 2;
  });
  const layout = await imageWindowLayout(page);
  const state = (await page.evaluate(() => window.rack.getPreview())).state;
  const expected = Math.min(layout.stage.clientWidth / layout.natural.width, layout.stage.clientHeight / layout.natural.height, 1);
  const actual = layout.world.width / layout.natural.width;
  assert(Math.abs(actual - expected) < .01, '适应屏幕后窗口应贴合整张图，不预扣标题或底栏空间');
  assert(actual <= 1.001, '拟合不能把小图放大到原图尺寸以上');
  assert.equal(state.mode, 'fit');
  return { scale: actual, expectedScale: expected, stage: layout.stage, state };
}

async function imageControls(page, visible, { blur = true } = {}) {
  await page.bringToFront();
  if (!visible && blur) await page.evaluate(() => document.activeElement?.blur());
  if (visible) {
    const box = await page.locator('#imageStage').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  } else await page.mouse.move(-10, -10);
  let mode = 'native-mouse';
  const predicate = expected => ['.preview-brand', '.preview-footer'].every(selector => {
    const style = getComputedStyle(document.querySelector(selector));
    if (style.display === 'none') return true;
    const opacity = Number(style.opacity);
    return expected ? opacity > .99 : opacity < .01;
  });
  try { await page.waitForFunction(predicate, visible, { timeout: 2000 }); }
  catch (error) {
    mode = 'body-event-fallback';
    await page.evaluate(entered => {
      document.body.dispatchEvent(new PointerEvent(entered ? 'pointerenter' : 'pointerleave'));
      document.body.dispatchEvent(new MouseEvent(entered ? 'mouseenter' : 'mouseleave'));
    }, visible);
    await page.waitForFunction(predicate, visible, { timeout: 2000 });
  }
  for (const selector of ['#previewPinButton', '#closeButton']) assert.equal(await page.locator(selector).isVisible(), true);
  return mode;
}

async function check(name, operation) {
  const started = Date.now();
  try {
    const detail = await operation();
    verification.tests.push({ name, passed: true, durationMs: Date.now() - started, ...(detail ? { detail } : {}) });
    console.log(`通过：${name}`);
  } catch (error) {
    verification.tests.push({ name, passed: false, error: error.message });
    throw error;
  }
}

function observe(page) {
  if (observedPages.has(page)) return;
  observedPages.add(page);
  page.on('pageerror', error => pageErrors.push({ url: page.url(), error: error.message }));
}

async function launch() {
  const env = { ...process.env, RACK_TEST_MODE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const instance = await electron.launch({ executablePath: process.env.RACK_EXE || require('electron'),
    args: [...(process.env.RACK_EXE ? [] : [root]), '--rack-test', `--data-dir=${profile}`],
    env, cwd: root, timeout: 60000 });
  application = instance;
  instance.on('window', observe);
  instance.process().stderr?.on('data', chunk => { diagnostics.push(chunk.toString()); if (diagnostics.length > 40) diagnostics.shift(); });
  const rack = await instance.firstWindow();
  observe(rack);
  await rack.waitForFunction(() => !!window.rack);
  await instance.evaluate(({ app }) => { if (!app.__rackTest?.noteRuntime) throw new Error('便签测试辅助接口不可用'); });
  return { instance, rack };
}

async function waitState(instance, getter, predicate, label = '状态', timeout = 8000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await instance.evaluate(({ app }, name) => app.__rackTest[name](), getter);
    if (predicate(value)) return value;
    await pause();
  }
  throw new Error(`等待${label}超时：${JSON.stringify(value)}`);
}

const notes = instance => instance.evaluate(({ app }) => app.__rackTest.notes());

async function addNote(instance, rack, id = null) {
  const opened = instance.waitForEvent('window');
  await rack.evaluate(noteId => noteId ? window.rack.openNote(noteId) : window.rack.addNote(), id);
  const page = await opened;
  observe(page);
  await page.waitForFunction(() => document.getElementById('noteInput') && !document.getElementById('noteInput').disabled);
  return page;
}

async function openPreview(instance, rack, id) {
  const opened = instance.waitForEvent('window');
  await rack.evaluate(photoId => window.rack.openPreview(photoId), id);
  const page = await opened;
  observe(page);
  await imageWindowLayout(page);
  return page;
}

async function closeNote(page) {
  const closed = page.waitForEvent('close');
  await page.locator('#noteCloseButton').click().catch(error => { if (!page.isClosed()) throw error; });
  await closed;
}

async function closePreview(page) {
  const closed = page.waitForEvent('close');
  await page.evaluate(() => window.rack.closePreview()).catch(error => { if (!page.isClosed()) throw error; });
  await closed;
}

async function customColor(page, color) {
  await page.locator('#noteCustomColor').evaluate((input, value) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, color);
  await page.waitForFunction(value => document.getElementById('noteCustomColor').value === value
    && getComputedStyle(document.documentElement).getPropertyValue('--note-color').trim() === value, color);
}

async function deleteFromRack(instance, rack, id) {
  await rack.locator('#photoScroll').evaluate(scroll => { scroll.scrollLeft = 0; });
  const card = rack.locator(`[data-note-id="${id}"]`);
  await card.waitFor({ state: 'visible' });
  // 真实卡片触发 contextmenu；测试模式保留原生菜单内容，由辅助接口选择菜单项。
  const geometry = await card.evaluate(element => {
    const rect = element.getBoundingClientRect(), viewport = element.closest('#photoScroll').getBoundingClientRect();
    const left = Math.max(rect.left, viewport.left), right = Math.min(rect.right, viewport.right);
    const top = Math.max(rect.top, viewport.top), bottom = Math.min(rect.bottom, viewport.bottom);
    return { intersectsViewport: right > left && bottom > top, x: (left + right) / 2, y: (top + bottom) / 2 };
  });
  assert.equal(geometry.intersectsViewport, true, '删除候选必须位于衣架可见区域，不能命中虚拟列表的预加载卡片');
  await card.evaluate((element, point) => element.dispatchEvent(new MouseEvent('contextmenu',
    { bubbles: true, cancelable: true, button: 2, clientX: point.x, clientY: point.y })), geometry);
  const menu = await waitState(instance, 'noteMenu', value => value?.id === id, '便签右键菜单');
  assert.deepEqual(menu.labels, ['删除']);
  await instance.evaluate(async ({ app }) => { await app.__rackTest.chooseNoteMenu('删除'); });
}

async function quit(instance) {
  const closed = instance.waitForEvent('close', { timeout: 20000 });
  await instance.evaluate(({ app }) => { app.quit(); }).catch(error => {
    if (!instance.process().exitCode && !String(error.message).includes('closed')) throw error;
  });
  await closed;
  application = null;
}

async function run() {
  await fs.mkdir(artifacts, { recursive: true });
  let { instance, rack } = await launch();
  let photos, previewA, previewB, noteA, noteB, savedA, savedB;
  const deletedNotes = [];
  let expectedPhotoCount = 3;
  const fullText = ['本周灵感与待办', '把截图和文字一起晾起来。', '衣架上的摘要固定为 14 px。',
    '打开后使用 20 px 阅读和编辑。', '颜色可以自定义，置顶只影响这张便签。',
    '完成封面配色方案', '整理项目参考图片', '给桌面留出一点空白', '这一行在衣架摘要里看不到',
    '<img src=x onerror=alert(1)> 作为普通文字保留',
    ...Array.from({ length: 24 }, (_, index) => `灵感 ${index + 1}：整理今天的观察和想法，完整文字保存在本地，衣架只传输有限摘要。`),
    '超过摘要上限的最后一行，也完整保存在本地。'].join('\n');
  assert(fullText.length > 700, '长便签必须覆盖公开摘要的 700 字符上限');

  await check('两张图片可同时打开、同图复用并各自返回所属原图', async () => {
    const fixtures = await rack.evaluate(() => [0, 1, 2].map(index => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 420;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = ['#e8dec5', '#d2e0cf', '#ead3c7'][index]; ctx.fillRect(0, 0, 640, 420);
      ctx.fillStyle = ['#688373', '#819983', '#bc8874'][index];
      ctx.beginPath(); ctx.arc(475, 120, 64, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = ['#455d52', '#4f715c', '#80644d'][index];
      ctx.font = '36px Microsoft YaHei'; ctx.fillText(['留住灵感', '慢一点也很好', '今天的小发现'][index], 44, 255);
      ctx.font = '18px Segoe UI'; ctx.fillText(`LOCAL INSPIRATION / ${index + 1}`, 45, 305);
      return canvas.toDataURL('image/png');
    }));
    for (const fixture of fixtures) await instance.evaluate(async ({ app }, value) => {
      app.__rackTest.setClipboardImage(value); await app.__rackTest.poll();
    }, fixture);
    await rack.evaluate(() => window.rack.setPaused(true));
    photos = (await rack.evaluate(() => window.rack.getSnapshot())).photos;
    assert.equal(photos.length, 3);
    previewA = await openPreview(instance, rack, photos[0].id);
    previewB = await openPreview(instance, rack, photos[1].id);
    const previewLayout = await imageWindowLayout(previewA);
    assert(Math.abs(previewLayout.stage.width / previewLayout.stage.height - photos[0].width / photos[0].height) < .015);
    const fitted = await assertImageFit(previewA);
    const hideMethod = await imageControls(previewA, false);
    await previewA.screenshot({ path: path.join(artifacts, 'photo-preview-clean.png') });
    await imageControls(previewA, true);
    await previewA.screenshot({ path: path.join(artifacts, 'photo-preview-hover.png') });
    await rack.evaluate(id => window.rack.openPreview(id), photos[0].id);
    const runtime = await waitState(instance, 'runtime', value => value.imagePreviews.length === 2, '两个图片预览');
    assert.equal((await previewA.evaluate(() => window.rack.getPreview())).id, photos[0].id);
    assert.equal((await previewB.evaluate(() => window.rack.getPreview())).id, photos[1].id);
    assert(runtime.imagePreviews.every(value => value.visible));
    return { previewCount: runtime.imagePreviews.length, originalWidth: 640, fitted, thinBorder: '1px',
      overlayHeights: [previewLayout.header.height, previewLayout.footer.height], hideMethod };
  });

  await check('两张新便签和两张图片同时打开，编辑期间不发布持久记录', async () => {
    noteA = await addNote(instance, rack);
    noteB = await addNote(instance, rack);
    await noteA.locator('#noteInput').fill('中🙂A');
    assert.equal(await noteA.locator('#noteCharacterCount').textContent(), '3 字');
    await noteA.locator('#noteInput').fill(fullText);
    await noteB.locator('#noteInput').fill('午后的小计划\n整理素材\n泡一杯茶\n让思路慢慢清晰');
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.noteRuntime())).length, 2);
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.runtime())).imagePreviews.length, 2);
    assert.deepEqual(await notes(instance), []);
    assert.equal((await rack.evaluate(() => window.rack.getSnapshot())).items.filter(item => item.type === 'note').length, 0);
    assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 5);
  });
  await check('两张图片缩放和置顶独立，变更只作用于所属窗口且来源校验严格', async () => {
    const nativeA = await instance.browserWindow(previewA), nativeB = await instance.browserWindow(previewB);
    const originalB = await previewB.evaluate(() => window.rack.getPreview());
    const otherBounds = await nativeB.evaluate(window => window.getBounds());
    const pinned = await previewA.evaluate(() => window.rack.setPreviewAlwaysOnTop(true));
    assert.equal(pinned.id, photos[0].id); assert.equal(pinned.alwaysOnTop, true);
    await previewA.waitForFunction(() => document.getElementById('previewPinButton').getAttribute('aria-pressed') === 'true');
    assert.equal(await nativeA.evaluate(window => window.isAlwaysOnTop()), true);
    assert.equal(await nativeB.evaluate(window => window.isAlwaysOnTop()), false);
    assert.equal(await instance.evaluate(({ app }) => app.__rackTest.runtime().alwaysOnTop), false);
    const resized = await previewA.evaluate(() => window.rack.resizePreview({ scale: .6 }));
    assert.equal(resized.id, photos[0].id);
    assert(Math.abs(resized.image.width - photos[0].width * resized.scale) <= 1);
    assert.deepEqual(await nativeB.evaluate(window => window.getBounds()), otherBounds);
    const afterB = await previewB.evaluate(() => window.rack.getPreview());
    assert.equal(afterB.id, originalB.id); assert.equal(afterB.state.scale, originalB.state.scale);
    assert.equal(afterB.state.alwaysOnTop, originalB.state.alwaysOnTop);
    const foreignPayload = await previewA.evaluate(id => window.rack.resizePreview({ scale: .75, id })
      .then(state => ({ allowed: true, id: state.id }), error => ({ allowed: false, message: error.message })), photos[1].id);
    if (foreignPayload.allowed) assert.equal(foreignPayload.id, photos[0].id, 'payload.id 不得把缩放目标改成另一个图片窗口');
    assert.deepEqual(await nativeB.evaluate(window => window.getBounds()), otherBounds);
    assert.equal(await rack.evaluate(() => window.rack.resizePreview({ scale: 1 }).then(() => false, () => true)), true);
    assert.equal(await rack.evaluate(() => window.rack.setPreviewAlwaysOnTop(true).then(() => false, () => true)), true);
    assert.equal(await noteA.evaluate(() => window.rack.resizePreview({ scale: 1 }).then(() => false, () => true)), true);
    assert.equal(await noteB.evaluate(() => window.rack.setPreviewAlwaysOnTop(true).then(() => false, () => true)), true);
    assert.equal(await previewA.evaluate(() => window.rack.setPreviewAlwaysOnTop('true').then(() => false, () => true)), true);
    assert.equal(await previewA.evaluate(() => window.rack.resizePreview({ scale: -1 }).then(() => false, () => true)), true);
    const frameBefore = (await previewA.evaluate(() => window.rack.getPreview())).state;
    const frameStart = { x: frameBefore.bounds.x + frameBefore.bounds.width - 1,
      y: frameBefore.bounds.y + frameBefore.bounds.height / 2 };
    try {
      await instance.evaluate(({ app }, point) => app.__rackTest.setPreviewCursor(point), frameStart);
      await rack.evaluate(() => window.rack.beginPreviewResize('se'));
      await noteA.evaluate(() => window.rack.beginPreviewResize('e'));
      await previewA.evaluate(() => window.rack.beginPreviewResize('invalid-edge'));
      await pause();
      assert.equal((await previewA.evaluate(() => window.rack.getPreview())).state.resizing, false);
      assert.equal((await previewB.evaluate(() => window.rack.getPreview())).state.resizing, false);
      assert.deepEqual(await nativeA.evaluate(window => window.getBounds()), frameBefore.bounds);
      assert.deepEqual(await nativeB.evaluate(window => window.getBounds()), otherBounds);
      await previewA.evaluate(() => window.rack.beginPreviewResize('e'));
      await previewA.waitForFunction(async () => (await window.rack.getPreview()).state.resizing);
      await instance.evaluate(({ app }, point) => app.__rackTest.setPreviewCursor(point), { x: frameStart.x + 70, y: frameStart.y });
      await previewB.evaluate(() => { window.rack.movePreviewResize(); window.rack.endPreviewResize(); });
      await noteB.evaluate(() => { window.rack.movePreviewResize(); window.rack.endPreviewResize(); });
      await pause();
      assert.equal((await previewA.evaluate(() => window.rack.getPreview())).state.resizing, true,
        '别的图片或便签不能移动或结束第一张图片的边框会话');
      assert.deepEqual(await nativeA.evaluate(window => window.getBounds()), frameBefore.bounds);
      await previewA.evaluate(() => { window.rack.movePreviewResize(); window.rack.endPreviewResize(); });
      await previewA.waitForFunction(async () => {
        const state = (await window.rack.getPreview()).state;
        return state.mode === 'frame' && !state.resizing && state.bounds.width > 64;
      });
      const framed = (await previewA.evaluate(() => window.rack.getPreview())).state;
      assert.equal(framed.id, photos[0].id);
      assert(Math.abs(framed.bounds.width - frameBefore.bounds.width - 70) <= 2);
      assert.equal(framed.bounds.height, frameBefore.bounds.height);
      assert(Math.abs(framed.image.width / framed.image.height - photos[0].width / photos[0].height) < .0001);
      assert.deepEqual(await nativeB.evaluate(window => window.getBounds()), otherBounds);
    } finally {
      await previewA.evaluate(() => window.rack.endPreviewResize()).catch(() => {});
      await instance.evaluate(({ app }) => app.__rackTest.setPreviewCursor(null));
    }
    await imageControls(previewA, false);
    await previewA.screenshot({ path: path.join(artifacts, 'photo-preview-pinned.png') });
    await previewA.evaluate(() => window.rack.setPreviewAlwaysOnTop(false));
    await assertImageFit(previewA);
    return { independentPin: true, independentBounds: true, sourceIds: [photos[0].id, photos[1].id],
      foreignPayload, frameSourceIsolation: true, frameCursor: 'isolated DIP cursor',
      rejectedForeignRoles: ['rack resize', 'rack pin', 'note resize', 'note pin', 'rack frame begin', 'note frame begin/move/end'] };
  });

  await check('便签打开期间悬停衣架仍可粘贴，离开衣架释放 Ctrl+V 注册', async () => {
    // 先关闭图片预览，单独验证便签窗口与悬停粘贴的焦点保护。
    await closePreview(previewA); await closePreview(previewB);
    const nativeA = await instance.browserWindow(noteA);
    const noteId = await nativeA.evaluate(window => { window.setAlwaysOnTop(false); window.focus(); return window.id; });
    await noteA.waitForFunction(() => document.hasFocus());
    const image = await rack.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 777; canvas.height = 511;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#e6e8d2'; ctx.fillRect(0, 0, 777, 511);
      ctx.fillStyle = '#687350'; ctx.font = '40px Microsoft YaHei'; ctx.fillText('图片与便签，一起晾起来', 42, 250);
      return canvas.toDataURL('image/png');
    });
    const state = await instance.evaluate(async ({ app, BrowserWindow }, { value, noteId }) => {
      app.__rackTest.setClipboardImage(value);
      app.__rackTest.hoverPaste({ x: -99999, y: -99999 }, false);
      const outside = app.__rackTest.pasteState();
      const bounds = app.__rackTest.runtime().bounds;
      const editor = BrowserWindow.fromId(noteId).getBounds();
      const left = Math.max(bounds.x, editor.x), right = Math.min(bounds.x + bounds.width, editor.x + editor.width);
      const top = Math.max(bounds.y, editor.y), bottom = Math.min(bounds.y + bounds.height, editor.y + editor.height);
      if (right <= left || bottom <= top) throw new Error('便签必须与衣架形成真实重叠区，才能验证 Ctrl+V 焦点保护');
      const coveredPoint = { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
      const covered = app.__rackTest.hoverPaste(coveredPoint, true);
      const blockedTrigger = await app.__rackTest.triggerPaste();
      const inside = app.__rackTest.hoverPaste({ x: bounds.x + 70, y: bounds.y + 35 }, true);
      return { outside, covered, blockedTrigger, inside, coveredPoint, focusedId: BrowserWindow.getFocusedWindow()?.id ?? null };
    }, { value: image, noteId });
    assert.equal(state.outside.registered, false);
    assert.equal(state.focusedId, noteId);
    assert.equal(state.covered.registered, false);
    assert.equal(state.blockedTrigger, false);
    assert.equal(state.inside.registered, true);
    const focus = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null);
    assert.equal(await instance.evaluate(({ app }) => app.__rackTest.triggerPaste()), true);
    expectedPhotoCount++;
    await waitState(instance, 'snapshot', value => value.photos.length === expectedPhotoCount, '便签打开时粘贴图片');
    assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null), focus);
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.noteRuntime())).length, 2);
    const outside = await instance.evaluate(({ app }) => app.__rackTest.hoverPaste({ x: -99999, y: -99999 }, false));
    assert.equal(outside.registered, false);
    assert.equal(await noteA.evaluate(() => window.rack.pasteClipboard().then(() => false, () => true)), true);
    // 衣架置顶且便签未置顶时，几何交集实际由衣架盖住，应仍允许其快捷键。
    await rack.evaluate(() => window.rack.setAlwaysOnTop(true));
    await nativeA.evaluate(window => { window.setAlwaysOnTop(false); window.focus(); });
    await noteA.waitForFunction(() => document.hasFocus());
    const layered = await instance.evaluate(({ app }, point) => app.__rackTest.hoverPaste(point, true), state.coveredPoint);
    assert.equal(layered.registered, true);
    await instance.evaluate(({ app }) => app.__rackTest.hoverPaste({ x: -99999, y: -99999 }, false));
    await rack.evaluate(() => window.rack.setAlwaysOnTop(false));
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.pasteState())).registered, false);
    // 再打开两张图片，供下面独立关闭检查使用。
    previewA = await openPreview(instance, rack, photos[0].id);
    previewB = await openPreview(instance, rack, photos[1].id);
    return { addedWhileNotesOpen: true, noteCount: 2, shortcutReleasedOutside: true, focusRetained: true,
      focusedNoteOverlapProtected: true, uncoveredRackPasteAllowed: true, alwaysOnTopRackOverlapAllowed: true };
  });

  await check('便签与图片同时打开仍按快中慢自动收起，独立关闭图片与跨角色 IPC 正常', async () => {
    assert.equal(await previewA.evaluate(() => window.rack.getNote().then(() => false, () => true)), true);
    assert.equal(await previewB.evaluate(() => window.rack.getSnapshot().then(() => false, () => true)), true);
    assert.equal(await rack.evaluate(() => window.rack.getPreview().then(() => false, () => true)), true);
    assert.equal(await noteA.evaluate(() => window.rack.getSnapshot().then(() => false, () => true)), true);
    assert.equal(await noteB.evaluate(() => window.rack.getPreview().then(() => false, () => true)), true);
    const originalSettings = (await rack.evaluate(() => window.rack.getSnapshot())).state;
    const initialRuntime = await instance.evaluate(({ app }) => app.__rackTest.runtime());
    const inside = { x: initialRuntime.expandedBounds.x + 80, y: initialRuntime.expandedBounds.y + 100 };
    const outside = { x: initialRuntime.expandedBounds.x + initialRuntime.expandedBounds.width + 20,
      y: initialRuntime.expandedBounds.y + 300 };
    const top = { x: initialRuntime.expandedBounds.x + 80, y: initialRuntime.displayBounds.y + 2 };
    await previewA.evaluate(() => window.rack.setPreviewAlwaysOnTop(true));
    await noteB.locator('#notePinButton').click();
    await noteB.waitForFunction(() => document.getElementById('notePinButton').getAttribute('aria-pressed') === 'true');
    const windows = async () => ({
      pictures: (await instance.evaluate(({ app }) => app.__rackTest.runtime())).imagePreviews,
      notes: await instance.evaluate(({ app }) => app.__rackTest.noteRuntime())
    });
    const before = await windows();
    assert.equal(before.pictures.length, 2); assert.equal(before.notes.length, 2);
    assert(before.pictures.every(item => item.visible) && before.notes.every(item => item.visible));
    assert.equal(before.pictures.find(item => item.id === photos[0].id).alwaysOnTop, true);
    assert(before.notes.some(item => item.alwaysOnTop));
    const timings = [];
    for (const [speed, delayMs] of [['fast', 0], ['medium', 1000], ['slow', 2000]]) {
      await rack.evaluate(() => window.rack.setAutoHide(false));
      await instance.evaluate(({ app }, point) => app.__rackTest.setAutoHideCursor(point), inside);
      await rack.evaluate(speed => window.rack.setAutoHideSpeed(speed), speed);
      await rack.evaluate(() => window.rack.setAutoHide(true));
      const timing = await instance.evaluate(({ app }, input) => {
        const inside = app.__rackTest.autoHideTick(input.inside, 4000);
        const immediate = app.__rackTest.autoHideTick(input.outside).collapsed;
        if (input.delayMs === 0) return { inside, immediate };
        const beforeDue = app.__rackTest.autoHideTick(input.outside, input.delayMs - 1).collapsed;
        const due = app.__rackTest.autoHideTick(input.outside, 1).collapsed;
        return { inside, immediate, beforeDue, due };
      }, { inside, outside, delayMs });
      assert.equal(timing.inside.collapsed, false); assert.equal(timing.inside.suspended, false);
      if (delayMs === 0) assert.equal(timing.immediate, true);
      else assert.deepEqual({ immediate: timing.immediate, beforeDue: timing.beforeDue, due: timing.due },
        { immediate: false, beforeDue: false, due: true });
      await waitState(instance, 'runtime', value => value.autoHide.collapsed && !value.autoHide.suspended, '图片和便签打开时衣架仍可自动收起');
      const collapsedWindows = await windows();
      assert.deepEqual(collapsedWindows, before, '衣架收起保持两个图片与两个便签的原窗口位置、可见与置顶状态');
      const text = await noteB.locator('#noteInput').inputValue();
      await noteB.locator('#noteInput').fill(`${text}\n收起衣架后仍可继续编辑便签。`);
      await noteB.waitForFunction(text => document.getElementById('noteInput').value === text,
        `${text}\n收起衣架后仍可继续编辑便签。`);
      await noteB.waitForFunction(async text => (await window.rack.getNote()).text === text,
        `${text}\n收起衣架后仍可继续编辑便签。`);
      await noteB.locator('#noteInput').fill(text);
      await noteB.waitForFunction(async text => (await window.rack.getNote()).text === text, text);
      assert.equal((await instance.evaluate(({ app }) => app.__rackTest.runtime())).autoHide.collapsed, true);
      if (speed === 'slow') await noteA.screenshot({ path: path.join(artifacts, 'note-with-collapsed-rack.png') });
      const focusBefore = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null);
      await instance.evaluate(({ app }, point) => app.__rackTest.autoHideTick(point), top);
      const expanded = await waitState(instance, 'runtime', value => !value.autoHide.collapsed, '便签仍打开时顶部唤回衣架');
      assert.deepEqual(expanded.bounds, initialRuntime.expandedBounds);
      assert.deepEqual(await windows(), before);
      assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null), focusBefore);
      await instance.evaluate(({ app }, point) => app.__rackTest.autoHideTick(point), inside);
      timings.push({ speed, delayMs, ...timing, collapsedWindows, noteDraftSavedWhileCollapsed: true });
    }
    await instance.evaluate(({ app }, point) => {
      app.__rackTest.autoHideTick(point); app.__rackTest.autoHideTick(point, 2000);
    }, outside);
    await waitState(instance, 'runtime', value => value.autoHide.collapsed, '关闭图片前衣架已收起');
    await closePreview(previewA);
    assert.equal(previewB.isClosed(), false);
    assert.equal((await previewB.evaluate(() => window.rack.getPreview())).id, photos[1].id);
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.noteRuntime())).length, 2);
    const afterClose = await instance.evaluate(({ app }) => app.__rackTest.runtime());
    assert.equal(afterClose.autoHide.suspended, false);
    assert.equal(afterClose.autoHide.collapsed, true, '便签仍打开时，关闭图片不能展开衣架');
    await noteB.locator('#notePinButton').click();
    await noteB.waitForFunction(() => document.getElementById('notePinButton').getAttribute('aria-pressed') === 'false');
    await rack.evaluate(() => window.rack.setAutoHide(false));
    await rack.evaluate(speed => window.rack.setAutoHideSpeed(speed), originalSettings.autoHideSpeed);
    await instance.evaluate(({ app }) => app.__rackTest.setAutoHideCursor(null));
    return { source: 'isolated main-process DIP cursor and controlled auto-hide clock; not physical mouse input',
      timings, imageAndNoteWindowStateRetained: true, editingWhileCollapsed: true, closingImageDidNotExpandRack: true };
  });

  await check('自定义颜色、20 px 字号、独立置顶和标题栏拖动生效', async () => {
    await noteA.locator('#noteFontSize').selectOption('20');
    await customColor(noteA, '#e7d9ff');
    await noteB.locator('[data-color="#e1ead7"]').click();
    await noteB.locator('#noteFontSize').selectOption('16');
    await noteA.locator('#notePinButton').click();
    await noteA.waitForFunction(() => document.getElementById('notePinButton').getAttribute('aria-pressed') === 'true');
    const nativeA = await instance.browserWindow(noteA), nativeB = await instance.browserWindow(noteB);
    const nativeId = await nativeA.evaluate(window => window.id);
    await waitState(instance, 'noteRuntime', value => value.some(item => item.windowId === nativeId && item.alwaysOnTop), '便签独立置顶');
    assert.equal(await nativeB.evaluate(window => window.isAlwaysOnTop()), false);
    assert.equal(await instance.evaluate(({ app }) => app.__rackTest.runtime().alwaysOnTop), false);
    assert.equal(await noteA.locator('#noteInput').evaluate(input => getComputedStyle(input).fontSize), '20px');
    const before = await nativeA.evaluate(window => window.getBounds());
    const otherBefore = await nativeB.evaluate(window => window.getBounds());
    const handle = await noteA.locator('#noteDragHandle .note-brand').boundingBox();
    await noteA.mouse.move(handle.x + 40, handle.y + handle.height / 2);
    await noteA.mouse.down();
    await noteA.mouse.move(handle.x + 115, handle.y + handle.height / 2 + 45);
    await noteA.mouse.up();
    const moved = await waitState(instance, 'noteRuntime', value => value.some(item => item.windowId === nativeId
      && (item.bounds.x !== before.x || item.bounds.y !== before.y)), '标题栏拖动');
    assert.deepEqual(await nativeB.evaluate(window => window.getBounds()), otherBefore);
    assert(moved.find(item => item.windowId === nativeId).bounds.x >= 0);
    await noteA.locator('#noteInput').evaluate(input => { input.scrollTop = 0; });
    await noteB.screenshot({ path: path.join(artifacts, 'note-window.png') });
    await noteA.screenshot({ path: path.join(artifacts, 'note-custom.png') });
    return { customColor: '#e7d9ff', editorFont: '20px', independentPin: true, moved: moved.find(item => item.windowId === nativeId).bounds };
  });

  await check('关闭后挂出完整文字便签，衣架摘要固定 14 px 且截断而非转为图片', async () => {
    await closeNote(noteA);
    assert.equal(noteB.isClosed(), false);
    savedA = (await notes(instance)).find(note => note.text === fullText);
    assert(savedA); assert.equal(savedA.fontSize, 20); assert.equal(savedA.color, '#e7d9ff');
    assert.equal(savedA.alwaysOnTop, true);
    await closeNote(noteB);
    savedB = (await notes(instance)).find(note => note.id !== savedA.id);
    assert(savedB);
    await rack.waitForFunction(id => document.querySelector(`[data-note-id="${id}"] .note-preview`), savedA.id);
    const preview = rack.locator(`[data-note-id="${savedA.id}"] .note-preview`);
    const geometry = await preview.evaluate(element => ({ fontSize: getComputedStyle(element).fontSize,
      overflow: getComputedStyle(element).overflow, height: element.clientHeight, scrollHeight: element.scrollHeight,
      text: element.textContent, images: element.closest('.note-card').querySelectorAll('img').length }));
    assert.equal(geometry.fontSize, '14px'); assert.equal(geometry.overflow, 'hidden');
    assert(geometry.scrollHeight > geometry.height); assert.equal(geometry.text, fullText.slice(0, 700)); assert.equal(geometry.images, 0);
    const snapshot = await rack.evaluate(() => window.rack.getSnapshot());
    assert.equal(snapshot.items.filter(item => item.type === 'note').length, 2);
    assert.equal(snapshot.items.find(item => item.id === savedA.id).text.length, 700);
    assert.equal(snapshot.photos.length, expectedPhotoCount);
    await rack.locator('#photoScroll').evaluate(scroll => { scroll.scrollLeft = 0; });
    await rack.mouse.move(1, 259);
    await rack.screenshot({ path: path.join(artifacts, 'mixed-rack.png'), omitBackground: true });
    return { rackFont: geometry.fontSize, clippedHeight: geometry.height, fullTextLength: fullText.length, editableText: true };
  });

  await check('已有便签复用窗口且 payload.id 无法改变别张便签', async () => {
    noteA = await addNote(instance, rack, savedA.id);
    noteB = await addNote(instance, rack, savedB.id);
    await rack.evaluate(id => window.rack.openNote(id), savedA.id);
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.noteRuntime())).length, 2);
    const draft = await noteA.evaluate(() => window.rack.getNote());
    assert.equal(draft.text, fullText);
    const attempted = await noteA.evaluate(({ value, foreign }) => window.rack.saveNote({ ...value, id: foreign }),
      { value: draft, foreign: savedB.id });
    assert.equal(attempted.id, savedA.id);
    assert.equal((await noteB.evaluate(() => window.rack.getNote())).text, savedB.text);
    assert.equal(await rack.evaluate(() => window.rack.getNote().then(() => false, () => true)), true);
    await closeNote(noteA); await closeNote(noteB);
    const imageOnly = await waitState(instance, 'runtime', value => !value.autoHide.suspended, '便签关闭后，仍打开的图片不能保留自动隐藏暂停');
    assert.equal(previewB.isClosed(), false);
    assert.equal(imageOnly.imagePreviews.length, 1);
    assert.equal(imageOnly.imagePreviews[0].visible, true);
    await closePreview(previewB);
    await waitState(instance, 'runtime', value => !value.autoHide.suspended && value.imagePreviews.length === 0, '独立关闭最后一张图片');
  });

  await check('衣架便签右键删除仅移除所选记录和正文，其他便签及照片不变', async () => {
    const retained = await notes(instance);
    const photosBefore = (await rack.evaluate(() => window.rack.getSnapshot())).photos;
    const page = await addNote(instance, rack);
    const text = `右键删除的独立候选正文 ${runId}`;
    await page.locator('#noteInput').fill(text); await closeNote(page);
    const target = (await notes(instance)).find(note => note.text === text);
    assert(target);
    await deleteFromRack(instance, rack, target.id);
    await waitState(instance, 'snapshot', value => !value.items.some(item => item.id === target.id), '删除所选便签卡片');
    assert.deepEqual(await notes(instance), retained);
    assert.deepEqual((await rack.evaluate(() => window.rack.getSnapshot())).photos, photosBefore);
    await rack.waitForFunction(id => !document.querySelector(`[data-note-id="${id}"]`), target.id);
    const persisted = await fs.readFile(path.join(profile, 'notes.json'), 'utf8');
    assert.equal(persisted.includes(target.id), false);
    assert.equal(persisted.includes(text), false);
    assert.deepEqual(JSON.parse(persisted).notes, retained);
    deletedNotes.push({ id: target.id, text });
    return { selectedId: target.id, remainingNotes: retained.length, photosUnchanged: true, bodyRemovedFromIndex: true };
  });

  await check('多便签打开时右键删除只关闭目标窗口，未保存草稿不复活且其他便签可继续编辑', async () => {
    const page = await addNote(instance, rack);
    const text = `打开窗口删除候选 ${runId}`;
    await page.locator('#noteInput').fill(text); await closeNote(page);
    const target = (await notes(instance)).find(note => note.text === text);
    const selected = await addNote(instance, rack, target.id);
    const survivor = await addNote(instance, rack, savedB.id);
    const unsavedText = `${text}\n这段尚未关闭保存的文字必须随所选便签一起删除。`;
    await selected.locator('#noteInput').fill(unsavedText);
    await selected.waitForFunction(async value => (await window.rack.getNote()).text === value, unsavedText);
    assert.equal((await notes(instance)).find(note => note.id === target.id).text, text);
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.noteRuntime())).length, 2);
    const closed = selected.waitForEvent('close');
    await deleteFromRack(instance, rack, target.id); await closed;
    assert.equal(selected.isClosed(), true);
    assert.equal(survivor.isClosed(), false);
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.noteRuntime())).length, 1);
    assert.equal((await notes(instance)).some(note => note.id === target.id), false);
    const continuedText = `${savedB.text}\n删除另一张便签后，我仍然可以继续编辑。`;
    await survivor.locator('#noteInput').fill(continuedText); await closeNote(survivor);
    assert.equal((await notes(instance)).find(note => note.id === savedB.id).text, continuedText);
    assert.equal((await rack.evaluate(() => window.rack.getSnapshot())).photos.length, expectedPhotoCount);
    const persisted = JSON.parse(await fs.readFile(path.join(profile, 'notes.json'), 'utf8'));
    assert.equal(persisted.notes.some(note => note.id === target.id || note.text === unsavedText), false);
    deletedNotes.push({ id: target.id, text, unsavedText });
    return { targetWindowClosed: true, survivorRemainedEditable: true, unsavedTargetBodyDiscardedByExplicitDelete: true };
  });

  await check('便签删除失败保留卡片、窗口与完整草稿，右键重试成功后才消失', async () => {
    const page = await addNote(instance, rack);
    const text = `失败重试删除候选 ${runId}`;
    await page.locator('#noteInput').fill(text); await closeNote(page);
    const target = (await notes(instance)).find(note => note.text === text);
    const editor = await addNote(instance, rack, target.id);
    const latest = `${text}\n${fullText}\n删除失败必须保留这份尚未保存的完整草稿。`;
    await editor.locator('#noteInput').fill(latest);
    await editor.waitForFunction(async value => (await window.rack.getNote()).text === value, latest);
    const before = await notes(instance);
    await instance.evaluate(({ app }) => app.__rackTest.failNextNoteDelete());
    await deleteFromRack(instance, rack, target.id);
    await waitState(instance, 'snapshot', value => value.status.level === 'error'
      && value.status.message.includes('删除失败'), '便签删除失败提示');
    assert.equal(editor.isClosed(), false);
    assert.equal(await editor.locator('#noteInput').inputValue(), latest);
    assert.equal((await editor.evaluate(() => window.rack.getNote())).text, latest);
    assert.deepEqual(await notes(instance), before);
    assert.equal(await rack.locator(`[data-note-id="${target.id}"]`).count(), 1);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(profile, 'notes.json'), 'utf8')).notes, before);
    const closed = editor.waitForEvent('close');
    await deleteFromRack(instance, rack, target.id); await closed;
    await waitState(instance, 'snapshot', value => !value.items.some(item => item.id === target.id), '重试删除便签');
    assert.equal(editor.isClosed(), true);
    assert.deepEqual(await notes(instance), before.filter(note => note.id !== target.id));
    deletedNotes.push({ id: target.id, text, unsavedText: latest });
    return { failedDeleteRetainedCharacters: latest.length, cardAndWindowRetained: true, retryDeleted: true };
  });

  await check('便签保存失败时保留文本和窗口，重试关闭后才新增记录', async () => {
    const page = await addNote(instance, rack);
    const text = '这段文字在保存失败后仍然完整保留。';
    await page.locator('#noteInput').fill(text);
    const before = (await notes(instance)).length;
    await instance.evaluate(({ app }) => app.__rackTest.failNextNoteSave());
    await page.locator('#noteCloseButton').click();
    await page.waitForFunction(() => !document.getElementById('noteError').hidden && !document.getElementById('noteInput').disabled);
    assert.equal(page.isClosed(), false);
    assert.equal(await page.locator('#noteInput').inputValue(), text);
    assert.equal((await notes(instance)).length, before);
    assert.match(await page.locator('#noteError').textContent(), /保存失败/);
    await closeNote(page);
    assert.equal((await notes(instance)).length, before + 1);
    assert((await notes(instance)).some(note => note.text === text));
  });

  await check('原生窗口关闭会 flush 输入框的最新正文，包含未触发 input 的最后修改', async () => {
    const page = await addNote(instance, rack);
    await page.locator('#noteInput').fill('先前草稿');
    const latest = '原生关闭时的最新正文\n不能只保存先前草稿。';
    await page.locator('#noteInput').evaluate((input, text) => { input.value = text; }, latest);
    const native = await instance.browserWindow(page);
    const closed = page.waitForEvent('close');
    await native.evaluate(window => window.close());
    await closed;
    assert((await notes(instance)).some(note => note.text === latest));
  });

  await check('新空白便签关闭不入库，已保存便签清空后保留原 ID', async () => {
    const before = (await notes(instance)).length;
    const empty = await addNote(instance, rack);
    await empty.locator('#noteInput').fill(' \n\t'); await closeNote(empty);
    assert.equal((await notes(instance)).length, before);
    const retained = (await notes(instance)).find(note => note.id !== savedA.id && note.id !== savedB.id);
    const existing = await addNote(instance, rack, retained.id);
    await existing.locator('#noteInput').fill(''); await closeNote(existing);
    assert.equal((await notes(instance)).length, before);
    assert.equal((await notes(instance)).find(note => note.id === retained.id).text, '');
  });

  await check('退出时保存失败会取消退出并保留全文，继续编辑后可关闭重试', async () => {
    const page = await addNote(instance, rack);
    const text = `退出失败不能丢失正文\n${fullText}\n这一行也必须保留。`;
    await page.locator('#noteInput').fill(text);
    const before = (await notes(instance)).length;
    await instance.evaluate(({ app }) => { app.__rackTest.failNextNoteSave(); app.quit(); });
    const snapshot = await waitState(instance, 'snapshot', value => value.status.message.includes('有便签暂时没能保存'), '取消退出提示');
    await page.waitForFunction(() => !document.getElementById('noteInput').disabled && !document.getElementById('noteError').hidden);
    assert.equal(page.isClosed(), false);
    assert.equal(rack.isClosed(), false);
    assert.equal(await page.locator('#noteInput').inputValue(), text);
    assert.equal((await page.evaluate(() => window.rack.getNote())).text, text);
    assert.equal((await notes(instance)).length, before);
    assert.equal((await rack.evaluate(() => window.rack.getSnapshot())).items.length, snapshot.items.length);
    const retryText = `${text}\n取消退出后继续编辑，并重新保存成功。`;
    await page.locator('#noteInput').fill(retryText);
    await closeNote(page);
    assert.equal((await notes(instance)).length, before + 1);
    assert((await notes(instance)).some(note => note.text === retryText));
    return { exitCancelled: true, retainedCharacters: text.length, reopenedIPC: true, retrySaved: true };
  });

  let quitExpected;
  await check('退出程序会等待两个未关闭便签提交最新正文与独立外观位置', async () => {
    const first = await addNote(instance, rack), second = await addNote(instance, rack);
    await first.locator('#noteInput').fill('退出前第一张草稿');
    await second.locator('#noteInput').fill('退出前第二张草稿');
    await customColor(first, '#334759'); await first.locator('#noteFontSize').selectOption('24');
    await first.locator('#notePinButton').click();
    await first.waitForFunction(() => document.getElementById('notePinButton').getAttribute('aria-pressed') === 'true');
    await customColor(second, '#f2d4c4'); await second.locator('#noteFontSize').selectOption('20');
    await second.evaluate(() => {
      window.rack.beginNoteDrag({ x: 100, y: 100 }); window.rack.moveNoteDrag({ x: 180, y: 140 }); window.rack.endNoteDrag();
    });
    const before = (await notes(instance)).length;
    quitExpected = [];
    for (const [index, page] of [first, second].entries()) {
      const text = index ? '退出时第二张的最新文字\n颜色、字号和位置保持独立。' : '退出时第一张的最新文字\n深色便签使用浅色文字。';
      await page.locator('#noteInput').evaluate((input, value) => { input.value = value; }, text);
      const draft = await page.evaluate(() => window.rack.getNote());
      const native = await instance.browserWindow(page);
      quitExpected.push({ text, color: draft.color, fontSize: draft.fontSize, alwaysOnTop: draft.alwaysOnTop,
        bounds: await native.evaluate(window => window.getBounds()) });
    }
    assert.equal((await notes(instance)).length, before);
    await quit(instance);
    const disk = JSON.parse(await fs.readFile(path.join(profile, 'notes.json'), 'utf8'));
    assert.equal(disk.notes.length, before + 2);
    for (const expected of quitExpected) {
      const record = disk.notes.find(note => note.text === expected.text);
      assert(record);
      for (const key of ['color', 'fontSize', 'alwaysOnTop', 'bounds']) assert.deepEqual(record[key], expected[key]);
      expected.id = record.id;
    }
    return { savedOnQuit: 2, pendingInputIncluded: true };
  });

  await check('重启恢复便签正文、颜色、字号、置顶与位置，仍可同时打开编辑', async () => {
    ({ instance, rack } = await launch());
    const restored = await notes(instance);
    const persisted = JSON.parse(await fs.readFile(path.join(profile, 'notes.json'), 'utf8'));
    for (const deleted of deletedNotes) {
      assert.equal(restored.some(note => note.id === deleted.id || note.text === deleted.text || note.text === deleted.unsavedText), false);
      assert.equal(persisted.notes.some(note => note.id === deleted.id || note.text === deleted.text || note.text === deleted.unsavedText), false);
    }
    assert.equal((await rack.evaluate(() => window.rack.getSnapshot())).items.some(item => deletedNotes.some(note => note.id === item.id)), false);
    const pages = [];
    for (const expected of quitExpected) {
      const record = restored.find(note => note.id === expected.id);
      assert(record); assert.equal(record.text, expected.text);
      const page = await addNote(instance, rack, expected.id); pages.push(page);
      assert.equal(await page.locator('#noteInput').inputValue(), expected.text);
      assert.equal(await page.locator('#noteCustomColor').inputValue(), expected.color);
      assert.equal(await page.locator('#noteFontSize').inputValue(), String(expected.fontSize));
      assert.equal(await page.locator('#noteInput').evaluate(input => getComputedStyle(input).fontSize), `${expected.fontSize}px`);
      const native = await instance.browserWindow(page);
      assert.equal(await native.evaluate(window => window.isAlwaysOnTop()), expected.alwaysOnTop);
      const bounds = await native.evaluate(window => window.getBounds());
      for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(bounds[key] - expected.bounds[key]) <= 8,
        `窗口 ${key} 恢复异常：${bounds[key]}/${expected.bounds[key]}`);
    }
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.noteRuntime())).length, 2);
    for (const page of pages) await closeNote(page);
    const snapshot = await rack.evaluate(() => window.rack.getSnapshot());
    assert.equal(snapshot.photos.length, expectedPhotoCount);
    assert.equal(snapshot.items.filter(item => item.type === 'note').length, restored.length);
    return { restoredNotes: restored.length, simultaneouslyReopened: pages.length, deletedNotesStayedAbsent: deletedNotes.length };
  });

  await check('所有编辑、预览与衣架窗口没有页面错误，衣架占所在屏幕40%', async () => {
    assert.deepEqual(pageErrors, []);
    const screenshot = await rack.screenshot({ omitBackground: true });
    const layout = await rack.evaluate(() => ({ width: innerWidth, scale: devicePixelRatio }));
    const screenshotWidth = screenshot.readUInt32BE(16);
    const measured = await instance.evaluate(({ app }) => app.__rackTest.physicalWindow());
    const area = await instance.evaluate(({ app }) => app.__rackTest.workArea());
    const expectedWidth = Math.max(1, Math.floor(Math.min(measured.displayBounds.width * 0.4, area.width - 24)));
    assert.equal(measured.bounds.width, expectedWidth);
    assert.equal(screenshotWidth, Math.round(layout.width * layout.scale));
    assert.equal(await rack.evaluate(() => ({ require: typeof window.require, process: typeof window.process })).then(value => value.require), 'undefined');
    verification.pageErrors = pageErrors;
    return { pageErrors: 0, screenshotWidth, displayBounds: measured.displayBounds, scaleFactor: measured.scaleFactor };
  });
  await quit(instance);
}

run().then(() => { completed = true; }).catch(error => {
  console.error(error); console.error(diagnostics.join('').slice(-8000)); process.exitCode = 1;
}).finally(async () => {
  if (application) await application.close().catch(() => {});
  verification.passed = completed && verification.tests.length > 0 && verification.tests.every(item => item.passed);
  verification.testCount = verification.tests.length;
  verification.pageErrors = pageErrors;
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'verification.json'), JSON.stringify(verification, null, 2));
  console.log(`便签验证记录：${path.join(artifacts, 'verification.json')}`);
});
