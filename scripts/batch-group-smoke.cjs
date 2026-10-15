'use strict';

// 隔离 Electron 实例的图片组框选／批量拖动验证。原生拖出使用应用测试桩，
// 不向真实微信或资源管理器发送文件，不读取或改写系统剪贴板。
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const mode = process.env.RACK_EXE ? 'packaged' : 'development';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const artifacts = path.join(root, 'test-artifacts', `v${version}`, `batch-group-${mode}`, runId);
const profile = path.join(artifacts, 'profile');
const fixtureDir = path.join(artifacts, 'fixtures');
const report = { date: new Date().toISOString(), version, mode,
  executable: process.env.RACK_EXE || require('electron'), scaleRequested: process.env.RACK_SCALE || null,
  profile, tests: [], pageErrors: [],
  clipboard: '全部测试图经 app.__rackTest 隔离输入；不读取或更改系统剪贴板。',
  retention: '保留本次 fixtures、profile、报告和截图；无文件删除操作。',
  limits: ['原生多文件拖出只验证真实页面 dragstart 和应用测试桩 payload；微信、资源管理器的实际 OLE 接收需人工确认。',
    'RACK_SCALE 验证逻辑显示缩放；不替代不同 DPI 实体显示器之间的人工移动。'] };
const diagnostics = [], observed = new WeakSet();
let application, rack, groupPage, photoIds, noteIds, mainGroupId, otherGroupId, noteGroupId;
const delay = (ms = 35) => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const memberSelector = id => `.group-member[data-item-id="${id}"]`;
const hook = (name, ...args) => application.evaluate(({ app }, payload) => app.__rackTest[payload.name](...payload.args), { name, args });
const snapshot = () => rack.evaluate(() => window.rack.getSnapshot());
const runtime = () => hook('runtime');
const getGroup = () => groupPage.evaluate(() => window.groupBrowser.getGroup());
const apply = operation => rack.evaluate(operation => window.rack.applyLayout(operation), operation);
const selected = () => groupPage.locator('.group-member.is-selected').evaluateAll(elements => elements.map(element => element.dataset.itemId));

async function persistReport() {
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
}

function observe(page) {
  if (observed.has(page)) return;
  observed.add(page);
  page.on('pageerror', error => report.pageErrors.push({ url: page.url(), error: error.message }));
}

async function poll(read, accept, label, timeout = 10000) {
  const until = Date.now() + timeout;
  let value;
  while (Date.now() < until) {
    value = await read();
    if (accept(value)) return value;
    await delay();
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
    if (application) report.windowsAtFailure = await Promise.all(application.windows().map(async page => ({
      url: page.url(), title: await page.title().catch(() => ''),
      body: await page.locator('body').innerText().catch(() => ''),
    })));
    if (groupPage && !groupPage.isClosed()) await groupPage.screenshot({ path: path.join(artifacts, 'failure-group.png') }).catch(() => {});
    if (rack && !rack.isClosed()) await rack.screenshot({ path: path.join(artifacts, 'failure-rack.png'), omitBackground: true }).catch(() => {});
    throw error;
  } finally { await persistReport(); }
}

async function launch() {
  const env = { ...process.env, RACK_TEST_MODE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.RACK_EXE || require('electron'),
    args: [...(process.env.RACK_EXE ? [] : [root]), '--rack-test', `--data-dir=${profile}`,
      ...(process.env.RACK_SCALE ? [`--force-device-scale-factor=${process.env.RACK_SCALE}`] : [])],
    env, cwd: root, timeout: 60000 });
  application.on('window', observe);
  application.process().stderr?.on('data', chunk => { diagnostics.push(chunk.toString()); if (diagnostics.length > 60) diagnostics.shift(); });
  rack = await application.firstWindow(); observe(rack);
  await rack.waitForFunction(() => typeof window.rack?.applyLayout === 'function');
  await poll(() => application.evaluate(({ app }) => !!app.__rackTest?.holdNextBatchDragPreparation), Boolean, '批量拖动测试接口');
  await rack.evaluate(() => window.rack.setAutoHide(false));
}

async function closeApplication() {
  if (!application) return;
  await restoreSlowPreparation().catch(() => {});
  await hook('releaseBatchDragPreparation').catch(() => {});
  await application.close();
  application = null; groupPage = null;
}

async function openGroup(id) {
  const existing = application.windows().find(page => page.url().endsWith('/group.html'));
  const pending = existing ? null : application.waitForEvent('window');
  await rack.evaluate(id => window.rack.openGroup(id), id);
  groupPage = existing || await pending; observe(groupPage);
  await groupPage.waitForFunction(() => typeof window.groupBrowser?.preparePhotoBatch === 'function');
  const current = await poll(getGroup, group => group.id === id, '当前图片组');
  await poll(() => groupPage.locator('.group-member').evaluateAll(elements => elements.map(element => element.dataset.itemId)),
    ids => same(ids, current.memberIds), '组网格同步');
  await groupPage.waitForFunction(() => document.querySelector('.group-member'));
  await groupPage.bringToFront();
  await delay(50);
  return groupPage;
}

