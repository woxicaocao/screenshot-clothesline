'use strict';

const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const mode = process.env.RACK_EXE ? 'packaged' : 'development';
const artifacts = path.join(root, 'test-artifacts', `v${version}`, `compact-hover-${mode}`, new Date().toISOString().replace(/[:.]/g, '-'));
const profile = path.join(artifacts, 'profile');
const report = { version, mode, date: new Date().toISOString(), profile, executable: process.env.RACK_EXE || require('electron'),
  scaleRequested: process.env.RACK_SCALE || null, tests: [], pageErrors: [],
  clipboard: '使用隔离测试剪贴板，仅创建自然文案的合成素材，不读取或修改系统剪贴板。',
  retention: '隔离 profile、fixture、报告和截图全部保留，不执行删除文件或应用内删除操作。',
  limits: ['标题栏拖动通过 Electron 原生 app-region 的计算样式及窗口控制区域验证，不向其他桌面程序注入原生鼠标操作。',
    '显示缩放使用 RACK_SCALE；跨真实不同 DPI 显示器移动需人工确认。'] };
let application, rack, groupPage;
const observed = new WeakSet(), diagnostics = [];
const delay = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const hook = (name, ...args) => application.evaluate(({ app }, { name, args }) => app.__rackTest[name](...args), { name, args });
const snapshot = () => rack.evaluate(() => window.rack.getSnapshot());
const runtime = () => hook('runtime');
const popup = () => rack.locator('#autoHideSpeedControl');
const autoButton = () => rack.locator('#autoHideButton');

async function persist() {
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
}

function observe(page) {
  if (observed.has(page)) return;
  observed.add(page);
  page.on('pageerror', error => report.pageErrors.push({ url: page.url(), error: error.message }));
}

async function poll(read, accept, label, timeout = 8000) {
  let value; const end = Date.now() + timeout;
  while (Date.now() < end) {
    value = await read(); if (accept(value)) return value; await delay();
  }
  throw new Error(`等待${label}超时：${JSON.stringify(value)}`);
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
  } finally { await persist(); }
}

async function launch() {
  const env = { ...process.env, RACK_TEST_MODE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.RACK_EXE || require('electron'),
    args: [...(process.env.RACK_EXE ? [] : [root]), '--rack-test', `--data-dir=${profile}`,
      ...(process.env.RACK_SCALE ? [`--force-device-scale-factor=${process.env.RACK_SCALE}`] : [])], env, cwd: root, timeout: 60000 });
  application.on('window', observe);
  application.process().stderr?.on('data', bytes => { diagnostics.push(bytes.toString()); if (diagnostics.length > 80) diagnostics.shift(); });
  rack = await application.firstWindow(); observe(rack);
  await rack.waitForFunction(() => typeof window.rack?.getSnapshot === 'function');
  await poll(() => application.evaluate(({ app }) => !!app.__rackTest?.setAutoHideCursor), Boolean, '隔离测试接口');
  await freezeCursorInside();
  await rack.bringToFront();
}

async function closeApplication() {
  if (!application) return;
  await application.close(); application = null; groupPage = null;
}

async function freezeCursorInside() {
  const bounds = (await runtime()).expandedBounds;
  await hook('setAutoHideCursor', { x: bounds.x + Math.min(80, bounds.width / 2), y: bounds.y + 100 });
}

async function apply(operation) { return rack.evaluate(operation => window.rack.applyLayout(operation), operation); }

async function createGroup(ids, name) {
  const state = await apply({ type: 'group', sourceId: ids[1], targetId: ids[0] });
  const group = state.items.find(item => item.type === 'group' && item.memberIds.includes(ids[0]));
  await apply({ type: 'rename', groupId: group.id, name }); return group.id;
}

async function openGroup(id) {
  const existing = application.windows().find(page => page.url().endsWith('/group.html'));
  const pending = existing ? null : application.waitForEvent('window');
  await rack.evaluate(id => window.rack.openGroup(id), id);
  groupPage = existing || await pending; observe(groupPage);
  await groupPage.waitForFunction(() => document.getElementById('groupName') && !document.getElementById('groupName').disabled
    && document.querySelector('.group-member'));
  await poll(() => groupPage.evaluate(() => window.groupBrowser.getGroup()), group => group.id === id, '当前组');
  await groupPage.bringToFront(); return groupPage;
}

