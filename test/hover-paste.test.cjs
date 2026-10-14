'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HoverPasteController, PASTE_ACCELERATOR } = require('../src/lib/hover-paste.cjs');

function setup(options = {}) {
  let eligibility = false;
  let time = 0;
  let registrationResult = true;
  let callback = null;
  let pasteCount = 0;
  const registrations = [];
  const unregistrations = [];
  const changes = [];
  const errors = [];
  const controller = new HoverPasteController({
    globalShortcut: {
      register(accelerator, handler) {
        registrations.push(accelerator);
        if (registrationResult instanceof Error) throw registrationResult;
        if (registrationResult) callback = handler;
        return registrationResult;
      },
      unregister(accelerator) { unregistrations.push(accelerator); },
    },
    getEligibility: () => {
      if (eligibility instanceof Error) throw eligibility;
      return eligibility;
    },
    onPaste: () => { pasteCount += 1; },
    onChange: (state) => changes.push(state),
    onError: (error) => errors.push(error),
    now: () => time,
    ...(options.controller ?? {}),
  });
  return {
    controller, registrations, unregistrations, changes, errors,
    getPasteCount: () => pasteCount,
    setEligibility: (value) => { eligibility = value; },
    setTime: (value) => { time = value; },
    setRegistrationResult: (value) => { registrationResult = value; },
    fireNative: () => callback?.(),
  };
}

test('只有范围可用时注册 Ctrl+V，重复轮询不重复注册或发状态通知', () => {
  const context = setup();
  assert.deepEqual(context.controller.getState(), {
    registered: false, eligible: false, busy: false, failed: false,
  });
  context.controller.update();
  assert.deepEqual(context.registrations, []);
  assert.deepEqual(context.changes, []);
  context.setEligibility(true);
  assert.deepEqual(context.controller.update(), {
    registered: true, eligible: true, busy: false, failed: false,
  });
  context.controller.update();
  context.controller.getState().registered = false;
  context.changes[0].eligible = false;
  context.controller.update();
  assert.equal(context.controller.getState().registered, true);
  assert.deepEqual(context.registrations, [PASTE_ACCELERATOR]);
  assert.equal(context.changes.length, 1);
});

test('鼠标离开、隐藏、收起和拖动均由不可用状态立即注销，返回后重新注册', () => {
  const context = setup();
  for (const _reason of ['鼠标离开', '手动隐藏', '自动收起', '窗口拖动', '弹出菜单']) {
    context.setEligibility(true);
    context.controller.update();
    context.setEligibility(false);
    assert.equal(context.controller.update().registered, false);
    context.controller.update();
  }
  assert.equal(context.registrations.length, 5);
  assert.deepEqual(context.unregistrations, Array(5).fill(PASTE_ACCELERATOR));
});

test('注册失败节流重试，不注销其他应用占用的快捷键，并可恢复', async () => {
  const context = setup();
  context.setEligibility(true);
  context.setRegistrationResult(false);
  assert.deepEqual(context.controller.update(), {
    registered: false, eligible: true, busy: false, failed: true,
  });
  assert.equal(await context.controller.trigger(), false);
  context.controller.update();
  context.setTime(999);
  context.controller.update();
  assert.equal(context.registrations.length, 1);
  context.setTime(1000);
  context.setRegistrationResult(true);
  assert.equal(context.controller.update().registered, true);
  assert.equal(context.controller.getState().failed, false);
  assert.equal(context.registrations.length, 2);
  assert.equal(context.changes.length, 2);
  assert.deepEqual(context.unregistrations, []);
});

test('注册失败后离开重置状态，重新进入可立即尝试；dispose 不抢其他快捷键', () => {
  const context = setup();
  context.setEligibility(true);
  context.setRegistrationResult(false);
  context.controller.update();
  context.setEligibility(false);
  assert.equal(context.controller.update().failed, false);
  context.setEligibility(true);
  context.controller.update();
  assert.equal(context.registrations.length, 2);
  context.controller.dispose();
  assert.deepEqual(context.unregistrations, []);
});

test('按键到达时重新检查范围，轮询前已经离开的鼠标不会误粘贴', async () => {
  const context = setup();
  context.setEligibility(true);
  context.controller.update();
  context.setEligibility(false);
  assert.equal(await context.controller.trigger(), false);
  context.fireNative();
  assert.equal(context.getPasteCount(), 0);
  assert.equal(context.controller.getState().registered, false);
  assert.deepEqual(context.unregistrations, [PASTE_ACCELERATOR]);
});

