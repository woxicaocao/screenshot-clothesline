'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { NoteWindows } = require('../src/lib/note-windows.cjs');
const { AutoHideController } = require('../src/lib/auto-hide.cjs');
const { normalizeNoteInput, DEFAULT_NOTE } = require('../src/lib/notes-repository.cjs');

const NOTE_A = 'note-11111111-1111-4111-8111-111111111111';
const NOTE_B = 'note-22222222-2222-4222-8222-222222222222';
const clone = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
const payload = (text, extra = {}) => ({ text, ...DEFAULT_NOTE, ...extra });
const storedNote = (id, text, extra = {}) => ({ ...payload(text, extra), id,
  createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z' });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(t, { notes = [], delayLoad = false, onSuspend = () => {} } = {}) {
  const windows = [], changes = [], suspensions = [], errors = [], calls = [], deleteCalls = [];
  const records = notes.map(clone);
  let sequence = 0;
  const repository = {
    saveHandler: null,
    deleteHandler: null,
    getNote(id) { return clone(records.find(note => note.id === id) ?? null); },
    saveNote(input) {
      const normalized = normalizeNoteInput(input);
      calls.push(clone(normalized));
      // 故意允许同步抛错，验证窗口在磁盘层同步或异步失败后都能重试。
      const pending = repository.saveHandler?.(normalized);
      return Promise.resolve(pending).then(() => {
        const previous = normalized.id ? records.find(note => note.id === normalized.id) : null;
        if (normalized.id && !previous) throw new Error('这张便签不存在。');
        if (!previous && !normalized.text.trim()) return null;
        const id = previous?.id ?? `note-aaaaaaaa-aaaa-4aaa-8aaa-${String(++sequence).padStart(12, '0')}`;
        const note = storedNote(id, normalized.text, normalized);
        const index = records.findIndex(item => item.id === id);
        if (index >= 0) records[index] = note; else records.push(note);
        return { note: clone(note), added: !previous };
      });
    },
    deleteNote(id) {
      deleteCalls.push(id);
      const pending = repository.deleteHandler?.(id);
      return Promise.resolve(pending).then(() => {
        const index = records.findIndex(note => note.id === id);
        if (index < 0) return { id, deleted: false };
        records.splice(index, 1);
        return { id, deleted: true };
      });
    },
  };

  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.id = windows.length + 1; this.options = options;
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.visible = false; this.top = Boolean(options.alwaysOnTop); this.destroyed = false;
      this.focusCount = 0; this.sent = []; this.load = deferred();
      this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      this.webContents.send = (...args) => { this.sent.push(args); this.webContents.emit('sent', ...args); };
      windows.push(this);
      if (!delayLoad) this.load.resolve();
    }
    loadFile(file) { this.file = file; return this.load.promise; }
    isDestroyed() { return this.destroyed; }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) { this.bounds = { ...bounds }; this.emit('move'); this.emit('resize'); }
    show() { this.visible = true; }
    focus() { this.focusCount++; }
    isVisible() { return this.visible && !this.destroyed; }
    setAlwaysOnTop(value) { this.top = value; }
    isAlwaysOnTop() { return this.top; }
    close() {
      let prevented = false;
      this.emit('close', { preventDefault() { prevented = true; } });
      if (!prevented) this.destroy();
      return prevented;
    }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.visible = false; this.emit('closed'); } }
  }

  const manager = new NoteWindows({ BrowserWindow: FakeBrowserWindow,
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    repository, rendererDir: 'renderer', preload: 'preload.cjs', icon: 'app.ico',
    getRackBounds: () => ({ x: 100, y: 50, width: 1680, height: 260 }),
    onChange: result => changes.push(result), onError: error => errors.push(error),
    suspend: (reason, active) => { suspensions.push({ reason, active }); onSuspend(active); } });
  const eventFor = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  t.after(() => {
    for (const entry of manager.entries.values()) {
      if (entry.flush) entry.flush.promise.catch(() => {});
      entry.window.destroy();
    }
  });
  return { manager, windows, repository, records, calls, deleteCalls, changes, suspensions, errors, eventFor };
}

