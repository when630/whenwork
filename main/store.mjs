// main/store.mjs — node:sqlite 기반 단일 파일 저장소 (이전 PostgreSQL 저장소 모듈 대체, D-05)
// 캡처는 큐에 먼저 남고(main/queue.mjs), 여기서는 그 뒤 즉시 반영만 맡는다(D-01).
// DatabaseSync는 동기 API라 이 파일의 모든 함수도 동기다. Electron을 import하지 않는
// 순수 Node 모듈이라 node --test로 검증한다.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// 앱이 자신보다 높은 user_version의 DB를 만나면 열지 않는다(D-13) — 구버전으로 되돌린
// 사용자가 최신 스키마에 실수로 쓰지 않게 막는 신호다.
export class NewerSchemaError extends Error {
  constructor(found, known) {
    super(`store schema v${found}, this app only knows up to v${known}`);
    this.name = 'NewerSchemaError';
    this.found = found;
    this.known = known;
  }
}

// v1 스키마 — 남는 것은 project/item/event 세 테이블뿐이다(STOR-05). 인덱스는 지금 쿼리
// 패턴에 필요한 최소만, 외래키는 강제하지 않는다(체크포인트 결정 lean — 지금 PostgreSQL
// 스키마도 실질적으로 같은 보장 수준이고, 프로젝트는 보관만 하고 지우지 않는 설계에서
// 외래키 강제의 이득이 작다. Phase 3 이전 스크립트도 삽입 순서를 신경 쓰지 않아도 된다).
const V1_SQL = `
CREATE TABLE project (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL UNIQUE,
  abbr    TEXT,
  status  TEXT NOT NULL DEFAULT 'active',
  sort    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE item (
  id          TEXT PRIMARY KEY,
  project_id  INTEGER REFERENCES project(id),
  kind        TEXT NOT NULL DEFAULT 'inbox' CHECK (kind IN ('inbox','todo','waiting')),
  title       TEXT NOT NULL,
  due         TEXT,
  waiting_for TEXT,
  captured_at TEXT NOT NULL,
  done_at     TEXT,
  source      TEXT NOT NULL DEFAULT 'manual',
  context     TEXT,
  note        TEXT,
  nudged_at   TEXT,
  nudge_count INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT
);
CREATE TABLE event (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  kind   TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX item_due ON item (due);
CREATE INDEX item_kind ON item (kind);
CREATE INDEX event_at ON event (at DESC);
`;

// PRAGMA user_version 순번 마이그레이션(D-12). 새 DB도 빈 상태(v0)에서 이 배열을 처음부터
// 끝까지 밟아 올라간다 — 경로가 하나다. 한 번 배포된 함수는 절대 고치지 않는다.
export const MIGRATIONS = [(db) => db.exec(V1_SQL)];

// schemaTables()가 대조하는 원본 — MIGRATIONS와 함수 대 함수로 짝을 이룬다.
const MIGRATION_SQL = [V1_SQL];

// 스키마가 실제로 만드는 테이블 이름 — STOR-05 가드 테스트가 이것과 대조한다.
export function schemaTables() {
  const names = new Set();
  for (const sql of MIGRATION_SQL) {
    for (const m of sql.matchAll(/CREATE TABLE (\w+)/g)) names.add(m[1]);
  }
  return [...names].sort();
}

// node:sqlite의 DatabaseSync에는 트랜잭션 헬퍼가 없다 — BEGIN/COMMIT/ROLLBACK을 직접 감싼다.
function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// 이행 직전 백업 몇 개만 남긴다(보관 개수는 재량 — 5로 고정). Phase 3의 가져오기 직전
// 자동 백업(DATA-03)이 같은 폴더·명명 관례를 쓸 것이므로 접두사·위치를 바꾸지 않는다.
const BACKUP_KEEP = 5;

function todayStamp(d = new Date()) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function pruneOldBackups(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => /^store-v\d+-\d{8}\.sqlite$/.test(f));
    if (files.length <= BACKUP_KEEP) return;
    const withTimes = files
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    for (const { f } of withTimes.slice(0, withTimes.length - BACKUP_KEEP)) {
      fs.unlinkSync(path.join(dir, f));
    }
  } catch {
    // 정리 실패는 무시 — 이행을 막을 이유가 아니다
  }
}

