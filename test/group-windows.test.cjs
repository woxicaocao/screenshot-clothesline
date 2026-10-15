'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { GroupWindows } = require('../src/lib/group-windows.cjs');

function setup() {
  const windows = [], operations = [], opened = [], prepared = [], drags = [], menus = [], groupMenus = [], organized = [];
  const preparedBatches = [], batchDrags = [];
  const groups = new Map([
    ['group-a', { type: 'group', id: 'group-a', kind: 'photo', name: '图片组 1', items: [{ type: 'photo', id: 'p1' }, { type: 'photo', id: 'p2' }] }],
    ['group-b', { type: 'group', id: 'group-b', kind: 'note', name: '便签组 1', items: [{ type: 'note', id: 'n1' }, { type: 'note', id: 'n2' }] }],
  ]);
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.id = windows.length + 1; this.options = options;
      this.destroyed = false; this.visible = false; this.messages = []; this.alwaysOnTop = options.alwaysOnTop;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      this.webContents.send = (...args) => this.messages.push(args);
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    loadFile(file) { this.file = file; return Promise.resolve(); }
    show() { this.visible = true; }
    focus() { this.focused = true; }
    setTitle(title) { this.title = title; }
    setAlwaysOnTop(value) { this.alwaysOnTop = value; }
    isAlwaysOnTop() { return this.alwaysOnTop; }
    isVisible() { return this.visible; }
    getBounds() { return { x: this.options.x, y: this.options.y, width: this.options.width, height: this.options.height }; }
    close() { this.destroy(); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const manager = new GroupWindows({ BrowserWindow: FakeWindow,
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }) },
    rendererDir: 'renderer', preload: 'group-preload', getRackBounds: () => ({ x: 100, y: 30, width: 1400, height: 240 }),
    getGroup: id => groups.get(id) || null, onApply: async operation => { operations.push(operation); return { saved: true }; },
    onOpenItem: item => opened.push(item), onPreparePhotoDrag: id => prepared.push(id),
    onDragPhoto: (contents, id) => drags.push({ contents, id }),
    onPreparePhotoBatch: ids => preparedBatches.push(ids),
    onDragPhotos: (contents, ids, validate) => { validate(); batchDrags.push({ contents, ids }); },
    onMemberMenu: (groupId, id, owner) => menus.push({ groupId, id, owner }),
    onGroupMenu: (groupId, owner) => groupMenus.push({ groupId, owner }), onOrganizeActive: active => organized.push(active) });
  const event = () => ({ sender: manager.entry.window.webContents, senderFrame: manager.entry.window.webContents.mainFrame });
  return { manager, windows, groups, operations, opened, prepared, drags, menus, groupMenus, organized,
    preparedBatches, batchDrags, event };
}

test('组浏览窗口按需单例复用，关闭后销毁，打开时不暂停衣架自动隐藏', async () => {
  const { manager, windows, organized, event } = setup();
  await manager.open('group-a');
  assert.equal(windows.length, 1); assert.equal(windows[0].options.alwaysOnTop, false);
  assert.equal(windows[0].options.titleBarStyle, 'hidden');
  assert.deepEqual(windows[0].options.titleBarOverlay, { color: '#f5f3ec', symbolColor: '#5e6557', height: 40 });
  assert.equal(windows[0].options.resizable, true);
  assert.equal(manager.get(event()).id, 'group-a');
  assert.deepEqual(organized, []);
  const result = manager.get(event()); result.items.length = 0;
  assert.equal(manager.get(event()).items.length, 2);
  await manager.open('group-b', { rename: true });
  assert.equal(windows.length, 1); assert.equal(manager.get(event()).id, 'group-b');
  assert.deepEqual(organized, [], '切换组也不改变衣架自动隐藏计时');
  assert.ok(windows[0].messages.some(([channel]) => channel === 'group:focus-name'));
  manager.close(event()); assert.equal(windows[0].destroyed, true); assert.deepEqual(manager.runtime(), []);
  await manager.open('group-a'); assert.equal(windows.length, 2);
});

