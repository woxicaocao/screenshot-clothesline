'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PhotoWindows } = require('../src/lib/photo-windows.cjs');
const { geometryForScale, drawnSize, scaleLimitForDisplay, fitScaleForDisplay, visibleAreaFor,
  MAX_DRAWN_PIXELS, MAX_DRAWN_EDGE, MAX_SCALE, FRAME_EDGES, frameSizeForDisplay, frameBoundsFromPoint } = require('../src/lib/photo-window-geometry.cjs');

let nextId = 1;
class FakeWindow extends EventEmitter {
  constructor(bounds = { x: 100, y: 100, width: 642, height: 422 }, pinned = false) {
    super(); this.id = nextId++; this.bounds = { ...bounds }; this.pinned = pinned; this.destroyed = false; this.sent = [];
    this.webContents = { mainFrame: {}, isDestroyed: () => this.destroyed, send: (channel, payload) => this.sent.push({ channel, payload }) };
  }
  isDestroyed() { return this.destroyed; }
  getBounds() { return { ...this.bounds }; }
  getContentBounds() { return { ...this.bounds }; }
  setBounds(input) {
    if (this.failNextBounds) { this.failNextBounds = false; throw new Error('模拟原生窗口调整失败'); }
    const old = this.bounds, requested = { ...old, ...input };
    this.bounds = this.adjustBounds ? this.adjustBounds(requested) : requested;
    if (old.x !== this.bounds.x || old.y !== this.bounds.y) this.emit('move');
    if (old.width !== this.bounds.width || old.height !== this.bounds.height) this.emit('resize');
  }
  isAlwaysOnTop() { return this.pinned; }
  setAlwaysOnTop(value) { if (value !== this.pinned) { this.pinned = value; this.emit('always-on-top-changed', {}, value); } }
  close() { this.destroyed = true; this.emit('closed'); }
}

const PHOTO = { id: 'photo-one', width: 640, height: 420 };
const eventFor = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
const display = (factor = 1, x = 0, width = 1920, height = 1080) => ({ id: x + factor, scaleFactor: factor,
  bounds: { x, y: 0, width, height }, workArea: { x, y: 0, width, height } });

function harness(displays = [display()]) {
  const context = { displays, cursor: { x: 300, y: 250 }, errors: [] };
  const screen = {
    getCursorScreenPoint: () => ({ ...context.cursor }), getAllDisplays: () => context.displays,
    getDisplayMatching: bounds => context.displays.reduce((best, item) => {
      const area = visibleAreaFor(bounds, item.workArea), overlap = area.width * area.height;
      return !best || overlap > best.overlap ? { item, overlap } : best;
    }, null)?.item,
    getDisplayNearestPoint: point => context.displays.find(item => point.x >= item.bounds.x && point.x < item.bounds.x + item.bounds.width) || context.displays[0]
  };
  const Menu = { buildFromTemplate: template => ({ items: template.map(item => ({ ...item })), popup() { context.popupCalls = (context.popupCalls || 0) + 1; } }) };
  const manager = new PhotoWindows({ screen, Menu, popupMenus: false, onError: error => context.errors.push(error) });
  const first = new FakeWindow(), second = new FakeWindow({ x: 500, y: 180, width: 402, height: 302 }, true);
  manager.register(first, PHOTO, { scale: 1 });
  manager.register(second, { id: 'photo-two', width: 800, height: 600 }, { scale: .5, floating: true });
  return { context, manager, first, second, firstEvent: eventFor(first), secondEvent: eventFor(second) };
}

test('正常横竖原图保留比例和 1 DIP 边框，小图使用 64×48 可操作最小窗口', () => {
  assert.deepEqual(geometryForScale(PHOTO, 1), { width: 642, height: 422, image: { x: 1, y: 1, width: 640, height: 420 } });
  assert.deepEqual(geometryForScale({ width: 420, height: 640 }, .5), { width: 212, height: 322, image: { x: 1, y: 1, width: 210, height: 320 } });
  const tiny = geometryForScale(PHOTO, 1e-6);
  assert.equal(tiny.width, 64); assert.equal(tiny.height, 48);
  assert.equal(tiny.image.width / tiny.image.height, PHOTO.width / PHOTO.height);
});

test('绘制面积和最长边按 100%／125%／150%／200% 的实际像素限制，含外框', () => {
  for (const factor of [1, 1.25, 1.5, 2]) for (const photo of [{ width: 4096, height: 4096 }, { width: 16384, height: 1024 }, { width: 1024, height: 16384 }]) {
    const targetDisplay = display(factor), limit = scaleLimitForDisplay(photo, targetDisplay);
    const pixels = drawnSize(geometryForScale(photo, limit), targetDisplay);
    assert(limit > 0 && limit <= MAX_SCALE);
    assert(pixels.width <= MAX_DRAWN_EDGE && pixels.height <= MAX_DRAWN_EDGE);
    assert(pixels.area <= MAX_DRAWN_PIXELS);
    const tooLarge = drawnSize(geometryForScale(photo, limit + 1e-5), targetDisplay);
    assert(tooLarge.width > MAX_DRAWN_EDGE || tooLarge.height > MAX_DRAWN_EDGE || tooLarge.area > MAX_DRAWN_PIXELS);
  }
});

test('小原图最高 1600%，适应屏幕返回完整图且不超过工作区', () => {
  assert.equal(scaleLimitForDisplay({ width: 50, height: 50 }, display()), 16);
  const targetDisplay = display(1.5, 0, 1280, 720), photo = { width: 6000, height: 4000 };
  const scale = fitScaleForDisplay(photo, targetDisplay), geometry = geometryForScale(photo, scale);
  assert(geometry.width <= 1280 && geometry.height <= 720);
  assert.equal(geometry.image.width / geometry.image.height, 1.5);
});

