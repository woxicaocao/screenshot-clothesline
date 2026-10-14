'use strict';

const { randomUUID } = require('node:crypto');
const { inspectEncodedImage } = require('./image-format.cjs');
const MAX_DECODED_BYTES = 128 * 1024 * 1024;

// Chromium 补齐 NativeImage 不支持的 WebP；复用衣架进程，只有一张在途。
class RendererImageDecoder {
  constructor({ getWindow, nativeImage, timeoutMs = 15000 }) {
    this.getWindow = getWindow;
    this.nativeImage = nativeImage;
    this.timeoutMs = timeoutMs;
    this.pending = null;
  }

  decode(bytes, header) {
    if (this.pending) return Promise.reject(new Error('上一张 WebP 正在处理，请稍后重试。'));
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return Promise.reject(new Error('衣架暂不可用，请稍后重试。'));
    const contents = window.webContents;
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const finished = (error, image) => {
        const pending = this.pending;
        if (!pending || pending.requestId !== requestId) return;
        this.pending = null;
        clearTimeout(pending.timer);
        contents.removeListener('destroyed', pending.onDestroyed);
        if (error) reject(error); else resolve(image);
      };
      const onDestroyed = () => finished(new Error('衣架已关闭，请重新拖入图片。'));
      const timer = setTimeout(() => finished(new Error('WebP 处理超时，请转换为 PNG 或 JPEG 后再拖入。')), this.timeoutMs);
      timer.unref?.();
      this.pending = { requestId, contents, header, finished, timer, onDestroyed };
      contents.once('destroyed', onDestroyed);
      try { contents.send('rack:decode-local-webp', { requestId, bytes, width: header.width, height: header.height }); }
      catch (error) { finished(error); }
    });
  }

  accept(event, payload) {
    const pending = this.pending;
    if (!pending || event.sender !== pending.contents || event.senderFrame !== pending.contents.mainFrame
      || payload?.requestId !== pending.requestId) return false;
    try {
      if (payload.error) throw new Error('这张 WebP 暂时无法解码，请转换为 PNG 或 JPEG 再拖入。');
      if (!(payload.bytes instanceof Uint8Array) || !payload.bytes.byteLength || payload.bytes.byteLength > MAX_DECODED_BYTES) {
        throw new Error('WebP 转换结果过大或无效，请缩小图片后重新拖入。');
      }
      const bytes = Buffer.from(payload.bytes.buffer, payload.bytes.byteOffset, payload.bytes.byteLength);
      const dimensions = inspectEncodedImage(bytes, 'image/png');
      const { width, height } = pending.header;
      if (dimensions.animated || !(dimensions.width === width && dimensions.height === height
        || dimensions.width === height && dimensions.height === width)) throw new Error('WebP 转换尺寸无效。');
      const image = this.nativeImage.createFromBuffer(bytes);
      if (!image || image.isEmpty()) throw new Error('WebP 转换结果无法解码。');
      pending.finished(null, image);
    } catch (error) { pending.finished(error); }
    return true;
  }
}

module.exports = { RendererImageDecoder, MAX_DECODED_BYTES };