async function clearSelection() {
  if ((await selected()).length) await groupPage.locator('#clearSelection').click();
  await poll(selected, ids => !ids.length, '清空图片选择');
}

async function selectIds(ids) {
  await clearSelection();
  for (const id of ids) {
    await groupPage.locator(`${memberSelector(id)} .member-open`).scrollIntoViewIfNeeded();
    await groupPage.keyboard.down('Control');
    try { await groupPage.locator(`${memberSelector(id)} .member-open`).click(); }
    finally { await groupPage.keyboard.up('Control'); }
  }
  const order = (await getGroup()).memberIds.filter(id => ids.includes(id));
  await poll(selected, actual => same(actual, order), 'Ctrl 点击选择');
  return order;
}

async function top() {
  await groupPage.locator('#groupScroll').evaluate(element => { element.scrollTop = 0; });
  await groupPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function dragBody(id) {
  const body = groupPage.locator(`${memberSelector(id)} .member-open`);
  await body.scrollIntoViewIfNeeded(); await groupPage.bringToFront();
  const box = await body.boundingBox(); assert(box);
  await groupPage.mouse.move(box.x + box.width * .3, box.y + box.height * .4);
  await groupPage.mouse.down(); await delay(100);
  await groupPage.mouse.move(box.x + box.width * .3 + 60, box.y + box.height * .4 + 20, { steps: 10 });
  await groupPage.mouse.up();
}

async function dragClip(id, targetId, side = 'after', fail = false) {
  await top(); await groupPage.bringToFront();
  const clip = await groupPage.locator(`${memberSelector(id)} .wooden-clip`).boundingBox();
  const target = await groupPage.locator(memberSelector(targetId)).boundingBox();
  assert(clip && target);
  const before = await snapshot();
  if (fail) await hook('failNextLayoutSave');
  await groupPage.mouse.move(clip.x + clip.width / 2, clip.y + clip.height / 2);
  await groupPage.mouse.down();
  await groupPage.mouse.move(side === 'before' ? target.x + 3 : target.x + target.width - 3,
    target.y + Math.min(80, target.height / 2), { steps: 10 });
  await groupPage.locator(`.insert-${side}`).waitFor({ state: 'visible' });
  await poll(() => hook('organizeRuntime'), state => state.sources.includes('group'), '批量木夹会话');
  await groupPage.mouse.up();
  await poll(() => hook('organizeRuntime'), state => !state.sources.length, '批量木夹会话清理');
  await groupPage.waitForFunction(() => !document.body.classList.contains('is-saving'));
  if (!fail) await poll(snapshot, value => value.layoutRevision > before.layoutRevision, '批量排序保存');
  else await groupPage.locator('#groupError').waitFor({ state: 'visible' });
  return before;
}

async function verifyFiles(payload, expectedIds) {
  assert.deepEqual(payload.ids, expectedIds); assert.equal(payload.prepared, true);
  assert.equal(payload.nativeCalled, false); assert.equal(payload.file, payload.files[0]);
  assert.equal(new Set(payload.files).size, expectedIds.length);
  const index = JSON.parse(await fs.readFile(path.join(profile, 'index.json'), 'utf8'));
  const sizes = [];
  for (let position = 0; position < expectedIds.length; position += 1) {
    const original = path.join(profile, 'photos', index.photos.find(item => item.id === expectedIds[position]).fileName);
    const a = await fs.readFile(original), b = await fs.readFile(payload.files[position]);
    assert.equal(digest(a), digest(b)); sizes.push(a.length);
  }
  assert((await runtime()).preparedDragCount <= 2, '批量拖出不扩大原图图标常驻缓存');
  return { ids: expectedIds, files: payload.files, sizes, byteIdentical: true, preparedIconCacheAtMostTwo: true };
}

async function rejected(method, argument) {
  return groupPage.evaluate(async ({ method, argument }) => {
    try { await window.groupBrowser[method](argument); return null; }
    catch (error) { return error.message; }
  }, { method, argument });
}

async function holdSlowPreparation() {
  return application.evaluate(({ app, ipcMain }) => {
    const channel = 'group:prepare-batch-drag', original = ipcMain._invokeHandlers.get(channel);
    if (app.__batchSmokePrepareGate || typeof original !== 'function') throw new Error('批量准备测试屏障不可用');
    const gate = { original, entered: false, channel };
    gate.promise = new Promise(resolve => { gate.release = resolve; });
    app.__batchSmokePrepareGate = gate;
    ipcMain._invokeHandlers.set(channel, async (...args) => {
      gate.entered = true; await gate.promise; return original(...args);
    });
    return true;
  });
}

async function restoreSlowPreparation() {
  return application.evaluate(({ app, ipcMain }) => {
    const gate = app.__batchSmokePrepareGate;
    if (!gate) return false;
    ipcMain._invokeHandlers.set(gate.channel, gate.original);
    gate.release(); delete app.__batchSmokePrepareGate;
    return true;
  });
}

async function run() {
  await fs.mkdir(fixtureDir, { recursive: true });
  await launch();
  await check('隔离启动并收集 106 张测试图；前 12 张用于真实演示，系统剪贴板不变', async () => {
    assert.equal((await runtime()).dataDir, profile); assert.equal((await snapshot()).counts.photos, 0);
    const fixtures = await rack.evaluate(() => Array.from({ length: 106 }, (_, index) => {
      const canvas = document.createElement('canvas'), demo = index < 12;
      canvas.width = demo ? 900 : 144; canvas.height = demo ? 600 : 96;
      const context = canvas.getContext('2d'), scale = canvas.width / 900;
      context.scale(scale, scale);
      const colors = ['#dce5cf', '#d7e6e8', '#edd8cb', '#f1dfb3', '#dfd7ee', '#d0e5d9', '#e7cdd8', '#cbd9ed'];
      context.fillStyle = colors[index % colors.length]; context.fillRect(0, 0, 900, 600);
      context.fillStyle = '#fffdf4'; context.fillRect(42, 42, 816, 516);
      context.fillStyle = ['#647d53', '#5e8490', '#aa765a', '#aa8844'][index % 4];
      context.beginPath(); context.arc(700, 166, 76, 0, Math.PI * 2); context.fill();
      context.fillStyle = '#493f32'; context.font = 'bold 41px Microsoft YaHei';
      context.fillText(['沿途的颜色', '留住这一刻', '慢慢收集灵感', '阳光落在桌上', '设计参考', '今天的小发现',
        '简单的美好', '把想法挂起来', '属于自己的节奏', '桌边的颜色', '好看的小事', '下一份灵感'][index % 12], 84, 350);
      context.font = '23px Microsoft YaHei'; context.fillText(`灵感 ${String(index + 1).padStart(3, '0')}  ·  框选后一起带走`, 86, 405);
      return canvas.toDataURL('image/png');
    }));
    const imported = [];
    for (let index = 0; index < fixtures.length; index += 1) {
      await fs.writeFile(path.join(fixtureDir, `灵感-${index + 1}.png`), Buffer.from(fixtures[index].split(',')[1], 'base64'), { flag: 'wx' });
      await hook('setClipboardImage', fixtures[index]); await hook('poll');
      const value = await poll(snapshot, state => state.counts.photos === index + 1, '测试图收集');
      imported.push(value.photos.find(item => !imported.includes(item.id)).id);
    }
    photoIds = imported;
    await rack.evaluate(() => window.rack.setPaused(true));
    let value = await apply({ type: 'group', sourceId: photoIds[1], targetId: photoIds[0] });
    mainGroupId = value.items.find(item => item.type === 'group').id;
    for (const id of photoIds.slice(2, 12)) await apply({ type: 'group', sourceId: id, targetId: mainGroupId });
    value = await apply({ type: 'group', sourceId: photoIds[13], targetId: photoIds[12] });
    otherGroupId = value.items.find(item => item.type === 'group' && item.id !== mainGroupId).id;
    await apply({ type: 'rename', groupId: mainGroupId, name: '一起带走的灵感' });
    await openGroup(mainGroupId);
    return { count: photoIds.length, mainGroupId, otherGroupId, displayedPhotos: (await getGroup()).memberIds.length };
  });

  await check('空白处真实鼠标框选两张，矩形、选中状态与已选数量一致', async () => {
    await top(); const scroll = await groupPage.locator('#groupScroll').boundingBox();
    const ids = (await getGroup()).memberIds;
    const first = await groupPage.locator(memberSelector(ids[0])).boundingBox();
    const second = await groupPage.locator(memberSelector(ids[1])).boundingBox();
    const start = { x: scroll.x + 3, y: Math.max(scroll.y + 2, first.y + 2) };
    const target = { x: second.x + second.width - 2, y: Math.min(second.y + second.height - 2, scroll.y + scroll.height - 30) };
    const hit = await groupPage.evaluate(point => ({ inScroll: !!document.elementFromPoint(point.x, point.y)?.closest('#groupScroll'),
      body: !!document.elementFromPoint(point.x, point.y)?.closest('.member-open,.wooden-clip') }), start);
    assert(hit.inScroll && !hit.body);
    await groupPage.mouse.move(start.x, start.y); await groupPage.mouse.down();
    await groupPage.mouse.move(target.x, target.y, { steps: 15 });
    await groupPage.locator('#selectionBox').waitFor({ state: 'visible' });
    await poll(selected, selectedIds => same(selectedIds, ids.slice(0, 2)), '框选前两张');
    await groupPage.screenshot({ path: path.join(artifacts, 'batch-marquee.png') });
    await groupPage.mouse.up();
    await groupPage.locator('#selectionBox').waitFor({ state: 'hidden' });
    const afterScroll = await groupPage.locator('#groupScroll').boundingBox();
    assert(Math.abs(afterScroll.y - scroll.y) < 1 && Math.abs(afterScroll.height - scroll.height) < 1,
      '显示已选数量不能移动或挤压图片浏览区');
    assert((await groupPage.locator('#selectionCount').textContent()).includes('2'));
    assert.deepEqual(await groupPage.locator('.is-selected').evaluateAll(elements => elements.map(element => element.getAttribute('aria-selected'))), ['true', 'true']);
    await groupPage.screenshot({ path: path.join(artifacts, 'batch-selection.png') });
    assert.deepEqual((await hook('organizeRuntime')).sources, []);
    return { start, target, ids: await selected(), hit, selectionBadge: await groupPage.locator('#selectionCount').textContent() };
  });

  await check('卡片间隙点击清空，Ctrl 点击增减选择，Ctrl+A 全选，Esc 先清空', async () => {
    const ids = (await getGroup()).memberIds;
    const a = await groupPage.locator(memberSelector(ids[0])).boundingBox(), b = await groupPage.locator(memberSelector(ids[1])).boundingBox();
    await groupPage.mouse.click((a.x + a.width + b.x) / 2, a.y + a.height / 2);
    await poll(selected, value => !value.length, '间隙点击清选');
    await selectIds([ids[0], ids[2]]);
    await groupPage.keyboard.down('Control');
    try { await groupPage.locator(`${memberSelector(ids[0])} .member-open`).click(); }
    finally { await groupPage.keyboard.up('Control'); }
    assert.deepEqual(await selected(), [ids[2]]);
    await groupPage.keyboard.press('Control+A'); assert.deepEqual(await selected(), ids);
    await groupPage.keyboard.press('Escape'); assert.deepEqual(await selected(), []);
    assert.equal(groupPage.isClosed(), false);
    assert.equal((await runtime()).imagePreviews.length, 0);
    return { ctrlToggle: true, selectAll: ids.length, escapeClearsBeforeClosing: true };
  });

  await check('输入组名时 Ctrl+A 仍选中文字，切换组复用窗口并清空选择', async () => {
    await groupPage.locator('#groupName').focus(); await groupPage.keyboard.press('Control+A');
    assert.deepEqual(await selected(), []);
    const inputSelection = await groupPage.locator('#groupName').evaluate(input => ({ start: input.selectionStart, end: input.selectionEnd, length: input.value.length }));
    assert.equal(inputSelection.start, 0); assert.equal(inputSelection.end, inputSelection.length);
    await groupPage.locator('#groupHelp').click();
    await selectIds((await getGroup()).memberIds.slice(0, 2));
    const id = (await hook('groupRuntime'))[0].windowId;
    await openGroup(otherGroupId); assert.deepEqual(await selected(), []);
    assert.equal((await hook('groupRuntime'))[0].windowId, id);
    await openGroup(mainGroupId); assert.deepEqual(await selected(), []);
    return { inputSelection, reusedWindowId: id, switchedGroupClearsSelection: true };
  });

  await check('纵向边缘滚动框选保留上方选择，取消和失焦恢复原选择并清理会话', async () => {
    await top(); await clearSelection();
    const ids = (await getGroup()).memberIds, scroll = await groupPage.locator('#groupScroll').boundingBox();
    await groupPage.mouse.move(scroll.x + 3, scroll.y + 3); await groupPage.mouse.down();
    await groupPage.mouse.move(scroll.x + scroll.width - 6, scroll.y + scroll.height - 2, { steps: 15 });
    const scrolled = await poll(() => groupPage.locator('#groupScroll').evaluate(element => element.scrollTop), value => value > 390, '框选边缘纵向滚动');
    await groupPage.mouse.up();
    const captured = await selected(); assert(captured.includes(ids[0])); assert(captured.length >= 6);
    await poll(() => hook('organizeRuntime'), value => !value.sources.length, '框选结束会话');
    for (const cancel of ['Escape', 'blur']) {
      await top(); await selectIds(ids.slice(0, 2)); await top();
      await groupPage.mouse.move(scroll.x + 3, scroll.y + 3); await groupPage.mouse.down();
      await groupPage.mouse.move(scroll.x + scroll.width - 6, scroll.y + Math.min(120, scroll.height - 35), { steps: 8 });
      await groupPage.locator('#selectionBox').waitFor({ state: 'visible' });
      if (cancel === 'Escape') await groupPage.keyboard.press('Escape');
      else await groupPage.evaluate(() => window.dispatchEvent(new Event('blur')));
      await groupPage.mouse.up();
      await poll(selected, value => same(value, ids.slice(0, 2)), '取消框选恢复选择');
      await groupPage.locator('#selectionBox').waitFor({ state: 'hidden' });
      assert.deepEqual((await hook('organizeRuntime')).sources, []);
    }
    return { scrollTop: scrolled, selectedAfterScroll: captured.length, preservedFirst: true, cancelRestoresSelection: true };
  });

  await check('非连续三图拖木夹批量排序，相对顺序稳定且只保存一个版本', async () => {
    await top(); const beforeGroup = await getGroup();
    const ids = [beforeGroup.memberIds[0], beforeGroup.memberIds[2], beforeGroup.memberIds[4]];
    await selectIds(ids);
    const before = await dragClip(ids[0], beforeGroup.memberIds[1]);
    const remainder = beforeGroup.memberIds.filter(id => !ids.includes(id));
    const expected = [remainder[0], ...ids, ...remainder.slice(1)];
    const after = await poll(getGroup, value => same(value.memberIds, expected), '批量稳定排序');
    assert.equal((await snapshot()).layoutRevision, before.layoutRevision + 1);
    assert.deepEqual(await selected(), ids);
    await groupPage.screenshot({ path: path.join(artifacts, 'batch-reorder.png') });
    return { before: beforeGroup.memberIds, selected: ids, after: after.memberIds, oneCommit: true };
  });

  await check('批量排序保存失败保持布局、版本与选择，随后可以重新整理', async () => {
    const beforeGroup = await getGroup(), ids = await selected();
    const bytes = await fs.readFile(path.join(profile, 'layout.json'), 'utf8');
    const before = await dragClip(ids[0], beforeGroup.memberIds[0], 'before', true);
    assert.deepEqual((await getGroup()).memberIds, beforeGroup.memberIds);
    assert.equal((await snapshot()).layoutRevision, before.layoutRevision);
    assert.deepEqual(await selected(), ids);
    assert.equal(await fs.readFile(path.join(profile, 'layout.json'), 'utf8'), bytes);
    assert((await groupPage.locator('#groupError').textContent()).includes('布局保存失败'));
    await dragClip(ids[0], beforeGroup.memberIds[0], 'before');
    const expected = [...ids, ...beforeGroup.memberIds.filter(id => !ids.includes(id))];
    assert.deepEqual((await getGroup()).memberIds, expected);
    assert.equal((await snapshot()).layoutRevision, before.layoutRevision + 1);
    assert.deepEqual(await selected(), ids);
    return { failedRevision: before.layoutRevision, layoutBytesUnchangedOnFailure: true, selectionPreserved: ids, retryOrder: expected };
  });

  await check('拖选中图片主体导出多个原图，payload 与每张原图字节一致且不修改顺序', async () => {
    const before = await snapshot(), ids = await selected();
    await dragBody(ids[0]);
    const state = await poll(runtime, value => same(value.lastNativeDrag?.ids, ids) && !value.nativeDragging, '批量原图拖出');
    const detail = await verifyFiles(state.lastNativeDrag, ids);
    assert.equal((await snapshot()).layoutRevision, before.layoutRevision);
    assert.deepEqual(await selected(), ids); assert.deepEqual((await hook('organizeRuntime')).sources, []);
    return { ...detail, layoutUnchanged: true };
  });

  await check('批量拖出结束后无需再次按鼠标，键盘 Enter 仍可打开当前原图', async () => {
    const id = (await selected())[0], before = (await runtime()).lastNativeDrag;
    const opened = application.waitForEvent('window');
    await groupPage.locator(`${memberSelector(id)} .member-open`).focus();
    await groupPage.keyboard.press('Enter');
    const preview = await opened; observe(preview);
    await preview.waitForFunction(() => document.getElementById('previewImage')?.naturalWidth > 0);
    assert.deepEqual((await runtime()).lastNativeDrag, before);
    const closed = preview.waitForEvent('close'); await preview.evaluate(() => window.rack.closePreview()); await closed;
    await groupPage.bringToFront();
    return { id, keyboardActivationPreserved: true, noAdditionalNativeDrag: true };
  });

  await check('原图准备较慢时先松手或按 Esc，迟到结果不启动拖放也不误开原图', async () => {
    const ids = (await getGroup()).memberIds.slice(0, 2), results = [];
    for (const cancel of ['pointerup', 'Escape']) {
      await selectIds(ids); await top(); await groupPage.bringToFront();
      const previous = (await runtime()).lastNativeDrag, before = await snapshot();
      await holdSlowPreparation();
      try {
        const box = await groupPage.locator(`${memberSelector(ids[0])} .member-open`).boundingBox();
        await groupPage.mouse.move(box.x + box.width * .3, box.y + box.height * .4); await groupPage.mouse.down();
        await poll(() => application.evaluate(({ app }) => !!app.__batchSmokePrepareGate?.entered), Boolean, '原图准备延迟屏障');
        await groupPage.mouse.move(box.x + box.width * .3 + 60, box.y + box.height * .4 + 20, { steps: 10 });
        if (cancel === 'Escape') await groupPage.keyboard.press('Escape');
        await groupPage.mouse.up();
      } finally { await restoreSlowPreparation(); }
      await delay(300);
      const after = await runtime();
      assert.equal(after.nativeDragging, false); assert.deepEqual(after.lastNativeDrag, previous);
      assert.equal(after.imagePreviews.length, 0); assert.equal((await snapshot()).layoutRevision, before.layoutRevision);
      assert.deepEqual(await selected(), ids); assert.deepEqual((await hook('organizeRuntime')).sources, []);
      results.push({ cancel, nativePayloadUnchanged: true, noPreviewOpened: true });
    }
    return results;
  });

  await check('拖未选中图片仍走单图原图导出，普通点击仍打开原图', async () => {
    const group = await getGroup(), chosen = (await selected())[0];
    const id = group.memberIds.find(id => !(group.memberIds.indexOf(id) >= 1 && group.memberIds.indexOf(id) <= 3) && id !== chosen);
    const before = await snapshot(); await dragBody(id);
    const state = await poll(runtime, value => value.lastNativeDrag?.id === id && !value.lastNativeDrag.ids && !value.nativeDragging, '未选中单图拖出');
    assert.equal(state.lastNativeDrag.nativeCalled, false); assert.equal((await snapshot()).layoutRevision, before.layoutRevision);
    await clearSelection(); await delay(650);
    const opened = application.waitForEvent('window'); await groupPage.locator(`${memberSelector(id)} .member-open`).click();
    const preview = await opened; observe(preview);
    await preview.waitForFunction(() => document.getElementById('previewImage')?.naturalWidth > 0);
    const dimensions = await preview.locator('#previewImage').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
    assert.equal(dimensions.width, 900); assert.equal(dimensions.height, 600);
    const closed = preview.waitForEvent('close'); await preview.evaluate(() => window.rack.closePreview()); await closed;
    await groupPage.bringToFront();
    return { id, singlePayload: state.lastNativeDrag, previewDimensions: dimensions };
  });

  await check('当前组权限拒绝组外、重复、空数组及错误 frame，批量排序拒绝错误锚点', async () => {
    const group = await getGroup(), ids = group.memberIds.slice(0, 2), before = await snapshot();
    const invalidBatches = [[], [ids[0], ids[0]], [ids[0], photoIds[14]], ['not-a-photo']];
    const errors = [];
    for (const values of invalidBatches) errors.push(await rejected('preparePhotoBatch', values));
    for (const operation of [
      { type: 'move-many', groupId: otherGroupId, ids, beforeId: null },
      { type: 'move-many', groupId: mainGroupId, ids, beforeId: ids[0] },
      { type: 'move-many', groupId: mainGroupId, ids: [ids[0], photoIds[14]], beforeId: null },
    ]) errors.push(await rejected('applyLayout', operation));
    assert(errors.every(Boolean));
    const frameError = await application.evaluate(async ({ BrowserWindow, ipcMain }, ids) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/group.html'));
      const handler = ipcMain._invokeHandlers.get('group:prepare-batch-drag');
      try { await handler({ sender: window.webContents, senderFrame: {} }, ids); return null; }
      catch (error) { return error.message; }
    }, ids);
    assert(frameError?.includes('不允许'));
    assert.equal((await snapshot()).layoutRevision, before.layoutRevision);
    return { errors, frameError, noLayoutCommit: true };
  });

  await check('批量拖出准备后切换组，重新授权拒绝旧组且清理原生状态', async () => {
    await openGroup(mainGroupId); const ids = (await getGroup()).memberIds.slice(0, 2);
    await groupPage.evaluate(ids => window.groupBrowser.preparePhotoBatch(ids), ids);
    const previous = (await runtime()).lastNativeDrag;
    await hook('holdNextBatchDragPreparation');
    await groupPage.evaluate(ids => window.groupBrowser.dragPhotos(ids), ids);
    await poll(() => hook('batchDragPreparationPending'), Boolean, '批量准备屏障');
    assert.equal((await runtime()).nativeDragging, true);
    // 只验证拒绝路径：已进入原生拖动时，非首张图片也必须受保护，不能触碰文件。
    const photoCount = (await snapshot()).counts.photos;
    await assert.rejects(hook('deletePhoto', ids[1]), /先完成图片拖放/);
    assert.equal((await snapshot()).counts.photos, photoCount);
    assert((await snapshot()).photos.some(photo => photo.id === ids[1]));
    await openGroup(otherGroupId); await hook('releaseBatchDragPreparation');
    await poll(runtime, value => !value.nativeDragging, '切组后拖动清理');
    assert.deepEqual((await runtime()).lastNativeDrag, previous);
    assert.deepEqual((await hook('organizeRuntime')).sources, []);
    await openGroup(mainGroupId);
    return { rejectedStaleGroup: true, previousPayloadPreserved: true, nonFirstPhotoDeleteBlocked: true };
  });

  await check('批量拖出准备后移出成员，拒绝旧成员且保留原图', async () => {
    const ids = (await getGroup()).memberIds.slice(0, 2), previous = (await runtime()).lastNativeDrag;
    await hook('holdNextBatchDragPreparation');
    await groupPage.evaluate(ids => window.groupBrowser.dragPhotos(ids), ids);
    await poll(() => hook('batchDragPreparationPending'), Boolean, '成员移出准备屏障');
    const before = await snapshot(); await apply({ type: 'remove', groupId: mainGroupId, id: ids[1] });
    await hook('releaseBatchDragPreparation'); await poll(runtime, value => !value.nativeDragging, '成员移出后原生清理');
    assert.deepEqual((await runtime()).lastNativeDrag, previous);
    assert.equal((await snapshot()).counts.photos, before.counts.photos);
    await apply({ type: 'group', sourceId: ids[1], targetId: mainGroupId });
    await poll(getGroup, value => value.memberIds.includes(ids[1]), '移出图片重新入组');
    return { removedId: ids[1], staleExportRejected: true, originalCountPreserved: before.counts.photos };
  });

  await check('框选和木夹整理暂停自动隐藏，结束后恢复，组窗口本身不阻止隐藏', async () => {
    await top(); await clearSelection();
    const state = await runtime(), bounds = state.expandedBounds;
    const inside = { x: bounds.x + 60, y: bounds.y + 100 }, outside = { x: bounds.x + 60, y: bounds.y + bounds.height + 60 };
    await hook('setAutoHideCursor', inside); await rack.evaluate(() => window.rack.setAutoHideSpeed('medium'));
    await rack.evaluate(() => window.rack.setAutoHide(true));
    const scroll = await groupPage.locator('#groupScroll').boundingBox();
    await groupPage.mouse.move(scroll.x + 3, scroll.y + 3); await groupPage.mouse.down();
    await groupPage.mouse.move(scroll.x + scroll.width / 2, scroll.y + 90, { steps: 8 });
    await groupPage.locator('#selectionBox').waitFor({ state: 'visible' });
    await poll(() => hook('organizeRuntime'), value => value.sources.includes('group'), '框选暂停会话');
    const held = await hook('autoHideTick', outside, 1500); assert.equal(held.suspended, true); assert.equal(held.collapsed, false);
    await groupPage.mouse.up(); await poll(() => hook('organizeRuntime'), value => !value.sources.length, '框选释放');
    await hook('autoHideTick', outside); const resumed = await hook('autoHideTick', outside, 1100);
    assert.equal(resumed.collapsed, true); assert.equal((await hook('groupRuntime')).length, 1);
    await rack.evaluate(() => window.rack.setAutoHide(false)); await hook('restore'); await groupPage.bringToFront();
    return { held, resumed, groupRemainedOpen: true };
  });

  await check('102 张图片可框选全选，超过 100 张阻止批量拖出和排序并显示提示', async () => {
    for (const id of photoIds.slice(16)) await apply({ type: 'group', sourceId: id, targetId: mainGroupId });
    await poll(getGroup, value => value.memberIds.length === 102, '102 张图片组');
    await clearSelection(); await top(); await groupPage.locator('#groupHelp').click(); await groupPage.keyboard.press('Control+A');
    assert.equal((await selected()).length, 102);
    const previous = (await runtime()).lastNativeDrag, before = await snapshot(), group = await getGroup();
    await dragBody(group.memberIds[0]);
    const error = await poll(() => groupPage.locator('#groupError').textContent(), text => text.includes('100'), '超过 100 张提示');
    assert.deepEqual((await runtime()).lastNativeDrag, previous); assert.equal((await runtime()).nativeDragging, false);
    assert.equal((await runtime()).imagePreviews.length, 0, '超限拖放不能尾随误开原图窗口');
    assert.equal((await snapshot()).layoutRevision, before.layoutRevision);
    assert.equal((await selected()).length, 102);
    const invalid = await rejected('preparePhotoBatch', group.memberIds); assert(invalid?.includes('100'));
    const invalidSort = await rejected('applyLayout', { type: 'move-many', groupId: mainGroupId, ids: group.memberIds, beforeId: null });
    assert(invalidSort?.includes('100'));
    await groupPage.keyboard.press('Escape'); assert.deepEqual(await selected(), []);
    return { selectedCount: 102, error, invalid, invalidSort, nativePayloadUnchanged: true };
  });

  await check('便签组保持原有编辑和木夹操作，批量图片 API 拒绝便签', async () => {
    const ids = [];
    for (let index = 0; index < 2; index += 1) {
      const pending = application.waitForEvent('window'); await rack.evaluate(() => window.rack.addNote());
      const page = await pending; observe(page);
      assert(page.url().endsWith('/note.html'), `新增便签返回意外窗口：${page.url()}`);
      await page.waitForFunction(() => document.getElementById('noteInput') && !document.getElementById('noteInput').disabled);
      await page.locator('#noteInput').fill(['写下今天的灵感\n便签不参与图片框选', '要记得的小事\n按自己的节奏整理'][index]);
      const closed = page.waitForEvent('close'); await page.locator('#noteCloseButton').click(); await closed;
      const notes = await poll(() => hook('notes'), values => values.length === index + 1, '测试便签保存');
      ids.push(notes.find(note => !ids.includes(note.id)).id);
    }
    noteIds = ids;
    const value = await apply({ type: 'group', sourceId: ids[1], targetId: ids[0] });
    noteGroupId = value.items.find(item => item.type === 'group' && item.kind === 'note').id;
    await openGroup(noteGroupId); assert.deepEqual(await selected(), []);
    assert.equal(await groupPage.locator('#groupSelectionTools').isVisible(), false);
    const batchError = await rejected('preparePhotoBatch', ids); assert(batchError?.includes('图片组'));
    const sortError = await rejected('applyLayout', { type: 'move-many', groupId: noteGroupId, ids, beforeId: null });
    assert(sortError);
    const fontSizes = await groupPage.locator('.note-summary').evaluateAll(elements => elements.map(element => getComputedStyle(element).fontSize));
    assert.deepEqual(fontSizes, ['14px', '14px']);
    return { noteIds, batchError, sortError, fontSizes, selectionToolsHidden: true };
  });

  await check('关闭等待中的批量拖动安全清理，重启保留顺序且不保存临时选择', async () => {
    await openGroup(mainGroupId); const ids = (await getGroup()).memberIds.slice(0, 2);
    await selectIds(ids); const beforeGroup = await getGroup(), before = await snapshot(), previous = (await runtime()).lastNativeDrag;
    await hook('holdNextBatchDragPreparation'); await groupPage.evaluate(ids => window.groupBrowser.dragPhotos(ids), ids);
    await poll(() => hook('batchDragPreparationPending'), Boolean, '关闭窗口准备屏障');
    const closed = groupPage.waitForEvent('close'); await groupPage.evaluate(() => window.groupBrowser.close()); await closed;
    await hook('releaseBatchDragPreparation'); await poll(runtime, state => !state.nativeDragging, '关闭后原生拖动清理');
    assert.deepEqual((await runtime()).lastNativeDrag, previous); assert.deepEqual((await hook('organizeRuntime')).sources, []);
    const layout = await fs.readFile(path.join(profile, 'layout.json'), 'utf8');
    assert.equal(layout.includes('selected'), false);
    await closeApplication(); await launch(); await openGroup(mainGroupId);
    assert.deepEqual((await getGroup()).memberIds, beforeGroup.memberIds); assert.deepEqual(await selected(), []);
    assert.equal((await snapshot()).layoutRevision, before.layoutRevision);
    assert.equal(await fs.readFile(path.join(profile, 'layout.json'), 'utf8'), layout);
    assert.deepEqual((await snapshot()).counts, { photos: 106, notes: 2, groups: 3 });
    return { orderRetained: true, noSelectionInLayout: true, noFilesDeleted: true, counts: (await snapshot()).counts };
  });

  await check('所有页面无异常且不暴露 Node 权限，实际截图与隔离测试资料已保留', async () => {
    assert.deepEqual(report.pageErrors, []);
    const sandbox = await groupPage.evaluate(() => ({ require: typeof window.require, process: typeof window.process, scale: devicePixelRatio }));
    assert.equal(sandbox.require, 'undefined'); assert.equal(sandbox.process, 'undefined');
    return { sandbox, artifacts, screenshots: ['batch-marquee.png', 'batch-selection.png', 'batch-reorder.png'], isolatedProfile: profile };
  });
}

run().then(() => { report.passed = true; }).catch(error => {
  report.passed = false; report.error = error.stack; process.exitCode = 1; console.error(error);
  console.error(diagnostics.join('').slice(-7000));
}).finally(async () => {
  if (application) await closeApplication().catch(error => { report.closeError = error.message; });
  report.testCount = report.tests.length; report.diagnostics = diagnostics;
  await persistReport(); console.log(`图片组批量拖动验证记录：${path.join(artifacts, 'verification.json')}`);
});
