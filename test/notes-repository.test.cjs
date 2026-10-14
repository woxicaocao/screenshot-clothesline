'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { NotesRepository, normalizeNoteInput, MAX_NOTE_LENGTH } = require('../src/lib/notes-repository.cjs');

async function temporaryRepository() {
  // 测试目录保留，不自动删除文件。
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'screenshot-clothesline-notes-'));
  const repository = new NotesRepository(directory);
  await repository.init();
  return { directory, repository };
}

function payload(text = '第一行\n第二行') {
  return { text, color: '#FFF2B8', fontSize: 20, alwaysOnTop: false, bounds: { x: -100, y: 40, width: 360, height: 430 } };
}

test('新便签保存后重启恢复完整文字、颜色、字号、置顶和窗口位置', async () => {
  const { directory, repository } = await temporaryRepository();
  assert.deepEqual(repository.getNotes(), []);
  const saved = await repository.saveNote({ ...payload(), alwaysOnTop: true });
  assert.equal(saved.added, true);
  assert.match(saved.note.id, /^note-[a-f0-9-]{36}$/);
  assert.equal(saved.note.text, '第一行\n第二行');
  assert.equal(saved.note.color, '#fff2b8');
  assert.equal(saved.note.fontSize, 20);
  assert.equal(saved.note.alwaysOnTop, true);
  const index = JSON.parse(await fs.readFile(path.join(directory, 'notes.json'), 'utf8'));
  assert.equal(index.version, 1);
  assert.deepEqual(index.notes, [saved.note]);
  const restored = new NotesRepository(directory);
  await restored.init();
  assert.deepEqual(restored.getNotes(), [saved.note]);
});

test('新空白便签不产生索引，已有便签清空仍保留身份和创建时间', async () => {
  const { directory, repository } = await temporaryRepository();
  for (const text of ['', ' \r\n\t', '\u3000']) assert.equal(await repository.saveNote(payload(text)), null);
  assert.deepEqual(await fs.readdir(directory), []);
  const saved = await repository.saveNote(payload());
  const cleared = await repository.saveNote({ ...payload(''), id: saved.note.id });
  assert.equal(cleared.added, false);
  assert.equal(cleared.note.id, saved.note.id);
  assert.equal(cleared.note.createdAt, saved.note.createdAt);
  assert.equal(cleared.note.text, '');
  const restored = new NotesRepository(directory);
  await restored.init();
  assert.equal(restored.getNotes().length, 1);
  assert.equal(restored.getNote(saved.note.id).text, '');
});

test('输入规范化只返回允许字段，自定义颜色统一小写，默认字号为14', () => {
  assert.deepEqual(normalizeNoteInput({ text: '简洁便签', injected: '<script>', createdAt: '伪造' }), {
    text: '简洁便签', color: '#fff2b8', fontSize: 14, alwaysOnTop: false, bounds: null,
  });
  const input = { ...payload(), color: '#12AbEF', bounds: { ...payload().bounds, filename: '外部文件' } };
  const normalized = normalizeNoteInput(input);
  assert.equal(normalized.color, '#12abef');
  assert.deepEqual(normalized.bounds, payload().bounds);
  assert.equal(Object.hasOwn(normalized, 'filename'), false);
  input.bounds.x = 200;
  assert.equal(normalized.bounds.x, -100);
});

