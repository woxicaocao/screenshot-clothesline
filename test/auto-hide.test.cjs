'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AutoHideController } = require('../src/lib/auto-hide.cjs');

function setup(options = {}) {
  let expanded = options.expanded ?? { x: 300, y: 60, width: 900, height: 260 };
  let display = options.display ?? { x: 0, y: 0, width: 1920, height: 1080 };
  let time = 0;
  const events = [];
  const controller = new AutoHideController({
    getExpandedBounds: () => expanded,
    getDisplayBounds: () => display,
    now: () => time,
    onCollapse: () => events.push({ event: 'collapse', state: controller.getState() }),
    onExpand: () => events.push({ event: 'expand', state: controller.getState() }),
    onChange: (state) => events.push({ event: 'change', state }),
    ...(options.controller ?? {}),
  });
  return {
    controller, events,
    setTime: (value) => { time = value; },
    setExpanded: (value) => { expanded = value; },
    setDisplay: (value) => { display = value; },
  };
}

const outside = { x: 1500, y: 600 };
const inside = { x: 500, y: 200 };

function collapse(controller, startedAt = 0) {
  controller.tick(outside, startedAt);
  controller.tick(outside, startedAt + 3000);
  assert.equal(controller.getState().collapsed, true);
}

test('默认关闭，离开范围不隐藏，返回的状态不可修改内部状态', () => {
  const { controller, events } = setup();
  assert.deepEqual(controller.getState(), {
    enabled: false, collapsed: false, dragging: false, suspended: false, manuallyHidden: false,
  });
  controller.tick(outside, 0);
  controller.tick(outside, 10000);
  controller.getState().enabled = true;
  assert.equal(controller.getState().enabled, false);
  assert.deepEqual(events, []);
});

test('离开完整矩形满 3 秒才收起，回调先看到 collapsed 状态', () => {
  const { controller, events } = setup();
  controller.setEnabled(true);
  controller.tick(outside, 0);
  controller.tick(outside, 2999);
  assert.equal(controller.getState().collapsed, false);
  controller.tick(outside, 3000);
  assert.equal(controller.getState().collapsed, true);
  assert.equal(events.filter(({ event }) => event === 'collapse').length, 1);
  assert.equal(events.find(({ event }) => event === 'collapse').state.collapsed, true);
  controller.tick(outside, 6000);
  assert.equal(events.filter(({ event }) => event === 'collapse').length, 1);
});

for (const [name, delayMs] of [['快', 0], ['中', 1000], ['慢', 2000]]) {
  test(`${name}档在离开 ${delayMs} 毫秒的边界收起`, () => {
    const { controller, events } = setup();
    controller.setDelayMs(delayMs);
    controller.setEnabled(true);
    controller.tick(inside, 0);
    assert.equal(controller.getState().collapsed, false);
    controller.tick(outside, 100);
    if (delayMs > 0) {
      assert.equal(controller.getState().collapsed, false);
      controller.tick(outside, 100 + delayMs - 1);
      assert.equal(controller.getState().collapsed, false);
      controller.tick(outside, 100 + delayMs);
    }
    assert.equal(controller.getState().collapsed, true);
    assert.equal(events.filter(({ event }) => event === 'collapse').length, 1);
  });
}

test('切换等待档位重置倒计时，相同档位保留已有计时', () => {
  const { controller } = setup();
  controller.setEnabled(true);
  controller.tick(outside, 0);
  controller.tick(outside, 900);
  controller.setDelayMs(1000);
  controller.tick(outside, 900);
  controller.tick(outside, 1899);
  assert.equal(controller.getState().collapsed, false);
  controller.setDelayMs(1000);
  controller.tick(outside, 1900);
  assert.equal(controller.getState().collapsed, true);
  controller.setDelayMs(0);
  assert.equal(controller.getState().collapsed, true);
  controller.reveal();
  controller.tick(outside, 2000);
  assert.equal(controller.getState().collapsed, true);
});

test('快档仍遵守暂停、拖动、手动隐藏及开关，解除后下一次离开立即收起', () => {
  for (const setter of ['setSuspended', 'setDragging', 'setManuallyHidden']) {
    const { controller } = setup();
    controller.setDelayMs(0);
    controller.tick(outside, 0);
    assert.equal(controller.getState().collapsed, false);
    controller.setEnabled(true);
    controller[setter](true);
    controller.tick(outside, 1000);
    assert.equal(controller.getState().collapsed, false);
    controller[setter](false);
    controller.tick(outside, 1001);
    assert.equal(controller.getState().collapsed, true);
  }
});

test('等待档位拒绝无效值，不更改已有计时，dispose 后设置不生效', () => {
  const { controller, events } = setup();
  controller.setDelayMs(1000);
  controller.setEnabled(true);
  controller.tick(outside, 0);
  for (const value of [-1, Infinity, -Infinity, NaN, '1000', null, undefined]) {
    assert.throws(() => controller.setDelayMs(value), TypeError);
  }
  controller.tick(outside, 1000);
  assert.equal(controller.getState().collapsed, true);
  controller.reveal();
  controller.dispose();
  const eventCount = events.length;
  controller.setDelayMs(0);
  controller.tick(outside, 1001);
  assert.equal(controller.getState().collapsed, false);
  assert.equal(events.length, eventCount);
});

