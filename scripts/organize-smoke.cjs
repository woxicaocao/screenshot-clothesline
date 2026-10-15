'use strict';

const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const mode = process.env.RACK_EXE ? 'packaged' : 'development';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const artifacts = path.join(root, 'test-artifacts', `v${require('../package.json').version}`, `organize-${mode}`, runId);
const profile = path.join(artifacts, 'profile');
const fixtureDir = path.join(artifacts, 'fixtures');
const report = { date: new Date().toISOString(), mode, executable: process.env.RACK_EXE || require('electron'),
  scaleRequested: process.env.RACK_SCALE || null, profile, tests: [], pageErrors: [],
  clipboard: '使用隔离 app.__rackTest PNG 输入，不读取或改变系统剪贴板。',
  retention: '新建的 fixtures、profile、报告、实际截图全部保留；无文件删除操作。',
  limits: ['原图导出验证真实页面 dragstart 与原生 payload 测试桩；微信、资源管理器的原生 OLE 接收仍需人工验证。'] };
const diagnostics = [], observed = new WeakSet();
let application, rack, groupPage;
const delay = (ms = 35) => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const itemIds = snapshot => snapshot.items.map(item => item.id);
const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x
  && a.y < b.y + b.height && a.y + a.height > b.y;

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

const hook = (name, ...args) => application.evaluate(({ app }, { name, args }) => app.__rackTest[name](...args), { name, args });
const snapshot = () => rack.evaluate(() => window.rack.getSnapshot());
const runtime = () => hook('runtime');
const waitRuntime = (accept, label = '衣架状态', timeout) => poll(runtime, accept, label, timeout);
const waitSnapshot = (accept, label = '布局状态', timeout) => poll(snapshot, accept, label, timeout);
const apply = operation => rack.evaluate(operation => window.rack.applyLayout(operation), operation);

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
  await poll(() => application.evaluate(({ app }) => !!app.__rackTest?.groupRuntime), Boolean, '测试接口');
  await rack.evaluate(() => window.rack.setAutoHide(false));
  return application;
}

async function closeApplication() {
  if (!application) return;
  await application.close();
  application = null; groupPage = null;
}

function rootSelector(id) {
  return `.photo-card:is([data-photo-id="${id}"],[data-note-id="${id}"],[data-group-id="${id}"])`;
}

