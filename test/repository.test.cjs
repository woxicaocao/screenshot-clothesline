'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { PhotoRepository } = require('../src/lib/repository.cjs');

function image(name, capturedAt = '2026-10-13T01:00:00.000Z') {
  return {
    hash: createHash('sha256').update(name).digest('hex'), width: 800, height: 600,
    png: Buffer.from(`png:${name}`), thumbnail: Buffer.from(`thumb:${name}`), capturedAt,
  };
}

async function temporaryRepository() {
  // 遵守“不自动删除文件”的约定：临时测试目录保留在系统临时目录。
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'screenshot-clothesline-test-'));
  const repository = new PhotoRepository(directory);
  await repository.init();
  return { directory, repository };
}

test('真实目录保存原图、缩略图、索引和设置，重启恢复并按时间排序', async () => {
  const { directory, repository } = await temporaryRepository();
  assert.deepEqual(repository.getPhotos(), []);
  assert.deepEqual(repository.getSettings(), { paused: false, alwaysOnTop: false, autoHide: false, autoHideSpeed: 'medium', bounds: null });
  const first = image('first');
  const second = image('second', '2026-10-13T01:00:01.000Z');
  const [one, two] = await Promise.all([repository.savePhoto(first), repository.savePhoto(second)]);
  assert.equal(one.added, true);
  assert.equal(two.added, true);
  assert.deepEqual(await fs.readFile(path.join(directory, 'photos', one.photo.fileName)), first.png);
  assert.deepEqual(await fs.readFile(path.join(directory, 'thumbnails', two.photo.thumbnailName)), second.thumbnail);
  await Promise.all([
    repository.updateSettings({ paused: true }),
    repository.updateSettings({ alwaysOnTop: true, bounds: { x: -80, y: 12, width: 900, height: 260 } }),
  ]);
  const restored = new PhotoRepository(directory);
  await restored.init();
  assert.deepEqual(restored.getPhotos().map((photo) => photo.hash), [second.hash, first.hash]);
  assert.deepEqual(restored.getSettings(), { paused: true, alwaysOnTop: true, autoHide: false, autoHideSpeed: 'medium', bounds: { x: -80, y: 12, width: 900, height: 260 } });
  const duplicate = await restored.savePhoto(second);
  assert.equal(duplicate.added, false);
  assert.equal(restored.getPhotos().length, 2);
});

test('并发相同图片只新增一次，返回数据不会泄露内部可变引用', async () => {
  const { repository } = await temporaryRepository();
  const input = image('same');
  const results = await Promise.all([repository.savePhoto(input), repository.savePhoto(input)]);
  assert.deepEqual(results.map((result) => result.added), [true, false]);
  const photos = repository.getPhotos();
  photos[0].width = 1;
  assert.equal(repository.getPhotos()[0].width, 800);
  const settings = repository.getSettings();
  settings.paused = true;
  assert.equal(repository.getSettings().paused, false);
});

test('按标识查询只返回目标照片的独立副本，校验标识并区分不存在和未初始化', async () => {
  const { directory, repository } = await temporaryRepository();
  const first = await repository.savePhoto(image('single-query-one'));
  const second = await repository.savePhoto(image('single-query-two'));
  const result = repository.getPhoto(first.photo.id);
  assert.deepEqual(result, first.photo);
  result.width = 1;
  result.fileName = 'foreign.png';
  assert.deepEqual(repository.getPhoto(first.photo.id), first.photo);
  assert.deepEqual(repository.getPhoto(second.photo.id), second.photo);
  assert.equal(repository.getPhoto(image('single-query-missing').hash), null);
  for (const id of [null, undefined, 1, '../foreign.png', 'a'.repeat(63), 'A'.repeat(64)]) {
    assert.throws(() => repository.getPhoto(id), /图片标识无效/);
  }
  const restored = new PhotoRepository(directory);
  assert.throws(() => restored.getPhoto(first.photo.id), /尚未初始化/);
  await restored.init();
  assert.deepEqual(restored.getPhoto(first.photo.id), first.photo);
});

