'use strict';

// 独立、可重复的全应用内存测量。只操作隔离 profile 与 mock 剪贴板。
// 不调用 global.gc、EmptyWorkingSet、SetProcessWorkingSetSize 或缓存清理。
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const options = {
  executable: path.join(root, 'release', 'v0.8.6', 'win-unpacked', '截图晾衣架.exe'),
  source: true, onlyIdle: false, onlyNotes: false, label: 'optimized', args: [], idleMs: 20000, settleMs: 8000,
  sampleCount: 3, intervalMs: 1000, largeWidth: 2560, largeHeight: 1440,
  reportDir: path.join(root, 'test-artifacts', 'v0.8.6'),
};

function parseOptions() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--source') { options.source = true; continue; }
    if (token === '--only-idle') { options.onlyIdle = true; continue; }
    if (token === '--only-notes') { options.onlyNotes = true; continue; }
    if (token === '--help') {
      console.log('用法：node scripts/memory-benchmark.cjs [--source | --exe=路径] [--label=baseline|optimized|gpu-off] [--only-idle | --only-notes] [--arg=--disable-gpu] [--large=2560x1440|3840x2160] [--idle-ms=20000] [--settle-ms=8000] [--samples=3] [--interval-ms=1000]');
      process.exit(0);
    }
    const separator = token.indexOf('=');
    const name = separator < 0 ? token : token.slice(0, separator);
    const value = separator < 0 ? args[++i] : token.slice(separator + 1);
    if (value === undefined || value === '') throw new Error(`${name} 缺少参数。`);
    if (name === '--exe') { options.executable = path.resolve(value); options.source = false; }
    else if (name === '--label') options.label = value;
    else if (name === '--arg') options.args.push(value);
    else if (name === '--idle-ms') options.idleMs = Number(value);
    else if (name === '--settle-ms') options.settleMs = Number(value);
    else if (name === '--samples') options.sampleCount = Number(value);
    else if (name === '--interval-ms') options.intervalMs = Number(value);
    else if (name === '--report-dir') options.reportDir = path.resolve(value);
    else if (name === '--large') {
      const dimensions = /^(2560x1440|3840x2160)$/.exec(value);
      if (!dimensions) throw new Error('--large 只支持 2560x1440 或 3840x2160。');
      [options.largeWidth, options.largeHeight] = value.split('x').map(Number);
    } else throw new Error(`未知参数：${name}`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,48}$/.test(options.label)) throw new Error('label 只能包含英文字母、数字、下划线与连字符。');
  if (options.onlyIdle && options.onlyNotes) throw new Error('--only-idle 和 --only-notes 不能同时使用。');
  if (!Number.isSafeInteger(options.idleMs) || options.idleMs < 20000) throw new Error('空衣架 idle 必须至少 20 秒。');
  if (!Number.isSafeInteger(options.settleMs) || options.settleMs < 1000) throw new Error('settle-ms 必须至少 1000。');
  if (!Number.isSafeInteger(options.sampleCount) || options.sampleCount < 3 || options.sampleCount > 30) throw new Error('samples 必须是 3 至 30。');
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1000) throw new Error('interval-ms 必须至少 1000。');
  if (options.args.some((arg) => !arg.startsWith('--') || /(?:data-dir|user-data-dir|rack-test|js-flags|expose-gc)/i.test(arg))) throw new Error('启动对比参数必须是 -- 开头，且不得覆盖隔离目录、测试模式或强制 GC。');
}

