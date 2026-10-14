'use strict';

// 从用户指定的定稿生成 GitHub 播放副本；原视频只读取，不覆盖。
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const media = path.join(root, 'docs', 'media');
const cache = path.join(root, 'build-cache', 'github-showcase');
const bin = process.env.SHOWCASE_FFMPEG_BIN || 'G:\\codex测试\\tools\\jianying-ai-mcp-media\\ffmpeg-9.0.2-essentials_build\\bin';
const original = path.join(root, 'release', 'v0.8.6', '截图晾衣架功能演示_0.8.6OK.mp4');
const preview = path.join(media, 'demo-preview.mp4');

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', errors = '';
    child.stdout.on('data', data => { out += data; });
    child.stderr.on('data', data => { errors += data; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(out) : reject(new Error(`${path.basename(executable)}: ${code}\n${errors.slice(-5000)}`)));
  });
}

async function hash(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function probe(file) {
  return JSON.parse(await run(path.join(bin, 'ffprobe.exe'), ['-v', 'error', '-show_entries',
    'format=duration,size:stream=codec_name,width,height,r_frame_rate,duration', '-of', 'json', file]));
}

async function main() {
  await fs.mkdir(media, { recursive: true });
  await fs.mkdir(cache, { recursive: true });
  const sourceHash = await hash(original);
  const source = await probe(original);
  const passLog = path.join(cache, 'demo-preview-pass');
  const common = ['-hide_banner', '-loglevel', 'warning', '-y', '-i', original, '-map', '0:v:0',
    '-c:v', 'libx264', '-preset', 'medium', '-b:v', '1360k', '-pix_fmt', 'yuv420p',
    '-passlogfile', passLog, '-map_metadata', '-1'];
  console.log('生成视频播放副本：第一遍编码');
  await run(path.join(bin, 'ffmpeg.exe'), [...common, '-pass', '1', '-an', '-f', 'null', 'NUL']);
  console.log('生成视频播放副本：第二遍编码');
  await run(path.join(bin, 'ffmpeg.exe'), [...common, '-map', '0:a:0', '-pass', '2', '-c:a', 'aac',
    '-b:a', '96k', '-movflags', '+faststart', preview]);
  const result = await probe(preview);
  const video = result.streams.find(stream => stream.codec_name === 'h264');
  if (+result.format.size >= 9500000 || !video || video.width !== 1920 || video.height !== 1080)
    throw new Error(`播放副本未满足尺寸/体积要求：${JSON.stringify(result)}`);
  if (Math.abs(+source.format.duration - +result.format.duration) > 0.1)
    throw new Error('播放副本时长与原片不一致');
  if (await hash(original) !== sourceHash) throw new Error('原视频校验发生变化');
  const report = { created: new Date().toISOString(), original: { file: path.basename(original), sha256: sourceHash, ...source },
    preview: { file: 'docs/media/demo-preview.mp4', sha256: await hash(preview), ...result },
    editing: '仅重编码，未剪切、替换镜头或修改配音；原文件完整保留' };
  await fs.writeFile(path.join(cache, 'video-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