test('无效尺寸、缩放与过小工作区拒绝，缺失 DPI 安全按 100% 处理', () => {
  for (const width of [0, -1, NaN, Infinity, '640', 1.5]) assert.throws(() => geometryForScale({ width, height: 420 }, 1), TypeError);
  for (const scale of [-1, NaN, Infinity, '1']) assert.throws(() => geometryForScale(PHOTO, scale), TypeError);
  assert.throws(() => fitScaleForDisplay(PHOTO, display(1, 0, 50, 40)), /最小尺寸/);
  assert.equal(scaleLimitForDisplay(PHOTO, { ...display(), scaleFactor: undefined }), scaleLimitForDisplay(PHOTO, display()));
});

test('注册预览和浮窗独立返回 scale、mode、客户区 image 与 pin，不暴露内部引用', t => {
  const { manager, firstEvent, secondEvent } = harness(); t.after(() => manager.dispose());
  const first = manager.getState(firstEvent), second = manager.getState(secondEvent);
  assert.equal(first.mode, 'fit'); assert.equal(first.scale, 1); assert.equal(first.alwaysOnTop, false);
  assert.equal(second.floating, true); assert.equal(second.scale, .5); assert.equal(second.alwaysOnTop, true);
  assert.deepEqual(first.image, { x: 1, y: 1, width: 640, height: 420 });
  first.bounds.x = 99999; first.image.width = 1;
  assert.equal(manager.getState(firstEvent).bounds.x, 100); assert.equal(manager.getState(firstEvent).image.width, 640);
});

test('来源限定到已注册窗口主 Frame，其他窗口和子 Frame 不能读取或控制', t => {
  const { manager, first } = harness(); t.after(() => manager.dispose());
  for (const event of [{ sender: {}, senderFrame: {} }, { sender: first.webContents, senderFrame: {} }, {}]) {
    for (const action of [() => manager.getState(event), () => manager.setAlwaysOnTop(event, true), () => manager.resize(event, { scale: 2 }),
      () => manager.beginDrag(event), () => manager.moveDrag(event), () => manager.endDrag(event), () => manager.showMenu(event),
      () => manager.beginFrameResize(event, 'se'), () => manager.moveFrameResize(event), () => manager.endFrameResize(event)]) {
      assert.throws(action, /不允许/);
    }
  }
});

test('置顶只切换发送窗口，错误类型不改变任何窗口', t => {
  const { manager, firstEvent, secondEvent } = harness(); t.after(() => manager.dispose());
  const state = manager.setAlwaysOnTop(firstEvent, true);
  assert.equal(state.alwaysOnTop, true); assert.equal(manager.getState(secondEvent).alwaysOnTop, true);
  manager.setAlwaysOnTop(secondEvent, false);
  assert.equal(manager.getState(firstEvent).alwaysOnTop, true);
  assert.throws(() => manager.setAlwaysOnTop(firstEvent, 'false'), TypeError);
});

test('缩放按钮固定窗口中心，滚轮原图锚点使用原生 DIP 鼠标坐标', t => {
  const { context, manager, firstEvent, secondEvent } = harness(); t.after(() => manager.dispose());
  const old = manager.getState(firstEvent), second = manager.getState(secondEvent);
  const enlarged = manager.resize(firstEvent, { scale: 2 });
  assert.equal(enlarged.mode, 'manual'); assert.equal(enlarged.bounds.width, 1282); assert.equal(enlarged.bounds.height, 842);
  assert.equal(enlarged.bounds.x + enlarged.bounds.width / 2, old.bounds.x + old.bounds.width / 2);
  assert.equal(enlarged.bounds.y + enlarged.bounds.height / 2, old.bounds.y + old.bounds.height / 2);
  context.cursor = { x: 800, y: 500 };
  const anchored = manager.resize(firstEvent, { scale: .5, anchor: { x: .25, y: .75 } });
  assert(Math.abs(anchored.bounds.x + anchored.image.x + anchored.image.width * .25 - 800) <= .5);
  assert(Math.abs(anchored.bounds.y + anchored.image.y + anchored.image.height * .75 - 500) <= .5);
  assert.deepEqual(manager.getState(secondEvent), second);
});

test('允许放大到屏幕外，适应模式回到屏幕内，1:1 也受物理像素上限约束', t => {
  const { manager, firstEvent, first } = harness([display(1.5, 0, 1280, 720)]); t.after(() => manager.dispose());
  const oversized = manager.resize(firstEvent, { scale: 4 });
  assert(oversized.bounds.width > 1280 && oversized.bounds.height > 720);
  assert(oversized.visibleArea.width <= 1280 && oversized.visibleArea.height <= 720);
  const fitted = manager.resize(firstEvent, { mode: 'fit' });
  assert.equal(fitted.mode, 'fit'); assert(fitted.bounds.x >= 0 && fitted.bounds.y >= 0);
  assert(fitted.bounds.x + fitted.bounds.width <= 1280 && fitted.bounds.y + fitted.bounds.height <= 720);
  manager.unregister(first);
  manager.register(first, { id: 'huge', width: 12000, height: 12000 }, { scale: .01 });
  const actual = manager.resize(firstEvent, { mode: 'actual' });
  assert.equal(actual.mode, 'actual'); assert(actual.scale < 1); assert(actual.drawnSize.area <= MAX_DRAWN_PIXELS);
});

test('无效 resize 请求与越界锚点拒绝且保留现有状态', t => {
  const { manager, firstEvent } = harness(); t.after(() => manager.dispose());
  const before = manager.getState(firstEvent);
  for (const payload of [null, [], {}, { scale: 0 }, { scale: -1 }, { scale: Infinity }, { scale: '2' }, { mode: 'manual' },
    { mode: 'fit', scale: 1 }, { mode: 'fit', anchor: { x: .5, y: .5 } }, { scale: 2, anchor: { x: -1, y: .5 } },
    { scale: 2, anchor: { x: 1.1, y: .5 } }, { scale: 2, anchor: { x: .5, y: NaN } }, { scale: 2, width: 9999 }]) {
    assert.throws(() => manager.resize(firstEvent, payload), TypeError);
    assert.deepEqual(manager.getState(firstEvent), before);
  }
});

