import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createStore, MIGRATIONS } from '../main/store.mjs';

// v4 — 동기화의 바닥(D-P14·D-P26). 여기가 틀리면 어떤 쓰기는 다른 기기로 가지 않거나(updated_at이 안 바뀜),
// 두 기기가 같은 프로젝트를 다른 것으로 알거나(uid 없음·겹침), 첫 동기화에서 같은 데이터가 서로를 덮는다.

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-v4-')), 'store.sqlite');
const OLD = '2000-01-01T00:00:00.000Z';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function raw(file) {
  return new DatabaseSync(file);
}
function capture(store, id, title = '할 일') {
  store.insertCaptures([{ id, title, captured_at: '2026-11-10T01:00:00.000Z', context: null }]);
}
// 그 행의 updated_at을 아주 옛날로 돌려 둔다(직접 정하는 UPDATE라 트리거가 손대지 않는다)
function age(file, table, where) {
  const db = raw(file);
  db.prepare(`UPDATE ${table} SET updated_at = ? WHERE ${where}`).run(OLD);
  db.close();
}
function updatedAt(file, table, where) {
  const db = raw(file);
  const v = db.prepare(`SELECT updated_at FROM ${table} WHERE ${where}`).get()?.updated_at;
  db.close();
  return v;
}

test('새 프로젝트·새 항목은 uid와 updated_at을 갖는다 — uid는 서로 다르다', () => {
  const file = tmpFile();
  const store = createStore(file);
  const a = store.createProject('영업');
  const b = store.createProject('개발');
  capture(store, 'i1');
  store.close();
  const db = raw(file);
  const ps = db.prepare('SELECT id, uid, updated_at FROM project ORDER BY id').all();
  assert.equal(ps.length, 2);
  assert.ok(ps.every((p) => /^[0-9a-f]{32}$/.test(p.uid) && ISO.test(p.updated_at)));
  assert.notEqual(ps[0].uid, ps[1].uid);
  assert.ok(a && b);
  assert.match(db.prepare("SELECT updated_at FROM item WHERE id = 'i1'").get().updated_at, ISO);
  db.close();
});

test('앱의 쓰기 함수는 모두 updated_at을 새로 찍는다 — 하나라도 빠지면 그 변경은 다른 기기로 가지 않는다', () => {
  const file = tmpFile();
  const store = createStore(file);
  const pid = store.createProject('영업');
  capture(store, 'i1');
  const writes = [
    ['completeItem', () => store.completeItem('i1')],
    ['uncompleteItem', () => store.uncompleteItem('i1')],
    ['assignProject', () => store.assignProject('i1', pid)],
    ['setDue', () => store.setDue('i1', '2026-12-01')],
    ['toWaiting', () => store.toWaiting('i1', '김 대리')],
    ['renameItem', () => store.renameItem('i1', '새 제목')],
    ['setNote', () => store.setNote('i1', '메모')],
    ['nudgeItem', () => store.nudgeItem('i1')],
    ['removeItem', () => store.removeItem('i1')],
    ['restoreItem', () => store.restoreItem('i1')],
  ];
  for (const [name, fn] of writes) {
    age(file, 'item', "id = 'i1'");
    fn();
    assert.notEqual(updatedAt(file, 'item', "id = 'i1'"), OLD, name);
  }
  for (const [name, fn] of [
    ['updateProject', () => store.updateProject(pid, { name: '영업팀' })],
    ['deleteProject', () => store.deleteProject(pid)],
    ['restoreProject', () => store.restoreProject(pid)],
  ]) {
    age(file, 'project', `id = ${pid}`);
    fn();
    assert.notEqual(updatedAt(file, 'project', `id = ${pid}`), OLD, name);
  }
  store.close();
});

test('프로젝트를 지우면 인박스로 옮겨진 항목도 바뀐 것으로 찍힌다', () => {
  const file = tmpFile();
  const store = createStore(file);
  const pid = store.createProject('영업');
  capture(store, 'i1');
  store.assignProject('i1', pid);
  age(file, 'item', "id = 'i1'");
  store.deleteProject(pid);
  assert.notEqual(updatedAt(file, 'item', "id = 'i1'"), OLD);
  store.close();
});

test('문장이 updated_at을 직접 정하면 트리거가 덮어쓰지 않는다 — 동기화가 받아 적는 길', () => {
  const file = tmpFile();
  const store = createStore(file);
  capture(store, 'i1');
  store.close();
  const db = raw(file);
  db.prepare("UPDATE item SET title = '다른 기기에서', updated_at = '2026-11-12T09:00:00.000Z' WHERE id = 'i1'").run();
  db.prepare("INSERT INTO project (name, uid, updated_at) VALUES ('받은 것', 'remoteuid', '2026-11-12T09:00:00.000Z')").run();
  assert.equal(db.prepare("SELECT updated_at FROM item WHERE id = 'i1'").get().updated_at, '2026-11-12T09:00:00.000Z');
  assert.deepEqual({ ...db.prepare("SELECT uid, updated_at FROM project WHERE name = '받은 것'").get() }, { uid: 'remoteuid', updated_at: '2026-11-12T09:00:00.000Z' });
  db.close();
});