test('组窗口禁止子frame和其他窗口操作，成员操作只限当前组', async () => {
  const { manager, operations, event } = setup(); await manager.open('group-a');
  assert.throws(() => manager.get({ ...event(), senderFrame: {} }), /不允许/);
  assert.throws(() => manager.get({ ...event(), sender: {} }), /不允许/);
  assert.throws(() => manager.openItem(event(), 'n1'), /当前组/);
  await assert.rejects(manager.preparePhotoDrag(event(), 'n1'), /当前组/);
  const invalid = [
    { type: 'move', groupId: 'group-b', id: 'p1', beforeId: 'p2' },
    { type: 'move', groupId: 'group-a', id: 'p1', beforeId: 'n1' },
    { type: 'remove', groupId: 'group-a', id: 'n1' },
    { type: 'dissolve', groupId: 'group-a' },
    { type: 'create-group', groupId: 'group-a', id: 'p1', targetId: 'p2' },
  ];
  for (const operation of invalid) await assert.rejects(manager.apply(event(), operation), /当前|只能/);
  assert.equal(operations.length, 0);
  await manager.apply(event(), { type: 'move', groupId: 'group-a', id: 'p1', beforeId: null, dangerous: true });
  assert.deepEqual(operations, [{ type: 'move', id: 'p1', beforeId: null, groupId: 'group-a' }]);
  await manager.open('group-b');
  await assert.rejects(manager.preparePhotoDrag(event(), 'n1'), /当前组/);
});

test('组窗口点击、原图拖出和原生菜单传递经过校验的成员', async () => {
  const { manager, windows, opened, prepared, drags, menus, event } = setup(); await manager.open('group-a');
  manager.openItem(event(), 'p1'); await manager.preparePhotoDrag(event(), 'p1');
  await manager.dragPhoto(event(), 'p2'); manager.memberMenu(event(), 'p1');
  assert.deepEqual(opened, [{ type: 'photo', id: 'p1' }]); assert.deepEqual(prepared, ['p1']);
  assert.equal(drags[0].contents, windows[0].webContents); assert.equal(drags[0].id, 'p2');
  assert.deepEqual(menus, [{ groupId: 'group-a', id: 'p1', owner: windows[0] }]);
  assert.ok(windows[0].messages.some(([channel]) => channel === 'rack:photo-drag-ended'));
});

test('失焦和取消释放整理状态；保存失败原顺序保留，组消失时面板关闭', async () => {
  const { manager, windows, groups, organized, event } = setup(); await manager.open('group-a');
  manager.setOrganizeActive(event(), true); windows[0].emit('blur');
  assert.deepEqual(organized.slice(-2), [true, false]);
  manager.onApply = async () => { throw new Error('磁盘不可写'); };
  await assert.rejects(manager.apply(event(), { type: 'move', groupId: 'group-a', id: 'p1', beforeId: null }), /磁盘不可写/);
  assert.deepEqual(manager.get(event()).items.map(item => item.id), ['p1', 'p2']);
  assert.equal(windows[0].destroyed, false);
  groups.delete('group-a'); manager.publish(); assert.equal(windows[0].destroyed, true);
});

test('组取消后的卸载清理不报错，迟到的旧窗口清理不解除新窗口整理', async () => {
  const { manager, groups, organized, event } = setup(); await manager.open('group-a');
  const oldEvent = event();
  manager.setOrganizeActive(oldEvent, true); groups.delete('group-a');
  assert.doesNotThrow(() => manager.setOrganizeActive(oldEvent, false));
  assert.equal(organized.at(-1), false);
  assert.throws(() => manager.setOrganizeActive(oldEvent, true), /已经取消/);
  manager.publish();
  assert.doesNotThrow(() => manager.setOrganizeActive(oldEvent, false));
  await manager.open('group-b'); manager.setOrganizeActive(event(), true);
  manager.setOrganizeActive(oldEvent, false);
  assert.equal(organized.at(-1), true); assert.equal(manager.runtime()[0].organizing, true);
  manager.setOrganizeActive(event(), false);
});

test('原图拖出准备完成后重新验证当前组与成员', async () => {
  const { manager, groups, event } = setup(); await manager.open('group-a');
  let complete;
  manager.onPreparePhotoDrag = () => new Promise(resolve => { complete = resolve; });
  const preparing = manager.preparePhotoDrag(event(), 'p1');
  groups.get('group-a').items = [{ type: 'photo', id: 'p2' }]; complete();
  await assert.rejects(preparing, /当前组/);
});

test('组管理菜单校验当前主frame，切换组后仅管理当前组，并结束整理', async () => {
  const { manager, windows, groups, groupMenus, organized, event } = setup();
  await manager.open('group-a');
  assert.throws(() => manager.menu({ ...event(), sender: {} }), /不允许/);
  assert.throws(() => manager.menu({ ...event(), senderFrame: {} }), /不允许/);
  manager.setOrganizeActive(event(), true); manager.menu(event());
  assert.equal(organized.at(-1), false);
  assert.deepEqual(groupMenus, [{ groupId: 'group-a', owner: windows[0] }]);
  await manager.open('group-b'); manager.menu(event());
  assert.deepEqual(groupMenus.at(-1), { groupId: 'group-b', owner: windows[0] });
  groups.delete('group-b');
  assert.throws(() => manager.menu(event()), /已经取消/);
});