test('新便签可并行打开，已有便签加载中再次打开复用原窗口', async t => {
  const { manager, windows, suspensions } = setup(t, { notes: [storedNote(NOTE_A, '已有便签')], delayLoad: true });
  const first = manager.open(), second = manager.open();
  assert.equal(windows.length, 2);
  assert.equal(manager.runtime().length, 2);
  assert.equal(windows.every(window => !window.visible), true);
  windows[0].load.resolve(); windows[1].load.resolve();
  await Promise.all([first, second]);
  assert.equal(windows.every(window => window.visible), true);
  assert.notDeepEqual(windows[0].bounds, windows[1].bounds);
  const opening = manager.open(NOTE_A), repeated = manager.open(NOTE_A);
  assert.equal(windows.length, 3);
  windows[2].load.resolve();
  await Promise.all([opening, repeated]);
  assert.equal(windows[2].focusCount, 2);
  assert.equal(manager.runtime().filter(entry => entry.noteId === NOTE_A).length, 1);
  assert.deepEqual(suspensions, [], '打开、加载或复用便签窗口不暂停衣架自动隐藏');
  windows[2].destroy();
  assert.deepEqual(suspensions, [], '关闭回调不解除暂停或重置衣架计时');
});

test('编辑仅更新内存草稿，颜色字号保留且返回副本不能篡改窗口状态', async t => {
  const { manager, windows, calls, changes, records, eventFor } = setup(t);
  await manager.open();
  const event = eventFor(windows[0]);
  const result = manager.save(event, payload('正在输入，尚未挂回', { color: '#ABCDEF', fontSize: 20, alwaysOnTop: true }));
  assert.equal(result.color, '#abcdef');
  assert.equal(result.fontSize, 20);
  assert.equal(windows[0].top, true);
  result.text = '外部修改'; result.bounds.x = 999;
  const draft = manager.get(event);
  assert.equal(draft.text, '正在输入，尚未挂回');
  assert.equal(draft.fontSize, 20);
  assert.notEqual(draft.bounds.x, 999);
  assert.deepEqual(calls, []);
  assert.deepEqual(changes, []);
  assert.deepEqual(records, []);
});

test('关闭等待保存成功后才发布与销毁，重复关闭不产生第二条记录', async t => {
  const { manager, windows, repository, calls, changes, records, suspensions, eventFor } = setup(t);
  await manager.open();
  const gate = deferred(); repository.saveHandler = () => gate.promise;
  const event = eventFor(windows[0]);
  const closing = manager.close(event, payload('最终文本', { fontSize: 24 }));
  assert.strictEqual(manager.close(event, payload('重复点击不覆盖最终文本')), closing);
  await turn();
  assert.equal(calls.length, 1);
  assert.equal(windows[0].destroyed, false);
  assert.deepEqual(records, []);
  assert.deepEqual(changes, []);
  assert.equal(manager.runtime()[0].closing, true);
  assert.deepEqual(suspensions, [], '等待保存时不暂停衣架自动隐藏');
  assert.throws(() => manager.save(event, payload('关闭期间修改')), /保存并关闭/);
  gate.resolve();
  const result = await closing;
  assert.equal(result.note.text, '最终文本');
  assert.equal(result.note.fontSize, 24);
  assert.equal(records.length, 1);
  assert.equal(changes.filter(value => value?.note).length, 1);
  assert.equal(windows[0].destroyed, true);
  assert.deepEqual(manager.runtime(), []);
  assert.deepEqual(suspensions, [], '保存成功及关闭回调不重置衣架计时');
});

test('同步保存失败保留最新文本与窗口，不阻止衣架收起，后续关闭可以成功重试', async t => {
  const controller = new AutoHideController({
    getExpandedBounds: () => ({ x: 100, y: 50, width: 1680, height: 260 }),
    getDisplayBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    delayMs: 1000,
  });
  const outside = { x: 1800, y: 400 };
  controller.setEnabled(true);
  controller.tick(outside, 0);
  const { manager, windows, repository, records, changes, errors, suspensions, eventFor } = setup(t,
    { onSuspend: active => controller.setSuspended(active) });
  await manager.open();
  const failure = new Error('模拟磁盘不可写');
  repository.saveHandler = () => { throw failure; };
  const event = eventFor(windows[0]);
  await assert.rejects(manager.close(event, payload('失败也不能丢失', { color: '#ffccdd', fontSize: 22 })), /磁盘不可写/);
  assert.equal(windows[0].destroyed, false);
  assert.equal(manager.runtime()[0].closing, false);
  assert.equal(manager.get(event).text, '失败也不能丢失');
  assert.equal(manager.get(event).color, '#ffccdd');
  assert.deepEqual(records, []);
  assert.deepEqual(changes, []);
  assert.deepEqual(errors, [failure]);
  assert.deepEqual(suspensions, []);
  assert.equal(controller.getState().suspended, false);
  assert.equal(controller.tick(outside, 999).collapsed, false);
  assert.equal(controller.tick(outside, 1000).collapsed, true,
    '打开便签和保存失败不重置既有离开计时，保留的编辑窗口不阻止衣架收起');
  repository.saveHandler = null;
  const result = await manager.close(event, payload('重试保留文本', { fontSize: 22 }));
  assert.equal(result.note.text, '重试保留文本');
  assert.equal(windows[0].destroyed, true);
  assert.deepEqual(suspensions, [], '重试保存和关闭不调用衣架暂停接口');
  assert.equal(controller.getState().collapsed, true, '关闭便签不会展开已收起的衣架');
});