parseOptions();
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const profile = path.join(options.reportDir, 'memory-profiles', `${options.label}-${runId}`);
const runReportPath = path.join(options.reportDir, `memory-${options.label}-${runId}.json`);
const latestReportPath = path.join(options.reportDir, `memory-${options.label}.json`);
const logicalProcessors = os.cpus().length;
const report = {
  startedAt: new Date().toISOString(), runId, label: options.label, status: 'running',
  options, profile, runReportPath, latestReportPath,
  environment: { platform: process.platform, release: os.release(), architecture: os.arch(), logicalProcessors, totalPhysicalMemoryBytes: os.totalmem() },
  methodology: {
    primary: '所有 app.getAppMetrics() PID 的 Windows CIM WorkingSetPrivate 总和，为实际驻留的私有工作集，较接近任务管理器内存列，且不会重复计算共享页。若 CIM 不可用此主指标标为 null，不能用 privateBytes 冒充。',
    privateCommit: '所有 app.getAppMetrics() PID 的 memory.privateBytes 总和；Electron 原值为 KB，转换为字节。这是私有提交，作为补充指标，不能等同于实际驻留物理内存。',
    resident: '按相同 PID 用 Windows Get-Process WorkingSet64 与 CIM WorkingSetPrivate 核验。总 private working set 为可加的驻留私有页；总 working set 会重复计算共享页，不当作唯一物理占用。',
    scope: '包含 Electron 主进程、renderer、GPU、utility 等应用进程；不包含外部 Node/Playwright 控制器或 PowerShell 采样进程。',
    instrumentation: '使用相同 Playwright 远程调试与 mock 剪贴板进行各版本比较，应用内调试附加开销包含在测量中。固定 profile 隔离；不读取或写入真实截图与真实用户数据。',
    cpu: 'Electron percentCPUUsage 与 cumulativeCPUUsage 按 PID/type 保留；Windows CPU 时间差另算，cpuOneCorePercent 以单核 100% 为基准，cpuMachinePercent 再除以逻辑处理器数。',
    settling: `空衣架 idle ${options.idleMs} ms，其余场景至少 ${options.settleMs} ms；每场景 ${options.sampleCount} 次样本，间隔至少 ${options.intervalMs} ms，给出中位数、范围与 CPU 趋势，稳定度作为报告值而非预设。`,
    display: '启动时和每次采样记录衣架逻辑/物理窗口、显示器缩放、显示范围与工作区；分辨率、缩放或工作区变化会单独标注。只在显示条件匹配时比较版本内存，不把窗口宽度的产品改动当作外部屏幕变化。',
    memoryManipulation: '未强制 GC、未裁剪工作集、未清理缓存；关闭窗口与隐藏属于真实应用操作。',
    sources: ['https://www.electronjs.org/docs/latest/api/structures/memory-info', 'https://www.electronjs.org/docs/latest/api/app#appgetappmetrics', 'https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.privatememorysize64', 'https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-perfformatteddata-perfproc-process'],
  },
  scenarios: [], errors: [],
};
let application;
let page;
let latestArchivePrepared = false;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function saveReport() {
  await fs.mkdir(options.reportDir, { recursive: true });
  if (!latestArchivePrepared) {
    try { await fs.copyFile(latestReportPath, path.join(options.reportDir, `memory-${options.label}-previous-${runId}.json`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    latestArchivePrepared = true;
  }
  const content = `${JSON.stringify(report, null, 2)}\n`;
  await fs.writeFile(runReportPath, content);
  await fs.writeFile(latestReportPath, content);
}

function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Windows 进程采样超时')); }, 15000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Windows 采样失败 (${code})：${stderr.slice(-1000)}`));
      else {
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); }
        catch { reject(new Error(`Windows 采样 JSON 无效：${stdout.slice(0, 200)}`)); }
      }
    });
  });
}