test('组窗口独立置顶验证boolean和请求来源，复用保留状态，关闭重开恢复默认', async () => {
  const { manager, windows, groups, event } = setup(); await manager.open('group-a');
  assert.equal(manager.get(event()).alwaysOnTop, false);
  assert.throws(() => manager.setAlwaysOnTop(event(), 'true'), /置顶状态无效/);
  assert.throws(() => manager.setAlwaysOnTop({ ...event(), senderFrame: {} }, true), /不允许/);
  assert.throws(() => manager.setAlwaysOnTop({ ...event(), sender: {} }, true), /不允许/);
  assert.equal(manager.setAlwaysOnTop(event(), true), true);
  assert.equal(manager.get(event()).alwaysOnTop, true);
  assert.equal(manager.runtime()[0].alwaysOnTop, true);
  assert.equal(groups.get('group-a').alwaysOnTop, undefined, '原组数据不写入窗口状态');
  assert.equal(windows[0].messages.at(-1)[1].alwaysOnTop, true);
  await manager.open('group-b'); assert.equal(manager.get(event()).alwaysOnTop, true);
  assert.equal(manager.setAlwaysOnTop(event(), false), false);
  assert.equal(manager.setAlwaysOnTop(event(), true), true);
  const oldEvent = event(); manager.close(oldEvent); await manager.open('group-a');
  assert.equal(manager.get(event()).alwaysOnTop, false);
  assert.throws(() => manager.setAlwaysOnTop(oldEvent, true), /不允许/);
});

test('置顶接口返回系统实际状态而非请求值，原生异常不伪装成功', async () => {
  const { manager, windows, event } = setup(); await manager.open('group-a');
  windows[0].setAlwaysOnTop = () => {};
  assert.equal(manager.setAlwaysOnTop(event(), true), false);
  assert.equal(manager.get(event()).alwaysOnTop, false);
  assert.equal(windows[0].messages.at(-1)[1].alwaysOnTop, false);
  windows[0].setAlwaysOnTop = () => { throw new Error('native failure'); };
  assert.throws(() => manager.setAlwaysOnTop(event(), true), /native failure/);
});

test('批量原图准备与拖出按组原序归一化并在结束后通知当前窗口', async () => {
  const { manager, windows, preparedBatches, batchDrags, organized, event } = setup();
  await manager.open('group-a');
  assert.equal(await manager.preparePhotoBatch(event(), ['p2', 'p1']), true);
  assert.deepEqual(preparedBatches, [['p1', 'p2']]);
  manager.setOrganizeActive(event(), true);
  await manager.dragPhotos(event(), ['p2', 'p1']);
  assert.deepEqual(batchDrags, [{ contents: windows[0].webContents, ids: ['p1', 'p2'] }]);
  assert.equal(organized.at(-1), false);
  assert.ok(windows[0].messages.some(([channel]) => channel === 'rack:photo-drag-ended'));
});

test('批量接口拒绝非主frame、其他窗口、空重复跨组便签和超过100项', async () => {
  const { manager, groups, preparedBatches, batchDrags, event } = setup(); await manager.open('group-a');
  for (const invalidEvent of [{ ...event(), sender: {} }, { ...event(), senderFrame: {} }]) {
    await assert.rejects(manager.preparePhotoBatch(invalidEvent, ['p1']), /不允许/);
    await assert.rejects(manager.dragPhotos(invalidEvent, ['p1']), /不允许/);
  }
  for (const invalid of [null, [], 'p1', ['p1', 'p1'], [null], ['p1', 'n1'], ['not-a-member']]) {
    await assert.rejects(manager.preparePhotoBatch(event(), invalid));
    await assert.rejects(manager.dragPhotos(event(), invalid));
  }
  groups.get('group-a').items = Array.from({ length: 101 }, (_, i) => ({ type: 'photo', id: `p${i + 1}` }));
  const hundred = groups.get('group-a').items.slice(0, 100).map(item => item.id);
  await manager.preparePhotoBatch(event(), [...hundred].reverse());
  assert.deepEqual(preparedBatches[0], hundred);
  await assert.rejects(manager.preparePhotoBatch(event(), groups.get('group-a').items.map(item => item.id)), /100/);
  await manager.open('group-b');
  await assert.rejects(manager.preparePhotoBatch(event(), ['n1']), /当前图片组/);
  await assert.rejects(manager.dragPhotos(event(), ['n1']), /当前图片组/);
  assert.equal(preparedBatches.length, 1); assert.equal(batchDrags.length, 0);
});

