'use strict';

const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { nativePhotoDrag, nativeCursor } = require('./native-photo-drag.cjs');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'test-artifacts', `v${require('../package.json').version}`);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const profile = path.join(artifacts, 'profiles', runId);
const verification = { date: new Date().toISOString(), mode: process.env.RACK_EXE ? 'packaged' : 'development', clipboard: 'isolated mock; real clipboard read only', nativeDrag: 'isolated PNG payload stub; Windows OLE drag/drop not exercised', tests: [], manualChecks: ['微信实际截图', '微信等聊天软件的真实拖入和发送未自动实测', '资源管理器文件夹真实拖入保存未自动实测', '悬浮窗跨应用置顶', '桌面背景点击穿透', 'Windows 系统 125%/150% DPI 设置', '跨不同 DPI 的真实多显示器拖动未实测'] };
let application;
let completed = false;
let originalCursor;
const mainDiagnostics = [];

async function launch(dataDir = profile, extraArgs = []) {
  const env = { ...process.env, RACK_TEST_MODE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.RACK_EXE || require('electron');
  const args = process.env.RACK_EXE ? [] : [root];
  const instance = await electron.launch({ executablePath, args: [...args, '--rack-test', `--data-dir=${dataDir}`, ...extraArgs], env, cwd: root, timeout: 60000 });
  instance.process().stderr?.on('data', (chunk) => { mainDiagnostics.push(chunk.toString()); if (mainDiagnostics.length > 30) mainDiagnostics.shift(); });
  const page = await instance.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.rack);
  await instance.evaluate(({ app }) => { if (!app.__rackTest) throw new Error('Test harness unavailable'); });
  return { instance, page };
}

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
      && Math.abs(innerWidth - state.bounds.width) <= 8 && Math.abs(innerHeight - state.bounds.height) <= 8
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
    if (style.display === 'none') return true; // 极小窗口通过右键菜单操作，辅助区域可以收起。
    const opacity = Number(style.opacity);
    return expected ? opacity > .99 : opacity < .01;
  });
  try { await page.waitForFunction(predicate, visible, { timeout: 2000 }); }
  catch (error) {
    mode = 'native-screen-cursor';
    const current = (await page.evaluate(() => window.rack.getPreview())).state;
    const points = await application.evaluate(({ screen }, { bounds, visibleArea, entered }) => {
      const inside = { x: Math.round(bounds.x + visibleArea.x + visibleArea.width / 2),
        y: Math.round(bounds.y + visibleArea.y + visibleArea.height / 2) };
      if (entered) return [screen.dipToScreenPoint(inside)];
      const corners = screen.getAllDisplays().flatMap(display => {
        const area = display.workArea;
        return [{x:area.x+1,y:area.y+1},{x:area.x+area.width-2,y:area.y+1},
          {x:area.x+1,y:area.y+area.height-2},{x:area.x+area.width-2,y:area.y+area.height-2}];
      });
      const outside = corners.find(point => point.x < bounds.x || point.y < bounds.y || point.x >= bounds.x + bounds.width || point.y >= bounds.y + bounds.height);
      if (!outside) throw new Error('窗口覆盖所有显示器，无法通过真实鼠标离开');
      return [screen.dipToScreenPoint(inside), screen.dipToScreenPoint(outside)];
    }, { bounds: current.bounds, visibleArea: current.visibleArea, entered: visible });
    await nativeCursor(points);
    try { await page.waitForFunction(predicate, visible, { timeout: 2000 }); }
    catch {
      const detail = await page.evaluate(() => ({ hovered: document.body.matches(':hover'),
        active: document.activeElement?.id, focusVisible: document.activeElement?.matches(':focus-visible'),
        dragging: document.body.classList.contains('is-dragging'),
        layers: ['.preview-brand', '.preview-footer'].map(selector => ({ selector,
          opacity: getComputedStyle(document.querySelector(selector)).opacity,
          display: getComputedStyle(document.querySelector(selector)).display })) }));
      throw new Error(`辅助工具显隐不符 expected=${visible} ${JSON.stringify(detail)}`);
    }
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

async function fixtures(page) {
  return page.evaluate(() => {
    const images = [];
    for (let i = 0; i < 18; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = i === 3 ? 360 : 640;
      canvas.height = i === 3 ? 580 : 420;
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      if (i % 3 === 0) {
        ctx.fillStyle = '#f6f2e7'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#d7ddca'; ctx.fillRect(0, 0, w, 15);
        ctx.fillStyle = '#354b3e'; ctx.font = '22px Segoe UI'; ctx.fillText('A LITTLE INSPIRATION', 38, 64);
        ctx.font = 'bold 38px Microsoft YaHei'; ctx.fillText(i === 3 ? '灵感清单' : '把今天的灵感', 38, 126);
        if (i !== 3) ctx.fillText('留在这里。', 38, 178);
        ctx.fillStyle = '#748473'; ctx.font = '20px Microsoft YaHei';
        const lines = ['散步时看见的颜色', '想要试一试的小设计', '值得收藏的一段话'];
        lines.forEach((line, n) => { ctx.fillRect(40, 224 + n * 42, 14, 14); ctx.fillText(line, 70, 238 + n * 42); });
        ctx.font = '16px Segoe UI'; ctx.fillText(`SAMPLE ${i + 1} / LOCAL ONLY`, 38, h - 30);
      } else if (i % 3 === 1) {
        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, '#e5b6a1'); gradient.addColorStop(0.6, '#f4dbb2'); gradient.addColorStop(1, '#adbea4');
        ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#f7e9c5'; ctx.beginPath(); ctx.arc(435, 108, 41 + i, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#829f87'; ctx.beginPath(); ctx.moveTo(0, 330); ctx.lineTo(170, 132); ctx.lineTo(382, 335); ctx.lineTo(640, 240); ctx.lineTo(640, 420); ctx.lineTo(0, 420); ctx.fill();
        ctx.fillStyle = '#425f51'; ctx.beginPath(); ctx.moveTo(0, 370); ctx.lineTo(160, 290); ctx.lineTo(310, 353); ctx.lineTo(508, 196); ctx.lineTo(640, 318); ctx.lineTo(640, 420); ctx.lineTo(0, 420); ctx.fill();
        ctx.fillStyle = '#fff9ed'; ctx.font = '18px Segoe UI'; ctx.fillText(`SLOW MOMENTS / ${i + 1}`, 28, 38);
      } else {
        ctx.fillStyle = '#22352e'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#30483c'; ctx.fillRect(0, 0, w, 54);
        ['#d78970', '#e6c387', '#99b392'].forEach((color, n) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(26 + n * 24, 27, 6, 0, 2 * Math.PI); ctx.fill(); });
        ctx.fillStyle = '#a8bfa1'; ctx.font = '19px Consolas'; ctx.fillText('ideas.js', 108, 34);
        const lines = [`// tiny things, saved for later ${i}`, 'const inspiration = {', '  capture: "a good moment",', '  keep: true,', '  revisit: "anytime"', '};', '', 'hang(inspiration);'];
        lines.forEach((line, n) => { ctx.fillStyle = n === 0 ? '#849d89' : n === 7 ? '#e8c894' : '#d4e3ce'; ctx.fillText(line, 30, 100 + n * 34); });
      }
      images.push({ dataURL: canvas.toDataURL('image/png'), width: w, height: h });
    }
    return images;
  });
}

async function inject(instance, image, poll = true) {
  await instance.evaluate(({ app }, dataURL) => app.__rackTest.setClipboardImage(dataURL), image?.dataURL || null);
  if (poll) await instance.evaluate(({ app }) => app.__rackTest.poll());
}

async function count(instance) {
  return instance.evaluate(({ app }) => app.__rackTest.snapshot().photos.length);
}

async function waitForSnapshot(instance, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const snapshot = await instance.evaluate(({ app }) => app.__rackTest.snapshot());
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('等待窗口状态超时');
}

async function waitForRuntime(instance, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const runtime = await instance.evaluate(({ app }) => app.__rackTest.runtime());
    if (predicate(runtime)) return runtime;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('等待原生窗口状态超时');
}

async function nativeImageGesture(instance, preview, selector = '#imageStage', options = {}) {
  const expected = options.expected || (selector === '#imageStage' ? 'move' : 'stationary');
  const delta = options.delta || { x: 80, y: 50 };
  assert(['move', 'resize', 'stationary'].includes(expected), '原生测试预期必须是 move、resize 或 stationary');
  const native = await instance.browserWindow(preview);
  const previousPin = await native.evaluate(window => {
    const previous = window.isAlwaysOnTop();
    window.setAlwaysOnTop(true);
    window.show(); window.focus(); window.moveTop();
    return previous;
  });
  try {
  await instance.evaluate(({ app }) => app.__rackTest.setPreviewCursor(null));
  await preview.bringToFront();
  await native.evaluate(window => { window.show(); window.focus(); });
  await preview.waitForFunction(async () => {
    const state = (await window.rack.getPreview()).state;
    if (state.dragging || state.resizing || document.body.classList.contains('is-dragging') || document.body.classList.contains('is-resizing')
      || Math.abs(innerWidth - state.bounds.width) > 2 || Math.abs(innerHeight - state.bounds.height) > 2) return false;
    const sx = innerWidth / state.bounds.width, sy = innerHeight / state.bounds.height, area = state.visibleArea;
    return ['previewPinButton', 'closeButton'].every(id => {
      const rect = document.getElementById(id).getBoundingClientRect();
      return rect.x >= area.x * sx - 1 && rect.y >= area.y * sy - 1
        && rect.right <= (area.x + area.width) * sx + 1 && rect.bottom <= (area.y + area.height) * sy + 1;
    });
  });
  let target = await preview.locator(selector).boundingBox();
  assert(target && target.width > 0 && target.height > 0, '真实鼠标拖动必须有可见点击目标');
  const information = await native.evaluate(window => {
    const handle = window.getNativeWindowHandle();
    return { handle: (handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString(), bounds: window.getBounds() };
  });
  const viewport = await preview.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  if (selector === '#imageStage') {
    const state = (await preview.evaluate(() => window.rack.getPreview())).state;
    const visible = { x: state.visibleArea.x * viewport.width / state.bounds.width,
      y: state.visibleArea.y * viewport.height / state.bounds.height,
      width: state.visibleArea.width * viewport.width / state.bounds.width,
      height: state.visibleArea.height * viewport.height / state.bounds.height };
    const left = Math.max(target.x, visible.x), top = Math.max(target.y, visible.y);
    const right = Math.min(target.x + target.width, visible.x + visible.width);
    const bottom = Math.min(target.y + target.height, visible.y + visible.height);
    target = { x: left, y: top, width: right - left, height: bottom - top };
    assert(target.width > 0 && target.height > 0, '真实拖动必须选择图片窗口的屏幕可见交集');
  }
  const start = await instance.evaluate(({ screen }, { bounds, target, viewport }) => screen.dipToScreenPoint({
    x: Math.round(bounds.x + (target.x + target.width / 2) * bounds.width / viewport.width),
    y: Math.round(bounds.y + (target.y + target.height / 2) * bounds.height / viewport.height) }),
  { bounds: information.bounds, target, viewport });
  let result;
  try { result = await nativePhotoDrag({ handle: information.handle, start, delta,
    afterRelease: () => preview.waitForFunction(async () => {
      const state = (await window.rack.getPreview()).state;
      return !document.body.classList.contains('is-dragging') && !document.body.classList.contains('is-resizing')
        && !state.dragging && !state.resizing;
    }) }); }
  catch (error) {
    verification.nativeImageGesture = { passed: false, selector, reason: error.message, handle: information.handle, start };
    throw error;
  }
  let after = await native.evaluate(window => window.getBounds());
  if (expected === 'move') {
    const deadline = Date.now() + 3000;
    while (after.x === information.bounds.x && after.y === information.bounds.y && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 40));
      after = await native.evaluate(window => window.getBounds());
    }
    assert(Math.abs(after.x - information.bounds.x) > 8 || Math.abs(after.y - information.bounds.y) > 8,
      `真实鼠标拖图必须移动整个窗口：${JSON.stringify({ before: information.bounds, after, start, result })}`);
    const afterState = (await preview.evaluate(() => window.rack.getPreview())).state;
    assert.equal(after.width, information.bounds.width,
      `整窗移动须保持宽度：${JSON.stringify({before:information.bounds,after,state:afterState,start,result})}`);
    assert.equal(after.height, information.bounds.height,
      `整窗移动须保持高度：${JSON.stringify({before:information.bounds,after,state:afterState,start,result})}`);
  } else if (expected === 'resize') {
    const deadline = Date.now() + 3000;
    while (after.width === information.bounds.width && after.height === information.bounds.height && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 40));
      after = await native.evaluate(window => window.getBounds());
    }
    assert(Math.abs(after.width - information.bounds.width) > 8 || Math.abs(after.height - information.bounds.height) > 8,
      `真实鼠标拖边框必须改变窗口尺寸：${JSON.stringify({ before: information.bounds, after, start, result })}`);
  } else assert.deepEqual(after, information.bounds,
    `从按钮按下后拖动鼠标不能移动整个图片窗口 ${JSON.stringify({start,target,information,after,result})}`);
  return { source: 'Windows user32 physical mouse; test cursor override disabled', temporaryTopmost: true, selector,
    expected, handle: information.handle, start, physicalDelta: delta, before: information.bounds, after, result };
  } finally {
    await native.evaluate((window, value) => { if (!window.isDestroyed()) window.setAlwaysOnTop(value); }, previousPin).catch(() => {});
  }
}