test('过长文字、无效颜色、非法字号和位置被拒绝，旧索引不改写', async () => {
  const { directory, repository } = await temporaryRepository();
  const saved = await repository.saveNote(payload());
  const previousIndex = await fs.readFile(path.join(directory, 'notes.json'));
  const invalid = [
    null, [], { ...payload(), text: null }, { ...payload(), text: '字'.repeat(MAX_NOTE_LENGTH + 1) },
    ...['red', '#fff', '#aabbccdd', '#aaGG00', null].map((color) => ({ ...payload(), color })),
    ...[13, 33, 20.5, '20', NaN, Infinity].map((fontSize) => ({ ...payload(), fontSize })),
    { ...payload(), alwaysOnTop: 1 }, { ...payload(), bounds: { x: 0, y: 0, width: -1, height: 40 } },
    { ...payload(), bounds: { x: 0, y: 0, width: 16_385, height: 40 } },
    { ...payload(), bounds: { x: Infinity, y: 0, width: 360, height: 430 } },
    { ...payload(), id: '../outside.json' },
  ];
  for (const input of invalid) await assert.rejects(repository.saveNote(input), TypeError);
  await assert.rejects(repository.saveNote({ ...payload(), id: `note-${randomUUID()}` }), /不存在/);
  assert.deepEqual(repository.getNotes(), [saved.note]);
  assert.deepEqual(await fs.readFile(path.join(directory, 'notes.json')), previousIndex);
  assert.equal((await repository.saveNote(payload('字'.repeat(MAX_NOTE_LENGTH)))).note.text.length, MAX_NOTE_LENGTH);
});

test('并发保存与更新按队列执行，返回对象和调用方数据均不泄露可变引用', async () => {
  const { repository } = await temporaryRepository();
  const input = payload('排队前内容');
  const pending = repository.saveNote(input);
  input.text = '调用方随后改动';
  input.bounds.x = 200;
  const first = await pending;
  assert.equal(first.note.text, '排队前内容');
  assert.equal(first.note.bounds.x, -100);
  const results = await Promise.all([
    repository.saveNote({ ...payload('更新一'), id: first.note.id }),
    repository.saveNote(payload('第二张')),
    repository.saveNote({ ...payload('更新二'), id: first.note.id, fontSize: 32, color: '#abc123' }),
  ]);
  assert.deepEqual(results.map((result) => result.added), [false, true, false]);
  assert.equal(repository.getNotes().length, 2);
  assert.equal(repository.getNote(first.note.id).text, '更新二');
  first.note.text = '返回对象改动';
  results[2].note.bounds.x = 500;
  const notes = repository.getNotes();
  notes[0].text = '列表改动';
  assert.equal(repository.getNote(first.note.id).text, '更新二');
  assert.equal(repository.getNote(first.note.id).bounds.x, -100);
  assert.equal(repository.getNote(`note-${randomUUID()}`), null);
});

