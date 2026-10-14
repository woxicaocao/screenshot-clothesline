'use strict';

const BORDER_DIP = 1;
const MIN_WIDTH_DIP = 64;
const MIN_HEIGHT_DIP = 48;
const MAX_SCALE = 16;
const MAX_DRAWN_PIXELS = 16_000_000;
const MAX_DRAWN_EDGE = 8192;
const FRAME_EDGES = Object.freeze(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

function dimensionsFor(photo) {
  if (!photo || !Number.isSafeInteger(photo.width) || photo.width <= 0 || !Number.isSafeInteger(photo.height) || photo.height <= 0) {
    throw new TypeError('原图尺寸必须是有效的正整数。');
  }
  return { width: photo.width, height: photo.height };
}

function displayFactor(display) {
  return Number.isFinite(display?.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1;
}

function geometryForScale(photo, scale) {
  const size = dimensionsFor(photo);
  if (!Number.isFinite(scale) || scale < 0) throw new TypeError('图片缩放比例无效。');
  const imageWidth = size.width * scale, imageHeight = size.height * scale;
  const width = Math.max(MIN_WIDTH_DIP, Math.ceil(imageWidth) + BORDER_DIP * 2);
  const height = Math.max(MIN_HEIGHT_DIP, Math.ceil(imageHeight) + BORDER_DIP * 2);
  return { width, height, image: { x: (width - imageWidth) / 2, y: (height - imageHeight) / 2, width: imageWidth, height: imageHeight } };
}

function drawnSize(geometry, display) {
  const factor = displayFactor(display);
  const width = Math.ceil(geometry.width * factor), height = Math.ceil(geometry.height * factor);
  return { width, height, area: width * height };
}

function scaleLimitForDisplay(photo, display, nativeExtra = {}) {
  dimensionsFor(photo);
  const extraWidth = Math.max(0, Math.ceil(nativeExtra.width || 0));
  const extraHeight = Math.max(0, Math.ceil(nativeExtra.height || 0));
  const withinLimits = scale => {
    const geometry = geometryForScale(photo, scale);
    const pixels = drawnSize({ width: geometry.width + extraWidth, height: geometry.height + extraHeight }, display);
    return pixels.width <= MAX_DRAWN_EDGE && pixels.height <= MAX_DRAWN_EDGE && pixels.area <= MAX_DRAWN_PIXELS;
  };
  if (!withinLimits(0)) throw new Error('当前显示缩放过大，无法在绘制上限内显示图片窗口。');
  if (withinLimits(MAX_SCALE)) return MAX_SCALE;
  let lower = 0, upper = MAX_SCALE;
  for (let index = 0; index < 64; index += 1) {
    const middle = (lower + upper) / 2;
    if (withinLimits(middle)) lower = middle;
    else upper = middle;
  }
  if (!(lower > 0)) throw new Error('无法确定安全的图片缩放比例。');
  return lower;
}

function minScaleForDisplay(photo, display, limit = scaleLimitForDisplay(photo, display)) {
  const size = dimensionsFor(photo);
  return Math.min(1, (MIN_WIDTH_DIP - BORDER_DIP * 2) / size.width, (MIN_HEIGHT_DIP - BORDER_DIP * 2) / size.height, limit);
}

function frameSizeForDisplay(width, height, display, { horizontalOnly = false, verticalOnly = false, extraWidth = 0, extraHeight = 0 } = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new TypeError('图片窗口尺寸无效。');
  const factor = displayFactor(display), maximum = Math.floor(MAX_DRAWN_EDGE / factor);
  const valid = (candidateWidth, candidateHeight) => {
    const pixels = drawnSize({ width: candidateWidth + extraWidth, height: candidateHeight + extraHeight }, display);
    return pixels.width <= MAX_DRAWN_EDGE && pixels.height <= MAX_DRAWN_EDGE && pixels.area <= MAX_DRAWN_PIXELS;
  };
  if (!valid(MIN_WIDTH_DIP, MIN_HEIGHT_DIP)) throw new Error('当前显示缩放过大，无法在绘制上限内显示图片窗口。');
  width = Math.min(maximum, Math.max(MIN_WIDTH_DIP, Math.round(width)));
  height = Math.min(maximum, Math.max(MIN_HEIGHT_DIP, Math.round(height)));
  if (!valid(width, height)) {
    if (horizontalOnly && valid(MIN_WIDTH_DIP, height)) {
      let lower = MIN_WIDTH_DIP, upper = width;
      while (lower < upper) { const middle = Math.ceil((lower + upper) / 2); if (valid(middle, height)) lower = middle; else upper = middle - 1; }
      width = lower;
    } else if (verticalOnly && valid(width, MIN_HEIGHT_DIP)) {
      let lower = MIN_HEIGHT_DIP, upper = height;
      while (lower < upper) { const middle = Math.ceil((lower + upper) / 2); if (valid(width, middle)) lower = middle; else upper = middle - 1; }
      height = lower;
    } else {
      let lower = 0, upper = 1;
      for (let index = 0; index < 64; index += 1) {
        const middle = (lower + upper) / 2;
        if (valid(Math.max(MIN_WIDTH_DIP, Math.floor(width * middle)), Math.max(MIN_HEIGHT_DIP, Math.floor(height * middle)))) lower = middle;
        else upper = middle;
      }
      width = Math.max(MIN_WIDTH_DIP, Math.floor(width * lower));
      height = Math.max(MIN_HEIGHT_DIP, Math.floor(height * lower));
    }
  }
  return { width, height };
}

function frameBoundsFromPoint(bounds, origin, point, edge, display) {
  if (!FRAME_EDGES.includes(edge)) throw new TypeError('图片窗口边框方向无效。');
  if (![bounds.x, bounds.y, bounds.width, bounds.height, origin.x, origin.y, point.x, point.y].every(Number.isFinite)) throw new TypeError('图片窗口调整坐标无效。');
  const horizontal = edge.includes('e') || edge.includes('w'), vertical = edge.includes('n') || edge.includes('s');
  const width = bounds.width + (edge.includes('w') ? origin.x - point.x : edge.includes('e') ? point.x - origin.x : 0);
  const height = bounds.height + (edge.includes('n') ? origin.y - point.y : edge.includes('s') ? point.y - origin.y : 0);
  const size = frameSizeForDisplay(width, height, display, { horizontalOnly: horizontal && !vertical, verticalOnly: vertical && !horizontal });
  return { x: Math.round(edge.includes('w') ? bounds.x + bounds.width - size.width : bounds.x),
    y: Math.round(edge.includes('n') ? bounds.y + bounds.height - size.height : bounds.y), ...size };
}

function workAreaFor(display) {
  const area = display?.workArea || display?.bounds;
  if (!area || !Number.isFinite(area.x) || !Number.isFinite(area.y) || !Number.isFinite(area.width) || area.width <= 0 || !Number.isFinite(area.height) || area.height <= 0) {
    throw new TypeError('显示器工作区域无效。');
  }
  return area;
}

function fitScaleForDisplay(photo, display) {
  const size = dimensionsFor(photo), area = workAreaFor(display);
  if (area.width < MIN_WIDTH_DIP || area.height < MIN_HEIGHT_DIP) throw new Error('当前屏幕工作区小于图片窗口最小尺寸。');
  return Math.min(1, (area.width - BORDER_DIP * 2) / size.width, (area.height - BORDER_DIP * 2) / size.height, scaleLimitForDisplay(photo, display));
}

function visibleAreaFor(bounds, area) {
  const left = Math.max(bounds.x, area.x), top = Math.max(bounds.y, area.y);
  const right = Math.min(bounds.x + bounds.width, area.x + area.width), bottom = Math.min(bounds.y + bounds.height, area.y + area.height);
  return { x: Math.max(0, left - bounds.x), y: Math.max(0, top - bounds.y), width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

module.exports = { BORDER_DIP, MIN_WIDTH_DIP, MIN_HEIGHT_DIP, MAX_SCALE, MAX_DRAWN_PIXELS, MAX_DRAWN_EDGE, FRAME_EDGES,
  dimensionsFor, displayFactor, geometryForScale, drawnSize, scaleLimitForDisplay, minScaleForDisplay, frameSizeForDisplay, frameBoundsFromPoint,
  workAreaFor, fitScaleForDisplay, visibleAreaFor };
