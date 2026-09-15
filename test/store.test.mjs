import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createStore, MIGRATIONS, schemaTables, validateExport } from '../main/store.mjs';
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

test('모든 캡처는 인박스로 간다 — 캡처 시점에 프로젝트를 정하는 길은 없다', () => {
  const store = createStore(tmpFile());
  store.createProject('샘플프로젝트');
  store.insertCaptures([
    { id: 'id-plain', title: '복사버튼 추가', captured_at: new Date().toISOString(), context: null },
    // #이 든 제목도 그냥 제목이다 — 토큰으로 떼어내던 시절에는 여기서 프로젝트가 붙었다
    { id: 'id-hash', title: '#201 이슈 확인', captured_at: new Date().toISOString(), context: null },
  ]);
  const state = store.getViewState();
  for (const id of ['id-plain', 'id-hash']) {
    const it = state.inbox.find((x) => x.id === id);
    assert.ok(it, `${id}가 inbox에 있어야 한다`);
    assert.equal(it.kind, 'inbox');
    assert.equal(it.project_id, null);
  }
  // 제목이 통째로 남는다 — '#201'이 잘려 나가면 "왜 이걸 적었지"를 풀 단서가 사라진다
  assert.equal(state.inbox.find((x) => x.id === 'id-hash').title, '#201 이슈 확인');
  store.close();
});

