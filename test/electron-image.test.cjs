'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClipboardReader, normalizeImage, isImageObservation } = require('../src/lib/electron-image.cjs');
const { isImage } = require('../src/lib/repository.cjs');
const { ClipboardCollector } = require('../src/lib/collector.cjs');

function fixture() {
  let current = 'A';
  const counters = { decode: 0, bitmap: 0, png: 0, resize: 0 };
  const specs = {
    A: { width: 800, height: 600, pixels: 'pixels-A' },
    'A-reencoded': { width: 800, height: 600, pixels: 'pixels-A' },
    B: { width: 800, height: 600, pixels: 'pixels-B' },
    'A-other-size': { width: 400, height: 300, pixels: 'pixels-A' },
    empty: { width: 0, height: 0, pixels: '' },
    huge: { width: 20_000, height: 20_000, pixels: '' }
  };
  function fakeImage(name, thumbnail = false) {
    const spec = specs[name];
    return {
      isEmpty: () => !spec?.width,
      getSize: () => ({ width: spec.width, height: spec.height }),
      toBitmap: () => { counters.bitmap++; return Buffer.from(spec.pixels); },
      resize: (size) => {
        counters.resize++;
        counters.lastThumbnail = size;
        return fakeImage(name, true);
      },
      toPNG: () => { counters.png++; return Buffer.from(`${thumbnail ? 'thumbnail' : 'original'}:${name}`); }
    };
  }
  const nativeImage = {
    createFromBuffer: (buffer) => { counters.decode++; return fakeImage(buffer.toString()); }
  };
  const clipboard = {
    read: async () => current === null
      ? [{ types: ['text/plain'], getType: async () => new Blob(['text']) }]
      : [{ types: ['image/png'], getType: async () => new Blob([current]) }]
  };
  return { reader: createClipboardReader(clipboard, nativeImage), counters, fakeImage, set: (value) => { current = value; } };
}

test('基线和重复检查只计算元数据，不编码原PNG或缩略图，重复图无需再解码', async () => {
  const { reader, counters } = fixture();
  const baseline = await reader();
  assert.equal(isImageObservation(baseline), true);
  assert.equal(isImage(baseline), false);
  assert.deepEqual(Object.keys(baseline).sort(), ['hash', 'height', 'loadImage', 'width']);
  for (let index = 0; index < 10; index++) {
    const duplicate = await reader();
    assert.equal(duplicate.hash, baseline.hash);
    assert.equal(isImageObservation(duplicate), true);
  }
  assert.equal(counters.decode, 1);
  assert.equal(counters.bitmap, 1);
  assert.equal(counters.png, 0);
  assert.equal(counters.resize, 0);
});

test('按需生成完整原图且仅缩小缩略图，消费后不在描述里保留图片缓冲', async () => {
  const { reader, counters } = fixture();
  const observed = await reader();
  const full = await observed.loadImage();
  assert.equal(isImage(full), true);
  assert.equal(full.width, 800);
  assert.equal(full.height, 600);
  assert.deepEqual(full.png, Buffer.from('original:A'));
  assert.deepEqual(full.thumbnail, Buffer.from('thumbnail:A'));
  assert.deepEqual(counters.lastThumbnail, { width: 235, height: 176, quality: 'best' });
  assert.equal(counters.decode, 1);
  assert.equal(counters.bitmap, 1);
  assert.equal(counters.png, 2);
  assert.throws(() => observed.loadImage(), /读取已结束/);
  const duplicate = await reader();
  assert.equal(duplicate.hash, full.hash);
  assert.equal(counters.png, 2);
  assert.equal(counters.decode, 1);
});

test('去重哈希仍基于像素及尺寸，重新编码同图不会改变哈希', async () => {
  const { reader, set, counters } = fixture();
  const first = await reader();
  set('A-reencoded');
  const reencoded = await reader();
  assert.equal(reencoded.hash, first.hash);
  set('A-other-size');
  assert.notEqual((await reader()).hash, first.hash);
  set('B');
  assert.notEqual((await reader()).hash, first.hash);
  assert.equal(counters.bitmap, 4);
  assert.equal(counters.png, 0);
});

test('惰性编码使用取得的剪贴板快照，随后剪贴板改变不会串图', async () => {
  const { reader, set } = fixture();
  const first = await reader();
  set('B');
  const second = await reader();
  assert.deepEqual((await first.loadImage()).png, Buffer.from('original:A'));
  assert.deepEqual((await second.loadImage()).png, Buffer.from('original:B'));
});

