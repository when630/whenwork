import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createStore, MIGRATIONS, schemaTables } from '../main/store.mjs';
import { briefingLines } from '../main/brief.mjs';
import { createQueue } from '../main/queue.mjs';

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
  // CR-01: 저장소가 열리지 않은 상태에서는 던져야 한다 — 호출부(queue.replayPending·
  // ipc.saveCapture)가 "던지면 실패"를 계약으로 삼고 있어, 조용히 {inserted:0}을 돌려주면
  // 반영 실패가 성공으로 오인되어 대기 큐 파일이 지워지고 캡처가 영구 유실된다.
  assert.throws(
    () =>
      store.insertCaptures([
        { id: 'x', title: 'x', abbr: null, captured_at: new Date().toISOString(), context: null },
      ]),
    '상위 버전 DB에는 아무것도 쓰이지 않아야 하고, 호출부가 실패로 인식하도록 던져야 한다'
  );
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

// ── 프로젝트·항목 조작 (01-04 Task 1) ──

test('createProject는 정수 id를 돌려주고 같은 이름으로 다시 부르면 새 행이 생기지 않는다', () => {
  const store = createStore(tmpFile());
  const id = store.createProject('가');
  assert.equal(typeof id, 'number');
  const again = store.createProject('가');
  assert.equal(again, null, '같은 이름으로 다시 부르면 새 행이 생기지 않아야 한다');
  assert.equal(store.getProjects().length, 1);
  store.close();
});

test('moveProject 뒤 getProjects() 순서가 바뀌고 sort가 0..n으로 정규화된다', () => {
  const store = createStore(tmpFile());
  const a = store.createProject('가');
  const b = store.createProject('나');
  const c = store.createProject('다');
  store.moveProject(c, 'up'); // 원래 순서 a,b,c에서 c가 한 칸 앞으로 — b와 자리를 바꾼다
  const projects = store.getProjects();
  assert.deepEqual(projects.map((p) => p.id), [a, c, b]);
  assert.deepEqual(projects.map((p) => p.sort), [0, 1, 2]);
  store.close();
});

test('assignProject는 kind를 todo로 바꾸지만 keepKind가 true면 대기 항목이 대기 탭에 남는다', () => {
  const store = createStore(tmpFile());
  const pid = store.createProject('프로젝트');

  store.insertCaptures([
    { id: 'id-w', title: '대기 항목', abbr: null, captured_at: new Date().toISOString(), context: null },
  ]);
  store.toWaiting('id-w', '회신 대기');
  store.assignProject('id-w', pid, true);
  let state = store.getViewState();
  assert.ok(state.waiting.some((it) => it.id === 'id-w'), 'keepKind면 대기 탭에 남아야 한다');

  store.insertCaptures([
    { id: 'id-i', title: '인박스 항목', abbr: null, captured_at: new Date().toISOString(), context: null },
  ]);
  store.assignProject('id-i', pid);
  state = store.getViewState();
  assert.ok(state.today.some((it) => it.id === 'id-i'), 'keepKind가 없으면 todo로 바뀌어야 한다');
  store.close();
});

test('completeItem 뒤 done_at이 ISO 8601 UTC 문자열이고 uncompleteItem이 다시 비운다', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.insertCaptures([
    { id: 'id-done', title: '완료 테스트', abbr: null, captured_at: new Date().toISOString(), context: null },
  ]);
  store.completeItem('id-done');
  store.close();

  const raw = new DatabaseSync(file);
  const row = raw.prepare('SELECT done_at FROM item WHERE id = ?').get('id-done');
  assert.ok(row.done_at && !Number.isNaN(new Date(row.done_at).getTime()), 'done_at은 ISO 문자열이어야 한다');
  raw.close();

  const store2 = createStore(file);
  store2.uncompleteItem('id-done');
  store2.close();
  const raw2 = new DatabaseSync(file);
  const row2 = raw2.prepare('SELECT done_at FROM item WHERE id = ?').get('id-done');
  assert.equal(row2.done_at, null);
  raw2.close();
});

