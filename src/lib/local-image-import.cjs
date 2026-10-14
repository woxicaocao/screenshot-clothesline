'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { inspectEncodedImage, MAX_IMPORT_PIXELS } = require('./image-format.cjs');
const { normalizeImage } = require('./electron-image.cjs');

const MAX_LOCAL_FILES = 100;
const MAX_LOCAL_FILE_BYTES = 40 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const IMAGE_TYPES = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' });

class LocalImageImportError extends Error {}

function sourceDetails(filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.length > 32767
    || filePath.includes('\0') || !path.isAbsolute(filePath) || /^[a-z]+:\/\//i.test(filePath)
    || /^\\\\\.\\/.test(filePath)) {
    throw new LocalImageImportError('请从本机文件夹拖入图片文件。');
  }
  const mime = IMAGE_TYPES[path.extname(filePath).toLowerCase()];
  if (!mime) throw new LocalImageImportError('仅支持静态 PNG、JPG、JPEG 和 WebP 图片。');
  return { name: path.basename(filePath).slice(0, 120), mime };
}

function readableError(error) {
  if (error instanceof LocalImageImportError) return error.message;
  if (error?.code === 'ENOENT') return '文件不存在或已移动，请重新拖入。';
  if (['EACCES', 'EPERM', 'EBUSY'].includes(error?.code)) return '暂时无法读取文件，请检查权限后重试。';
  return '图片无法读取，请检查文件后重新拖入。';
}

async function readBoundedFile(filePath, fileSystem = fs) {
  // 只用读取句柄；预先拒绝目录、设备及链接，再检查实际打开的文件。
  const before = await fileSystem.lstat(filePath);
  if (!before.isFile()) throw new LocalImageImportError('请拖入图片文件，不能直接拖入文件夹或快捷方式。');
  const handle = await fileSystem.open(filePath, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new LocalImageImportError('这不是普通图片文件。');
    if (!Number.isSafeInteger(info.size) || info.size <= 0) throw new LocalImageImportError('图片文件为空或无效。');
    if (info.size > MAX_LOCAL_FILE_BYTES) throw new LocalImageImportError('单张图片超过 40 MiB，请缩小文件后再拖入。');
    // 按已校验的长度分配固定缓冲，防止读取中源文件增长导致无限读入。
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, Math.min(READ_CHUNK_BYTES, buffer.length - offset), offset);
      if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0) throw new LocalImageImportError('图片文件正在变化，请保存完成后重新拖入。');
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const tail = await handle.read(extra, 0, 1, buffer.length);
    const after = await handle.stat();
    if (tail.bytesRead !== 0 || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      throw new LocalImageImportError('图片文件正在变化，请保存完成后重新拖入。');
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

function importMessage(result) {
  const parts = [];
  if (result.added) parts.push(`已挂上 ${result.added} 张本机图片`);
  if (result.duplicates) parts.push(`${result.duplicates} 张已在晾衣架上`);
  if (result.failed) parts.push(`${result.failed} 个文件未能添加`);
  let message = parts.join('，');
  if (result.failed && result.errors.length) message += `。${result.errors[0].message}`;
  return message;
}

class LocalImageImporter {
  constructor({ nativeImage, repository, onPhoto = () => {}, fileSystem = fs, decodeWebp = null }) {
    if (!nativeImage || typeof nativeImage.createFromBuffer !== 'function'
      || !repository || typeof repository.savePhoto !== 'function' || typeof onPhoto !== 'function') {
      throw new TypeError('本机图片导入器缺少图片解码器或照片仓库。');
    }
    this._nativeImage = nativeImage;
    this._repository = repository;
    this._onPhoto = onPhoto;
    this._fileSystem = fileSystem;
    this._decodeWebp = decodeWebp;
    this._busy = false;
  }

  async _importFile(filePath) {
    const { mime } = sourceDetails(filePath);
    const bytes = await readBoundedFile(filePath, this._fileSystem);
    let header;
    try { header = inspectEncodedImage(bytes, mime); }
    catch (error) { throw new LocalImageImportError(error.message); }
    if (header.animated) throw new LocalImageImportError('暂不支持动画 PNG 或 WebP，请先转换为静态图片。');
    let decoded = this._nativeImage.createFromBuffer(bytes);
    if ((!decoded || decoded.isEmpty()) && header.extension === 'webp' && this._decodeWebp) {
      try { decoded = await this._decodeWebp(bytes, header); }
      catch (error) { throw new LocalImageImportError(error.message); }
    }
    if (!decoded || decoded.isEmpty()) throw new LocalImageImportError('图片文件损坏或无法解码，请换一张图片。');
    const size = decoded.getSize();
    const directSize = size.width === header.width && size.height === header.height;
    const rotated = ['jpg', 'webp'].includes(header.extension) && size.width === header.height && size.height === header.width;
    if (!directSize && !rotated || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)
      || size.width <= 0 || size.height <= 0 || size.width * size.height > MAX_IMPORT_PIXELS) {
      throw new LocalImageImportError('图片尺寸无效或超过 4000 万像素，暂时无法添加。');
    }
    const image = normalizeImage(decoded, { originalBytes: bytes, originalExtension: header.extension });
    if (!image) throw new LocalImageImportError('图片无法解码，请换一张图片。');
    try { return await this._repository.savePhoto(image); }
    catch { throw new LocalImageImportError('图片未能保存，请重新拖入重试。'); }
  }

  async importFiles(filePaths) {
    if (!Array.isArray(filePaths) || filePaths.length === 0 || filePaths.length > MAX_LOCAL_FILES) {
      throw new LocalImageImportError('请拖入 1 至 100 张本机图片，一次最多 100 张。');
    }
    if (this._busy) throw new LocalImageImportError('正在挂上上一批图片，请稍后再拖入。');
    this._busy = true;
    // 只持有最多 100 个短路径；每张图片读、解码、保存完成后再读取下一张。
    const paths = filePaths.slice();
    const result = { added: 0, duplicates: 0, failed: 0, total: paths.length, errors: [] };
    try {
      for (const filePath of paths) {
        let saved;
        try { saved = await this._importFile(filePath); }
        catch (error) {
          result.failed++;
          const name = typeof filePath === 'string' ? path.basename(filePath).slice(0, 120) : '文件';
          result.errors.push({ name, message: readableError(error) });
          continue;
        }
        if (saved.added) {
          result.added++;
          // 通知失败不能撤销已经落盘的图片，后续快照仍会包含它。
          try { this._onPhoto(saved.photo); } catch { /* 保持逐项导入。 */ }
        } else result.duplicates++;
      }
      return { ...result, message: importMessage(result) };
    } finally {
      this._busy = false;
    }
  }
}

module.exports = { LocalImageImporter, LocalImageImportError, MAX_LOCAL_FILES, MAX_LOCAL_FILE_BYTES, readBoundedFile };
