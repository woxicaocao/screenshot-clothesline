'use strict';

// 一次性 Windows 验收：真实鼠标只移动，不按任何鼠标键；50 ms 生产轮询使用真实时钟。
// 剪贴板为隔离 PNG mock，日常剪贴板和用户 profile 均不读写。
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { nativeCursor } = require('./native-photo-drag.cjs');

const root = path.resolve(__dirname, '..');
const mode = process.env.RACK_EXE ? 'packaged' : 'development';
const artifacts = path.join(root, 'test-artifacts', 'v0.8.6', `auto-hide-realtime-${mode}`);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const profile = path.join(artifacts, 'profiles', runId);
const verification = {
  date: new Date().toISOString(), version: '0.8.6', mode, profile,
  source: 'Windows user32 SetCursorPos/GetCursorPos; real Electron screen cursor; production 50 ms auto-hide interval and real Date.now',
  clipboard: 'isolated mock PNG; daily clipboard unchanged',
  mouseButtons: 'none', keyboardInput: 'none', cursorOverride: 'cleared; no simulated auto-hide ticks',
  tests: [], cursorMovements: [], screenshots: [],
  manualChecks: ['微信真实截图与拖放', '跨不同 DPI 的真实多显示器', 'Windows 125%/150% 系统设置'],
};
const pageErrors = [];
let application, rack, preview, originalCursor;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const offsetFrom = (actual, requested) => ({ x: actual.x - requested.x, y: actual.y - requested.y });
const isSamePoint = offset => Math.abs(offset.x) <= 1 && Math.abs(offset.y) <= 1;

async function waitRuntime(predicate, description, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  do {
    latest = await application.evaluate(({ app }) => app.__rackTest.runtime());
    if (predicate(latest)) return latest;
    await sleep(20);
  } while (Date.now() < deadline);
  throw new Error(`${description}超时：${JSON.stringify(latest)}`);
}