test('所有便签操作只接受所属窗口主 frame，导航和新窗口被阻止', async t => {
  const { manager, windows, eventFor } = setup(t);
  await manager.open();
  const window = windows[0];
  const invalidEvents = [
    { sender: window.webContents, senderFrame: {} },
    { sender: new EventEmitter(), senderFrame: window.webContents.mainFrame },
    { sender: {}, senderFrame: {} },
  ];
  const operations = [event => manager.get(event), event => manager.save(event, payload('禁止')),
    event => manager.close(event, payload('禁止')), event => manager.setAlwaysOnTop(event, true),
    event => manager.beginDrag(event, { x: 1, y: 1 }), event => manager.moveDrag(event, { x: 2, y: 2 }),
    event => manager.endDrag(event)];
  for (const event of invalidEvents) for (const operation of operations) {
    assert.throws(() => operation(event), /不允许的便签窗口请求/);
  }
  assert.deepEqual(window.openHandler({ url: 'https://example.test' }), { action: 'deny' });
  let prevented = false;
  window.webContents.emit('will-navigate', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  const event = eventFor(window);
  window.destroy();
  assert.throws(() => manager.get(event), /不允许的便签窗口请求/);
});

test('payload.id 不能改写其他便签，也不能把新草稿冒充为已存在便签', async t => {
  const { manager, windows, records, calls, eventFor } = setup(t, {
    notes: [storedNote(NOTE_A, '甲'), storedNote(NOTE_B, '乙不能被改')],
  });
  await manager.open(NOTE_A);
  await manager.close(eventFor(windows[0]), payload('只修改甲', { id: NOTE_B }));
  assert.equal(calls[0].id, NOTE_A);
  assert.equal(records.find(note => note.id === NOTE_A).text, '只修改甲');
  assert.equal(records.find(note => note.id === NOTE_B).text, '乙不能被改');
  await manager.open();
  const result = await manager.close(eventFor(windows[1]), payload('独立的新便签', { id: NOTE_B }));
  assert.equal(calls[1].id, undefined);
  assert.notEqual(result.note.id, NOTE_A);
  assert.notEqual(result.note.id, NOTE_B);
  assert.equal(records.length, 3);
  assert.equal(records.find(note => note.id === NOTE_B).text, '乙不能被改');
});

test('置顶和拖动仅作用当前便签，越界拖动限制在工作区并保存独立位置', async t => {
  const { manager, windows, eventFor } = setup(t);
  await Promise.all([manager.open(), manager.open()]);
  const [first, second] = windows;
  const firstEvent = eventFor(first), secondEvent = eventFor(second);
  const secondBounds = second.getBounds();
  manager.setAlwaysOnTop(firstEvent, true);
  assert.equal(first.top, true); assert.equal(second.top, false);
  assert.throws(() => manager.setAlwaysOnTop(firstEvent, 'true'), TypeError);
  manager.beginDrag(firstEvent, { x: NaN, y: 10 });
  manager.moveDrag(firstEvent, { x: 300, y: 300 });
  const initial = first.getBounds();
  manager.beginDrag(firstEvent, { x: 50, y: 50 });
  manager.moveDrag(secondEvent, { x: 2000, y: 2000 });
  manager.moveDrag(firstEvent, { x: Infinity, y: 0 });
  assert.deepEqual(first.getBounds(), initial);
  manager.moveDrag(firstEvent, { x: 2000, y: 2000 });
  assert.deepEqual(first.getBounds(), { x: 1540, y: 650, width: 380, height: 430 });
  assert.deepEqual(second.getBounds(), secondBounds);
  manager.endDrag(firstEvent);
  manager.moveDrag(firstEvent, { x: 60, y: 60 });
  const result = await manager.close(firstEvent, payload('移动后的便签', { alwaysOnTop: true }));
  assert.deepEqual(result.note.bounds, { x: 1540, y: 650, width: 380, height: 430 });
  assert.equal(second.destroyed, false);
});

test('系统关闭发送一次 flush 请求并等待编辑窗提交最新文本', async t => {
  const { manager, windows, calls, eventFor } = setup(t);
  await manager.open();
  const window = windows[0], event = eventFor(window);
  manager.save(event, payload('较早的自动保存草稿'));
  assert.equal(window.close(), true);
  const flushing = manager.requestFlush(manager.entries.get(window.id));
  await turn();
  assert.deepEqual(window.sent, [['rack:flush-note']]);
  assert.equal(window.destroyed, false);
  assert.deepEqual(calls, []);
  const result = await manager.close(event, payload('系统关闭时输入框中的最新内容', { fontSize: 20 }));
  assert.deepEqual(await flushing, result);
  assert.equal(result.note.text, '系统关闭时输入框中的最新内容');
  assert.equal(window.destroyed, true);
});

test('退出 flushAll 等待两个编辑窗各自提交并保存，不改变衣架自动隐藏计时', async t => {
  const { manager, windows, repository, calls, records, suspensions, eventFor } = setup(t);
  await Promise.all([manager.open(), manager.open()]);
  const gates = [deferred(), deferred()];
  repository.saveHandler = input => gates[input.text === '第一张最终内容' ? 0 : 1].promise;
  windows.forEach((window, index) => {
    window.webContents.on('sent', channel => {
      if (channel === 'rack:flush-note') {
        void manager.close(eventFor(window), payload(index === 0 ? '第一张最终内容' : '第二张最终内容',
          { fontSize: index === 0 ? 20 : 28 })).catch(() => {});
      }
    });
  });
  let finished = false;
  const flushing = manager.flushAll().then(() => { finished = true; });
  await turn();
  assert.equal(calls.length, 2);
  assert.equal(finished, false);
  assert.equal(windows.every(window => !window.destroyed), true);
  gates[0].resolve(); await turn();
  assert.equal(finished, false);
  assert.equal(windows[1].destroyed, false);
  gates[1].resolve(); await flushing;
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(note => note.text).sort(), ['第一张最终内容', '第二张最终内容'].sort());
  assert.equal(windows.every(window => window.destroyed), true);
  assert.deepEqual(manager.runtime(), []);
  assert.deepEqual(suspensions, [], '并行便签的打开、flush 和关闭不暂停或重置衣架计时');
});

