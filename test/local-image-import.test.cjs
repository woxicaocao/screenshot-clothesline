'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PhotoRepository } = require('../src/lib/repository.cjs');
const { normalizeImage } = require('../src/lib/electron-image.cjs');
const { LocalImageImporter, MAX_LOCAL_FILES, MAX_LOCAL_FILE_BYTES, readBoundedFile } = require('../src/lib/local-image-import.cjs');

function png(width = 800, height = 600, pixels = 'A') {
  const buffer = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.writeUInt32BE(13, 8); buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20);
  return Buffer.concat([buffer, Buffer.from(pixels)]);
}

function jpeg(width = 2, height = 3) {
  const buffer = Buffer.alloc(15);
  buffer.writeUInt16BE(0xffd8, 0); buffer.writeUInt16BE(0xffc0, 2);
  buffer.writeUInt16BE(11, 4); buffer[6] = 8;
  buffer.writeUInt16BE(height, 7); buffer.writeUInt16BE(width, 9);
  return buffer;
}

function webp(width = 2, height = 3) {
  const buffer = Buffer.alloc(26);
  buffer.write('RIFF', 0, 'ascii'); buffer.writeUInt32LE(18, 4); buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8L', 12, 'ascii'); buffer.writeUInt32LE(5, 16); buffer[20] = 0x2f;
  buffer.writeUInt32LE((width - 1) | (height - 1) << 14, 21);
  return buffer;
}

function decoder({ empty = false, overrideSize } = {}) {
  const calls = { decode: 0, bitmap: 0, resize: 0 };
  function image(width, height, pixels) {
    return {
      isEmpty: () => empty,
      getSize: () => overrideSize || { width, height },
      toBitmap: () => { calls.bitmap++; return Buffer.from(pixels); },
      resize: dimensions => {
        calls.resize++; calls.thumbnail = dimensions;
        return { toPNG: () => png(dimensions.width, dimensions.height, pixels) };
      },
      toPNG: () => png(width, height, pixels)
    };
  }
  return {
    calls,
    image,
    nativeImage: {
      createFromBuffer: bytes => {
        calls.decode++;
        if (bytes[0] === 137) return image(bytes.readUInt32BE(16), bytes.readUInt32BE(20), bytes.toString('utf8', 33));
        if (bytes[0] === 0xff) return image(bytes.readUInt16BE(9), bytes.readUInt16BE(7), 'JPEG');
        const bits = bytes.readUInt32LE(21);
        return image(1 + (bits & 0x3fff), 1 + (bits >>> 14 & 0x3fff), 'WEBP');
      }
    }
  };
}

async function fixture(options = {}) {
  // 测试只创建独立目录，全部保留，不自动删除来源或测试缓存。
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clothesline-local-import-'));
  const sourceDirectory = path.join(directory, 'source');
  await fs.mkdir(sourceDirectory);
  const dataDirectory = path.join(directory, 'data');
  const repository = new PhotoRepository(dataDirectory);
  await repository.init();
  const decoded = decoder(options);
  const notifications = [];
  const importer = new LocalImageImporter({ nativeImage: decoded.nativeImage, repository, onPhoto: photo => notifications.push(photo) });
  const source = async (name, bytes) => {
    const filePath = path.join(sourceDirectory, name);
    await fs.writeFile(filePath, bytes);
    return filePath;
  };
  return { directory, sourceDirectory, dataDirectory, repository, importer, source, notifications, ...decoded };
}

test('暂停时逐张导入并保存小缩略图，原文件字节、名称和修改时间保持不变', async () => {
  const f = await fixture();
  await f.repository.updateSettings({ paused: true });
  const original = png(1600, 1200);
  const filePath = await f.source('中文图片.PNG', original);
  const before = await fs.stat(filePath);
  const result = await f.importer.importFiles([filePath]);
  assert.deepEqual([result.added, result.duplicates, result.failed, result.total], [1, 0, 0, 1]);
  assert.match(result.message, /已挂上 1 张/);
  assert.equal(f.repository.getSettings().paused, true);
  assert.equal(f.notifications.length, 1);
  const photo = f.repository.getPhotos()[0];
  assert.equal(photo.width, 1600); assert.equal(photo.height, 1200);
  assert.deepEqual(await fs.readFile(path.join(f.dataDirectory, 'photos', photo.fileName)), original);
  assert.deepEqual(await fs.readFile(filePath), original);
  assert.equal((await fs.stat(filePath)).mtimeMs, before.mtimeMs);
  assert.ok(f.calls.thumbnail.width <= 288 && f.calls.thumbnail.height <= 176);
  const restarted = new PhotoRepository(f.dataDirectory);
  await restarted.init();
  assert.equal(restarted.getPhotos()[0].id, photo.id);
});