test('nudgeItem을 30분 안에 두 번 부르면 두 번째는 repeated:true이고 count가 오르지 않는다, nudgeRestore로 직전 값이 되돌아온다', () => {
  const store = createStore(tmpFile());
  store.insertCaptures([
    { id: 'id-n', title: '대기 항목', abbr: null, captured_at: new Date().toISOString(), context: null },
  ]);
  store.toWaiting('id-n', '회신 대기');

  const first = store.nudgeItem('id-n');
  assert.equal(first.repeated, false);
  assert.equal(first.count, 1);

  const second = store.nudgeItem('id-n');
  assert.equal(second.repeated, true, '30분 안의 재촉은 반복으로 잡혀야 한다');
  assert.equal(second.count, 1, '30분 안의 재촉은 횟수가 오르면 안 된다');

  store.nudgeRestore('id-n', second.prev.at, second.prev.count);
  const state = store.getViewState();
  const item = state.waiting.find((it) => it.id === 'id-n');
  assert.equal(item.nudge_count, second.prev.count);
  assert.equal(item.nudged_at, second.prev.at);
  store.close();
});

test('removeItem 뒤 getViewState()에서 사라지지만 행은 남아 있고 restoreItem이 되살린다', () => {
  const store = createStore(tmpFile());
  store.insertCaptures([
    { id: 'id-rm', title: '지울 항목', abbr: null, captured_at: new Date().toISOString(), context: null },
  ]);
  store.removeItem('id-rm');
  let state = store.getViewState();
  assert.ok(
    ![...state.today, ...state.inbox, ...state.waiting].some((it) => it.id === 'id-rm'),
    '삭제 표시된 항목은 오늘 뷰에 없어야 한다'
  );
  store.restoreItem('id-rm');
  state = store.getViewState();
  assert.ok(state.inbox.some((it) => it.id === 'id-rm'), '복구하면 다시 보여야 한다');
  store.close();
});

test('purgeDeleted(30)은 30일보다 오래 전에 지워진 행만 실제로 지우고 그 수를 돌려준다', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.insertCaptures([
    { id: 'id-old-del', title: '오래전 삭제', abbr: null, captured_at: new Date().toISOString(), context: null },
    { id: 'id-recent-del', title: '최근 삭제', abbr: null, captured_at: new Date().toISOString(), context: null },
  ]);
  store.close();

  const now = Date.now();
  const raw = new DatabaseSync(file);
  raw
    .prepare('UPDATE item SET deleted_at = ? WHERE id = ?')
    .run(new Date(now - 31 * 86400_000).toISOString(), 'id-old-del');
  raw
    .prepare('UPDATE item SET deleted_at = ? WHERE id = ?')
    .run(new Date(now - 1 * 86400_000).toISOString(), 'id-recent-del');
  raw.close();

  const store2 = createStore(file);
  const purged = store2.purgeDeleted(30);
  assert.equal(purged, 1);
  store2.close();

  const raw2 = new DatabaseSync(file);
  const remaining = raw2.prepare('SELECT id FROM item').all().map((r) => r.id);
  assert.ok(!remaining.includes('id-old-del'), '30일보다 오래 전에 지워진 행은 사라져야 한다');
  assert.ok(remaining.includes('id-recent-del'), '30일 안에 지워진 행은 남아야 한다');
  raw2.close();
});

test('purgeDeleted 경계 — 29일 전 삭제는 남고 31일 전 삭제는 지워진다 (T-01-04-02)', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.insertCaptures([
    { id: 'id-29', title: '29일 전 삭제', abbr: null, captured_at: new Date().toISOString(), context: null },
    { id: 'id-31', title: '31일 전 삭제', abbr: null, captured_at: new Date().toISOString(), context: null },
  ]);
  store.close();

  const now = Date.now();
  const raw = new DatabaseSync(file);
  raw.prepare('UPDATE item SET deleted_at = ? WHERE id = ?').run(new Date(now - 29 * 86400_000).toISOString(), 'id-29');
  raw.prepare('UPDATE item SET deleted_at = ? WHERE id = ?').run(new Date(now - 31 * 86400_000).toISOString(), 'id-31');
  raw.close();

  const store2 = createStore(file);
  const purged = store2.purgeDeleted(30);
  assert.equal(purged, 1);
  store2.close();

  const raw2 = new DatabaseSync(file);
  const remaining = raw2.prepare('SELECT id FROM item').all().map((r) => r.id);
  assert.ok(remaining.includes('id-29'), '29일 전 삭제는 유예 기간 안이라 남아야 한다');
  assert.ok(!remaining.includes('id-31'), '31일 전 삭제는 유예 기간을 넘겨 지워져야 한다');
  raw2.close();
});