async function windowsMetrics(pids) {
  if (process.platform !== 'win32') return { available: false, reason: '不是 Windows', processes: [] };
  assert(pids.length > 0 && pids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
  const command = `
$ErrorActionPreference = 'Stop'
$rackMeasureIds = @(${pids.join(',')})
$rackPrivateWorking = @{}
$rackCimError = $null
try {
  $rackFilter = ($rackMeasureIds | ForEach-Object { 'IDProcess=' + $_ }) -join ' OR '
  Get-CimInstance -ClassName Win32_PerfFormattedData_PerfProc_Process -Filter $rackFilter | ForEach-Object { $rackPrivateWorking[[string]$_.IDProcess] = [double]$_.WorkingSetPrivate }
} catch { $rackCimError = $_.Exception.Message }
$rackRows = @(Get-Process -Id $rackMeasureIds -ErrorAction SilentlyContinue | ForEach-Object {
  $rackEntry = $_
  $rackPrivateResident = $null
  if ($rackPrivateWorking.ContainsKey([string]$rackEntry.Id)) { $rackPrivateResident = $rackPrivateWorking[[string]$rackEntry.Id] }
  [pscustomobject]@{ pid = $rackEntry.Id; name = $rackEntry.ProcessName; workingSetBytes = [double]$rackEntry.WorkingSet64; privateBytes = [double]$rackEntry.PrivateMemorySize64; privateWorkingSetBytes = $rackPrivateResident; totalCpuMs = [double]$rackEntry.TotalProcessorTime.TotalMilliseconds }
})
[pscustomobject]@{ available = $true; timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); privateWorkingSetError = $rackCimError; processes = $rackRows } | ConvertTo-Json -Depth 5 -Compress
`;
  try { return await runPowerShell(command); }
  catch (error) { return { available: false, reason: error.message, timestamp: Date.now(), processes: [] }; }
}

function sum(rows, key) {
  const values = rows.map((row) => row[key]);
  return values.length && values.every(Number.isFinite) ? values.reduce((total, value) => total + value, 0) : null;
}

function groupTypes(rows) {
  const grouped = {};
  for (const type of new Set(rows.map((row) => row.type))) {
    const items = rows.filter((row) => row.type === type);
    grouped[type] = { processCount: items.length, pids: items.map((row) => row.pid), privateBytes: sum(items, 'privateBytes'), workingSetBytes: sum(items, 'workingSetBytes'), electronCpuPercent: sum(items, 'electronCpuPercent') };
  }
  return grouped;
}

function displayConditions(physicalWindow, workArea, displayBounds) {
  const rectangle = value => value ? { x: value.x, y: value.y, width: value.width, height: value.height } : null;
  return { scaleFactor: physicalWindow?.scaleFactor ?? null,
    displayBounds: rectangle(displayBounds), workArea: rectangle(workArea) };
}

function recordDisplayConditions(timestamp, physicalWindow, workArea, displayBounds) {
  const conditions = displayConditions(physicalWindow, workArea, displayBounds);
  if (!report.environment.displayConditionsInitial) {
    Object.assign(report.environment, { physicalWindow, workArea, displayBounds,
      displayConditionsInitial: conditions, displayConditionsLast: conditions,
      displayConditionsStable: !!(conditions.scaleFactor && conditions.displayBounds && conditions.workArea), displayChanges: [] });
    return;
  }
  if (JSON.stringify(conditions) !== JSON.stringify(report.environment.displayConditionsLast)) {
    report.environment.displayConditionsStable = false;
    report.environment.displayChanges.push({ timestamp, previous: report.environment.displayConditionsLast, current: conditions });
    report.environment.displayConditionsLast = conditions;
    console.log(`显示环境变化：${JSON.stringify(conditions)}；本次记录需按显示条件分别比较。`);
  }
}

async function collectSample(previous) {
  const electronData = await application.evaluate(({ app }) => {
    const snapshot = app.__rackTest.snapshot();
    const runtime = app.__rackTest.runtime();
    const physicalWindow = typeof app.__rackTest.physicalWindow === 'function' ? app.__rackTest.physicalWindow() : null;
    const workArea = typeof app.__rackTest.workArea === 'function' ? app.__rackTest.workArea() : null;
    return { timestamp: Date.now(), metrics: app.getAppMetrics(), runtime, physicalWindow, workArea,
      displayBounds: physicalWindow?.displayBounds || runtime.displayBounds || null,
      photos: snapshot.photos.length, notes: Array.isArray(snapshot.items) ? snapshot.items.filter(item => item.type === 'note').length : null,
      noteWindows: typeof app.__rackTest.noteRuntime === 'function' ? app.__rackTest.noteRuntime().length : null };
  });
  recordDisplayConditions(new Date(electronData.timestamp).toISOString(), electronData.physicalWindow, electronData.workArea, electronData.displayBounds);
  const processes = electronData.metrics.map((metric) => ({
    pid: metric.pid, type: metric.type, serviceName: metric.serviceName || null, name: metric.name || null,
    privateBytes: Number.isFinite(metric.memory?.privateBytes) ? metric.memory.privateBytes * 1024 : null,
    workingSetBytes: Number.isFinite(metric.memory?.workingSetSize) ? metric.memory.workingSetSize * 1024 : null,
    peakWorkingSetBytes: Number.isFinite(metric.memory?.peakWorkingSetSize) ? metric.memory.peakWorkingSetSize * 1024 : null,
    electronCpuPercent: metric.cpu?.percentCPUUsage ?? null, cumulativeCpuSeconds: metric.cpu?.cumulativeCPUUsage ?? null,
  }));
  const windows = await windowsMetrics(processes.map((item) => item.pid));
  const typesByPid = new Map(processes.map((item) => [item.pid, item.type]));
  windows.processes = windows.processes.map((item) => ({ ...item, type: typesByPid.get(item.pid) || 'unknown' }));
  const previousRows = new Map(previous?.windows?.processes?.map((item) => [item.pid, item]) || []);
  const intervalMs = previous?.windows?.timestamp ? windows.timestamp - previous.windows.timestamp : null;
  let cpuDeltaMs = 0;
  let cpuPidsMeasured = 0;
  if (intervalMs > 0 && windows.available) {
    for (const item of windows.processes) {
      const before = previousRows.get(item.pid);
      if (before && Number.isFinite(before.totalCpuMs) && item.totalCpuMs >= before.totalCpuMs) { cpuDeltaMs += item.totalCpuMs - before.totalCpuMs; cpuPidsMeasured += 1; }
    }
  }
  return {
    timestamp: new Date(electronData.timestamp).toISOString(), elapsedFromPreviousSampleMs: previous ? electronData.timestamp - Date.parse(previous.timestamp) : null,
    processes, byProcessType: groupTypes(processes),
    total: { processCount: processes.length, privateBytes: sum(processes, 'privateBytes'), workingSetBytes: sum(processes, 'workingSetBytes'), electronCpuPercent: sum(processes, 'electronCpuPercent') },
    windows: { ...windows, total: { processCount: windows.processes.length, privateBytes: sum(windows.processes, 'privateBytes'), workingSetBytes: sum(windows.processes, 'workingSetBytes'), privateWorkingSetBytes: sum(windows.processes, 'privateWorkingSetBytes'), cpuOneCorePercent: cpuPidsMeasured ? cpuDeltaMs / intervalMs * 100 : null, cpuMachinePercent: cpuPidsMeasured ? cpuDeltaMs / intervalMs * 100 / logicalProcessors : null, cpuPidsMeasured, intervalMs } },
    state: { photos: electronData.photos, notes: electronData.notes, noteWindowCount: electronData.noteWindows,
      imagePreviewCount: electronData.runtime.imagePreviews?.length ?? null,
      physicalWindow: electronData.physicalWindow, workArea: electronData.workArea, displayBounds: electronData.displayBounds,
      visible: electronData.runtime.visible, autoHidden: electronData.runtime.autoHide.collapsed, floatingCount: electronData.runtime.floating.length, nativeDragging: electronData.runtime.nativeDragging },
  };
}

function stats(values) {
  const numbers = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const median = numbers.length % 2 ? numbers[(numbers.length - 1) / 2] : (numbers[numbers.length / 2 - 1] + numbers[numbers.length / 2]) / 2;
  return { median, min: numbers[0], max: numbers.at(-1), spreadPercent: median ? (numbers.at(-1) - numbers[0]) / median * 100 : 0 };
}

function summarize(samples) {
  const byProcessType = {};
  for (const type of new Set(samples.flatMap((sample) => Object.keys(sample.byProcessType)))) {
    byProcessType[type] = {
      privateBytes: stats(samples.map((sample) => sample.byProcessType[type]?.privateBytes)),
      workingSetBytes: stats(samples.map((sample) => sample.byProcessType[type]?.workingSetBytes)),
      windowsPrivateWorkingSetBytes: stats(samples.map((sample) => sum(sample.windows.processes.filter((item) => item.type === type), 'privateWorkingSetBytes'))),
      processCounts: samples.map((sample) => sample.byProcessType[type]?.processCount || 0),
    };
  }
  return {
    primaryMetric: 'windowsPrivateWorkingSetBytes',
    privateBytes: stats(samples.map((sample) => sample.total.privateBytes)),
    privateCommitBytes: stats(samples.map((sample) => sample.total.privateBytes)),
    workingSetBytes: stats(samples.map((sample) => sample.total.workingSetBytes)),
    windowsPrivateBytes: stats(samples.map((sample) => sample.windows.total.privateBytes)),
    windowsWorkingSetBytes: stats(samples.map((sample) => sample.windows.total.workingSetBytes)),
    windowsPrivateWorkingSetBytes: stats(samples.map((sample) => sample.windows.total.privateWorkingSetBytes)),
    cpuTrend: samples.map((sample) => ({ timestamp: sample.timestamp, electronCpuPercent: sample.total.electronCpuPercent, windowsCpuOneCorePercent: sample.windows.total.cpuOneCorePercent, windowsCpuMachinePercent: sample.windows.total.cpuMachinePercent })),
    processCounts: samples.map((sample) => sample.total.processCount), byProcessType,
  };
}

async function scenario(id, label, settleMs = options.settleMs, detail = {}) {
  console.log(`场景 ${id}：${label}；静置 ${Math.round(settleMs / 1000)} 秒后采样。`);
  await sleep(settleMs);
  let previous = await collectSample();
  const samples = [];
  for (let index = 0; index < options.sampleCount; index += 1) {
    await sleep(options.intervalMs);
    const sample = await collectSample(previous);
    samples.push(sample); previous = sample;
  }
  const summary = summarize(samples);
  report.scenarios.push({ id, label, settledMs: settleMs, detail, samples, summary });
  await saveReport();
  const mib = (value) => Number.isFinite(value) ? (value / 1024 / 1024).toFixed(1) : '不可用';
  console.log(`完成 ${id}：私有工作集 ${mib(summary.windowsPrivateWorkingSetBytes?.median)} MiB；私有提交 ${mib(summary.privateBytes?.median)} MiB；总工作集 ${mib(summary.workingSetBytes?.median)} MiB；${summary.processCounts.join('/')} 个进程。`);
  return summary;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type);
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0); name.copy(result, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return result;
}
function fixture(width, height, index) {
  // 在外部控制器生成，避免 renderer Canvas/原始 RGBA 影响应用测量。
  const rowSize = width * 4 + 1;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * rowSize;
    for (let x = 0; x < width; x += 1) {
      const offset = rowOffset + 1 + x * 4;
      raw[offset] = (Math.floor(x / width * 255) + index * 17) & 255;
      raw[offset + 1] = (Math.floor(y / height * 255) + index * 23) & 255;
      raw[offset + 2] = (((Math.floor(x / 60) ^ Math.floor(y / 60)) * 15) + index * 13) & 255;
      raw[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(raw, { level: 3 })), pngChunk('IEND', Buffer.alloc(0))]);
}

