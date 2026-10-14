'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { BrowserBridge, loadConnectionToken } = require('../src/lib/browser-bridge.cjs');
const { inspectEncodedImage } = require('../src/lib/image-format.cjs');
const token = 'a'.repeat(64);
const origin = `chrome-extension://${'b'.repeat(32)}`;
async function bridge(t, options = {}) {
  const server = new BrowserBridge({ token, port: 0, importImage: async () => ({ added: true, photo: { id: 'c'.repeat(64), width: 2, height: 3 } }), getStatus: () => ({ version: 'test', paused: true, photoCount: 0 }), ...options });
  await server.start(); t.after(() => server.close());
  return { server, url: `http://127.0.0.1:${server.port}` };
}
function request(url, route, options = {}) {
  return fetch(url + route, { headers: { 'X-Rack-Token': token, Origin: origin, ...options.headers }, ...options, body: options.body });
}
test('本地服务只绑定回环，持久连接码可重启复用，损坏文件保留', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rack-bridge-test-'));
  const first = await loadConnectionToken(directory);
  assert.equal(await loadConnectionToken(directory), first); assert.match(first, /^[a-f0-9]{64}$/);
  const { server } = await bridge(t);
  assert.equal(server.server.address().address, '127.0.0.1'); assert.equal(server.getCode(), `RACK1-${server.port}-${token}`);
  await fs.writeFile(path.join(directory, 'browser-connection.json'), '{broken');
  await assert.rejects(loadConnectionToken(directory)); assert.equal(await fs.readFile(path.join(directory, 'browser-connection.json'), 'utf8'), '{broken');
});
test('正确token及Chrome/Edge扩展origin可获取状态，错误token/网页origin/Host被拒绝', async t => {
  const { url } = await bridge(t);
  const ok = await request(url, '/v1/status'); assert.equal(ok.status, 200); assert.equal(ok.headers.get('access-control-allow-origin'), origin);
  assert.equal((await ok.json()).paused, true);
  assert.equal((await request(url, '/v1/status', { headers: { Origin: origin, 'X-Rack-Token': 'd'.repeat(64) } })).status, 401);
  assert.equal((await request(url, '/v1/status', { headers: { Origin: 'https://example.com', 'X-Rack-Token': token } })).status, 403);
  assert.equal((await request(url, '/v1/status', { headers: { Origin: 'null', 'X-Rack-Token': token } })).status, 403);
  await new Promise((resolve, reject) => { const r = http.get(url + '/v1/status', { headers: { Host: 'example.com', 'X-Rack-Token': token } }, response => { assert.equal(response.statusCode, 403); response.resume(); response.on('end', resolve); }); r.on('error', reject); });
});
test('仅允许扩展来源的有限CORS预检，实际POST仍验证token，格式和大小错误不入库', async t => {
  let calls = 0;
  const { url } = await bridge(t, { maxBytes: 8, importImage: async () => { calls++; return { added: true, photo: { id: 'x' } }; } });
  const preflight = await fetch(url + '/v1/images', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-rack-token,content-type' } });
  assert.equal(preflight.status, 204);
  const post = (body, mime, auth = token) => fetch(url + '/v1/images', { method: 'POST', headers: { Origin: origin, 'X-Rack-Token': auth, 'Content-Type': mime }, body });
  assert.equal((await post('123', 'image/png', 'e'.repeat(64))).status, 401);
  assert.equal((await post('123', 'text/html')).status, 415);
  assert.equal((await post('123456789', 'image/png')).status, 413);
  assert.equal((await post('', 'image/png')).status, 400);
  assert.equal(calls, 0);
  assert.equal((await post('123', 'image/png')).status, 200); assert.equal(calls, 1);
});
test('并行导入明确返回稍后重试，保存失败不假报成功，后续还能正常导入', async t => {
  let finish; let entered;
  const start = new Promise(resolve => { entered = resolve; });
  const { url } = await bridge(t, { importImage: async () => { entered(); return new Promise(resolve => { finish = resolve; }); } });
  const post = () => fetch(url + '/v1/images', { method: 'POST', headers: { 'X-Rack-Token': token, 'Content-Type': 'image/png' }, body: 'png' });
  const first = post(); await start;
  assert.equal((await post()).status, 429);
  finish({ added: false, photo: { id: 'same' } }); assert.equal((await first).status, 200);
  assert.equal((await (await first).json()).added, false);
  const bad = await bridge(t, { importImage: async () => { throw new Error('disk error'); } });
  const failed = await fetch(bad.url + '/v1/images', { method: 'POST', headers: { 'X-Rack-Token': token, 'Content-Type': 'image/png' }, body: 'png' });
  assert.equal(failed.status, 500); assert.equal((await failed.json()).ok, false); assert.equal(bad.server.busy, false);
});
function png(width, height) { const b = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(b); b.writeUInt32BE(13,8); b.write('IHDR',12); b.writeUInt32BE(width,16); b.writeUInt32BE(height,20); return b; }
test('解码前识别PNG/JPEG/WebP尺寸，拒绝超大、类型伪装和截断数据', () => {
  assert.deepEqual(inspectEncodedImage(png(640,420),'image/png'), { width: 640, height: 420, extension: 'png', mime: 'image/png' });
  const jpg = Buffer.from([255,216,255,192,0,8,8,0,100,0,200,1,255,217]);
  assert.equal(inspectEncodedImage(jpg,'image/jpeg').width, 200);
  const webp = Buffer.alloc(30); webp.write('RIFF',0); webp.writeUInt32LE(22,4); webp.write('WEBPVP8X',8); webp.writeUInt32LE(10,16); webp.writeUIntLE(639,24,3); webp.writeUIntLE(419,27,3);
  assert.equal(inspectEncodedImage(webp,'image/webp').height,420);
  webp[20] = 2;
  assert.equal(inspectEncodedImage(webp,'image/webp').animated, true);
  const animationControl = Buffer.alloc(20);
  animationControl.writeUInt32BE(8, 0); animationControl.write('acTL', 4); animationControl.writeUInt32BE(2, 8);
  const animatedPng = Buffer.concat([png(640,420), animationControl]);
  assert.equal(inspectEncodedImage(animatedPng,'image/png').animated, true);
  animationControl.writeUInt32BE(1, 8);
  assert.equal(inspectEncodedImage(Buffer.concat([png(640,420), animationControl]),'image/png').animated, true);
  animationControl.writeUInt32BE(0, 8);
  assert.equal(inspectEncodedImage(Buffer.concat([png(640,420), animationControl]),'image/png').animated, undefined);
  assert.throws(() => inspectEncodedImage(png(10000,10000),'image/png'), /像素/);
  assert.throws(() => inspectEncodedImage(png(10,10),'image/jpeg'), /格式/);
  assert.throws(() => inspectEncodedImage(jpg.subarray(0,8),'image/jpeg'), /格式/);
  assert.throws(() => inspectEncodedImage(Buffer.from('<html>'),'image/png'), /格式/);
});