test('本机导入与剪贴板图片共用像素哈希，重复图不再增加，编码副本同样去重', async () => {
  const f = await fixture();
  const fromClipboard = normalizeImage(f.image(800, 600, 'A'));
  await f.repository.savePhoto(fromClipboard);
  const one = await f.source('same.png', png());
  const two = await f.source('same-encoding.png', Buffer.concat([png(), Buffer.alloc(8)]));
  // 解码器将尾部无意义填充视为同一像素内容。
  f.nativeImage.createFromBuffer = bytes => f.image(bytes.readUInt32BE(16), bytes.readUInt32BE(20), bytes.toString('utf8', 33).replace(/\0/g, ''));
  const result = await f.importer.importFiles([one, two, one]);
  assert.deepEqual([result.added, result.duplicates, result.failed], [0, 3, 0]);
  assert.equal(f.repository.getPhotos().length, 1);
  assert.equal(f.notifications.length, 0);
});

test('PNG、JPEG和WebP保留原始编码，大小写扩展和.jpeg都可导入', async () => {
  const f = await fixture();
  const values = [['photo.PNG', png()], ['photo.JPEG', jpeg()], ['photo.WEBP', webp()]];
  const files = [];
  for (const [name, bytes] of values) files.push(await f.source(name, bytes));
  const result = await f.importer.importFiles(files);
  assert.deepEqual([result.added, result.failed], [3, 0]);
  for (const [name, bytes] of values) {
    const extension = name.endsWith('JPEG') ? '.jpg' : path.extname(name).toLowerCase();
    const photo = f.repository.getPhotos().find(entry => path.extname(entry.fileName) === extension);
    assert.deepEqual(await fs.readFile(path.join(f.dataDirectory, 'photos', photo.fileName)), bytes);
    assert.deepEqual(await fs.readFile(await f.repository.prepareExport(photo.id)), bytes);
  }
});

test('混合批次拒绝文本、假扩展、路径URL、目录及缺失文件，其余图片仍继续保存', async () => {
  const f = await fixture();
  const valid = await f.source('good.png', png());
  const text = await f.source('text.txt', Buffer.from('text'));
  const fake = await f.source('fake.jpg', png());
  const directory = path.join(f.sourceDirectory, 'folder.png'); await fs.mkdir(directory);
  const result = await f.importer.importFiles([text, fake, 'https://example.test/file.png', directory, path.join(f.sourceDirectory, 'missing.png'), valid]);
  assert.deepEqual([result.added, result.failed, result.total], [1, 5, 6]);
  assert.equal(result.errors.length, 5);
  assert.equal(f.calls.decode, 1);
  assert.match(result.errors[0].message, /仅支持/);
  assert.match(result.errors[1].message, /不一致/);
  assert.match(result.errors[2].message, /本机文件夹/);
  assert.match(result.errors[3].message, /文件夹/);
  assert.match(result.errors[4].message, /不存在/);
  assert.equal(f.notifications.length, 1);
});

test('保存失败不会提前显示照片，重拖可以复用已写副本并成功保存', async () => {
  const f = await fixture();
  const source = await f.source('retry.png', png());
  const writeIndex = f.repository._writeIndex.bind(f.repository);
  f.repository._writeIndex = async () => { f.repository._writeIndex = writeIndex; throw new Error('disk full'); };
  const first = await f.importer.importFiles([source]);
  assert.deepEqual([first.added, first.failed], [0, 1]);
  assert.match(first.errors[0].message, /重新拖入重试/);
  assert.equal(f.repository.getPhotos().length, 0);
  assert.equal(f.notifications.length, 0);
  const retry = await f.importer.importFiles([source]);
  assert.deepEqual([retry.added, retry.failed], [1, 0]);
  assert.equal(f.notifications.length, 1);
  assert.deepEqual(await fs.readFile(source), png());
});

