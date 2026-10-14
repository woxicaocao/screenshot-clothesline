'use strict';

const { isImage } = require('./repository.cjs');
const { isImageObservation } = require('./electron-image.cjs');

const isObservedImage = (image) => isImage(image) || isImageObservation(image);

class ClipboardCollector {
  constructor({ readImage, repository, onPhoto = () => {}, onError = () => {}, intervalMs = 800 }) {
    if (typeof readImage !== 'function' || !repository || typeof repository.savePhoto !== 'function') {
      throw new TypeError('剪贴板收集器缺少读取函数或照片仓库。');
    }
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new TypeError('轮询间隔无效。');
    this._readImage = readImage;
    this._repository = repository;
    this._onPhoto = onPhoto;
    this._onError = onError;
    this._intervalMs = intervalMs;
    this._started = false;
    this._paused = true;
    this._generation = 0;
    this._timer = null;
    this._polling = null;
    this._transition = null;
    this._tail = Promise.resolve();
    this._lastObservedHash = null;
    this._needsBaseline = true;
    this._savedHashes = new Set();
    this._pendingImage = null;
    this._photoVersions = new Map();
    this._forgottenUntilChange = new Set();
  }

  _enqueue(operation) {
    const pending = this._tail.then(operation);
    this._tail = pending.catch(() => {});
    return pending;
  }

  _report(error) {
    try { this._onError(error); } catch { /* 用户回调不得中止后续轮询。 */ }
  }

  _clearTimer() {
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = null;
  }

