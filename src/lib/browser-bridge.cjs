'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_WEBP_PACKET_BYTES = MAX_IMAGE_BYTES * 2 + 8;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
class BridgeError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

async function loadConnectionToken(dataDir) {
  const destination = path.join(dataDir, 'browser-connection.json');
  try {
    const saved = JSON.parse(await fs.readFile(destination, 'utf8'));
    if (saved.version !== 1 || !/^[a-f0-9]{64}$/.test(saved.token)) throw new Error('浏览器连接设置无效，原文件已保留。');
    return saved.token;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const token = randomBytes(32).toString('hex');
  try { await fs.writeFile(destination, JSON.stringify({ version: 1, token }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') return loadConnectionToken(dataDir); throw error; }
  return token;
}

class BrowserBridge {
  constructor({ token, importImage, getStatus, port = 17867, maxBytes = MAX_IMAGE_BYTES }) {
    if (!/^[a-f0-9]{64}$/.test(token) || typeof importImage !== 'function' || typeof getStatus !== 'function') throw new TypeError('浏览器连接参数无效。');
    this.token = token; this.importImage = importImage; this.getStatus = getStatus;
    this.port = port; this.maxBytes = maxBytes; this.busy = false; this.server = null;
  }
  getCode() { return this.server?.listening ? `RACK1-${this.port}-${this.token}` : null; }
  async start() {
    if (this.server?.listening) return;
    const server = http.createServer({ maxHeaderSize: 8192 }, (request, response) => {
      this.handle(request, response).catch(error => this.reply(response, error.status || 500, { ok: false, message: error.status ? error.message : '图片暂时未能保存，请稍后重试。' }));
    });
    server.headersTimeout = 5000; server.requestTimeout = 20000; server.keepAliveTimeout = 1000; server.maxConnections = 8;
    server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
    const listen = port => new Promise((resolve, reject) => {
      const failed = error => { server.off('listening', ready); reject(error); };
      const ready = () => { server.off('error', failed); resolve(); };
      server.once('error', failed); server.once('listening', ready); server.listen(port, '127.0.0.1');
    });
    try { await listen(this.port); }
    catch (error) { if (error.code !== 'EADDRINUSE') throw error; await listen(0); }
    server.on('error', error => console.error('[浏览器本地连接]', error.message));
    this.server = server; this.port = server.address().port;
  }
  reply(response, status, value) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Connection': 'close' });
    response.end(JSON.stringify(value));
  }
  async handle(request, response) {
    if (request.headers.host !== `127.0.0.1:${this.port}`) throw new BridgeError('本地连接地址无效。', 403);
    const origin = request.headers.origin;
    if (origin && !EXTENSION_ORIGIN.test(origin)) throw new BridgeError('此请求来源不允许连接。', 403);
    if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
    if (!['/v1/status', '/v1/images'].includes(request.url)) throw new BridgeError('连接地址无效。', 404);
    if (request.method === 'OPTIONS') {
      if (!origin || !['GET', 'POST'].includes(request.headers['access-control-request-method'])) throw new BridgeError('连接预检无效。', 403);
      const requestedHeaders = (request.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if (requestedHeaders.some(value => !['x-rack-token', 'content-type'].includes(value))) throw new BridgeError('连接预检无效。', 403);
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'X-Rack-Token, Content-Type', 'Access-Control-Max-Age': '600' });
      response.end(); return;
    }
    const token = request.headers['x-rack-token'];
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(this.token, 'hex'))) throw new BridgeError('连接码不匹配，请重新连接晾衣架。', 401);
    if (request.url === '/v1/status' && request.method === 'GET') { this.reply(response, 200, { ok: true, ...this.getStatus() }); return; }
    if (request.url !== '/v1/images' || request.method !== 'POST') throw new BridgeError('请求方法不支持。', 405);
    if (this.busy) throw new BridgeError('已有图片正在添加，请稍后再试。', 429);
    const type = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/webp', 'application/x-rack-webp', 'application/x-rack-jpeg'].includes(type)) throw new BridgeError('请添加 PNG、JPEG 或 WebP 图片。', 415);
    const limit = type.startsWith('application/x-rack-') ? Math.min(this.maxBytes * 2 + 8, MAX_WEBP_PACKET_BYTES) : this.maxBytes;
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) throw new BridgeError('图片超过大小限制，暂时无法添加。', 413);
    this.busy = true;
    try {
      const bytes = await new Promise((resolve, reject) => {
        const chunks = []; let total = 0; let finished = false;
        const fail = error => { if (finished) return; finished = true; reject(error); };
        request.setTimeout(15000, () => { fail(new BridgeError('图片传输超时，请重试。', 408)); request.destroy(); });
        request.on('data', chunk => {
          if (finished) return;
          total += chunk.length;
          if (total > limit) { chunks.length = 0; fail(new BridgeError('图片超过大小限制，暂时无法添加。', 413)); return; }
          chunks.push(chunk);
        });
        request.on('end', () => { if (finished) return; finished = true; resolve(Buffer.concat(chunks, total)); });
        request.on('error', () => fail(new BridgeError('图片传输中断，请重试。', 400)));
        request.on('aborted', () => fail(new BridgeError('图片传输中断，请重试。', 400)));
      });
      if (!bytes.length) throw new BridgeError('没有收到图片数据。', 400);
      const result = await this.importImage(bytes, type);
      if (!result || typeof result.added !== 'boolean' || typeof result.photo?.id !== 'string') throw new BridgeError('晾衣架暂时无法接收图片，请稍后重试。', 503);
      this.reply(response, 200, { ok: true, ...result });
    } finally { this.busy = false; }
  }
  async close() {
    const server = this.server; this.server = null;
    if (!server) return;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

module.exports = { BrowserBridge, BridgeError, MAX_IMAGE_BYTES, loadConnectionToken };
