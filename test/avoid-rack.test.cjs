'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { placeAvoidingRack, fitSavedBounds } = require('../src/lib/avoid-rack.cjs');
const { NoteWindows } = require('../src/lib/note-windows.cjs');

const overlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
function safe(bounds, rack, area) {
  assert.ok(bounds.x >= area.x && bounds.y >= area.y);
  assert.ok(bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y + bounds.height <= area.y + area.height);
  assert.equal(overlap(bounds, rack), false);
  assert.ok(Object.values(bounds).every(Number.isSafeInteger));
}

test('新便签优先位于衣架下方，保留16个逻辑像素且多张标题栏错开', () => {
  const rack = { x: 100, y: 50, width: 1680, height: 260 };
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const first = placeAvoidingRack({ rack, workArea });
  const second = placeAvoidingRack({ rack, workArea, cascade: 1 });
  assert.equal(first.y, 326); assert.equal(first.width, 380); assert.equal(first.height, 430);
  assert.equal(second.x - first.x, 24); assert.equal(second.y - first.y, 20);
  safe(first, rack, workArea); safe(second, rack, workArea);
});

test('衣架靠近底部时依次尝试上方，左右区域仍可用', () => {
  const workArea = { x: 0, y: 0, width: 1600, height: 1000 };
  const rack = { x: 100, y: 740, width: 1350, height: 240 };
  const result = placeAvoidingRack({ rack, workArea });
  assert.equal(result.y + result.height, rack.y - 16); safe(result, rack, workArea);
  const verticalRack = { x: 100, y: 0, width: 300, height: 1000 };
  const right = placeAvoidingRack({ rack: verticalRack, workArea });
  assert.equal(right.x, 416); safe(right, verticalRack, workArea);
  const leftRack = { x: 1200, y: 0, width: 350, height: 1000 };
  const left = placeAvoidingRack({ rack: leftRack, workArea });
  assert.equal(left.x + left.width, 1184); safe(left, leftRack, workArea);
});

test('150%缩放下窄工作区直接使用DIP缩小新窗口，不重复应用缩放', () => {
  const workArea = { x: 0, y: 0, width: 853, height: 480 };
  const rack = { x: 20, y: 20, width: 813, height: 210 };
  const note = placeAvoidingRack({ rack, workArea });
  assert.deepEqual(note, { x: 237, y: 246, width: 380, height: 234 });
  const group = placeAvoidingRack({ rack, workArea, width: 680, height: 420 });
  assert.equal(group.height, 234); assert.equal(group.width, 680); safe(group, rack, workArea);
});

test('窄屏空位被用满时后续便签稍微缩小，仍错开标题栏', () => {
  const workArea = { x: 0, y: 0, width: 300, height: 480 };
  const rack = { x: 0, y: 0, width: 300, height: 200 };
  const first = placeAvoidingRack({ rack, workArea });
  const second = placeAvoidingRack({ rack, workArea, cascade: 1 });
  assert.notEqual(first.x, second.x); assert.ok(second.width >= 240);
  safe(first, rack, workArea); safe(second, rack, workArea);
});

test('负坐标副屏与被衣架占满的极限工作区明确处理', () => {
  const workArea = { x: -1280, y: -120, width: 1280, height: 1000 };
  const rack = { x: -1200, y: -50, width: 1120, height: 240 };
  const bounds = placeAvoidingRack({ rack, workArea });
  assert.equal(bounds.y, 206); safe(bounds, rack, workArea);
  assert.throws(() => placeAvoidingRack({ rack: workArea, workArea }), /没有可放置/);
});

test('旧便签沿用保存的位置，只有超出工作区时才夹紧', () => {
  const area = { x: -1000, y: 0, width: 1000, height: 800 };
  const saved = { x: -850, y: 120, width: 380, height: 430 };
  assert.deepEqual(fitSavedBounds(saved, area), saved);
  assert.deepEqual(fitSavedBounds({ x: -1500, y: 750, width: 1200, height: 900 }, area),
    { x: -1000, y: 24, width: 976, height: 776 });
});

test('关闭前一张后继续新建便签，不与仍打开的便签标题栏重合', () => {
  const rack = { x: 100, y: 50, width: 1680, height: 260 };
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const manager = new NoteWindows({ getRackBounds: () => rack,
    screen: { getDisplayNearestPoint: () => ({ workArea }) } });
  const existing = placeAvoidingRack({ rack, workArea, cascade: 1 });
  manager.entries.set(2, { window: { isDestroyed: () => false, getBounds: () => existing } });
  const next = manager._position(null);
  assert.ok(next.x !== existing.x || next.y !== existing.y);
  safe(next, rack, workArea);
});