async function inject(width, height, index, expectedCount) {
  const png = fixture(width, height, index);
  await application.evaluate(({ app }, dataURL) => app.__rackTest.setClipboardImage(dataURL), `data:image/png;base64,${png.toString('base64')}`);
  await application.evaluate(({ app }) => app.__rackTest.poll());
  const actual = await application.evaluate(({ app }) => app.__rackTest.snapshot().photos.length);
  assert.equal(actual, expectedCount, '隔离样例图片必须完成保存后才能测量');
}

async function waitRuntime(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const runtime = await application.evaluate(({ app }) => app.__rackTest.runtime());
    if (predicate(runtime)) return runtime;
    await sleep(50);
  }
  throw new Error('等待隔离窗口状态超时');
}

async function openFloating(id) {
  const opened = application.waitForEvent('window');
  await page.evaluate((photoId) => window.rack.showPhotoMenu(photoId), id);
  await waitRuntime((runtime) => runtime.lastPhotoMenu?.id === id);
  await application.evaluate(({ app }) => app.__rackTest.choosePhotoMenu('悬浮'));
  const floating = await opened;
  await floating.waitForFunction(() => document.querySelector('#previewImage')?.naturalWidth > 0);
  return floating;
}

async function closeImageWindow(window) {
  const closed = window.waitForEvent('close');
  await window.evaluate(() => window.rack.closePreview()).catch((error) => { if (!window.isClosed()) throw error; });
  await closed;
}