test('旧设置缺少自动隐藏字段时默认关闭，保留照片索引、图片及已有设置', async () => {
  const { directory, repository } = await temporaryRepository();
  const input = image('existing-photo');
  const { photo } = await repository.savePhoto(input);
  const legacySettings = { paused: true, alwaysOnTop: true, bounds: { x: 20, y: 40, width: 900, height: 260 } };
  const settingsPath = path.join(directory, 'settings.json');
  await fs.writeFile(settingsPath, `${JSON.stringify(legacySettings)}\n`, 'utf8');
  const originalIndex = await fs.readFile(path.join(directory, 'index.json'));
  const restored = new PhotoRepository(directory);
  await restored.init();
  assert.deepEqual(restored.getSettings(), { ...legacySettings, autoHide: false, autoHideSpeed: 'medium' });
  assert.deepEqual(restored.getPhotos(), [photo]);
  assert.deepEqual(await fs.readFile(path.join(directory, 'index.json')), originalIndex);
  assert.deepEqual(await fs.readFile(path.join(directory, 'photos', photo.fileName)), input.png);
  assert.deepEqual(await fs.readFile(path.join(directory, 'thumbnails', photo.thumbnailName)), input.thumbnail);
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), legacySettings);
});

test('自动隐藏开关保存后重启恢复，其他设置更新不覆盖开关', async () => {
  const { directory, repository } = await temporaryRepository();
  await repository.updateSettings({ autoHide: true });
  await repository.updateSettings({ paused: true });
  const restored = new PhotoRepository(directory);
  await restored.init();
  assert.equal(restored.getSettings().autoHide, true);
  assert.equal(restored.getSettings().paused, true);
  await restored.updateSettings({ autoHide: false });
  const restoredAgain = new PhotoRepository(directory);
  await restoredAgain.init();
  assert.equal(restoredAgain.getSettings().autoHide, false);
  assert.equal(restoredAgain.getSettings().paused, true);
});

test('非布尔自动隐藏设置被拒绝且保留已保存状态', async () => {
  const { directory, repository } = await temporaryRepository();
  await repository.updateSettings({ autoHide: true });
  const originalSettings = await fs.readFile(path.join(directory, 'settings.json'));
  for (const value of ['true', 1, null, undefined, {}, []]) {
    await assert.rejects(repository.updateSettings({ autoHide: value }), /autoHide 必须是布尔值/);
    assert.equal(repository.getSettings().autoHide, true);
    assert.deepEqual(await fs.readFile(path.join(directory, 'settings.json')), originalSettings);
  }
});

test('索引原子发布失败保留旧索引和图片，后续重试复用图片并成功发布', async (t) => {
  const { directory, repository } = await temporaryRepository();
  const first = image('before-failure');
  const second = image('retry-after-failure', '2026-10-13T01:00:01.000Z');
  await repository.savePhoto(first);
  const indexPath = path.join(directory, 'index.json');
  const previousIndex = await fs.readFile(indexPath);
  const originalRename = fs.rename;
  const mockedRename = t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === indexPath) throw Object.assign(new Error('模拟 Windows 文件被占用'), { code: 'EACCES' });
    return originalRename(source, destination);
  });
  await assert.rejects(repository.savePhoto(second), /模拟 Windows 文件被占用/);
  mockedRename.mock.restore();
  assert.deepEqual(await fs.readFile(indexPath), previousIndex);
  assert.equal(repository.getPhotos().length, 1);
  const photoPath = path.join(directory, 'photos', `${second.hash}.png`);
  const originalImage = await fs.readFile(photoPath);
  const imageTimestamp = (await fs.stat(photoPath)).mtimeMs;
  assert.ok((await fs.readdir(directory)).some((name) => name.startsWith('index.json.pending-')));
  const recovered = await repository.savePhoto(second);
  assert.equal(recovered.added, true);
  assert.deepEqual(await fs.readFile(photoPath), originalImage);
  assert.equal((await fs.stat(photoPath)).mtimeMs, imageTimestamp);
  const restored = new PhotoRepository(directory);
  await restored.init();
  assert.equal(restored.getPhotos().length, 2);
});

