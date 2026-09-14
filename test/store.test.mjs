import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createStore, MIGRATIONS, schemaTables } from '../main/store.mjs';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-s-'));
  return path.join(dir, 'store.sqlite');
}

// ── 스키마 가드 (STOR-05, D-09) ──

test('스키마는 project·item·event 세 테이블만 만든다', () => {
  assert.deepEqual([...schemaTables()].sort(), ['event', 'item', 'project']);
});

// ── 열기·마이그레이션 ──

test('빈 파일로 열면 최신 버전까지 마이그레이션되고 정상 상태다', () => {
  const file = tmpFile();
  const store = createStore(file);
  assert.equal(store.status().ok, true);
  store.close();
  const raw = new DatabaseSync(file);
  const { user_version } = raw.prepare('PRAGMA user_version').get();
  assert.equal(user_version, MIGRATIONS.length);
  raw.close();
});

// ── 캡처 반영 → 오늘 뷰 ──

test('insertCaptures 뒤 getViewState().inbox에 그 제목이 있다', () => {
  const store = createStore(tmpFile());
  store.insertCaptures([
    { id: 'id-1', title: '테스트 캡처', abbr: null, captured_at: new Date().toISOString(), context: null },
  ]);
  const state = store.getViewState();
  assert.ok(state.inbox.some((it) => it.title === '테스트 캡처'));
  store.close();
});

test('같은 id로 두 번 insertCaptures 하면 행이 하나만 남는다', () => {
  const store = createStore(tmpFile());
  const entry = { id: 'id-dup', title: '중복 캡처', abbr: null, captured_at: new Date().toISOString(), context: null };
  store.insertCaptures([entry]);
  store.insertCaptures([entry]);
  const state = store.getViewState();
  assert.equal(state.inbox.filter((it) => it.id === 'id-dup').length, 1);
  store.close();
});

test('활성 프로젝트를 가리키는 약어는 todo로 붙고, 모르는 약어는 원문이 복원되어 inbox로 간다', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.close();
  // Task 2는 프로젝트 CRUD를 구현하지 않는다(01-04 몫) — 테스트가 직접 시드한다.
  const raw = new DatabaseSync(file);
  raw.prepare(`INSERT INTO project (name, abbr, status) VALUES (?, ?, 'active')`).run('GoWrite', 'gw');
  raw.close();
  store.reopen();
  store.insertCaptures([
    {
      id: 'id-known',
      title: '복사버튼 추가',
      abbr: 'gw',
      raw: '복사버튼 추가 #gw',
      captured_at: new Date().toISOString(),
      context: null,
    },
    {
      id: 'id-unknown',
      title: '엉뚱한 것',
      abbr: 'zz',
      raw: '엉뚱한 것 #zz',
      captured_at: new Date().toISOString(),
      context: null,
    },
  ]);
  const state = store.getViewState();
  const known = state.today.find((it) => it.id === 'id-known');
  assert.ok(known, 'gw로 붙은 항목이 today(todo)에 있어야 한다');
  assert.equal(known.kind, 'todo');
  assert.ok(known.project_id != null);
  const unknown = state.inbox.find((it) => it.id === 'id-unknown');
  assert.ok(unknown, '모르는 약어는 inbox에 남아야 한다');
  assert.equal(unknown.title, '엉뚱한 것 #zz');
  store.close();
});

test('context를 객체로 넣으면 getViewState()가 객체로 돌려준다', () => {
  const store = createStore(tmpFile());
  store.insertCaptures([
    {
      id: 'id-ctx',
      title: '컨텍스트 캡처',
      abbr: null,
      captured_at: new Date().toISOString(),
      context: { fg: '메모장' },
    },
  ]);
  const state = store.getViewState();
  const it = state.inbox.find((i) => i.id === 'id-ctx');
  assert.deepEqual(it.context, { fg: '메모장' });
  store.close();
});

test('done_at이 12시간보다 오래된 항목은 나오지 않고, 12시간 안이면 나온다', () => {
  const file = tmpFile();
  const store = createStore(file);
  const now = Date.now();
  store.insertCaptures([
    { id: 'id-old', title: '오래전에 끝남', abbr: null, captured_at: new Date(now).toISOString(), context: null },
    { id: 'id-recent', title: '최근에 끝남', abbr: null, captured_at: new Date(now).toISOString(), context: null },
  ]);
  store.close();
  const raw = new DatabaseSync(file);
  raw.prepare('UPDATE item SET done_at = ? WHERE id = ?').run(new Date(now - 13 * 3600_000).toISOString(), 'id-old');
  raw.prepare('UPDATE item SET done_at = ? WHERE id = ?').run(new Date(now - 1 * 3600_000).toISOString(), 'id-recent');
  raw.close();
  store.reopen();
  const state = store.getViewState();
  const all = [...state.today, ...state.inbox, ...state.waiting];
  assert.ok(!all.some((it) => it.id === 'id-old'), '12시간 넘은 완료 항목은 나오면 안 된다');
  assert.ok(all.some((it) => it.id === 'id-recent'), '12시간 안의 완료 항목은 나와야 한다');
  store.close();
});

test('due가 null인 항목은 due가 있는 항목보다 뒤에 온다', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.insertCaptures([
    { id: 'id-nodue', title: '마감 없음', abbr: null, captured_at: new Date(Date.now() - 2000).toISOString(), context: null },
    { id: 'id-due', title: '마감 있음', abbr: null, captured_at: new Date().toISOString(), context: null },
  ]);
  store.close();
  const raw = new DatabaseSync(file);
  raw.prepare('UPDATE item SET due = ? WHERE id = ?').run('2026-01-01', 'id-due');
  raw.close();
  store.reopen();
  const state = store.getViewState();
  const ids = state.inbox.map((it) => it.id);
  assert.ok(ids.indexOf('id-due') < ids.indexOf('id-nodue'), 'due 있는 항목이 앞에 와야 한다: ' + ids.join(','));
  store.close();
});