test('达到最小窗口后图片仍清晰可见，小原图不强制放大，state 提供 minScale', t => {
  const { manager, firstEvent, first } = harness(); t.after(() => manager.dispose());
  const smallest = manager.resize(firstEvent, { scale: 1e-6 });
  assert.equal(smallest.bounds.width, 64); assert.equal(smallest.bounds.height, 48);
  assert.equal(smallest.minScale, 62 / PHOTO.width); assert.equal(smallest.scale, smallest.minScale);
  assert.equal(smallest.image.width, 62); assert(smallest.image.height > 40);
  manager.unregister(first); manager.register(first, { id: 'small-photo', width: 20, height: 10 }, { scale: 1 });
  const small = manager.resize(firstEvent, { scale: .001 });
  assert.equal(small.minScale, 1); assert.equal(small.scale, 1); assert.equal(small.image.width, 20); assert.equal(small.image.height, 10);
});

test('原生 setBounds 失败保留此前比例、模式、拖动会话和窗口状态', t => {
  const { manager, firstEvent, first } = harness(); t.after(() => manager.dispose());
  manager.beginDrag(firstEvent);
  const previous = manager.getState(firstEvent);
  first.failNextBounds = true;
  assert.throws(() => manager.resize(firstEvent, { scale: 2 }), /原生窗口调整失败/);
  assert.deepEqual(manager.getState(firstEvent), previous);
});

test('滚轮锚点将窗口移到高 DPI 屏时，在目标显示器重新检查实际绘制上限', t => {
  const { context, manager, firstEvent } = harness([display(1, 0, 1920, 1080), display(2, 1920, 1920, 1080)]);
  t.after(() => manager.dispose()); context.cursor = { x: 2800, y: 600 };
  const state = manager.resize(firstEvent, { scale: 10, anchor: { x: .5, y: .5 } });
  assert.equal(state.displayScaleFactor, 2); assert(state.scale <= state.scaleLimit);
  assert(state.drawnSize.area <= MAX_DRAWN_PIXELS); assert(state.drawnSize.width <= MAX_DRAWN_EDGE);
  assert(Math.abs(state.bounds.x + state.image.x + state.image.width / 2 - 2800) <= .5);
});

test('原生返回的位置跨入另一 DPI 屏时收紧，原生客户区缩小时图片同比回退且不溢出', t => {
  const { manager, firstEvent, first } = harness([display(1, 0, 1920, 1080), display(2, 1920, 1920, 1080)]);
  t.after(() => manager.dispose());
  let calls = 0; first.adjustBounds = requested => { calls += 1; return { ...requested, x: 2500 }; };
  const relocated = manager.resize(firstEvent, { scale: 6 });
  assert(calls >= 2); assert.equal(relocated.displayScaleFactor, 2); assert(relocated.drawnSize.area <= MAX_DRAWN_PIXELS);
  first.adjustBounds = requested => ({ ...requested, x: 100, y: 100, width: 300, height: 200 });
  const constrained = manager.resize(firstEvent, { scale: 2 });
  assert.equal(constrained.bounds.width, 300); assert.equal(constrained.bounds.height, 200);
  assert.equal(constrained.scale, 298 / PHOTO.width);
  assert(constrained.image.x >= 1 && constrained.image.y >= 1);
  assert(constrained.image.x + constrained.image.width <= 299 && constrained.image.y + constrained.image.height <= 199);
  assert.equal(constrained.image.width / constrained.image.height, PHOTO.width / PHOTO.height);
});

test('整窗拖动用原生鼠标坐标，窗口会话互不影响并允许超屏，blur 结束', t => {
  const { context, manager, first, firstEvent, secondEvent } = harness(); t.after(() => manager.dispose());
  const original = manager.getState(firstEvent), survivor = manager.getState(secondEvent);
  context.cursor = { x: 310, y: 260 }; manager.beginDrag(firstEvent);
  context.cursor = { x: 360, y: 230 }; const moved = manager.moveDrag(firstEvent);
  assert.equal(moved.bounds.x, original.bounds.x + 50); assert.equal(moved.bounds.y, original.bounds.y - 30);
  assert.deepEqual(manager.getState(secondEvent), survivor);
  context.cursor = { x: -500, y: 100 }; const beyond = manager.moveDrag(firstEvent);
  assert(beyond.bounds.x < 0); assert.equal(beyond.scale, original.scale);
  first.emit('blur'); context.cursor = { x: 1000, y: 1000 };
  assert.deepEqual(manager.moveDrag(firstEvent).bounds, beyond.bounds); assert.equal(manager.getState(firstEvent).dragging, false);
});

