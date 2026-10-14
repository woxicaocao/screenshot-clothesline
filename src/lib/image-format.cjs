'use strict';

const { BridgeError } = require('./browser-bridge.cjs');
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_IMPORT_PIXELS = 40_000_000;

function inspectEncodedImage(bytes, mime) {
  let width, height, extension, actualMime, animated = false;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); extension = 'png'; actualMime = 'image/png';
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (offset + 12 + length > bytes.length) break;
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL' && length === 8 && bytes.readUInt32BE(offset + 8) > 0) { animated = true; break; }
      offset += 12 + length;
    }
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if ([0xda, 0xd9].includes(marker)) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); extension = 'jpg'; actualMime = 'image/jpeg'; break;
      }
      offset += length;
    }
  } else if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const chunk = bytes.toString('ascii', offset, offset + 4); const length = bytes.readUInt32LE(offset + 4); const start = offset + 8;
      if (start + length > bytes.length) break;
      if (chunk === 'VP8X' && length >= 10) { width = 1 + bytes.readUIntLE(start + 4, 3); height = 1 + bytes.readUIntLE(start + 7, 3); animated = !!(bytes[start] & 2); }
      else if (chunk === 'VP8L' && length >= 5 && bytes[start] === 0x2f) { const bits = bytes.readUInt32LE(start + 1); width = 1 + (bits & 0x3fff); height = 1 + (bits >>> 14 & 0x3fff); }
      else if (chunk === 'VP8 ' && length >= 10 && bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) { width = bytes.readUInt16LE(start + 6) & 0x3fff; height = bytes.readUInt16LE(start + 8) & 0x3fff; }
      if (width && height) { extension = 'webp'; actualMime = 'image/webp'; break; }
      offset = start + length + (length % 2);
    }
  }
  if (!width || !height || !extension || actualMime !== mime) throw new BridgeError('图片格式无效或与文件内容不一致，请选择 PNG、JPEG 或 WebP 图片。', 415);
  if (width * height > MAX_IMPORT_PIXELS) throw new BridgeError('图片超过 4000 万像素，暂时无法添加。', 413);
  return { width, height, extension, mime: actualMime, ...(animated ? { animated: true } : {}) };
}

const mimeForFile = fileName => ({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' })[fileName.split('.').pop()] || 'application/octet-stream';
module.exports = { inspectEncodedImage, mimeForFile, MAX_IMPORT_PIXELS };