test('设置写入失败保留旧设置，不污染内存状态，串行队列仍可重试', async (t) => {
  const { directory, repository } = await temporaryRepository();
  await repository.updateSettings({ paused: true });
  const settingsPath = path.join(directory, 'settings.json');
  const previousSettings = await fs.readFile(settingsPath);
  const originalRename = fs.rename;
  const mockedRename = t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === settingsPath) throw new Error('模拟设置保存失败');
    return originalRename(source, destination);
  });
  await assert.rejects(repository.updateSettings({ paused: false }), /模拟设置保存失败/);
  mockedRename.mock.restore();
  assert.deepEqual(await fs.readFile(settingsPath), previousSettings);
  assert.equal(repository.getSettings().paused, true);
  await repository.updateSettings({ paused: false });
  assert.equal(repository.getSettings().paused, false);
});

test('损坏索引明确报错并完整保留原始文件', async () => {
  const { directory } = await temporaryRepository();
  const contents = '{ invalid JSON';
  const indexPath = path.join(directory, 'index.json');
  await fs.writeFile(indexPath, contents, 'utf8');
  await assert.rejects(new PhotoRepository(directory).init(), /无法读取 index.json/);
  assert.equal(await fs.readFile(indexPath, 'utf8'), contents);
});

test('路径穿越哈希、空图片及无效设置被拒绝', async () => {
  const { repository } = await temporaryRepository();
  await assert.rejects(repository.savePhoto({ ...image('invalid'), hash: '../outside' }), /图片数据无效/);
  await assert.rejects(repository.savePhoto({ ...image('empty'), png: Buffer.alloc(0) }), /图片数据无效/);
  await assert.rejects(repository.updateSettings({ paused: 'true' }), /布尔值/);
  await assert.rejects(repository.updateSettings({ bounds: { x: 0, y: 0, width: -1, height: 260 } }), /位置和尺寸无效/);
  assert.equal(repository.getPhotos().length, 0);
});

test('自动隐藏快中慢保存后恢复，旧设置默认中速，更新其它设置保留速度', async () => {
  const { directory, repository } = await temporaryRepository();
  assert.equal(repository.getSettings().autoHideSpeed, 'medium');
  for (const speed of ['fast', 'medium', 'slow']) {
    await repository.updateSettings({ autoHide: true, autoHideSpeed: speed });
    await repository.updateSettings({ paused: true });
    const restored = new PhotoRepository(directory);
    await restored.init();
    assert.equal(restored.getSettings().autoHideSpeed, speed);
    assert.equal(restored.getSettings().autoHide, true);
    assert.equal(restored.getSettings().paused, true);
  }
  const previous = await fs.readFile(path.join(directory, 'settings.json'));
  for (const speed of ['instant', '', 0, null, undefined]) {
    await assert.rejects(repository.updateSettings({ autoHideSpeed: speed }), /fast、medium 或 slow/);
    assert.deepEqual(await fs.readFile(path.join(directory, 'settings.json')), previous);
  }
});

test('拖出缓存使用原图PNG并复用同一绝对路径，未知及越界标识拒绝', async () => {
  const { directory, repository } = await temporaryRepository();
  const input = image('export-original');
  await repository.savePhoto(input);
  const exportPath = await repository.prepareExport(input.hash);
  assert.equal(exportPath, path.join(directory, 'exports', `${input.hash}.png`));
  assert.equal(path.isAbsolute(exportPath), true);
  assert.deepEqual(await fs.readFile(exportPath), input.png);
  const timestamp = (await fs.stat(exportPath)).mtimeMs;
  assert.equal(await repository.prepareExport(input.hash), exportPath);
  assert.equal((await fs.stat(exportPath)).mtimeMs, timestamp);
  await assert.rejects(repository.prepareExport('../outside'), /标识无效/);
  await assert.rejects(repository.prepareExport(image('unknown').hash), /不存在/);
  await assert.rejects(repository._cachePath('photos', '../outside.png'), /路径超出/);
});

