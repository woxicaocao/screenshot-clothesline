'use strict';

const SCREEN_WIDTH_FRACTION = 0.4;
const TARGET_HEIGHT_DIP = 260;
const SCREEN_MARGIN_DIP = 24;

function rackSizeForDisplay(display) {
  const { width, height } = display?.workArea ?? {};
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new TypeError('显示器工作区域的宽度和高度必须是有效的正数');
  }
  const screenWidth = display?.bounds?.width;
  const referenceWidth = Number.isFinite(screenWidth) && screenWidth > 0 ? screenWidth : width;
  return {
    // 屏幕和窗口均使用 DIP；原三分之一宽度增加 20%，在不同分辨率与系统缩放下保持 40%。
    width: Math.max(1, Math.floor(Math.min(referenceWidth * SCREEN_WIDTH_FRACTION, width - SCREEN_MARGIN_DIP))),
    height: Math.max(1, Math.floor(Math.min(TARGET_HEIGHT_DIP, height))),
  };
}

module.exports = { SCREEN_WIDTH_FRACTION, rackSizeForDisplay };
