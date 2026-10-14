'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ORIGINAL_EXTENSIONS = Object.freeze(['png', 'jpg', 'webp']);
const CACHE_DIRECTORIES = Object.freeze(['photos', 'thumbnails', 'exports']);
const DEFAULT_SETTINGS = Object.freeze({ paused: false, alwaysOnTop: false, autoHide: false, autoHideSpeed: 'medium', bounds: null });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isImage(image) {
  return Boolean(image && typeof image.hash === 'string' && HASH_PATTERN.test(image.hash)
    && Number.isSafeInteger(image.width) && image.width > 0
    && Number.isSafeInteger(image.height) && image.height > 0
    && Buffer.isBuffer(image.png) && image.png.length > 0
    && (image.originalExtension === undefined || ORIGINAL_EXTENSIONS.includes(image.originalExtension))
    && (image.originalBytes === undefined || (Buffer.isBuffer(image.originalBytes) && image.originalBytes.length > 0
      && ORIGINAL_EXTENSIONS.includes(image.originalExtension)))
    && Buffer.isBuffer(image.thumbnail) && image.thumbnail.length > 0);
}

function validateSettings(partial, previous = DEFAULT_SETTINGS) {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new TypeError('设置必须是对象。');
  }
  const next = clone(previous);
  for (const key of ['paused', 'alwaysOnTop', 'autoHide']) {
    if (Object.hasOwn(partial, key)) {
      if (typeof partial[key] !== 'boolean') throw new TypeError(`${key} 必须是布尔值。`);
      next[key] = partial[key];
    }
  }
  if (Object.hasOwn(partial, 'autoHideSpeed')) {
    if (!['fast', 'medium', 'slow'].includes(partial.autoHideSpeed)) {
      throw new TypeError('autoHideSpeed 必须是 fast、medium 或 slow。');
    }
    next.autoHideSpeed = partial.autoHideSpeed;
  }
  if (Object.hasOwn(partial, 'bounds')) {
    const bounds = partial.bounds;
    if (bounds !== null && (!bounds || !['x', 'y', 'width', 'height'].every((key) => Number.isSafeInteger(bounds[key]))
      || bounds.width <= 0 || bounds.height <= 0)) {
      throw new TypeError('窗口位置和尺寸无效。');
    }
    next.bounds = bounds === null ? null : {
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    };
  }
  return next;
}

class PhotoRepository {
  constructor(dataDir) {
    if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('缺少数据目录。');
    this.dataDir = path.resolve(dataDir);
    this._photos = [];
    this._pendingDeletes = new Set();
    this._settings = clone(DEFAULT_SETTINGS);
    this._tail = Promise.resolve();
    this._initialized = false;
  }

  _enqueue(operation) {
    const pending = this._tail.then(operation);
    this._tail = pending.catch(() => {});
    return pending;
  }