test('删除仅清除选中图片原图、缩图、导出及同哈希pending，保留其它照片和索引设置', async () => {
  const { directory, repository } = await temporaryRepository();
  const selected = image('delete-selected');
  const other = image('keep-other');
  await repository.savePhoto(selected);
  await repository.savePhoto(other);
  await repository.prepareExport(selected.hash);
  await repository.prepareExport(other.hash);
  await repository.updateSettings({ autoHideSpeed: 'slow' });
  for (const name of ['photos', 'thumbnails', 'exports']) {
    await fs.writeFile(path.join(directory, name, `${selected.hash}.png.pending-example`), 'selected pending');
    await fs.writeFile(path.join(directory, name, `${selected.hash}0.png.pending-example`), 'unselected pending');
  }
  assert.deepEqual(await repository.deletePhoto(selected.hash), { deleted: true, cleanupPending: false });
  assert.deepEqual(repository.getPhotos().map((photo) => photo.hash), [other.hash]);
  for (const name of ['photos', 'thumbnails', 'exports']) {
    await assert.rejects(fs.stat(path.join(directory, name, `${selected.hash}.png`)), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(directory, name, `${selected.hash}.png.pending-example`)), { code: 'ENOENT' });
    assert.ok((await fs.stat(path.join(directory, name, `${other.hash}.png`))).isFile());
    assert.equal(await fs.readFile(path.join(directory, name, `${selected.hash}0.png.pending-example`), 'utf8'), 'unselected pending');
  }
  assert.ok((await fs.stat(path.join(directory, 'index.json'))).isFile());
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8')).autoHideSpeed, 'slow');
  const restored = new PhotoRepository(directory);
  await restored.init();
  assert.deepEqual(restored.getPhotos().map((photo) => photo.hash), [other.hash]);
  assert.deepEqual(await restored.deletePhoto(selected.hash), { deleted: false, cleanupPending: false });
  await assert.rejects(restored.deletePhoto('../outside'), /标识无效/);
});

test('删除索引发布失败时不删除任何图片文件或改变可见照片', async (t) => {
  const { directory, repository } = await temporaryRepository();
  const selected = image('delete-journal-failure');
  await repository.savePhoto(selected);
  await repository.prepareExport(selected.hash);
  const indexPath = path.join(directory, 'index.json');
  const previous = await fs.readFile(indexPath);
  const originalRename = fs.rename;
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === indexPath) throw Object.assign(new Error('删除日志发布失败'), { code: 'EACCES' });
    return originalRename(source, destination);
  });
  await assert.rejects(repository.deletePhoto(selected.hash), /删除日志发布失败/);
  assert.deepEqual(await fs.readFile(indexPath), previous);
  assert.equal(repository.getPhotos()[0].hash, selected.hash);
  for (const name of ['photos', 'thumbnails', 'exports']) {
    assert.ok((await fs.stat(path.join(directory, name, `${selected.hash}.png`))).isFile());
  }
});

test('缓存被占用时持久记录删除任务，不阻止其它删除及保存，重启不复活并重试清理', async (t) => {
  const { directory, repository } = await temporaryRepository();
  const selected = image('busy-delete');
  const other = image('another-delete');
  const later = image('save-during-pending-delete');
  await repository.savePhoto(selected);
  await repository.savePhoto(other);
  await repository.prepareExport(selected.hash);
  const blockedPath = path.join(directory, 'photos', `${selected.hash}.png`);
  const originalUnlink = fs.unlink;
  const mockedUnlink = t.mock.method(fs, 'unlink', async (target) => {
    if (target === blockedPath) throw Object.assign(new Error('文件正在发送'), { code: 'EBUSY' });
    return originalUnlink(target);
  });
  assert.deepEqual(await repository.deletePhoto(selected.hash), { deleted: true, cleanupPending: true });
  assert.deepEqual(await repository.deletePhoto(other.hash), { deleted: true, cleanupPending: false });
  await repository.savePhoto(later);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'index.json'), 'utf8')).pendingDeletes, [selected.hash]);
  await assert.rejects(repository.savePhoto(selected), /缓存正在清理/);
  const restoredWhileBusy = new PhotoRepository(directory);
  await restoredWhileBusy.init();
  assert.deepEqual(restoredWhileBusy.getPhotos().map((photo) => photo.hash), [later.hash]);
  assert.deepEqual(await restoredWhileBusy.retryPendingDeletes(), { remaining: 1 });
  mockedUnlink.mock.restore();
  const restored = new PhotoRepository(directory);
  await restored.init();
  await assert.rejects(fs.stat(blockedPath), { code: 'ENOENT' });
  assert.deepEqual(await restored.retryPendingDeletes(), { remaining: 0 });
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'index.json'), 'utf8')).pendingDeletes, undefined);
  assert.equal((await restored.savePhoto(selected)).added, true);
});