async function titlebarGeometry() {
  return groupPage.evaluate(() => {
    const plain = rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom });
    const titlebar = document.querySelector('.window-titlebar');
    const available = navigator.windowControlsOverlay?.getTitlebarAreaRect();
    let blankDragPoint = null;
    for (let x = (available?.x || 0) + 3; x < (available ? available.right : innerWidth - 138) - 3; x += 2) {
      const y = titlebar.getBoundingClientRect().height / 2, hit = document.elementFromPoint(x, y);
      let draggable = false;
      for (let current = hit; current && current !== document.body; current = current.parentElement) {
        const region = getComputedStyle(current).getPropertyValue('-webkit-app-region');
        if (region === 'no-drag') break;
        if (region === 'drag') { draggable = true; break; }
      }
      if (hit && !hit.closest('input,button') && draggable) {
        blankDragPoint = { x, y, tag: hit.tagName, className: hit.className?.baseVal || hit.className || '' }; break;
      }
    }
    return { viewport: innerWidth, pageOverflow: document.documentElement.scrollWidth > innerWidth, blankDragPoint,
      titlebar: plain(titlebar.getBoundingClientRect()), appRegion: getComputedStyle(titlebar).getPropertyValue('-webkit-app-region'),
      overlay: navigator.windowControlsOverlay ? { visible: navigator.windowControlsOverlay.visible,
        rect: plain(navigator.windowControlsOverlay.getTitlebarAreaRect()) } : null,
      controls: Object.fromEntries(['groupName','groupCount','groupPin','groupMenu'].map(id => {
        const element = document.getElementById(id), style = getComputedStyle(element);
        return [id, { ...plain(element.getBoundingClientRect()), display: style.display, appRegion: style.getPropertyValue('-webkit-app-region') }];
      })),
      decorations: [...document.querySelectorAll('.group-eyebrow,.group-kind,.group-name-label')].map(element => ({ text: element.textContent, visible: !!element.getClientRects().length })),
      header: document.querySelector('.group-header') ? plain(document.querySelector('.group-header').getBoundingClientRect()) : null,
      help: document.querySelector('.group-help') ? plain(document.querySelector('.group-help').getBoundingClientRect()) : null };
  });
}

async function captureGroup(name) {
  await groupPage.locator('#groupHelp').hover();
  await groupPage.evaluate(() => document.activeElement?.blur());
  await groupPage.screenshot({ path: path.join(artifacts, name) });
}

function assertCompactGeometry(value) {
  assert.equal(value.overlay?.visible, true); assert.equal(value.pageOverflow, false);
  assert.equal(value.appRegion, 'drag'); assert(value.titlebar.height >= 36 && value.titlebar.height <= 44);
  assert(value.blankDragPoint, '保留可拖动窗口的标题栏空白或品牌区域');
  const controls = Object.entries(value.controls);
  for (const [id, rect] of controls) {
    assert(rect.width > 0 && rect.height > 0, `标题栏控件必须显示：${id}`);
    assert(rect.x >= -1 && rect.right <= value.overlay.rect.right + 1, `不能覆盖原生窗口按钮：${id} ${JSON.stringify(value)}`);
    assert(rect.y >= -1 && rect.bottom <= value.titlebar.bottom + 1, `控件放在标题栏同一行：${id}`);
    if (id !== 'groupCount') assert.equal(rect.appRegion, 'no-drag', `可操作区域不能拖动窗口：${id}`);
  }
  for (let index = 1; index < controls.length; index += 1) {
    assert(controls[index - 1][1].right <= controls[index][1].x + 1, `标题栏控件不能重叠：${JSON.stringify(value.controls)}`);
  }
  assert(value.decorations.every(element => !element.visible), '装饰行不应显示');
  if (value.header) assert(value.header.height < 70, '下方不保留大标题区');
}

async function moveAway() {
  await rack.bringToFront();
  const point = await rack.evaluate(() => {
    const element = document.getElementById('photoScroll'), rect = element.getBoundingClientRect();
    return { x: rect.left + 16, y: rect.bottom - 20 };
  });
  await rack.mouse.move(point.x, point.y);
  await autoButton().evaluate(element => element.blur());
  return point;
}

async function closePopup() {
  await rack.keyboard.press('Escape');
  await moveAway();
  await poll(() => popup().isVisible(), value => !value, '隐藏速度弹层关闭');
}

async function hoverOpen() {
  await moveAway(); await delay(150);
  await autoButton().hover();
  return poll(() => popup().isVisible(), Boolean, '悬停 500ms 速度弹层', 2500);
}

