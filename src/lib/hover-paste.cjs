'use strict';

const PASTE_ACCELERATOR = 'Control+V';

// 窗口与鼠标范围由主进程验证；这里只临时持有自己的快捷键。
class HoverPasteController {
  constructor({
    globalShortcut, getEligibility, onPaste, onChange = () => {}, onError = () => {},
    now = () => Date.now(), retryMs = 1000,
  }) {
    if (!globalShortcut || typeof globalShortcut.register !== 'function' ||
      typeof globalShortcut.unregister !== 'function' ||
      [getEligibility, onPaste, onChange, onError, now].some((value) => typeof value !== 'function')) {
      throw new TypeError('悬停粘贴控制器缺少有效的快捷键或回调函数。');
    }
    if (!Number.isFinite(retryMs) || retryMs < 0) {
      throw new TypeError('快捷键重试间隔必须是大于等于 0 的有限数值。');
    }
    this._globalShortcut = globalShortcut;
    this._getEligibility = getEligibility;
    this._onPaste = onPaste;
    this._onChange = onChange;
    this._onError = onError;
    this._now = now;
    this._retryMs = retryMs;
    this._nextRetry = 0;
    this._disposed = false;
    this._state = { registered: false, eligible: false, busy: false, failed: false };
    this._lastNotified = this.getState();
    // trigger 会自行处理异步失败，原生快捷键回调不产生悬空的 rejection。
    this._shortcutCallback = () => { void this.trigger(); };
  }

  getState() {
    return { ...this._state };
  }

  _reportError(error) {
    try { this._onError(error); } catch {}
  }

  _notifyChange() {
    const state = this.getState();
    if (Object.keys(state).every((key) => state[key] === this._lastNotified[key])) return;
    this._lastNotified = state;
    try { this._onChange({ ...state }); } catch (error) { this._reportError(error); }
  }

  _readEligibility() {
    try { return this._getEligibility() === true; }
    catch (error) {
      this._reportError(error);
      return false;
    }
  }

  _unregisterOwned() {
    if (!this._state.registered) return;
    this._state.registered = false;
    try { this._globalShortcut.unregister(PASTE_ACCELERATOR); }
    catch (error) { this._reportError(error); }
  }

  update() {
    if (this._disposed) return this.getState();
    const state = this._state;
    state.eligible = this._readEligibility();
    if (!state.eligible) {
      this._unregisterOwned();
      state.failed = false;
      this._nextRetry = 0;
    } else if (!state.registered) {
      const time = this._now();
      if (Number.isFinite(time) && time >= this._nextRetry) {
        this._nextRetry = time + this._retryMs;
        try {
          state.registered = this._globalShortcut.register(PASTE_ACCELERATOR, this._shortcutCallback) === true;
          state.failed = !state.registered;
        } catch (error) {
          state.failed = true;
          this._reportError(error);
        }
        if (state.registered) this._nextRetry = 0;
      }
    }
    this._notifyChange();
    return this.getState();
  }

  async trigger() {
    if (this._disposed) return false;
    const state = this._state;
    // 不信任上一轮鼠标轮询结果：快捷键到达时立即复查可见性和范围。
    state.eligible = this._readEligibility();
    if (!state.eligible) {
      this._unregisterOwned();
      state.failed = false;
      this._nextRetry = 0;
      this._notifyChange();
      return false;
    }
    if (!state.registered || state.busy) {
      this._notifyChange();
      return false;
    }
    state.busy = true;
    this._notifyChange();
    let succeeded = false;
    try {
      if (!this._disposed) {
        await this._onPaste();
        succeeded = true;
      }
    } catch (error) {
      this._reportError(error);
    } finally {
      state.busy = false;
      // 粘贴期间可能已经离开或隐藏；完成后同样即时释放快捷键。
      if (!this._disposed) this.update();
    }
    return succeeded && !this._disposed;
  }

  dispose() {
    if (this._disposed) return this.getState();
    this._disposed = true;
    this._unregisterOwned();
    this._state.eligible = false;
    this._state.busy = false;
    this._state.failed = false;
    this._nextRetry = 0;
    this._notifyChange();
    return this.getState();
  }
}

module.exports = { HoverPasteController, PASTE_ACCELERATOR };