async function front(ids) {
  for (const id of [...ids].reverse()) {
    const current = await snapshot();
    if (current.items[0].id !== id) await apply({ type: 'move', id, beforeId: current.items[0].id, groupId: null });
  }
  await rack.locator('#photoScroll').evaluate(element => { element.scrollLeft = 0; });
  await rack.bringToFront();
  await rack.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function rootBox(id, clip = false) {
  const locator = rack.locator(rootSelector(id));
  await locator.waitFor({ state: 'visible' });
  const box = await (clip ? locator.locator('.wooden-clip') : locator).boundingBox();
  assert(box, `卡片必须有实际几何位置：${id}`);
  return box;
}

async function beginRootDrag(id) {
  await rack.bringToFront();
  const box = await rootBox(id, true);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await rack.mouse.move(point.x, point.y); await rack.mouse.down();
  await poll(() => hook('organizeRuntime'), state => state.sources.includes('rack'), '衣架木夹整理会话');
  return point;
}

async function endRootDrag(revision, shouldCommit = true) {
  await rack.mouse.up();
  await poll(() => hook('organizeRuntime'), state => state.sources.length === 0, '整理会话结束');
  if (shouldCommit) await waitSnapshot(value => value.layoutRevision > revision, '布局保存');
  await rack.waitForFunction(() => !document.body.classList.contains('is-layout-saving'));
}

async function groupByPointer(sourceId, targetId, joining = false) {
  await front([sourceId, targetId]);
  const target = await rootBox(targetId);
  const before = await snapshot();
  await beginRootDrag(sourceId);
  await rack.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
  const started = Date.now();
  const waiting = await rack.locator('#organizeHint').textContent();
  await poll(() => rack.locator('#organizeHint').textContent(), value => value === (joining ? '松手加入此组' : '松手成组'), '350ms 中央成组提示');
  const heldMs = Date.now() - started;
  await endRootDrag(before.layoutRevision);
  const current = await snapshot();
  const created = current.items.find(item => item.type === 'group' && item.memberIds.includes(sourceId) && (joining ? item.id === targetId : item.memberIds.includes(targetId)));
  assert(created, '松手后必须实际保存成组');
  return { group: created, heldMs, initialHint: waiting };
}

async function openGroup(id) {
  const existing = application.windows().find(page => page.url().endsWith('/group.html'));
  const pending = existing ? null : application.waitForEvent('window');
  await rack.evaluate(id => window.rack.openGroup(id), id);
  groupPage = existing || await pending;
  observe(groupPage);
  await groupPage.waitForFunction(() => document.getElementById('groupName') && !document.getElementById('groupName').disabled
    && document.querySelector('.group-member'));
  await poll(() => groupPage.evaluate(() => window.groupBrowser.getGroup()), group => group.id === id, '组窗口切换');
  await groupPage.bringToFront();
  return groupPage;
}

async function getGroup() { return groupPage.evaluate(() => window.groupBrowser.getGroup()); }

async function groupMemberMenu(id, label) {
  const member = groupPage.locator(`.group-member[data-item-id="${id}"]`);
  await member.scrollIntoViewIfNeeded();
  await member.click({ button: 'right' });
  const menu = await poll(() => hook('groupMemberMenu'), value => value?.id === id, '组成员右键菜单');
  assert(menu.labels.includes(label));
  await hook('chooseGroupMemberMenu', label);
  return menu;
}

async function nativeDrag(page, bodySelector, id) {
  const body = page.locator(bodySelector); await body.scrollIntoViewIfNeeded();
  await page.bringToFront();
  const before = await snapshot();
  const box = await body.boundingBox();
  await page.mouse.move(box.x + box.width * .3, box.y + box.height * .4);
  await page.mouse.down();
  await delay(120);
  await page.mouse.move(box.x + box.width * .3 + 55, box.y + box.height * .4 + 22, { steps: 9 });
  await page.mouse.up();
  const state = await waitRuntime(state => state.lastNativeDrag?.id === id && !state.nativeDragging, '图片主体原图拖出');
  assert.equal(state.lastNativeDrag.nativeCalled, false);
  assert.equal((await snapshot()).layoutRevision, before.layoutRevision);
  const index = JSON.parse(await fs.readFile(path.join(profile, 'index.json'), 'utf8'));
  const original = path.join(profile, 'photos', index.photos.find(photo => photo.id === id).fileName);
  assert.equal(digest(await fs.readFile(original)), digest(await fs.readFile(state.lastNativeDrag.file)));
  assert.deepEqual((await hook('organizeRuntime')).sources, []);
  return { ...state.lastNativeDrag, byteIdentical: true, layoutUnchanged: true };
}

async function run() {
  await fs.mkdir(fixtureDir, { recursive: true });
  await launch();
  let photoIds, noteIds, photoGroupId, noteGroupId;

  await check('隔离启动，生成并收集 8 张不同 PNG，不改变系统剪贴板', async () => {
    assert.equal((await runtime()).dataDir, profile);
    assert.equal((await snapshot()).counts.photos, 0);
    const fixtures = await rack.evaluate(() => Array.from({ length: 8 }, (_, index) => {
      const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 600;
      const context = canvas.getContext('2d');
      context.fillStyle = ['#dce5cf', '#d7e6e8', '#edd8cb', '#f1dfb3', '#dfd7ee', '#d0e5d9', '#e7cdd8', '#cbd9ed'][index];
      context.fillRect(0, 0, 900, 600);
      context.fillStyle = '#fffdf4'; context.fillRect(45, 45, 810, 510);
      context.fillStyle = ['#647d53', '#5e8490', '#aa765a', '#aa8844', '#817095', '#648673', '#a57388', '#607d9d'][index];
      context.beginPath(); context.arc(697, 176, 78, 0, Math.PI * 2); context.fill();
      context.fillStyle = '#493f32'; context.font = 'bold 42px Microsoft YaHei';
      context.fillText(['沿途的颜色', '留住这一刻', '慢慢收集灵感', '阳光落在桌上', '设计参考', '今天的小发现', '简单的美好', '把想法挂起来'][index], 88, 355);
      context.font = '22px Microsoft YaHei'; context.fillText(`本地整理测试 0${index + 1}  ·  原图保留`, 90, 405);
      return canvas.toDataURL('image/png');
    }));
    for (let index = 0; index < fixtures.length; index += 1) {
      await fs.writeFile(path.join(fixtureDir, `灵感-${index + 1}.png`), Buffer.from(fixtures[index].split(',')[1], 'base64'), { flag: 'wx' });
      await hook('setClipboardImage', fixtures[index]); await hook('poll');
      await waitSnapshot(value => value.counts.photos === index + 1, '逐张收集');
    }
    await rack.evaluate(() => window.rack.setPaused(true));
    photoIds = (await snapshot()).photos.map(photo => photo.id);
    assert.equal(new Set(photoIds).size, 8);
    return { photos: photoIds, fixtureDir, testClipboardOnly: true };
  });

  await check('3 张新便签都避开衣架、保留间距、错开标题栏并通过真实窗口保存', async () => {
    const pages = [];
    for (let index = 0; index < 3; index += 1) {
      const opened = application.waitForEvent('window'); await rack.evaluate(() => window.rack.addNote());
      const page = await opened; observe(page); pages.push(page);
      await page.waitForFunction(() => document.getElementById('noteInput') && !document.getElementById('noteInput').disabled);
      await page.locator('#noteInput').fill(['今日待办\n整理参考图片\n给桌面留一点空白', '配色灵感\n鼠尾草绿与奶油白\n便签摘要固定 14px', '项目笔记\n拖木夹排序，主体拖出原图\n本地测试，原文件保留'][index]);
      await page.locator('#noteFontSize').selectOption('32');
      await page.locator('#noteCustomColor').evaluate((input, color) => {
        input.value = color; input.dispatchEvent(new Event('input', { bubbles: true }));
      }, ['#fff2b8', '#d8e9ce', '#d8e6f2'][index]);
    }
    const bounds = (await hook('noteRuntime')).map(entry => entry.bounds);
    const rackBounds = (await runtime()).expandedBounds;
    assert.equal(bounds.length, 3);
    for (const value of bounds) {
      assert.equal(intersects(value, rackBounds), false, `新便签覆盖衣架：${JSON.stringify({ value, rackBounds })}`);
      if (value.y >= rackBounds.y + rackBounds.height) assert(value.y - rackBounds.y - rackBounds.height >= 15);
    }
    assert.equal(new Set(bounds.map(value => `${value.x}:${value.y}`)).size, 3);
    await pages[2].screenshot({ path: path.join(artifacts, 'new-note-avoids-rack.png') });
    for (const page of pages) {
      const closed = page.waitForEvent('close'); await page.locator('#noteCloseButton').click(); await closed;
    }
    await waitSnapshot(value => value.counts.notes === 3, '便签保存');
    noteIds = (await hook('notes')).map(note => note.id);
    return { rackBounds, noteBounds: bounds, fontSize: 32, notes: noteIds };
  });

  await check('木夹实际左右排序，插入标记可见，取消和失焦不提交并恢复会话', async () => {
    await front([photoIds[0], photoIds[1], photoIds[2]]);
    const nativeBefore = await runtime();
    const before = await snapshot(); const target = await rootBox(photoIds[1]);
    await beginRootDrag(photoIds[0]);
    await rack.mouse.move(target.x + target.width - 8, target.y + target.height / 2, { steps: 8 });
    await rack.locator('#organizeInsertion').waitFor({ state: 'visible' });
    await endRootDrag(before.layoutRevision);
    const after = await snapshot();
    assert.deepEqual(itemIds(after).slice(0, 3), [photoIds[1], photoIds[0], photoIds[2]]);
    for (const cancel of ['Escape', 'blur']) {
      const checkpoint = await snapshot();
      const second = await rootBox(checkpoint.items[1].id);
      await beginRootDrag(checkpoint.items[0].id);
      await rack.mouse.move(second.x + second.width - 8, second.y + second.height / 2, { steps: 8 });
      if (cancel === 'Escape') {
        await rack.keyboard.press('Escape');
        await delay(750);
        const sourceBody = await rootBox(checkpoint.items[0].id);
        await rack.mouse.move(sourceBody.x + sourceBody.width / 2, sourceBody.y + sourceBody.height / 2);
      }
      else await rack.evaluate(() => window.dispatchEvent(new Event('blur')));
      await endRootDrag(checkpoint.layoutRevision, false);
      assert.deepEqual(itemIds(await snapshot()), itemIds(checkpoint));
      assert.equal((await snapshot()).layoutRevision, checkpoint.layoutRevision);
    }
    const nativeAfter = await runtime();
    assert.equal(nativeAfter.preparedDragCount, nativeBefore.preparedDragCount);
    assert.deepEqual(nativeAfter.lastNativeDrag, nativeBefore.lastNativeDrag);
    assert.equal(nativeAfter.imagePreviews.length, 0);
    return { before: itemIds(before), after: itemIds(after), cancelWithoutCommit: ['Escape held 750ms then released on body', 'renderer blur'], woodenClipDoesNotPrepareExport: true };
  });

  await check('中央停留约 350ms 才提示松手成组，图片组使用叠放缩略图', async () => {
    const result = await groupByPointer(photoIds[0], photoIds[1]); photoGroupId = result.group.id;
    assert.equal(result.group.kind, 'photo'); assert.equal(result.group.count, 2);
    assert.equal(result.group.name, '图片组 1');
    assert.equal(await rack.locator(`${rootSelector(photoGroupId)} .group-photo-leaf`).count(), 2);
    return result;
  });

  await check('图片与便签中央拖动不成组，主进程也拒绝混合操作', async () => {
    await front([photoIds[2], noteIds[0]]);
    const target = await rootBox(noteIds[0]); const before = await snapshot();
    await beginRootDrag(photoIds[2]);
    await rack.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
    await delay(450);
    assert.equal(await rack.locator('#organizeHint').textContent(), '松手调整顺序');
    await rack.mouse.up(); await poll(() => hook('organizeRuntime'), value => !value.sources.length, '混合拖动结束');
    await rack.waitForFunction(() => !document.body.classList.contains('is-layout-saving'));
    const current = await snapshot(); assert.equal(current.counts.groups, before.counts.groups);
    const rejected = await rack.evaluate(async ({ sourceId, targetId }) => {
      try { await window.rack.applyLayout({ type: 'group', sourceId, targetId }); return null; }
      catch (error) { return error.message; }
    }, { sourceId: photoIds[2], targetId: noteIds[0] });
    assert(rejected?.includes('不能混合'));
    assert.equal((await snapshot()).layoutRevision, current.layoutRevision);
    return { rejected, groupCount: current.counts.groups };
  });

  await check('右端边缘连续滚动保留虚拟列表拖动源，并按完整列表移到末尾', async () => {
    await front([photoGroupId]);
    const before = await snapshot();
    const logicalWidth = await rack.locator('#photoTrack').evaluate(element => parseFloat(element.style.width));
    await beginRootDrag(photoGroupId);
    const bounds = await rack.locator('#photoScroll').boundingBox();
    await rack.mouse.move(bounds.x + bounds.width - 3, bounds.y + bounds.height / 2, { steps: 12 });
    const scrolled = await poll(() => rack.locator('#photoScroll').evaluate(element => ({ left: element.scrollLeft, width: element.scrollWidth, client: element.clientWidth })),
      value => value.left > 200 && value.left >= logicalWidth - value.client - 4, '边缘滚到完整列表末端', 15000);
    await delay(650);
    const held = await rack.locator('#photoScroll').evaluate(element => ({ left: element.scrollLeft, width: element.scrollWidth, client: element.clientWidth }));
    assert(held.left <= logicalWidth - held.client + 1, `拖源位移不能扩大逻辑滚动终点：${JSON.stringify({ logicalWidth, held })}`);
    assert.equal(await rack.locator(rootSelector(photoGroupId)).count(), 1);
    assert.equal(await rack.locator(rootSelector(photoGroupId)).evaluate(element => element.classList.contains('is-organize-source')), true);
    await endRootDrag(before.layoutRevision);
    assert.equal((await snapshot()).items.at(-1).id, photoGroupId);
    return { scroll: scrolled, held, logicalWidth, sourceNodeRetained: true, targetFromFullList: true };
  });

  await check('轻微滚动时收到快照不跳回左端，拖动源和 pointer capture 保留', async () => {
    await front([photoGroupId]);
    await rack.locator('#photoScroll').evaluate(element => { element.scrollLeft = 15; });
    await beginRootDrag(photoGroupId);
    const clip = await rootBox(photoGroupId, true);
    const bounds = await rack.locator('#photoScroll').boundingBox();
    await rack.mouse.move(bounds.x + bounds.width / 2, clip.y + clip.height / 2 + 8, { steps: 6 });
    const before = await rack.locator('#photoScroll').evaluate(element => element.scrollLeft);
    await rack.evaluate(() => window.rack.setAlwaysOnTop(false));
    await delay(80);
    const after = await rack.locator('#photoScroll').evaluate(element => element.scrollLeft);
    assert(Math.abs(after - before) < 2 && after > 0, `快照不能将15px附近拖动位置回0：${before}/${after}`);
    assert.equal(await rack.locator(rootSelector(photoGroupId)).evaluate(element => element.classList.contains('is-organize-source')), true);
    assert.equal(await rack.locator(rootSelector(photoGroupId)).locator('.wooden-clip').evaluate(element => element.hasPointerCapture(1)), true);
    await rack.keyboard.press('Escape'); await rack.mouse.up();
    await poll(() => hook('organizeRuntime'), value => !value.sources.length, '轻微滚动取消');
    return { before, after, sourceRetained: true, pointerCaptureRetained: true };
  });

  await check('卡片间隙可连续横向滚动，浏览带外透明空白继续鼠标穿透', async () => {
    await rack.locator('#photoScroll').evaluate(element => { element.scrollLeft = 0; });
    const gap = await rack.evaluate(() => {
      const rect = document.getElementById('photoScroll').getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      for (let x = rect.left + 5; x < rect.right - 5; x += 2) {
        const element = document.elementFromPoint(x, y);
        if (element?.closest('#photoScroll') && !element.closest('.photo-card')) return { x, y, element: element.id };
      }
      throw new Error('没有找到真实卡片间隙');
    });
    await rack.mouse.move(gap.x, gap.y); await waitRuntime(value => !value.ignoringMouseEvents);
    const readings = [];
    for (let index = 0; index < 3; index += 1) {
      const before = await rack.locator('#photoScroll').evaluate(element => element.scrollLeft);
      await rack.mouse.wheel(0, 190);
      readings.push(await poll(() => rack.locator('#photoScroll').evaluate(element => element.scrollLeft), value => value > before + 10, '间隙滚轮连续响应'));
    }
    const outside = await rack.evaluate(() => ({ x: innerWidth / 2, y: innerHeight - 2 }));
    await rack.mouse.move(outside.x, outside.y); await waitRuntime(value => value.ignoringMouseEvents, '透明空白穿透');
    const outsideTarget = await rack.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-interactive]')?.id || null, outside);
    assert.equal(outsideTarget, null);
    return { gap, scrollReadings: readings, outside, transparentOutside: true };
  });

  await check('整理保存失败保留原布局及版本，并在衣架显示失败提示', async () => {
    await front([photoIds[2], photoIds[3], photoIds[4]]);
    const before = await snapshot(); const target = await rootBox(photoIds[3]);
    await hook('failNextLayoutSave');
    await beginRootDrag(photoIds[2]);
    await rack.mouse.move(target.x + target.width - 8, target.y + target.height / 2, { steps: 8 });
    await endRootDrag(before.layoutRevision, false);
    await rack.locator('#errorMessage').waitFor({ state: 'visible' });
    const after = await snapshot();
    assert.deepEqual(itemIds(after), itemIds(before)); assert.equal(after.layoutRevision, before.layoutRevision);
    assert((await rack.locator('#errorMessage').textContent()).includes('布局保存失败'));
    return { layoutRevision: after.layoutRevision, preservedOrder: itemIds(after), message: await rack.locator('#errorMessage').textContent() };
  });

  await check('图片主体真实拖动仍导出原图 payload，不触发布局整理', async () => {
    await front([photoIds[2]]);
    return nativeDrag(rack, `${rootSelector(photoIds[2])} .photo-image-wrap`, photoIds[2]);
  });

  await check('便签同类叠放和单项继续入组，彩色组卡显示数量', async () => {
    const created = await groupByPointer(noteIds[0], noteIds[1]); noteGroupId = created.group.id;
    assert.equal(created.group.kind, 'note'); assert.equal(created.group.name, '便签组 1');
    const joined = await groupByPointer(noteIds[2], noteGroupId, true);
    assert.equal(joined.group.count, 3);
    assert.equal(await rack.locator(`${rootSelector(noteGroupId)} .group-note-leaf`).count(), 3);
    await rack.screenshot({ path: path.join(artifacts, 'rack-photo-and-note-groups.png'), omitBackground: true });
    return { created, joined };
  });

  await check('图片组独立浏览面板避开衣架，默认三列且纵向滚动，组内拖木夹排序', async () => {
    for (const id of photoIds.slice(2)) await apply({ type: 'group', sourceId: id, targetId: photoGroupId });
    await openGroup(photoGroupId);
    const state = (await hook('groupRuntime'))[0], rackBounds = (await runtime()).expandedBounds;
    assert.equal(intersects(state.bounds, rackBounds), false);
    const grid = await groupPage.locator('#groupGrid').evaluate(element => ({ columns: getComputedStyle(element).gridTemplateColumns.split(' ').length,
      overflowX: getComputedStyle(element.parentElement).overflowX, overflowY: getComputedStyle(element.parentElement).overflowY,
      client: element.parentElement.clientHeight, height: element.parentElement.scrollHeight, viewport: innerWidth }));
    assert.equal(grid.columns, grid.viewport > 560 ? 3 : grid.viewport > 340 ? 2 : 1);
    assert.equal(grid.overflowY, 'auto'); assert.equal(grid.overflowX, 'hidden'); assert(grid.height > grid.client);
    const before = await getGroup();
    const source = groupPage.locator(`.group-member[data-item-id="${before.items[0].id}"] .wooden-clip`);
    const target = groupPage.locator(`.group-member[data-item-id="${before.items[1].id}"]`);
    const a = await source.boundingBox(), b = await target.boundingBox();
    await groupPage.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await groupPage.mouse.down();
    await groupPage.mouse.move(b.x + b.width - 8, b.y + b.height / 2, { steps: 10 });
    await groupPage.locator('.insert-after').waitFor({ state: 'visible' }); await groupPage.mouse.up();
    const sorted = await poll(getGroup, value => value.memberIds[0] === before.memberIds[1], '组内木夹排序');
    await groupPage.screenshot({ path: path.join(artifacts, 'photo-group-grid.png') });
    return { runtime: state, grid, before: before.memberIds, after: sorted.memberIds };
  });

  await check('组面板窄窗自动减列，切换组复用同一窗口，便签摘要固定 14px', async () => {
    const original = (await hook('groupRuntime'))[0];
    const native = await application.browserWindow(groupPage);
    const measured = [];
    for (const width of [500, 320, original.bounds.width]) {
      await native.evaluate((window, width) => window.setBounds({ ...window.getBounds(), width }), width);
      const value = await poll(() => groupPage.locator('#groupGrid').evaluate(element => ({ viewport: innerWidth, columns: getComputedStyle(element).gridTemplateColumns.split(' ').length })),
        value => value.columns === (value.viewport > 560 ? 3 : value.viewport > 340 ? 2 : 1), '窄窗列数');
      measured.push(value);
    }
    await openGroup(noteGroupId);
    const current = (await hook('groupRuntime'))[0]; assert.equal(current.windowId, original.windowId);
    assert.equal((await hook('groupRuntime')).length, 1);
    const fontSizes = await groupPage.locator('.note-summary').evaluateAll(elements => elements.map(element => getComputedStyle(element).fontSize));
    assert.deepEqual(fontSizes, ['14px', '14px', '14px']);
    await groupPage.screenshot({ path: path.join(artifacts, 'note-group-grid.png') });
    return { sameWindowId: current.windowId, measured, fontSizes };
  });

  await check('组窗口受限 IPC 拒绝其他组、非成员、建组和解散操作', async () => {
    const before = await snapshot();
    const operations = [
      { type: 'move', groupId: photoGroupId, id: photoIds[0], beforeId: null },
      { type: 'move', groupId: noteGroupId, id: photoIds[0], beforeId: null },
      { type: 'remove', groupId: noteGroupId, id: photoIds[0] },
      { type: 'dissolve', groupId: noteGroupId },
      { type: 'group', groupId: noteGroupId, sourceId: noteIds[0], targetId: noteIds[1] },
    ];
    const rejected = [];
    for (const operation of operations) rejected.push(await groupPage.evaluate(async operation => {
      try { await window.groupBrowser.applyLayout(operation); return null; } catch (error) { return error.message; }
    }, operation));
    assert(rejected.every(Boolean));
    for (const method of ['openItem', 'preparePhotoDrag']) {
      assert(await groupPage.evaluate(async ({ method, id }) => {
        try { await window.groupBrowser[method](id); return false; } catch { return true; }
      }, { method, id: photoIds[0] }));
    }
    assert.deepEqual(itemIds(await snapshot()), itemIds(before)); assert.equal((await snapshot()).layoutRevision, before.layoutRevision);
    return { rejected, foreignOpenAndExportRejected: true };
  });

  await check('右键组重命名，保存失败恢复原名，恢复后真实编辑保存成功', async () => {
    await front([noteGroupId]);
    await rack.locator(rootSelector(noteGroupId)).click({ button: 'right' });
    const menu = await poll(() => hook('groupMenu'), value => value?.id === noteGroupId, '组右键菜单');
    assert.deepEqual(menu.labels.filter(Boolean), ['重命名', '解散组', '删除整个组']); await hook('chooseGroupMenu', '重命名');
    await groupPage.locator('#groupName').waitFor({ state: 'visible' });
    const old = (await getGroup()).name;
    await hook('failNextLayoutSave'); await groupPage.locator('#groupName').fill('失败名称'); await groupPage.locator('#groupName').press('Enter');
    await groupPage.locator('#groupError').waitFor({ state: 'visible' });
    assert.equal((await getGroup()).name, old); assert.equal(await groupPage.locator('#groupName').inputValue(), old);
    await groupPage.locator('#groupName').fill('桌边的灵感'); await groupPage.locator('#groupName').press('Enter');
    await poll(getGroup, value => value.name === '桌边的灵感', '重命名保存');
    return { menu, failedNameRestored: old, savedName: '桌边的灵感' };
  });

  await check('组内点击打开完整便签和原图，两类独立窗口可同时保留，图片主体仍能拖出', async () => {
    const openedNote = application.waitForEvent('window'); await groupPage.locator('.member-open').first().click();
    const notePage = await openedNote; observe(notePage);
    await notePage.waitForFunction(() => !!document.getElementById('noteInput') && !document.getElementById('noteInput').disabled);
    assert.equal(await notePage.locator('#noteFontSize').inputValue(), '32');
    await openGroup(photoGroupId);
    const photo = (await getGroup()).items[0];
    const openedPhoto = application.waitForEvent('window'); await groupPage.locator(`.group-member[data-item-id="${photo.id}"] .member-open`).click();
    const photoPage = await openedPhoto; observe(photoPage);
    await photoPage.waitForFunction(() => document.getElementById('previewImage')?.naturalWidth > 0);
    const dimensions = await photoPage.locator('#previewImage').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight, url: image.src }));
    assert.equal(dimensions.width, photo.width); assert.equal(dimensions.height, photo.height);
    assert.equal((await hook('noteRuntime')).length, 1); assert.equal((await runtime()).imagePreviews.length, 1);
    const payload = await nativeDrag(groupPage, `.group-member[data-item-id="${photo.id}"] .member-open`, photo.id);
    const photoClosed = photoPage.waitForEvent('close'); await photoPage.evaluate(() => window.rack.closePreview()); await photoClosed;
    const noteClosed = notePage.waitForEvent('close'); await notePage.locator('#noteCloseButton').click(); await noteClosed;
    return { fullNoteFontSize: 32, dimensions, payload, simultaneousWindows: true };
  });

  await check('打开组面板不阻止自动隐藏，整理期间暂停，取消后继续收起', async () => {
    await openGroup(photoGroupId);
    const state = await runtime(), bounds = state.expandedBounds;
    const inside = { x: bounds.x + 60, y: bounds.y + 100 }, outside = { x: bounds.x + 60, y: bounds.y + bounds.height + 60 };
    await hook('setAutoHideCursor', inside); await rack.evaluate(() => window.rack.setAutoHideSpeed('medium')); await rack.evaluate(() => window.rack.setAutoHide(true));
    const start = await hook('autoHideTick', outside); const collapsed = await hook('autoHideTick', outside, 1100);
    assert.equal(start.suspended, false); assert.equal(collapsed.collapsed, true);
    assert.equal((await hook('groupRuntime')).length, 1);
    await hook('autoHideTick', { x: inside.x, y: state.displayBounds.y + 2 }); await hook('autoHideTick', inside);
    await waitSnapshot(value => !value.state.autoHidden, '恢复衣架');
    await rack.evaluate(() => window.rack.setOrganizeActive(true));
    await poll(() => hook('organizeRuntime'), value => value.sources.includes('rack'), '整理暂停');
    const suspended = await hook('autoHideTick', outside, 1500); assert.equal(suspended.suspended, true); assert.equal(suspended.collapsed, false);
    await rack.evaluate(() => window.rack.setOrganizeActive(false));
    await poll(() => hook('organizeRuntime'), value => !value.sources.length, '整理取消');
    await hook('autoHideTick', outside); const resumed = await hook('autoHideTick', outside, 1100);
    assert.equal(resumed.collapsed, true);
    await rack.evaluate(() => window.rack.setAutoHide(false)); await hook('restore');
    return { groupRemainedOpen: true, collapsed, suspended, resumed };
  });

  await check('右键移出放在原组右侧，剩一项还原，删除便签成员后组状态同步', async () => {
    await openGroup(noteGroupId);
    const initial = await getGroup();
    const menu = await groupMemberMenu(initial.items[0].id, '移出此组');
    const current = await waitSnapshot(value => value.items.some(item => item.id === initial.items[0].id), '成员移出');
    const position = current.items.findIndex(item => item.id === noteGroupId);
    assert.equal(current.items[position + 1].id, initial.items[0].id);
    const two = await getGroup();
    await groupMemberMenu(two.items[0].id, '移出此组');
    await poll(() => hook('groupRuntime'), value => !value.length, '单成员自动还原并销毁组窗口');
    assert.equal((await snapshot()).items.some(item => item.id === noteGroupId), false);
    const rebuilt = await apply({ type: 'group', sourceId: noteIds[0], targetId: noteIds[1] });
    const freshGroup = rebuilt.items.find(item => item.type === 'group' && item.kind === 'note'); noteGroupId = freshGroup.id;
    await openGroup(noteGroupId);
    const deleting = (await getGroup()).items[0].id;
    await groupMemberMenu(deleting, '删除');
    await waitSnapshot(value => value.counts.notes === 2, '测试便签成员删除');
    await poll(() => hook('groupRuntime'), value => !value.length, '删除后单成员还原');
    noteIds = (await hook('notes')).map(note => note.id);
    const final = await apply({ type: 'group', sourceId: noteIds[0], targetId: noteIds[1] });
    noteGroupId = final.items.find(item => item.type === 'group' && item.kind === 'note').id;
    return { menu, removedToRight: true, collapsedWithoutDeletingContent: true, deletedNoteId: deleting, remainingNotes: noteIds };
  });

  await check('右键解散图片组原位展开，恢复分组后关闭窗口销毁，重启恢复布局和组名', async () => {
    await openGroup(photoGroupId); const originalGroup = await getGroup();
    await front([photoGroupId]); const before = await snapshot();
    await rack.locator(rootSelector(photoGroupId)).click({ button: 'right' });
    await poll(() => hook('groupMenu'), value => value?.id === photoGroupId, '解散组菜单'); await hook('chooseGroupMenu', '解散组');
    const expanded = await waitSnapshot(value => !value.items.some(item => item.id === photoGroupId), '原位解散');
    const expected = itemIds(before).flatMap(id => id === photoGroupId ? originalGroup.memberIds : [id]);
    assert.deepEqual(itemIds(expanded), expected); assert.equal(expanded.counts.photos, 8);
    await poll(() => hook('groupRuntime'), value => !value.length, '解散后销毁组面板');
    let current = await apply({ type: 'group', sourceId: originalGroup.memberIds[1], targetId: originalGroup.memberIds[0] });
    photoGroupId = current.items.find(item => item.type === 'group' && item.kind === 'photo').id;
    for (const id of originalGroup.memberIds.slice(2)) await apply({ type: 'group', sourceId: id, targetId: photoGroupId });
    await apply({ type: 'rename', groupId: photoGroupId, name: '项目参考图片' });
    await apply({ type: 'rename', groupId: noteGroupId, name: '桌边的灵感' });
    await front([photoGroupId, noteGroupId]); await rack.screenshot({ path: path.join(artifacts, 'final-rack.png'), omitBackground: true });
    await openGroup(photoGroupId); await groupPage.screenshot({ path: path.join(artifacts, 'final-photo-group.png') });
    const closed = groupPage.waitForEvent('close'); await groupPage.evaluate(() => window.groupBrowser.close()); await closed;
    await poll(() => hook('groupRuntime'), value => !value.length, '关闭后组窗口销毁');
    const persisted = await snapshot(); const layoutBytes = await fs.readFile(path.join(profile, 'layout.json'), 'utf8');
    await closeApplication(); await launch();
    const restored = await snapshot();
    assert.deepEqual(restored.items, persisted.items); assert.equal(restored.layoutRevision, persisted.layoutRevision);
    assert.equal(await fs.readFile(path.join(profile, 'layout.json'), 'utf8'), layoutBytes);
    assert.deepEqual(restored.counts, { photos: 8, notes: 2, groups: 2 });
    await openGroup(noteGroupId); await groupPage.screenshot({ path: path.join(artifacts, 'final-note-group.png') });
    return { expectedExpandedOrder: expected, restoredOrder: itemIds(restored), counts: restored.counts, revision: restored.layoutRevision };
  });

  await check('真实窗口截图已保存，所有页面无错误且 renderer 无 Node 权限', async () => {
    assert.deepEqual(report.pageErrors, []);
    const sandbox = await rack.evaluate(() => ({ require: typeof window.require, process: typeof window.process, scale: devicePixelRatio }));
    assert.equal(sandbox.require, 'undefined'); assert.equal(sandbox.process, 'undefined');
    return { pageErrors: report.pageErrors, sandbox, artifacts, version: (await snapshot()).version };
  });
}

run().then(() => { report.passed = true; }).catch(error => {
  report.passed = false; report.error = error.stack; process.exitCode = 1; console.error(error);
  console.error(diagnostics.join('').slice(-7000));
}).finally(async () => {
  if (application) await closeApplication().catch(error => { report.closeError = error.message; });
  report.testCount = report.tests.length; report.diagnostics = diagnostics;
  await persistReport(); console.log(`整理分组验证记录：${path.join(artifacts, 'verification.json')}`);
});