test('原生尺寸回报比请求多 1 时，多步及重复整窗拖移不累积放大，失败重试仍保持大小', t => {
  for (const factor of [1, 1.25, 1.5]) for (const mode of ['manual', 'frame']) {
    const { context, manager, first, firstEvent, secondEvent } = harness([display(factor)]);
    t.after(() => manager.dispose());
    // 模拟高 DPI DIP↔原生像素往返取整：每次回报都比此次请求多 1。
    // 若下一次把 GetBounds 的回报尺寸当成请求尺寸，窗口会每步累积放大。
    manager.unregister(first);
    first.adjustBounds = requested => ({ ...requested, width: requested.width + 1, height: requested.height + 1 });
    manager.register(first, PHOTO, { scale: 1 });
    manager.resize(firstEvent, { scale: 1.6 });
    if (mode === 'frame') {
      const state = manager.getState(firstEvent);
      context.cursor = { x: state.bounds.x + state.bounds.width, y: state.bounds.y + 100 };
      manager.beginFrameResize(firstEvent, 'e'); context.cursor.x += 100;
      manager.moveFrameResize(firstEvent); manager.endFrameResize(firstEvent);
    }
    const original = manager.getState(firstEvent);
    let survivor = manager.getState(secondEvent);
    let resizeEvents = 0; first.on('resize', () => { resizeEvents++; });
    const assertStable = state => {
      assert.equal(state.bounds.width, original.bounds.width);
      assert.equal(state.bounds.height, original.bounds.height);
      assert.equal(state.mode, mode); assert.equal(state.scale, original.scale);
      assert.deepEqual(state.image, original.image);
      assert.deepEqual(manager.getState(secondEvent), survivor);
    };
    for (let gesture = 0; gesture < 3; gesture++) {
      const before = manager.getState(firstEvent);
      const point = { x: before.bounds.x + 100, y: before.bounds.y + 100 };
      context.cursor = { ...point }; manager.beginDrag(firstEvent);
      for (let step = 1; step <= 12; step++) {
        context.cursor = { x: point.x + step * 4, y: point.y + step * 3 };
        const moved = manager.moveDrag(firstEvent);
        assert.equal(moved.bounds.x, before.bounds.x + step * 4);
        assert.equal(moved.bounds.y, before.bounds.y + step * 3);
        assertStable(moved); assert.equal(moved.dragging, true);
      }
      assert.equal(manager.endDrag(firstEvent).dragging, false);
    }
    // 移动失败及随后重试、失败的比例/自由框调整都不能丢失固定请求尺寸。
    let before = manager.getState(firstEvent);
    context.cursor = { x: before.bounds.x + 100, y: before.bounds.y + 100 };
    manager.beginDrag(firstEvent); context.cursor.x += 4; context.cursor.y += 3;
    const dragging = manager.getState(firstEvent); first.failNextBounds = true;
    assert.throws(() => manager.moveDrag(firstEvent), /原生窗口调整失败/);
    assert.deepEqual(manager.getState(firstEvent), dragging);
    assertStable(manager.moveDrag(firstEvent));
    first.failNextBounds = true;
    assert.throws(() => manager.resize(firstEvent, { scale: 3 }), /原生窗口调整失败/);
    context.cursor.x += 4; context.cursor.y += 3;
    assertStable(manager.moveDrag(firstEvent)); manager.endDrag(firstEvent);
    before = manager.getState(firstEvent);
    context.cursor = { x: before.bounds.x + before.bounds.width, y: before.bounds.y + before.bounds.height };
    manager.beginFrameResize(firstEvent, 'se'); context.cursor.x += 100; context.cursor.y += 80;
    first.failNextBounds = true;
    assert.throws(() => manager.moveFrameResize(firstEvent), /原生窗口调整失败/);
    assertStable(manager.getState(firstEvent)); manager.endFrameResize(firstEvent);
    context.cursor = { x: before.bounds.x + 100, y: before.bounds.y + 100 };
    manager.beginDrag(firstEvent); context.cursor.x += 4; context.cursor.y += 3;
    const moved = manager.moveDrag(firstEvent);
    assertStable(moved); assert.equal(moved.dragging, true);
    assert.equal(manager.endDrag(firstEvent).dragging, false);
    // 窗口曾在副屏上，移除该屏后只能修复位置，不能再把回报尺寸反馈成请求。
    const refreshOnlyPosition = () => {
      manager.refreshDisplays();
      const notified = manager.getState(secondEvent);
      assert.deepEqual({ ...notified, revision: survivor.revision }, survivor,
        '显示配置刷新允许通知其他窗口，但不能改变其尺寸、位置、比例或置顶');
      survivor = notified;
    };
    for (let refresh = 0; refresh < 3; refresh++) {
      context.displays.push(display(factor, 1920, 1920, 1080));
      first.bounds = { ...first.bounds, x: 2500 + refresh * 20, y: 200 };
      context.displays.pop();
      refreshOnlyPosition();
      let repaired = manager.getState(firstEvent);
      assertStable(repaired);
      assert(repaired.visibleArea.width >= 64 && repaired.visibleArea.height >= 48);
      refreshOnlyPosition(); assertStable(manager.getState(firstEvent));
      context.cursor = { x: repaired.bounds.x + 100, y: repaired.bounds.y + 100 };
      manager.beginDrag(firstEvent); context.cursor.x -= 300; context.cursor.y += 20;
      repaired = manager.moveDrag(firstEvent);
      assertStable(repaired); assert.equal(repaired.dragging, true);
      assert.equal(manager.endDrag(firstEvent).dragging, false);
    }
    assert.equal(resizeEvents, 0);
  }
});

test('外部原生移位先保留规模，下次比例操作与显示配置刷新重新 cap', t => {
  const displays = [display(1, 0, 1920, 1080), display(2, 1920, 1920, 1080)];
  const { context, manager, firstEvent, first } = harness(displays); t.after(() => manager.dispose());
  const large = manager.resize(firstEvent, { scale: 6 });
  const sourceScale = large.scale;
  first.setBounds({ x: 1930, y: 10 });
  assert.equal(manager.getState(firstEvent).scale, sourceScale);
  const capped = manager.resize(firstEvent, { scale: sourceScale });
  assert(capped.scale < sourceScale); assert(capped.drawnSize.area <= MAX_DRAWN_PIXELS);
  context.displays = [display(3, 0, 1920, 1080)];
  first.setBounds({ x: 9999, y: 9999 });
  manager.refreshDisplays();
  const refreshed = manager.getState(firstEvent);
  assert(refreshed.visibleArea.width > 0 && refreshed.visibleArea.height > 0);
  assert(refreshed.drawnSize.area <= MAX_DRAWN_PIXELS);
});

