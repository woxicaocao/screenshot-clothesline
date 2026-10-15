'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deleteGroupMembers } = require('../src/lib/group-deletion.cjs');

const photo = number => ({ type: 'photo', id: number.toString(16).padStart(64, '0') });
const note = number => ({ type: 'note', id: `note-00000000-0000-0000-0000-${number.toString(16).padStart(12, '0')}` });

test('两项图片组塌缩后仍删除固定快照中的最后一项', async () => {
  const members = [photo(1), photo(2)], originalIds = members.map(member => member.id), removed = [];
  const result = await deleteGroupMembers({ members, deletePhoto: async id => {
    removed.push(id);
    // 模拟仓库 publish 后布局取消了单成员组，并改动了原来的成员数组。
    members.length = 0;
    return { deleted: true, cleanupPending: false };
  } });
  assert.deepEqual(removed, originalIds);
  assert.deepEqual(result.deletedIds, originalIds);
  assert.equal(result.completed, true);
  assert.deepEqual(result.remainingIds, []);
  assert.equal(result.failedId, null);
});

test('多项图片串行删除，保留顺序且不会并发', async () => {
  const members = [photo(1), photo(2), photo(3), photo(4)];
  let active = 0, maximum = 0;
  const calls = [];
  const result = await deleteGroupMembers({ members, deletePhoto: async id => {
    active += 1; maximum = Math.max(maximum, active); calls.push(id);
    await new Promise(resolve => setImmediate(resolve));
    active -= 1;
    return { deleted: true, cleanupPending: id === members[1].id };
  } });
  assert.equal(maximum, 1);
  assert.deepEqual(calls, members.map(member => member.id));
  assert.deepEqual(result.cleanupPendingIds, [members[1].id]);
  assert.equal(result.completed, true);
});

test('便签使用便签删除方法，成功无返回值仍算已完成', async () => {
  const members = [note(1), note(2)], calls = [];
  const result = await deleteGroupMembers({ members,
    deletePhoto: () => assert.fail('不得调用图片删除'), deleteNote: id => { calls.push(id); } });
  assert.deepEqual(calls, members.map(member => member.id));
  assert.deepEqual(result.deletedIds, calls);
  assert.equal(result.completed, true);
});

test('中途失败立即停止，报告已删除、失败及包含失败项的剩余成员', async () => {
  const members = [photo(1), photo(2), photo(3)], calls = [], failure = new Error('文件正在占用');
  const result = await deleteGroupMembers({ members, deletePhoto: id => {
    calls.push(id); if (id === members[1].id) throw failure; return { deleted: true };
  } });
  assert.deepEqual(calls, members.slice(0, 2).map(member => member.id));
  assert.equal(result.completed, false);
  assert.equal(result.failedId, members[1].id);
  assert.deepEqual(result.deletedIds, [members[0].id]);
  assert.deepEqual(result.remainingIds, members.slice(1).map(member => member.id));
  assert.equal(result.error, failure);
});

test('第一项失败不会执行任何其他成员，非 Error 拒绝也可展示', async () => {
  const members = [note(1), note(2)], calls = [];
  const result = await deleteGroupMembers({ members, deleteNote: async id => { calls.push(id); throw '索引保存失败'; } });
  assert.deepEqual(calls, [members[0].id]);
  assert.deepEqual(result.deletedIds, []);
  assert.deepEqual(result.remainingIds, members.map(member => member.id));
  assert.equal(result.error.message, '索引保存失败');
});

test('再次确认剩余单项后可以重试，不需要仍存在分组', async () => {
  const member = photo(2);
  const result = await deleteGroupMembers({ members: [member], deletePhoto: async () => ({ deleted: true }) });
  assert.equal(result.completed, true);
  assert.deepEqual(result.deletedIds, [member.id]);
});

test('取消时不执行删除及进度通知', async () => {
  const members = [photo(1), photo(2)];
  const result = await deleteGroupMembers({ members, cancelled: true,
    deletePhoto: () => assert.fail('取消不得删除'), onProgress: () => assert.fail('取消不得发进度') });
  assert.equal(result.cancelled, true); assert.equal(result.completed, false);
  assert.deepEqual(result.deletedIds, []);
  assert.deepEqual(result.remainingIds, members.map(member => member.id));
});