test('新空白便签关闭不挂出，已有便签清空后仍保留记录', async t => {
  const { manager, windows, records, eventFor } = setup(t, { notes: [storedNote(NOTE_A, '已保存的文字')] });
  await manager.open();
  assert.equal(await manager.close(eventFor(windows[0]), payload(' \n\t')), null);
  assert.equal(records.length, 1);
  assert.equal(windows[0].destroyed, true);
  await manager.open(NOTE_A);
  const result = await manager.close(eventFor(windows[1]), payload(''));
  assert.equal(result.added, false);
  assert.equal(result.note.id, NOTE_A);
  assert.equal(records.length, 1);
  assert.equal(records[0].text, '');
});

test('删除已打开便签等待提交成功才关闭，锁住当前id而不影响其他窗口', async t => {
  const { manager, windows, repository, records, calls, deleteCalls, changes, eventFor } = setup(t, {
    notes: [storedNote(NOTE_A, '待删除'), storedNote(NOTE_B, '保留')],
  });
  await Promise.all([manager.open(NOTE_A), manager.open(NOTE_B)]);
  const event = eventFor(windows[0]), otherEvent = eventFor(windows[1]);
  manager.save(event, payload('未保存的草稿也属于用户删除的便签'));
  const gate = deferred(); repository.deleteHandler = () => gate.promise;
  const deleting = manager.delete(NOTE_A);
  assert.strictEqual(manager.delete(NOTE_A), deleting);
  await turn();
  assert.deepEqual(deleteCalls, [NOTE_A]);
  assert.equal(windows[0].destroyed, false);
  assert.equal(records.length, 2);
  assert.deepEqual(changes, []);
  await assert.rejects(manager.open(NOTE_A), /正在删除/);
  for (const operation of [() => manager.save(event, payload('禁止继续写入')),
    () => manager.close(event, payload('禁止关闭保存')),
    () => manager.setAlwaysOnTop(event, true),
    () => manager.beginDrag(event, { x: 0, y: 0 }), () => manager.moveDrag(event, { x: 1, y: 1 }),
    () => manager.endDrag(event)]) assert.throws(operation, /正在删除/);
  manager.save(otherEvent, payload('另一张仍然可编辑'));
  const flushing = manager.flushAll();
  await turn();
  assert.deepEqual(windows[0].sent, []);
  assert.deepEqual(windows[1].sent, [['rack:flush-note']]);
  await manager.close(otherEvent, payload('另一张仍然可编辑'));
  gate.resolve();
  assert.deepEqual(await deleting, { id: NOTE_A, deleted: true });
  await flushing;
  assert.equal(windows[0].destroyed, true);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, NOTE_B);
  assert.equal(records[0].text, '另一张仍然可编辑');
  assert.equal(calls.every(input => input.id !== NOTE_A), true);
  assert.equal(changes.filter(result => result?.deleted).length, 1);
});