test('文字清除图片摘要基线，空图忽略，大图在位图或PNG编码前拒绝', async () => {
  const { reader, set, counters } = fixture();
  const first = await reader();
  set(null);
  assert.equal(await reader(), null);
  set('A');
  assert.equal((await reader()).hash, first.hash);
  assert.equal(counters.decode, 2);
  set('empty');
  assert.equal(await reader(), null);
  assert.equal(await reader(), null);
  set('huge');
  await assert.rejects(reader(), /图片太大/);
  assert.equal(counters.bitmap, 2);
  assert.equal(counters.png, 0);
});

test('normalizeImage继续返回既有完整接口，测试夹具和独立调用不受惰性改动影响', () => {
  const { fakeImage } = fixture();
  assert.equal(normalizeImage(fakeImage('empty')), null);
  const normalized = normalizeImage(fakeImage('A'));
  assert.equal(isImage(normalized), true);
  assert.deepEqual(normalized.png, Buffer.from('original:A'));
  assert.equal(isImageObservation({ hash: '../outside', width: 1, height: 1, loadImage() {} }), false);
  assert.equal(isImageObservation({ hash: normalized.hash, width: 0, height: 1, loadImage() {} }), false);
});

test('真实惰性读器联动收集器：基线/重复不编码，新图编码一次，重新编码同图不重挂', async (t) => {
  const { reader, set, counters } = fixture();
  const photos = [];
  const repository = {
    getPhotos: () => photos,
    savePhoto: async (image) => {
      assert.equal(isImage(image), true);
      const photo = { id: image.hash, hash: image.hash };
      photos.push(photo);
      return { photo, added: true };
    }
  };
  const collector = new ClipboardCollector({ readImage: reader, repository, intervalMs: 600_000 });
  t.after(() => collector.stop());
  await collector.start();
  await collector.pollOnce();
  assert.equal(counters.png, 0);
  set('B');
  await collector.pollOnce();
  await collector.pollOnce();
  assert.equal(photos.length, 1);
  assert.equal(counters.png, 2);
  set('A');
  await collector.pollOnce();
  set('A-reencoded');
  await collector.pollOnce();
  assert.equal(photos.length, 2);
  assert.equal(counters.png, 4);
});

test('网页原图字节和扩展名原样返回，只编码缩略图而不重新编码原PNG', () => {
  for (const extension of ['png', 'jpg', 'webp']) {
    const { fakeImage, counters } = fixture();
    const bytes = Buffer.from(`original ${extension} encoded bytes`);
    const full = normalizeImage(fakeImage('A'), { originalBytes: bytes, originalExtension: extension });
    assert.equal(isImage(full), true);
    assert.equal(full.png, bytes);
    assert.equal(full.originalBytes, bytes);
    assert.equal(full.originalExtension, extension);
    assert.equal(counters.png, 1);
    assert.equal(counters.resize, 1);
    assert.deepEqual(full.thumbnail, Buffer.from('thumbnail:A'));
  }
});

test('原始导入选项拒绝空字节和无效扩展，不改变默认PNG归一化接口', () => {
  const { fakeImage } = fixture();
  for (const options of [
    { originalBytes: Buffer.from('bytes'), originalExtension: '../jpg' },
    { originalBytes: Buffer.from('bytes'), originalExtension: 'gif' },
    { originalBytes: Buffer.from('bytes') },
    { originalBytes: Buffer.alloc(0), originalExtension: 'jpg' },
    { originalBytes: new Uint8Array([1]), originalExtension: 'png' },
    { originalExtension: 'png' }
  ]) assert.throws(() => normalizeImage(fakeImage('A'), options), /原始图片字节及格式无效/);
  const full = normalizeImage(fakeImage('A'));
  assert.equal(full.originalBytes, undefined);
  assert.equal(full.originalExtension, undefined);
  assert.deepEqual(full.png, Buffer.from('original:A'));
});

test('紧凑缩略图最大288×176，保持比例，不放大小图片，不改变原图像素', () => {
  for (const dimensions of [
    { width: 1920, height: 1080, expected: { width: 288, height: 162 } },
    { width: 1080, height: 1920, expected: { width: 99, height: 176 } },
    { width: 500, height: 500, expected: { width: 176, height: 176 } },
    { width: 80, height: 40, expected: { width: 80, height: 40 } }
  ]) {
    let thumbnailSize;
    const fakeImage = {
      isEmpty: () => false,
      getSize: () => dimensions,
      toBitmap: () => Buffer.from('same pixels'),
      toPNG: () => Buffer.from('full original'),
      resize: (size) => { thumbnailSize = size; return { toPNG: () => Buffer.from('thumbnail') }; }
    };
    const full = normalizeImage(fakeImage);
    assert.deepEqual({ width: thumbnailSize.width, height: thumbnailSize.height }, dimensions.expected);
    assert.ok(thumbnailSize.width <= 288 && thumbnailSize.height <= 176);
    assert.equal(full.width, dimensions.width);
    assert.equal(full.height, dimensions.height);
    assert.deepEqual(full.png, Buffer.from('full original'));
  }
});
