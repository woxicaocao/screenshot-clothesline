'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { RendererImageDecoder } = require('../src/lib/renderer-image-decoder.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxMsAAAAASUVORK5CYII=', 'base64');

function harness(timeoutMs = 1000) {
  const contents = new EventEmitter();
  contents.mainFrame = {};
  contents.send = (channel, payload) => { contents.sent = { channel, payload }; };
  const image = { isEmpty: () => false };
  const decoder = new RendererImageDecoder({ timeoutMs,
    getWindow: () => ({ isDestroyed: () => false, webContents: contents }),
    nativeImage: { createFromBuffer: bytes => { assert.deepEqual(bytes, png); return image; } } });
  const start = () => decoder.decode(Buffer.from('webp source'), { width: 1, height: 1 });
  const reply = extra => ({ requestId: contents.sent.payload.requestId, bytes: new Uint8Array(png), ...extra });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return { decoder, contents, image, start, reply, event };
}

test('WebP 解码回包仅接受原衣架主 frame 和唯一请求标识，成功后不保留二进制缓存', async () => {
  const h = harness(), result = h.start();
  assert.equal(h.contents.sent.channel, 'rack:decode-local-webp');
  assert.equal(h.decoder.accept({ sender: {}, senderFrame: h.contents.mainFrame }, h.reply()), false);
  assert.equal(h.decoder.accept({ sender: h.contents, senderFrame: {} }, h.reply()), false);
  assert.equal(h.decoder.accept(h.event, h.reply({ requestId: 'other-request' })), false);
  assert.equal(h.decoder.accept(h.event, h.reply()), true);
  assert.equal(await result, h.image);
  assert.equal(h.decoder.pending, null);
  assert.equal(h.contents.listenerCount('destroyed'), 0);
  assert.equal(h.decoder.accept(h.event, h.reply()), false);
});

test('无效格式和错误尺寸的 WebP 回包被拒绝，后续合法图片仍可重试', async () => {
  const h = harness();
  const invalid = h.start();
  h.decoder.accept(h.event, h.reply({ bytes: new Uint8Array([1, 2, 3]) }));
  await assert.rejects(invalid);
  assert.equal(h.decoder.pending, null);
  const size = h.start();
  const wrong = Buffer.from(png);
  wrong.writeUInt32BE(100, 16);
  h.decoder.accept(h.event, h.reply({ bytes: new Uint8Array(wrong) }));
  await assert.rejects(size, /尺寸/);
  const success = h.start();
  h.decoder.accept(h.event, h.reply());
  assert.equal(await success, h.image);
});

test('WebP 同时只有一张在途，窗口销毁后立即结束等待并清理监听', async () => {
  const h = harness(), result = h.start();
  await assert.rejects(h.start(), /上一张/);
  h.contents.emit('destroyed');
  await assert.rejects(result, /已关闭/);
  assert.equal(h.decoder.pending, null);
  assert.equal(h.contents.listenerCount('destroyed'), 0);
});

test('WebP 渲染解码超时恢复可重试，超时后的旧回包不能干扰新请求', async () => {
  const h = harness(15), pending = h.start(), oldReply = h.reply();
  const keepAlive = setTimeout(() => {}, 100);
  try { await assert.rejects(pending, /超时/); } finally { clearTimeout(keepAlive); }
  assert.equal(h.decoder.pending, null);
  const next = h.start();
  assert.equal(h.decoder.accept(h.event, oldReply), false);
  h.decoder.accept(h.event, h.reply());
  assert.equal(await next, h.image);
});