test('快档顶部唤回后允许跨过空隙，进入衣架后再次离开立即收起', () => {
  const { controller } = setup({ controller: { delayMs: 0 } });
  controller.setEnabled(true);
  controller.tick(outside, 0);
  assert.equal(controller.getState().collapsed, true);
  controller.tick({ x: 500, y: 0 }, 1);
  assert.equal(controller.getState().collapsed, false);
  controller.tick({ x: 500, y: 0 }, 10000);
  controller.tick({ x: 500, y: 35 }, 10001);
  assert.equal(controller.getState().collapsed, false);
  controller.tick(inside, 10002);
  controller.tick({ x: 500, y: 35 }, 10003);
  assert.equal(controller.getState().collapsed, true);
});

test('顶部唤回通道只保留到首次离开水平范围或当前屏幕', () => {
  for (const point of [{ x: 299, y: 35 }, { x: 1200, y: 35 }, { x: 500, y: -1 }, outside]) {
    const { controller } = setup({ controller: { delayMs: 0 } });
    controller.setEnabled(true);
    controller.tick(outside, 0);
    controller.tick({ x: 500, y: 0 }, 1);
    controller.tick(point, 2);
    assert.equal(controller.getState().collapsed, true);
  }
});

test('手动 reveal 和开关、拖动、预览、手动隐藏状态变化清除顶部通道', () => {
  for (const reset of [
    (controller) => controller.reveal(),
    (controller) => { controller.setEnabled(false); controller.setEnabled(true); },
    (controller) => { controller.setDragging(true); controller.setDragging(false); },
    (controller) => { controller.setSuspended(true); controller.setSuspended(false); },
    (controller) => { controller.setManuallyHidden(true); controller.setManuallyHidden(false); },
  ]) {
    const { controller } = setup({ controller: { delayMs: 0 } });
    controller.setEnabled(true);
    controller.tick(outside, 0);
    controller.tick({ x: 500, y: 0 }, 1);
    reset(controller);
    controller.tick({ x: 500, y: 35 }, 2);
    assert.equal(controller.getState().collapsed, true);
  }
});

test('顶部通道同样适用于负坐标屏幕，跨屏顶部和通道外不延长保护', () => {
  const { controller } = setup({
    expanded: { x: -1800, y: -900, width: 900, height: 260 },
    display: { x: -1920, y: -1080, width: 1920, height: 1080 },
    controller: { delayMs: 0 },
  });
  controller.setEnabled(true);
  controller.tick(outside, 0);
  controller.tick({ x: -1700, y: -1080 }, 1);
  controller.tick({ x: -1700, y: -1000 }, 2);
  assert.equal(controller.getState().collapsed, false);
  controller.tick({ x: -1700, y: 0 }, 3);
  assert.equal(controller.getState().collapsed, true);
});

test('矩形内透明空白也取消倒计时，再次离开需要重新等待', () => {
  const { controller } = setup();
  controller.setEnabled(true);
  controller.tick(outside, 0);
  controller.tick({ x: 300, y: 60 }, 2900);
  controller.tick(outside, 3000);
  controller.tick(outside, 5999);
  assert.equal(controller.getState().collapsed, false);
  controller.tick(outside, 6000);
  assert.equal(controller.getState().collapsed, true);
});

test('只在本屏顶部 8 像素及挂件水平范围内立即唤回，回调看到已展开', () => {
  const { controller, events } = setup();
  controller.setEnabled(true);
  collapse(controller);
  for (const point of [{ x: 500, y: 8 }, { x: 299, y: 0 }, { x: 1200, y: 0 }, { x: 500, y: -1 }]) {
    controller.tick(point, 4000);
    assert.equal(controller.getState().collapsed, true);
  }
  controller.tick({ x: 300, y: 7 }, 4100);
  assert.equal(controller.getState().collapsed, false);
  assert.equal(events.find(({ event }) => event === 'expand').state.collapsed, false);
  controller.tick(outside, 4200);
  controller.tick(outside, 7199);
  assert.equal(controller.getState().collapsed, false);
  controller.tick(outside, 7200);
  assert.equal(controller.getState().collapsed, true);
});

test('负坐标显示器使用其真实顶部，其它屏幕顶部不会唤醒', () => {
  const { controller } = setup({
    expanded: { x: -1800, y: -900, width: 900, height: 260 },
    display: { x: -1920, y: -1080, width: 1920, height: 1080 },
  });
  controller.setEnabled(true);
  collapse(controller);
  controller.tick({ x: -1700, y: 0 }, 4000);
  controller.tick({ x: 500, y: 0 }, 4000);
  controller.tick({ x: -1700, y: -1072 }, 4000);
  assert.equal(controller.getState().collapsed, true);
  controller.tick({ x: -1700, y: -1080 }, 4000);
  assert.equal(controller.getState().collapsed, false);
});

