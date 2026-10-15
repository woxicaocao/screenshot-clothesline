'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const PHOTO_ID = /^[a-f0-9]{64}$/;
const NOTE_ID = /^note-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const GROUP_ID = /^group-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_GROUP_NAME_LENGTH = 80;
const MAX_BATCH_PHOTOS = 100;

function isItemId(id) {
  return typeof id === 'string' && (PHOTO_ID.test(id) || NOTE_ID.test(id));
}

function requireId(id, groupOnly = false) {
  if (typeof id !== 'string' || !(groupOnly ? GROUP_ID.test(id) : isItemId(id) || GROUP_ID.test(id))) {
    throw new TypeError(groupOnly ? '分组标识无效。' : '卡片标识无效。');
  }
  return id;
}

function normalizeName(name) {
  if (typeof name !== 'string' || !name.trim() || [...name.trim()].length > MAX_GROUP_NAME_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new TypeError(`组名必须是 1 到 ${MAX_GROUP_NAME_LENGTH} 个字符的单行文字。`);
  }
  return name.trim();
}

function normalizeOperation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('整理操作必须是对象。');
  switch (input.type) {
    case 'move':
      return { type: input.type, id: requireId(input.id),
        beforeId: input.beforeId == null ? null : requireId(input.beforeId),
        groupId: input.groupId == null ? null : requireId(input.groupId, true) };
    case 'move-many': {
      if (!Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > MAX_BATCH_PHOTOS
        || input.ids.some(id => typeof id !== 'string' || !PHOTO_ID.test(id))
        || new Set(input.ids).size !== input.ids.length) {
        throw new TypeError(`每次只能整理 1 到 ${MAX_BATCH_PHOTOS} 张不重复的图片。`);
      }
      const beforeId = input.beforeId == null ? null : requireId(input.beforeId);
      if (input.ids.includes(beforeId)) throw new TypeError('插入位置不能是已选中的图片。');
      return { type: input.type, groupId: requireId(input.groupId, true), ids: [...input.ids], beforeId };
    }
    case 'group':
      return { type: input.type, sourceId: requireId(input.sourceId), targetId: requireId(input.targetId) };
    case 'rename':
      return { type: input.type, groupId: requireId(input.groupId, true), name: normalizeName(input.name) };
    case 'remove':
      return { type: input.type, groupId: requireId(input.groupId, true), id: requireId(input.id) };
    case 'dissolve':
      return { type: input.type, groupId: requireId(input.groupId, true) };
    default:
      throw new TypeError('不支持的整理操作。');
  }
}

function normalizeStoredLayout(input) {
  if (!input || input.version !== 1 || !Array.isArray(input.order) || !Array.isArray(input.groups)
    || (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 0))) {
    throw new Error('布局文件格式无效，原文件已保留。');
  }
  try {
    const order = input.order.map((id) => requireId(id));
    const groups = input.groups.map((group) => {
      if (!group || !['photo', 'note'].includes(group.kind) || !Array.isArray(group.memberIds)) {
        throw new TypeError('分组内容无效。');
      }
      const memberIds = group.memberIds.map((id) => {
        // 成员只引用原始内容；组不嵌套、不合并。
        if (!isItemId(id)) throw new TypeError('分组成员标识无效。');
        return id;
      });
      return { id: requireId(group.id, true), kind: group.kind, name: normalizeName(group.name), memberIds };
    });
    return { version: 1, revision: input.revision ?? 0, order, groups };
  } catch (error) {
    throw new Error('布局文件包含无效记录，原文件已保留。', { cause: error });
  }
}

function makeCatalog(catalog) {
  if (!Array.isArray(catalog)) throw new TypeError('卡片目录必须是完整数组。');
  const entries = new Map();
  for (const item of catalog) {
    if (!item || !['photo', 'note'].includes(item.type) || !isItemId(item.id)
      || (item.type === 'photo' ? !PHOTO_ID.test(item.id) : !NOTE_ID.test(item.id))) {
      throw new TypeError('卡片目录包含无效记录。');
    }
    if (!entries.has(item.id)) entries.set(item.id, item);
  }
  return entries;
}

function itemTime(item) {
  const time = Date.parse(item.capturedAt ?? item.createdAt);
  return Number.isFinite(time) ? time : 0;
}