async function openNoteWindow(id = null) {
  const opened = application.waitForEvent('window');
  await page.evaluate((noteId) => noteId ? window.rack.openNote(noteId) : window.rack.addNote(), id);
  const note = await opened;
  await note.waitForFunction(() => {
    const input = document.getElementById('noteInput');
    return input && !input.disabled && typeof window.rack?.getNote === 'function';
  });
  return note;
}

async function closeNoteWindow(note) {
  const closed = note.waitForEvent('close');
  await note.locator('#noteCloseButton').click().catch((error) => { if (!note.isClosed()) throw error; });
  await closed;
}

async function runNotes() {
  const supportsNotes = await application.evaluate(({ app }) =>
    typeof app.__rackTest.noteRuntime === 'function' && typeof app.__rackTest.notes === 'function');
  assert.equal(supportsNotes, true, '--only-notes 需要 0.7.0 或更新版本的便签 API');
  const fixtures = ['便签一：内存测试0123456789', '便签二：颜色字号ABCDEF'].map((text) =>
    text.repeat(Math.ceil(50_000 / text.length)).slice(0, 50_000));
  const notes = [];
  for (const [index, text] of fixtures.entries()) {
    const note = await openNoteWindow();
    await note.locator('#noteInput').fill(text);
    await note.locator('#noteFontSize').selectOption(index === 0 ? '20' : '24');
    await note.locator('#noteCustomColor').evaluate((input, color) => {
      input.value = color; input.dispatchEvent(new Event('input', { bubbles: true }));
    }, index === 0 ? '#cfe3d5' : '#fff2b8');
    await note.waitForFunction(async (expected) => (await window.rack.getNote()).text === expected, text);
    notes.push(note);
  }
  assert.equal(await application.evaluate(({ app }) => app.__rackTest.noteRuntime().length), 2);
  assert.equal(await application.evaluate(({ app }) => app.__rackTest.notes().length), 0, '新草稿关闭前不能挂到衣架');
  await scenario('two_note_drafts', '两张各 50000 字的独立便签编辑窗', options.settleMs,
    { noteWindows: 2, charactersPerNote: 50_000, originalImages: 0 });

  for (const note of notes) await closeNoteWindow(note);
  const saved = await application.evaluate(({ app }) => app.__rackTest.notes());
  assert.equal(saved.length, 2);
  assert.equal(saved.every(note => note.text.length === 50_000), true, '完整便签不得因卡片预览截断');
  const summaries = await page.evaluate(async () => (await window.rack.getSnapshot()).items.filter(item => item.type === 'note'));
  assert.equal(summaries.every(note => note.text.length <= 700), true);
  assert.equal(await application.evaluate(({ app }) => app.__rackTest.noteRuntime().length), 0);
  await scenario('two_notes_saved', '两张长便签关闭后仅保留衣架预览', options.settleMs,
    { storedNotes: 2, charactersPerNote: 50_000, cardPreviewLimit: 700, noteWindows: 0 });

  const reopened = [];
  for (const note of saved) {
    const window = await openNoteWindow(note.id);
    assert.equal(await window.locator('#noteInput').inputValue(), note.text);
    reopened.push(window);
  }
  await scenario('two_notes_reopened', '再次同时打开两张完整长便签', options.settleMs,
    { storedNotes: 2, noteWindows: 2, charactersPerNote: 50_000 });
  for (const note of reopened) await closeNoteWindow(note);
  assert.equal(await application.evaluate(({ app }) => app.__rackTest.noteRuntime().length), 0);
  await scenario('note_windows_closed', '再次关闭全部便签编辑窗', options.settleMs,
    { storedNotes: 2, noteWindows: 0, originalImages: 0 });
}