test('getInbox()가 인박스 항목의 context를 객체로 돌려준다', () => {
  const store = createStore(tmpFile());
  store.insertCaptures([
    {
      id: 'id-inbox-ctx',
      title: '인박스 컨텍스트',
      abbr: null,
      captured_at: new Date().toISOString(),
      context: { fg: '메모장' },
    },
  ]);
  const inbox = store.getInbox();
  const item = inbox.find((it) => it.id === 'id-inbox-ctx');
  assert.deepEqual(item.context, { fg: '메모장' });
  store.close();
});

test('getProjects()는 status가 active인 것만 sort·id 순으로 돌려준다', () => {
  const store = createStore(tmpFile());
  const a = store.createProject('가');
  const b = store.createProject('나');
  store.archiveProject(a);
  const projects = store.getProjects();
  assert.deepEqual(projects.map((p) => p.id), [b]);
  store.close();
});

// ── 완료 이력·축소된 아침 브리핑 (01-04 Task 2) ──

test('getHistory(7)이 최근 7일 완료 항목을 done_at 내림차순으로 돌려주고 8일 전 항목은 빠진다, commits는 항상 빈 배열', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.insertCaptures([
    { id: 'id-h1', title: '최근 완료1', abbr: null, captured_at: new Date().toISOString(), context: null },
    { id: 'id-h2', title: '최근 완료2', abbr: null, captured_at: new Date().toISOString(), context: null },
    { id: 'id-h-old', title: '오래된 완료', abbr: null, captured_at: new Date().toISOString(), context: null },
  ]);
  store.close();

  const now = Date.now();
  const raw = new DatabaseSync(file);
  raw.prepare('UPDATE item SET done_at = ? WHERE id = ?').run(new Date(now - 1 * 86400_000).toISOString(), 'id-h1');
  raw.prepare('UPDATE item SET done_at = ? WHERE id = ?').run(new Date(now - 2 * 86400_000).toISOString(), 'id-h2');
  raw
    .prepare('UPDATE item SET done_at = ? WHERE id = ?')
    .run(new Date(now - 8 * 86400_000).toISOString(), 'id-h-old');
  raw.close();

  const store2 = createStore(file);
  const history = store2.getHistory(7);
  assert.deepEqual(history.items.map((it) => it.id), ['id-h1', 'id-h2'], 'done_at 내림차순, 8일 전은 빠져야 한다');
  assert.deepEqual(history.commits, []);
  store2.close();
});

test('briefing()이 overdue·due_today·inbox·open_todo·oldest_todo_days·stale_waiting 여섯 키를 숫자로 돌려준다', () => {
  const store = createStore(tmpFile());
  const b = store.briefing();
  assert.deepEqual(Object.keys(b).sort(), [
    'due_today',
    'inbox',
    'oldest_todo_days',
    'open_todo',
    'overdue',
    'stale_waiting',
  ]);
  for (const v of Object.values(b)) assert.equal(typeof v, 'number');
  store.close();
});

test('마감이 어제인 항목은 overdue에, 오늘인 항목은 due_today에 잡히고 kind와 무관하다', () => {
  const store = createStore(tmpFile());
  store.insertCaptures([
    { id: 'id-od', title: '인박스 지연', abbr: null, captured_at: new Date().toISOString(), context: null },
    { id: 'id-dt', title: '인박스 오늘마감', abbr: null, captured_at: new Date().toISOString(), context: null },
  ]);
  store.setDue('id-od', new Date(Date.now() - 86400_000).toISOString().slice(0, 10));
  store.setDue('id-dt', new Date().toISOString().slice(0, 10));
  const b = store.briefing();
  assert.equal(b.overdue, 1, '인박스 항목의 마감도 지연으로 잡혀야 한다');
  assert.equal(b.due_today, 1);
  store.close();
});

