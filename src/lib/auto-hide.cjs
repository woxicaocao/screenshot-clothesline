'use strict';

function isPoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function isRect(rect) {
  return isPoint(rect) && Number.isFinite(rect.width) && rect.width > 0 &&
    Number.isFinite(rect.height) && rect.height > 0;
}

function contains(rect, point) {
  return point.x >= rect.x && point.x < rect.x + rect.width &&
    point.y >= rect.y && point.y < rect.y + rect.height;
}

// 只维护交互状态；原生窗口移动、显示和轮询均由主进程负责。
class AutoHideController {
  constructor({
    getExpandedBounds, getDisplayBounds, onCollapse = () => {}, onExpand = () => {},
    onChange = () => {}, delayMs = 3000, edgeSize = 8, now = () => Date.now(),
  }) {
    if ([getExpandedBounds, getDisplayBounds, onCollapse, onExpand, onChange, now]
      .some((callback) => typeof callback !== 'function')) {
      throw new TypeError('自动隐藏控制器缺少有效的窗口函数。');
    }
    if (!Number.isFinite(delayMs) || delayMs < 0 || !Number.isFinite(edgeSize) || edgeSize <= 0) {
      throw new TypeError('自动隐藏等待时间或顶部感应范围无效。');
    }
    this._getExpandedBounds = getExpandedBounds;
    this._getDisplayBounds = getDisplayBounds;
    this._onCollapse = onCollapse;
    this._onExpand = onExpand;
    this._onChange = onChange;
    this._delayMs = delayMs;
    this._edgeSize = edgeSize;
    this._now = now;
    this._state = {
      enabled: false, collapsed: false, dragging: false, suspended: false, manuallyHidden: false,
    };
    this._outsideSince = null;
    this._topRevealTransit = false;
    this._disposed = false;
  }

  getState() {
    return { ...this._state };
  }

  _changeCollapsed(collapsed) {
    if (this._state.collapsed === collapsed) return false;
    // move 回调会立即读取状态，因此必须在移动窗口前更新 collapsed。
    this._state.collapsed = collapsed;
    this._outsideSince = null;
    this._topRevealTransit = false;
    if (collapsed) this._onCollapse();
    else this._onExpand();
    return true;
  }

  _setFlag(name, value, expand) {
    if (typeof value !== 'boolean') throw new TypeError('自动隐藏状态必须是布尔值。');
    if (this._disposed || this._state[name] === value) return this.getState();
    this._state[name] = value;
    this._outsideSince = null;
    this._topRevealTransit = false;
    if (expand) this._changeCollapsed(false);
    this._onChange(this.getState());
    return this.getState();
  }

  setEnabled(enabled) {
    return this._setFlag('enabled', enabled, !enabled);
  }

  setDelayMs(delayMs) {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new TypeError('自动隐藏等待时间必须是大于等于 0 的有限数值。');
    }
    if (this._disposed || this._delayMs === delayMs) return this.getState();
    this._delayMs = delayMs;
    // 切换档位从下一次离开检测重新计时，避免继承旧档位的剩余时间。
    this._outsideSince = null;
    this._topRevealTransit = false;
    return this.getState();
  }

  setDragging(dragging) {
    return this._setFlag('dragging', dragging, dragging);
  }

  setSuspended(suspended) {
    return this._setFlag('suspended', suspended, suspended);
  }

  setManuallyHidden(manuallyHidden) {
    // 取消手动隐藏时是否显示窗口，由调用者通过 reveal 显式决定。
    return this._setFlag('manuallyHidden', manuallyHidden, false);
  }

  reveal() {
    if (this._disposed) return this.getState();
    this._outsideSince = null;
    this._topRevealTransit = false;
    if (this._changeCollapsed(false)) this._onChange(this.getState());
    return this.getState();
  }

  tick(cursorPoint, timestamp = this._now()) {
    if (this._disposed) return this.getState();
    const state = this._state;
    if (!state.enabled || state.dragging || state.suspended || state.manuallyHidden ||
      !isPoint(cursorPoint) || !Number.isFinite(timestamp)) {
      this._outsideSince = null;
      this._topRevealTransit = false;
      return this.getState();
    }

    const expanded = this._getExpandedBounds();
    if (!isRect(expanded)) {
      this._outsideSince = null;
      this._topRevealTransit = false;
      return this.getState();
    }
    if (state.collapsed) {
      const display = this._getDisplayBounds();
      if (isRect(display) && contains(display, cursorPoint) &&
        cursorPoint.x >= expanded.x && cursorPoint.x < expanded.x + expanded.width &&
        cursorPoint.y < display.y + this._edgeSize) {
        this.reveal();
        // 鼠标从顶部进入原位衣架需要经过空隙，快档也应留出这段通道。
        this._topRevealTransit = true;
      }
      return this.getState();
    }

    if (contains(expanded, cursorPoint)) {
      this._outsideSince = null;
      this._topRevealTransit = false;
      return this.getState();
    }
    if (this._topRevealTransit) {
      const display = this._getDisplayBounds();
      if (isRect(display) && contains(display, cursorPoint) &&
        cursorPoint.x >= expanded.x && cursorPoint.x < expanded.x + expanded.width &&
        cursorPoint.y >= display.y && cursorPoint.y < expanded.y) {
        this._outsideSince = null;
        return this.getState();
      }
      this._topRevealTransit = false;
    }
    if (this._outsideSince === null || timestamp < this._outsideSince) {
      this._outsideSince = timestamp;
    }
    if (timestamp - this._outsideSince >= this._delayMs && this._changeCollapsed(true)) {
      this._onChange(this.getState());
    }
    return this.getState();
  }

  dispose() {
    this._disposed = true;
    this._outsideSince = null;
    this._topRevealTransit = false;
  }
}

module.exports = { AutoHideController };
