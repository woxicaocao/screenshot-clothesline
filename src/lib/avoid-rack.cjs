'use strict';

const clamp = (value, low, high) => Math.max(low, Math.min(value, high));

function fitSavedBounds(saved, workArea) {
  const width = Math.max(1, Math.min(Math.round(saved.width), workArea.width - 24));
  const height = Math.max(1, Math.min(Math.round(saved.height), workArea.height - 24));
  return { x: Math.round(clamp(saved.x, workArea.x, workArea.x + workArea.width - width)),
    y: Math.round(clamp(saved.y, workArea.y, workArea.y + workArea.height - height)), width, height };
}

// Electron 的 bounds/workArea 本身就是逻辑像素；这里不再次乘显示缩放系数。
function placeAvoidingRack({ rack, workArea, width = 380, height = 430, gap = 16, cascade = 0,
  minWidth = 240, minHeight = 220 }) {
  const area = { x: Math.round(workArea.x), y: Math.round(workArea.y),
    width: Math.max(1, Math.round(workArea.width)), height: Math.max(1, Math.round(workArea.height)) };
  const right = area.x + area.width, bottom = area.y + area.height;
  const rackRight = rack.x + rack.width, rackBottom = rack.y + rack.height;
  const offset = Math.max(0, Math.trunc(cascade)) % 8;
  const below = clamp(rackBottom + gap, area.y, bottom);
  const above = clamp(rack.y - gap, area.y, bottom);
  const after = clamp(rackRight + gap, area.x, right);
  const before = clamp(rack.x - gap, area.x, right);
  let regions = [
    { side: 'below', x: area.x, y: below, width: area.width, height: bottom - below },
    { side: 'above', x: area.x, y: area.y, width: area.width, height: above - area.y },
    { side: 'right', x: after, y: area.y, width: right - after, height: area.height },
    { side: 'left', x: area.x, y: area.y, width: before - area.x, height: area.height },
  ].filter(region => region.width > 0 && region.height > 0);
  // 衣架可能在另一块屏幕；这种情况下整个工作区都可用。
  if (rackRight + gap <= area.x || rack.x - gap >= right || rackBottom + gap <= area.y || rack.y - gap >= bottom) {
    regions = [{ side: 'below', ...area }];
  }
  if (!regions.length) {
    // 工作区被衣架完全占满时不存在可避让的矩形，明确报错比覆盖衣架更安全。
    throw new Error('当前屏幕没有可放置窗口的空间，请先移动衣架。');
  }
  let region = regions.find(candidate => candidate.width >= width && candidate.height >= height);
  if (!region) {
    const usable = regions.filter(candidate => candidate.width >= Math.min(width, minWidth)
      && candidate.height >= Math.min(height, minHeight));
    // 同等可用面积按下、上、右、左的顺序选择；极小屏幕也保持窗口完全避开衣架。
    region = (usable.length ? usable : regions).reduce((best, candidate) => {
      const score = value => Math.min(width, value.width) / width * (Math.min(height, value.height) / height);
      return score(candidate) > score(best) ? candidate : best;
    });
  }
  let fittedWidth = Math.min(width, region.width), fittedHeight = Math.min(height, region.height);
  // 窄屏里整块空位都被首张便签用满时，后续便签稍缩一点以露出彼此标题栏。
  if (offset && region.width <= width && region.height <= height) {
    const horizontalRoom = Math.max(0, fittedWidth - minWidth);
    if (horizontalRoom) fittedWidth -= Math.min(offset * 24, horizontalRoom);
    else fittedHeight -= Math.min(offset * 20, Math.max(0, fittedHeight - minHeight));
  }
  let x = rack.x + (rack.width - fittedWidth) / 2 + offset * 24;
  let y = region.side === 'below' ? rackBottom + gap + offset * 20
    : region.side === 'above' ? rack.y - gap - fittedHeight - offset * 20
      : rack.y + offset * 20;
  if (region.side === 'right') x = rackRight + gap + offset * 24;
  if (region.side === 'left') x = rack.x - gap - fittedWidth - offset * 24;
  return { x: Math.round(clamp(x, region.x, region.x + region.width - fittedWidth)),
    y: Math.round(clamp(y, region.y, region.y + region.height - fittedHeight)),
    width: Math.round(fittedWidth), height: Math.round(fittedHeight) };
}

module.exports = { placeAvoidingRack, fitSavedBounds };