test('组内批量排序仅转发当前图片组的稳定成员顺序和安全字段', async () => {
  const { manager, operations, event } = setup(); await manager.open('group-a');
  await manager.apply(event(), { type: 'move-many', groupId: 'group-a', ids: ['p2', 'p1'], beforeId: null, extra: 'ignored' });
  assert.deepEqual(operations, [{ type: 'move-many', groupId: 'group-a', ids: ['p1', 'p2'], beforeId: null }]);
  for (const operation of [
    { type: 'move-many', groupId: null, ids: ['p1'], beforeId: null },
    { type: 'move-many', groupId: 'group-b', ids: ['p1'], beforeId: null },
    { type: 'move-many', groupId: 'group-a', ids: ['p1'], beforeId: 'p1' },
    { type: 'move-many', groupId: 'group-a', ids: ['p1'], beforeId: 'n1' },
    { type: 'move-many', groupId: 'group-a', ids: [], beforeId: null },
    { type: 'move-many', groupId: 'group-a', ids: ['p1', 'p1'], beforeId: null },
    { type: 'move-many', groupId: 'group-a', ids: ['n1'], beforeId: null },
  ]) await assert.rejects(manager.apply(event(), operation));
  await manager.open('group-b');
  await assert.rejects(manager.apply(event(), { type: 'move-many', groupId: 'group-b', ids: ['n1'], beforeId: null }), /当前图片组/);
  assert.equal(operations.length, 1);
});

test('批量准备期间移出成员、切组或关闭会撤销请求，不能使用迟到结果', async () => {
  for (const mutate of [
    async ({ groups }) => { groups.get('group-a').items = [{ type: 'photo', id: 'p2' }]; },
    async ({ manager }) => { await manager.open('group-b'); },
    async ({ manager }) => { manager.close(); },
    async ({ manager }) => { await manager.open('group-b'); await manager.open('group-a'); },
  ]) {
    const context = setup(); const { manager, event } = context; await manager.open('group-a');
    let release; manager.onPreparePhotoBatch = () => new Promise(resolve => { release = resolve; });
    const input = ['p1', 'p2'];
    const pending = manager.preparePhotoBatch(event(), input); input[0] = 'n1';
    await mutate(context); release();
    await assert.rejects(pending, /当前图片组|已切换|不允许/);
  }
});

test('批量拖出在准备完成到startDrag前同步重验，移出、切组、关闭均不导出', async () => {
  for (const mutate of [
    async ({ groups }) => { groups.get('group-a').items = [{ type: 'photo', id: 'p2' }]; },
    async ({ manager }) => { await manager.open('group-b'); },
    async ({ manager }) => { manager.close(); },
    async ({ manager }) => { await manager.open('group-b'); await manager.open('group-a'); },
  ]) {
    const context = setup(); const { manager, windows, event } = context; await manager.open('group-a');
    let release, started = false;
    manager.onDragPhotos = async (contents, ids, validate) => {
      await new Promise(resolve => { release = resolve; });
      assert.equal(validate.constructor, Function, 'validator必须同步');
      validate(); started = true;
    };
    const oldMessages = windows[0].messages.length;
    const originalScope = manager.entry.batchScope;
    const input = ['p2', 'p1'];
    const pending = manager.dragPhotos(event(), input); input[0] = 'n1';
    await mutate(context);
    const shouldNotify = manager.entry?.window === windows[0] && manager.entry?.groupId === 'group-a'
      && manager.entry?.batchScope === originalScope && !windows[0].destroyed;
    release();
    await assert.rejects(pending, /当前图片组|已切换|不允许/);
    assert.equal(started, false);
    assert.equal(windows[0].messages.slice(oldMessages).some(([channel]) => channel === 'rack:photo-drag-ended'), shouldNotify);
  }
});

test('批量导出准备失败会结束当前拖动，迟到旧窗口不会影响新窗口', async () => {
  const { manager, windows, event } = setup(); await manager.open('group-a');
  manager.onDragPhotos = async () => { throw new Error('原图不可读'); };
  await assert.rejects(manager.dragPhotos(event(), ['p1', 'p2']), /原图不可读/);
  assert.equal(windows[0].messages.at(-1)[0], 'rack:photo-drag-ended');
  let release;
  manager.onDragPhotos = async (contents, ids, validate) => { await new Promise(resolve => { release = resolve; }); validate(); };
  const pending = manager.dragPhotos(event(), ['p1', 'p2']);
  manager.close(); await manager.open('group-a');
  const messageCount = windows[1].messages.length; release();
  await assert.rejects(pending, /不允许/);
  assert.equal(windows[1].messages.length, messageCount);
});