function reconcile(layout, catalog) {
  const used = new Set();
  const groupsById = new Map();
  for (const group of layout.groups) if (!groupsById.has(group.id)) groupsById.set(group.id, group);
  const order = [];
  const groups = [];
  for (const id of layout.order) {
    if (GROUP_ID.test(id)) {
      const group = groupsById.get(id);
      if (!group || used.has(id)) continue;
      used.add(id);
      const memberIds = [];
      for (const memberId of group.memberIds) {
        if (used.has(memberId) || catalog.get(memberId)?.type !== group.kind) continue;
        used.add(memberId);
        memberIds.push(memberId);
      }
      if (memberIds.length === 1) order.push(memberIds[0]);
      else if (memberIds.length > 1) {
        order.push(id);
        groups.push({ ...group, memberIds });
      }
    } else if (!used.has(id) && catalog.has(id)) {
      used.add(id);
      order.push(id);
    }
  }
  const added = [...catalog.values()].filter((item) => !used.has(item.id))
    .sort((left, right) => itemTime(right) - itemTime(left)).map((item) => item.id);
  return { version: 1, revision: layout.revision, order: [...added, ...order], groups };
}

class LayoutRepository {
  constructor(dataDir) {
    if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('缺少布局数据目录。');
    this.dataDir = path.resolve(dataDir);
    this._layout = { version: 1, revision: 0, order: [], groups: [] };
    this._catalog = new Map();
    this._catalogEpoch = 0;
    this._removedAt = new Map();
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

  async _guardIndex() {
    const directory = await fs.lstat(this.dataDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || !this._samePath(await fs.realpath(this.dataDir), this._realDataDir)) {
      throw new Error('布局数据目录发生变化，已停止保存并保留原文件。');
    }
    const destination = path.join(this.dataDir, 'layout.json');
    try {
      const info = await fs.lstat(destination);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('布局文件不是普通文件，原文件已保留。');
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
      let stored;
      try {
        stored = JSON.parse(await fs.readFile(destination, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') stored = { version: 1, revision: 0, order: [], groups: [] };
        else throw new Error('无法读取布局文件，原文件已保留。', { cause: error });
      }
      this._layout = normalizeStoredLayout(stored);
      this._initialized = true;
    });
  }

  _receiveCatalog(catalog) {
    if (!this._initialized) throw new Error('布局仓库尚未初始化。');
    const nextCatalog = makeCatalog(catalog);
    this._catalogEpoch += 1;
    for (const id of this._catalog.keys()) {
      if (!nextCatalog.has(id)) this._removedAt.set(id, this._catalogEpoch);
    }
    this._catalog = nextCatalog;
    // 同步清理运行时引用，避免删除后重新导入相同 hash 时复活旧分组。
    // 此处不写盘；下一次成功整理时一并持久化。
    this._layout = reconcile(this._layout, this._catalog);
  }

  _groupView(group) {
    const items = group.memberIds.map((id) => this._catalog.get(id));
    return { type: 'group', id: group.id, kind: group.kind, name: group.name,
      count: items.length, memberIds: [...group.memberIds], covers: items.slice(0, 3) };
  }

  _view() {
    const groups = new Map(this._layout.groups.map((group) => [group.id, group]));
    return { revision: this._layout.revision,
      items: this._layout.order.map((id) => groups.has(id) ? this._groupView(groups.get(id)) : this._catalog.get(id)) };
  }

  getView(catalog) {
    this._receiveCatalog(catalog);
    return this._view();
  }

  getGroup(id, catalog) {
    requireId(id, true);
    this._receiveCatalog(catalog);
    const group = this._layout.groups.find((entry) => entry.id === id);
    return group ? { ...this._groupView(group), items: group.memberIds.map((memberId) => this._catalog.get(memberId)) } : null;
  }

  async _atomicWrite(layout) {
    const destination = await this._guardIndex();
    const temporary = `${destination}.pending-${randomUUID()}`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx');
      await handle.writeFile(`${JSON.stringify(layout, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this._guardIndex();
      // 完整写入后同目录原子发布；失败保留旧布局和 pending 文件。
      await fs.rename(temporary, destination);
    } finally {
      if (handle) await handle.close();
    }
  }

  _change(layout, operation) {
    const findGroup = (id) => {
      const group = layout.groups.find((entry) => entry.id === id);
      if (!group) throw new Error('这个分组已不存在。');
      return group;
    };
    switch (operation.type) {
      case 'move': {
        const order = operation.groupId === null ? layout.order : findGroup(operation.groupId).memberIds;
        if (!order.includes(operation.id) || (operation.beforeId !== null && !order.includes(operation.beforeId))) {
          throw new Error('只能调整当前列表中的卡片顺序。');
        }
        if (operation.id === operation.beforeId) break;
        order.splice(order.indexOf(operation.id), 1);
        order.splice(operation.beforeId === null ? order.length : order.indexOf(operation.beforeId), 0, operation.id);
        break;
      }
      case 'move-many': {
        const group = findGroup(operation.groupId);
        const selected = new Set(operation.ids);
        if (group.kind !== 'photo' || operation.ids.some(id => !group.memberIds.includes(id)
          || this._catalog.get(id)?.type !== 'photo')
          || operation.beforeId !== null && !group.memberIds.includes(operation.beforeId)) {
          throw new Error('只能批量整理当前图片组中的图片。');
        }
        // 选择顺序不代表拖动顺序，始终保留组内原有的相对位置。
        const moving = group.memberIds.filter(id => selected.has(id));
        const remaining = group.memberIds.filter(id => !selected.has(id));
        const index = operation.beforeId === null ? remaining.length : remaining.indexOf(operation.beforeId);
        remaining.splice(index, 0, ...moving);
        group.memberIds = remaining;
        break;
      }
      case 'group': {
        const { sourceId, targetId } = operation;
        const source = this._catalog.get(sourceId);
        if (sourceId === targetId || !source || !layout.order.includes(sourceId) || !layout.order.includes(targetId)) {
          throw new Error('只能将顶层单张卡片加入另一张同类卡片或同类组。');
        }
        const targetGroup = layout.groups.find((entry) => entry.id === targetId);
        const target = this._catalog.get(targetId);
        if (source.type !== (targetGroup?.kind ?? target?.type)) throw new Error('图片与便签不能混合分组。');
        layout.order.splice(layout.order.indexOf(sourceId), 1);
        if (targetGroup) targetGroup.memberIds.push(sourceId);
        else {
          const prefix = source.type === 'photo' ? '图片组' : '便签组';
          const names = new Set(layout.groups.map((group) => group.name));
          let number = 1;
          while (names.has(`${prefix} ${number}`)) number += 1;
          const group = { id: `group-${randomUUID()}`, kind: source.type, name: `${prefix} ${number}`,
            memberIds: [targetId, sourceId] };
          layout.groups.push(group);
          layout.order.splice(layout.order.indexOf(targetId), 1, group.id);
        }
        break;
      }
      case 'rename':
        findGroup(operation.groupId).name = operation.name;
        break;
      case 'remove': {
        const group = findGroup(operation.groupId);
        const index = group.memberIds.indexOf(operation.id);
        if (index < 0) throw new Error('这张卡片不属于当前分组。');
        group.memberIds.splice(index, 1);
        layout.order.splice(layout.order.indexOf(group.id) + 1, 0, operation.id);
        break;
      }
      case 'dissolve': {
        const group = findGroup(operation.groupId);
        layout.order.splice(layout.order.indexOf(group.id), 1, ...group.memberIds);
        layout.groups = layout.groups.filter((entry) => entry.id !== group.id);
        break;
      }
    }
    return reconcile(layout, this._catalog);
  }

  async apply(operation, catalog) {
    const normalized = normalizeOperation(operation);
    // 在入队时接收最新完整目录；队列执行时继续使用最新目录，避免旧快照复活已删除内容。
    this._receiveCatalog(catalog);
    return this._enqueue(async () => {
      const catalogEpoch = this._catalogEpoch;
      const next = this._change(structuredClone(this._layout), normalized);
      if (next.revision >= Number.MAX_SAFE_INTEGER) throw new Error('布局版本已达到上限。');
      next.revision += 1;
      await this._atomicWrite(next);
      // 保存期间截图/删除仍可改变目录；提交时再次过滤，操作失败不会提前发布草案。
      // 同一 hash 在保存期间先删除再导入，也必须在组外作为新内容出现。
      const removedSinceDraft = (id) => (this._removedAt.get(id) ?? 0) > catalogEpoch;
      next.order = next.order.filter((id) => !removedSinceDraft(id));
      for (const group of next.groups) group.memberIds = group.memberIds.filter((id) => !removedSinceDraft(id));
      this._layout = reconcile(next, this._catalog);
      return this._view();
    });
  }
}

module.exports = { LayoutRepository, MAX_GROUP_NAME_LENGTH, MAX_BATCH_PHOTOS };
