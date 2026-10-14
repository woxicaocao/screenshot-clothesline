'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SCREEN_WIDTH_FRACTION, rackSizeForDisplay } = require('../src/lib/window-size.cjs');

function display(scaleFactor = 1, width = 1920, height = 1080, workWidth = width) {
  return { scaleFactor, bounds: { x: 0, y: 0, width, height }, workArea: { x: 0, y: 0, width: workWidth, height } };
}

test('窗口宽度在三分之一基础上增加 20%，取屏幕宽度 40% 且没有 1680 像素上限', () => {
  assert.equal(SCREEN_WIDTH_FRACTION, 0.4);
  for (const [screenWidth, expected] of [[1366, 546], [1600, 640], [1920, 768], [2560, 1024], [3840, 1536], [7680, 3072]]) {
    const size = rackSizeForDisplay(display(1, screenWidth));
    assert.deepEqual(size, { width: expected, height: 260 });
    assert.ok(size.width <= screenWidth * 0.4);
    assert.ok(screenWidth * 0.4 - size.width < 1);
  }
});

test('100%／125%／150%／200% 缩放下按屏幕 DIP 取比例，不重复缩放', () => {
  for (const factor of [1, 1.25, 1.5, 1.75, 2, 1.3, 2.25]) {
    const physicalWidth = 3840;
    const dipWidth = physicalWidth / factor;
    const size = rackSizeForDisplay(display(factor, dipWidth));
    assert.equal(size.width, Math.floor(dipWidth * 0.4));
    assert.ok(size.width * factor <= physicalWidth * 0.4);
    assert.ok(physicalWidth * 0.4 - size.width * factor < factor);
    assert.ok(Number.isInteger(size.width));
    assert.equal(size.height, 260);
  }
});

test('基于完整显示器宽度取比例，受工作区限制时保留 24 DIP 余量', () => {
  const targetDisplay = { ...display(1.5, 1920, 600, 1800), width: 2516, previousWidth: 280 };
  assert.deepEqual(rackSizeForDisplay(targetDisplay), { width: 768, height: 260 });
  assert.deepEqual(rackSizeForDisplay(display(1, 1920, 600, 500)), { width: 476, height: 260 });
  assert.deepEqual(rackSizeForDisplay(display(1, 1920, 600, 100.75)), { width: 76, height: 260 });
  assert.deepEqual(rackSizeForDisplay(display(1, 1920, 600, 20)), { width: 1, height: 260 });
});

test('高 DPI 和窄屏不强制最小 280 DIP，避免偏离 40% 比例', () => {
  const size = rackSizeForDisplay(display(2, 640));
  assert.equal(size.width, 256);
  assert.equal(size.width * 2, 512);
});

test('显示器已经是 DIP，缩放因子缺失或无效也不改变 40% 比例', () => {
  for (const factor of [undefined, null, 0, -1, NaN, Infinity, -Infinity, '1.5']) {
    assert.deepEqual(rackSizeForDisplay({ ...display(), scaleFactor: factor }), { width: 768, height: 260 });
  }
});

test('高度保持 260 DIP，并适应较矮工作区域且返回整数', () => {
  assert.deepEqual(rackSizeForDisplay(display(2, 1000, 180)), { width: 400, height: 180 });
  assert.deepEqual(rackSizeForDisplay(display(2, 1000, 180.75)), { width: 400, height: 180 });
  assert.equal(rackSizeForDisplay(display(1, 1000, 0.5)).height, 1);
});

test('完整屏幕宽度缺失或无效时回退到工作区的 40%', () => {
  for (const bounds of [undefined, null, {}, { width: 0 }, { width: -1 }, { width: NaN }, { width: Infinity }, { width: '1920' }]) {
    assert.deepEqual(rackSizeForDisplay({ bounds, workArea: { width: 1600, height: 900 } }), { width: 640, height: 260 });
  }
});

test('显示器位置和上次窗口宽度不影响宽度比例', () => {
  const targetDisplay = display(1.5, 2560, 1440);
  targetDisplay.bounds.x = -2560;
  targetDisplay.bounds.y = -200;
  targetDisplay.previousWidth = 1680;
  assert.deepEqual(rackSizeForDisplay(targetDisplay), { width: 1024, height: 260 });
});

test('缺失、零值、负值或非有限工作区域明确报错', () => {
  for (const invalid of [undefined, null, {}, { workArea: null }]) {
    assert.throws(() => rackSizeForDisplay(invalid), TypeError);
  }
  for (const value of [undefined, null, 0, -1, NaN, Infinity, -Infinity, '1920']) {
    assert.throws(() => rackSizeForDisplay({ scaleFactor: 1, workArea: { width: value, height: 600 } }), TypeError);
    assert.throws(() => rackSizeForDisplay({ scaleFactor: 1, workArea: { width: 1920, height: value } }), TypeError);
  }
});