test('清理完成后日志更新失败仍保存任务，下次安全重试清除日志', async (t) => {
  const { directory, repository } = await temporaryRepository();
  const selected = image('journal-finalize-failure');
  await repository.savePhoto(selected);
  const indexPath = path.join(directory, 'index.json');
  const originalRename = fs.rename;
  let commits = 0;
  const mockedRename = t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === indexPath && ++commits === 2) throw new Error('日志完成状态保存失败');
    return originalRename(source, destination);
  });
  assert.deepEqual(await repository.deletePhoto(selected.hash), { deleted: true, cleanupPending: true });
  await assert.rejects(fs.stat(path.join(directory, 'photos', `${selected.hash}.png`)), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await fs.readFile(indexPath, 'utf8')).pendingDeletes, [selected.hash]);
  mockedRename.mock.restore();
  assert.deepEqual(await repository.retryPendingDeletes(), { remaining: 0 });
});

test('缓存目录junction越界时拒绝导出和文件清理，外部文件完整保留', async () => {
  const { directory, repository } = await temporaryRepository();
  const selected = image('junction-escape');
  await repository.savePhoto(selected);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'screenshot-clothesline-outside-'));
  const outsideFile = path.join(outside, `${selected.hash}.png`);
  await fs.writeFile(outsideFile, 'outside sentinel');
  // 仅移动测试目录内的缓存目录，保留所有文件，不做递归删除。
  const cache = path.join(directory, 'photos');
  await fs.rename(cache, path.join(directory, 'photos-preserved'));
  await fs.symlink(outside, cache, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(repository.prepareExport(selected.hash), /目录超出/);
  assert.deepEqual(await repository.deletePhoto(selected.hash), { deleted: true, cleanupPending: true });
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'outside sentinel');
  assert.deepEqual(await fs.readFile(path.join(directory, 'photos-preserved', `${selected.hash}.png`)), selected.png);
  assert.deepEqual(await repository.retryPendingDeletes(), { remaining: 1 });
});

test('同哈希名的目录绝不递归删除，异常删除日志格式在初始化时拒绝', async () => {
  const { directory, repository } = await temporaryRepository();
  const selected = image('pending-directory-preserved');
  await repository.savePhoto(selected);
  const suspicious = path.join(directory, 'exports', `${selected.hash}.png.pending-directory`);
  await fs.mkdir(suspicious);
  await fs.writeFile(path.join(suspicious, 'keep.txt'), 'keep nested data');
  assert.deepEqual(await repository.deletePhoto(selected.hash), { deleted: true, cleanupPending: true });
  assert.equal(await fs.readFile(path.join(suspicious, 'keep.txt'), 'utf8'), 'keep nested data');
  await fs.writeFile(path.join(directory, 'index.json'), JSON.stringify({ version: 1, photos: [], pendingDeletes: ['../outside'] }));
  await assert.rejects(new PhotoRepository(directory).init(), /索引格式无效/);
  assert.equal(await fs.readFile(path.join(suspicious, 'keep.txt'), 'utf8'), 'keep nested data');
});

test('原始JPEG和WebP保存、重启和导出保持扩展及字节，旧PNG仍完全兼容', async () => {
  const { directory, repository } = await temporaryRepository();
  const legacy = image('legacy-plain-png');
  await repository.savePhoto(legacy);
  const expected = [];
  for (const extension of ['jpg', 'webp', 'png']) {
    const input = { ...image(`original-format-${extension}`), originalBytes: Buffer.from(`source:${extension}`), originalExtension: extension };
    const original = Buffer.from(input.originalBytes);
    const saving = repository.savePhoto(input);
    input.originalBytes.fill(0);
    const { photo, added } = await saving;
    assert.equal(added, true);
    assert.equal(photo.fileName, `${input.hash}.${extension}`);
    assert.equal(photo.thumbnailName, `${input.hash}.png`);
    assert.deepEqual(await fs.readFile(path.join(directory, 'photos', photo.fileName)), original);
    const exported = await repository.prepareExport(photo.id);
    assert.equal(exported, path.join(directory, 'exports', photo.fileName));
    assert.deepEqual(await fs.readFile(exported), original);
    expected.push({ photo, original });
  }
  const restored = new PhotoRepository(directory);
  await restored.init();
  assert.equal(restored.getPhotos().length, 4);
  for (const { photo, original } of expected) {
    assert.equal(restored.getPhotos().find((entry) => entry.id === photo.id).fileName, photo.fileName);
    assert.deepEqual(await fs.readFile(await restored.prepareExport(photo.id)), original);
  }
  assert.deepEqual(await fs.readFile(await restored.prepareExport(legacy.hash)), legacy.png);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'index.json'), 'utf8')).version, 1);
});