async function run() {
  await fs.mkdir(path.join(artifacts, 'fixtures'), { recursive: true });
  await launch(); let photoGroupId, noteGroupId;

  await check('隔离建立两张图片和两张自然文案便签，保存两类组', async () => {
    assert.equal((await runtime()).dataDir, profile);
    await rack.evaluate(() => window.rack.setAutoHide(false));
    const fixtures = await rack.evaluate(() => Array.from({ length: 2 }, (_, index) => {
      const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 720;
      const ctx = canvas.getContext('2d'), colors = index ? ['#d7ddcf','#8fa38b','#f0d9ac'] : ['#d7e2db','#6b877b','#ead7ad'];
      ctx.fillStyle = '#faf5e8'; ctx.fillRect(0, 0, 960, 720);
      ctx.fillStyle = colors[0]; ctx.fillRect(38, 38, 884, 644);
      ctx.fillStyle = colors[2]; ctx.beginPath(); ctx.arc(740, 170, 72, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = colors[1]; ctx.beginPath(); ctx.moveTo(80, 570); ctx.bezierCurveTo(250, 240, 410, 250, 620, 570); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#b8c6ad'; ctx.beginPath(); ctx.ellipse(720, 510, 170, 100, -.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#3c4a3a'; ctx.font = 'bold 36px Microsoft YaHei'; ctx.fillText(index ? '留一点温柔给日常' : '把喜欢的片刻留下', 78, 640);
      return canvas.toDataURL('image/png');
    }));
    for (let index = 0; index < fixtures.length; index += 1) {
      await fs.writeFile(path.join(artifacts, 'fixtures', `灵感-${index + 1}.png`), Buffer.from(fixtures[index].split(',')[1], 'base64'), { flag: 'wx' });
      await hook('setClipboardImage', fixtures[index]); await hook('poll');
      await poll(snapshot, state => state.counts.photos === index + 1, '保存参考图片');
    }
    await rack.evaluate(() => window.rack.setPaused(true));
    const photos = (await snapshot()).photos.map(photo => photo.id);
    for (let index = 0; index < 2; index += 1) {
      const pending = application.waitForEvent('window'); await rack.evaluate(() => window.rack.addNote());
      const page = await pending; observe(page);
      await page.waitForFunction(() => document.getElementById('noteInput') && !document.getElementById('noteInput').disabled);
      await page.locator('#noteInput').fill(index ? '下班前的小清单\n收好今天的灵感，给桌面留一点空白。\n明天继续。' : '新的配色灵感\n奶油白，鼠尾草绿，还有自然原木色。\n喜欢的东西，慢慢收集。');
      await page.locator('#noteFontSize').selectOption('28');
      await page.locator('#noteCustomColor').evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, index ? '#dce9d6' : '#fff0b8');
      const closed = page.waitForEvent('close'); await page.locator('#noteCloseButton').click(); await closed;
    }
    const notes = (await hook('notes')).map(note => note.id);
    photoGroupId = await createGroup(photos, '午后的灵感'); noteGroupId = await createGroup(notes, '桌边便签');
    return { photoGroupId, noteGroupId, counts: (await snapshot()).counts };
  });

  await check('组名、数量、置顶和更多收在原生标题栏同一行，窄窗不越界或重叠', async () => {
    await openGroup(photoGroupId);
    const native = await application.browserWindow(groupPage), original = await native.evaluate(window => window.getBounds());
    const measured = [];
    for (const width of [original.width, 270, 320, 420, 680]) {
      await native.evaluate((window, width) => window.setBounds({ ...window.getBounds(), width }), width);
      await delay(120); const detail = await titlebarGeometry(); assertCompactGeometry(detail); measured.push({ requestedWidth: width, ...detail });
      if (width === 270) await captureGroup('compact-group-narrow.png');
    }
    await groupPage.waitForFunction(() => [...document.querySelectorAll('.photo-thumbnail')].every(image => image.complete && image.naturalWidth > 0));
    await captureGroup('compact-photo-group.png');
    return { measured, originalBounds: original };
  });

  await check('紧凑标题栏可编辑组名、独立置顶并打开更多菜单', async () => {
    await groupPage.locator('#groupName').fill('午后的灵感 · 随时对照'); await groupPage.locator('#groupName').press('Enter');
    await poll(() => groupPage.evaluate(() => window.groupBrowser.getGroup()), group => group.name === '午后的灵感 · 随时对照', '标题栏重命名');
    const native = await application.browserWindow(groupPage);
    await groupPage.locator('#groupPin').click(); await poll(() => native.evaluate(window => window.isAlwaysOnTop()), Boolean, '标题栏置顶');
    assert.equal(await groupPage.locator('#groupPin').getAttribute('aria-pressed'), 'true');
    await groupPage.locator('#groupPin').click(); await poll(() => native.evaluate(window => window.isAlwaysOnTop()), value => !value, '标题栏取消置顶');
    await groupPage.locator('#groupMenu').click();
    const menu = await poll(() => hook('groupMenu'), value => value?.id === photoGroupId, '标题栏更多菜单');
    assert(menu.labels.includes('删除整个组'));
    await apply({ type: 'rename', groupId: photoGroupId, name: '午后的灵感' });
    await captureGroup('compact-photo-group.png');
    return { renamed: true, independentPinToggled: true, menu };
  });

  await check('紧凑便签组复用窗口，摘要字号固定 14px', async () => {
    const windowId = (await hook('groupRuntime'))[0].windowId;
    await openGroup(noteGroupId); const geometry = await titlebarGeometry(); assertCompactGeometry(geometry);
    assert.equal((await hook('groupRuntime'))[0].windowId, windowId);
    const sizes = await groupPage.locator('.note-summary').evaluateAll(elements => elements.map(element => getComputedStyle(element).fontSize));
    assert.deepEqual(sizes, ['14px', '14px']);
    await captureGroup('compact-note-group.png');
    const closed = groupPage.waitForEvent('close'); await groupPage.evaluate(() => window.groupBrowser.close()); await closed;
    return { windowId, sizes, geometry };
  });

  await check('自动隐藏按钮标签清楚，关闭时悬停也不显示速度弹层', async () => {
    await rack.bringToFront(); await freezeCursorInside();
    assert.equal(await autoButton().innerText(), '自动隐藏');
    assert.equal((await snapshot()).state.autoHide, false); assert.equal(await popup().isVisible(), false);
    await autoButton().hover(); await delay(650); assert.equal(await popup().isVisible(), false);
    await autoButton().focus(); await delay(650); assert.equal(await popup().isVisible(), false);
    assert.equal(await popup().locator('.speed-label').textContent(), '自动隐藏');
    return { label: await autoButton().innerText(), disabledHoverMs: 650, disabledFocusMs: 650, popupLabel: '自动隐藏', popupVisible: false };
  });

  await check('点击开启后显示速度弹层，Esc 关闭后保持开启且不常驻', async () => {
    const enabledAt = Date.now(); await autoButton().click();
    await poll(snapshot, state => state.state.autoHide, '开启自动隐藏');
    await delay(220); assert.equal(await popup().isVisible(), false, '开启后必须重新等待 500ms，不能沿用之前的 focus 时间');
    await poll(() => popup().isVisible(), Boolean, '开启后的速度弹层');
    assert(Date.now() - enabledAt >= 470);
    assert.equal(await autoButton().getAttribute('aria-expanded'), 'true');
    await rack.screenshot({ path: path.join(artifacts, 'auto-hide-hover.png'), omitBackground: true });
    await closePopup(); await delay(650);
    assert.equal((await snapshot()).state.autoHide, true); assert.equal(await popup().isVisible(), false);
    await rack.screenshot({ path: path.join(artifacts, 'auto-hide-collapsed.png'), omitBackground: true });
    return { enabled: true, escapedClosed: true, doesNotStayOpen: true };
  });

  await check('离开不足 500ms 不弹出，持续悬停才展开，进入弹层可选择三档', async () => {
    await moveAway(); await delay(150); await autoButton().hover(); await delay(220); await moveAway(); await delay(450);
    assert.equal(await popup().isVisible(), false);
    const started = Date.now(); await autoButton().hover(); await delay(300); assert.equal(await popup().isVisible(), false);
    await poll(() => popup().isVisible(), Boolean, '连续悬停满 500ms', 1500); const hoverMs = Date.now() - started;
    assert(hoverMs >= 470);
    const selected = [];
    for (const speed of ['fast', 'medium', 'slow']) {
      const button = popup().locator(`[data-speed="${speed}"]`);
      await button.hover(); await button.click();
      await poll(snapshot, state => state.state.autoHideSpeed === speed, `保存${speed}档`);
      assert.equal(await button.getAttribute('aria-pressed'), 'true'); selected.push(speed);
      if (!(await popup().isVisible())) await hoverOpen();
    }
    await moveAway(); await poll(() => popup().isVisible(), value => !value, '离开按钮与弹层后关闭');
    return { earlyExitMs: 220, continuousHoverMs: hoverMs, selected };
  });

  await check('普通快照不会重置悬停计时或打断已展开的速度弹层', async () => {
    await closePopup();
    const started = Date.now(); await autoButton().hover(); await delay(300);
    await rack.evaluate(() => window.rack.setPaused(true));
    await poll(() => popup().isVisible(), Boolean, '快照前后连续悬停', 400);
    const hoverMs = Date.now() - started; assert(hoverMs < 780);
    await rack.evaluate(() => window.rack.setAlwaysOnTop(false)); await delay(120); assert.equal(await popup().isVisible(), true);
    await closePopup(); return { continuousHoverMs: hoverMs, openAcrossSnapshot: true };
  });

  await check('键盘聚焦与方向键可进入三档，Esc 返回按钮且不立即重弹', async () => {
    await closePopup(); await autoButton().focus(); await autoButton().press('ArrowDown');
    await poll(() => popup().isVisible(), Boolean, '键盘展开速度选项');
    const focused = await rack.evaluate(() => document.activeElement?.dataset.speed || null);
    assert(['fast', 'medium', 'slow'].includes(focused));
    await rack.keyboard.press('Escape'); await poll(() => popup().isVisible(), value => !value, '键盘 Esc 关闭');
    assert.equal(await autoButton().evaluate(element => document.activeElement === element), true);
    await delay(650); assert.equal(await popup().isVisible(), false);
    return { focusedSpeed: focused, focusReturnedToButton: true, noImmediateReopen: true };
  });

  await check('失焦、拖放和拖动衣架时关闭弹层并清理待触发计时', async () => {
    await hoverOpen(); await rack.evaluate(() => window.dispatchEvent(new Event('blur')));
    await poll(() => popup().isVisible(), value => !value, '失焦关闭'); await delay(650); assert.equal(await popup().isVisible(), false);
    await hoverOpen();
    await rack.evaluate(() => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['fixture'], '灵感.png', { type: 'image/png' }));
      document.querySelector('.rack-app').dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await poll(() => popup().isVisible(), value => !value, '文件拖入清理');
    await rack.evaluate(() => {
      document.dispatchEvent(new Event('dragleave', { bubbles: true })); window.dispatchEvent(new Event('blur')); window.rack.setFileDropActive(false);
    });
    await hoverOpen();
    const bounds = (await runtime()).expandedBounds;
    await rack.evaluate(point => window.rack.beginDrag(point), { x: bounds.x + 80, y: bounds.y + 30 });
    await poll(snapshot, state => state.state.dragging, '衣架拖动状态');
    await poll(() => popup().isVisible(), value => !value, '拖动衣架关闭');
    await rack.evaluate(() => window.rack.endDrag()); await poll(snapshot, state => !state.state.dragging, '衣架拖动结束');
    await closePopup();
    return { blur: true, fileDrag: true, rackDrag: true, noStaleTimer: true };
  });

  await check('收起和关闭自动隐藏均清理弹层，重启保留档位但弹层默认关闭', async () => {
    await hoverOpen();
    const state = await runtime(), bounds = state.expandedBounds;
    const inside = { x: bounds.x + 80, y: bounds.y + 100 }, outside = { x: bounds.x + 80, y: bounds.y + bounds.height + 80 };
    await hook('autoHideTick', inside); await hook('autoHideTick', outside); const collapsed = await hook('autoHideTick', outside, 2300);
    assert.equal(collapsed.collapsed, true); assert.equal(await popup().isVisible(), false);
    await hook('autoHideTick', { x: inside.x, y: state.displayBounds.y + 2 }); await hook('setAutoHideCursor', inside); await hook('restore');
    await poll(snapshot, value => !value.state.autoHidden, '恢复衣架');
    await rack.bringToFront(); await freezeCursorInside(); await hoverOpen();
    await autoButton().click(); await poll(snapshot, value => !value.state.autoHide, '关闭自动隐藏');
    assert.equal(await popup().isVisible(), false); await delay(650); assert.equal(await popup().isVisible(), false);
    await rack.evaluate(() => window.rack.setAutoHide(true)); await closePopup();
    const before = await snapshot(); await closeApplication(); await launch();
    const after = await snapshot(); assert.equal(after.state.autoHide, true); assert.equal(after.state.autoHideSpeed, before.state.autoHideSpeed);
    assert.equal(await popup().isVisible(), false); assert.deepEqual(report.pageErrors, []);
    return { collapsed, disabledClosed: true, persistedSpeed: after.state.autoHideSpeed, restartPopupClosed: true, pageErrors: report.pageErrors };
  });
}

run().then(async () => { report.passed = true; await persist(); console.log(`全部通过；报告与实际截图：${artifacts}`); })
  .catch(async error => { report.passed = false; report.error = error.stack; report.diagnostics = diagnostics;
    await persist(); console.error(error.stack); process.exitCode = 1; })
  .finally(async () => { await closeApplication().catch(error => console.error(error.message)); });