test('#약어를 걷어내기 전에 쌓인 대기 항목은 raw(원문)로 되살아난다', () => {
  // 업그레이드 직후 한 번만 생기는 경우다. title에는 토큰을 뗀 값이, raw에 원문이 있다 —
  // title로 반영하면 사용자가 친 '#gw'가 조용히 사라진다.
  const store = createStore(tmpFile());
  store.insertCaptures([
    {
      id: 'id-legacy',
      title: '복사버튼 추가',
      abbr: 'gw',
      raw: '복사버튼 추가 #gw',
      captured_at: new Date().toISOString(),
      context: null,
    },
  ]);
  const it = store.getViewState().inbox.find((x) => x.id === 'id-legacy');
  assert.ok(it, '옛 대기 항목이 inbox에 있어야 한다');
  assert.equal(it.title, '복사버튼 추가 #gw');
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
  const BEFORE = MIGRATIONS.length; // 지금 최신 버전 — 아래에서 한 칸 더 밀어 올린다
  MIGRATIONS.push(() => {});
  try {
    store = createStore(file);
    assert.equal(store.status().ok, true);
    const backupDir = path.join(path.dirname(file), 'backups');
    const backups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
    assert.ok(
      backups.some((f) => new RegExp(`^store-v${BEFORE}-\\d{8}\\.sqlite$`).test(f)),
      '백업 파일이 있어야 한다: ' + backups.join(',')
    );
    store.close();
    const raw = new DatabaseSync(file);
    const { user_version } = raw.prepare('PRAGMA user_version').get();
    assert.equal(user_version, BEFORE + 1);
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

// WR-01: 재검토 REVIEW.md가 WR-02(이행 전 백업이 WAL 체크포인트를 하는지)에 전용
// 회귀 테스트가 없다고 지적했다 — store1의 연결을 열어 둔 채(닫으면 SQLite가 WAL 모드의
// 마지막 연결 종료 시 자동으로 체크포인트해 버려 검증 의미가 없어진다) 커밋된 캡처를
// -wal에만 남기고, 두 번째 연결(store2)이 다음 마이그레이션을 트리거하게 만들어 이행 전
// 백업이 그 캡처를 포함하는지 직접 확인한다.
test('WAL에만 있고 아직 체크포인트되지 않은 캡처도 이행 전 백업에 포함된다 (WR-02 회귀)', () => {
  const file = tmpFile();
  const store1 = createStore(file); // v1까지 정상적으로 마이그레이션
  store1.insertCaptures([
    { id: 'id-wal-only', title: 'WAL에만 있는 캡처', abbr: null, captured_at: new Date().toISOString(), context: null },
  ]);
  // store1을 닫지 않는다 — 지금 커밋은 -wal에만 있고 메인 파일에는 아직 합쳐지지 않았다.

  const BEFORE = MIGRATIONS.length;
  MIGRATIONS.push(() => {}); // 이 테스트 안에서만 다음 버전을 흉내낸다(D-12: 배포된 함수는 고치지 않는다)
  let store2;
  try {
    store2 = createStore(file); // current=1 < MIGRATIONS.length=2 → backupBeforeMigrate 트리거
    assert.equal(store2.status().ok, true);
    const backupDir = path.join(path.dirname(file), 'backups');
    const backups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
    const backupFile = backups.find((f) => new RegExp(`^store-v${BEFORE}-\\d{8}\\.sqlite$`).test(f));
    assert.ok(backupFile, '백업 파일이 있어야 한다: ' + backups.join(','));

    const raw = new DatabaseSync(path.join(backupDir, backupFile));
    const row = raw.prepare('SELECT title FROM item WHERE id = ?').get('id-wal-only');
    raw.close();
    assert.ok(row, 'WAL에만 있던 캡처가 이행 전 백업에도 있어야 한다 — 체크포인트 없이 복사했다면 빠진다');
    assert.equal(row.title, 'WAL에만 있는 캡처');
  } finally {
    MIGRATIONS.pop();
    if (store2) store2.close();
    store1.close();
  }
});

test('백업 폴더를 만들 수 없어도 마이그레이션은 끝까지 진행된다', () => {
  const file = tmpFile();
  let store = createStore(file); // v1까지
  store.close();
  const backupsPath = path.join(path.dirname(file), 'backups');
  fs.writeFileSync(backupsPath, '나는 폴더가 아니라 파일이다'); // mkdir이 실패하도록 자리를 막는다
  const BEFORE = MIGRATIONS.length;
  MIGRATIONS.push(() => {});
  try {
    store = createStore(file);
    assert.equal(store.status().ok, true, '백업 실패에도 이행은 끝까지 진행돼야 한다');
    store.close();
    const raw = new DatabaseSync(file);
    const { user_version } = raw.prepare('PRAGMA user_version').get();
    assert.equal(user_version, BEFORE + 1);
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
  store.deleteProject(a);
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

// ── 내보내기·가져오기 왕복 (DATA-01~03) ──

// 왕복이 "같은 상태"인지를 표 전체를 비교해 본다 — 화면에 보이는 몇 줄만 맞춰 보면
// deleted_at·nudge_count처럼 눈에 안 보이는 칸이 조용히 빠져도 통과한다.
function seedFull(store) {
  store.createProject('가나');
  store.createProject('다라');
  const [p1, p2] = store.getProjects();
  store.updateProject(p1.id, { abbr: 'ga' });
  store.insertCaptures([
    { id: 'i1', title: '인박스 하나', captured_at: '2026-09-01T00:10:00.000Z', context: { note: '왕복' } },
    { id: 'i2', abbr: 'ga', title: '할 일', captured_at: '2026-09-02T01:00:00.000Z' },
    { id: 'i3', title: '대기 건', captured_at: '2026-09-03T02:00:00.000Z' },
    { id: 'i4', title: '지운 것', captured_at: '2026-09-04T03:00:00.000Z' },
  ]);
  store.toWaiting('i3', '상대방');
  store.nudgeItem('i3');
  store.setDue('i2', '2026-09-30');
  store.setNote('i2', '메모');
  store.completeItem('i1');
  store.removeItem('i4');
  store.logEvent('test', 'detail');
  return { p1, p2 };
}

const dump = (store) => {
  const d = store.exportAll();
  return { project: d.project, item: d.item, event: d.event };
};

test('내보내기→가져오기 왕복이 모든 표를 그대로 되살린다', () => {
  const a = createStore(tmpFile());
  a.open();
  seedFull(a);
  const exported = JSON.parse(JSON.stringify(a.exportAll())); // 파일을 거친 것과 같게
  const before = dump(a);

  const b = createStore(tmpFile());
  b.open();
  const out = b.importAll(exported);
  assert.equal(out.project, before.project.length);
  assert.equal(out.item, before.item.length);

  assert.deepEqual(dump(b), before);
  a.close();
  b.close();
});

test('가져오기는 기존 데이터를 합치지 않고 갈아끼운다', () => {
  const a = createStore(tmpFile());
  a.open();
  a.createProject('원래');
  a.insertCaptures([{ id: 'old', title: '원래 있던 것', captured_at: '2026-09-01T00:00:00.000Z' }]);

  const src = createStore(tmpFile());
  src.open();
  src.createProject('새로');
  src.insertCaptures([{ id: 'new', title: '가져온 것', captured_at: '2026-09-05T00:00:00.000Z' }]);

  a.importAll(JSON.parse(JSON.stringify(src.exportAll())));
  const after = a.exportAll();
  assert.deepEqual(after.item.map((i) => i.id), ['new']);
  assert.deepEqual(after.project.map((p) => p.name), ['새로']);
  a.close();
  src.close();
});

test('가져오기 직전 상태가 백업으로 남아 되돌릴 수 있다', () => {
  const file = tmpFile();
  const a = createStore(file);
  a.open();
  a.createProject('되돌릴 것');
  a.insertCaptures([{ id: 'keep', title: '잃으면 안 되는 캡처', captured_at: '2026-09-01T00:00:00.000Z' }]);

  const src = createStore(tmpFile());
  src.open();
  src.createProject('덮어쓸 것');

  const out = a.importAll(JSON.parse(JSON.stringify(src.exportAll())));
  assert.ok(out.backup && fs.existsSync(out.backup), '가져오기 직전 백업이 남아야 한다');
  assert.equal(a.exportAll().item.length, 0);
  a.close();
  src.close();

  // 백업 파일을 그대로 열면 가져오기 전 상태다
  const restored = createStore(out.backup);
  restored.open();
  assert.deepEqual(restored.exportAll().item.map((i) => i.title), ['잃으면 안 되는 캡처']);
  restored.close();
});

test('context는 객체로 왕복한다 — 문자열로 굳지 않는다', () => {
  const a = createStore(tmpFile());
  a.open();
  a.insertCaptures([{ id: 'c1', title: '맥락', captured_at: '2026-09-01T00:00:00.000Z', context: { a: 1, b: '둘' } }]);
  const b = createStore(tmpFile());
  b.open();
  b.importAll(JSON.parse(JSON.stringify(a.exportAll())));
  const row = b.getViewState().inbox.find((i) => i.id === 'c1');
  assert.deepEqual(row.context, { a: 1, b: '둘' });
  a.close();
  b.close();
});

test('남의 파일·손상된 파일·상위 스키마는 가져오지 않는다', () => {
  const ok = { app: 'whenwork', schema_version: MIGRATIONS.length, project: [], item: [], event: [] };
  assert.equal(validateExport(ok), null);
  assert.match(validateExport(null), /읽을 수 없는/);
  assert.match(validateExport({ app: 'other', schema_version: 1, project: [], item: [] }), /WHENWORK가 내보낸/);
  assert.match(validateExport({ ...ok, schema_version: MIGRATIONS.length + 1 }), /업데이트/);
  assert.match(validateExport({ ...ok, item: [{ id: 'x' }] }), /항목 자료가 손상/);
  assert.match(validateExport({ ...ok, project: [{ id: 'notnum', name: '가' }] }), /프로젝트 자료가 손상/);
  assert.match(
    validateExport({ ...ok, item: [{ id: 'x', title: '제목', captured_at: '2026-09-01T00:00:00.000Z', project_id: 99 }] }),
    /가리키는 프로젝트가 파일에 없/
  );
});

test('가져오기가 거부되면 기존 데이터는 그대로다', () => {
  const a = createStore(tmpFile());
  a.open();
  a.insertCaptures([{ id: 'safe', title: '남아야 한다', captured_at: '2026-09-01T00:00:00.000Z' }]);
  assert.throws(() => a.importAll({ app: 'other', schema_version: 1, project: [], item: [] }));
  assert.deepEqual(a.exportAll().item.map((i) => i.id), ['safe']);
  a.close();
});

test('가져오기 백업 이름에 시각이 들어간다 — 두 번 가져와도 앞 백업을 덮지 않는다', () => {
  const store = createStore(tmpFile());
  store.open();
  store.insertCaptures([{ id: 'a', title: '첫 번째', captured_at: '2026-09-01T00:00:00.000Z' }]);
  const empty = { app: 'whenwork', schema_version: store.schemaVersion(), project: [], item: [], event: [] };
  const first = store.importAll(empty).backup;
  // 정규식의 . 을 이스케이프하지 않으면 문자열 전체가 잘려 'store-import-.sqlite'가 된다
  assert.match(path.basename(first), /^store-import-\d{8}T\d{6}\.sqlite$/, path.basename(first));
  store.close();
});

// ── 프로젝트 삭제 — 항목의 X와 같은 소프트 삭제 ──

test('지운 프로젝트는 1~9 목록에서 빠지고 deletedProjects로 따로 내려온다', () => {
  const store = createStore(tmpFile());
  store.open();
  const gone = store.createProject('지울 것');
  store.createProject('남을 것');
  store.deleteProject(gone);
  const st = store.getViewState();
  assert.deepEqual(st.projects.map((p) => p.name), ['남을 것']);
  assert.deepEqual(st.deletedProjects.map((p) => p.name), ['지울 것']);
  assert.ok(st.deletedProjects[0].deleted_at, '언제 지웠는지가 남아야 30일 정리가 된다');
  store.close();
});

test('지우면 미완료 항목은 인박스로 가고 완료 항목은 라벨을 안고 남는다', () => {
  const store = createStore(tmpFile());
  store.open();
  const pid = store.createProject('지울 것');
  const now = new Date().toISOString();
  store.insertCaptures([
    { id: 'live', title: '아직 할 일', captured_at: now },
    { id: 'done', title: '끝낸 일', captured_at: now },
  ]);
  store.assignProject('live', pid);
  store.assignProject('done', pid);
  store.completeItem('done');

  const { movedItemIds } = store.deleteProject(pid);
  assert.deepEqual(movedItemIds, ['live'], '인박스로 보낸 것은 미완료 항목만이어야 한다');

  const st = store.getViewState();
  const live = st.inbox.find((i) => i.id === 'live');
  assert.ok(live, '미완료 항목이 인박스에 다시 나타나야 한다 — 숨겨지면 조용히 사라지는 것이다');
  assert.equal(live.project_id, null);

  // 완료 기록은 프로젝트 이름을 그대로 안고 있다 — 라벨이 떨어진 기록은 기록이 아니다
  const hist = store.getHistory(null).items.find((i) => i.id === 'done');
  assert.ok(hist, '완료 항목이 기록에 남아야 한다');
  assert.equal(hist.project_name, '지울 것');
  store.close();
});

test('되돌리면 프로젝트도, 인박스로 갔던 항목도 함께 돌아온다', () => {
  const store = createStore(tmpFile());
  store.open();
  const pid = store.createProject('지울 것');
  store.insertCaptures([{ id: 'live', title: '아직 할 일', captured_at: new Date().toISOString() }]);
  store.assignProject('live', pid);
  const { movedItemIds } = store.deleteProject(pid);

  store.restoreProject(pid, movedItemIds);
  const st = store.getViewState();
  assert.deepEqual(st.projects.map((p) => p.name), ['지울 것']);
  assert.equal(st.deletedProjects.length, 0);
  const it = st.today.find((i) => i.id === 'live');
  assert.ok(it, '되돌린 뒤 항목이 다시 프로젝트의 todo에 있어야 한다');
  assert.equal(it.project_id, pid);
  store.close();
});

test('되돌리기는 그 사이 사용자가 다른 데로 옮긴 항목을 뒤집지 않는다', () => {
  const store = createStore(tmpFile());
  store.open();
  const a = store.createProject('지울 것');
  const b = store.createProject('다른 것');
  store.insertCaptures([{ id: 'x', title: '옮긴 일', captured_at: new Date().toISOString() }]);
  store.assignProject('x', a);
  const { movedItemIds } = store.deleteProject(a);
  // 인박스에 나타난 것을 사용자가 다른 프로젝트로 보냈다
  store.assignProject('x', b);

  store.restoreProject(a, movedItemIds);
  const it = store.getViewState().today.find((i) => i.id === 'x');
  assert.equal(it.project_id, b, '사용자가 손댄 것을 되돌리기가 빼앗아 오면 안 된다');
  store.close();
});

test('빈 삭제 프로젝트만 30일 뒤 정리되고, 항목이 남은 것은 라벨로 살아 있다', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.open();
  const empty = store.createProject('빈 것');
  const withDone = store.createProject('기록 있는 것');
  store.insertCaptures([{ id: 'd', title: '끝낸 일', captured_at: new Date().toISOString() }]);
  store.assignProject('d', withDone);
  store.completeItem('d');
  store.deleteProject(empty);
  store.deleteProject(withDone);
  store.close();

  // 31일 전에 지운 것으로 만든다
  const raw = new DatabaseSync(file);
  const old = new Date(Date.now() - 31 * 86400_000).toISOString();
  raw.prepare(`UPDATE project SET deleted_at = ? WHERE status != 'active'`).run(old);
  raw.close();

  store.reopen();
  store.purgeDeleted(30);
  const names = store.getViewState().deletedProjects.map((p) => p.name);
  assert.deepEqual(names, ['기록 있는 것'], '기록이 남은 프로젝트는 지워지면 안 된다: ' + names.join(','));
  assert.equal(store.getHistory(null).items.find((i) => i.id === 'd')?.project_name, '기록 있는 것');
  store.close();
});

test('옛 데이터의 archived 프로젝트도 삭제된 것으로 함께 보인다 (v3 이행)', () => {
  const file = tmpFile();
  let store = createStore(file);
  store.close();
  // v2 시절처럼 status만 archived인 행을 흉내낸다 — deleted_at은 v3가 채운다
  const raw = new DatabaseSync(file);
  raw.prepare(`INSERT INTO project (name, status, sort) VALUES ('옛 보관', 'archived', 0)`).run();
  raw.close();
  store = createStore(file);
  const st = store.getViewState();
  assert.deepEqual(st.deletedProjects.map((p) => p.name), ['옛 보관']);
  store.close();
});

// ── 완료 기록 기간 ──

test('getHistory(null)은 전 기간을 돌려주고, 7은 7일만 돌려준다', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.open();
  store.insertCaptures([
    { id: 'recent', title: '최근', captured_at: new Date().toISOString() },
    { id: 'old', title: '오래전', captured_at: new Date().toISOString() },
  ]);
  store.completeItem('recent');
  store.completeItem('old');
  store.close();
  const raw = new DatabaseSync(file);
  raw.prepare('UPDATE item SET done_at = ? WHERE id = ?').run(new Date(Date.now() - 40 * 86400_000).toISOString(), 'old');
  raw.close();
  store.reopen();
  assert.deepEqual(store.getHistory(7).items.map((i) => i.id), ['recent']);
  assert.deepEqual(store.getHistory(null).items.map((i) => i.id).sort(), ['old', 'recent']);
  store.close();
});