test('原生窗口回报多 1 DIP 时，最大倍率、巨图原始大小与巨量拉框仍成功遵守实际绘制上限', t => {
  const assertSafe = state => {
    assert(state.drawnSize.area <= MAX_DRAWN_PIXELS);
    assert(state.drawnSize.width <= MAX_DRAWN_EDGE && state.drawnSize.height <= MAX_DRAWN_EDGE);
    assert(state.scale <= MAX_SCALE);
    assert(state.image.x >= 1 && state.image.y >= 1);
  };
  for (const factor of [1, 1.25, 1.5]) {
    for (const photo of [PHOTO, { id: 'huge-rounding', width: 12000, height: 9000 },
      { id: 'long-rounding', width: 16384, height: 1024 }]) {
      const { context, manager, first, firstEvent } = harness([display(factor)]);
      t.after(() => manager.dispose()); manager.unregister(first);
      first.adjustBounds = requested => ({ ...requested, width: requested.width + 1, height: requested.height + 1 });
      manager.register(first, photo, { scale: photo === PHOTO ? 1 : .05 });
      const payload = photo === PHOTO ? { scale: 16 } : { mode: 'actual' };
      const capped = manager.resize(firstEvent, payload);
      assertSafe(capped); assert.equal(capped.mode, photo === PHOTO ? 'manual' : 'actual');
      assert(Math.abs(capped.image.width / capped.image.height - photo.width / photo.height) <= Number.EPSILON * 4);
      // 上限补偿的第二次原生提交失败时，应回滚至最后一次成功的请求尺寸。
      const nativeSetBounds = first.setBounds.bind(first);
      let calls = 0;
      first.setBounds = input => {
        calls++;
        if (calls === 2) throw new Error('模拟 cap 重试失败');
        nativeSetBounds(input);
      };
      assert.throws(() => manager.resize(firstEvent, payload), /cap 重试失败/);
      first.setBounds = nativeSetBounds;
      const restored = manager.getState(firstEvent);
      assert.deepEqual({ ...restored, revision: capped.revision }, capped);
      context.cursor = { x: restored.bounds.x + 100, y: restored.bounds.y + 100 };
      manager.beginDrag(firstEvent); context.cursor.x += 20; context.cursor.y += 10;
      const moved = manager.moveDrag(firstEvent);
      assert.equal(moved.bounds.width, capped.bounds.width); assert.equal(moved.bounds.height, capped.bounds.height);
      assert.equal(moved.scale, capped.scale); assertSafe(moved);
      manager.endDrag(firstEvent);
    }
    for (const edge of ['se', 'nw']) {
      const { context, manager, first, firstEvent } = harness([display(factor)]);
      t.after(() => manager.dispose()); manager.unregister(first);
      first.adjustBounds = requested => ({ ...requested, width: requested.width + 1, height: requested.height + 1 });
      manager.register(first, PHOTO, { scale: 1 });
      const original = manager.getState(firstEvent);
      context.cursor = { x: edge === 'nw' ? original.bounds.x : original.bounds.x + original.bounds.width,
        y: edge === 'nw' ? original.bounds.y : original.bounds.y + original.bounds.height };
      manager.beginFrameResize(firstEvent, edge);
      context.cursor.x += edge === 'nw' ? -50000 : 50000;
      context.cursor.y += edge === 'nw' ? -50000 : 50000;
      const capped = manager.moveFrameResize(firstEvent);
      assertSafe(capped); assert.equal(capped.mode, 'frame'); assert.equal(capped.resizing, true);
      if (edge === 'se') {
        assert.equal(capped.bounds.x, original.bounds.x); assert.equal(capped.bounds.y, original.bounds.y);
      } else {
        assert(Math.abs(capped.bounds.x + capped.bounds.width - original.bounds.x - original.bounds.width) <= 1);
        assert(Math.abs(capped.bounds.y + capped.bounds.height - original.bounds.y - original.bounds.height) <= 1);
      }
      const nativeSetBounds = first.setBounds.bind(first);
      let calls = 0;
      first.setBounds = input => {
        calls++;
        if (calls === 2) throw new Error('模拟 frame cap 重试失败');
        nativeSetBounds(input);
      };
      assert.throws(() => manager.moveFrameResize(firstEvent), /frame cap 重试失败/);
      first.setBounds = nativeSetBounds;
      const restored = manager.getState(firstEvent);
      assert.deepEqual({ ...restored, revision: capped.revision }, capped);
      manager.endFrameResize(firstEvent);
      context.cursor = { x: restored.bounds.x + 100, y: restored.bounds.y + 100 };
      manager.beginDrag(firstEvent); context.cursor.x += 20; context.cursor.y += 10;
      const moved = manager.moveDrag(firstEvent);
      assert.equal(moved.bounds.width, capped.bounds.width); assert.equal(moved.bounds.height, capped.bounds.height);
      assert.equal(moved.scale, capped.scale); assertSafe(moved);
      manager.endDrag(firstEvent);
    }
  }
});

test('可见区域使用客户区坐标，超屏窗口的工具定位不会采用屏幕绝对坐标', t => {
  const { manager, first, firstEvent } = harness([display(1, 1000, 1600, 900)]); t.after(() => manager.dispose());
  first.setBounds({ x: 800, y: -100, width: 1800, height: 1200 });
  const state = manager.getState(firstEvent);
  assert.deepEqual(state.visibleArea, { x: 200, y: 100, width: 1600, height: 900 });
});