async function run() {
  await fs.mkdir(profile, { recursive: true });
  await saveReport();
  if (!options.source) await fs.access(options.executable);
  const env = { ...process.env, RACK_TEST_MODE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = options.source ? require('electron') : options.executable;
  const args = [...(options.source ? [root] : []), '--rack-test', `--data-dir=${profile}`, ...options.args];
  application = await electron.launch({ executablePath, args, env, cwd: root, timeout: 60000 });
  page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.rack?.getSnapshot === 'function');
  report.application = await application.evaluate(({ app }) => ({
    version: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome,
    pid: process.pid, dataDir: app.getPath('userData'), testAPI: typeof app.__rackTest, nativeDragStub: true,
    clipboardPipeline: String(app.__rackTest?.setClipboardImage).includes('testClipboardBytes')
      ? 'PNG 字节 mock → Blob → 共用 createClipboardReader → NativeImage 像素哈希 → 新图才延迟编码原图及缩略图；重复图只保留摘要和尺寸，路径接近真实读取。'
      : '旧实现 mock 在 setter 中 normalizeImage 完整生成 PNG/缩略图，再交给 collector；与优化版真实读取路径不同。',
    disabledFeatures: app.commandLine.getSwitchValue('disable-features'),
    gpuFeatureStatus: app.getGPUFeatureStatus(),
  }));
  assert.equal(report.application.dataDir, profile);
  assert.equal(report.application.testAPI, 'object');
  const display = await application.evaluate(({ app }) => {
    const runtime = app.__rackTest.runtime();
    const physicalWindow = typeof app.__rackTest.physicalWindow === 'function' ? app.__rackTest.physicalWindow() : null;
    return { timestamp: new Date().toISOString(), physicalWindow,
      workArea: typeof app.__rackTest.workArea === 'function' ? app.__rackTest.workArea() : null,
      displayBounds: physicalWindow?.displayBounds || runtime.displayBounds || null };
  });
  recordDisplayConditions(display.timestamp, display.physicalWindow, display.workArea, display.displayBounds);
  assert.equal(await application.evaluate(({ app }) => app.__rackTest.snapshot().photos.length), 0);
  console.log(`开始 ${options.label}；${report.application.version}；独立目录 ${profile}`);
  console.log(`初始显示条件：${JSON.stringify(report.environment.displayConditionsInitial)}`);
  await scenario('empty_idle', '空衣架静置', options.idleMs);
  if (options.onlyIdle) { report.status = 'completed'; return; }
  if (options.onlyNotes) { await runNotes(); report.status = 'completed'; return; }

  const smallStarted = Date.now();
  for (let index = 0; index < 20; index += 1) await inject(640, 420, index, index + 1);
  await page.waitForFunction(() => [...document.querySelectorAll('.photo-card img')].some((image) => image.complete && image.naturalWidth > 0));
  await scenario('twenty_screenshots', '20 张 640×420 截图后静置', options.settleMs, { added: 20, width: 640, height: 420, injectionMs: Date.now() - smallStarted });

  const largeStarted = Date.now();
  const burst = [];
  for (let index = 0; index < 10; index += 1) {
    await inject(options.largeWidth, options.largeHeight, index + 20, index + 21);
    const peak = await application.evaluate(({ app }) => app.getAppMetrics());
    burst.push({ at: new Date().toISOString(), screenshot: index + 1, processCount: peak.length, privateBytes: peak.every((item) => Number.isFinite(item.memory?.privateBytes)) ? peak.reduce((total, item) => total + item.memory.privateBytes * 1024, 0) : null, workingSetBytes: peak.reduce((total, item) => total + item.memory.workingSetSize * 1024, 0) });
  }
  await scenario('ten_large_screenshots', '连续 10 张大图后静置（保留此前 20 张）', options.settleMs, { added: 10, totalPhotos: 30, width: options.largeWidth, height: options.largeHeight, injectionMs: Date.now() - largeStarted, burst });

  const photos = await application.evaluate(({ app }) => app.__rackTest.snapshot().photos);
  const opened = application.waitForEvent('window');
  await page.evaluate((id) => window.rack.openPreview(id), photos[0].id);
  const preview = await opened;
  await preview.waitForFunction(() => document.querySelector('#previewImage')?.naturalWidth > 0);
  await scenario('preview_open', '打开一张大图预览');
  await closeImageWindow(preview);
  await scenario('preview_closed', '关闭大图预览后静置');

  const floating = [await openFloating(photos[0].id)];
  await scenario('one_floating', '一张大图悬浮窗');
  floating.push(await openFloating(photos[1].id), await openFloating(photos[2].id));
  await waitRuntime((runtime) => runtime.floating.length === 3);
  await scenario('three_floating', '三张独立大图悬浮窗');
  for (const window of floating) await closeImageWindow(window);
  await waitRuntime((runtime) => runtime.floating.length === 0);
  await scenario('floating_closed', '关闭全部悬浮窗后静置');

  await page.evaluate(() => window.rack.setAutoHideSpeed('medium'));
  await page.evaluate(() => window.rack.setAutoHide(true));
  await application.evaluate(({ app }) => {
    const { expandedBounds } = app.__rackTest.runtime();
    const point = { x: expandedBounds.x + expandedBounds.width + 30, y: expandedBounds.y + expandedBounds.height + 30 };
    app.__rackTest.autoHideTick(point);
    app.__rackTest.autoHideTick(point, 1500);
  });
  await waitRuntime((runtime) => runtime.autoHide.collapsed);
  await scenario('auto_hidden', '晾衣架自动收起到顶部');
  await page.evaluate(() => window.rack.setAutoHide(false));
  await page.evaluate(() => window.rack.hide());
  await waitRuntime((runtime) => !runtime.visible);
  await scenario('tray_hidden', '隐藏到系统托盘');
  report.status = 'completed';
}

run().catch((error) => { report.status = 'failed'; report.errors.push({ message: error.message, stack: error.stack }); console.error(error); process.exitCode = 1; }).finally(async () => {
  if (application) await application.close().catch((error) => report.errors.push({ during: 'closing', message: error.message }));
  report.completedAt = new Date().toISOString();
  await saveReport();
  console.log(`内存报告：${runReportPath}`);
  console.log(`本标签最新记录：${latestReportPath}`);
});
