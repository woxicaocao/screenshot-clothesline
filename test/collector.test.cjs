'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { ClipboardCollector } = require('../src/lib/collector.cjs');

function image(name) {
  return {
    hash: createHash('sha256').update(name).digest('hex'),
    width: 640, height: 480, png: Buffer.from(`png:${name}`), thumbnail: Buffer.from(`thumb:${name}`),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createRepository(photos = []) {
  return {
    photos: [...photos], calls: [],
    getPhotos() { return this.photos; },
    async savePhoto(input) {
      this.calls.push(input.hash);
      const existing = this.photos.find((photo) => photo.hash === input.hash);
      if (existing) return { photo: existing, added: false };
      const photo = { id: input.hash, hash: input.hash };
      this.photos.unshift(photo);
      return { photo, added: true };
    },
  };
}

function createCollector(t, options) {
  const collector = new ClipboardCollector({ intervalMs: 600_000, ...options });
  t.after(() => collector.stop());
  return collector;
}

test('启动跳过当前截图；新图入库；文字及无效图片被忽略', async (t) => {
  let current = image('startup');
  const repository = createRepository();
  const notified = [];
  const collector = createCollector(t, { readImage: async () => current, repository, onPhoto: (photo) => notified.push(photo) });
  await collector.start();
  await collector.pollOnce();
  assert.equal(repository.calls.length, 0);
  current = null;
  await collector.pollOnce();
  current = { ...image('invalid'), width: 0 };
  await collector.pollOnce();
  assert.equal(repository.calls.length, 0);
  current = image('new');
  await collector.pollOnce();
  assert.deepEqual(repository.calls, [current.hash]);
  assert.equal(notified.length, 1);
});

test('重复图片、已持久化的旧图片均不会再次调用保存', async (t) => {
  const saved = image('already-saved');
  let current = null;
  const repository = createRepository([{ id: saved.hash, hash: saved.hash }]);
  const collector = createCollector(t, { readImage: async () => current, repository });
  await collector.start();
  current = image('new');
  await collector.pollOnce();
  await collector.pollOnce();
  current = null;
  await collector.pollOnce();
  current = image('new');
  await collector.pollOnce();
  current = saved;
  await collector.pollOnce();
  assert.equal(repository.calls.length, 1);
});

test('暂停立即丢弃正在读取的图，恢复跳过暂停期间的剪贴板图片', async (t) => {
  let current = null;
  let pendingRead = null;
  const repository = createRepository();
  const collector = createCollector(t, {
    readImage: async () => pendingRead ? pendingRead.promise : current,
    repository,
  });
  await collector.start();
  pendingRead = deferred();
  const polling = collector.pollOnce();
  await new Promise(setImmediate);
  await collector.setPaused(true);
  pendingRead.resolve(image('reading-when-paused'));
  await polling;
  assert.equal(repository.calls.length, 0);
  pendingRead = null;
  current = image('during-pause');
  await collector.pollOnce();
  assert.equal(repository.calls.length, 0);
  await collector.setPaused(false);
  await collector.pollOnce();
  assert.equal(repository.calls.length, 0);
  current = image('after-resume');
  await collector.pollOnce();
  assert.deepEqual(repository.calls, [current.hash]);
});

test('启动为暂停状态时不采集，恢复会重新取得基线', async (t) => {
  let current = image('startup');
  let reads = 0;
  const repository = createRepository();
  const collector = createCollector(t, { readImage: async () => { reads++; return current; }, repository });
  await collector.start({ paused: true });
  current = image('paused');
  await collector.pollOnce();
  assert.equal(reads, 1);
  await collector.setPaused(false);
  await collector.pollOnce();
  assert.equal(repository.calls.length, 0);
  current = image('resumed');
  await collector.pollOnce();
  assert.equal(repository.calls.length, 1);
});

test('长时间读取时并发轮询不重入，恢复基线也与读取串行', async (t) => {
  let pendingRead = null;
  let activeReads = 0;
  let maxReads = 0;
  let reads = 0;
  const repository = createRepository();
  const collector = createCollector(t, {
    readImage: async () => {
      reads++;
      maxReads = Math.max(maxReads, ++activeReads);
      try { return pendingRead ? await pendingRead.promise : null; }
      finally { activeReads--; }
    },
    repository,
  });
  await collector.start();
  pendingRead = deferred();
  const polling = collector.pollOnce();
  await new Promise(setImmediate);
  await Promise.all([collector.pollOnce(), collector.pollOnce(), collector.pollOnce()]);
  assert.equal(reads, 2);
  await collector.setPaused(true);
  const resuming = collector.setPaused(false);
  await new Promise(setImmediate);
  assert.equal(reads, 2);
  const waiting = pendingRead;
  pendingRead = null;
  waiting.resolve(image('old-read'));
  await Promise.all([polling, resuming]);
  assert.equal(reads, 3);
  assert.equal(maxReads, 1);
  assert.equal(repository.calls.length, 0);
});

test('保存失败不标记已保存，同一剪贴板图片下一轮重试', async (t) => {
  let current = null;
  const repository = createRepository();
  const originalSave = repository.savePhoto;
  let attempts = 0;
  repository.savePhoto = async function savePhoto(input) {
    if (++attempts === 1) throw new Error('模拟磁盘写入失败');
    return originalSave.call(this, input);
  };
  const errors = [];
  const notified = [];
  const collector = createCollector(t, { readImage: async () => current, repository, onError: (error) => errors.push(error), onPhoto: (photo) => notified.push(photo) });
  await collector.start();
  current = image('retry');
  await collector.pollOnce();
  assert.equal(errors.length, 1);
  assert.equal(notified.length, 0);
  await collector.pollOnce();
  await collector.pollOnce();
  assert.equal(attempts, 2);
  assert.equal(notified.length, 1);
});

test('A 保存失败后剪贴板变为 B，先重试 A 再采集 B，通知各一次', async (t) => {
  let current = null;
  const repository = createRepository();
  const originalSave = repository.savePhoto;
  const attempts = [];
  let failure = true;
  repository.savePhoto = async function savePhoto(input) {
    attempts.push(input.hash);
    if (failure) throw new Error('磁盘暂不可写');
    return originalSave.call(this, input);
  };
  const notified = [];
  const collector = createCollector(t, { readImage: async () => current, repository, onPhoto: (photo) => notified.push(photo.hash) });
  await collector.start();
  const first = image('pending-A');
  const second = image('clipboard-B');
  current = first;
  await collector.pollOnce();
  assert.equal(notified.length, 0);
  current = second;
  failure = false;
  await collector.pollOnce();
  await collector.pollOnce();
  current = first;
  await collector.pollOnce();
  assert.deepEqual(attempts, [first.hash, first.hash, second.hash]);
  assert.deepEqual(notified, [first.hash, second.hash]);
});

test('A 保存失败后剪贴板变为文字，仍重试保存独立副本的 A', async (t) => {
  let current = null;
  const repository = createRepository();
  const originalSave = repository.savePhoto;
  let failure = true;
  let savedPng;
  let savedThumbnail;
  repository.savePhoto = async function savePhoto(input) {
    if (failure) throw new Error('磁盘暂不可写');
    savedPng = Buffer.from(input.png);
    savedThumbnail = Buffer.from(input.thumbnail);
    return originalSave.call(this, input);
  };
  const notified = [];
  const collector = createCollector(t, { readImage: async () => current, repository, onPhoto: (photo) => notified.push(photo.hash) });
  await collector.start();
  const first = image('pending-before-text');
  const expectedPng = Buffer.from(first.png);
  const expectedThumbnail = Buffer.from(first.thumbnail);
  current = first;
  await collector.pollOnce();
  first.png.fill(0);
  first.thumbnail.fill(0);
  current = null;
  failure = false;
  await collector.pollOnce();
  await collector.pollOnce();
  assert.deepEqual(notified, [first.hash]);
  assert.deepEqual(savedPng, expectedPng);
  assert.deepEqual(savedThumbnail, expectedThumbnail);
});

test('暂停保留 pending 并停止重试；恢复保存 pending，仍跳过恢复基线', async (t) => {
  let current = null;
  const repository = createRepository();
  const originalSave = repository.savePhoto;
  const attempts = [];
  let failure = true;
  repository.savePhoto = async function savePhoto(input) {
    attempts.push(input.hash);
    if (failure) throw new Error('磁盘暂不可写');
    return originalSave.call(this, input);
  };
  const notified = [];
  const collector = createCollector(t, { readImage: async () => current, repository, onPhoto: (photo) => notified.push(photo.hash) });
  await collector.start();
  const pending = image('pending-before-pause');
  const baseline = image('pause-baseline');
  const later = image('after-resume-new');
  current = pending;
  await collector.pollOnce();
  await collector.setPaused(true);
  current = baseline;
  failure = false;
  await collector.pollOnce();
  assert.equal(attempts.length, 1);
  await collector.setPaused(false);
  await collector.pollOnce();
  await collector.pollOnce();
  assert.deepEqual(attempts, [pending.hash, pending.hash]);
  assert.deepEqual(notified, [pending.hash]);
  current = later;
  await collector.pollOnce();
  assert.deepEqual(notified, [pending.hash, later.hash]);
});

test('连续保存失败只重试单张 pending，不继续读取或积累后续图片', async (t) => {
  let current = null;
  let reads = 0;
  const attempted = [];
  const repository = createRepository();
  repository.savePhoto = async (input) => { attempted.push(input.hash); throw new Error('持续失败'); };
  const collector = createCollector(t, { readImage: async () => { reads++; return current; }, repository });
  await collector.start();
  const pending = image('one-pending-only');
  current = pending;
  await collector.pollOnce();
  current = image('later-while-failed');
  await collector.pollOnce();
  current = null;
  await collector.pollOnce();
  assert.equal(reads, 2);
  assert.deepEqual(attempted, [pending.hash, pending.hash, pending.hash]);
  collector.stop();
  await collector.start();
  await collector.pollOnce();
  assert.equal(attempted.length, 3);
});

test('基线读取失败后首次成功读取只建立基线，后续新图才保存', async (t) => {
  let reads = 0;
  let current = image('existing');
  const repository = createRepository();
  const errors = [];
  const collector = createCollector(t, {
    readImage: async () => { if (++reads === 1) throw new Error('剪贴板忙'); return current; },
    repository, onError: (error) => errors.push(error),
  });
  await collector.start();
  await collector.pollOnce();
  assert.equal(errors.length, 1);
  assert.equal(repository.calls.length, 0);
  current = image('later');
  await collector.pollOnce();
  assert.equal(repository.calls.length, 1);
});

test('停止立即丢弃尚未完成的读取', async (t) => {
  let pendingRead = null;
  const repository = createRepository();
  const collector = createCollector(t, { readImage: async () => pendingRead ? pendingRead.promise : null, repository });
  await collector.start();
  pendingRead = deferred();
  const polling = collector.pollOnce();
  await new Promise(setImmediate);
  collector.stop();
  pendingRead.resolve(image('stopped'));
  await polling;
  assert.equal(repository.calls.length, 0);
});

test('删除后保持当前剪贴板基线，经过其它内容后相同截图可以重新收集', async (t) => {
  let current = null;
  const repository = createRepository();
  const notified = [];
  const collector = createCollector(t, { readImage: async () => current, repository, onPhoto: (photo) => notified.push(photo.hash) });
  await collector.start();
  const selected = image('deleted-and-recaptured');
  current = selected;
  await collector.pollOnce();
  repository.photos = [];
  collector.forgetPhoto(selected.hash);
  await collector.pollOnce();
  await collector.pollOnce();
  assert.deepEqual(repository.calls, [selected.hash]);
  current = null;
  await collector.pollOnce();
  current = selected;
  await collector.pollOnce();
  assert.deepEqual(repository.calls, [selected.hash, selected.hash]);
  assert.deepEqual(notified, [selected.hash, selected.hash]);
  assert.throws(() => collector.forgetPhoto('../outside'), /标识无效/);
});

test('删除同哈希待保存截图使其作废，不在下一轮自动恢复', async (t) => {
  let current = null;
  const repository = createRepository();
  let calls = 0;
  let failure = true;
  const originalSave = repository.savePhoto;
  repository.savePhoto = async function savePhoto(input) {
    calls++;
    if (failure) throw new Error('缓存暂不可写');
    return originalSave.call(this, input);
  };
  const collector = createCollector(t, { readImage: async () => current, repository });
  await collector.start();
  current = image('pending-deleted');
  await collector.pollOnce();
  collector.forgetPhoto(current.hash);
  failure = false;
  await collector.pollOnce();
  assert.equal(calls, 1);
  assert.equal(repository.photos.length, 0);
});

test('删除其它截图不丢失待保存图片，也不影响其它已收集图片去重', async (t) => {
  const selected = image('delete-old');
  const retained = image('keep-old');
  let current = null;
  const repository = createRepository([{ id: selected.hash, hash: selected.hash }, { id: retained.hash, hash: retained.hash }]);
  let failure = true;
  const originalSave = repository.savePhoto;
  repository.savePhoto = async function savePhoto(input) {
    if (failure) throw new Error('暂时失败');
    return originalSave.call(this, input);
  };
  const collector = createCollector(t, { readImage: async () => current, repository });
  await collector.start();
  const pending = image('keep-pending');
  current = pending;
  await collector.pollOnce();
  collector.forgetPhoto(selected.hash);
  repository.photos = repository.photos.filter((photo) => photo.hash !== selected.hash);
  failure = false;
  current = retained;
  await collector.pollOnce();
  assert.deepEqual(repository.calls, [pending.hash]);
  assert.equal(repository.photos.length, 2);
});

test('删除正在保存的哈希后，其完成结果不重新通知显示，也不恢复去重标记', async (t) => {
  let current = null;
  let waiting = null;
  const repository = createRepository();
  const originalSave = repository.savePhoto;
  repository.savePhoto = async function savePhoto(input) {
    if (waiting) return waiting.promise;
    return originalSave.call(this, input);
  };
  const notified = [];
  const collector = createCollector(t, { readImage: async () => current, repository, onPhoto: (photo) => notified.push(photo.hash) });
  await collector.start();
  const selected = image('save-in-flight-deleted');
  current = selected;
  waiting = deferred();
  const polling = collector.pollOnce();
  await new Promise(setImmediate);
  collector.forgetPhoto(selected.hash);
  waiting.resolve({ photo: { id: selected.hash, hash: selected.hash }, added: true });
  await polling;
  assert.deepEqual(notified, []);
  waiting = null;
  await collector.pollOnce();
  assert.deepEqual(repository.calls, []);
  current = null;
  await collector.pollOnce();
  current = selected;
  await collector.pollOnce();
  assert.deepEqual(repository.calls, [selected.hash]);
  assert.deepEqual(notified, [selected.hash]);
});

test('删除发生在剪贴板读取途中时，同图读完只建立基线，避免竞态重新入库', async (t) => {
  const selected = image('delete-while-reading');
  const repository = createRepository([{ id: selected.hash, hash: selected.hash }]);
  let current = null;
  let waiting = null;
  const collector = createCollector(t, { readImage: async () => waiting ? waiting.promise : current, repository });
  await collector.start();
  waiting = deferred();
  const polling = collector.pollOnce();
  await new Promise(setImmediate);
  repository.photos = [];
  collector.forgetPhoto(selected.hash);
  waiting.resolve(selected);
  await polling;
  waiting = null;
  current = selected;
  await collector.pollOnce();
  assert.deepEqual(repository.calls, []);
  current = image('different-after-delete');
  await collector.pollOnce();
  current = selected;
  await collector.pollOnce();
  assert.deepEqual(repository.calls, [image('different-after-delete').hash, selected.hash]);
});

function lazyImage(name, loadImage) {
  const full = image(name);
  return { hash: full.hash, width: full.width, height: full.height, loadImage: loadImage ?? (() => full) };
}

test('惰性图片基线、已收集图片和删除保护只读元数据，不调用图片编码', async (t) => {
  let loads = 0;
  const old = image('lazy-old');
  let current = lazyImage('lazy-startup', () => { loads++; return image('lazy-startup'); });
  const repository = createRepository([{ id: old.hash, hash: old.hash }]);
  const collector = createCollector(t, { readImage: async () => current, repository });
  await collector.start();
  await collector.pollOnce();
  current = lazyImage('lazy-old', () => { loads++; return old; });
  await collector.pollOnce();
  collector.forgetPhoto(old.hash);
  await collector.pollOnce();
  assert.equal(loads, 0);
  assert.deepEqual(repository.calls, []);
});

test('惰性编码完成后保存失败仍使用独立pending副本重试，不重复编码', async (t) => {
  let current = null;
  let loads = 0;
  let failure = true;
  const repository = createRepository();
  const originalSave = repository.savePhoto;
  repository.savePhoto = async function savePhoto(input) {
    if (failure) throw new Error('写盘失败');
    return originalSave.call(this, input);
  };
  const collector = createCollector(t, { readImage: async () => current, repository });
  await collector.start();
  const full = image('lazy-pending');
  current = lazyImage('lazy-pending', () => { loads++; return full; });
  await collector.pollOnce();
  assert.equal(loads, 1);
  full.png.fill(0);
  current = null;
  let receivedPng;
  repository.savePhoto = async function savePhoto(input) {
    receivedPng = Buffer.from(input.png);
    return originalSave.call(this, input);
  };
  failure = false;
  await collector.pollOnce();
  assert.equal(loads, 1);
  assert.deepEqual(receivedPng, image('lazy-pending').png);
  assert.deepEqual(repository.calls, [full.hash]);
});

test('惰性编码失败或返回不一致数据不推进观察基线，同图下次能重试', async (t) => {
  let current = null;
  const errors = [];
  const repository = createRepository();
  const collector = createCollector(t, { readImage: async () => current, repository, onError: (error) => errors.push(error) });
  await collector.start();
  current = lazyImage('lazy-retry', () => { throw new Error('PNG编码失败'); });
  await collector.pollOnce();
  current = lazyImage('lazy-retry', () => image('inconsistent'));
  await collector.pollOnce();
  current = lazyImage('lazy-retry');
  await collector.pollOnce();
  assert.equal(errors.length, 2);
  assert.deepEqual(repository.calls, [image('lazy-retry').hash]);
});

test('惰性编码await期间暂停或停止会作废结果，恢复基线仍跳过当时图片', async (t) => {
  for (const stop of [false, true]) {
    let current = null;
    const repository = createRepository();
    const collector = createCollector(t, { readImage: async () => current, repository });
    await collector.start();
    const waiting = deferred();
    const full = image(stop ? 'lazy-stop' : 'lazy-pause');
    current = { hash: full.hash, width: full.width, height: full.height, loadImage: () => waiting.promise };
    const polling = collector.pollOnce();
    await new Promise(setImmediate);
    if (stop) collector.stop();
    else await collector.setPaused(true);
    waiting.resolve(full);
    await polling;
    assert.deepEqual(repository.calls, []);
    current = lazyImage(stop ? 'lazy-stop' : 'lazy-pause');
    if (stop) await collector.start();
    else await collector.setPaused(false);
    await collector.pollOnce();
    assert.deepEqual(repository.calls, []);
  }
});

test('惰性编码await期间删除当前哈希会作废结果，其它内容后仍可重新收集', async (t) => {
  let current = null;
  const repository = createRepository();
  const collector = createCollector(t, { readImage: async () => current, repository });
  await collector.start();
  const full = image('lazy-delete');
  const waiting = deferred();
  current = lazyImage('lazy-delete', () => waiting.promise);
  const polling = collector.pollOnce();
  await new Promise(setImmediate);
  collector.forgetPhoto(full.hash);
  waiting.resolve(full);
  await polling;
  current = lazyImage('lazy-delete');
  await collector.pollOnce();
  assert.deepEqual(repository.calls, []);
  current = null;
  await collector.pollOnce();
  current = lazyImage('lazy-delete');
  await collector.pollOnce();
  assert.deepEqual(repository.calls, [full.hash]);
});
