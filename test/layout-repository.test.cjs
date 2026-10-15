'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { LayoutRepository, MAX_GROUP_NAME_LENGTH, MAX_BATCH_PHOTOS } = require('../src/lib/layout-repository.cjs');

function photo(number, capturedAt = `2026-10-${String(number).padStart(2, '0')}T00:00:00.000Z`) {
  return { type: 'photo', id: number.toString(16).padStart(64, '0'), capturedAt,
    thumbnailUrl: `clothesline://thumbnail/${number}`, originalWidth: 1600 };
}

function note(number) {
  return { type: 'note', id: `note-00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    capturedAt: `2026-10-${String(number).padStart(2, '0')}T01:00:00.000Z`, text: `便签 ${number}`,
    color: '#fff2b8', fontSize: 32 };
}

const ids = (view) => view.items.map((item) => item.id);

async function temporaryRepository(layout) {
  // 用户要求保留文件，测试目录也保留，不做自动清理。
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'screenshot-clothesline-layout-'));
  if (layout) await fs.writeFile(path.join(directory, 'layout.json'), JSON.stringify(layout));
  const repository = new LayoutRepository(directory);
  await repository.init();
  return { directory, repository };
}

async function group(repository, source, target, catalog) {
  const view = await repository.apply({ type: 'group', sourceId: source.id, targetId: target.id }, catalog);
  return view.items.find((item) => item.type === 'group' && item.memberIds.includes(source.id));
}

test('首次不写文件，按时间展示，新增在左端，编辑已有内容不打乱手动顺序', async () => {
  const { directory, repository } = await temporaryRepository();
  const catalog = [photo(1), note(2), photo(3)];
  assert.deepEqual(ids(repository.getView(catalog)), [catalog[2].id, catalog[1].id, catalog[0].id]);
  assert.deepEqual(await fs.readdir(directory), []);
  await repository.apply({ type: 'move', id: catalog[0].id, beforeId: catalog[2].id, groupId: null }, catalog);
  const edited = { ...catalog[1], text: '改动正文', updatedAt: '2026-12-31T00:00:00.000Z' };
  assert.deepEqual(ids(repository.getView([catalog[0], edited, catalog[2]])), [catalog[0].id, catalog[2].id, edited.id]);
  const fresh = photo(4);
  assert.deepEqual(ids(repository.getView([...catalog, fresh])), [fresh.id, catalog[0].id, catalog[2].id, edited.id]);
  assert.equal(repository.getView(catalog).revision, 1);
});

test('图片组和便签组各自编号，保存重启恢复组名成员与顶层排序', async () => {
  const { directory, repository } = await temporaryRepository();
  const [a, b, c, d, e, f] = [photo(1), photo(2), note(3), note(4), photo(5), photo(6)];
  const catalog = [a, b, c, d, e, f];
  const photos = await group(repository, a, b, catalog);
  const notes = await group(repository, c, d, catalog);
  const second = await group(repository, e, f, catalog);
  assert.equal(photos.name, '图片组 1');
  assert.equal(notes.name, '便签组 1');
  assert.equal(second.name, '图片组 2');
  await repository.apply({ type: 'rename', groupId: photos.id, name: '  设计参考  ' }, catalog);
  const before = await repository.apply({ type: 'move', id: photos.id, beforeId: second.id, groupId: null }, catalog);
  const restored = new LayoutRepository(directory); await restored.init();
  assert.deepEqual(restored.getView(catalog), before);
  const full = restored.getGroup(photos.id, catalog);
  assert.equal(full.name, '设计参考');
  assert.deepEqual(full.memberIds, [b.id, a.id]);
  assert.deepEqual(full.items, [b, a]);
  assert.deepEqual(full.covers, [b, a]);
  assert.equal(full.count, 2);
  assert.equal(full.kind, 'photo');
  assert.match(full.id, /^group-[a-f0-9-]{36}$/);
  assert.equal(before.revision, 5);
});

test('单项加入同类组，封面最多三项，组内排序按完整成员列表生效', async () => {
  const { repository } = await temporaryRepository();
  const catalog = [photo(1), photo(2), photo(3), photo(4), photo(5)];
  const created = await group(repository, catalog[0], catalog[1], catalog);
  for (const item of catalog.slice(2)) {
    await repository.apply({ type: 'group', sourceId: item.id, targetId: created.id }, catalog);
  }
  const before = repository.getGroup(created.id, catalog);
  assert.equal(before.count, 5);
  assert.equal(before.covers.length, 3);
  assert.deepEqual(before.memberIds, [catalog[1].id, catalog[0].id, ...catalog.slice(2).map((item) => item.id)]);
  await repository.apply({ type: 'move', id: catalog[4].id, beforeId: catalog[0].id, groupId: created.id }, catalog);
  await repository.apply({ type: 'move', id: catalog[1].id, beforeId: null, groupId: created.id }, catalog);
  const after = repository.getGroup(created.id, catalog);
  assert.deepEqual(after.memberIds, [catalog[4].id, catalog[0].id, catalog[2].id, catalog[3].id, catalog[1].id]);
  assert.deepEqual(ids(repository.getView(catalog)), [created.id]);
});

test('两类不混放，禁止组作源、组嵌套和跨列表排序，拒绝操作不写盘', async () => {
  const { directory, repository } = await temporaryRepository();
  const catalog = [photo(1), photo(2), note(3), note(4), photo(5)];
  const photos = await group(repository, catalog[0], catalog[1], catalog);
  const notes = await group(repository, catalog[2], catalog[3], catalog);
  const before = repository.getView(catalog);
  const bytes = await fs.readFile(path.join(directory, 'layout.json'));
  for (const operation of [
    { type: 'group', sourceId: catalog[4].id, targetId: notes.id },
    { type: 'group', sourceId: photos.id, targetId: notes.id },
    { type: 'group', sourceId: photos.id, targetId: catalog[4].id },
    { type: 'group', sourceId: catalog[0].id, targetId: catalog[4].id },
    { type: 'group', sourceId: catalog[4].id, targetId: catalog[4].id },
    { type: 'move', id: catalog[4].id, beforeId: catalog[0].id, groupId: null },
    { type: 'move', id: catalog[0].id, beforeId: catalog[4].id, groupId: photos.id },
    { type: 'remove', groupId: photos.id, id: catalog[4].id },
  ]) await assert.rejects(repository.apply(operation, catalog));
  assert.deepEqual(repository.getView(catalog), before);
  assert.deepEqual(await fs.readFile(path.join(directory, 'layout.json')), bytes);
});

test('图片和便签单项相互建组均被拒绝', async () => {
  const { directory, repository } = await temporaryRepository();
  const catalog = [photo(1), note(2)];
  for (const [source, target] of [catalog, [...catalog].reverse()]) {
    await assert.rejects(repository.apply({ type: 'group', sourceId: source.id, targetId: target.id }, catalog), /不能混合/);
  }
  assert.deepEqual(await fs.readdir(directory), []);
});

test('移出成员放在原组右侧，剩一项自动还原，解散按成员顺序原位展开', async () => {
  const { repository } = await temporaryRepository();
  const catalog = [photo(1), photo(2), photo(3), photo(4)];
  const created = await group(repository, catalog[0], catalog[1], catalog);
  await repository.apply({ type: 'group', sourceId: catalog[2].id, targetId: created.id }, catalog);
  const removed = await repository.apply({ type: 'remove', groupId: created.id, id: catalog[0].id }, catalog);
  const groupPosition = ids(removed).indexOf(created.id);
  assert.equal(removed.items[groupPosition + 1].id, catalog[0].id);
  const expanded = await repository.apply({ type: 'dissolve', groupId: created.id }, catalog);
  assert.deepEqual(ids(expanded), [catalog[3].id, catalog[1].id, catalog[2].id, catalog[0].id]);
  const two = await group(repository, catalog[1], catalog[2], catalog);
  const collapsed = await repository.apply({ type: 'remove', groupId: two.id, id: catalog[1].id }, catalog);
  assert.equal(collapsed.items.some((item) => item.type === 'group'), false);
  assert.deepEqual(ids(collapsed), [catalog[3].id, catalog[2].id, catalog[1].id, catalog[0].id]);
  assert.equal(repository.getGroup(two.id, catalog), null);
});

test('同步清理重复引用和失效成员，空组取消，单成员还原，遗漏内容在左侧', async () => {
  const [a, b, c, d] = [photo(1), photo(2), photo(3), note(4)];
  const gid = `group-${randomUUID()}`; const emptyId = `group-${randomUUID()}`;
  const { directory, repository } = await temporaryRepository({ version: 1, revision: 7,
    order: [gid, a.id, gid, emptyId, b.id, b.id, photo(8).id], groups: [
      { id: gid, kind: 'photo', name: '恢复组', memberIds: [a.id, a.id, photo(9).id, d.id] },
      { id: emptyId, kind: 'note', name: '空组', memberIds: [note(8).id] },
    ] });
  const original = await fs.readFile(path.join(directory, 'layout.json'));
  assert.deepEqual(repository.getView([a, b, c, d]), { revision: 7, items: [d, c, a, b] });
  assert.equal(repository.getGroup(gid, [a, b, c, d]), null);
  assert.deepEqual(await fs.readFile(path.join(directory, 'layout.json')), original);
});

test('删除成员后同 hash 重新导入不回旧组，首次重启快照也清除失效引用', async () => {
  const { directory, repository } = await temporaryRepository();
  const [a, b, c] = [photo(1), photo(2), photo(3)];
  const created = await group(repository, a, b, [a, b, c]);
  await repository.apply({ type: 'group', sourceId: c.id, targetId: created.id }, [a, b, c]);
  const restored = new LayoutRepository(directory); await restored.init();
  restored.getView([a, c]);
  const reimported = restored.getView([a, b, c]);
  assert.equal(reimported.items[0].id, b.id);
  assert.deepEqual(restored.getGroup(created.id, [a, b, c]).memberIds, [a.id, c.id]);
  assert.deepEqual(ids(restored.getView([])), []);
  assert.deepEqual(ids(restored.getView([a, b, c])), [c.id, b.id, a.id]);
});

test('原子发布失败不提前改布局和版本，保留旧文件及 pending，解除占用可重试', async (t) => {
  const { directory, repository } = await temporaryRepository();
  const catalog = [photo(1), photo(2), photo(3)];
  const created = await group(repository, catalog[0], catalog[1], catalog);
  const before = repository.getView(catalog);
  const destination = path.join(directory, 'layout.json');
  const bytes = await fs.readFile(destination);
  const rename = fs.rename;
  const mock = t.mock.method(fs, 'rename', async (source, target) => {
    if (target === destination) throw Object.assign(new Error('模拟布局文件被占用'), { code: 'EACCES' });
    return rename(source, target);
  });
  await assert.rejects(repository.apply({ type: 'rename', groupId: created.id, name: '不能提前生效' }, catalog), /被占用/);
  await assert.rejects(repository.apply({ type: 'move', id: catalog[2].id, beforeId: null, groupId: null }, catalog), /被占用/);
  mock.mock.restore();
  assert.deepEqual(repository.getView(catalog), before);
  assert.deepEqual(await fs.readFile(destination), bytes);
  const pending = (await fs.readdir(directory)).filter((name) => name.startsWith('layout.json.pending-'));
  assert.equal(pending.length, 2);
  for (const name of pending) assert.equal(JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')).revision, before.revision + 1);
  const after = await repository.apply({ type: 'rename', groupId: created.id, name: '成功重试' }, catalog);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(repository.getGroup(created.id, catalog).name, '成功重试');
  for (const name of pending) await fs.access(path.join(directory, name));
});

test('并发操作串行提交，输入在入队时复制，返回成员数组不能改内部布局', async () => {
  const { directory, repository } = await temporaryRepository();
  const catalog = [photo(1), photo(2), photo(3), photo(4)];
  const created = await group(repository, catalog[0], catalog[1], catalog);
  const rename = { type: 'rename', groupId: created.id, name: '排队时名称' };
  const pending = repository.apply(rename, catalog); rename.name = '排队后修改';
  const results = await Promise.all([
    pending,
    repository.apply({ type: 'group', sourceId: catalog[2].id, targetId: created.id }, catalog),
    repository.apply({ type: 'move', id: catalog[0].id, beforeId: catalog[1].id, groupId: created.id }, catalog),
    repository.apply({ type: 'move', id: created.id, beforeId: catalog[3].id, groupId: null }, catalog),
  ]);
  assert.deepEqual(results.map((view) => view.revision), [2, 3, 4, 5]);
  const groupView = repository.getGroup(created.id, catalog);
  assert.equal(groupView.name, '排队时名称');
  assert.deepEqual(groupView.memberIds, [catalog[0].id, catalog[1].id, catalog[2].id]);
  groupView.memberIds.length = 0; groupView.covers.length = 0; groupView.items.length = 0;
  assert.equal(repository.getGroup(created.id, catalog).count, 3);
  const restored = new LayoutRepository(directory); await restored.init();
  assert.deepEqual(restored.getView(catalog), repository.getView(catalog));
});

test('保存期间不发布草案，新目录内容和先删除再导入的 hash 在提交时仍正确', async () => {
  const { repository } = await temporaryRepository();
  const [a, b, c, fresh] = [photo(1), photo(2), photo(3), photo(4)];
  const catalog = [a, b, c];
  const created = await group(repository, a, b, catalog);
  await repository.apply({ type: 'group', sourceId: c.id, targetId: created.id }, catalog);
  const write = repository._atomicWrite.bind(repository);
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let started; const start = new Promise((resolve) => { started = resolve; });
  repository._atomicWrite = async (layout) => { started(); await gate; return write(layout); };
  const pending = repository.apply({ type: 'rename', groupId: created.id, name: '提交后名称' }, catalog);
  await start;
  assert.equal(repository.getGroup(created.id, catalog).name, '图片组 1');
  repository.getView([a, c, fresh]);
  repository.getView([a, b, c, fresh]);
  release(); await pending;
  assert.deepEqual(ids(repository.getView([a, b, c, fresh])), [fresh.id, b.id, created.id]);
  assert.deepEqual(repository.getGroup(created.id, [a, b, c, fresh]).memberIds, [a.id, c.id]);
  assert.equal(repository.getGroup(created.id, [a, b, c, fresh]).name, '提交后名称');
});

test('独立布局保存不修改照片、便签索引和原图', async () => {
  const { directory, repository } = await temporaryRepository();
  const retained = new Map([
    ['index.json', '{"version":1,"photos":["旧格式保持"]}'],
    ['notes.json', '{"version":1,"notes":["便签原文保持"]}'],
    ['original-image.png', '原图文件二进制占位'],
  ]);
  for (const [name, contents] of retained) await fs.writeFile(path.join(directory, name), contents);
  const catalog = [photo(1), photo(2)];
  const created = await group(repository, catalog[0], catalog[1], catalog);
  await repository.apply({ type: 'rename', groupId: created.id, name: '保留原数据' }, catalog);
  for (const [name, contents] of retained) assert.equal(await fs.readFile(path.join(directory, name), 'utf8'), contents);
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'layout.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['version', 'revision', 'order', 'groups'].sort());
  assert.equal(JSON.stringify(saved).includes('thumbnailUrl'), false);
  assert.equal(JSON.stringify(saved).includes('originalWidth'), false);
});

test('路径穿越、非法操作和无效组名被拒绝，合法组名只存允许字段', async () => {
  const { directory, repository } = await temporaryRepository();
  const catalog = [note(1), note(2)];
  const created = await group(repository, catalog[0], catalog[1], catalog);
  const before = await fs.readFile(path.join(directory, 'layout.json'));
  for (const operation of [
    null, [], {}, { type: 'unknown' },
    { type: 'move', id: '../index.json', beforeId: null },
    { type: 'move', id: catalog[0].id, beforeId: '..\\notes.json', groupId: created.id },
    { type: 'remove', groupId: '../../outside', id: catalog[0].id },
    { type: 'group', sourceId: catalog[0].id, targetId: 'C:\\outside.json' },
    ...['', '   ', '行\n换行', '字'.repeat(MAX_GROUP_NAME_LENGTH + 1), null].map((name) => ({ type: 'rename', groupId: created.id, name })),
  ]) await assert.rejects(repository.apply(operation, catalog), TypeError);
  assert.deepEqual(await fs.readFile(path.join(directory, 'layout.json')), before);
  await repository.apply({ type: 'rename', groupId: created.id, name: '字'.repeat(MAX_GROUP_NAME_LENGTH), filename: 'outside.json' }, catalog);
  assert.equal(Object.hasOwn(repository.getGroup(created.id, catalog), 'filename'), false);
  assert.throws(() => repository.getGroup('../outside', catalog), TypeError);
});

test('损坏布局和嵌套成员拒绝启动，保留原文件；未知字段不进入内存', async () => {
  const a = photo(1); const b = photo(2); const gid = `group-${randomUUID()}`;
  const valid = { version: 1, revision: 3, order: [gid], groups: [{ id: gid, kind: 'photo', name: '恢复', memberIds: [a.id, b.id] }] };
  for (const content of [
    '{broken', JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, revision: -1 }),
    JSON.stringify({ ...valid, order: ['../outside'] }),
    JSON.stringify({ ...valid, groups: [{ ...valid.groups[0], memberIds: [gid] }] }),
  ]) {
    const { directory } = await temporaryRepository();
    const destination = path.join(directory, 'layout.json');
    await fs.writeFile(destination, content);
    const repository = new LayoutRepository(directory);
    await assert.rejects(repository.init(), /原文件已保留/);
    assert.equal(await fs.readFile(destination, 'utf8'), content);
    assert.throws(() => repository.getView([a, b]), /尚未初始化/);
  }
  const { repository } = await temporaryRepository({ ...valid, extra: true,
    groups: [{ ...valid.groups[0], secret: '不透出' }] });
  assert.equal(Object.hasOwn(repository.getGroup(gid, [a, b]), 'secret'), false);
});

test('初始化前拒绝操作，布局路径为目录或数据根被换成 junction 时拒绝保存', async () => {
  const unopened = new LayoutRepository(path.join(os.tmpdir(), `screenshot-clothesline-layout-${randomUUID()}`));
  await assert.rejects(unopened.apply({ type: 'move', id: photo(1).id, beforeId: null }, [photo(1)]), /尚未初始化/);
  const { directory, repository } = await temporaryRepository();
  const catalog = [photo(1)];
  await fs.mkdir(path.join(directory, 'layout.json'));
  await assert.rejects(repository.apply({ type: 'move', id: catalog[0].id, beforeId: null }, catalog), /不是普通文件/);
  const restored = new LayoutRepository(directory); await assert.rejects(restored.init(), /不是普通文件/);
  const safe = await temporaryRepository();
  const original = `${safe.directory}-original`;
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'screenshot-clothesline-layout-external-'));
  await fs.writeFile(path.join(external, 'external.txt'), '外部内容');
  await fs.rename(safe.directory, original);
  await fs.symlink(external, safe.directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(safe.repository.apply({ type: 'move', id: catalog[0].id, beforeId: null }, catalog), /数据目录发生变化/);
  assert.deepEqual(await fs.readdir(external), ['external.txt']);
});

async function photoGroupRepository(count = 6) {
  const catalog = Array.from({ length: count }, (_, index) => photo(index + 1));
  const groupId = `group-${randomUUID()}`;
  const created = await temporaryRepository({ version: 1, revision: 4, order: [groupId],
    groups: [{ id: groupId, kind: 'photo', name: '批量测试组', memberIds: catalog.map(item => item.id) }] });
  return { ...created, catalog, groupId };
}

test('批量排序按组内原顺序稳定移动，不采信选择数组次序，重启保留', async () => {
  const { directory, repository, catalog, groupId } = await photoGroupRepository();
  const [a, b, c, d, e, f] = catalog.map(item => item.id);
  const operation = { type: 'move-many', groupId, ids: [e, b], beforeId: f };
  const pending = repository.apply(operation, catalog);
  operation.ids[0] = a; operation.beforeId = a;
  const after = await pending;
  assert.equal(after.revision, 5);
  assert.deepEqual(repository.getGroup(groupId, catalog).memberIds, [a, c, d, b, e, f]);
  assert.deepEqual(ids(after), [groupId]);
  await repository.apply({ type: 'move-many', groupId, ids: [e, b], beforeId: a }, catalog);
  assert.deepEqual(repository.getGroup(groupId, catalog).memberIds, [b, e, a, c, d, f]);
  await repository.apply({ type: 'move-many', groupId, ids: [b, e], beforeId: null }, catalog);
  assert.deepEqual(repository.getGroup(groupId, catalog).memberIds, [a, c, d, f, b, e]);
  const restored = new LayoutRepository(directory); await restored.init();
  assert.deepEqual(restored.getView(catalog), repository.getView(catalog));
});

test('批量排序相邻原位和全选不会颠倒、遗漏或重复成员', async () => {
  const { repository, catalog, groupId } = await photoGroupRepository();
  const original = catalog.map(item => item.id);
  await repository.apply({ type: 'move-many', groupId, ids: [original[2], original[1]], beforeId: original[3] }, catalog);
  assert.deepEqual(repository.getGroup(groupId, catalog).memberIds, original);
  await repository.apply({ type: 'move-many', groupId, ids: [...original].reverse(), beforeId: null }, catalog);
  assert.deepEqual(repository.getGroup(groupId, catalog).memberIds, original);
  await repository.apply({ type: 'move-many', groupId, ids: [original[0]], beforeId: original[1] }, catalog);
  assert.deepEqual(repository.getGroup(groupId, catalog).memberIds, original);
});

test('批量整理拒绝顶层、便签组、跨组、重复和所选目标，拒绝时原文件不变', async () => {
  const { directory, repository, catalog, groupId } = await photoGroupRepository();
  const extra = photo(30), other = photo(31), firstNote = note(1), secondNote = note(2);
  catalog.push(extra, other, firstNote, secondNote);
  const otherGroup = await group(repository, extra, other, catalog);
  const noteGroup = await group(repository, firstNote, secondNote, catalog);
  const before = repository.getView(catalog);
  const bytes = await fs.readFile(path.join(directory, 'layout.json'));
  const base = { type: 'move-many', groupId, ids: [catalog[0].id], beforeId: null };
  for (const operation of [
    { ...base, groupId: null }, { ...base, groupId: `group-${randomUUID()}` },
    { ...base, ids: [] }, { ...base, ids: 'bad' }, { ...base, ids: [catalog[0].id, catalog[0].id] },
    { ...base, ids: [catalog[0].id, extra.id] }, { ...base, groupId: otherGroup.id },
    { ...base, groupId: noteGroup.id, ids: [firstNote.id] },
    { ...base, ids: [firstNote.id] }, { ...base, beforeId: catalog[0].id },
    { ...base, beforeId: extra.id }, { ...base, ids: ['../index.json'] },
  ]) await assert.rejects(repository.apply(operation, catalog));
  assert.deepEqual(repository.getView(catalog), before);
  assert.deepEqual(await fs.readFile(path.join(directory, 'layout.json')), bytes);
});

test('批量排序接受最多100张并拒绝101张，整组允许保留更多成员', async () => {
  assert.equal(MAX_BATCH_PHOTOS, 100);
  const { directory, repository, catalog, groupId } = await photoGroupRepository(MAX_BATCH_PHOTOS + 1);
  const selected = catalog.slice(0, MAX_BATCH_PHOTOS).map(item => item.id);
  await repository.apply({ type: 'move-many', groupId, ids: [...selected].reverse(), beforeId: null }, catalog);
  assert.deepEqual(repository.getGroup(groupId, catalog).memberIds, [catalog.at(-1).id, ...selected]);
  const bytes = await fs.readFile(path.join(directory, 'layout.json'));
  await assert.rejects(repository.apply({ type: 'move-many', groupId, ids: catalog.map(item => item.id), beforeId: null }, catalog), /100/);
  assert.deepEqual(await fs.readFile(path.join(directory, 'layout.json')), bytes);
});

test('批量排序只原子写入一次，失败不发布并可重试', async () => {
  const { directory, repository, catalog, groupId } = await photoGroupRepository();
  const before = repository.getView(catalog);
  const bytes = await fs.readFile(path.join(directory, 'layout.json'));
  const originalWrite = repository._atomicWrite.bind(repository);
  let writes = 0;
  repository._atomicWrite = async () => { writes += 1; throw new Error('模拟磁盘不可写'); };
  const operation = { type: 'move-many', groupId, ids: [catalog[0].id, catalog[2].id], beforeId: null };
  await assert.rejects(repository.apply(operation, catalog), /磁盘不可写/);
  assert.equal(writes, 1); assert.deepEqual(repository.getView(catalog), before);
  assert.deepEqual(await fs.readFile(path.join(directory, 'layout.json')), bytes);
  repository._atomicWrite = async layout => { writes += 1; await originalWrite(layout); };
  await repository.apply(operation, catalog); assert.equal(writes, 2);
  assert.equal(repository.getView(catalog).revision, before.revision + 1);
  assert.deepEqual(repository.getGroup(groupId, catalog).memberIds,
    [catalog[1], catalog[3], catalog[4], catalog[5], catalog[0], catalog[2]].map(item => item.id));
});

test('批量排序入队后使用最新目录，保存中移出的旧hash重新导入也不会复活为组成员', async () => {
  const { repository, catalog, groupId } = await photoGroupRepository();
  const originalWrite = repository._atomicWrite.bind(repository);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const writing = new Promise(resolve => { started = resolve; });
  repository._atomicWrite = async layout => { started(); await gate; await originalWrite(layout); };
  const pending = repository.apply({ type: 'move-many', groupId, ids: [catalog[0].id, catalog[2].id], beforeId: null }, catalog);
  await writing;
  repository.getView(catalog.filter(item => item.id !== catalog[0].id));
  repository.getView(catalog);
  release(); await pending;
  assert.equal(repository.getView(catalog).items[0].id, catalog[0].id);
  assert.deepEqual(repository.getGroup(groupId, catalog).memberIds,
    [catalog[1], catalog[3], catalog[4], catalog[5], catalog[2]].map(item => item.id));
  const stale = repository.apply({ type: 'move-many', groupId, ids: [catalog[0].id], beforeId: null }, catalog);
  await assert.rejects(stale, /当前图片组/);
});