test('近乎移出屏幕时只保留 64×48 可操作角，跨屏拖动不收紧整个窗口或改变比例', t => {
  const { context, manager, firstEvent, first } = harness([display(1, 0, 1920, 1080), display(1.5, 1920, 1280, 900)]);
  t.after(() => manager.dispose());
  const large = manager.resize(firstEvent, { scale: 2 });
  first.setBounds({ x: -large.bounds.width + 1, y: -large.bounds.height + 1 });
  manager.refreshDisplays();
  const repaired = manager.getState(firstEvent);
  assert(repaired.visibleArea.width >= 64 && repaired.visibleArea.height >= 48);
  assert(repaired.bounds.x < 0 && repaired.bounds.y < 0); assert.equal(repaired.scale, large.scale);
  context.cursor = { x: 2000, y: 500 }; manager.beginDrag(firstEvent);
  context.cursor = { x: 3199, y: 899 }; const dragged = manager.moveDrag(firstEvent);
  const intersection = visibleAreaFor(dragged.bounds, context.displays[1].workArea);
  assert(intersection.width >= 64 && intersection.height >= 48);
  assert.equal(dragged.bounds.width, repaired.bounds.width); assert.equal(dragged.bounds.height, repaired.bounds.height); assert.equal(dragged.scale, repaired.scale);
});

test('上下错位屏中匹配显示器只有细条可见时，工具采用另一屏的完整可操作角', t => {
  const firstDisplay = display(2, 0, 1920, 4000), secondDisplay = display(1, 1920, 1920, 1080);
  secondDisplay.bounds.y = 3452; secondDisplay.workArea.y = 3452;
  const { manager, firstEvent, first } = harness([firstDisplay, secondDisplay]); t.after(() => manager.dispose());
  first.setBounds({ x: 1919, y: 0, width: 65, height: 3500 });
  const state = manager.getState(firstEvent);
  assert.equal(state.displayScaleFactor, 2);
  assert.deepEqual(state.visibleArea, { x: 1, y: 3452, width: 64, height: 48 });
});

test('原生连续事件聚合通知且 revision 单调增加，closed/dispose 清理监听和通知', async t => {
  const { manager, first, firstEvent, second } = harness(); t.after(() => manager.dispose());
  await new Promise(resolve => setTimeout(resolve, 25)); first.sent.length = 0;
  const before = manager.getState(firstEvent).revision;
  first.setBounds({ x: 200 }); first.setBounds({ y: 300 }); first.setAlwaysOnTop(true);
  const latest = manager.getState(firstEvent).revision;
  assert(latest > before);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(first.sent.length, 1); assert.equal(first.sent[0].channel, 'rack:preview-state');
  assert.equal(first.sent[0].payload.revision, latest);
  first.setBounds({ x: 210 }); first.close();
  assert.throws(() => manager.getState(firstEvent), /不允许/);
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(first.sent.length, 1);
  assert.equal(first.listenerCount('move'), 0); assert.equal(first.listenerCount('blur'), 0);
  manager.dispose(); assert.equal(second.listenerCount('resize'), 0); assert.equal(manager.entries.size, 0);
});

test('菜单只控制指定图片窗，checkbox 切换返回状态，关闭不再读取销毁窗口', t => {
  const { context, manager, first, firstEvent, secondEvent } = harness(); t.after(() => manager.dispose());
  const menu = manager.showMenu(firstEvent);
  assert.deepEqual(menu.labels, ['放大', '缩小', '适应屏幕', '1:1', '置顶', '关闭']);
  assert.deepEqual(menu.checked, { '置顶': false }); assert.equal(context.popupCalls || 0, 0);
  const pinned = manager.chooseMenu(first.id, '置顶'); assert.equal(pinned.alwaysOnTop, true);
  assert.equal(manager.getState(secondEvent).alwaysOnTop, true);
  assert.equal(manager.chooseMenu(first.id, '置顶').alwaysOnTop, false);
  assert.equal(manager.chooseMenu(first.id, '适应屏幕').mode, 'fit');
  assert.throws(() => manager.chooseMenu(-1, '置顶'), /不匹配/);
  assert.throws(() => manager.chooseMenu(first.id, '删除'), /无效/);
  manager.chooseMenu(first.id, '关闭'); assert.equal(first.isDestroyed(), true); assert.equal(manager.getLastMenu(), null);
  assert.equal(context.errors.length, 0);
});

test('八方向边框按原生 DIP 鼠标变化自由调整，保留未拖边并完整 contain 图片', t => {
  for (const edge of FRAME_EDGES) {
    const { context, manager, firstEvent, secondEvent } = harness(); t.after(() => manager.dispose());
    const original = manager.getState(firstEvent), survivor = manager.getState(secondEvent);
    context.cursor = { x: edge.includes('w') ? original.bounds.x : edge.includes('e') ? original.bounds.x + original.bounds.width : original.bounds.x + original.bounds.width / 2,
      y: edge.includes('n') ? original.bounds.y : edge.includes('s') ? original.bounds.y + original.bounds.height : original.bounds.y + original.bounds.height / 2 };
    const started = manager.beginFrameResize(firstEvent, edge); assert.equal(started.resizing, true); assert.equal(started.dragging, false);
    context.cursor.x += edge.includes('w') ? -80 : edge.includes('e') ? 80 : 0;
    context.cursor.y += edge.includes('n') ? -60 : edge.includes('s') ? 60 : 0;
    const result = manager.moveFrameResize(firstEvent), horizontal = edge.includes('w') || edge.includes('e'), vertical = edge.includes('n') || edge.includes('s');
    assert.equal(result.mode, 'frame'); assert.equal(result.bounds.width, original.bounds.width + (horizontal ? 80 : 0));
    assert.equal(result.bounds.height, original.bounds.height + (vertical ? 60 : 0));
    assert.equal(result.bounds.x, original.bounds.x - (edge.includes('w') ? 80 : 0));
    assert.equal(result.bounds.y, original.bounds.y - (edge.includes('n') ? 60 : 0));
    assert.equal(result.image.width / result.image.height, PHOTO.width / PHOTO.height);
    assert.equal(result.image.x, (result.bounds.width - result.image.width) / 2); assert.equal(result.image.y, (result.bounds.height - result.image.height) / 2);
    assert(result.image.x >= 1 && result.image.y >= 1);
    assert(result.image.width <= result.bounds.width - 2 && result.image.height <= result.bounds.height - 2);
    assert.deepEqual(manager.getState(secondEvent), survivor);
    assert.equal(manager.endFrameResize(firstEvent).resizing, false);
  }
});