  async init() {
    return this._enqueue(async () => {
      if (this._initialized) return;
      await fs.mkdir(this.dataDir, { recursive: true });
      this._realDataDir = await fs.realpath(this.dataDir);
      for (const name of CACHE_DIRECTORIES) {
        await fs.mkdir(path.join(this.dataDir, name), { recursive: true });
        await this._cacheDirectory(name);
      }
      const index = await this._readJson('index.json', { version: 1, photos: [] });
      if (!index || index.version !== 1 || !Array.isArray(index.photos)
        || (index.pendingDeletes !== undefined && (!Array.isArray(index.pendingDeletes)
          || index.pendingDeletes.some((hash) => typeof hash !== 'string' || !HASH_PATTERN.test(hash))))) {
        throw new Error('照片索引格式无效，原文件已保留。');
      }
      const pendingDeletes = new Set(index.pendingDeletes ?? []);
      const hashes = new Set();
      const photos = index.photos.map((photo) => {
        if (!photo || typeof photo.hash !== 'string' || !HASH_PATTERN.test(photo.hash) || photo.id !== photo.hash
          || !Number.isSafeInteger(photo.width) || photo.width <= 0
          || !Number.isSafeInteger(photo.height) || photo.height <= 0
          || typeof photo.capturedAt !== 'string' || !Number.isFinite(Date.parse(photo.capturedAt))
          || !ORIGINAL_EXTENSIONS.some((extension) => photo.fileName === `${photo.hash}.${extension}`)
          || photo.thumbnailName !== `${photo.hash}.png`
          || hashes.has(photo.hash)) {
          throw new Error('照片索引包含无效记录，原文件已保留。');
        }
        hashes.add(photo.hash);
        return clone(photo);
      });
      const settings = validateSettings(await this._readJson('settings.json', DEFAULT_SETTINGS));
      this._photos = photos.sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt));
      // 已授权删除的记录即使出现不完整旧索引，也不得在重启后重新显示。
      this._photos = this._photos.filter((photo) => !pendingDeletes.has(photo.hash));
      this._pendingDeletes = pendingDeletes;
      this._settings = settings;
      this._initialized = true;
      await this._retryPendingDeletes();
    });
  }

  async _readJson(name, fallback) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dataDir, name), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return clone(fallback);
      throw new Error(`无法读取 ${name}，原文件已保留。`, { cause: error });
    }
  }

  getPhotos() {
    return clone(this._photos);
  }

  getPhoto(id) {
    this._requireHash(id);
    const photo = this._photos.find((entry) => entry.id === id);
    return photo ? clone(photo) : null;
  }

  getSettings() {
    return clone(this._settings);
  }

  _requireHash(id) {
    if (typeof id !== 'string' || !HASH_PATTERN.test(id)) throw new TypeError('图片标识无效。');
    if (!this._initialized) throw new Error('照片仓库尚未初始化。');
  }

  _samePath(left, right) {
    const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
    return normalize(path.resolve(left)) === normalize(path.resolve(right));
  }

  async _cacheDirectory(name) {
    if (!CACHE_DIRECTORIES.includes(name)) throw new TypeError('图片缓存目录无效。');
    const directory = path.resolve(this.dataDir, name);
    const root = await fs.realpath(this.dataDir);
    const realDirectory = await fs.realpath(directory);
    // 拒绝目录 junction/symlink 以及初始化后替换的数据根目录。
    if (!this._samePath(root, this._realDataDir)
      || !this._samePath(realDirectory, path.join(this._realDataDir, name))
      || !(await fs.lstat(directory)).isDirectory()) {
      throw new Error('图片缓存目录超出应用数据目录，已停止操作。');
    }
    return directory;
  }

  async _cachePath(name, fileName) {
    const directory = await this._cacheDirectory(name);
    const destination = path.resolve(directory, fileName);
    if (path.dirname(destination) !== directory || path.basename(destination) !== fileName) {
      throw new Error('图片缓存路径超出应用数据目录，已停止操作。');
    }
    return destination;
  }

  async _writeIndex(photos, pendingDeletes = this._pendingDeletes) {
    const index = { version: 1, photos };
    if (pendingDeletes.size) index.pendingDeletes = [...pendingDeletes];
    await this._atomicWrite(path.join(this.dataDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  }

  async _atomicWrite(destination, contents) {
    const temporary = `${destination}.pending-${randomUUID()}`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx');
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close();
      handle = undefined;
      // 同目录重命名原子发布；失败保留原文件和 pending 文件，绝不删除文件。
      await fs.rename(temporary, destination);
    } finally {
      if (handle) await handle.close();
    }
  }

  async _saveImmutable(relativeName, contents) {
    const destination = await this._cachePath(path.dirname(relativeName), path.basename(relativeName));
    try {
      const existing = await fs.lstat(destination);
      if (!existing.isFile() || existing.size === 0) {
        throw new Error(`已有图片文件无效，已保留：${relativeName}`);
      }
      // 上一次索引写入失败时留下的完整图片可供重试复用。
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await this._atomicWrite(destination, contents);
  }

  async savePhoto(image) {
    if (!isImage(image)) throw new TypeError('截图图片数据无效。');
    const capturedAt = image.capturedAt ?? new Date().toISOString();
    if (typeof capturedAt !== 'string' || !Number.isFinite(Date.parse(capturedAt))) {
      throw new TypeError('截图时间无效。');
    }
    // 复制调用方的 Buffer，避免等待串行队列期间图片数据被修改。
    const input = {
      hash: image.hash, width: image.width, height: image.height,
      png: Buffer.from(image.originalBytes ?? image.png), thumbnail: Buffer.from(image.thumbnail),
      originalExtension: image.originalExtension ?? 'png', capturedAt,
    };
    return this._enqueue(async () => {
      if (!this._initialized) throw new Error('照片仓库尚未初始化。');
      if (this._pendingDeletes.has(input.hash)) throw new Error('图片缓存正在清理，请稍后重试。');
      const existing = this._photos.find((photo) => photo.hash === input.hash);
      if (existing) return { photo: clone(existing), added: false };
      const photo = {
        id: input.hash, hash: input.hash, width: input.width, height: input.height,
        capturedAt: input.capturedAt, fileName: `${input.hash}.${input.originalExtension}`, thumbnailName: `${input.hash}.png`,
      };
      await this._saveImmutable(path.join('photos', photo.fileName), input.png);
      await this._saveImmutable(path.join('thumbnails', photo.thumbnailName), input.thumbnail);
      const photos = [photo, ...this._photos].sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt));
      await this._writeIndex(photos);
      this._photos = photos;
      return { photo: clone(photo), added: true };
    });
  }

  async prepareExport(id) {
    this._requireHash(id);
    return this._enqueue(async () => {
      const photo = this._photos.find((entry) => entry.id === id);
      if (!photo || this._pendingDeletes.has(id)) throw new Error('这张图片已删除或不存在。');
      const source = await this._cachePath('photos', photo.fileName);
      const sourceInfo = await fs.lstat(source);
      if (!sourceInfo.isFile() || sourceInfo.size === 0) throw new Error('截图原图无效，无法拖出。');
      const destination = await this._cachePath('exports', photo.fileName);
      try {
        const info = await fs.lstat(destination);
        if (!info.isFile() || info.size === 0) throw new Error('截图导出缓存无效，已保留。');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await this._atomicWrite(destination, await fs.readFile(source));
      }
      return destination;
    });
  }

  async ensureCompactThumbnail(id, converter) {
    this._requireHash(id);
    if (typeof converter !== 'function') throw new TypeError('缩略图转换器必须是函数。');
    return this._enqueue(async () => {
      const photo = this._photos.find((entry) => entry.id === id);
      if (!photo || this._pendingDeletes.has(id)) throw new Error('这张图片已删除或不存在。');
      const compactName = `${id}.compact.png`;
      const compactPath = await this._cachePath('thumbnails', compactName);
      try {
        const existing = await fs.lstat(compactPath);
        if (!existing.isFile() || existing.size === 0) throw new Error('紧凑缩略图缓存无效，已保留。');
        return compactPath;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const source = await this._cachePath('thumbnails', photo.thumbnailName);
      const sourceInfo = await fs.lstat(source);
      if (!sourceInfo.isFile() || sourceInfo.size === 0) throw new Error('截图缩略图无效，无法生成紧凑缓存。');
      const converted = await converter(await fs.readFile(source));
      if (!converted || typeof converted.changed !== 'boolean' || !Buffer.isBuffer(converted.buffer) || !converted.buffer.length) {
        throw new TypeError('缩略图转换结果无效。');
      }
      // 全过程在仓库串行队列中执行；删除先完成时不能再创建此图片的缓存。
      if (!this._photos.some((entry) => entry.id === id) || this._pendingDeletes.has(id)) {
        throw new Error('这张图片已删除或不存在。');
      }
      if (!converted.changed) return source;
      const validatedDestination = await this._cachePath('thumbnails', compactName);
      await this._atomicWrite(validatedDestination, Buffer.from(converted.buffer));
      return validatedDestination;
    });
  }

  async _cleanupHash(hash) {
    let cleaned = true;
    for (const name of CACHE_DIRECTORIES) {
      try {
        const directory = await this._cacheDirectory(name);
        const fileNames = name === 'thumbnails'
          ? [`${hash}.png`, `${hash}.compact.png`]
          : ORIGINAL_EXTENSIONS.map((extension) => `${hash}.${extension}`);
        const names = (await fs.readdir(directory)).filter((entry) => fileNames.some((fileName) => entry === fileName || entry.startsWith(`${fileName}.pending-`)));
        for (const entry of names) {
          try {
            // 每次 unlink 前重新校验父目录及绝对路径，只清理此哈希的文件。
            const destination = await this._cachePath(name, entry);
            const info = await fs.lstat(destination);
            if (!info.isFile() && !info.isSymbolicLink()) throw new Error('图片缓存路径不是文件，已保留。');
            await fs.unlink(destination);
          } catch (error) {
            if (error.code !== 'ENOENT') cleaned = false;
          }
        }
      } catch {
        cleaned = false;
      }
    }
    return cleaned;
  }

  async _retryPendingDeletes() {
    if (!this._pendingDeletes.size) return { remaining: 0 };
    const remaining = new Set(this._pendingDeletes);
    for (const hash of this._pendingDeletes) {
      if (await this._cleanupHash(hash)) remaining.delete(hash);
    }
    if (remaining.size !== this._pendingDeletes.size) {
      try {
        await this._writeIndex(this._photos, remaining);
        this._pendingDeletes = remaining;
      } catch {
        // 图片已隐藏；索引被占用时保留删除任务，下次继续安全重试。
      }
    }
    return { remaining: this._pendingDeletes.size };
  }

  async retryPendingDeletes() {
    return this._enqueue(async () => {
      if (!this._initialized) throw new Error('照片仓库尚未初始化。');
      return this._retryPendingDeletes();
    });
  }

  async deletePhoto(id) {
    this._requireHash(id);
    return this._enqueue(async () => {
      const photo = this._photos.find((entry) => entry.id === id);
      if (!photo && !this._pendingDeletes.has(id)) return { deleted: false, cleanupPending: false };
      if (photo) {
        const photos = this._photos.filter((entry) => entry.id !== id);
        const pendingDeletes = new Set([...this._pendingDeletes, id]);
        // 先原子提交删除授权和隐藏记录；失败时不触碰任何图片文件。
        await this._writeIndex(photos, pendingDeletes);
        this._photos = photos;
        this._pendingDeletes = pendingDeletes;
      }
      await this._retryPendingDeletes();
      return { deleted: Boolean(photo), cleanupPending: this._pendingDeletes.has(id) };
    });
  }

  async updateSettings(partial) {
    return this._enqueue(async () => {
      if (!this._initialized) throw new Error('照片仓库尚未初始化。');
      const settings = validateSettings(partial, this._settings);
      await this._atomicWrite(path.join(this.dataDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
      this._settings = settings;
      return clone(settings);
    });
  }
}

module.exports = { PhotoRepository, DEFAULT_SETTINGS, isImage };