  _armTimer() {
    this._clearTimer();
    if (!this._started || this._paused || this._transition || this._polling) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      void this.pollOnce();
    }, this._intervalMs);
    this._timer.unref?.();
  }

  async _readBaseline(generation) {
    try {
      const image = await this._readImage();
      if (!this._started || generation !== this._generation) return;
      this._lastObservedHash = isObservedImage(image) ? image.hash : null;
      this._observeForgottenBaseline(this._lastObservedHash);
      this._needsBaseline = false;
    } catch (error) {
      if (this._started && generation === this._generation) this._report(error);
    }
  }

  async start({ paused = false } = {}) {
    if (typeof paused !== 'boolean') throw new TypeError('暂停状态必须是布尔值。');
    this.stop();
    this._started = true;
    this._paused = true;
    this._needsBaseline = true;
    this._savedHashes = new Set(this._repository.getPhotos?.().map((photo) => photo.hash) ?? []);
    const generation = ++this._generation;
    const transition = this._enqueue(() => this._readBaseline(generation));
    this._transition = transition;
    await transition;
    if (!this._started || generation !== this._generation) return;
    this._transition = null;
    this._paused = paused;
    this._armTimer();
  }

  async setPaused(paused) {
    if (typeof paused !== 'boolean') throw new TypeError('暂停状态必须是布尔值。');
    this._clearTimer();
    const generation = ++this._generation;
    // 在任何 await 之前暂停，立即废弃正在读取但尚未入库的截图。
    this._paused = true;
    this._transition = null;
    if (paused || !this._started) {
      this._paused = paused;
      return;
    }
    this._needsBaseline = true;
    const transition = this._enqueue(() => this._readBaseline(generation));
    this._transition = transition;
    await transition;
    if (!this._started || generation !== this._generation) return;
    this._transition = null;
    this._paused = false;
    this._armTimer();
  }

  stop() {
    this._started = false;
    ++this._generation;
    this._clearTimer();
    this._transition = null;
    this._pendingImage = null;
  }

  forgetPhoto(hash) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new TypeError('图片标识无效。');
    this._savedHashes.delete(hash);
    this._photoVersions.set(hash, (this._photoVersions.get(hash) ?? 0) + 1);
    this._forgottenUntilChange.add(hash);
    if (this._pendingImage?.hash === hash) this._pendingImage = null;
    // 保留当前观察哈希：删除剪贴板上正在显示的截图后，不立即重新挂回。
  }

  _observeForgottenBaseline(hash) {
    for (const forgotten of this._forgottenUntilChange) {
      if (forgotten !== hash) this._forgottenUntilChange.delete(forgotten);
    }
  }

  async _savePending() {
    const image = this._pendingImage;
    if (!image) return;
    const version = this._photoVersions.get(image.hash) ?? 0;
    const result = await this._repository.savePhoto(image);
    // 正在保存的截图被用户删除时，其完成结果不能重新通知衣架显示。
    if (version !== (this._photoVersions.get(image.hash) ?? 0)) return;
    this._savedHashes.add(image.hash);
    if (this._pendingImage === image) this._pendingImage = null;
    // 不覆盖观察哈希：恢复收集时建立的剪贴板基线必须继续生效。
    if (result.added) {
      try { this._onPhoto(result.photo); } catch (error) { this._report(error); }
    }
  }

  collectCurrent() {
    return this._enqueue(async () => {
      if (!this._started) throw new Error('收集器尚未就绪，请稍后粘贴。');
      // 手动粘贴与轮询共用队列，暂停及启动基线不会跳过用户明确要求的图片。
      const image = await this._readImage();
      if (!this._started) throw new Error('程序正在退出。');
      if (!isObservedImage(image)) return null;
      const existing = this._repository.getPhotos?.().find(photo => photo.hash === image.hash);
      if (existing) return { added: false, photo: existing };
      const fullImage = isImage(image) ? image : await image.loadImage();
      if (!this._started) throw new Error('程序正在退出。');
      if (!isImage(fullImage) || fullImage.hash !== image.hash
        || fullImage.width !== image.width || fullImage.height !== image.height) {
        throw new Error('剪贴板图片无效，请重新复制后粘贴。');
      }
      const result = await this._repository.savePhoto(fullImage);
      this._savedHashes.add(image.hash);
      this._forgottenUntilChange.delete(image.hash);
      this._lastObservedHash = image.hash;
      this._needsBaseline = false;
      if (this._pendingImage?.hash === image.hash) this._pendingImage = null;
      return result;
    });
  }

  async pollOnce() {
    if (!this._started || this._paused || this._transition || this._polling) return;
    this._clearTimer();
    const generation = this._generation;
    const polling = this._enqueue(async () => {
      if (!this._started || this._paused || generation !== this._generation) return;
      try {
        // 最多保留一张待保存图片；磁盘恢复后先保存它，再读取当前剪贴板。
        // 保存持续失败时不积累后续截图，避免待存队列无限占用内存。
        if (this._pendingImage) await this._savePending();
        if (!this._started || this._paused || generation !== this._generation) return;
        const image = await this._readImage();
        if (!this._started || this._paused || generation !== this._generation) return;
        if (!isObservedImage(image)) {
          this._lastObservedHash = null;
          this._observeForgottenBaseline(null);
          this._needsBaseline = false;
          return;
        }
        this._observeForgottenBaseline(image.hash);
        if (this._forgottenUntilChange.has(image.hash)) {
          this._lastObservedHash = image.hash;
          this._needsBaseline = false;
          return;
        }
        if (this._needsBaseline) {
          this._lastObservedHash = image.hash;
          this._needsBaseline = false;
          return;
        }
        if (image.hash === this._lastObservedHash) return;
        if (this._savedHashes.has(image.hash)) {
          this._lastObservedHash = image.hash;
          return;
        }
        const version = this._photoVersions.get(image.hash) ?? 0;
        const fullImage = isImage(image) ? image : await image.loadImage();
        if (!this._started || this._paused || generation !== this._generation) return;
        if (version !== (this._photoVersions.get(image.hash) ?? 0)
          || this._forgottenUntilChange.has(image.hash)) {
          this._lastObservedHash = image.hash;
          return;
        }
        if (!isImage(fullImage) || fullImage.hash !== image.hash
          || fullImage.width !== image.width || fullImage.height !== image.height) {
          throw new Error('截图图片读取结果无效，稍后重试。');
        }
        // 编码失败时不提前推进基线，下一轮仍可读取同图并重试。
        this._lastObservedHash = image.hash;
        this._pendingImage = {
          hash: fullImage.hash, width: fullImage.width, height: fullImage.height,
          png: Buffer.from(fullImage.png), thumbnail: Buffer.from(fullImage.thumbnail),
          capturedAt: fullImage.capturedAt ?? new Date().toISOString(),
        };
        await this._savePending();
      } catch (error) {
        // 保存失败不标记已保存，并保留独立 Buffer；剪贴板变化后仍可重试。
        if (this._started) this._report(error);
      }
    });
    this._polling = polling;
    try {
      await polling;
    } finally {
      if (this._polling === polling) this._polling = null;
      this._armTimer();
    }
  }
}

module.exports = { ClipboardCollector };