// user_version이 실제로 오를 때만, 그리고 v0에서 시작하는 게 아닐 때만 백업한다(D-16).
// 복사 실패가 이행을 막지 않도록 전체를 삼킨다.
function backupBeforeMigrate(file, fromVersion) {
  try {
    const dir = path.join(path.dirname(file), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `store-v${fromVersion}-${todayStamp()}.sqlite`);
    fs.copyFileSync(file, dest);
    pruneOldBackups(dir);
  } catch {
    // 백업 실패가 이행을 막지 않는다(D-16)
  }
}

function migrate(db, file) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  if (current > MIGRATIONS.length) {
    throw new NewerSchemaError(current, MIGRATIONS.length);
  }
  if (current === MIGRATIONS.length) return; // 이미 최신 — 백업도 이행도 필요 없다
  if (current > 0) backupBeforeMigrate(file, current);
  for (let v = current; v < MIGRATIONS.length; v++) {
    withTransaction(db, () => {
      MIGRATIONS[v](db);
      // PRAGMA는 파라미터 바인딩을 받지 않는다 — 내부에서 계산한 정수라 템플릿 리터럴로 넣는다.
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

// integrity_check가 'ok'가 아니면 손상으로 취급한다 — 판정 근거를 예외 하나로 통일한다.
class IntegrityCheckFailedError extends Error {}

function checkIntegrity(db) {
  const row = db.prepare('PRAGMA integrity_check').get();
  const result = row?.integrity_check;
  if (result !== 'ok') throw new IntegrityCheckFailedError(`integrity_check: ${result}`);
}

// 손상 판정 기준은 "열기에 실패했다"가 아니라 에러의 정체다(D-15) — 건강한 DB를 옆으로
// 미는 일이 절대 없어야 한다. errcode 26(SQLITE_NOTADB)·11(SQLITE_CORRUPT) 또는
// integrity_check 불합격만 손상이고, 잠김(errcode 5)·권한 오류는 손상이 아니다.
function isCorruptError(err) {
  if (err instanceof IntegrityCheckFailedError) return true;
  return !!err && (err.errcode === 26 || err.errcode === 11);
}

// 손상 파일·옆의 -wal/-shm을 옆으로 옮겨 보존한다(지우지 않는다, D-15). 콜론은 Windows가
// 파일명으로 허용하지 않아 ISO 타임스탬프에서 :와 .을 제거한다.
function quarantine(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '');
  const quarantinedName = `store.corrupt-${stamp}.sqlite`;
  const dir = path.dirname(file);
  for (const suffix of ['', '-wal', '-shm']) {
    const src = file + suffix;
    if (!fs.existsSync(src)) continue;
    try {
      fs.renameSync(src, path.join(dir, quarantinedName + suffix));
    } catch {
      // 옆 파일(wal/shm) 이동 실패는 본 파일 격리를 막지 않는다
    }
  }
  return quarantinedName;
}

export function createStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db = null;
  let state = { ok: false, reason: null, notice: null, quarantined: null };

  function closeQuietly() {
    if (!db) return;
    try {
      db.close();
    } catch {
      // 이미 망가진 핸들이면 닫기도 실패할 수 있다 — 무시한다
    }
    db = null;
  }

  function genericFailure() {
    closeQuietly();
    return {
      ok: false,
      reason: 'error',
      notice: '저장소를 열지 못했습니다 — 캡처는 로컬 큐에 안전하게 쌓입니다',
      quarantined: null,
    };
  }

  function open() {
    // (a)+(b) 열기(construction)와 integrity_check를 한 판정 경계로 묶는다 — 손상 여부는
    // "열기에 실패했다"가 아니라 에러의 정체(errcode 26/11 또는 불합격 결과)로만 가른다.
    // 잠김·권한 오류처럼 errcode가 다른 것은 isCorruptError가 걸러 손상으로 오판하지
    // 않는다(D-15 — 건강한 파일을 절대 옆으로 밀지 않는다).
    try {
      db = new DatabaseSync(file);
      checkIntegrity(db);
    } catch (err) {
      closeQuietly();
      if (!isCorruptError(err)) {
        state = genericFailure();
        return state;
      }
      const quarantinedName = quarantine(file);
      try {
        db = new DatabaseSync(file); // 같은 자리에 빈 DB를 새로 연다
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = FULL');
        migrate(db, file);
        state = {
          ok: true,
          reason: 'corrupt',
          notice: '이전 데이터 파일이 손상되어 보관해 두었습니다',
          quarantined: quarantinedName,
        };
      } catch {
        closeQuietly();
        state = {
          ok: false,
          reason: 'error',
          notice: '저장소를 열지 못했습니다 — 캡처는 로컬 큐에 안전하게 쌓입니다',
          quarantined: quarantinedName,
        };
      }
      return state;
    }

    // (c) 정상 파일 — 프라그마·마이그레이션. 상위 버전(D-13)은 여기서 걸린다.
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      migrate(db, file);
      state = { ok: true, reason: null, notice: null, quarantined: null };
    } catch (err) {
      closeQuietly();
      if (err instanceof NewerSchemaError) {
        state = {
          ok: false,
          reason: 'newer',
          notice: '새 버전으로 만든 데이터입니다 — 앱을 업데이트해 주세요',
          quarantined: null,
        };
      } else {
        state = genericFailure();
      }
    }
    return state;
  }

  function checkpoint() {
    if (!db) return;
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // 체크포인트 실패가 종료를 막지 않는다
    }
  }

  function close() {
    if (!db) return;
    checkpoint();
    try {
      db.close();
    } catch {
      // 이미 닫힌 핸들이어도 넘어간다
    }
    db = null;
  }

  function reopen() {
    close();
    return open();
  }

  function status() {
    return { ...state };
  }

  // 캡처 반영 — id가 멱등 키라 재시도돼도 중복이 없다(D-02). 약어가 활성 프로젝트를
  // 가리키면 todo로 붙고, 어느 프로젝트도 아니면 원문을 그대로 되살려 인박스에 남긴다.
  function insertCaptures(entries) {
    if (!db || !state.ok) return { inserted: 0 };
    const findAbbr = db.prepare(`SELECT id FROM project WHERE lower(abbr) = lower(?) AND status = 'active'`);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO item (id, project_id, kind, title, captured_at, source, context)
       VALUES (?, ?, ?, ?, ?, 'manual', ?)`
    );
    let inserted = 0;
    withTransaction(db, () => {
      for (const e of entries) {
        let projectId = null;
        if (e.abbr) {
          const row = findAbbr.get(e.abbr);
          projectId = row?.id ?? null;
        }
        // 약어가 어느 프로젝트도 아니면(오타 등) 원문을 그대로 되살린다 — 조용히 떼어내면
        // 인박스에서 "왜 여기 있지"를 풀 단서가 사라진다. raw가 없는 옛 항목은 뒤에 붙인다.
        const title = e.abbr && !projectId ? (e.raw ?? `${e.title} #${e.abbr}`) : e.title;
        const context = e.context != null ? JSON.stringify(e.context) : null;
        const result = insert.run(e.id, projectId, projectId ? 'todo' : 'inbox', title, e.captured_at, context);
        if (result.changes) inserted += 1;
      }
    });
    return { inserted };
  }

  // 오늘 뷰 한 번에 — 탭 세 개 분량을 묶어 내려보낸다. 완료 12시간 창은 호출 시점 JS
  // 계산 + 문자열 비교로 처리한다(D-10). due는 SQLite 네이티브 NULLS LAST로 정렬한다.
  function getViewState() {
    if (!db || !state.ok) return { projects: [], today: [], inbox: [], waiting: [] };
    const cutoff = new Date(new Date().getTime() - 12 * 3600_000).toISOString();
    const rows = db
      .prepare(
        `SELECT i.id, i.project_id, p.name AS project_name, i.kind, i.title, i.due,
                i.waiting_for, i.captured_at, i.done_at, i.context, i.note,
                i.nudged_at, i.nudge_count
         FROM item i
         LEFT JOIN project p ON p.id = i.project_id
         WHERE i.deleted_at IS NULL
           AND (i.done_at IS NULL OR i.done_at > ?)
         ORDER BY i.due NULLS LAST, i.captured_at`
      )
      .all(cutoff);
    const items = rows.map((r) => ({ ...r, context: r.context ? JSON.parse(r.context) : null }));
    const projects = db.prepare(`SELECT id, name, abbr, status, sort FROM project ORDER BY sort, name`).all();
    return {
      projects,
      today: items.filter((r) => r.kind === 'todo'),
      inbox: items.filter((r) => r.kind === 'inbox'),
      waiting: items.filter((r) => r.kind === 'waiting'),
    };
  }

  // 지표 한 줄 — 실패해도 기능을 막지 않는다.
  function logEvent(kind, detail = null) {
    try {
      if (!db || !state.ok) return;
      db.prepare('INSERT INTO event (at, kind, detail) VALUES (?, ?, ?)').run(
        new Date().toISOString(),
        kind,
        detail == null ? null : String(detail)
      );
    } catch {
      // 지표 기록 실패가 기능을 막지 않는다
    }
  }

  // ── 프로젝트 관리 — 시드·하드코딩 없이 전부 여기서

  function getProjects() {
    if (!db || !state.ok) return [];
    return db
      .prepare(`SELECT id, name, abbr, status, sort FROM project WHERE status = 'active' ORDER BY sort, id`)
      .all();
  }

  function createProject(name) {
    if (!db || !state.ok) return null;
    const row = db
      .prepare(
        `INSERT OR IGNORE INTO project (name, sort)
         VALUES (?, (SELECT coalesce(max(sort), 0) + 1 FROM project))
         RETURNING id`
      )
      .get(name);
    return row?.id ?? null;
  }

  function updateProject(id, fields) {
    if (!db || !state.ok) return;
    if (fields.name != null) db.prepare('UPDATE project SET name = ? WHERE id = ?').run(fields.name, id);
    if (fields.abbr != null) db.prepare('UPDATE project SET abbr = ? WHERE id = ?').run(fields.abbr || null, id);
  }

  function archiveProject(id) {
    if (!db || !state.ok) return;
    db.prepare(`UPDATE project SET status = 'archived' WHERE id = ?`).run(id);
  }

  // 순서 변경 — 이웃과 자리를 바꾸고 sort를 0..n으로 정규화해 충돌을 없앤다
  function moveProject(id, dir) {
    if (!db || !state.ok) return;
    const projects = getProjects();
    const i = projects.findIndex((p) => p.id === id);
    const j = i + (dir === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= projects.length) return;
    [projects[i], projects[j]] = [projects[j], projects[i]];
    withTransaction(db, () => {
      const setSort = db.prepare('UPDATE project SET sort = ? WHERE id = ?');
      for (let k = 0; k < projects.length; k++) {
        setSort.run(k, projects[k].id);
      }
    });
  }

  function completeItem(id) {
    if (!db || !state.ok) return;
    db.prepare('UPDATE item SET done_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  function uncompleteItem(id) {
    if (!db || !state.ok) return;
    db.prepare('UPDATE item SET done_at = NULL WHERE id = ?').run(id);
  }

  // 프로젝트 지정. 인박스에서 부르면 그것이 곧 "할 일로 세운다"는 뜻이라 kind도 바꾸지만,
  // 대기 항목에 부를 때는 kind를 건드리면 안 된다 — 프로젝트만 붙이려던 조작이
  // 대기 해제가 되어 항목이 대기 탭에서 사라진다.
  function assignProject(id, projectId, keepKind = false) {
    if (!db || !state.ok) return;
    if (keepKind) {
      db.prepare('UPDATE item SET project_id = ? WHERE id = ?').run(projectId, id);
    } else {
      db.prepare(`UPDATE item SET project_id = ?, kind = 'todo' WHERE id = ?`).run(projectId, id);
    }
  }

  function setDue(id, due) {
    if (!db || !state.ok) return;
    db.prepare('UPDATE item SET due = ? WHERE id = ?').run(due, id);
  }

  function toWaiting(id, waitingFor) {
    if (!db || !state.ok) return;
    db.prepare(`UPDATE item SET kind = 'waiting', waiting_for = ? WHERE id = ?`).run(waitingFor ?? null, id);
  }

  function renameItem(id, title) {
    if (!db || !state.ok) return;
    db.prepare('UPDATE item SET title = ? WHERE id = ?').run(title, id);
  }

  // 삭제는 표시만 — 되돌릴 수 있어야 한다(U). 실제 삭제는 purgeDeleted가 나중에 한다.
  function removeItem(id) {
    if (!db || !state.ok) return;
    db.prepare('UPDATE item SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  function restoreItem(id) {
    if (!db || !state.ok) return;
    db.prepare('UPDATE item SET deleted_at = NULL WHERE id = ?').run(id);
  }

  function setNote(id, note) {
    if (!db || !state.ok) return;
    db.prepare('UPDATE item SET note = ? WHERE id = ?').run(note || null, id);
  }

  // 재촉 기록 — 경과 시계를 지금부터 다시 센다.
  //
  // 30분 안에 다시 누른 것은 손이 미끄러진 것으로 보고 횟수를 올리지 않는다(실사용에서 한 항목에
  // 5회가 찍혔다 — 같은 사람을 30분 안에 두 번 찌를 일은 없다). 직전 값을 함께 돌려주는 것은
  // U로 되돌리기 위해서다: 확인 없이 경과 시계를 리셋하는 키였는데 취소할 방법이 없었다.
  const NUDGE_DEDUP_MIN = 30;

  function nudgeItem(id) {
    if (!db || !state.ok) return null;
    const prev = db.prepare('SELECT nudged_at, nudge_count FROM item WHERE id = ?').get(id);
    if (!prev) return null;
    const repeated =
      !!prev.nudged_at && new Date().getTime() - new Date(prev.nudged_at).getTime() < NUDGE_DEDUP_MIN * 60_000;
    const nextCount = Number(prev.nudge_count ?? 0) + (repeated ? 0 : 1);
    const updated = db
      .prepare('UPDATE item SET nudged_at = ?, nudge_count = ? WHERE id = ? RETURNING nudge_count')
      .get(new Date().toISOString(), nextCount, id);
    return {
      count: updated?.nudge_count ?? 0,
      repeated,
      prev: { at: prev.nudged_at, count: Number(prev.nudge_count ?? 0) },
    };
  }

  // 재촉 되돌리기 — 직전 값을 그대로 되돌려 놓는다 (첫 재촉이었으면 at은 null)
  function nudgeRestore(id, at, count) {
    if (!db || !state.ok) return;
    db.prepare('UPDATE item SET nudged_at = ?, nudge_count = ? WHERE id = ?').run(at ?? null, Number(count) || 0, id);
  }

  function getInbox() {
    if (!db || !state.ok) return [];
    const rows = db
      .prepare(
        `SELECT id, title, context FROM item
         WHERE kind = 'inbox' AND done_at IS NULL AND deleted_at IS NULL
         ORDER BY captured_at`
      )
      .all();
    return rows.map((r) => ({ ...r, context: r.context ? JSON.parse(r.context) : null }));
  }

  // 되돌릴 수 있는 창이 지난 삭제분을 실제로 비운다. 기동 시 1회.
  function purgeDeleted(days = 30) {
    if (!db || !state.ok) return 0;
    const cutoff = new Date(new Date().getTime() - days * 86400_000).toISOString();
    const result = db.prepare('DELETE FROM item WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(cutoff);
    return result.changes;
  }

  // 완료 기록 — 오늘 뷰는 12시간만 보여주므로 "어제 뭐 했지"를 볼 창구가 없었다.
  // 커밋 목록은 제거 대상 테이블(수집기)에서 오던 것이라 여기서는 계산하지 않고 항상
  // 빈 배열을 돌려준다 — 호출부와 렌더러가 이 키(commits)를 그대로 읽으므로 모양은 유지한다.
  function getHistory(days = 7) {
    if (!db || !state.ok) return { items: [], commits: [] };
    const cutoff = new Date(new Date().getTime() - days * 86400_000).toISOString();
    const rows = db
      .prepare(
        `SELECT i.id, i.title, i.kind, i.done_at, i.project_id, p.name AS project_name
         FROM item i LEFT JOIN project p ON p.id = i.project_id
         WHERE i.deleted_at IS NULL AND i.done_at IS NOT NULL AND i.done_at > ?
         ORDER BY i.done_at DESC`
      )
      .all(cutoff);
    return { items: rows, commits: [] };
  }

  // 아침 브리핑 재료 — 이번 페이즈에서 걷어낸 테이블·칼럼에 기대는 원본의 서브쿼리·조인은
  // 통째로 드롭한다(RESEARCH Pitfall 1). main/brief.mjs의 briefingLines()가 이 여섯 필드
  // 밖의 값을 모두 falsy 가드로 감싸고 있어 축소된 결과만 넘겨도 문구가 깨지지 않는다.
  function briefing(staleDays = 5) {
    if (!db || !state.ok) {
      return { overdue: 0, due_today: 0, inbox: 0, open_todo: 0, oldest_todo_days: 0, stale_waiting: 0 };
    }
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = new Date(new Date().getTime() - staleDays * 86400_000).toISOString();
    // 마감은 어느 탭에 있든 챙겨야 한다 — kind로 거르지 않는다(원본 PostgreSQL 저장소 모듈의
    // 이유를 그대로 옮긴다: kind='todo'만 세면 인박스·대기 항목의 마감이 화면 배지로는 뜨는데 아침에는
    // 조용히 빠진다). 재촉한 건은 그때부터 다시 센다 — 처음 부탁한 날로 세면 방금 재촉한
    // 것까지 묶여 나온다.
    const counts = db
      .prepare(
        `SELECT
           count(*) FILTER (WHERE due < ?) AS overdue,
           count(*) FILTER (WHERE due = ?) AS due_today,
           count(*) FILTER (WHERE kind = 'inbox') AS inbox,
           count(*) FILTER (WHERE kind = 'todo') AS open_todo,
           count(*) FILTER (WHERE kind = 'waiting'
                              AND coalesce(nudged_at, captured_at) < ?) AS stale_waiting
         FROM item
         WHERE deleted_at IS NULL AND done_at IS NULL`
      )
      .get(today, today, cutoff);
    // 가장 오래된 미완료 할 일이 잡힌 지 며칠인가 — SQL에서는 해당 그룹의 최소 captured_at만
    // 가져오고 날수 계산은 JS에서 한다(D-10, RESEARCH Pattern 3).
    const oldest = db
      .prepare(
        `SELECT captured_at FROM item
         WHERE kind = 'todo' AND deleted_at IS NULL AND done_at IS NULL
         ORDER BY captured_at ASC LIMIT 1`
      )
      .get();
    const oldestTodoDays = oldest
      ? Math.floor((new Date().getTime() - new Date(oldest.captured_at).getTime()) / 86400_000)
      : 0;
    return {
      overdue: Number(counts.overdue) || 0,
      due_today: Number(counts.due_today) || 0,
      inbox: Number(counts.inbox) || 0,
      open_todo: Number(counts.open_todo) || 0,
      oldest_todo_days: oldestTodoDays,
      stale_waiting: Number(counts.stale_waiting) || 0,
    };
  }

  open();

  return {
    open,
    close,
    reopen,
    checkpoint,
    status,
    insertCaptures,
    getViewState,
    logEvent,
    getProjects,
    createProject,
    updateProject,
    archiveProject,
    moveProject,
    completeItem,
    uncompleteItem,
    assignProject,
    setDue,
    toWaiting,
    renameItem,
    removeItem,
    restoreItem,
    setNote,
    nudgeItem,
    nudgeRestore,
    getInbox,
    purgeDeleted,
    getHistory,
    briefing,
    file,
  };
}