test('原始图片扩展及原始字节校验拒绝越界，不允许索引存储来源URL等额外字段', async () => {
  const { repository } = await temporaryRepository();
  for (const extra of [
    { originalExtension: '../jpg' }, { originalExtension: 'jpeg' },
    { originalExtension: 'webp', originalBytes: Buffer.alloc(0) },
    { originalBytes: Buffer.from('data') }
  ]) await assert.rejects(repository.savePhoto({ ...image('invalid-original'), ...extra }), /图片数据无效/);
  const { photo } = await repository.savePhoto({
    ...image('no-sensitive-fields'), originalExtension: 'jpg', originalBytes: Buffer.from('source bytes'),
    sourceURL: 'https://example.test/private', cookies: 'private cookie'
  });
  assert.equal(photo.sourceURL, undefined);
  assert.equal(photo.cookies, undefined);
  assert.equal(repository.getPhotos()[0].sourceURL, undefined);
});

test('旧缩略图按需新增compact缓存并复用，原缩略图和原图完整保留', async () => {
  const { directory, repository } = await temporaryRepository();
  const selected = image('compact-old-thumbnail');
  await repository.savePhoto(selected);
  let conversions = 0;
  const converter = async (buffer) => {
    conversions++;
    assert.deepEqual(buffer, selected.thumbnail);
    return { changed: true, buffer: Buffer.from('smaller thumbnail') };
  };
  const [one, two] = await Promise.all([
    repository.ensureCompactThumbnail(selected.hash, converter),
    repository.ensureCompactThumbnail(selected.hash, converter)
  ]);
  assert.equal(one, path.join(directory, 'thumbnails', `${selected.hash}.compact.png`));
  assert.equal(two, one);
  assert.equal(conversions, 1);
  assert.deepEqual(await fs.readFile(one), Buffer.from('smaller thumbnail'));
  assert.deepEqual(await fs.readFile(path.join(directory, 'thumbnails', `${selected.hash}.png`)), selected.thumbnail);
  assert.deepEqual(await fs.readFile(path.join(directory, 'photos', `${selected.hash}.png`)), selected.png);
  const restored = new PhotoRepository(directory);
  await restored.init();
  assert.equal(await restored.ensureCompactThumbnail(selected.hash, () => { throw new Error('缓存不应重编码'); }), one);
});

test('已紧凑的缩略图复用旧文件；无效转换拒绝且保留旧缩略图', async () => {
  const { directory, repository } = await temporaryRepository();
  const selected = image('compact-unchanged');
  await repository.savePhoto(selected);
  const oldPath = path.join(directory, 'thumbnails', `${selected.hash}.png`);
  assert.equal(await repository.ensureCompactThumbnail(selected.hash, (buffer) => ({ changed: false, buffer })), oldPath);
  await assert.rejects(fs.stat(path.join(directory, 'thumbnails', `${selected.hash}.compact.png`)), { code: 'ENOENT' });
  for (const converted of [null, { changed: true }, { changed: 1, buffer: Buffer.from('invalid') }, { changed: true, buffer: Buffer.alloc(0) }]) {
    await assert.rejects(repository.ensureCompactThumbnail(selected.hash, () => converted), /转换结果无效/);
  }
  assert.deepEqual(await fs.readFile(oldPath), selected.thumbnail);
  await assert.rejects(repository.ensureCompactThumbnail('../outside', () => null), /标识无效/);
  await assert.rejects(repository.ensureCompactThumbnail(selected.hash, null), /必须是函数/);
});

