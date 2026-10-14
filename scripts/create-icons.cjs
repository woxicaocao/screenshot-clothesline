'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const table = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const label = Buffer.from(type);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  label.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([label, data])), result.length - 4);
  return result;
}
function rounded(x, y, left, top, width, height, radius) {
  const dx = Math.max(left + radius - x, 0, x - (left + width - radius));
  const dy = Math.max(top + radius - y, 0, y - (top + height - radius));
  return x >= left && x <= left + width && y >= top && y <= top + height && dx * dx + dy * dy <= radius * radius;
}
function colorAt(x, y) {
  let color = [0, 0, 0, 0];
  if (rounded(x, y, 4, 4, 248, 248, 54)) color = [42, 69, 58, 255];
  const rope = 80 + 12 * Math.sin((x - 18) * Math.PI / 220);
  if (x >= 18 && x <= 238 && Math.abs(y - rope) < 3) color = [218, 191, 137, 255];
  if (rounded(x, y, 65, 102, 140, 113, 7)) color = [22, 47, 39, 255];
  if (rounded(x, y, 59, 94, 140, 113, 7)) color = [248, 243, 225, 255];
  if (rounded(x, y, 69, 104, 120, 82, 2)) color = [136, 165, 143, 255];
  if (x >= 69 && x <= 189 && y >= 154 - (x - 70) * 0.42 && y <= 186) color = [72, 109, 89, 255];
  if (x >= 107 && x <= 189 && y >= 119 + (x - 143) * 0.8 && y <= 186) color = [99, 137, 110, 255];
  if ((x - 96) ** 2 + (y - 126) ** 2 < 100) color = [239, 215, 157, 255];
  if (rounded(x, y, 118, 64, 22, 58, 6)) color = [193, 139, 80, 255];
  if (rounded(x, y, 120, 65, 8, 55, 4)) color = [223, 178, 113, 255];
  if (x >= 119 && x <= 139 && y >= 92 && y <= 98) color = [110, 86, 61, 255];
  if ((x - 129) ** 2 + (y - 94) ** 2 < 12) color = [221, 210, 180, 255];
  return color;
}
function makePNG(size) {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sums = [0, 0, 0, 0];
      for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
        const color = colorAt((x + (sx + 0.5) / 2) * 256 / size, (y + (sy + 0.5) / 2) * 256 / size);
        for (let c = 0; c < 4; c++) sums[c] += color[c];
      }
      for (let c = 0; c < 4; c++) rows[y * (size * 4 + 1) + 1 + x * 4 + c] = Math.round(sums[c] / 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const directory = path.join(__dirname, '..', 'src', 'assets');
fs.mkdirSync(directory, { recursive: true });
const png = makePNG(256);
fs.writeFileSync(path.join(directory, 'app.png'), png);
fs.writeFileSync(path.join(directory, 'tray.png'), makePNG(64));
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
header[8] = 0; header[9] = 0;
header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(directory, 'app.ico'), Buffer.concat([header, png]));
console.log('图标已生成');
