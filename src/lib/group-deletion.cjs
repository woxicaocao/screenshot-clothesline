'use strict';

const PHOTO_ID = /^[a-f0-9]{64}$/;
const NOTE_ID = /^note-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function errorValue(value) {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' && value ? value : '删除失败，请重试。');
}

function snapshotMembers(members) {
  if (!Array.isArray(members) || members.length === 0) throw new TypeError('整组删除需要至少一个成员。');
  const ids = new Set();
  let kind;
  return Array.from(members, member => {
    if (!member || typeof member !== 'object' || Array.isArray(member)
      || !['photo', 'note'].includes(member.type) || typeof member.id !== 'string'
      || !(member.type === 'photo' ? PHOTO_ID : NOTE_ID).test(member.id)) {
      throw new TypeError('分组成员标识或类型无效。');
    }
    if (kind && member.type !== kind) throw new TypeError('图片和便签不能混合整组删除。');
    if (ids.has(member.id)) throw new TypeError('分组成员不能重复。');
    kind = member.type;
    ids.add(member.id);
    // 只保留删除所需引用；后续分组塌缩或调用方改动数组都不改变本次范围。
    return Object.freeze({ id: member.id, type: member.type });
  });
}

/**
 * 在调用方确认过的固定成员快照中串行删除。调用方负责队列、确认和 UI。
 * 仓库删除失败立即停止；成功删除不可回滚，报告始终反映已经提交的结果。
 * onProgress 仅用于通知；它的失败不会覆盖删除结果或中断本次授权。
 */
async function deleteGroupMembers(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('整组删除参数无效。');
  const { deletePhoto, deleteNote, onProgress, cancelled = false } = options;
  const members = snapshotMembers(options.members);
  if (typeof cancelled !== 'boolean') throw new TypeError('取消状态必须是布尔值。');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('删除进度回调无效。');
  const remove = members[0].type === 'photo' ? deletePhoto : deleteNote;
  if (typeof remove !== 'function') throw new TypeError('缺少当前成员类型的删除方法。');

  const deletedIds = [], alreadyAbsentIds = [], cleanupPendingIds = [], progressErrors = [];
  const report = (nextIndex, extra = {}) => ({
    completed: !cancelled && nextIndex === members.length,
    cancelled,
    deletedIds: [...deletedIds],
    alreadyAbsentIds: [...alreadyAbsentIds],
    cleanupPendingIds: [...cleanupPendingIds],
    failedId: null,
    remainingIds: members.slice(nextIndex).map(member => member.id),
    progressErrors: progressErrors.map(entry => ({ ...entry })),
    ...extra,
  });
  if (cancelled) return report(0);

  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    let result;
    try { result = await remove(member.id); }
    catch (error) {
      return report(index, { completed: false, failedId: member.id, error: errorValue(error) });
    }
    if (result?.deleted === false) alreadyAbsentIds.push(member.id);
    else deletedIds.push(member.id);
    if (result?.cleanupPending === true) cleanupPendingIds.push(member.id);
    if (onProgress) {
      try {
        await onProgress({ ...report(index + 1), member: { ...member }, processedCount: index + 1, totalCount: members.length });
      } catch (error) { progressErrors.push({ id: member.id, error: errorValue(error) }); }
    }
  }
  return report(members.length);
}

module.exports = { deleteGroupMembers };