test('像素上限及动画在解码前拦截，损坏图片不入库', async () => {
  const f = await fixture({ empty: true });
  const huge = await f.source('huge.png', png(10000, 10000));
  const animation = Buffer.alloc(20); animation.writeUInt32BE(8, 0); animation.write('acTL', 4, 'ascii'); animation.writeUInt32BE(2, 8);
  const animated = await f.source('animation.png', Buffer.concat([png(1, 1, ''), animation]));
  const broken = await f.source('broken.png', png());
  const result = await f.importer.importFiles([huge, animated, broken]);
  assert.equal(result.failed, 3);
  assert.match(result.errors[0].message, /4000 万像素/);
  assert.match(result.errors[1].message, /动画/);
  assert.match(result.errors[2].message, /损坏/);
  assert.equal(f.calls.decode, 1);
  assert.equal(f.calls.bitmap, 0);
  assert.equal(f.repository.getPhotos().length, 0);
});

test('JPEG方向转换允许交换尺寸，其他格式尺寸不匹配在位图生成前拦截', async () => {
  const f = await fixture({ overrideSize: { width: 3, height: 2 } });
  const rotated = await f.source('rotated.jpg', jpeg());
  const mismatched = await f.source('mismatch.png', png(2, 3));
  const result = await f.importer.importFiles([rotated, mismatched]);
  assert.deepEqual([result.added, result.failed], [1, 1]);
  assert.deepEqual([f.repository.getPhotos()[0].width, f.repository.getPhotos()[0].height], [3, 2]);
  assert.equal(f.calls.bitmap, 1);
});

test('批次及并发上限避免累积大图片，上一批完成后仍可再次导入', async () => {
  const f = await fixture();
  const source = await f.source('one.png', png());
  await assert.rejects(f.importer.importFiles([]), /1 至 100/);
  await assert.rejects(f.importer.importFiles(Array(MAX_LOCAL_FILES + 1).fill(source)), /最多 100/);
  const save = f.repository.savePhoto.bind(f.repository);
  let release, reached;
  const began = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.repository.savePhoto = async image => { reached(); await gate; return save(image); };
  const first = f.importer.importFiles([source, source]);
  await began;
  await assert.rejects(f.importer.importFiles([source]), /上一批/);
  assert.equal(f.calls.decode, 1);
  release();
  assert.deepEqual([(await first).added, f.calls.decode], [1, 2]);
  assert.equal((await f.importer.importFiles([source])).duplicates, 1);
});

test('读取按尺寸限额分配缓冲，超大文件不读取，增长或中途截断时拒绝并关闭只读句柄', async () => {
  for (const mode of ['large', 'grow', 'shrink', 'valid']) {
    const operations = []; let stats = 0;
    const fileSystem = {
      lstat: async () => ({ isFile: () => true }),
      open: async (_name, flags) => {
        operations.push(['open', flags]);
        return {
          stat: async () => ({ isFile: () => true, size: mode === 'large' ? MAX_LOCAL_FILE_BYTES + 1 : 4, mtimeMs: mode === 'grow' && stats++ ? 2 : 1 }),
          read: async (buffer, offset, length, position) => {
            operations.push(['read', buffer.length, length, position]);
            if (mode === 'shrink') return { bytesRead: 0 };
            if (position === 4) return { bytesRead: mode === 'grow' ? 1 : 0 };
            Buffer.from('test').copy(buffer, offset); return { bytesRead: length };
          },
          close: async () => operations.push(['close'])
        };
      }
    };
    const promise = readBoundedFile('unused', fileSystem);
    if (mode === 'valid') assert.deepEqual(await promise, Buffer.from('test'));
    else await assert.rejects(promise, mode === 'large' ? /40 MiB/ : /正在变化/);
    assert.deepEqual(operations[0], ['open', 'r']);
    assert.deepEqual(operations.at(-1), ['close']);
    if (mode === 'large') assert.equal(operations.some(entry => entry[0] === 'read'), false);
    else assert.ok(operations.filter(entry => entry[0] === 'read').every(entry => entry[1] <= 4));
  }
});