async function physicalPoint(dip) {
  const point = await application.evaluate(({ screen }, value) => screen.dipToScreenPoint(value), dip);
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

function checkCursorMovement(label, requested, result) {
  const offset = offsetFrom(result.actual, requested);
  const record = { label, requestedPhysical: requested, actualPhysical: result.actual, offset,
    previousPhysical: result.original, source: 'Windows user32 GetCursorPos; no mouse button input' };
  verification.cursorMovements.push(record);
  assert(isSamePoint(offset), `真实鼠标没有到达请求位置，已中止：${JSON.stringify(record)}`);
  return record;
}

async function moveCursor(label, dip) {
  const requested = await physicalPoint(dip);
  const result = await nativeCursor([requested]);
  return checkCursorMovement(label, requested, result);
}

// 观察在原生输入启动前注册。耗时从主进程首次看见实际 OS 鼠标到达目标开始，
// 因此不把 PowerShell 启动或 Add-Type 编译耗时计入自动隐藏延迟。
async function moveAndObserve(label, dip, collapsed, delayMs = 0) {
  const requested = await physicalPoint(dip);
  const observer = application.evaluate(({ app, BrowserWindow, screen }, input) => new Promise((resolve, reject) => {
    let firstCursorAt = null, firstCursor = null;
    const started = Date.now();
    const interval = setInterval(() => {
      try {
        const now = Date.now();
        const cursorDIP = screen.getCursorScreenPoint();
        const cursorPhysical = screen.dipToScreenPoint(cursorDIP);
        const reached = Math.abs(cursorPhysical.x - input.requested.x) <= 1
          && Math.abs(cursorPhysical.y - input.requested.y) <= 1;
        const runtime = app.__rackTest.runtime();
        if (firstCursorAt === null && reached) {
          firstCursorAt = now;
          firstCursor = { dip: cursorDIP, physical: cursorPhysical };
        }
        if (firstCursorAt !== null && !reached) {
          clearInterval(interval);
          reject(new Error(`观察期间真实鼠标离开目标，已中止：${JSON.stringify({ requested: input.requested, actual: cursorPhysical })}`));
          return;
        }
        if (firstCursorAt !== null && runtime.autoHide.collapsed === input.collapsed) {
          clearInterval(interval);
          resolve({ targetCollapsed: input.collapsed, firstCursor, firstCursorAt, transitionAt: now,
            elapsedMs: now - firstCursorAt, observerIntervalMs: 10, runtime,
            focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null });
          return;
        }
        if (now - started > input.timeoutMs) {
          clearInterval(interval);
          reject(new Error(`真实时钟自动隐藏状态未改变：${JSON.stringify({ targetCollapsed: input.collapsed, firstCursor, runtime })}`));
        }
      } catch (error) { clearInterval(interval); reject(error); }
    }, 10);
  }), { requested, collapsed, timeoutMs: 15000 + delayMs + 2000 });
  const [movementResult, observed] = await Promise.all([nativeCursor([requested]), observer]);
  const movement = checkCursorMovement(label, requested, movementResult);
  const observedOffset = offsetFrom(observed.firstCursor.physical, requested);
  assert(isSamePoint(observedOffset), `Electron 实际屏幕鼠标偏离请求位置：${JSON.stringify({ movement, observed })}`);
  if (collapsed) {
    // 原生指针先到达，测试观察最多晚一个生产轮询和若干调度帧；不能提前整档收起。
    assert(observed.elapsedMs >= Math.max(0, delayMs - 150),
      `自动隐藏早于档位等待时间：${JSON.stringify({ delayMs, observed })}`);
    assert(observed.elapsedMs <= delayMs + 750,
      `自动隐藏超过允许的调度余量：${JSON.stringify({ delayMs, observed })}`);
  } else assert(observed.elapsedMs <= 750, `移到顶部后衣架未及时恢复：${JSON.stringify(observed)}`);
  return { movement, observed };
}

async function holdInside(requestedPhysical, durationMs = 300) {
  const result = await application.evaluate(({ app, screen }, input) => new Promise((resolve, reject) => {
    const started = Date.now();
    let samples = 0;
    const interval = setInterval(() => {
      try {
        const cursor = screen.dipToScreenPoint(screen.getCursorScreenPoint());
        const state = app.__rackTest.runtime().autoHide;
        if (Math.abs(cursor.x - input.point.x) > 1 || Math.abs(cursor.y - input.point.y) > 1) {
          clearInterval(interval);
          reject(new Error(`范围内等待时真实鼠标偏离，已中止：${JSON.stringify({ requested: input.point, actual: cursor })}`));
          return;
        }
        if (state.collapsed || state.suspended) {
          clearInterval(interval);
          reject(new Error(`图片打开时范围内状态异常：${JSON.stringify(state)}`));
          return;
        }
        samples++;
        if (Date.now() - started >= input.durationMs) {
          clearInterval(interval);
          resolve({ durationMs: Date.now() - started, samples, finalActualPhysical: cursor, state });
        }
      } catch (error) { clearInterval(interval); reject(error); }
    }, 15);
  }), { point: requestedPhysical, durationMs });
  assert(result.durationMs >= durationMs);
  return result;
}

async function run() {
  await fs.mkdir(artifacts, { recursive: true });
  originalCursor = (await nativeCursor()).original;
  const env = { ...process.env, RACK_TEST_MODE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.RACK_EXE || require('electron'),
    args: [...(process.env.RACK_EXE ? [] : [root]), '--rack-test', `--data-dir=${profile}`],
    env, cwd: root, timeout: 60000 });
  application.on('window', page => page.on('pageerror', error => pageErrors.push({ url: page.url(), error: error.message })));
  rack = await application.firstWindow();
  rack.on('pageerror', error => pageErrors.push({ url: rack.url(), error: error.message }));
  await rack.waitForLoadState('domcontentloaded');
  await rack.waitForFunction(() => !!window.rack);
  await rack.evaluate(() => window.rack.setAutoHide(false));
  await application.evaluate(({ app }) => app.__rackTest.setAutoHideCursor(null));
  const fixture = await rack.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 460;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e1ead7'; ctx.fillRect(0, 0, 720, 460);
    ctx.fillStyle = '#799184'; ctx.beginPath(); ctx.arc(550, 122, 76, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#40574d'; ctx.font = '40px Microsoft YaHei'; ctx.fillText('参考图片，独立置顶', 48, 280);
    ctx.font = '22px Microsoft YaHei'; ctx.fillText('晾衣架自动收起，图片继续可见', 48, 330);
    return canvas.toDataURL('image/png');
  });
  await application.evaluate(async ({ app }, image) => { app.__rackTest.setClipboardImage(image); await app.__rackTest.poll(); }, fixture);
  await rack.evaluate(() => window.rack.setPaused(true));
  const photo = (await rack.evaluate(() => window.rack.getSnapshot())).photos[0];
  assert(photo, '隔离 PNG 必须成功保存');
  const newWindow = application.waitForEvent('window');
  await rack.evaluate(id => window.rack.openPreview(id), photo.id);
  preview = await newWindow;
  await preview.waitForFunction(() => document.querySelector('#previewImage')?.naturalWidth > 0);
  await preview.evaluate(() => window.rack.setPreviewAlwaysOnTop(true));
  await preview.waitForFunction(() => document.getElementById('previewPinButton').getAttribute('aria-pressed') === 'true');
  const native = await application.browserWindow(preview);
  await native.evaluate(window => { window.show(); window.focus(); });
  await preview.waitForFunction(() => document.hasFocus());
  const initial = await waitRuntime(value => value.imagePreviews.length === 1 && value.imagePreviews[0].visible
    && value.imagePreviews[0].alwaysOnTop && !value.autoHide.suspended, '置顶普通图片准备');
  const display = initial.displayBounds, bounds = initial.expandedBounds;
  const inside = { x: bounds.x + Math.min(80, Math.floor(bounds.width / 2)), y: bounds.y + Math.min(100, Math.floor(bounds.height / 2)) };
  const withinDisplay = point => point.x >= display.x + 2 && point.x < display.x + display.width - 2
    && point.y >= display.y + 2 && point.y < display.y + display.height - 2;
  const outsideRack = point => point.x < bounds.x || point.x >= bounds.x + bounds.width
    || point.y < bounds.y || point.y >= bounds.y + bounds.height;
  const outside = [
    { x: inside.x, y: bounds.y + bounds.height + 60 },
    { x: bounds.x + bounds.width + 60, y: inside.y },
    { x: bounds.x - 60, y: inside.y }
  ].find(point => withinDisplay(point) && outsideRack(point));
  assert(withinDisplay(inside), `衣架范围内测试点必须位于实际显示器：${JSON.stringify({ inside, bounds, display })}`);
  assert(outside, `无法找到显示器内且衣架外的真实鼠标测试点：${JSON.stringify({ bounds, display })}`);
  const top = { x: inside.x, y: display.y + 2 };
  verification.geometry = { display, expandedBounds: bounds, insideDIP: inside, outsideDIP: outside, topDIP: top };
  const imageSnapshot = runtime => runtime.imagePreviews;
  for (const [speed, delayMs] of [['fast', 0], ['medium', 1000], ['slow', 2000]]) {
    const started = Date.now();
    await rack.evaluate(() => window.rack.setAutoHide(false));
    await application.evaluate(({ app }) => app.__rackTest.setAutoHideCursor(null));
    const insideMovement = await moveCursor(`${speed}: inside rack`, inside);
    await rack.evaluate(speed => window.rack.setAutoHideSpeed(speed), speed);
    await rack.evaluate(() => window.rack.setAutoHide(true));
    const held = await holdInside(insideMovement.requestedPhysical, 300);
    const before = await application.evaluate(({ app, BrowserWindow }) => ({ runtime: app.__rackTest.runtime(),
      focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null }));
    const collapse = await moveAndObserve(`${speed}: leave rack`, outside, true, delayMs);
    assert.equal(collapse.observed.runtime.autoHide.suspended, false);
    assert.deepEqual(imageSnapshot(collapse.observed.runtime), imageSnapshot(before.runtime),
      '真实鼠标离开后收起衣架必须保持普通图片的可见、置顶和原窗口位置');
    assert.equal(collapse.observed.focusedWindowId, before.focusedWindowId, '收起衣架不能抢走图片焦点');
    await rack.waitForFunction(() => document.body.classList.contains('is-auto-hidden'));
    const previewShot = `auto-hide-${speed}-pinned-preview.png`, tabShot = `auto-hide-${speed}-tab.png`;
    await preview.screenshot({ path: path.join(artifacts, previewShot) });
    await rack.locator('#autoHideTab').screenshot({ path: path.join(artifacts, tabShot), omitBackground: true });
    verification.screenshots.push(previewShot, tabShot);
    const reveal = await moveAndObserve(`${speed}: top reveal`, top, false);
    assert.deepEqual(reveal.observed.runtime.bounds, bounds);
    assert.deepEqual(imageSnapshot(reveal.observed.runtime), imageSnapshot(before.runtime), '顶部恢复衣架必须保持图片状态');
    assert.equal(reveal.observed.focusedWindowId, before.focusedWindowId, '顶部恢复衣架不能抢焦点');
    const returned = await moveCursor(`${speed}: return into rack`, inside);
    await holdInside(returned.requestedPhysical, 300);
    assert.equal(preview.isClosed(), false);
    verification.tests.push({ name: `${speed} 档真实鼠标离开、自动收起与顶部恢复`, passed: true,
      durationMs: Date.now() - started, speed, configuredDelayMs: delayMs,
      collapseDetectionMs: collapse.observed.elapsedMs, topRevealDetectionMs: reveal.observed.elapsedMs,
      heldInside: held, collapse, reveal, picturesRetained: true, focusedWindowRetained: true });
    console.log(`通过：${speed} 档，离开检测后 ${collapse.observed.elapsedMs} ms 收起，顶部检测后 ${reveal.observed.elapsedMs} ms 恢复`);
  }
  assert.equal(verification.tests.length, 3);
  assert.deepEqual(pageErrors, []);
}

