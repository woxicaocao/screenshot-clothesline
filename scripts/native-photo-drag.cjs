'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

// 仅隔离桌面验收使用。点击前验证目标原生窗口，finally 松键并恢复鼠标位置。
async function nativePhotoDrag({ handle, start, delta, steps = 12, afterRelease }) {
  if (process.platform !== 'win32') throw new Error('原生鼠标验收仅支持 Windows');
  if (!/^\d+$/.test(String(handle))) throw new TypeError('测试窗口句柄无效');
  const values = [start?.x, start?.y, delta?.x, delta?.y];
  if (!values.every(value => Number.isFinite(value) && Math.abs(value) < 100000)) throw new TypeError('测试鼠标坐标无效');
  if (!Number.isInteger(steps) || steps < 2 || steps > 30) throw new TypeError('测试鼠标步数无效');
  const [x, y, dx, dy] = values.map(Math.round);
  const source = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RackPhotoInput083 {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder text, int length);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@
[RackPhotoInput083]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$savedPoint=New-Object RackPhotoInput083+Point
if (-not [RackPhotoInput083]::GetCursorPos([ref]$savedPoint)) { throw '无法读取真实鼠标位置' }
$targetHandle=[IntPtr]::new([Int64]${handle})
$pressed=$false
$completed=$false
try {
  [RackPhotoInput083]::SetForegroundWindow($targetHandle) | Out-Null
  if (-not [RackPhotoInput083]::SetCursorPos(${x},${y})) { throw '无法移动真实鼠标' }
  Start-Sleep -Milliseconds 120
  $point=New-Object RackPhotoInput083+Point
  if (-not [RackPhotoInput083]::GetCursorPos([ref]$point)) { throw '无法确认真实鼠标位置' }
  $actualHandle=[RackPhotoInput083]::GetAncestor([RackPhotoInput083]::WindowFromPoint($point),2)
  if ($actualHandle -ne $targetHandle -or [Math]::Abs($point.X-${x}) -gt 1 -or [Math]::Abs($point.Y-${y}) -gt 1) {
    $rect=New-Object RackPhotoInput083+Rect
    [RackPhotoInput083]::GetWindowRect($targetHandle,[ref]$rect) | Out-Null
    $className=New-Object System.Text.StringBuilder 128
    [RackPhotoInput083]::GetClassName($actualHandle,$className,128) | Out-Null
    @{ targetHandle='${handle}'; actualHandle=$actualHandle.ToInt64(); actualClass=$className.ToString();
       requested=@{x=${x};y=${y}}; actual=@{x=$point.X;y=$point.Y};
       targetRect=@{left=$rect.Left;top=$rect.Top;right=$rect.Right;bottom=$rect.Bottom} } | ConvertTo-Json -Compress
    throw '测试点不在目标图片窗口上，已取消鼠标按下'
  }
  [RackPhotoInput083]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  $pressed=$true
  Start-Sleep -Milliseconds 100
  for ($step=1; $step -le ${steps}; $step++) {
    $moveX=${x}+[int][Math]::Round(${dx}*$step/${steps})
    $moveY=${y}+[int][Math]::Round(${dy}*$step/${steps})
    if (-not [RackPhotoInput083]::SetCursorPos($moveX,$moveY)) { throw '真实鼠标移动中断' }
    Start-Sleep -Milliseconds 24
  }
  [RackPhotoInput083]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  $pressed=$false
  Start-Sleep -Milliseconds 100
  @{ nativeInput=$true; guardedWindow='${handle}'; delta=@{x=${dx};y=${dy}};
     originalCursor=@{x=$savedPoint.X;y=$savedPoint.Y} } | ConvertTo-Json -Compress
  $completed=$true
} finally {
  if ($pressed) { [RackPhotoInput083]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
  if (-not $completed) { [RackPhotoInput083]::SetCursorPos($savedPoint.X,$savedPoint.Y) | Out-Null }
}
`;
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout.trim());
    try {
      if (afterRelease) await afterRelease();
      return result;
    } finally { await nativeCursor([result.originalCursor]); }
  } catch (error) {
    throw new Error(`原生鼠标验收未完成：${error.stdout?.trim() || ''} ${error.stderr?.trim().slice(0, 500) || error.code}`);
  }
}

async function nativeCursor(points = []) {
  if (process.platform !== 'win32') throw new Error('真实鼠标验收仅支持 Windows');
  if (!Array.isArray(points) || points.length > 3 || points.some(point => !point || ![point.x, point.y].every(value => Number.isFinite(value) && Math.abs(value) < 100000))) throw new TypeError('测试鼠标坐标无效');
  const moves = points.map(point => `if (-not [RackPhotoCursor083]::SetCursorPos(${Math.round(point.x)},${Math.round(point.y)})) { throw '无法移动真实鼠标' }; Start-Sleep -Milliseconds 70`).join('\n');
  const source = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RackPhotoCursor083 {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
[RackPhotoCursor083]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$before=New-Object RackPhotoCursor083+Point
[RackPhotoCursor083]::GetCursorPos([ref]$before) | Out-Null
${moves}
$after=New-Object RackPhotoCursor083+Point
[RackPhotoCursor083]::GetCursorPos([ref]$after) | Out-Null
@{ original=@{x=$before.X;y=$before.Y}; actual=@{x=$after.X;y=$after.Y} } | ConvertTo-Json -Compress
`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source],
    { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.trim());
}

module.exports = { nativePhotoDrag, nativeCursor };