async function assertFrameContained(instance, preview) {
  const layout = await imageWindowLayout(preview);
  const photo = await preview.evaluate(() => window.rack.getPreview());
  const native = await instance.browserWindow(preview);
  const content = await native.evaluate(window => window.getContentBounds());
  const state = photo.state;
  const expectedScale = Math.min((content.width - 2) / photo.width, (content.height - 2) / photo.height, 16, state.scaleLimit);
  assert.equal(state.mode, 'frame');
  assert(Math.abs(state.scale - expectedScale) < .001, `自由调整后应自动 contain：${JSON.stringify({ state, content, expectedScale })}`);
  assert(Math.abs(state.image.width / state.image.height - photo.width / photo.height) < .0001, '边框自由拉伸不能改变图片宽高比');
  assert(Math.abs(state.image.x - (content.width - state.image.width) / 2) < .1
    && Math.abs(state.image.y - (content.height - state.image.height) / 2) < .1, '图片应在自由调整的窗口中居中');
  assert(state.image.x >= .9 && state.image.y >= .9
    && state.image.x + state.image.width <= content.width - .9
    && state.image.y + state.image.height <= content.height - .9, '完整图片应位于 1 DIP 外框内');
  return { state, content, expectedScale, layout };
}

async function run() {
  originalCursor = (await nativeCursor()).original;
  await fs.mkdir(artifacts, { recursive: true });
  let { instance, page } = await launch();
  application = instance;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const samples = await fixtures(page);
  const systemScale = (await instance.evaluate(({ app }) => app.__rackTest.physicalWindow())).scaleFactor;

  await check('透明窗口、默认状态与受限预加载', async () => {
    const runtime = await instance.evaluate(({ app }) => app.__rackTest.runtime());
    assert.equal(runtime.alwaysOnTop, false); assert.equal(runtime.trayCreated, true);
    const area = await instance.evaluate(({ app }) => app.__rackTest.workArea());
    const measured = await instance.evaluate(({ app }) => app.__rackTest.physicalWindow());
    const expectedWidth = Math.max(1, Math.floor(Math.min(measured.displayBounds.width * 0.4, area.width - 24)));
    assert.equal(runtime.bounds.width, expectedWidth); assert.equal(runtime.bounds.height, 260);
    assert(Math.abs(measured.physicalBounds.width - expectedWidth * measured.scaleFactor) <= 8, `实际屏幕宽度异常：${measured.physicalBounds.width}`);
    assert.equal(await count(instance), 0);
    const initialState = (await page.evaluate(() => window.rack.getSnapshot())).state;
    assert.equal(initialState.autoHide, false);
    assert.equal(initialState.autoHideSpeed, 'medium');
    assert.equal(await page.locator('#autoHideSpeedControl').isVisible(), false);
    const isolated = await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process, api: typeof window.rack.getSnapshot }));
    assert.deepEqual(isolated, { require: 'undefined', process: 'undefined', api: 'function' });
    await page.screenshot({ path: path.join(artifacts, 'empty-window.png'), omitBackground: true });
    return runtime;
  });
  await check('旧版固定宽度和原生尺寸改变会修正为当前屏幕40%', async () => {
    const measured = await instance.evaluate(async ({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(1680, 260);
      await app.__rackTest.persistPosition();
      return app.__rackTest.physicalWindow();
    });
    const area = await instance.evaluate(({ app }) => app.__rackTest.workArea());
    assert.equal(measured.bounds.width, Math.max(1, Math.floor(Math.min(measured.displayBounds.width * 0.4, area.width - 24))));
    return measured;
  });
  await check('Electron 44 异步剪贴板 API 可只读调用', async () => {
    const result = await instance.evaluate(({ app }) => app.__rackTest.clipboardAPI());
    assert.equal(result.read, 'function');
    return { readAvailable: true };
  });
  await check('新图片自动挂上，不重复保存，不抢焦点', async () => {
    const beforeFocus = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id || null);
    const started = Date.now();
    await inject(instance, samples[0], false);
    await waitForSnapshot(instance, (snapshot) => snapshot.photos.length === 1);
    const latency = Date.now() - started;
    assert(latency < 2200, `自动收集耗时 ${latency}ms`);
    await inject(instance, samples[0]);
    assert.equal(await count(instance), 1);
    const afterFocus = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id || null);
    assert.equal(afterFocus, beforeFocus);
    return { captureLatencyMs: latency };
  });
  await check('暂停、恢复基线与快速连续切换', async () => {
    await page.evaluate(() => window.rack.setPaused(true));
    await inject(instance, samples[1]); assert.equal(await count(instance), 1);
    await page.evaluate(() => window.rack.setPaused(false));
    await instance.evaluate(({ app }) => app.__rackTest.poll()); assert.equal(await count(instance), 1);
    await page.evaluate(() => Promise.all([window.rack.setPaused(true), window.rack.setPaused(false), window.rack.setPaused(true)]));
    assert.equal((await page.evaluate(() => window.rack.getSnapshot())).state.paused, true);
    await page.evaluate(() => window.rack.setPaused(false));
    await inject(instance, samples[2]); assert.equal(await count(instance), 2);
  });
  await check('空剪贴板和无法解码的图片被忽略', async () => {
    await inject(instance, null);
    await instance.evaluate(({ app }) => app.__rackTest.setClipboardImage('data:image/png;base64,bm90LWFuLWltYWdl'));
    await instance.evaluate(({ app }) => app.__rackTest.poll());
    assert.equal(await count(instance), 2);
  });
  await check('横竖图片、横向滚动和完整缩略图', async () => {
    for (let i = 3; i < samples.length; i++) await inject(instance, samples[i]);
    assert.equal(await count(instance), samples.length - 1);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="photo-card"]').length > 0);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="photo-card"] img')].filter((image) => image.complete && image.naturalWidth > 0).length > 0);
    const track = page.locator('[data-testid="photo-track"]');
    const geometry = await track.evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
    assert(geometry.scrollWidth > geometry.width);
    // 预加载卡片可能位于窗口外；只在滚动区内实际命中纸张的位置操作。
    const wheelPoint = await page.evaluate(() => {
      const viewport = document.getElementById('photoScroll').getBoundingClientRect();
      for (const card of document.querySelectorAll('[data-testid="photo-card"]')) {
        const rect = card.getBoundingClientRect();
        const left = Math.max(rect.left, viewport.left), right = Math.min(rect.right, viewport.right);
        const top = Math.max(rect.top, viewport.top), bottom = Math.min(rect.bottom, viewport.bottom);
        if (right - left < 10 || bottom - top < 10) continue;
        const point = { x: (left + right) / 2, y: (top + bottom) / 2 };
        if (document.elementFromPoint(point.x, point.y)?.closest('.photo-card') === card) return point;
      }
      return null;
    });
    assert(wheelPoint, '必须有实际可见的照片可供滚轮操作');
    await page.mouse.move(wheelPoint.x, wheelPoint.y);
    await waitForRuntime(instance, value => !value.ignoringMouseEvents);
    await page.mouse.wheel(0, 460);
    await page.waitForFunction(() => document.querySelector('[data-testid="photo-track"]').scrollLeft > 20);
    await track.evaluate((element) => { element.scrollLeft = 0; });
    await page.mouse.move(1, 259);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(artifacts, 'rack-window.png'), omitBackground: true });
    return geometry;
  });
  await check('大图预览、缩放与 Esc 关闭', async () => {
    const photo = (await page.evaluate(() => window.rack.getSnapshot())).photos[0];
    const newWindow = instance.waitForEvent('window');
    await page.evaluate((id) => window.rack.openPreview(id), photo.id);
    const preview = await newWindow;
    const initialLayout = await imageWindowLayout(preview);
    assert(Math.abs(initialLayout.stage.width / initialLayout.stage.height - photo.width / photo.height) < .015,
      '预览初始窗口应按原图比例收紧，只保留细边框');
    const fitted = await assertImageFit(preview);
    const hideMethod = await imageControls(preview, false);
    await preview.screenshot({ path: path.join(artifacts, 'photo-preview-clean.png') });
    const showMethod = await imageControls(preview, true);
    const image = preview.locator('[data-testid="preview-image"]');
    const before = await image.evaluate((element) => element.getBoundingClientRect().width);
    const beforeScaleState = (await preview.evaluate(() => window.rack.getPreview())).state;
    const stage = preview.locator('[data-testid="preview-stage"]');
    const box = await stage.boundingBox();
    await preview.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await preview.mouse.wheel(0, -400);
    await preview.waitForFunction(async previous => (await window.rack.getPreview()).state.scale > previous, beforeScaleState.scale);
    const after = await image.evaluate((element) => element.getBoundingClientRect().width);
    assert(after > before, `缩放前后宽度 ${before}/${after}`);
    const resized = (await preview.evaluate(() => window.rack.getPreview())).state;
    assert(resized.bounds.width > beforeScaleState.bounds.width && resized.bounds.height > beforeScaleState.bounds.height,
      '滚轮缩放图片时整个窗口必须同步变大');
    assert.equal(await stage.evaluate(element => element.classList.contains('can-pan')), false, '图片不再在固定窗口内平移');
    const beforeMoveImage = await preview.locator('#imageWorld').evaluate(element => ({ left: element.style.left, top: element.style.top }));
    const actualDrag = await nativeImageGesture(instance, preview);
    const afterMoveImage = await preview.locator('#imageWorld').evaluate(element => ({ left: element.style.left, top: element.style.top }));
    assert.deepEqual(afterMoveImage, beforeMoveImage, '真正拖图移动的是窗口，图片在窗口内的位置保持');
    const buttonDrag = await nativeImageGesture(instance, preview, '#previewPinButton');
    const releaseBox = await stage.boundingBox();
    await preview.mouse.move(releaseBox.x + releaseBox.width / 2, releaseBox.y + releaseBox.height / 2);
    const downPointer = preview.evaluate(() => new Promise(resolve => {
      document.body.addEventListener('pointerdown', event => resolve(event.pointerId), { once: true });
    }));
    await preview.mouse.down();
    const pointerId = await downPointer;
    await preview.waitForFunction(() => document.body.classList.contains('is-dragging'));
    await preview.evaluate(pointerId => document.body.dispatchEvent(new PointerEvent('pointermove',
      { bubbles: true, pointerId, buttons: 0 })), pointerId);
    await preview.waitForFunction(async () => !document.body.classList.contains('is-dragging')
      && !(await window.rack.getPreview()).state.dragging);
    await preview.mouse.up();
    await imageControls(preview, true);
    await preview.screenshot({ path: path.join(artifacts, 'photo-preview.png') });
    await preview.locator('#zoomIn').click();
    const hideAfterClickMethod = await imageControls(preview, false, { blur: false });
    await preview.keyboard.press('Tab');
    await preview.waitForFunction(() => document.activeElement?.matches('button:focus-visible')
      && ['.preview-brand', '.preview-footer'].every(selector => {
        const style = getComputedStyle(document.querySelector(selector));
        return style.display === 'none' || Number(style.opacity) > .99;
      }));
    const closed = preview.waitForEvent('close');
    await preview.keyboard.press('Escape').catch((error) => { if (!preview.isClosed()) throw error; });
    await closed;
    return { fitted, initialWindowRatio: initialLayout.stage.width / initialLayout.stage.height,
      thinBorder: '1px', controlsAlwaysVisible: ['pin', 'close'], resized,
      hideMethod, showMethod, hideAfterClickMethod, keyboardControlsVisible: true, missedReleaseEnded: true, actualDrag, buttonDrag };
  });
  await check('真实鼠标拖右边和右下角可自由调整窗口，图片按原比例居中完整显示', async () => {
    const photo = (await page.evaluate(() => window.rack.getSnapshot())).photos[0];
    const opened = instance.waitForEvent('window');
    await page.evaluate(id => window.rack.openPreview(id), photo.id);
    const preview = await opened;
    await imageWindowLayout(preview);
    await preview.evaluate(() => window.rack.resizePreview({ mode: 'actual' }));
    await imageWindowLayout(preview);
    const zones = await preview.evaluate(() => [...document.querySelectorAll('[data-preview-resize-edge]')].map(element => {
      const rect = element.getBoundingClientRect(), edge = element.dataset.previewResizeEdge;
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('[data-preview-resize-edge]');
      return { edge, width: rect.width, height: rect.height, cursor: getComputedStyle(element).cursor,
        actuallyHit: hit?.dataset.previewResizeEdge === edge };
    }));
    assert.deepEqual(zones.map(zone => zone.edge).sort(), ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].sort());
    for (const zone of zones) {
      const horizontal = ['n', 's'].includes(zone.edge), vertical = ['e', 'w'].includes(zone.edge);
      if (horizontal) assert(Math.abs(zone.height - 5) < .1);
      else if (vertical) assert(Math.abs(zone.width - 5) < .1);
      else assert(Math.abs(zone.width - 8) < .1 && Math.abs(zone.height - 8) < .1);
      assert(/resize$/.test(zone.cursor), `边框必须显示调整大小的鼠标：${JSON.stringify(zone)}`);
      assert.equal(zone.actuallyHit, true, `边框不能被图片或工具条遮挡：${JSON.stringify(zone)}`);
    }
    assert.equal(await preview.locator('#previewPinButton').evaluate(button => {
      const rect = button.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button') === button;
    }), true, '内缩后的置顶按钮必须优先可点击');
    const right = await nativeImageGesture(instance, preview, '[data-preview-resize-edge="e"]',
      { expected: 'resize', delta: { x: 80, y: 0 } });
    assert.equal(right.after.x, right.before.x); assert.equal(right.after.y, right.before.y);
    assert.equal(right.after.height, right.before.height); assert(right.after.width > right.before.width + 8);
    const wide = await assertFrameContained(instance, preview);
    assert(wide.state.image.x > 1, '只向右加宽时图片应保持比例并出现左右居中余量');
    await imageControls(preview, false);
    await preview.screenshot({ path: path.join(artifacts, 'photo-frame-wide.png') });
    const corner = await nativeImageGesture(instance, preview, '[data-preview-resize-edge="se"]',
      { expected: 'resize', delta: { x: 80, y: 50 } });
    assert.equal(corner.after.x, corner.before.x); assert.equal(corner.after.y, corner.before.y);
    assert(corner.after.width > corner.before.width + 8 && corner.after.height > corner.before.height + 8);
    const contained = await assertFrameContained(instance, preview);
    const button = await nativeImageGesture(instance, preview, '#previewPinButton', { expected: 'stationary' });
    await imageControls(preview, true);
    await preview.screenshot({ path: path.join(artifacts, 'photo-frame-corner.png') });
    const native = await instance.browserWindow(preview);
    assert.equal(await native.evaluate(window => window.isResizable()), false, '边框调整使用受限 IPC，系统任意拉伸保持关闭');
    const fitted = await assertImageFit(preview);
    const closed = preview.waitForEvent('close');
    await preview.evaluate(() => window.rack.closePreview()).catch(error => { if (!preview.isClosed()) throw error; });
    await closed;
    return { zones, nativeRightEdge: right, nativeCorner: corner, buttonStationary: button,
      wideContain: wide, cornerContain: contained, fitted };
  });
  await check('受控边框调整保留对边、限制最小尺寸和物理面积，失焦和丢失捕获会结束调整', async () => {
    const photo = (await page.evaluate(() => window.rack.getSnapshot())).photos[0];
    const opened = instance.waitForEvent('window');
    await page.evaluate(id => window.rack.openPreview(id), photo.id);
    const preview = await opened;
    const native = await instance.browserWindow(preview);
    await imageWindowLayout(preview);
    const begin = async (edge, point) => {
      await instance.evaluate(({ app }, value) => app.__rackTest.setPreviewCursor(value), point);
      await preview.evaluate(value => window.rack.beginPreviewResize(value), edge);
      await preview.waitForFunction(async () => (await window.rack.getPreview()).state.resizing);
    };
    const end = async () => {
      await preview.evaluate(() => window.rack.endPreviewResize());
      await preview.waitForFunction(async () => !(await window.rack.getPreview()).state.resizing);
    };
    let minimum, limited, lostCapture, blurEnded;
    try {
      const original = await preview.evaluate(() => window.rack.resizePreview({ mode: 'actual' }));
      const start = { x: original.bounds.x, y: original.bounds.y };
      await begin('nw', start);
      await instance.evaluate(({ app }, value) => app.__rackTest.setPreviewCursor(value),
        { x: start.x + original.bounds.width * 2, y: start.y + original.bounds.height * 2 });
      await preview.evaluate(() => window.rack.movePreviewResize());
      await preview.waitForFunction(async () => {
        const state = (await window.rack.getPreview()).state;
        return state.mode === 'frame' && state.bounds.width === 64 && state.bounds.height === 48;
      });
      await end();
      minimum = await assertFrameContained(instance, preview);
      assert(minimum.state.bounds.width >= 64 && minimum.state.bounds.width <= 65
        && minimum.state.bounds.height >= 48 && minimum.state.bounds.height <= 49, '最小请求 64×48，原生 DIP 回报仅允许多 1');
      assert(Math.abs(minimum.state.bounds.x + minimum.state.bounds.width - original.bounds.x - original.bounds.width) <= 1
        && Math.abs(minimum.state.bounds.y + minimum.state.bounds.height - original.bounds.y - original.bounds.height) <= 1,
      '从左上缩小时原来的右边和下边必须保持');
      await preview.screenshot({ path: path.join(artifacts, 'photo-frame-minimum.png') });

      const baseline = await preview.evaluate(() => window.rack.resizePreview({ mode: 'actual' }));
      const lowerRight = { x: baseline.bounds.x + baseline.bounds.width - 1, y: baseline.bounds.y + baseline.bounds.height - 1 };
      await begin('se', lowerRight);
      await instance.evaluate(({ app }, value) => app.__rackTest.setPreviewCursor(value),
        { x: lowerRight.x + 100000, y: lowerRight.y + 100000 });
      await preview.evaluate(() => window.rack.movePreviewResize());
      await preview.waitForFunction(async () => (await window.rack.getPreview()).state.mode === 'frame');
      await end();
      limited = await assertFrameContained(instance, preview);
      assert(limited.state.drawnSize.width <= 8192 && limited.state.drawnSize.height <= 8192
        && limited.state.drawnSize.area <= 16_000_000, '边框巨幅调整仍须遵守真实绘制像素预算');
      assert.equal(limited.state.bounds.x, baseline.bounds.x); assert.equal(limited.state.bounds.y, baseline.bounds.y);

      await preview.evaluate(() => window.rack.resizePreview({ mode: 'actual' }));
      await imageWindowLayout(preview);
      const box = await preview.locator('[data-preview-resize-edge="e"]').boundingBox();
      const state = (await preview.evaluate(() => window.rack.getPreview())).state;
      const viewport = await preview.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const gripPoint = { x: state.bounds.x + (box.x + box.width / 2) * state.bounds.width / viewport.width,
        y: state.bounds.y + (box.y + box.height / 2) * state.bounds.height / viewport.height };
      await preview.evaluate(() => {
        window.__rackResizePointerId = null;
        document.body.addEventListener('pointerdown', event => { window.__rackResizePointerId = event.pointerId; }, { capture: true, once: true });
      });
      await preview.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await instance.evaluate(({ app }, value) => app.__rackTest.setPreviewCursor(value), gripPoint);
      await preview.mouse.down();
      await preview.waitForFunction(async () => document.body.classList.contains('is-resizing') && (await window.rack.getPreview()).state.resizing);
      const pointerId = await preview.evaluate(() => window.__rackResizePointerId);
      assert(Number.isSafeInteger(pointerId) && pointerId > 0);
      await preview.evaluate(pointerId => document.body.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId, bubbles: true })), pointerId);
      await preview.waitForFunction(async () => !document.body.classList.contains('is-resizing') && !(await window.rack.getPreview()).state.resizing);
      await preview.mouse.up();
      lostCapture = { pointerId, source: 'renderer pointer gesture + explicit lostpointercapture + isolated DIP cursor', ended: true };

      await preview.bringToFront(); await native.evaluate(window => window.focus());
      await preview.waitForFunction(() => document.hasFocus());
      await preview.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await instance.evaluate(({ app }, value) => app.__rackTest.setPreviewCursor(value), gripPoint);
      await preview.mouse.down();
      await preview.waitForFunction(async () => (await window.rack.getPreview()).state.resizing);
      await native.evaluate(window => window.blur());
      await preview.waitForFunction(async () => !document.body.classList.contains('is-resizing') && !(await window.rack.getPreview()).state.resizing);
      await preview.mouse.up();
      blurEnded = { source: 'native BrowserWindow.blur + renderer pointer gesture + isolated DIP cursor', ended: true };
    } finally {
      await preview.mouse.up().catch(() => {});
      await preview.evaluate(() => window.rack.endPreviewResize()).catch(() => {});
      await instance.evaluate(({ app }) => app.__rackTest.setPreviewCursor(null));
    }
    const fitted = await assertImageFit(preview);
    const closed = preview.waitForEvent('close');
    await preview.evaluate(() => window.rack.closePreview()).catch(error => { if (!preview.isClosed()) throw error; });
    await closed;
    return { source: 'isolated main-process DIP cursor; native edge/corner input covered by preceding group',
      minimum, physicalLimit: limited, lostCapture, blurEnded, fitted };
  });
  await check('照片拖出使用完整 PNG 原生载荷，衣架保留且拖后点击不会误开预览', async () => {
    const snapshot = await page.evaluate(() => window.rack.getSnapshot());
    const photo = snapshot.photos[0];
    const card = page.locator(`[data-photo-id="${photo.id}"]`);
    assert.equal(await card.getAttribute('draggable'), 'true');
    assert.equal(await card.locator('img').getAttribute('draggable'), 'true');
    await card.dispatchEvent('pointerdown', { button: 0, pointerId: 7 });
    await page.evaluate((id) => window.rack.preparePhotoDrag(id), photo.id);
    await card.dispatchEvent('dragstart');
    const runtime = await waitForRuntime(instance, (value) => value.lastNativeDrag?.id === photo.id && !value.nativeDragging);
    const payload = runtime.lastNativeDrag;
    assert.equal(payload.prepared, true);
    assert.equal(payload.nativeCalled, false, '隔离测试不得调用真实 Windows OLE 拖放');
    assert.equal(path.dirname(payload.file), path.join(profile, 'exports'));
    assert.equal(path.basename(payload.file), `${photo.id}.png`);
    assert(payload.iconSize.width > 0 && payload.iconSize.width <= 128);
    assert(payload.iconSize.height > 0 && payload.iconSize.height <= 96);
    const exported = await fs.readFile(payload.file);
    const original = await fs.readFile(path.join(profile, 'photos', `${photo.id}.png`));
    assert.deepEqual(exported, original);
    assert.deepEqual([...exported.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(await count(instance), snapshot.photos.length);
    await card.dispatchEvent('click');
    assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    await page.locator('#pauseButton').hover();
    await waitForRuntime(instance, (value) => !value.ignoringMouseEvents);
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.runtime())).autoHide.suspended, false);
    return { id: photo.id, file: payload.file, iconSize: payload.iconSize, nativeWindowsDrag: 'stub only', copiedBytes: exported.length };
  });
  await check('图片窗口缩放跟随原图、滚轮锚点不漂移、超屏仍可操作并适应屏幕', async () => {
    const photos = (await page.evaluate(() => window.rack.getSnapshot())).photos;
    // 竖图在较宽的高分屏也可用温和面积覆盖超屏分支，无需逼近最长边上限。
    const photo = photos.find(photo => photo.height > photo.width) || photos[0];
    const opened = instance.waitForEvent('window');
    await page.evaluate(id => window.rack.openPreview(id), photo.id);
    const preview = await opened;
    const native = await instance.browserWindow(preview);
    await imageWindowLayout(preview);
    const actual = await preview.evaluate(() => window.rack.resizePreview({ mode: 'actual' }));
    assert.equal(actual.mode, 'actual'); assert(Math.abs(actual.scale - 1) < .001);
    assert(Math.abs(actual.image.width - photo.width) <= 1 && Math.abs(actual.image.height - photo.height) <= 1);
    assert(Math.abs(actual.bounds.width - actual.image.width - 2) <= 1 && Math.abs(actual.bounds.height - actual.image.height - 2) <= 1,
      '1:1 时窗口随原图尺寸，只保留四边各 1 DIP');

    await preview.evaluate(() => window.rack.resizePreview({ scale: .8 }));
    const base = (await imageWindowLayout(preview)).state;
    const anchor = { x: .37, y: .63 };
    const point = { x: base.bounds.x + base.image.x + base.image.width * anchor.x,
      y: base.bounds.y + base.image.y + base.image.height * anchor.y };
    const cssPoint = await preview.locator('#imageWorld').evaluate((element, anchor) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width * anchor.x, y: rect.y + rect.height * anchor.y };
    }, anchor);
    await preview.mouse.move(cssPoint.x, cssPoint.y);
    await instance.evaluate(({ app }, point) => app.__rackTest.setPreviewCursor(point), point);
    let zoomed;
    try {
      await preview.mouse.wheel(0, -120);
      await preview.waitForFunction(async scale => (await window.rack.getPreview()).state.scale > scale, base.scale);
      zoomed = (await preview.evaluate(() => window.rack.getPreview())).state;
      const afterPoint = { x: zoomed.bounds.x + zoomed.image.x + zoomed.image.width * anchor.x,
        y: zoomed.bounds.y + zoomed.image.y + zoomed.image.height * anchor.y };
      assert(Math.abs(point.x - afterPoint.x) <= 2 && Math.abs(point.y - afterPoint.y) <= 2,
        `滚轮锚点应保持屏幕位置：${JSON.stringify({ point, afterPoint, base, zoomed })}`);
    } finally { await instance.evaluate(({ app }) => app.__rackTest.setPreviewCursor(null)); }

    const center = { x: zoomed.bounds.x + zoomed.bounds.width / 2, y: zoomed.bounds.y + zoomed.bounds.height / 2 };
    const centered = await preview.evaluate(scale => window.rack.resizePreview({ scale }), zoomed.scale * 1.15);
    assert(Math.abs(center.x - centered.bounds.x - centered.bounds.width / 2) <= 2
      && Math.abs(center.y - centered.bounds.y - centered.bounds.height / 2) <= 2, '不带锚点的按钮缩放保持窗口中心');
    const area = await instance.evaluate(({ screen }, bounds) => screen.getDisplayMatching(bounds).workArea, centered.bounds);
    const largeScale = Math.min(centered.scaleLimit, Math.max(area.width / photo.width, area.height / photo.height) * 1.2);
    const large = await preview.evaluate(scale => window.rack.resizePreview({ scale }), largeScale);
    assert(large.bounds.width > area.width || large.bounds.height > area.height, '测试样例应真实放大到超出屏幕');
    assert(large.scale <= large.scaleLimit);
    // 请求先按图片像素取 ceil，再留两侧细框；原生 DIP 往返另允许 1 DIP 取整。
    const largeGeometry = { width: Math.max(64, Math.ceil(large.image.width) + 2),
      height: Math.max(48, Math.ceil(large.image.height) + 2) };
    assert(Math.abs(large.bounds.width - largeGeometry.width) <= 1 && Math.abs(large.bounds.height - largeGeometry.height) <= 1,
      `超屏尺寸应符合图片取整、两侧细框及原生 DIP 取整：${JSON.stringify({large,largeGeometry})}`);
    await preview.waitForFunction(async () => {
      const state = (await window.rack.getPreview()).state;
      return Math.abs(document.getElementById('imageWorld').getBoundingClientRect().width
        - state.image.width * innerWidth / state.bounds.width) < 2;
    });
    await preview.waitForFunction(async () => {
      const state = (await window.rack.getPreview()).state;
      const sx = innerWidth / state.bounds.width, sy = innerHeight / state.bounds.height;
      const visible = state.visibleArea;
      return ['previewPinButton', 'closeButton'].every(id => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return rect.x >= visible.x * sx - 1 && rect.y >= visible.y * sy - 1
          && rect.right <= (visible.x + visible.width) * sx + 1 && rect.bottom <= (visible.y + visible.height) * sy + 1;
      });
    });
    const settledLarge = (await preview.evaluate(() => window.rack.getPreview())).state;
    const oversizedLayout = await imageWindowLayout(preview);
    const controls = await preview.evaluate(() => ['previewPinButton', 'closeButton'].map(id => {
      const rect = document.getElementById(id).getBoundingClientRect();
      return { id, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
    }));
    const viewport = await preview.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const visible = { x: settledLarge.visibleArea.x * viewport.width / settledLarge.bounds.width,
      y: settledLarge.visibleArea.y * viewport.height / settledLarge.bounds.height,
      right: (settledLarge.visibleArea.x + settledLarge.visibleArea.width) * viewport.width / settledLarge.bounds.width,
      bottom: (settledLarge.visibleArea.y + settledLarge.visibleArea.height) * viewport.height / settledLarge.bounds.height };
    for (const control of controls) assert(control.x >= visible.x - 1 && control.y >= visible.y - 1
      && control.right <= visible.right + 1 && control.bottom <= visible.bottom + 1,
    `超屏后置顶和关闭应留在屏幕可见交集中 ${JSON.stringify({control,visible,large,viewport})}`);
    await imageControls(preview, true);
    await preview.screenshot({ path: path.join(artifacts, 'photo-preview-large.png') });
    const fitted = await assertImageFit(preview);
    assert(fitted.state.bounds.x >= area.x && fitted.state.bounds.y >= area.y
      && fitted.state.bounds.x + fitted.state.bounds.width <= area.x + area.width + 1
      && fitted.state.bounds.y + fitted.state.bounds.height <= area.y + area.height + 1, '适应屏幕应恢复整窗可见');
    assert.equal(await native.evaluate(window => window.isResizable()), false, '图片尺寸由缩放管理，不使用任意边缘拉伸');
    await preview.locator('#previewPinButton').click();
    await preview.waitForFunction(() => document.getElementById('previewPinButton').getAttribute('aria-pressed') === 'true');
    assert.equal(await native.evaluate(window => window.isAlwaysOnTop()), true);
    await preview.screenshot({ path: path.join(artifacts, 'photo-preview-pinned.png') });
    const closed = preview.waitForEvent('close');
    await preview.locator('#closeButton').click().catch(error => { if (!preview.isClosed()) throw error; });
    await closed;
    return { originalSize: actual.image, wheelAnchor: { source: 'renderer wheel + isolated main-process DIP cursor', point, anchor, zoomed },
      centerRetained: true, oversized: large, visibleControls: controls, oversizedLayout, fitted, pinned: true };
  });
  await check('反复准备不同照片拖出时内存图标缓存有界，淘汰后仍可拖出原图', async () => {
    const photos = (await page.evaluate(() => window.rack.getSnapshot())).photos;
    for (const photo of photos) {
      await page.evaluate((id) => window.rack.preparePhotoDrag(id), photo.id);
      const runtime = await instance.evaluate(({ app }) => app.__rackTest.runtime());
      assert(runtime.preparedDragCount <= 2);
    }
    await page.evaluate((id) => window.rack.preparePhotoDrag(id), photos[0].id);
    const bytes = await fs.readFile(path.join(profile, 'exports', `${photos[0].id}.png`));
    assert.deepEqual(bytes, await fs.readFile(path.join(profile, 'photos', `${photos[0].id}.png`)));
    assert.equal(await count(instance), photos.length);
  });
  await check('照片右键菜单、悬浮多图置顶、同图复用与独立关闭', async () => {
    const photos = (await page.evaluate(() => window.rack.getSnapshot())).photos;
    await page.locator(`[data-photo-id="${photos[0].id}"]`).dispatchEvent('contextmenu');
    const menu = await waitForRuntime(instance, (value) => value.lastPhotoMenu?.id === photos[0].id);
    assert.deepEqual(menu.lastPhotoMenu.labels, ['悬浮', '删除']);
    let newWindow = instance.waitForEvent('window');
    await instance.evaluate(({ app }) => app.__rackTest.choosePhotoMenu('悬浮'));
    const firstFloating = await newWindow;
    await firstFloating.waitForFunction(() => document.body.classList.contains('is-floating'));
    const floatingLayout = await imageWindowLayout(firstFloating);
    assert(Math.abs(floatingLayout.stage.width / floatingLayout.stage.height - photos[0].width / photos[0].height) < .015,
      '悬浮初始窗口应按原图比例收紧，只保留细边框');
    const floatingFit = await assertImageFit(firstFloating);
    await waitForRuntime(instance, (value) => value.floating.length === 1 && value.floating[0].visible);
    assert.equal(await firstFloating.locator('#previewTitle').textContent(), '悬浮图片');
    const firstPhoto = await firstFloating.evaluate(() => window.rack.getPreview());
    assert.equal(firstPhoto.floating, true); assert.equal(firstPhoto.state.alwaysOnTop, true);
    await instance.evaluate(({ app }) => app.__rackTest.choosePhotoMenu('悬浮'));
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.runtime())).floating.length, 1);
    await page.evaluate((id) => window.rack.showPhotoMenu(id), photos[1].id);
    await waitForRuntime(instance, (value) => value.lastPhotoMenu?.id === photos[1].id);
    newWindow = instance.waitForEvent('window');
    await instance.evaluate(({ app }) => app.__rackTest.choosePhotoMenu('悬浮'));
    const secondFloating = await newWindow;
    await imageWindowLayout(secondFloating);
    const opened = await waitForRuntime(instance, (value) => value.floating.length === 2 && value.floating.every((entry) => entry.visible));
    assert(opened.floating.every((entry) => entry.alwaysOnTop));
    const floatingHideMethod = await imageControls(firstFloating, false);
    await firstFloating.screenshot({ path: path.join(artifacts, 'floating-clean.png') });
    await imageControls(firstFloating, true);
    await firstFloating.screenshot({ path: path.join(artifacts, 'floating-window.png') });
    const firstNativeWindow = await instance.browserWindow(firstFloating);
    const secondNativeWindow = await instance.browserWindow(secondFloating);
    const otherBounds = await secondNativeWindow.evaluate(window => window.getBounds());
    const resizeRequest = await firstNativeWindow.evaluate(window => ({ before: window.getBounds(),
      resizable: window.isResizable(), minimumSize: window.getMinimumSize() }));
    assert.equal(resizeRequest.resizable, false);
    // 不可自由拉伸的 Windows 窗口可报告当前尺寸为原生 min；下限由实际缩小结果验收。
    const minimum = await firstFloating.evaluate(() => window.rack.resizePreview({ scale: 1e-6 }));
    assert(minimum.bounds.width >= 64 && minimum.bounds.width <= 65
      && minimum.bounds.height >= 48 && minimum.bounds.height <= 49, '最小请求 64×48，原生 DIP 回报仅允许多 1');
    assert(minimum.scale >= minimum.minScale && minimum.image.width >= 1 && minimum.image.height >= 1,
      '缩放到最小窗口仍须保留非零图片，不能把原图压成不可见的亚像素');
    await firstFloating.waitForFunction(() => innerWidth <= 72 && innerHeight <= 56
      && document.body.classList.contains('is-compact'), undefined, { timeout: 5000 });
    const nativeCompactBounds = await firstNativeWindow.evaluate(window => window.getBounds());
    const compact = await firstFloating.evaluate(() => {
      const button = document.getElementById('closeButton').getBoundingClientRect();
      const pin = document.getElementById('previewPinButton').getBoundingClientRect();
      return { width: innerWidth, height: innerHeight, closeVisible: button.width > 0 && button.x >= 0 && button.right <= innerWidth,
        pinVisible: pin.width > 0 && pin.x >= 0 && pin.right <= innerWidth,
        footerHidden: getComputedStyle(document.querySelector('.preview-footer')).display === 'none' };
    });
    assert(Math.abs(compact.width - 64) <= 8 && Math.abs(compact.height - 48) <= 8,
      `悬浮窗渲染客户区尺寸不符：${JSON.stringify({ compact, nativeCompactBounds, resizeRequest })}`);
    assert.equal(compact.closeVisible, true); assert.equal(compact.pinVisible, true); assert.equal(compact.footerHidden, true);
    await imageWindowLayout(firstFloating);
    await firstFloating.screenshot({ path: path.join(artifacts, 'floating-compact.png') });
    await firstFloating.locator('#previewPinButton').click();
    await firstFloating.waitForFunction(() => document.getElementById('previewPinButton').getAttribute('aria-pressed') === 'false');
    assert.equal(await firstNativeWindow.evaluate(window => window.isAlwaysOnTop()), false);
    assert.equal(await secondNativeWindow.evaluate(window => window.isAlwaysOnTop()), true, '取消第一张置顶不能改变第二张');
    assert.deepEqual(await secondNativeWindow.evaluate(window => window.getBounds()), otherBounds);
    await firstFloating.locator('#imageStage').dispatchEvent('contextmenu');
    const menuState = await instance.evaluate(({ app }) => app.__rackTest.previewMenu());
    assert.deepEqual(menuState.labels, ['放大', '缩小', '适应屏幕', '1:1', '置顶', '关闭']);
    assert.equal(menuState.checked['置顶'], false);
    await instance.evaluate(({ app }) => app.__rackTest.choosePreviewMenu('置顶'));
    assert.equal(await firstNativeWindow.evaluate(window => window.isAlwaysOnTop()), true);
    await instance.evaluate(({ app }) => app.__rackTest.choosePreviewMenu('放大'));
    const enlarged = (await firstFloating.evaluate(() => window.rack.getPreview())).state;
    assert(enlarged.scale > minimum.scale);
    await instance.evaluate(({ app }) => app.__rackTest.choosePreviewMenu('1:1'));
    assert.equal((await firstFloating.evaluate(() => window.rack.getPreview())).state.mode, 'actual');
    await instance.evaluate(({ app }) => app.__rackTest.choosePreviewMenu('适应屏幕'));
    const compactFit = await assertImageFit(firstFloating);
    await firstFloating.evaluate(() => window.rack.resizePreview({ scale: 1e-6 }));
    await firstFloating.waitForFunction(() => document.body.classList.contains('is-compact'));
    await page.evaluate(() => window.rack.hide());
    const hidden = await instance.evaluate(({ app }) => app.__rackTest.runtime());
    assert.equal(hidden.visible, false);
    assert(hidden.floating.every((entry) => entry.visible && entry.alwaysOnTop));
    await instance.evaluate(({ app }) => app.__rackTest.restore());
    const closed = firstFloating.waitForEvent('close');
    await firstFloating.locator('#closeButton').click().catch((error) => { if (!firstFloating.isClosed()) throw error; });
    await closed;
    await waitForRuntime(instance, (value) => value.floating.length === 1 && value.floating[0].id === photos[1].id);
    assert.equal(secondFloating.isClosed(), false);
    assert.equal(await count(instance), photos.length);
    return { menu: menu.lastPhotoMenu.labels, samePhotoWindows: 1, multiplePhotos: 2, compact, nativeCompactBounds, resizeRequest,
      floatingFit, compactFit, floatingHideMethod, thinBorder: '1px', menuState, independentPin: true, minimum };
  });
  await check('极小图片窗口的右键菜单可以独立关闭，其他悬浮图仍保留', async () => {
    const photos = (await page.evaluate(() => window.rack.getSnapshot())).photos;
    const opened = instance.waitForEvent('window');
    await page.evaluate(id => window.rack.openPreview(id), photos[2].id);
    const preview = await opened;
    await imageWindowLayout(preview);
    await preview.evaluate(() => window.rack.resizePreview({ scale: 1e-6 }));
    await preview.waitForFunction(() => document.body.classList.contains('is-compact'));
    await preview.locator('#imageStage').dispatchEvent('contextmenu');
    const menu = await instance.evaluate(({ app }) => app.__rackTest.previewMenu());
    assert(menu.labels.includes('关闭') && menu.labels.includes('适应屏幕'));
    const closed = preview.waitForEvent('close');
    await instance.evaluate(({ app }) => app.__rackTest.choosePreviewMenu('关闭'));
    await closed;
    const runtime = await waitForRuntime(instance, value => value.imagePreviews.length === 0 && value.floating.length === 1);
    assert.equal(runtime.floating[0].id, photos[1].id);
    assert.equal(await count(instance), photos.length);
    return { menu, closedOnlySelectedWindow: true, floatingRetained: runtime.floating[0].id };
  });
  await check('右键删除清除原图缩略图与导出缓存，关闭相关窗口并保留外部副本', async () => {
    const photos = (await page.evaluate(() => window.rack.getSnapshot())).photos;
    const deleted = photos[0];
    const other = photos[1];
    await page.evaluate((id) => window.rack.preparePhotoDrag(id), deleted.id);
    const exportFile = path.join(profile, 'exports', `${deleted.id}.png`);
    const externalCopy = path.join(artifacts, `external-drop-copy-${runId}.png`);
    await fs.copyFile(exportFile, externalCopy);
    const expectedBytes = await fs.readFile(externalCopy);
    await page.evaluate((id) => window.rack.showPhotoMenu(id), deleted.id);
    await waitForRuntime(instance, (value) => value.lastPhotoMenu?.id === deleted.id);
    let newWindow = instance.waitForEvent('window');
    await instance.evaluate(({ app }) => app.__rackTest.choosePhotoMenu('悬浮'));
    const floating = await newWindow;
    await floating.waitForFunction(() => document.querySelector('#previewImage')?.naturalWidth > 0);
    newWindow = instance.waitForEvent('window');
    await page.evaluate((id) => window.rack.openPreview(id), deleted.id);
    const preview = await newWindow;
    await preview.waitForFunction(() => document.querySelector('#previewImage')?.naturalWidth > 0);
    const floatingClosed = floating.waitForEvent('close');
    const previewClosed = preview.waitForEvent('close');
    await page.evaluate((id) => window.rack.showPhotoMenu(id), deleted.id);
    await waitForRuntime(instance, (value) => value.lastPhotoMenu?.id === deleted.id);
    await instance.evaluate(({ app }) => app.__rackTest.choosePhotoMenu('删除'));
    await waitForSnapshot(instance, (snapshot) => snapshot.photos.length === photos.length - 1 && !snapshot.photos.some((photo) => photo.id === deleted.id));
    await Promise.all([floatingClosed, previewClosed]);
    for (const directory of ['photos', 'thumbnails', 'exports']) {
      await assert.rejects(fs.stat(path.join(profile, directory, `${deleted.id}.png`)), { code: 'ENOENT' });
    }
    assert.deepEqual(await fs.readFile(externalCopy), expectedBytes);
    const index = JSON.parse(await fs.readFile(path.join(profile, 'index.json'), 'utf8'));
    assert(!index.photos.some((photo) => photo.id === deleted.id));
    for (const directory of ['photos', 'thumbnails']) {
      assert((await fs.stat(path.join(profile, directory, `${other.id}.png`))).size > 0);
    }
    const runtime = await instance.evaluate(({ app }) => app.__rackTest.runtime());
    assert.equal(runtime.floating.length, 1);
    assert.equal(runtime.floating[0].id, other.id);
    // 最新截图仍在隔离剪贴板里，删除后重采样不能将它立刻挂回来。
    await instance.evaluate(({ app }) => app.__rackTest.poll());
    assert.equal(await count(instance), photos.length - 1);
    await instance.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.webContents.getURL().endsWith('/preview.html')) window.close();
      }
    });
    await waitForRuntime(instance, (value) => value.floating.length === 0 && !value.autoHide.suspended);
    return { deletedId: deleted.id, remaining: photos.length - 1, externalCopy, deletedFiles: ['photos', 'thumbnails', 'exports'], clipboardDidNotRecapture: true };
  });
  await check('自动隐藏速度开启后悬停展开，快中慢分别为立即、1 秒、2 秒', async () => {
    const timings = [];
    for (const [speed, delayMs] of [['fast', 0], ['medium', 1000], ['slow', 2000]]) {
      await page.evaluate(() => window.rack.setAutoHide(false));
      assert.equal(await page.locator('#autoHideSpeedControl').isVisible(), false);
      const runtime = await instance.evaluate(({ app }) => app.__rackTest.runtime());
      const inside = { x: runtime.expandedBounds.x + 80, y: runtime.expandedBounds.y + 100 };
      const outside = { x: runtime.expandedBounds.x + runtime.expandedBounds.width + 20, y: runtime.expandedBounds.y + 300 };
      await instance.evaluate(({ app }, point) => app.__rackTest.setAutoHideCursor(point), inside);
      await page.evaluate(() => window.rack.setAutoHide(true));
      await page.locator('#autoHideButton').hover();
      await page.locator('#autoHideSpeedControl').waitFor({ state: 'visible' });
      await page.locator(`#autoHideSpeedControl [data-speed="${speed}"]`).click();
      await waitForSnapshot(instance, (snapshot) => snapshot.state.autoHideSpeed === speed);
      assert.equal(await page.locator(`#autoHideSpeedControl [data-speed="${speed}"]`).getAttribute('aria-pressed'), 'true');
      const timing = await instance.evaluate(({ app }, input) => {
        app.__rackTest.autoHideTick(input.inside);
        const immediate = app.__rackTest.autoHideTick(input.outside).collapsed;
        if (input.delayMs === 0) return { immediate };
        const before = app.__rackTest.autoHideTick(input.outside, input.delayMs - 1).collapsed;
        const due = app.__rackTest.autoHideTick(input.outside, 1).collapsed;
        return { immediate, before, due };
      }, { inside, outside, delayMs });
      if (delayMs === 0) assert.equal(timing.immediate, true);
      else assert.deepEqual(timing, { immediate: false, before: false, due: true });
      timings.push({ speed, delayMs, ...timing });
    }
    await page.evaluate(() => window.rack.setAutoHide(false));
    return { timings, default: 'medium' };
  });
  await check('自动隐藏开关与慢档离开 2 秒后收起', async () => {
    const runtime = await instance.evaluate(({ app }) => app.__rackTest.runtime());
    const outside = { x: runtime.bounds.x + runtime.bounds.width + 20, y: runtime.bounds.y + runtime.bounds.height + 20 };
    await instance.evaluate(({ app }, point) => app.__rackTest.setAutoHideCursor(point), outside);
    await instance.evaluate(({ app }) => app.__rackTest.persistPosition());
    await page.locator('#autoHideButton').click();
    await waitForSnapshot(instance, (snapshot) => snapshot.state.autoHide);
    assert.equal((await page.evaluate(() => window.rack.getSnapshot())).state.autoHide, true);
    const started = Date.now();
    await page.waitForTimeout(1750);
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.runtime())).autoHide.collapsed, false);
    await waitForSnapshot(instance, (snapshot) => snapshot.state.autoHidden, 1500);
    await page.waitForTimeout(150);
    const collapsed = await instance.evaluate(({ app }) => app.__rackTest.runtime());
    assert.equal(collapsed.bounds.y + collapsed.bounds.height, collapsed.displayBounds.y + 12);
    assert.deepEqual(collapsed.expandedBounds, runtime.expandedBounds);
    await instance.evaluate(({ app }) => app.__rackTest.persistPosition());
    const settings = JSON.parse(await fs.readFile(path.join(profile, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.bounds, runtime.expandedBounds);
    await page.locator('#autoHideTab').screenshot({ path: path.join(artifacts, 'auto-hide-tab.png'), omitBackground: true });
    return { hideLatencyMs: Date.now() - started, collapsedBounds: collapsed.bounds };
  });
  await check('鼠标移到顶部唤回原位置且不抢焦点', async () => {
    const runtime = await instance.evaluate(({ app }) => app.__rackTest.runtime());
    const focusBefore = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id || null);
    await instance.evaluate(({ app }, point) => app.__rackTest.autoHideTick(point), { x: runtime.expandedBounds.x + 80, y: runtime.displayBounds.y + 2 });
    await waitForSnapshot(instance, (snapshot) => !snapshot.state.autoHidden);
    const restored = await instance.evaluate(({ app }) => app.__rackTest.runtime());
    assert.deepEqual(restored.bounds, runtime.expandedBounds);
    const focusAfter = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id || null);
    assert.equal(focusAfter, focusBefore);
    await page.screenshot({ path: path.join(artifacts, 'auto-hide-expanded.png'), omitBackground: true });
  });
  await check('回到范围内取消隐藏倒计时', async () => {
    const runtime = await instance.evaluate(({ app }) => app.__rackTest.runtime());
    const inside = { x: runtime.expandedBounds.x + 80, y: runtime.expandedBounds.y + 100 };
    const outside = { x: runtime.expandedBounds.x + runtime.expandedBounds.width + 20, y: runtime.expandedBounds.y + 300 };
    await instance.evaluate(({ app }, point) => app.__rackTest.autoHideTick(point), inside);
    await instance.evaluate(({ app }, point) => app.__rackTest.autoHideTick(point), outside);
    await instance.evaluate(({ app }, point) => app.__rackTest.autoHideTick(point, 1800), outside);
    await instance.evaluate(({ app }, point) => app.__rackTest.autoHideTick(point), inside);
    await instance.evaluate(({ app }, point) => app.__rackTest.autoHideTick(point, 1000), outside);
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.runtime())).autoHide.collapsed, false);
    await page.evaluate(() => window.rack.setAutoHide(false));
  });
  await check('可见拖动把手实际移动窗口且拖动期间不自动收起', async () => {
    const before = await instance.evaluate(({ app }) => app.__rackTest.runtime());
    await page.evaluate(() => window.rack.setAutoHide(true));
    const handle = page.locator('#dragHandle');
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await waitForSnapshot(instance, (snapshot) => snapshot.state.dragging);
    await page.mouse.move(box.x + box.width / 2 + 55, box.y + box.height / 2 + 45, { steps: 1 });
    await page.waitForFunction(() => document.body.classList.contains('is-dragging'));
    await page.waitForTimeout(100);
    const movedRuntime = await instance.evaluate(({ app }) => app.__rackTest.runtime());
    assert(movedRuntime.bounds.x !== before.bounds.x || movedRuntime.bounds.y !== before.bounds.y, '拖动后原生窗口位置没有改变');
    await instance.evaluate(({ app }) => {
      const { expandedBounds } = app.__rackTest.runtime();
      app.__rackTest.autoHideTick({ x: expandedBounds.x + expandedBounds.width + 20, y: expandedBounds.y + expandedBounds.height + 20 }, 6000);
    });
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.runtime())).autoHide.collapsed, false);
    await page.mouse.up();
    await waitForSnapshot(instance, (snapshot) => !snapshot.state.dragging);
    await page.evaluate(() => window.rack.setAutoHide(false));
    await instance.evaluate(({ app }) => app.__rackTest.persistPosition());
    return { before: before.bounds, after: (await instance.evaluate(({ app }) => app.__rackTest.runtime())).bounds };
  });
  await check('普通图片未置顶或置顶、多图与悬浮均不阻止快中慢自动收起，关闭不展开或重置计时', async () => {
    const source = 'isolated main-process DIP cursor and controlled auto-hide clock; not physical mouse input';
    await page.evaluate(() => window.rack.setAutoHide(false));
    const photos = (await page.evaluate(() => window.rack.getSnapshot())).photos;
    const openImage = async id => {
      const pending = instance.waitForEvent('window');
      await page.evaluate(id => window.rack.openPreview(id), id);
      const preview = await pending;
      await imageWindowLayout(preview);
      return preview;
    };
    const closeImage = async preview => {
      const closed = preview.waitForEvent('close');
      await preview.evaluate(() => window.rack.closePreview()).catch(error => { if (!preview.isClosed()) throw error; });
      await closed;
    };
    const preview = await openImage(photos[0].id);
    const secondPreview = await openImage(photos[1].id);
    await page.evaluate(id => window.rack.showPhotoMenu(id), photos[0].id);
    await waitForRuntime(instance, value => value.lastPhotoMenu?.id === photos[0].id);
    const pendingFloating = instance.waitForEvent('window');
    await instance.evaluate(({ app }) => app.__rackTest.choosePhotoMenu('悬浮'));
    const floating = await pendingFloating;
    await imageWindowLayout(floating);
    const ready = await waitForRuntime(instance, value => value.imagePreviews.length === 2
      && value.floating.length === 1 && [...value.imagePreviews, ...value.floating].every(item => item.visible));
    assert.equal(ready.autoHide.suspended, false);
    const inside = { x: ready.expandedBounds.x + 80, y: ready.expandedBounds.y + 100 };
    const outside = { x: ready.expandedBounds.x + ready.expandedBounds.width + 20, y: ready.expandedBounds.y + 300 };
    const top = { x: ready.expandedBounds.x + 80, y: ready.displayBounds.y + 2 };
    const imageState = runtime => ({ imagePreviews: runtime.imagePreviews, floating: runtime.floating });
    const timings = [];
    let revealedNativeBounds;
    for (const pinned of [false, true]) {
      await preview.evaluate(value => window.rack.setPreviewAlwaysOnTop(value), pinned);
      for (const [speed, delayMs] of [['fast', 0], ['medium', 1000], ['slow', 2000]]) {
        await page.evaluate(() => window.rack.setAutoHide(false));
        await instance.evaluate(({ app }, point) => app.__rackTest.setAutoHideCursor(point), inside);
        await page.evaluate(speed => window.rack.setAutoHideSpeed(speed), speed);
        await page.evaluate(() => window.rack.setAutoHide(true));
        const before = await instance.evaluate(({ app }, point) => {
          app.__rackTest.autoHideTick(point, 3000);
          return app.__rackTest.runtime();
        }, inside);
        assert.equal(before.autoHide.collapsed, false, '鼠标在衣架范围内时，图片打开也不能使衣架收起');
        assert.equal(before.autoHide.suspended, false, '图片窗口的生命周期不能暂停自动隐藏');
        assert.equal(before.imagePreviews.find(item => item.id === photos[0].id).alwaysOnTop, pinned);
        assert.equal(before.imagePreviews.find(item => item.id === photos[1].id).alwaysOnTop, false);
        assert.equal(before.floating[0].alwaysOnTop, true);
        const timing = await instance.evaluate(({ app }, input) => {
          const immediate = app.__rackTest.autoHideTick(input.outside).collapsed;
          if (input.delayMs === 0) return { immediate };
          const beforeDue = app.__rackTest.autoHideTick(input.outside, input.delayMs - 1).collapsed;
          const due = app.__rackTest.autoHideTick(input.outside, 1).collapsed;
          return { immediate, beforeDue, due };
        }, { outside, delayMs });
        if (delayMs === 0) assert.deepEqual(timing, { immediate: true });
        else assert.deepEqual(timing, { immediate: false, beforeDue: false, due: true });
        const collapsed = await waitForRuntime(instance, value => value.autoHide.collapsed);
        assert.deepEqual(imageState(collapsed), imageState(before), '衣架收起不能隐藏、关闭、移位或取消任何图片置顶');
        const focusBefore = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null);
        await instance.evaluate(({ app }, point) => app.__rackTest.autoHideTick(point), top);
        const expanded = await waitForRuntime(instance, value => !value.autoHide.collapsed);
        assert.deepEqual(expanded.expandedBounds, ready.expandedBounds, '恢复后的逻辑位置和请求尺寸保持不变');
        for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(expanded.bounds[key] - ready.expandedBounds[key]) <= 1,
          `恢复位置仅允许原生 DIP 取整：${JSON.stringify({expected:ready.expandedBounds,actual:expanded.bounds})}`);
        if (revealedNativeBounds) assert.deepEqual(expanded.bounds, revealedNativeBounds, '反复收起和展开不能累积改变原生尺寸');
        else revealedNativeBounds = expanded.bounds;
        assert.deepEqual(imageState(expanded), imageState(before), '顶部唤回衣架必须保持图片窗口状态');
        assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null), focusBefore);
        await instance.evaluate(({ app }, point) => app.__rackTest.autoHideTick(point), inside);
        timings.push({ pinned, speed, delayMs, ...timing, collapsedImageWindows: imageState(collapsed), topRevealKeptImages: true });
      }
    }
    await instance.evaluate(({ app }, point) => {
      app.__rackTest.autoHideTick(point);
      app.__rackTest.autoHideTick(point, 2000);
    }, outside);
    await waitForSnapshot(instance, value => value.state.autoHidden);
    await preview.screenshot({ path: path.join(artifacts, 'auto-hide-with-pinned-preview.png') });
    await page.locator('#autoHideTab').screenshot({ path: path.join(artifacts, 'auto-hide-with-preview-tab.png'), omitBackground: true });

    // 收起后仍可独立缩放与置顶图片，关闭部分窗口也不会唤回衣架。
    const previousScale = (await preview.evaluate(() => window.rack.getPreview())).state.scale;
    await preview.evaluate(scale => window.rack.resizePreview({ scale }), previousScale * .9);
    const resized = (await imageWindowLayout(preview)).state;
    assert(resized.scale < previousScale);
    await preview.evaluate(() => window.rack.setPreviewAlwaysOnTop(false));
    assert.equal((await preview.evaluate(() => window.rack.getPreview())).state.alwaysOnTop, false);
    await preview.evaluate(() => window.rack.setPreviewAlwaysOnTop(true));
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.runtime())).autoHide.collapsed, true);
    await closeImage(secondPreview);
    const afterClose = await waitForRuntime(instance, value => value.imagePreviews.length === 1);
    assert.equal(afterClose.autoHide.collapsed, true);
    assert.equal(afterClose.imagePreviews[0].visible, true); assert.equal(afterClose.imagePreviews[0].alwaysOnTop, true);
    assert.deepEqual(afterClose.imagePreviews[0].bounds, resized.bounds);
    await closeImage(floating);
    const afterFloatingClose = await waitForRuntime(instance, value => value.floating.length === 0);
    assert.equal(afterFloatingClose.autoHide.collapsed, true);
    await closeImage(preview);
    const afterAllClosed = await waitForRuntime(instance, value => value.imagePreviews.length === 0);
    assert.equal(afterAllClosed.autoHide.collapsed, true, '关闭最后一张图片不能展开已经收起的衣架');

    const closeWhileCounting = [];
    for (const [speed, delayMs] of [['medium', 1000], ['slow', 2000]]) {
      await page.evaluate(() => window.rack.setAutoHide(false));
      await instance.evaluate(({ app }, point) => app.__rackTest.setAutoHideCursor(point), inside);
      const closingPreview = await openImage(photos[0].id);
      await page.evaluate(speed => window.rack.setAutoHideSpeed(speed), speed);
      await page.evaluate(() => window.rack.setAutoHide(true));
      await instance.evaluate(({ app }, point) => {
        app.__rackTest.autoHideTick(point);
        app.__rackTest.autoHideTick(point, 400);
      }, outside);
      await closeImage(closingPreview);
      const timing = await instance.evaluate(({ app }, input) => {
        const closedAt400Ms = app.__rackTest.runtime().autoHide.collapsed;
        const beforeDue = app.__rackTest.autoHideTick(input.outside, input.delayMs - 401).collapsed;
        const due = app.__rackTest.autoHideTick(input.outside, 1).collapsed;
        return { closedAt400Ms, beforeDue, due };
      }, { outside, delayMs });
      assert.deepEqual(timing, { closedAt400Ms: false, beforeDue: false, due: true }, '关闭预览不能重置已经开始的离开计时');
      closeWhileCounting.push({ speed, delayMs, ...timing });
    }
    await page.evaluate(() => window.rack.setAutoHide(false));
    return { source, timings, closeWhileCounting, collapsedResize: resized, pinWhileCollapsed: true,
      closeWhileCollapsedDidNotExpand: true, mouseInsideRetained: true, independentImages: '2 ordinary previews and 1 floating image' };
  });
  await check('手动托盘隐藏不会被顶部唤回，恢复后关闭自动隐藏立即展开', async () => {
    await page.evaluate(() => window.rack.setAutoHide(true));
    await page.evaluate(() => window.rack.hide());
    await instance.evaluate(({ app }) => {
      const { expandedBounds, displayBounds } = app.__rackTest.runtime();
      app.__rackTest.autoHideTick({ x: expandedBounds.x + 50, y: displayBounds.y + 1 }, 5000);
    });
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.runtime())).visible, false);
    await instance.evaluate(({ app }) => app.__rackTest.restore());
    await instance.evaluate(({ app }) => {
      const { expandedBounds } = app.__rackTest.runtime();
      const outside = { x: expandedBounds.x + expandedBounds.width + 20, y: expandedBounds.y + 300 };
      app.__rackTest.autoHideTick(outside);
      app.__rackTest.autoHideTick(outside, 3000);
    });
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.runtime())).autoHide.collapsed, true);
    await page.evaluate(() => window.rack.setAutoHide(false));
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.runtime())).autoHide.collapsed, false);
  });
  await check('交互区域命中与透明空白穿透开关', async () => {
    const control = page.locator('#pauseButton');
    await control.hover();
    await page.waitForTimeout(100);
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.runtime())).ignoringMouseEvents, false);
    await page.mouse.move(2, 258);
    await page.waitForTimeout(100);
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.runtime())).ignoringMouseEvents, true);
  });
  await check('置顶、隐藏及托盘恢复流程', async () => {
    await page.evaluate(() => window.rack.setAlwaysOnTop(true));
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.runtime())).alwaysOnTop, true);
    await page.evaluate(() => window.rack.hide());
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.runtime())).visible, false);
    await instance.evaluate(({ app }) => app.__rackTest.restore());
    assert.equal((await instance.evaluate(({ app }) => app.__rackTest.runtime())).visible, true);
  });
  await check('收起或托盘隐藏释放缩略图，恢复后保留浏览位置且图片能再次打开', async () => {
    const runtime = await instance.evaluate(({ app }) => app.__rackTest.runtime());
    const inside = { x: runtime.expandedBounds.x + 80, y: runtime.expandedBounds.y + 100 };
    const outside = { x: runtime.expandedBounds.x + runtime.expandedBounds.width + 30, y: runtime.expandedBounds.y + 300 };
    await instance.evaluate(({ app }, point) => app.__rackTest.setAutoHideCursor(point), inside);
    await page.evaluate(() => { document.getElementById('photoScroll').scrollLeft = 260; });
    await page.waitForFunction(() => document.getElementById('photoScroll').scrollLeft > 200);
    const position = await page.evaluate(() => document.getElementById('photoScroll').scrollLeft);
    await page.evaluate(() => window.rack.setAutoHideSpeed('fast'));
    await page.evaluate(() => window.rack.setAutoHide(true));
    await instance.evaluate(({ app }, point) => app.__rackTest.autoHideTick(point), outside);
    await waitForSnapshot(instance, (snapshot) => snapshot.state.autoHidden);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="photo-card"]').length === 0);
    await instance.evaluate(({ app }, point) => app.__rackTest.autoHideTick(point), { x: inside.x, y: runtime.displayBounds.y + 2 });
    await waitForSnapshot(instance, (snapshot) => !snapshot.state.autoHidden);
    await page.waitForFunction((expected) => Math.abs(document.getElementById('photoScroll').scrollLeft - expected) < 2 && [...document.querySelectorAll('.photo-card img')].some(image => image.complete && image.naturalWidth > 0), position);
    await page.evaluate(() => window.rack.setAutoHide(false));
    await page.evaluate(() => window.rack.hide());
    await waitForSnapshot(instance, (snapshot) => snapshot.state.manuallyHidden);
    await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 0);
    await instance.evaluate(({ app }) => app.__rackTest.restore());
    await waitForSnapshot(instance, (snapshot) => !snapshot.state.manuallyHidden);
    await page.waitForFunction((expected) => Math.abs(document.getElementById('photoScroll').scrollLeft - expected) < 2 && [...document.querySelectorAll('.photo-card img')].some(image => image.complete && image.naturalWidth > 0), position);
    const photo = await page.locator('.photo-card').first().getAttribute('data-photo-id');
    const opened = instance.waitForEvent('window');
    await page.evaluate((id) => window.rack.openPreview(id), photo);
    const preview = await opened;
    await preview.waitForFunction(() => document.getElementById('previewImage')?.naturalWidth > 0);
    const closed = preview.waitForEvent('close');
    await preview.evaluate(() => window.rack.closePreview()).catch(error => { if (!preview.isClosed()) throw error; });
    await closed;
    await page.evaluate(() => window.rack.setAutoHideSpeed('slow'));
    await page.evaluate(() => { document.getElementById('photoScroll').scrollLeft = 0; });
    return { restoredScrollLeft: position, releasedCards: true };
  });
  await check('悬停时实际注册 Ctrl+V，移出、隐藏和收起释放，浏览器入口已取消', async () => {
    const api = await page.evaluate(() => ({ paste: typeof window.rack.pasteClipboard, browser: typeof window.rack.openBrowserConnection }));
    assert.deepEqual(api, { paste: 'function', browser: 'undefined' });
    assert.equal(await page.locator('#browserButton').count(), 0);
    const registered = await instance.evaluate(({ app, globalShortcut }) => {
      const bounds = app.__rackTest.runtime().bounds;
      app.__rackTest.hoverPaste({ x: bounds.x + 80, y: bounds.y + 30 });
      return globalShortcut.isRegistered('Control+V');
    });
    assert.equal(registered, true);
    await instance.evaluate(({ app }) => { const bounds=app.__rackTest.runtime().bounds; app.__rackTest.hoverPaste({x:bounds.x-1,y:bounds.y+30}); });
    assert.equal(await instance.evaluate(({ globalShortcut })=>globalShortcut.isRegistered('Control+V')),false);
    await instance.evaluate(({ app }) => { const bounds=app.__rackTest.runtime().bounds; app.__rackTest.hoverPaste({x:bounds.x+80,y:bounds.y+30}); });
    await page.evaluate(()=>window.rack.hide());
    assert.equal(await instance.evaluate(({ globalShortcut })=>globalShortcut.isRegistered('Control+V')),false);
    await instance.evaluate(({ app })=>app.__rackTest.restore());
    await page.evaluate(()=>window.rack.setAutoHide(true));
    await instance.evaluate(({ app })=>{const b=app.__rackTest.runtime().bounds;app.__rackTest.hoverPaste({x:b.x+80,y:b.y+30});const outside={x:b.x+b.width+20,y:b.y+300};app.__rackTest.autoHideTick(outside);app.__rackTest.autoHideTick(outside,3000);});
    assert.equal(await instance.evaluate(({ globalShortcut })=>globalShortcut.isRegistered('Control+V')),false);
    await page.evaluate(()=>window.rack.setAutoHide(false));
    await instance.evaluate(({ app })=>app.__rackTest.hoverPaste({x:-99999,y:-99999},false));
  });
  await check('暂停时悬停粘贴完整图片，重复不新增、不抢焦点，恢复收集不重复', async () => {
    await page.evaluate(()=>window.rack.setPaused(true));
    const original = await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=2048;canvas.height=1365;const c=canvas.getContext('2d');c.fillStyle='#526f84';c.fillRect(0,0,2048,1365);c.fillStyle='#fff';c.font='64px Microsoft YaHei';c.fillText('复制图片 → Ctrl+V',120,180);return canvas.toDataURL('image/png');});
    const before=await count(instance);
    await instance.evaluate(({ app },value)=>{app.__rackTest.setClipboardImage(value);const b=app.__rackTest.runtime().bounds;app.__rackTest.hoverPaste({x:b.x+90,y:b.y+35});},original);
    const focus=await instance.evaluate(({ BrowserWindow })=>BrowserWindow.getFocusedWindow()?.id||null);
    assert.equal(await instance.evaluate(({ app })=>app.__rackTest.triggerPaste()),true);
    assert.equal(await count(instance),before+1);
    const snapshot=await page.evaluate(()=>window.rack.getSnapshot());assert.equal(snapshot.state.paused,true);
    const photo=snapshot.photos[0];assert.equal(photo.width,2048);assert.equal(photo.height,1365);assert.equal(photo.format,'png');
    const stored=await fs.readFile(path.join(profile,'photos',photo.id+'.png'));
    assert.equal(stored.readUInt32BE(16),2048);assert.equal(stored.readUInt32BE(20),1365);
    await page.evaluate(id=>window.rack.preparePhotoDrag(id),photo.id);
    assert.deepEqual(await fs.readFile(path.join(profile,'exports',photo.id+'.png')),stored);
    await instance.evaluate(({ app })=>app.__rackTest.triggerPaste());assert.equal(await count(instance),before+1);
    assert.equal(await instance.evaluate(({ BrowserWindow })=>BrowserWindow.getFocusedWindow()?.id||null),focus);
    const opened=instance.waitForEvent('window');await page.evaluate(id=>window.rack.openPreview(id),photo.id);const preview=await opened;
    await preview.waitForFunction(()=>document.getElementById('previewImage')?.naturalWidth===2048);
    assert.equal(await preview.locator('#previewImage').evaluate(image=>image.naturalHeight),1365);
    assert.equal(await preview.evaluate(()=>window.rack.pasteClipboard().then(()=>false,()=>true)),true);
    const closed=preview.waitForEvent('close');await preview.evaluate(()=>window.rack.closePreview()).catch(e=>{if(!preview.isClosed())throw e;});await closed;
    await page.evaluate(()=>window.rack.setPaused(false));await instance.evaluate(({ app })=>app.__rackTest.poll());assert.equal(await count(instance),before+1);
    await instance.evaluate(({ app })=>app.__rackTest.hoverPaste({x:-99999,y:-99999},false));
    return {width:photo.width,height:photo.height,originalExport:true,focusRetained:true,pausedManual:true};
  });
  await check('粘贴按钮与窗口Ctrl+V可用，纯文字和无效图片提示且不新增',async()=>{
    await page.evaluate(()=>window.rack.setPaused(true));const before=await count(instance);
    await instance.evaluate(({app})=>app.__rackTest.setClipboardImage(null));await page.locator('#pasteButton').click();
    await waitForSnapshot(instance,s=>s.status.message.includes('剪贴板里没有图片'));assert.equal(await count(instance),before);
    await instance.evaluate(({app})=>app.__rackTest.setClipboardImage('data:image/png;base64,bm90LWFuLWltYWdl'));
    await page.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'v',code:'KeyV',ctrlKey:true,bubbles:true,cancelable:true})));
    await waitForSnapshot(instance,s=>s.status.message.includes('剪贴板里没有图片'));assert.equal(await count(instance),before);
    await page.evaluate(()=>window.rack.setPaused(false));
  });
  const savedPhotos = (await page.evaluate(() => window.rack.getSnapshot())).photos;
  const moved = await instance.evaluate(async ({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const bounds = window.getBounds(); window.setPosition(bounds.x + 20, bounds.y + 50);
    await app.__rackTest.persistPosition();
    return app.__rackTest.runtime().expandedBounds;
  });
  await page.evaluate(() => window.rack.setAutoHide(true));
  await instance.evaluate(({ app }) => {
    const { expandedBounds } = app.__rackTest.runtime();
    const outside = { x: expandedBounds.x + expandedBounds.width + 20, y: expandedBounds.y + 300 };
    app.__rackTest.autoHideTick(outside);
    app.__rackTest.autoHideTick(outside, 3000);
  });
  await instance.close(); application = null;
  ({ instance, page } = await launch()); application = instance;
  await check('收起状态退出后照片、置顶、自动隐藏速度和展开位置恢复', async () => {
    const restored = await page.evaluate(() => window.rack.getSnapshot());
    assert.deepEqual(restored.photos, savedPhotos); assert.equal(restored.state.alwaysOnTop, true);
    assert.equal(restored.state.autoHide, true);
    assert.equal(restored.state.autoHideSpeed, 'slow');
    const runtime = await instance.evaluate(({ app }) => app.__rackTest.runtime());
    assert.equal(runtime.bounds.x, moved.x); assert.equal(runtime.bounds.y, moved.y);
    const names = await fs.readdir(path.join(profile, 'photos'));
    assert.equal(names.length, savedPhotos.length);
    await page.evaluate(() => window.rack.setAutoHide(false));
    return { photos: restored.photos.length, bounds: runtime.bounds };
  });
  assert.deepEqual(pageErrors, []);
  await instance.close(); application = null;

  for (const scale of [1, 1.25, 1.5]) {
    await check(`${scale * 100}% 显示缩放下宽度为所在屏幕40%`, async () => {
      ({ instance, page } = await launch(profile, [`--force-device-scale-factor=${scale}`])); application = instance;
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="photo-card"] img')].some((image) => image.complete && image.naturalWidth > 0));
      // Windows 强制缩放启动后可能继续发原生尺寸消息，等待位置/尺寸归一化完成。
      await page.waitForTimeout(700);
      const layout = await page.evaluate(() => ({ scale: devicePixelRatio, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollHeight > innerHeight }));
      // Windows 的实际系统 DPI 与强制的 Chromium 比例不同时，客户区有少量 DIP 取整差异。
      const measured = await instance.evaluate(({ app }) => app.__rackTest.physicalWindow());
      const area = await instance.evaluate(({ app }) => app.__rackTest.workArea());
      const expectedLogicalWidth = Math.max(1, Math.floor(Math.min(measured.displayBounds.width * 0.4, area.width - 24)));
      const expectedPixelWidth = Math.round(expectedLogicalWidth * measured.scaleFactor);
      const nativeBounds = measured.bounds;
      assert(Math.abs(layout.width - nativeBounds.width) <= 8, `缩放后的宽度异常：${layout.width}`);
      assert(Math.abs(layout.height - 260) <= 8, `缩放后的高度异常：${layout.height}`);
      assert.equal(layout.overflow, false);
      const screenshot = await page.screenshot({ path: path.join(artifacts, `rack-scale-${scale}.png`), omitBackground: true });
      const screenshotWidth = screenshot.readUInt32BE(16);
      // DIP边界反算到屏幕坐标会向外取整；用户看到的PNG宽度单独严格检查。
      const pixelTolerance = 8;
      assert(Math.abs(measured.physicalBounds.width - expectedPixelWidth) <= pixelTolerance, `原生窗口实际宽度异常：${measured.physicalBounds.width}`);
      assert(Math.abs(screenshotWidth - expectedPixelWidth) <= 1, `截图实际宽度异常：${screenshotWidth}，预期${expectedPixelWidth}`);
      const photo = (await page.evaluate(() => window.rack.getSnapshot())).photos[0];
      const opened = instance.waitForEvent('window');
      await page.evaluate(id => window.rack.openPreview(id), photo.id);
      const preview = await opened;
      await imageWindowLayout(preview);
      const initial = (await preview.evaluate(() => window.rack.getPreview())).state;
      const imageState = await preview.evaluate(scale => window.rack.resizePreview({ scale }), initial.scale * 1.2);
      await preview.waitForFunction(async () => {
        const state = (await window.rack.getPreview()).state;
        return Math.abs(document.getElementById('imageWorld').getBoundingClientRect().width
          - state.image.width * innerWidth / state.bounds.width) < 2;
      });
      const imageLayout = await imageWindowLayout(preview);
      assert(imageState.bounds.width > initial.bounds.width && imageState.image.width > initial.image.width);
      assert(imageState.drawnSize.area <= 16000000 && Math.max(imageState.drawnSize.width, imageState.drawnSize.height) <= 8192);
      await preview.evaluate(() => window.rack.setPreviewAlwaysOnTop(true));
      await preview.waitForFunction(() => document.getElementById('previewPinButton').getAttribute('aria-pressed') === 'true');
      const imageScreenshot = await preview.screenshot({ path: path.join(artifacts, `photo-scale-${scale}.png`) });
      const imagePixels = await preview.evaluate(() => ({ width: innerWidth, scale: devicePixelRatio }));
      assert(Math.abs(imageScreenshot.readUInt32BE(16) - Math.round(imagePixels.width * imagePixels.scale)) <= 1);
      const imageNative = await instance.browserWindow(preview);
      assert.equal(await imageNative.evaluate(window => window.isAlwaysOnTop()), true);
      await instance.close(); application = null;
      return { ...layout, ...measured, screenshotWidth, expectedPixelWidth, workArea: area, systemScale, pixelTolerance,
        imageState, imageViewport: imageLayout.viewport, imageScreenshotWidth: imageScreenshot.readUInt32BE(16),
        note: '衣架40%宽度及图片窗口同步缩放、细边框、独立置顶均检查；DIP边界反算允许8像素取整差异，强制比例测试未改系统设置。' };
    });
  }
}

run().then(() => { completed = true; }).catch((error) => { console.error(error); console.error(mainDiagnostics.join('').slice(-8000)); process.exitCode = 1; }).finally(async () => {
  if (application) await application.close().catch(() => {});
  if (originalCursor) await nativeCursor([originalCursor]).catch(error => console.error('恢复鼠标位置失败', error.message));
  verification.passed = completed && verification.tests.length > 0 && verification.tests.every((item) => item.passed);
  await fs.mkdir(artifacts, { recursive: true });
  const name = process.env.RACK_EXE ? 'packaged-verification.json' : 'verification.json';
  await fs.writeFile(path.join(artifacts, name), JSON.stringify(verification, null, 2));
  console.log(`验证记录：${path.join(artifacts, name)}`);
});
