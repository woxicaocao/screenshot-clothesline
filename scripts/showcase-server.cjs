'use strict';

// 仅用于本地详情预览，绑定回环地址；不参与桌面程序运行。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const port = Number(process.env.SHOWCASE_PORT || 4176);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.zip': 'application/zip' };

http.createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); return res.end(); }
  if (urlPath === '/') urlPath = '/docs/showcase/index.html';
  const allowed = /^\/(docs\/(showcase|media)\/|src\/assets\/)/.test(urlPath)
    || /^\/release\/v0\.8\.6\/screenshot-clothesline-0\.8\.6-win-x64\.zip$/.test(urlPath);
  const file = path.resolve(root, '.' + urlPath);
  const relative = path.relative(root, file);
  if (!allowed || relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(404); return res.end(); }
  fs.stat(file, (error, info) => {
    if (error || !info.isFile()) { res.writeHead(404); return res.end(); }
    const headers = { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
    let start = 0, end = info.size - 1, status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
      if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (start < 0 || start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}).listen(port, '127.0.0.1', () => console.log(`本地视觉预览：http://127.0.0.1:${port}/`));