test('单边改变框的长宽比，拉大框时图片继续放大，不冻结之前比例', t => {
  const { context, manager, firstEvent } = harness(); t.after(() => manager.dispose());
  context.cursor = { x: 742, y: 311 }; manager.beginFrameResize(firstEvent, 'e');
  context.cursor.x += 400; const wide = manager.moveFrameResize(firstEvent);
  assert.equal(wide.bounds.width, 1042); assert.equal(wide.bounds.height, 422);
  assert.equal(wide.scale, 1); assert(wide.image.x > 1); assert.equal(wide.image.y, 1);
  manager.endFrameResize(firstEvent);
  context.cursor = { x: wide.bounds.x + wide.bounds.width / 2, y: wide.bounds.y + wide.bounds.height };
  manager.beginFrameResize(firstEvent, 's'); context.cursor.y += 400;
  const taller = manager.moveFrameResize(firstEvent);
  assert(taller.scale > wide.scale); assert.equal(taller.scale, 1040 / PHOTO.width);
  assert.equal(taller.bounds.width, 1042); assert.equal(taller.bounds.height, 822);
});

test('西北边缩过对边停在 64×48，固定右下角且没有反转尺寸', () => {
  const original = { x: 100, y: 100, width: 642, height: 422 };
  const result = frameBoundsFromPoint(original, { x: 100, y: 100 }, { x: 9999, y: 9999 }, 'nw', display());
  assert.equal(result.width, 64); assert.equal(result.height, 48);
  assert.equal(result.x + result.width, 742); assert.equal(result.y + result.height, 522);
  assert.throws(() => frameBoundsFromPoint(original, { x: 0, y: 0 }, { x: 1, y: 1 }, 'middle', display()), TypeError);
});

test('任意框比例在不同 DPI 下受实际窗口面积和最长边限制，单边保持另一尺寸', () => {
  for (const factor of [1, 1.25, 1.5, 2]) {
    const targetDisplay = display(factor);
    const corner = frameSizeForDisplay(50000, 50000, targetDisplay), pixels = drawnSize(corner, targetDisplay);
    assert(corner.width >= 64 && corner.height >= 48); assert(pixels.area <= MAX_DRAWN_PIXELS);
    assert(pixels.width <= MAX_DRAWN_EDGE && pixels.height <= MAX_DRAWN_EDGE);
    const horizontal = frameSizeForDisplay(50000, 422, targetDisplay, { horizontalOnly: true });
    assert.equal(horizontal.height, 422); assert(drawnSize(horizontal, targetDisplay).area <= MAX_DRAWN_PIXELS);
    const vertical = frameSizeForDisplay(642, 50000, targetDisplay, { verticalOnly: true });
    assert.equal(vertical.width, 642); assert(drawnSize(vertical, targetDisplay).height <= MAX_DRAWN_EDGE);
  }
});

test('框模式最大显示比例 16，小原图在更大框中不无限放大', t => {
  const { context, manager, first, firstEvent } = harness(); t.after(() => manager.dispose());
  manager.unregister(first); manager.register(first, { id: 'tiny-frame-photo', width: 20, height: 10 }, { scale: 1 });
  context.cursor = { x: 164, y: 148 }; manager.beginFrameResize(firstEvent, 'se');
  context.cursor = { x: 4164, y: 3148 }; const result = manager.moveFrameResize(firstEvent);
  assert.equal(result.mode, 'frame'); assert.equal(result.scale, 16);
  assert.equal(result.image.width, 320); assert.equal(result.image.height, 160);
  assert(result.drawnSize.area <= MAX_DRAWN_PIXELS);
});

test('边框无效方向和原生调整失败保留此前状态，框调整与整窗拖动互斥', t => {
  const { manager, firstEvent, first } = harness(); t.after(() => manager.dispose());
  const original = manager.getState(firstEvent);
  for (const edge of [undefined, null, '', 'N', 'left', 'middle', 1, {}]) {
    assert.throws(() => manager.beginFrameResize(firstEvent, edge), TypeError); assert.deepEqual(manager.getState(firstEvent), original);
  }
  manager.beginDrag(firstEvent); assert.equal(manager.getState(firstEvent).dragging, true);
  manager.beginFrameResize(firstEvent, 'se'); assert.equal(manager.getState(firstEvent).dragging, false);
  const before = manager.getState(firstEvent); first.failNextBounds = true;
  assert.throws(() => manager.moveFrameResize(firstEvent), /原生窗口调整失败/); assert.deepEqual(manager.getState(firstEvent), before);
  manager.beginDrag(firstEvent); assert.equal(manager.getState(firstEvent).resizing, false); assert.equal(manager.getState(firstEvent).dragging, true);
});

test('blur、菜单、比例缩放、屏幕刷新和关闭都结束框调整会话', t => {
  const { context, manager, first, firstEvent } = harness(); t.after(() => manager.dispose());
  for (const finish of [() => first.emit('blur'), () => manager.showMenu(firstEvent), () => manager.resize(firstEvent, { scale: 1 }), () => manager.refreshDisplays()]) {
    manager.beginFrameResize(firstEvent, 'e'); assert.equal(manager.getState(firstEvent).resizing, true);
    finish(); const before = manager.getState(firstEvent); assert.equal(before.resizing, false);
    context.cursor.x += 30; assert.deepEqual(manager.moveFrameResize(firstEvent), before);
  }
  manager.beginFrameResize(firstEvent, 'se'); first.close();
  assert.throws(() => manager.moveFrameResize(firstEvent), /不允许/); assert.equal(first.listenerCount('blur'), 0);
});