(async () => {
  let failure;
  try { await run(); }
  catch (error) { failure = error; }
  finally {
    if (application) {
      if (rack && !rack.isClosed()) await rack.evaluate(() => window.rack.setAutoHide(false)).catch(error => {
        if (!failure) failure = new Error(`清理自动隐藏状态失败：${error.message}`);
      });
      await application.close().catch(error => { if (!failure) failure = new Error(`关闭隔离验收程序失败：${error.message}`); });
    }
    if (originalCursor) {
      try {
        const restored = await nativeCursor([originalCursor]);
        const offset = offsetFrom(restored.actual, originalCursor);
        verification.cursorRestored = { requested: originalCursor, actual: restored.actual, offset };
        assert(isSamePoint(offset), `恢复原光标位置失败：${JSON.stringify(verification.cursorRestored)}`);
      } catch (error) { if (!failure) failure = error; }
    }
  }
  verification.pageErrors = pageErrors;
  verification.completed = !failure;
  if (failure) {
    verification.error = failure.stack || failure.message;
    const failedPath = path.join(artifacts, `verification-failed-${runId}.json`);
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(failedPath, JSON.stringify(verification, null, 2));
    console.error(failure.stack || failure.message);
    console.error(`真实鼠标验收失败记录：${failedPath}`);
    process.exitCode = 1;
  } else {
    const report = path.join(artifacts, 'verification.json');
    await fs.writeFile(report, JSON.stringify(verification, null, 2));
    console.log(`真实鼠标验收记录：${report}`);
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
