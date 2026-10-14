'use strict';

const { createHash } = require('node:crypto');

function inspectImage(image) {
  if (!image || image.isEmpty()) return null;
  const { width, height } = image.getSize();
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) return null;
  if (width * height > 100_000_000) throw new Error('图片太大，暂时无法挂上。');
  const dimensions = Buffer.alloc(8);
  dimensions.writeUInt32LE(width, 0);
  dimensions.writeUInt32LE(height, 4);
  const hash = createHash('sha256').update(dimensions).update(image.toBitmap()).digest('hex');
  return { hash, width, height };
}

function encodeImage(image, metadata, options = {}) {
  const { width, height } = metadata;
  const hasOriginal = options.originalBytes !== undefined || options.originalExtension !== undefined;
  if (hasOriginal && (!Buffer.isBuffer(options.originalBytes) || options.originalBytes.length === 0
    || !['png', 'jpg', 'webp'].includes(options.originalExtension))) {
    throw new TypeError('原始图片字节及格式无效。');
  }
  const factor = Math.min(1, 288 / width, 176 / height);
  const thumbnail = image.resize({
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
    quality: 'best'
  }).toPNG();
  if (hasOriginal) {
    // png 为既有兼容数据槽；网页导入按 originalExtension 保存原始字节，避免再编码。
    // 两个字段引用同一 Buffer，仓库只创建一份独立保存副本。
    return { ...metadata, png: options.originalBytes, originalBytes: options.originalBytes, originalExtension: options.originalExtension, thumbnail };
  }
  return { ...metadata, png: image.toPNG(), thumbnail };
}

function normalizeImage(image, options = {}) {
  const metadata = inspectImage(image);
  return metadata ? encodeImage(image, metadata, options) : null;
}

function isImageObservation(image) {
  return Boolean(image && typeof image.hash === 'string' && /^[a-f0-9]{64}$/.test(image.hash)
    && Number.isSafeInteger(image.width) && image.width > 0
    && Number.isSafeInteger(image.height) && image.height > 0
    && typeof image.loadImage === 'function');
}

function observation(metadata, source, nativeImage) {
  return {
    ...metadata,
    loadImage() {
      // 此描述仅供一次轮询消费；编码后立刻释放捕获的原始缓冲/解码图片。
      // 待保存副本由收集器独立持有，重试不再依赖剪贴板或此闭包。
      const current = source;
      source = null;
      if (!current) throw new Error('图片读取已结束，请重新读取剪贴板。');
      const image = Buffer.isBuffer(current) ? nativeImage.createFromBuffer(current) : current;
      return encodeImage(image, metadata);
    }
  };
}

function createClipboardReader(clipboard, nativeImage) {
  let previousEncodedHash = null;
  let previousMetadata = null;
  return async function readImage() {
    const items = await clipboard.read();
    for (const item of items) {
      const type = item.types.includes('image/png')
        ? 'image/png'
        : item.types.find((value) => /^image\/(jpeg|jpg|webp|gif|bmp)$/i.test(value));
      if (!type) continue;
      const blob = await item.getType(type);
      const buffer = Buffer.from(await blob.arrayBuffer());
      const digest = createHash('sha256').update(buffer).digest('hex');
      if (digest === previousEncodedHash) {
        return previousMetadata ? observation(previousMetadata, buffer, nativeImage) : null;
      }
      const image = nativeImage.createFromBuffer(buffer);
      const metadata = inspectImage(image);
      previousEncodedHash = digest;
      // 常驻缓存只有两个摘要和尺寸；启动基线/重复图片无需PNG或缩略图编码。
      previousMetadata = metadata;
      return metadata ? observation(metadata, image, nativeImage) : null;
    }
    previousEncodedHash = null;
    previousMetadata = null;
    return null;
  };
}

module.exports = { createClipboardReader, normalizeImage, isImageObservation };