test('已不存在的成员单独记账，缓存待清理仍明确记录', async () => {
  const members = [photo(1), photo(2)];
  const result = await deleteGroupMembers({ members, deletePhoto: async id => ({ deleted: id !== members[0].id, cleanupPending: id === members[0].id }) });
  assert.equal(result.completed, true);
  assert.deepEqual(result.deletedIds, [members[1].id]);
  assert.deepEqual(result.alreadyAbsentIds, [members[0].id]);
  assert.deepEqual(result.cleanupPendingIds, [members[0].id]);
});

test('删除回调改动调用方成员对象不能扩大本次删除范围', async () => {
  const members = [photo(1), photo(2)], ids = members.map(member => member.id), calls = [];
  const result = await deleteGroupMembers({ members, deletePhoto: async id => {
    calls.push(id); members[1].id = photo(99).id; members.push(photo(100)); return { deleted: true };
  } });
  assert.deepEqual(calls, ids);
  assert.deepEqual(result.deletedIds, ids);
});

test('进度回调收到独立状态，修改通知内容不能改变删除范围和结果', async () => {
  const members = [photo(1), photo(2), photo(3)], ids = members.map(member => member.id), calls = [], progress = [];
  const result = await deleteGroupMembers({ members, deletePhoto: async id => { calls.push(id); }, onProgress: state => {
    progress.push({ processed: state.processedCount, total: state.totalCount, remaining: [...state.remainingIds] });
    state.deletedIds.length = 0; state.remainingIds.push(photo(99).id); state.member.id = photo(100).id;
    state.progressErrors.push({ id: 'extra' });
  } });
  assert.deepEqual(calls, ids); assert.deepEqual(result.deletedIds, ids);
  assert.deepEqual(result.progressErrors, []);
  assert.deepEqual(progress.map(state => state.processed), [1, 2, 3]);
  assert.ok(progress.every(state => state.total === 3));
  assert.deepEqual(progress.map(state => state.remaining), [ids.slice(1), ids.slice(2), []]);
});

test('进度通知同步/异步失败不影响已提交删除或后续删除', async () => {
  const members = [note(1), note(2), note(3)], calls = [];
  const result = await deleteGroupMembers({ members, deleteNote: async id => { calls.push(id); return { deleted: true }; },
    onProgress: state => { if (state.processedCount === 1) throw new Error('刷新失败'); if (state.processedCount === 2) return Promise.reject('通知失败'); } });
  assert.equal(result.completed, true);
  assert.deepEqual(calls, members.map(member => member.id));
  assert.deepEqual(result.progressErrors.map(entry => [entry.id, entry.error.message]), [[members[0].id, '刷新失败'], [members[1].id, '通知失败']]);
});

test('所有输入预先验证：混组、重复、非法成员均在第一次删除前拒绝', async () => {
  const invalid = [null, [], {}, [null], new Array(2), [photo(1), , photo(2)], [photo(1), note(1)], [photo(1), photo(1)],
    [{ type: 'photo', id: note(1).id }], [{ type: 'note', id: photo(1).id }],
    [{ type: 'group', id: 'group-00000000-0000-0000-0000-000000000001' }],
    [{ type: 'photo', id: '../outside' }], [photo(1), { type: 'photo', id: 'not-a-hash' }]];
  for (const members of invalid) {
    await assert.rejects(deleteGroupMembers({ members, deletePhoto: () => assert.fail('无效输入不能删除'), deleteNote: () => assert.fail('无效输入不能删除') }), TypeError);
  }
});

test('选项、回调和取消状态无效时拒绝且不执行删除', async () => {
  for (const options of [null, [], undefined, 'x', { members: [photo(1)] },
    { members: [note(1)], deletePhoto() {} }, { members: [photo(1)], deletePhoto: 1 },
    { members: [photo(1)], deletePhoto() { assert.fail(); }, cancelled: 'yes' },
    { members: [photo(1)], deletePhoto() { assert.fail(); }, onProgress: false }]) {
    await assert.rejects(deleteGroupMembers(options), TypeError);
  }
});