test('修改仅更新内容和更新时间，不改变创建顺序、身份和其他便签', async () => {
  const { directory, repository } = await temporaryRepository();
  const older = { ...payload('旧便签'), id: `note-${randomUUID()}`, createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z' };
  const newer = { ...payload('新便签'), id: `note-${randomUUID()}`, createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z' };
  await fs.writeFile(path.join(directory, 'notes.json'), JSON.stringify({ version: 1, notes: [older, newer] }));
  const restored = new NotesRepository(directory);
  await restored.init();
  const before = restored.getNotes();
  assert.deepEqual(before.map((note) => note.id), [newer.id, older.id]);
  const result = await restored.saveNote({ ...payload('改写旧便签'), id: older.id });
  assert.equal(result.note.createdAt, older.createdAt);
  assert.notEqual(result.note.updatedAt, older.updatedAt);
  assert.deepEqual(restored.getNotes().map((note) => note.id), [newer.id, older.id]);
  assert.deepEqual(restored.getNote(newer.id), before[0]);
  assert.deepEqual(repository.getNotes(), []);
});

test('原子发布失败保留旧索引和pending内容，后续重试成功且内存不会提前新增', async (t) => {
  const { directory, repository } = await temporaryRepository();
  const first = await repository.saveNote(payload('已保存内容'));
  const destination = path.join(directory, 'notes.json');
  const previousIndex = await fs.readFile(destination);
  const rename = fs.rename;
  const mockedRename = t.mock.method(fs, 'rename', async (source, target) => {
    if (target === destination) throw Object.assign(new Error('模拟文件被占用'), { code: 'EACCES' });
    return rename(source, target);
  });
  await assert.rejects(repository.saveNote(payload('需重试的新便签')), /模拟文件被占用/);
  await assert.rejects(repository.saveNote({ ...payload('更新也失败'), id: first.note.id }), /模拟文件被占用/);
  mockedRename.mock.restore();
  assert.deepEqual(await fs.readFile(destination), previousIndex);
  assert.deepEqual(repository.getNotes(), [first.note]);
  const pending = (await fs.readdir(directory)).filter((name) => name.startsWith('notes.json.pending-'));
  assert.equal(pending.length, 2);
  for (const name of pending) assert.equal(JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')).version, 1);
  const retried = await repository.saveNote(payload('需重试的新便签'));
  assert.equal(retried.added, true);
  assert.equal(repository.getNotes().length, 2);
  for (const name of pending) await fs.access(path.join(directory, name));
});

test('索引损坏、重复标识和非法时间拒绝启动且保留原文件，未知字段不透出', async () => {
  const valid = { ...payload(), id: `note-${randomUUID()}`, createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z' };
  const invalidIndexes = [
    '{broken', JSON.stringify({ version: 2, notes: [] }), JSON.stringify({ version: 1, notes: [valid, valid] }),
    JSON.stringify({ version: 1, notes: [{ ...valid, updatedAt: 'invalid' }] }),
    JSON.stringify({ version: 1, notes: [{ ...valid, id: undefined }] }),
  ];
  for (const contents of invalidIndexes) {
    const { directory } = await temporaryRepository();
    const destination = path.join(directory, 'notes.json');
    await fs.writeFile(destination, contents, 'utf8');
    const repository = new NotesRepository(directory);
    await assert.rejects(repository.init(), /原文件已保留/);
    assert.deepEqual(repository.getNotes(), []);
    assert.equal(await fs.readFile(destination, 'utf8'), contents);
  }
  const { directory } = await temporaryRepository();
  await fs.writeFile(path.join(directory, 'notes.json'), JSON.stringify({ version: 1, unknown: true, notes: [{ ...valid, secret: '不透出' }] }));
  const restored = new NotesRepository(directory);
  await restored.init();
  assert.equal(Object.hasOwn(restored.getNotes()[0], 'secret'), false);
});

test('初始化前保存被拒绝，notes.json不是普通文件时不被改写', async () => {
  const unopened = new NotesRepository(path.join(os.tmpdir(), `screenshot-clothesline-notes-${randomUUID()}`));
  await assert.rejects(unopened.saveNote(payload()), /尚未初始化/);
  const { directory, repository } = await temporaryRepository();
  await fs.mkdir(path.join(directory, 'notes.json'));
  await assert.rejects(repository.saveNote(payload()), /不是普通文件/);
  assert.equal((await fs.lstat(path.join(directory, 'notes.json'))).isDirectory(), true);
  const restored = new NotesRepository(directory);
  await assert.rejects(restored.init(), /不是普通文件/);
});

test('初始化后数据目录被换成junction时拒绝保存，外部目录内容保持不变', async () => {
  const { directory, repository } = await temporaryRepository();
  await repository.saveNote(payload('保留原数据'));
  const original = `${directory}-original`;
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'screenshot-clothesline-notes-external-'));
  await fs.writeFile(path.join(external, 'external.txt'), '不应改写');
  await fs.rename(directory, original);
  await fs.symlink(external, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(repository.saveNote(payload('拒绝越界')), /数据目录发生变化/);
  assert.deepEqual(await fs.readdir(external), ['external.txt']);
  assert.equal(await fs.readFile(path.join(external, 'external.txt'), 'utf8'), '不应改写');
  assert.equal(JSON.parse(await fs.readFile(path.join(original, 'notes.json'), 'utf8')).notes[0].text, '保留原数据');
});

test('衣架摘要最多700字符，完整正文独立保留且摘要不会泄露可变引用', async () => {
  const { repository } = await temporaryRepository();
  const text = '完整便签文字\n'.repeat(5000);
  const saved = await repository.saveNote(payload(text));
  const [summary] = repository.getNoteSummaries();
  assert.equal(summary.text, text.slice(0, 700));
  assert.equal(Object.hasOwn(summary, 'bounds'), false);
  assert.deepEqual(Object.keys(summary).sort(), ['id', 'text', 'color', 'fontSize', 'alwaysOnTop', 'createdAt', 'updatedAt'].sort());
  summary.text = '不能修改原文'; summary.color = '#000000';
  assert.equal(repository.getNote(saved.note.id).text, text);
  assert.equal(repository.getNoteSummaries()[0].text, text.slice(0, 700));
  assert.equal(repository.getNoteSummaries()[0].color, '#fff2b8');
});

test('删除仅移除选中便签，重启不恢复它且其他便签和照片文件保留', async () => {
  const { directory, repository } = await temporaryRepository();
  const selected = await repository.saveNote(payload('用户选择删除的便签'));
  const other = await repository.saveNote(payload('保留的便签'));
  await fs.writeFile(path.join(directory, 'photos.json'), '照片数据不变');
  assert.deepEqual(await repository.deleteNote(selected.note.id), { id: selected.note.id, deleted: true });
  assert.equal(repository.getNote(selected.note.id), null);
  assert.deepEqual(repository.getNotes(), [other.note]);
  const restored = new NotesRepository(directory); await restored.init();
  assert.deepEqual(restored.getNotes(), [other.note]);
  assert.equal(await fs.readFile(path.join(directory, 'photos.json'), 'utf8'), '照片数据不变');
  const before = await fs.readFile(path.join(directory, 'notes.json'));
  assert.deepEqual(await repository.deleteNote(selected.note.id), { id: selected.note.id, deleted: false });
  assert.deepEqual(await fs.readFile(path.join(directory, 'notes.json')), before);
});

test('删除发布失败保留内存与旧索引，解除失败后可重试删除', async t => {
  const { directory, repository } = await temporaryRepository();
  const selected = await repository.saveNote(payload('不能提前消失的便签'));
  const destination = path.join(directory, 'notes.json');
  const original = await fs.readFile(destination);
  const rename = fs.rename;
  const mock = t.mock.method(fs, 'rename', async (source, target) => {
    if (target === destination) throw new Error('模拟删除时索引被占用');
    return rename(source, target);
  });
  await assert.rejects(repository.deleteNote(selected.note.id), /索引被占用/);
  mock.mock.restore();
  assert.deepEqual(repository.getNotes(), [selected.note]);
  assert.deepEqual(await fs.readFile(destination), original);
  assert.deepEqual(await repository.deleteNote(selected.note.id), { id: selected.note.id, deleted: true });
  assert.deepEqual(repository.getNotes(), []);
});

test('删除与保存按同一队列提交，删除后的旧id更新不会复活记录', async () => {
  const { directory, repository } = await temporaryRepository();
  const selected = await repository.saveNote(payload('原内容'));
  const updating = repository.saveNote({ ...payload('关闭窗口时的最新内容'), id: selected.note.id });
  const deleting = repository.deleteNote(selected.note.id);
  const staleUpdate = repository.saveNote({ ...payload('删除之后排入的旧窗口写入'), id: selected.note.id });
  const results = await Promise.allSettled([updating, deleting, staleUpdate]);
  assert.equal(results[0].status, 'fulfilled');
  assert.deepEqual(results[1].value, { id: selected.note.id, deleted: true });
  assert.equal(results[2].status, 'rejected');
  assert.match(results[2].reason.message, /不存在/);
  assert.deepEqual(repository.getNotes(), []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'notes.json'), 'utf8')).notes, []);
  const unopened = new NotesRepository(path.join(os.tmpdir(), `screenshot-clothesline-notes-${randomUUID()}`));
  await assert.rejects(unopened.deleteNote(selected.note.id), /尚未初始化/);
  for (const id of [null, '../notes.json', 1, 'note-invalid']) await assert.rejects(repository.deleteNote(id), TypeError);
});