test('5일 넘게 손대지 않은 대기 항목은 stale_waiting에 잡히고 어제 재촉한 대기 항목은 잡히지 않는다', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.insertCaptures([
    {
      id: 'id-stale',
      title: '오래된 대기',
      abbr: null,
      captured_at: new Date(Date.now() - 10 * 86400_000).toISOString(),
      context: null,
    },
    {
      id: 'id-fresh',
      title: '재촉한 대기',
      abbr: null,
      captured_at: new Date(Date.now() - 10 * 86400_000).toISOString(),
      context: null,
    },
  ]);
  store.toWaiting('id-stale', '회신 대기');
  store.toWaiting('id-fresh', '회신 대기');
  store.close();

  const raw = new DatabaseSync(file);
  raw
    .prepare('UPDATE item SET nudged_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 86400_000).toISOString(), 'id-fresh');
  raw.close();

  const store2 = createStore(file);
  const b = store2.briefing(5);
  assert.equal(b.stale_waiting, 1, '재촉 시각부터 경과를 다시 세야 어제 재촉한 건은 빠진다');
  store2.close();
});

test('완료됐거나 소프트 삭제된 항목은 어느 숫자에도 잡히지 않는다', () => {
  const file = tmpFile();
  const store = createStore(file);
  const pid = store.createProject('프로젝트');
  store.insertCaptures([
    { id: 'id-done-b', title: '완료된 할일', abbr: null, captured_at: new Date().toISOString(), context: null },
    { id: 'id-del-b', title: '삭제된 할일', abbr: null, captured_at: new Date().toISOString(), context: null },
  ]);
  store.assignProject('id-done-b', pid);
  store.assignProject('id-del-b', pid);
  const today = new Date().toISOString().slice(0, 10);
  store.setDue('id-done-b', today);
  store.setDue('id-del-b', today);
  store.completeItem('id-done-b');
  store.removeItem('id-del-b');
  const b = store.briefing();
  assert.equal(b.due_today, 0, '완료·삭제된 항목은 due_today에 잡히면 안 된다');
  assert.equal(b.open_todo, 0, '완료·삭제된 항목은 open_todo에 잡히면 안 된다');
  store.close();
});

test('briefing() 결과를 briefingLines()에 그대로 넣어도 예외 없이 문자열 배열이 나온다', () => {
  const store = createStore(tmpFile());
  store.insertCaptures([
    { id: 'id-bl', title: '할 일', abbr: null, captured_at: new Date().toISOString(), context: null },
  ]);
  const b = store.briefing();
  const lines = briefingLines(b);
  assert.ok(Array.isArray(lines));
  for (const line of lines) assert.equal(typeof line, 'string');
  store.close();
});

// ── 재검토 CR-01 회귀(WR-06이 재도입한 영구 유실) ──
//
// WR-06은 insertCaptures의 개별 항목 INSERT를 통째로 try/catch로 감쌌다. item.title
// NOT NULL 위반은 SQLite 트랜잭션 자체를 무효화하지 않으므로, 대기 파일 안 "모든" 항목이
// 같은 결함(title 없음)을 공유하면 insertCaptures가 절대 던지지 않고 { inserted: 0 }을
// 돌려주었다 — queue.replayPending은 이를 성공으로 오인해 대기 파일을 지워, 캡처가
// 저장소에도 큐 파일에도 남지 않는 영구 유실이 재발했다(재검토 REVIEW.md 새 CR-01).
test('대기 파일 안 항목 전부가 title 결함을 공유하면 반영은 실패로 남고 대기 파일이 지워지지 않는다 (재검토 CR-01 회귀)', () => {
  const store = createStore(tmpFile());
  const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-q-'));
  const queue = createQueue(path.join(queueDir, 'queue.jsonl'));

  // title이 null인, 구조적으로 결함 있는 항목 하나만 든 큐 — 656beaa 리뷰의 재현 그대로.
  queue.append({ id: 'lost-1', title: null, abbr: null, captured_at: new Date().toISOString() });

  const replayed = queue.replayPending((entries) => store.insertCaptures(entries));

  const pendingLeft = fs.readdirSync(queueDir).filter((f) => f.includes('.pending-'));
  assert.ok(
    replayed === 0 && pendingLeft.length === 1,
    '항목 전부가 결함이면 replayPending은 성공(0보다 큰 반영)으로 보고하면 안 되고, 대기 파일을 지우면 안 된다 — ' +
      `replayed=${replayed}, pendingLeft=${JSON.stringify(pendingLeft)}`
  );

  const state = store.getViewState();
  assert.ok(
    !state.inbox.some((it) => it.id === 'lost-1'),
    '결함 있는 항목 자체는 저장소에도 써지지 않아야 한다(구조 결함은 여전히 격리된다)'
  );
  store.close();
});
