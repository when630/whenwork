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

// ── 열기 실패를 정직하게 다루기 (Task 3: 손상 격리·상위 버전 거부·이행 전 백업) ──

test('쓰레기 바이트 파일은 store.corrupt-*.sqlite로 보존되고 빈 DB로 새로 열린다', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'not a database at all');
  const store = createStore(file);
  const st = store.status();
  assert.equal(st.ok, true, '손상된 원본은 옆으로 옮기고 빈 DB로 열려야 한다');
  assert.equal(st.reason, 'corrupt');
  assert.ok(st.notice && st.notice.length > 0);
  assert.ok(!st.notice.includes(file), '안내 문구에 절대 경로가 없어야 한다');
  assert.ok(!st.notice.includes('Error'), '안내 문구에 에러 객체 문자열이 없어야 한다');
  assert.ok(st.quarantined, '격리 파일 이름이 있어야 한다');
  assert.ok(
    fs.existsSync(path.join(path.dirname(file), st.quarantined)),
    '격리 파일이 실제로 남아 있어야 한다'
  );
  store.close();
});

test('격리 파일 이름에는 콜론과(확장자 앞을 뺀) 점이 들어가지 않는다', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'garbage');
  const store = createStore(file);
  const { quarantined } = store.status();
  assert.match(quarantined, /^store\.corrupt-[^:.]+\.sqlite$/, 'Windows 파일명 제약을 지켜야 한다: ' + quarantined);
  store.close();
});

test('MIGRATIONS.length보다 높은 user_version의 DB는 열지 않고 newer로 거부한다', () => {
  const file = tmpFile();
  let store = createStore(file);
  store.close();
  const raw = new DatabaseSync(file);
  raw.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  raw.close();
  store = createStore(file);
  const st = store.status();
  assert.equal(st.ok, false);
  assert.equal(st.reason, 'newer');
  assert.ok(st.notice && st.notice.length > 0);
  assert.ok(!st.notice.includes(file));
  assert.ok(!st.notice.includes('Error'));
  const result = store.insertCaptures([
    { id: 'x', title: 'x', abbr: null, captured_at: new Date().toISOString(), context: null },
  ]);
  assert.equal(result.inserted, 0, '상위 버전 DB에는 아무것도 쓰이지 않아야 한다');
  const dirFiles = fs.readdirSync(path.dirname(file));
  assert.ok(!dirFiles.some((f) => f.includes('corrupt')), '상위 버전 파일은 격리 대상이 아니다(옮기지 않는다)');
  const check = new DatabaseSync(file);
  const { user_version } = check.prepare('PRAGMA user_version').get();
  assert.equal(user_version, MIGRATIONS.length + 1, 'user_version은 그대로여야 한다');
  check.close();
});

test('열기 자체가 실패하면(디렉터리 등) 파일을 옮기지 않고 locked/error로 처리한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-s-'));
  const file = path.join(dir, 'store.sqlite');
  fs.mkdirSync(file); // 파일 자리에 디렉터리를 두어 열기 자체가 실패하게 만든다(권한·잠김류와 같은 취급)
  const store = createStore(file);
  const st = store.status();
  assert.ok(st.reason === 'locked' || st.reason === 'error', 'locked 또는 error여야 한다: ' + JSON.stringify(st));
  assert.equal(st.quarantined, null);
  assert.ok(fs.statSync(file).isDirectory(), '디렉터리가 그대로 있어야 한다(옮기지 않음)');
});

test('user_version이 실제로 오를 때만 이행 직전 백업이 생기고, 그 뒤 버전이 N이다', () => {
  const file = tmpFile();
  let store = createStore(file); // v1까지 정상적으로 마이그레이션
  store.close();
  // 다음 버전이 필요해진 상황을 흉내낸다 — 배포된 MIGRATIONS[0]은 건드리지 않고
  // 테스트 안에서만 임시로 밀어 넣었다가 되돌린다(D-12: 이미 배포된 함수는 고치지 않는다).
  MIGRATIONS.push(() => {});
  try {
    store = createStore(file);
    assert.equal(store.status().ok, true);
    const backupDir = path.join(path.dirname(file), 'backups');
    const backups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
    assert.ok(
      backups.some((f) => /^store-v1-\d{8}\.sqlite$/.test(f)),
      '백업 파일이 있어야 한다: ' + backups.join(',')
    );
    store.close();
    const raw = new DatabaseSync(file);
    const { user_version } = raw.prepare('PRAGMA user_version').get();
    assert.equal(user_version, 2);
    raw.close();
  } finally {
    MIGRATIONS.pop();
  }
});

test('새로 만든 빈 DB(v0에서 시작)는 백업 파일을 만들지 않는다', () => {
  const file = tmpFile();
  const store = createStore(file);
  const backupDir = path.join(path.dirname(file), 'backups');
  assert.equal(fs.existsSync(backupDir), false, 'v0에서 시작하면 백업 폴더 자체가 생기면 안 된다');
  store.close();
});

test('백업 폴더를 만들 수 없어도 마이그레이션은 끝까지 진행된다', () => {
  const file = tmpFile();
  let store = createStore(file); // v1까지
  store.close();
  const backupsPath = path.join(path.dirname(file), 'backups');
  fs.writeFileSync(backupsPath, '나는 폴더가 아니라 파일이다'); // mkdir이 실패하도록 자리를 막는다
  MIGRATIONS.push(() => {});
  try {
    store = createStore(file);
    assert.equal(store.status().ok, true, '백업 실패에도 이행은 끝까지 진행돼야 한다');
    store.close();
    const raw = new DatabaseSync(file);
    const { user_version } = raw.prepare('PRAGMA user_version').get();
    assert.equal(user_version, 2);
    raw.close();
  } finally {
    MIGRATIONS.pop();
  }
});