test('删除清理同哈希PNG/JPEG/WebP及compact缓存和pending，未知后缀与其它hash保留', async () => {
  const { directory, repository } = await temporaryRepository();
  const selected = image('delete-mixed-formats');
  const other = image('keep-mixed-formats');
  await repository.savePhoto({ ...selected, originalBytes: Buffer.from('jpeg source'), originalExtension: 'jpg' });
  await repository.savePhoto(other);
  await repository.ensureCompactThumbnail(selected.hash, () => ({ changed: true, buffer: Buffer.from('compact') }));
  for (const folder of ['photos', 'exports']) {
    for (const extension of ['png', 'jpg', 'webp']) {
      await fs.writeFile(path.join(directory, folder, `${selected.hash}.${extension}`), `selected ${extension}`);
      await fs.writeFile(path.join(directory, folder, `${selected.hash}.${extension}.pending-orphan`), 'selected pending');
    }
    await fs.writeFile(path.join(directory, folder, `${selected.hash}.txt`), 'unrelated suffix');
    await fs.writeFile(path.join(directory, folder, `${selected.hash}0.jpg`), 'unrelated hash');
  }
  await fs.writeFile(path.join(directory, 'thumbnails', `${selected.hash}.compact.png.pending-orphan`), 'compact pending');
  assert.deepEqual(await repository.deletePhoto(selected.hash), { deleted: true, cleanupPending: false });
  for (const folder of ['photos', 'exports']) {
    for (const extension of ['png', 'jpg', 'webp']) {
      await assert.rejects(fs.stat(path.join(directory, folder, `${selected.hash}.${extension}`)), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(directory, folder, `${selected.hash}.${extension}.pending-orphan`)), { code: 'ENOENT' });
    }
    assert.equal(await fs.readFile(path.join(directory, folder, `${selected.hash}.txt`), 'utf8'), 'unrelated suffix');
    assert.equal(await fs.readFile(path.join(directory, folder, `${selected.hash}0.jpg`), 'utf8'), 'unrelated hash');
  }
  for (const name of [`${selected.hash}.png`, `${selected.hash}.compact.png`, `${selected.hash}.compact.png.pending-orphan`]) {
    await assert.rejects(fs.stat(path.join(directory, 'thumbnails', name)), { code: 'ENOENT' });
  }
  assert.deepEqual(repository.getPhotos().map((photo) => photo.hash), [other.hash]);
});

test('缩略图生成与删除串行，删除后绝不新建compact缓存', async () => {
  const { directory, repository } = await temporaryRepository();
  const selected = image('delete-while-converting');
  await repository.savePhoto(selected);
  let enterConverter;
  const entered = new Promise((resolve) => { enterConverter = resolve; });
  let finishConverter;
  const waiting = new Promise((resolve) => { finishConverter = resolve; });
  const creating = repository.ensureCompactThumbnail(selected.hash, () => { enterConverter(); return waiting; });
  await entered;
  const deleting = repository.deletePhoto(selected.hash);
  finishConverter({ changed: true, buffer: Buffer.from('compact') });
  await creating;
  assert.deepEqual(await deleting, { deleted: true, cleanupPending: false });
  await assert.rejects(repository.ensureCompactThumbnail(selected.hash, () => ({ changed: true, buffer: Buffer.from('must not write') })), /已删除或不存在/);
  await assert.rejects(fs.stat(path.join(directory, 'thumbnails', `${selected.hash}.compact.png`)), { code: 'ENOENT' });
});

test('compact生成拒绝缩略图目录junction，越界缓存不读取、不写入、不删除', async () => {
  const { directory, repository } = await temporaryRepository();
  const selected = image('compact-junction-escape');
  await repository.savePhoto(selected);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'screenshot-clothesline-compact-outside-'));
  await fs.writeFile(path.join(outside, `${selected.hash}.png`), 'outside thumbnail');
  const sourceDirectory = path.join(directory, 'thumbnails');
  await fs.rename(sourceDirectory, path.join(directory, 'thumbnails-preserved'));
  await fs.symlink(outside, sourceDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  let called = false;
  await assert.rejects(repository.ensureCompactThumbnail(selected.hash, () => { called = true; return { changed: true, buffer: Buffer.from('compact') }; }), /目录超出/);
  assert.equal(called, false);
  assert.equal(await fs.readFile(path.join(outside, `${selected.hash}.png`), 'utf8'), 'outside thumbnail');
  await assert.rejects(fs.stat(path.join(outside, `${selected.hash}.compact.png`)), { code: 'ENOENT' });
  assert.deepEqual(await repository.deletePhoto(selected.hash), { deleted: true, cleanupPending: true });
  assert.equal(await fs.readFile(path.join(outside, `${selected.hash}.png`), 'utf8'), 'outside thumbnail');
});
