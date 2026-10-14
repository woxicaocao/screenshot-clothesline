'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { ClipboardCollector } = require('../src/lib/collector.cjs');

function image(name) {
  return {
    hash: createHash('sha256').update(name).digest('hex'), width: 640, height: 480,
    png: Buffer.from(`png:${name}`), thumbnail: Buffer.from(`thumbnail:${name}`),
  };
}

function observation(full, loadImage = () => full) {
  return { hash: full.hash, width: full.width, height: full.height, loadImage };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function repository(photos = []) {
  const cache = new Map(photos.map((photo) => [photo.hash, photo]));
  return {
    cache, calls: [],
    getPhotos() { return [...cache.values()]; },
    async savePhoto(full) {
      this.calls.push(full.hash);
      if (cache.has(full.hash)) return { photo: cache.get(full.hash), added: false };
      const photo = { id: full.hash, hash: full.hash, width: full.width, height: full.height };
      cache.set(full.hash, photo);
      return { photo, added: true };
    },
  };
}

function createCollector(t, options) {
  const collector = new ClipboardCollector({ intervalMs: 600_000, ...options });
  t.after(() => collector.stop());
  return collector;
}

test('启动基线仍跳过自动收集；暂停时用户明确手动粘贴可以保存该图', async (t) => {
  const full = image('manual-startup-baseline');
  let loads = 0;
  const current = observation(full, () => { loads++; return full; });
  const store = repository();
  const collector = createCollector(t, { readImage: async () => current, repository: store });
  await collector.start();
  await collector.pollOnce();
  assert.equal(loads, 0);
  assert.deepEqual(store.calls, []);
  await collector.setPaused(true);
  await collector.pollOnce();
  const result = await collector.collectCurrent();
  assert.equal(result.added, true);
  assert.equal(result.photo.hash, full.hash);
  assert.equal(loads, 1);
  await collector.pollOnce();
  assert.deepEqual(store.calls, [full.hash]);
});

test('持久化旧图和刚手动保存的新图重复粘贴时不再编码或调用保存', async (t) => {
  const old = image('manual-persisted');
  const fresh = image('manual-new');
  let loads = 0;
  let current = null;
  const oldPhoto = { id: old.hash, hash: old.hash };
  const store = repository([oldPhoto]);
  const collector = createCollector(t, { readImage: async () => current, repository: store });
  await collector.start({ paused: true });
  current = observation(old, () => { loads++; throw new Error('重复图片不得再次编码'); });
  assert.deepEqual(await collector.collectCurrent(), { added: false, photo: oldPhoto });
  assert.equal(loads, 0);
  current = observation(fresh, () => { loads++; return fresh; });
  assert.equal((await collector.collectCurrent()).added, true);
  assert.equal((await collector.collectCurrent()).added, false);
  assert.equal((await collector.collectCurrent()).added, false);
  assert.equal(loads, 1);
  assert.deepEqual(store.calls, [fresh.hash]);
});

test('文字、空剪贴板及无效图片手动粘贴返回 null，不编码或保存', async (t) => {
  let current = null;
  const store = repository();
  const collector = createCollector(t, { readImage: async () => current, repository: store });
  await collector.start({ paused: true });
  const valid = image('manual-invalid');
  const samples = [
    null, 'https://example.test/image.png', { text: '普通文本' },
    { ...valid, width: 0 }, { ...valid, png: Buffer.alloc(0) },
    { ...valid, hash: '../outside' },
    { hash: valid.hash, width: 640, height: 480, loadImage: null },
  ];
  for (const sample of samples) {
    current = sample;
    assert.equal(await collector.collectCurrent(), null);
  }
  assert.deepEqual(store.calls, []);
  assert.equal(store.cache.size, 0);
});

test('手动保存失败不标记已保存，同图手动或自动重试均能成功且成功后去重', async (t) => {
  for (const retryMode of ['manual', 'automatic']) {
    let current = null;
    let loads = 0;
    let attempts = 0;
    const full = image(`manual-save-retry-${retryMode}`);
    const store = repository();
    const save = store.savePhoto.bind(store);
    store.savePhoto = async (input) => {
      attempts++;
      if (attempts === 1) throw new Error('模拟磁盘暂时不可写');
      return save(input);
    };
    const collector = createCollector(t, { readImage: async () => current, repository: store });
    await collector.start();
    current = observation(full, () => { loads++; return full; });
    await assert.rejects(collector.collectCurrent(), /磁盘暂时不可写/);
    assert.equal(store.cache.size, 0);
    assert.deepEqual(store.calls, []);
    if (retryMode === 'manual') assert.equal((await collector.collectCurrent()).added, true);
    else await collector.pollOnce();
    assert.equal(store.cache.has(full.hash), true);
    assert.equal(attempts, 2);
    assert.equal(loads, 2);
    assert.equal((await collector.collectCurrent()).added, false);
    current = null;
    await collector.pollOnce();
    current = observation(full, () => { throw new Error('已保存图片不应再次编码'); });
    await collector.pollOnce();
    assert.equal(attempts, 2);
    assert.deepEqual(store.calls, [full.hash]);
  }
});

test('手动请求与自动轮询串行，读取和写盘均不重入，排队的重复请求只保存一次', async (t) => {
  const first = image('manual-queue-auto');
  const second = image('manual-queue-paste');
  let current = null;
  let readBarrier = null;
  let saveBarrier = null;
  let active = 0;
  let maxActive = 0;
  let reads = 0;
  const readEntered = deferred();
  const saveEntered = deferred();
  const store = repository();
  const save = store.savePhoto.bind(store);
  store.savePhoto = async (input) => {
    maxActive = Math.max(maxActive, ++active);
    try {
      if (saveBarrier && input.hash === first.hash) {
        saveEntered.resolve();
        await saveBarrier.promise;
      }
      return await save(input);
    } finally { active--; }
  };
  const collector = createCollector(t, {
    readImage: async () => {
      reads++;
      maxActive = Math.max(maxActive, ++active);
      const captured = current;
      try {
        if (readBarrier) {
          readEntered.resolve();
          await readBarrier.promise;
        }
        return captured;
      } finally { active--; }
    },
    repository: store,
  });
  await collector.start();
  current = first;
  readBarrier = deferred();
  saveBarrier = deferred();
  const polling = collector.pollOnce();
  await readEntered.promise;
  current = second;
  const manual = collector.collectCurrent();
  const duplicate = collector.collectCurrent();
  await new Promise(setImmediate);
  assert.equal(reads, 2);
  assert.deepEqual(store.calls, []);
  const waitingRead = readBarrier;
  readBarrier = null;
  waitingRead.resolve();
  await saveEntered.promise;
  assert.equal(reads, 2);
  assert.equal(active, 1);
  saveBarrier.resolve();
  await polling;
  assert.equal((await manual).added, true);
  assert.equal((await duplicate).added, false);
  assert.equal(reads, 4);
  assert.equal(maxActive, 1);
  assert.deepEqual(store.calls, [first.hash, second.hash]);
});

test('惰性编码返回的哈希、尺寸或图片数据不一致时拒绝保存，同图后续仍可重试', async (t) => {
  const full = image('manual-lazy-consistency');
  let current = null;
  const store = repository();
  const collector = createCollector(t, { readImage: async () => current, repository: store });
  await collector.start({ paused: true });
  const inconsistent = [
    image('manual-wrong-hash'), { ...full, width: 641 }, { ...full, height: 481 },
    { ...full, thumbnail: Buffer.alloc(0) },
  ];
  for (const encoded of inconsistent) {
    current = observation(full, async () => encoded);
    await assert.rejects(collector.collectCurrent(), /剪贴板图片无效/);
    assert.equal(store.cache.size, 0);
    assert.deepEqual(store.calls, []);
  }
  current = observation(full);
  assert.equal((await collector.collectCurrent()).added, true);
  assert.deepEqual(store.calls, [full.hash]);
});

test('删除保护不自动恢复当前图片；只有明确手动粘贴才恢复，随后自动收集保持去重', async (t) => {
  const full = image('manual-restore-deleted');
  let current = null;
  let loads = 0;
  const store = repository();
  const collector = createCollector(t, { readImage: async () => current, repository: store });
  await collector.start();
  current = observation(full, () => { loads++; return full; });
  await collector.pollOnce();
  assert.deepEqual(store.calls, [full.hash]);
  store.cache.delete(full.hash);
  collector.forgetPhoto(full.hash);
  await collector.pollOnce();
  await collector.pollOnce();
  assert.equal(loads, 1);
  assert.equal(store.cache.size, 0);
  assert.equal((await collector.collectCurrent()).added, true);
  assert.equal(loads, 2);
  await collector.pollOnce();
  current = null;
  await collector.pollOnce();
  current = observation(full, () => { throw new Error('手动恢复后自动采集不应再编码'); });
  await collector.pollOnce();
  assert.equal((await collector.collectCurrent()).added, false);
  assert.deepEqual(store.calls, [full.hash, full.hash]);
});

test('停止期间尚未完成的异步读取或惰性编码不得保存，退出后新请求同样拒绝', async (t) => {
  for (const stage of ['read', 'encoding']) {
    const full = image(`manual-stop-${stage}`);
    const pending = deferred();
    const entered = deferred();
    let current = null;
    let reads = 0;
    const store = repository();
    const collector = createCollector(t, {
      readImage: async () => {
        reads++;
        if (stage === 'read' && current) {
          entered.resolve();
          return pending.promise;
        }
        return current;
      },
      repository: store,
    });
    await collector.start({ paused: true });
    current = stage === 'read' ? full : observation(full, () => {
      entered.resolve();
      return pending.promise;
    });
    const collecting = collector.collectCurrent();
    const rejected = assert.rejects(collecting, /程序正在退出/);
    await entered.promise;
    collector.stop();
    pending.resolve(full);
    await rejected;
    assert.deepEqual(store.calls, []);
    assert.equal(store.cache.size, 0);
    const readsBefore = reads;
    await assert.rejects(collector.collectCurrent(), /尚未就绪/);
    assert.equal(reads, readsBefore);
  }
});
