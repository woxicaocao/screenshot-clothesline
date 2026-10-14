'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_NOTE_LENGTH = 50_000;
const NOTE_ID_PATTERN = /^note-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DEFAULT_NOTE = Object.freeze({ color: '#fff2b8', fontSize: 14, alwaysOnTop: false, bounds: null });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeNoteInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('便签内容必须是对象。');
  if (typeof input.text !== 'string') throw new TypeError('便签文字必须是字符串。');
  if (input.text.length > MAX_NOTE_LENGTH) throw new TypeError('便签文字不能超过 50000 个字符。');
  const color = input.color === undefined ? DEFAULT_NOTE.color : input.color;
  if (typeof color !== 'string' || !/^#[a-f0-9]{6}$/i.test(color)) throw new TypeError('便签颜色必须是 #RRGGBB 格式。');
  const fontSize = input.fontSize === undefined ? DEFAULT_NOTE.fontSize : input.fontSize;
  if (!Number.isSafeInteger(fontSize) || fontSize < 14 || fontSize > 32) throw new TypeError('便签字体大小必须是 14 到 32 的整数。');
  const alwaysOnTop = input.alwaysOnTop === undefined ? DEFAULT_NOTE.alwaysOnTop : input.alwaysOnTop;
  if (typeof alwaysOnTop !== 'boolean') throw new TypeError('便签置顶开关必须是布尔值。');
  const bounds = input.bounds === undefined ? null : input.bounds;
  if (bounds !== null && (!bounds || typeof bounds !== 'object' || Array.isArray(bounds)
    || !['x', 'y', 'width', 'height'].every((key) => Number.isSafeInteger(bounds[key]))
    || Math.abs(bounds.x) > 1_000_000 || Math.abs(bounds.y) > 1_000_000
    || bounds.width <= 0 || bounds.height <= 0 || bounds.width > 16_384 || bounds.height > 16_384)) {
    throw new TypeError('便签窗口位置和尺寸无效。');
  }
  const normalized = {
    text: input.text, color: color.toLowerCase(), fontSize, alwaysOnTop,
    bounds: bounds === null ? null : { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
  };
  if (input.id !== undefined) {
    if (typeof input.id !== 'string' || !NOTE_ID_PATTERN.test(input.id)) throw new TypeError('便签标识无效。');
    normalized.id = input.id;
  }
  return normalized;
}

class NotesRepository {
  constructor(dataDir) {
    if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('缺少便签数据目录。');
    this.dataDir = path.resolve(dataDir);
    this._notes = [];
    this._initialized = false;
    this._tail = Promise.resolve();
  }

  _enqueue(operation) {
    const pending = this._tail.then(operation);
    this._tail = pending.catch(() => {});
    return pending;
  }

  _samePath(left, right) {
    const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
    return normalize(path.resolve(left)) === normalize(path.resolve(right));
  }

  async _guardDirectory() {
    const info = await fs.lstat(this.dataDir);
    const realDirectory = await fs.realpath(this.dataDir);
    if (!info.isDirectory() || info.isSymbolicLink() || !this._samePath(realDirectory, this._realDataDir)) {
      throw new Error('便签数据目录发生变化，已停止保存并保留原文件。');
    }
  }

  async _guardIndex() {
    await this._guardDirectory();
    const destination = path.join(this.dataDir, 'notes.json');
    try {
      const info = await fs.lstat(destination);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('便签索引不是普通文件，原文件已保留。');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return destination;
  }

  async init() {
    return this._enqueue(async () => {
      if (this._initialized) return;
      await fs.mkdir(this.dataDir, { recursive: true });
      this._realDataDir = await fs.realpath(this.dataDir);
      const destination = await this._guardIndex();
      let index;
      try {
        index = JSON.parse(await fs.readFile(destination, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') index = { version: 1, notes: [] };
        else throw new Error('无法读取便签索引，原文件已保留。', { cause: error });
      }
      if (!index || index.version !== 1 || !Array.isArray(index.notes)) {
        throw new Error('便签索引格式无效，原文件已保留。');
      }
      const ids = new Set();
      const notes = index.notes.map((entry) => {
        let normalized;
        try {
          normalized = normalizeNoteInput(entry);
          if (!normalized.id || ids.has(normalized.id)
            || typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt))
            || typeof entry.updatedAt !== 'string' || !Number.isFinite(Date.parse(entry.updatedAt))) {
            throw new TypeError('便签标识或时间无效。');
          }
        } catch (error) {
          throw new Error('便签索引包含无效记录，原文件已保留。', { cause: error });
        }
        ids.add(normalized.id);
        return { ...normalized, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
      });
      this._notes = notes.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
      this._initialized = true;
    });
  }

  getNotes() {
    return clone(this._notes);
  }

  getNoteSummaries() {
    // 衣架只需要短预览；不先复制整篇正文或窗口位置，减少刷新时的临时分配。
    return this._notes.map((note) => ({ id: note.id, text: note.text.slice(0, 700), color: note.color,
      fontSize: note.fontSize, alwaysOnTop: note.alwaysOnTop, createdAt: note.createdAt, updatedAt: note.updatedAt }));
  }

  getNote(id) {
    if (typeof id !== 'string' || !NOTE_ID_PATTERN.test(id)) throw new TypeError('便签标识无效。');
    const note = this._notes.find((entry) => entry.id === id);
    return note ? clone(note) : null;
  }

  async _atomicWrite(notes) {
    const destination = await this._guardIndex();
    const temporary = `${destination}.pending-${randomUUID()}`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx');
      await handle.writeFile(`${JSON.stringify({ version: 1, notes }, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this._guardIndex();
      // 写入完整后原子发布；失败保留旧索引和 pending 文件，绝不删除文件。
      await fs.rename(temporary, destination);
    } finally {
      if (handle) await handle.close();
    }
  }

  async saveNote(input) {
    // 在排队前复制、验证调用方数据，避免等待期间被修改。
    const normalized = normalizeNoteInput(input);
    return this._enqueue(async () => {
      if (!this._initialized) throw new Error('便签仓库尚未初始化。');
      const previous = normalized.id ? this._notes.find((entry) => entry.id === normalized.id) : null;
      if (normalized.id && !previous) throw new Error('这张便签不存在。');
      if (!previous && normalized.text.trim().length === 0) return null;
      const now = new Date().toISOString();
      const note = {
        ...normalized, id: previous?.id ?? `note-${randomUUID()}`,
        createdAt: previous?.createdAt ?? now, updatedAt: now,
      };
      const notes = previous ? this._notes.map((entry) => entry.id === note.id ? note : entry) : [note, ...this._notes];
      notes.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
      await this._atomicWrite(notes);
      this._notes = notes;
      return { note: clone(note), added: !previous };
    });
  }

  async deleteNote(id) {
    if (typeof id !== 'string' || !NOTE_ID_PATTERN.test(id)) throw new TypeError('便签标识无效。');
    return this._enqueue(async () => {
      if (!this._initialized) throw new Error('便签仓库尚未初始化。');
      if (!this._notes.some((note) => note.id === id)) return { id, deleted: false };
      const notes = this._notes.filter((note) => note.id !== id);
      // 仅移除用户选择的记录；先原子提交，失败时旧索引和内存记录都保留。
      await this._atomicWrite(notes);
      this._notes = notes;
      return { id, deleted: true };
    });
  }
}

module.exports = { NotesRepository, normalizeNoteInput, DEFAULT_NOTE, MAX_NOTE_LENGTH };