test('横跨屏幕的窗口仅当前显示器范围可以唤回，并读取最新窗口位置', () => {
  const { controller, setExpanded, setDisplay } = setup();
  setExpanded({ x: 1700, y: 80, width: 900, height: 260 });
  controller.setEnabled(true);
  collapse(controller);
  controller.tick({ x: 2000, y: 0 }, 4000);
  assert.equal(controller.getState().collapsed, true);
  controller.tick({ x: 1900, y: 0 }, 4000);
  assert.equal(controller.getState().collapsed, false);
  setDisplay({ x: 1920, y: 0, width: 1920, height: 1080 });
  setExpanded({ x: 2100, y: 80, width: 900, height: 260 });
  collapse(controller, 5000);
  controller.tick({ x: 1900, y: 0 }, 9000);
  assert.equal(controller.getState().collapsed, true);
  controller.tick({ x: 2500, y: 0 }, 9000);
  assert.equal(controller.getState().collapsed, false);
});

for (const [name, setter] of [['拖动', 'setDragging'], ['菜单或临时操作', 'setSuspended']]) {
  test(`${name}开始会展开，期间不收起，结束后重新计时`, () => {
    const { controller } = setup();
    controller.setEnabled(true);
    collapse(controller);
    controller[setter](true);
    assert.equal(controller.getState().collapsed, false);
    controller.tick(outside, 4000);
    controller.tick(outside, 20000);
    assert.equal(controller.getState().collapsed, false);
    controller[setter](false);
    controller.tick(outside, 21000);
    controller.tick(outside, 23999);
    assert.equal(controller.getState().collapsed, false);
    controller.tick(outside, 24000);
    assert.equal(controller.getState().collapsed, true);
  });
}

test('手动隐藏禁止顶部唤醒，取消手动隐藏后通过 reveal 显式展开', () => {
  const { controller } = setup();
  controller.setEnabled(true);
  collapse(controller);
  controller.setManuallyHidden(true);
  controller.tick({ x: 500, y: 0 }, 9000);
  assert.equal(controller.getState().collapsed, true);
  controller.setManuallyHidden(false);
  assert.equal(controller.getState().collapsed, true);
  controller.reveal();
  assert.equal(controller.getState().collapsed, false);
  controller.tick(outside, 10000);
  controller.setManuallyHidden(true);
  controller.tick(outside, 20000);
  assert.equal(controller.getState().collapsed, false);
});

test('关闭自动隐藏会展开，仍保留手动隐藏状态', () => {
  const { controller } = setup();
  controller.setEnabled(true);
  collapse(controller);
  controller.setManuallyHidden(true);
  controller.setEnabled(false);
  assert.equal(controller.getState().collapsed, false);
  assert.equal(controller.getState().manuallyHidden, true);
  controller.tick(outside, 20000);
  assert.equal(controller.getState().collapsed, false);
});

test('重复设置相同值不会重置倒计时或重复发送状态通知', () => {
  const { controller, events } = setup();
  controller.setEnabled(true);
  controller.tick(outside, 0);
  controller.setEnabled(true);
  controller.setDragging(false);
  controller.setSuspended(false);
  controller.setManuallyHidden(false);
  assert.equal(events.length, 1);
  controller.tick(outside, 3000);
  assert.equal(controller.getState().collapsed, true);
});

test('显式 reveal 即使已展开也重置倒计时，默认时钟可以驱动 tick', () => {
  const { controller, setTime } = setup();
  controller.setEnabled(true);
  setTime(1000);
  controller.tick(outside);
  setTime(3999);
  controller.reveal();
  controller.tick(outside);
  setTime(6998);
  controller.tick(outside);
  assert.equal(controller.getState().collapsed, false);
  setTime(6999);
  controller.tick(outside);
  assert.equal(controller.getState().collapsed, true);
});

test('无效坐标、窗口信息或时钟回拨不产生意外收起', () => {
  const { controller, setExpanded } = setup();
  controller.setEnabled(true);
  controller.tick(outside, 10000);
  controller.tick(outside, 0);
  controller.tick(outside, 2999);
  assert.equal(controller.getState().collapsed, false);
  controller.tick({ x: NaN, y: 0 }, 3000);
  controller.tick(outside, 6000);
  assert.equal(controller.getState().collapsed, false);
  setExpanded(null);
  controller.tick(outside, 9000);
  setExpanded({ x: 300, y: 60, width: 900, height: 260 });
  controller.tick(outside, 10000);
  controller.tick(outside, 12999);
  assert.equal(controller.getState().collapsed, false);
});

test('dispose 后没有状态变化、窗口回调或自建定时器', () => {
  const { controller, events } = setup();
  controller.setEnabled(true);
  controller.tick(outside, 0);
  controller.dispose();
  const eventCount = events.length;
  controller.tick(outside, 3000);
  controller.setEnabled(false);
  controller.setDragging(true);
  controller.setSuspended(true);
  controller.setManuallyHidden(true);
  controller.reveal();
  assert.equal(events.length, eventCount);
  assert.deepEqual(controller.getState(), {
    enabled: true, collapsed: false, dragging: false, suspended: false, manuallyHidden: false,
  });
});