test('删除失败保留全文与窗口并解除锁，重新删除可以成功', async t => {
  const { manager, windows, repository, records, changes, eventFor } = setup(t, { notes: [storedNote(NOTE_A, '磁盘原文')] });
  await manager.open(NOTE_A);
  const event = eventFor(windows[0]);
  const text = '完整草稿\n'.repeat(3000);
  manager.save(event, payload(text, { color: '#123456', fontSize: 20 }));
  repository.deleteHandler = () => { throw new Error('模拟删除失败'); };
  await assert.rejects(manager.delete(NOTE_A), /模拟删除失败/);
  assert.equal(windows[0].destroyed, false);
  assert.equal(manager.runtime()[0].deleting, false);
  assert.equal(manager.get(event).text, text);
  assert.equal(records[0].text, '磁盘原文');
  assert.deepEqual(changes, []);
  manager.save(event, payload(text, { color: '#abcdef' }));
  await manager.open(NOTE_A);
  assert.equal(windows.length, 1);
  repository.deleteHandler = null;
  await manager.delete(NOTE_A);
  assert.equal(windows[0].destroyed, true);
  assert.deepEqual(records, []);
  assert.deepEqual(manager.runtime(), []);
});

test('删除等正在关闭的保存完成，再移除记录且不会被旧窗口复活', async t => {
  const { manager, windows, repository, records, deleteCalls, eventFor } = setup(t, { notes: [storedNote(NOTE_A, '原文')] });
  await manager.open(NOTE_A);
  const saveGate = deferred(); repository.saveHandler = () => saveGate.promise;
  const closing = manager.close(eventFor(windows[0]), payload('关闭时最新文字'));
  const deleting = manager.delete(NOTE_A);
  await turn();
  assert.deepEqual(deleteCalls, []);
  assert.equal(windows[0].destroyed, false);
  saveGate.resolve();
  assert.equal((await closing).note.text, '关闭时最新文字');
  assert.deepEqual(await deleting, { id: NOTE_A, deleted: true });
  assert.deepEqual(records, []);
  await assert.rejects(manager.open(NOTE_A), /找不到/);
});

test('关闭保存失败后仍可按删除意图移除原记录，等待中的flush成功结束', async t => {
  const { manager, windows, repository, records, eventFor } = setup(t, { notes: [storedNote(NOTE_A, '原文')] });
  await manager.open(NOTE_A);
  const saveGate = deferred(); repository.saveHandler = () => saveGate.promise;
  const closing = manager.close(eventFor(windows[0]), payload('未能保存的内容'));
  const failedClosing = assert.rejects(closing, /保存失败/);
  const deleting = manager.delete(NOTE_A);
  const flushing = manager.requestFlush(manager.entries.get(windows[0].id));
  await turn(); saveGate.reject(new Error('模拟保存失败'));
  await failedClosing;
  assert.deepEqual(await deleting, { id: NOTE_A, deleted: true });
  assert.deepEqual(await flushing, { id: NOTE_A, deleted: true });
  assert.equal(windows[0].destroyed, true);
  assert.deepEqual(records, []);
});

test('删除加载中的便签与系统关闭请求不提交旧草稿，失败则恢复可见编辑窗', async t => {
  const { manager, windows, repository, records, calls } = setup(t, { notes: [storedNote(NOTE_A, '原文')], delayLoad: true });
  const opening = manager.open(NOTE_A);
  const gate = deferred(); repository.deleteHandler = () => gate.promise;
  const deleting = manager.delete(NOTE_A);
  const flushing = manager.requestFlush(manager.entries.get(windows[0].id));
  const failedFlush = assert.rejects(flushing, /删除失败/);
  await turn(); windows[0].load.resolve(); await opening;
  assert.equal(windows[0].visible, false);
  assert.deepEqual(windows[0].sent, []);
  assert.deepEqual(calls, []);
  gate.reject(new Error('模拟删除失败'));
  await assert.rejects(deleting, /删除失败/);
  await failedFlush; await turn();
  assert.equal(windows[0].visible, true);
  assert.equal(windows[0].destroyed, false);
  assert.equal(records[0].text, '原文');
  assert.equal(manager.runtime()[0].deleting, false);
});