test('异步保存防重入，原生按键和测试 trigger 走同一入口，完成后可继续粘贴', async () => {
  let finish;
  let count = 0;
  const context = setup({ controller: {
    onPaste: () => {
      count += 1;
      return new Promise((resolve) => { finish = resolve; });
    },
  } });
  context.setEligibility(true);
  context.controller.update();
  const first = context.controller.trigger();
  assert.equal(count, 1);
  assert.equal(context.controller.getState().busy, true);
  context.fireNative();
  assert.equal(await context.controller.trigger(), false);
  assert.equal(count, 1);
  finish();
  assert.equal(await first, true);
  assert.equal(context.controller.getState().busy, false);
  const second = context.controller.trigger();
  assert.equal(count, 2);
  finish();
  assert.equal(await second, true);
  assert.deepEqual(context.changes.map(({ busy }) => busy), [false, true, false, true, false]);
});

test('保存期间离开也能注销，完成后不会在窗口外重新持有快捷键', async () => {
  let finish;
  const context = setup({ controller: {
    onPaste: () => new Promise((resolve) => { finish = resolve; }),
  } });
  context.setEligibility(true);
  context.controller.update();
  const pending = context.controller.trigger();
  context.setEligibility(false);
  context.controller.update();
  assert.equal(context.controller.getState().busy, true);
  assert.equal(context.controller.getState().registered, false);
  finish();
  assert.equal(await pending, true);
  assert.deepEqual(context.controller.getState(), {
    registered: false, eligible: false, busy: false, failed: false,
  });
  assert.equal(context.registrations.length, 1);
  assert.deepEqual(context.unregistrations, [PASTE_ACCELERATOR]);
});

test('粘贴失败解除 busy 并报告错误，后续 Ctrl+V 可以再次重试', async () => {
  const failure = new Error('磁盘保存失败');
  let fail = true;
  const context = setup({ controller: {
    onPaste: async () => { if (fail) throw failure; },
  } });
  context.setEligibility(true);
  context.controller.update();
  assert.equal(await context.controller.trigger(), false);
  assert.equal(context.controller.getState().busy, false);
  assert.deepEqual(context.errors, [failure]);
  fail = false;
  assert.equal(await context.controller.trigger(), true);
});

test('退出只释放自己的快捷键且幂等，已排队的回调不粘贴、不重新注册', async () => {
  const context = setup();
  context.setEligibility(true);
  context.controller.update();
  assert.deepEqual(context.controller.dispose(), {
    registered: false, eligible: false, busy: false, failed: false,
  });
  context.controller.dispose();
  context.controller.update();
  context.fireNative();
  assert.equal(await context.controller.trigger(), false);
  assert.equal(context.getPasteCount(), 0);
  assert.equal(context.registrations.length, 1);
  assert.deepEqual(context.unregistrations, [PASTE_ACCELERATOR]);
});

test('退出时保存尚未完成，完成回调不再注册或通知已经退出的窗口', async () => {
  let finish;
  const context = setup({ controller: {
    onPaste: () => new Promise((resolve) => { finish = resolve; }),
  } });
  context.setEligibility(true);
  context.controller.update();
  const pending = context.controller.trigger();
  context.controller.dispose();
  const notifications = context.changes.length;
  finish();
  assert.equal(await pending, false);
  assert.equal(context.changes.length, notifications);
  assert.equal(context.controller.getState().busy, false);
  assert.equal(context.registrations.length, 1);
  assert.deepEqual(context.unregistrations, [PASTE_ACCELERATOR]);
});

test('范围查询异常时安全释放，注册异常可报告并稍后恢复', () => {
  const context = setup();
  const registrationError = new Error('系统快捷键注册失败');
  context.setEligibility(true);
  context.setRegistrationResult(registrationError);
  assert.equal(context.controller.update().failed, true);
  assert.deepEqual(context.errors, [registrationError]);
  context.setRegistrationResult(true);
  context.setTime(1000);
  context.controller.update();
  const rangeError = new Error('窗口已销毁');
  context.setEligibility(rangeError);
  assert.equal(context.controller.update().registered, false);
  assert.equal(context.controller.getState().eligible, false);
  assert.equal(context.errors.at(-1), rangeError);
  assert.deepEqual(context.unregistrations, [PASTE_ACCELERATOR]);
});

test('依赖和重试间隔输入验证', () => {
  const valid = {
    globalShortcut: { register: () => true, unregister: () => {} },
    getEligibility: () => false, onPaste: () => {},
  };
  assert.throws(() => new HoverPasteController({ ...valid, globalShortcut: {} }), /快捷键或回调/);
  assert.throws(() => new HoverPasteController({ ...valid, onPaste: null }), /快捷键或回调/);
  for (const retryMs of [-1, NaN, Infinity]) {
    assert.throws(() => new HoverPasteController({ ...valid, retryMs }), /重试间隔/);
  }
});