test('v3에서 이행: 모든 프로젝트에 겹치지 않는 uid, 항목의 updated_at은 그 행의 가장 늦은 시각', () => {
  const file = tmpFile();
  const db = raw(file);
  for (let v = 0; v < 3; v++) MIGRATIONS[v](db);
  db.exec('PRAGMA user_version = 3');
  db.exec("INSERT INTO project (name) VALUES ('영업'), ('개발')");
  db.exec("INSERT INTO project (name, status, deleted_at) VALUES ('옛것', 'archived', '2026-10-01T00:00:00.000Z')");
  db.exec(`INSERT INTO item (id, title, captured_at) VALUES ('a', 'a', '2026-11-01T00:00:00.000Z')`);
  db.exec(`INSERT INTO item (id, title, captured_at, done_at) VALUES ('b', 'b', '2026-11-01T00:00:00.000Z', '2026-11-05T00:00:00.000Z')`);
  db.exec(`INSERT INTO item (id, title, captured_at, done_at, deleted_at) VALUES ('c', 'c', '2026-11-01T00:00:00.000Z', '2026-11-05T00:00:00.000Z', '2026-11-07T00:00:00.000Z')`);
  db.exec(`INSERT INTO item (id, title, captured_at, nudged_at) VALUES ('d', 'd', '2026-11-01T00:00:00.000Z', '2026-11-09T00:00:00.000Z')`);
  db.close();

  const store = createStore(file);
  assert.equal(store.status().ok, true);
  store.close();
  const after = raw(file);
  assert.equal(after.prepare('PRAGMA user_version').get().user_version, 4);
  const uids = after.prepare('SELECT uid FROM project').all().map((r) => r.uid);
  assert.equal(new Set(uids).size, 3);
  assert.ok(uids.every((u) => /^[0-9a-f]{32}$/.test(u)));
  assert.equal(after.prepare("SELECT updated_at FROM project WHERE name = '옛것'").get().updated_at, '2026-10-01T00:00:00.000Z');
  const at = (id) => after.prepare('SELECT updated_at FROM item WHERE id = ?').get(id).updated_at;
  assert.equal(at('a'), '2026-11-01T00:00:00.000Z');
  assert.equal(at('b'), '2026-11-05T00:00:00.000Z');
  assert.equal(at('c'), '2026-11-07T00:00:00.000Z');
  assert.equal(at('d'), '2026-11-09T00:00:00.000Z');
  after.close();
  // 이행 직전 백업이 남는다(D-16)
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.includes('backup') || f.endsWith('.bak') || f.includes('pre')));
});

test('같은 uid는 두 번 들어가지 않는다', () => {
  const file = tmpFile();
  createStore(file).close();
  const db = raw(file);
  db.exec("INSERT INTO project (name, uid) VALUES ('가', 'same')");
  assert.throws(() => db.exec("INSERT INTO project (name, uid) VALUES ('나', 'same')"), /UNIQUE/);
  db.close();
});

test('내보내기·가져오기는 uid·updated_at·지운 시각을 그대로 옮긴다 — 옛 파일은 새로 채운다', () => {
  const a = createStore(tmpFile());
  const pid = a.createProject('영업');
  capture(a, 'i1');
  a.assignProject('i1', pid);
  a.createProject('지울 것');
  a.deleteProject(a.getProjects().find((p) => p.name === '지울 것').id);
  const data = a.exportAll();
  a.close();
  const p = data.project.find((x) => x.name === '영업');
  assert.match(p.uid, /^[0-9a-f]{32}$/);
  assert.match(data.item[0].updated_at, ISO);
  const gone = data.project.find((x) => x.name === '지울 것');
  assert.ok(gone.deleted_at);

  const bFile = tmpFile();
  const b = createStore(bFile);
  b.importAll(data);
  const again = b.exportAll();
  b.close();
  const strip = (d) => ({ project: d.project, item: d.item });
  assert.deepEqual(strip(again), strip(data));

  // v3 시절 파일(uid·updated_at 없음)
  const cFile = tmpFile();
  const c = createStore(cFile);
  c.importAll({ app: 'whenwork', schema_version: 3, project: [{ id: 1, name: '영업' }, { id: 2, name: '옛것', status: 'archived' }], item: [{ id: 'x', title: 'x', captured_at: '2026-11-01T00:00:00.000Z', project_id: 1 }], event: [] });
  const out = c.exportAll();
  c.close();
  assert.ok(out.project.every((r) => /^[0-9a-f]{32}$/.test(r.uid) && ISO.test(r.updated_at)));
  assert.ok(out.project.find((r) => r.name === '옛것').deleted_at, '옛 보관 프로젝트에는 지운 시각을 채운다');
  assert.match(out.item[0].updated_at, ISO);
});