test('自由框整窗移动保持模式和框尺寸，滚轮及适应恢复按原图比例的窗口', t => {
  const { context, manager, firstEvent } = harness(); t.after(() => manager.dispose());
  context.cursor = { x: 742, y: 311 }; manager.beginFrameResize(firstEvent, 'e'); context.cursor.x += 300;
  const frame = manager.moveFrameResize(firstEvent); manager.endFrameResize(firstEvent);
  manager.beginDrag(firstEvent); context.cursor.x += 60; context.cursor.y += 20; const moved = manager.moveDrag(firstEvent);
  assert.equal(moved.mode, 'frame'); assert.equal(moved.bounds.width, frame.bounds.width); assert.equal(moved.bounds.height, frame.bounds.height);
  manager.endDrag(firstEvent);
  const wheel = manager.resize(firstEvent, { scale: moved.scale * 1.25 });
  assert.equal(wheel.mode, 'manual'); assert.equal(wheel.resizing, false);
  assert.equal(wheel.bounds.width, Math.ceil(PHOTO.width * wheel.scale) + 2); assert.equal(wheel.bounds.height, Math.ceil(PHOTO.height * wheel.scale) + 2);
  assert.equal(manager.resize(firstEvent, { mode: 'fit' }).mode, 'fit');
});

test('框调整目标跨高 DPI 屏重新 cap，显示缩放改变保持框比例并回退安全大小', t => {
  const { context, manager, firstEvent, first } = harness([display(1, 0, 1920, 1080), display(2, 1920, 1920, 1080)]);
  t.after(() => manager.dispose());
  context.cursor = { x: 742, y: 522 }; manager.beginFrameResize(firstEvent, 'se');
  context.cursor = { x: 12000, y: 12000 }; const huge = manager.moveFrameResize(firstEvent);
  assert.equal(huge.mode, 'frame'); assert(huge.drawnSize.area <= MAX_DRAWN_PIXELS);
  manager.endFrameResize(firstEvent);
  first.setBounds({ x: 2200, y: 10 }); context.displays = [display(3, 0, 1920, 1080)];
  const previousRatio = huge.bounds.width / huge.bounds.height;
  manager.refreshDisplays(); const refreshed = manager.getState(firstEvent);
  assert.equal(refreshed.mode, 'frame'); assert.equal(refreshed.resizing, false);
  assert(refreshed.drawnSize.area <= MAX_DRAWN_PIXELS); assert(refreshed.drawnSize.width <= MAX_DRAWN_EDGE);
  assert(Math.abs(refreshed.bounds.width / refreshed.bounds.height - previousRatio) < .002);
  assert(refreshed.visibleArea.width >= 64 && refreshed.visibleArea.height >= 48);
});

test('低 DPI 向高 DPI 整窗拖移保持 frame 模式并收紧安全尺寸，后续拖移继续且不跳回', t => {
  const { context, manager, firstEvent } = harness([display(1, 0, 1920, 1080), display(2, 1920, 1920, 1080)]);
  t.after(() => manager.dispose());
  context.cursor = { x: 742, y: 522 }; manager.beginFrameResize(firstEvent, 'se');
  context.cursor = { x: 3100, y: 3100 }; const frame = manager.moveFrameResize(firstEvent);
  manager.endFrameResize(firstEvent);
  assert.equal(frame.displayScaleFactor, 1); assert.equal(frame.bounds.width, 3000); assert.equal(frame.bounds.height, 3000);
  context.cursor = { x: 300, y: 300 }; manager.beginDrag(firstEvent);
  context.cursor = { x: 2500, y: 300 }; const crossed = manager.moveDrag(firstEvent);
  assert.equal(crossed.displayScaleFactor, 2); assert.equal(crossed.mode, 'frame'); assert.equal(crossed.dragging, true);
  assert(crossed.drawnSize.area <= MAX_DRAWN_PIXELS); assert(crossed.drawnSize.width <= MAX_DRAWN_EDGE);
  assert(crossed.bounds.width < frame.bounds.width); assert(crossed.bounds.height < frame.bounds.height);
  assert(Math.abs(crossed.bounds.width / crossed.bounds.height - frame.bounds.width / frame.bounds.height) < .002);
  context.cursor = { x: 2510, y: 315 }; const continued = manager.moveDrag(firstEvent);
  assert.equal(continued.bounds.x, crossed.bounds.x + 10); assert.equal(continued.bounds.y, crossed.bounds.y + 15);
  assert.equal(continued.bounds.width, crossed.bounds.width); assert.equal(continued.bounds.height, crossed.bounds.height);
  assert.equal(continued.mode, 'frame'); assert.equal(continued.dragging, true);
});

test('原比例图片窗低 DPI 拖到高 DPI 也保持原模式及拖移会话并满足实际像素 cap', t => {
  const { context, manager, firstEvent } = harness([display(1, 0, 1920, 1080), display(2, 1920, 1920, 1080)]);
  t.after(() => manager.dispose());
  const large = manager.resize(firstEvent, { scale: 6 }); assert.equal(large.displayScaleFactor, 1);
  context.cursor = { x: 100, y: 100 }; manager.beginDrag(firstEvent);
  context.cursor = { x: 2500, y: 300 }; const crossed = manager.moveDrag(firstEvent);
  assert.equal(crossed.displayScaleFactor, 2); assert.equal(crossed.mode, 'manual'); assert.equal(crossed.dragging, true);
  assert(crossed.scale < large.scale); assert(crossed.drawnSize.area <= MAX_DRAWN_PIXELS);
  assert(Math.abs(crossed.image.width / crossed.image.height - PHOTO.width / PHOTO.height) < Number.EPSILON * 4);
  context.cursor = { x: 2512, y: 308 }; const continued = manager.moveDrag(firstEvent);
  assert.equal(continued.bounds.x, crossed.bounds.x + 12); assert.equal(continued.bounds.y, crossed.bounds.y + 8);
  assert.equal(continued.mode, 'manual'); assert.equal(continued.dragging, true);
});
