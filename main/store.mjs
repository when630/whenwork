// main/store.mjs — node:sqlite 기반 단일 파일 저장소 (이전 PostgreSQL 저장소 모듈 대체, D-05)
// 캡처는 큐에 먼저 남고(main/queue.mjs), 여기서는 그 뒤 즉시 반영만 맡는다(D-01).
// DatabaseSync는 동기 API라 이 파일의 모든 함수도 동기다. Electron을 import하지 않는
// 순수 Node 모듈이라 node --test로 검증한다.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { dayKey } from './brief.mjs';

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

// v2 — #약어 기능을 걷어내면서 project.abbr을 지운다. V1_SQL은 손대지 않는다:
// 한 번 배포된 마이그레이션 함수를 고치면 이미 v1을 밟은 DB와 새로 만드는 DB가
// 서로 다른 길을 걷게 된다. 새 DB는 v1으로 컬럼을 만들었다가 v2에서 지운다 — 낭비처럼
// 보이지만 그 대신 "경로가 하나"가 지켜진다(D-12).
//
// 이행 전 백업은 migrate()가 알아서 남긴다(D-16). 지우는 컬럼이라 되돌릴 일이 생기면
// 그 백업이 유일한 근거다.
const V2_SQL = `
ALTER TABLE project DROP COLUMN abbr;
`;

// v3 — 프로젝트 삭제를 항목과 같은 소프트 삭제로 바꾼다. 언제 지웠는지가 있어야
// 비어 있는 것을 30일 뒤 정리할 수 있다. 옛 데이터의 'archived'는 그대로 두되
// 시각만 지금으로 채운다 — 그 프로젝트들도 같은 규칙(비었으면 30일 뒤 정리)을 탄다.
const V3_SQL = `
ALTER TABLE project ADD COLUMN deleted_at TEXT;
UPDATE project SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status != 'active';
`;

// PRAGMA user_version 순번 마이그레이션(D-12). 새 DB도 빈 상태(v0)에서 이 배열을 처음부터
// 끝까지 밟아 올라간다 — 경로가 하나다. 한 번 배포된 함수는 절대 고치지 않는다.
export const MIGRATIONS = [(db) => db.exec(V1_SQL), (db) => db.exec(V2_SQL), (db) => db.exec(V3_SQL)];

// schemaTables()가 대조하는 원본 — MIGRATIONS와 함수 대 함수로 짝을 이룬다.
const MIGRATION_SQL = [V1_SQL, V2_SQL, V3_SQL];

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
function backupBeforeMigrate(db, file, fromVersion) {
  try {
    // WR-02: 강제종료 직후 재기동해 마이그레이션이 겹치면 -wal에 아직 체크포인트되지 않은
    // 캡처가 남아 있을 수 있다. 본 파일만 복사하면 그 캡처가 빠진 오래된 백업이 만들어져
    // 나중에 이 백업으로 되돌릴 때 최근 캡처를 다시 잃는다 — 복사 전에 -wal을 합친다.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const dir = path.join(path.dirname(file), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `store-v${fromVersion}-${todayStamp()}.sqlite`);
    fs.copyFileSync(file, dest);
    pruneOldBackups(dir);
  } catch {
    // 백업 실패가 이행을 막지 않는다(D-16)
  }
}

// 가져오기 파일 검증. 통과하면 null, 아니면 사람이 읽을 수 있는 이유 한 줄을 돌려준다.
// **절대 경로나 내부 구조를 이유에 넣지 않는다**(01-02 규칙) — 사용자가 고칠 수 있는 말만 한다.
//
// 상위 스키마를 거부하는 이유는 저장소를 여는 쪽과 같다(D-13): 모르는 버전의 데이터를
// 지금 표에 밀어 넣으면 조용히 컬럼이 잘린다. 앱을 올린 뒤 다시 가져오게 한다.
export function validateExport(data) {
  if (!data || typeof data !== 'object') return '읽을 수 없는 파일입니다';
  if (data.app !== 'whenwork') return 'WHENWORK가 내보낸 파일이 아닙니다';
  if (!Array.isArray(data.project) || !Array.isArray(data.item)) {
    return '내보내기 파일의 형식이 올바르지 않습니다';
  }
  if (data.event != null && !Array.isArray(data.event)) {
    return '내보내기 파일의 형식이 올바르지 않습니다';
  }
  const sv = Number(data.schema_version);
  if (!Number.isFinite(sv) || sv < 1) return '내보내기 파일의 형식이 올바르지 않습니다';
  if (sv > MIGRATIONS.length) {
    return '더 새로운 버전에서 내보낸 파일입니다 — 앱을 업데이트한 뒤 다시 가져오세요';
  }
  for (const r of data.project) {
    if (!Number.isInteger(r?.id) || typeof r?.name !== 'string' || !r.name.trim()) {
      return '프로젝트 자료가 손상되었습니다';
    }
  }
  const KINDS = new Set(['inbox', 'todo', 'waiting']);
  for (const r of data.item) {
    if (typeof r?.id !== 'string' || !r.id) return '항목 자료가 손상되었습니다';
    if (typeof r?.title !== 'string' || !r.title) return '항목 자료가 손상되었습니다';
    if (typeof r?.captured_at !== 'string' || !r.captured_at) return '항목 자료가 손상되었습니다';
    if (r.kind != null && !KINDS.has(r.kind)) return '항목 자료가 손상되었습니다';
  }
  // 항목이 가리키는 프로젝트가 파일 안에 없으면 외래키가 깨진 채로 들어간다
  const ids = new Set(data.project.map((r) => r.id));
  for (const r of data.item) {
    if (r.project_id != null && !ids.has(r.project_id)) return '항목이 가리키는 프로젝트가 파일에 없습니다';
  }
  return null;
}

function migrate(db, file) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  if (current > MIGRATIONS.length) {
    throw new NewerSchemaError(current, MIGRATIONS.length);
  }
  if (current === MIGRATIONS.length) return; // 이미 최신 — 백업도 이행도 필요 없다
  if (current > 0) backupBeforeMigrate(db, file, current);
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
    // 호출부(queue.replayPending·ipc.saveCapture)는 "던지면 실패, 안 던지면 성공"을 전제한다 —
    // 여기서 조용히 {inserted:0}을 돌려주면 반영되지 않은 큐 항목이 성공으로 오인되어
    // 대기 파일이 지워지고 캡처가 영구 유실된다(CR-01).
    if (!db || !state.ok) throw new Error('store not open');
    const insert = db.prepare(
      `INSERT OR IGNORE INTO item (id, project_id, kind, title, captured_at, source, context)
       VALUES (?, ?, ?, ?, ?, 'manual', ?)`
    );
    let inserted = 0;
    let skipped = 0;
    withTransaction(db, () => {
      for (const e of entries) {
        // 재검토 CR-01(656beaa 리뷰의 CR-01을 WR-06이 다른 경로로 재도입한 회귀의 수정):
        // WR-06은 insert.run() 자체를 개별 try/catch로 감쌌었다. item.title NOT NULL 같은
        // 제약 위반은 SQLite 트랜잭션을 무효화하지 않으므로, 파일 안 모든 항목이 같은
        // 결함을 공유하면 insertCaptures가 절대 던지지 않고 { inserted: 0 }을 돌려주었고,
        // replayPending은 이를 성공으로 오인해 대기 파일을 지워 캡처가 영구 유실됐다.
        // 에러 종류로 나누는 대신(node:sqlite가 이를 신뢰성 있게 구분해 주지 않는다)
        // 필수 필드를 insert.run() 호출 전에 여기서 검증해 구조적으로 결함 있는 항목만
        // 조용히 건너뛴다 — 이 continue는 SQL을 건드리지 않으므로 트랜잭션을 무효화하지
        // 않는다. insert.run() 자체는 더 이상 try/catch로 감싸지 않는다: 거기서 던지는
        // 예외는 전부 진짜 저장 실패(디스크 풀·I/O 등)이므로 트랜잭션 전체를 롤백시켜
        // 위로 올라가고, replayPending이 대기 파일을 보존해 다음 기동에서 재시도하게
        // 둔다(WR-06 이전 동작으로 복귀).
        if (!e?.id || !e?.captured_at) {
          console.error('insertCaptures: 필수 필드 결함으로 항목을 건너뛴다', e?.id);
          skipped += 1;
          continue;
        }
        // #약어를 걷어내기 전에 쌓인 대기 파일에는 title이 토큰을 뗀 값이고 raw에 원문이
        // 들어 있다. 그 항목을 title로 반영하면 사용자가 친 "#gw"가 조용히 사라진다 —
        // 원문이 있으면 그것을 쓴다. 지금 캡처에는 raw가 없으므로 title이 곧 원문이다.
        const title = e.raw ?? e.title;
        if (!title) {
          console.error('insertCaptures: title 결함으로 항목을 건너뛴다', e.id);
          skipped += 1;
          continue;
        }
        const context = e.context != null ? JSON.stringify(e.context) : null;
        // 분류는 던진 다음에 인박스에서 한다 — 캡처 시점에 프로젝트를 정하는 길은 없어졌다
        const result = insert.run(e.id, null, 'inbox', title, e.captured_at, context);
        if (result.changes) inserted += 1;
      }
    });
    // 파일 안 항목 일부만 결함이면(WR-06이 원래 겨냥한 시나리오) 나머지가 반영됐으므로
    // 여기 걸리지 않고 정상적으로 성공 반환한다. 그러나 항목 전부가 구조 결함으로
    // 건너뛰어졌다면(부분 성공이 전혀 없다면) 성공으로 보고하지 않는다 — replayPending이
    // 이를 성공으로 오인해 대기 파일을 지우면 그 항목들이 영구 유실된다(재검토 CR-01).
    if (entries.length > 0 && skipped === entries.length) {
      throw new Error(`insertCaptures: ${entries.length}건 모두 구조적 결함으로 반영되지 못했다`);
    }
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
    // 보관한 프로젝트는 화면에서 빠져야 한다. status 필터가 없어서 X로 보관해도 목록이
    // 그대로였고, 사용자에게는 "삭제가 안 되는" 것으로 보였다. 1~9 번호와 색도 이 배열의
    // 순서에서 나오므로, 보관한 것이 남아 있으면 번호가 빈 자리를 차지한다.
    const projects = db
      .prepare(`SELECT id, name, status, sort FROM project WHERE status = 'active' ORDER BY sort, name`)
      .all();
    // 지운 것도 함께 내려보낸다. 삭제는 항목과 같은 소프트 삭제라 되돌릴 문이 있어야
    // 하고, 재시작 뒤에는 U 스택이 비어 있으니 화면에 자리가 있어야 한다.
    const deletedProjects = db
      .prepare(
        `SELECT p.id, p.name, p.status, p.sort, p.deleted_at,
                (SELECT count(*) FROM item i WHERE i.project_id = p.id AND i.deleted_at IS NULL) AS item_count
           FROM project p WHERE p.status != 'active' ORDER BY p.deleted_at DESC, p.name`
      )
      .all();
    return {
      projects,
      deletedProjects,
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
      .prepare(`SELECT id, name, status, sort FROM project WHERE status = 'active' ORDER BY sort, id`)
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
  }

  // 프로젝트 삭제 — 항목의 X와 같은 소프트 삭제다. 행은 남는다: 완료된 항목이 이 행을
  // 라벨로 가리키고, 라벨이 떨어진 기록은 기록이 아니다.
  //
  // 미완료 항목은 인박스로 보낸다. 죽은 프로젝트가 살아 있는 일을 가질 수는 없고,
  // 숨겨 두면 그 일이 조용히 사라진다 — 인박스에 다시 나타나 분류를 기다리는 쪽이
  // "잃지 않는다"에 맞다. 되돌리기가 그 항목들을 다시 데려갈 수 있게 id를 돌려준다.
  function deleteProject(id) {
    if (!db || !state.ok) return { movedItemIds: [] };
    return withTransaction(db, () => {
      const moved = db
        .prepare('SELECT id FROM item WHERE project_id = ? AND done_at IS NULL AND deleted_at IS NULL')
        .all(id)
        .map((r) => r.id);
      if (moved.length) {
        const q = db.prepare(`UPDATE item SET project_id = NULL, kind = 'inbox' WHERE id = ?`);
        for (const iid of moved) q.run(iid);
      }
      db.prepare(`UPDATE project SET status = 'deleted', deleted_at = ? WHERE id = ?`).run(
        new Date().toISOString(),
        id
      );
      return { movedItemIds: moved };
    });
  }

  // 삭제를 되돌린다. 인박스로 보냈던 항목도 함께 데려온다 — 그 항목들이 그 사이 다른
  // 프로젝트로 갔거나 완료됐으면 건드리지 않는다(사용자가 손댄 것을 되돌리기가 뒤집지 않게).
  function restoreProject(id, movedItemIds = []) {
    if (!db || !state.ok) return;
    withTransaction(db, () => {
      db.prepare(`UPDATE project SET status = 'active', deleted_at = NULL WHERE id = ?`).run(id);
      const q = db.prepare(
        `UPDATE item SET project_id = ?, kind = 'todo'
         WHERE id = ? AND project_id IS NULL AND kind = 'inbox' AND done_at IS NULL AND deleted_at IS NULL`
      );
      for (const iid of movedItemIds) q.run(id, iid);
    });
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
    const items = db.prepare('DELETE FROM item WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(cutoff);
    // 지운 프로젝트는 **비어 있을 때만** 정리한다. 항목이 하나라도 남아 있으면(완료 기록
    // 포함) 그 기억이 사는 동안 라벨도 산다 — 라벨을 지우면 기록의 뜻이 사라진다.
    const projects = db
      .prepare(
        `DELETE FROM project
         WHERE status != 'active' AND deleted_at IS NOT NULL AND deleted_at < ?
           AND NOT EXISTS (SELECT 1 FROM item WHERE item.project_id = project.id)`
      )
      .run(cutoff);
    return items.changes + projects.changes;
  }

  // 완료 기록 — 오늘 뷰는 12시간만 보여주므로 "어제 뭐 했지"를 볼 창구가 없었다.
  // 커밋 목록은 제거 대상 테이블(수집기)에서 오던 것이라 여기서는 계산하지 않고 항상
  // 빈 배열을 돌려준다 — 호출부와 렌더러가 이 키(commits)를 그대로 읽으므로 모양은 유지한다.
  // days가 null이면 전 기간. 완료 항목은 이 앱의 기억이라 "그거 했었나?"에 답하려면
  // 끝까지 닿아야 한다 — 7일 고정일 때는 22건 중 19건이 어디서도 보이지 않았다.
  function getHistory(days = 7) {
    if (!db || !state.ok) return { items: [], commits: [] };
    const where = `i.deleted_at IS NULL AND i.done_at IS NOT NULL${days == null ? '' : ' AND i.done_at > ?'}`;
    const stmt = db.prepare(
      `SELECT i.id, i.title, i.kind, i.done_at, i.project_id, p.name AS project_name
       FROM item i LEFT JOIN project p ON p.id = i.project_id
       WHERE ${where}
       ORDER BY i.done_at DESC`
    );
    const rows = days == null ? stmt.all() : stmt.all(new Date(Date.now() - days * 86400_000).toISOString());
    return { items: rows, commits: [] };
  }

  // 아침 브리핑 재료 — 이번 페이즈에서 걷어낸 테이블·칼럼에 기대는 원본의 서브쿼리·조인은
  // 통째로 드롭한다(RESEARCH Pitfall 1). main/brief.mjs의 briefingLines()가 이 여섯 필드
  // 밖의 값을 모두 falsy 가드로 감싸고 있어 축소된 결과만 넘겨도 문구가 깨지지 않는다.
  function briefing(staleDays = 5) {
    if (!db || !state.ok) {
      return { overdue: 0, due_today: 0, inbox: 0, open_todo: 0, oldest_todo_days: 0, stale_waiting: 0 };
    }
    // WR-01: due는 로컬 캘린더 날짜(D-10)로 저장되는데 toISOString()은 UTC 날짜를 뽑아,
    // 한국 시간 자정~09시 사이에는 로컬 날짜가 이미 넘어갔지만 UTC 날짜는 전날이라 overdue/
    // due_today 판정이 하루 어긋난다. dayKey()(main/brief.mjs, main/ipc.mjs weekLabel과 동일한
    // getFullYear/getMonth/getDate 기반)로 로컬 날짜를 뽑는다.
    const today = dayKey();
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

  // ── 내보내기·가져오기 (DATA-01~03)
  //
  // 사람이 읽을 수 있는 JSON 하나로 전부 내보낸다. 표 이름·컬럼 이름을 그대로 쓰고
  // 들여쓰기를 둔다 — 사용자가 열어 보고 필요하면 손으로 고칠 수 있어야 데이터를
  // 자기 것으로 소유한다고 할 수 있다. schema는 가져오기 쪽이 호환을 판단하는 근거다.
  const EXPORT_VERSION = 1;

  function exportAll() {
    if (!db || !state.ok) throw new Error('store not open');
    return {
      app: 'whenwork',
      export_version: EXPORT_VERSION,
      schema_version: MIGRATIONS.length,
      exported_at: new Date().toISOString(),
      project: db.prepare('SELECT id, name, status, sort FROM project ORDER BY sort, id').all(),
      item: db
        .prepare(
          `SELECT id, project_id, kind, title, due, waiting_for, captured_at, done_at,
                  source, context, note, nudged_at, nudge_count, deleted_at
             FROM item ORDER BY captured_at`
        )
        .all(),
      event: db.prepare('SELECT id, at, kind, detail FROM event ORDER BY at').all(),
    };
  }

  // 가져오기는 **전부 갈아끼운다**(합치지 않는다). 합치기는 같은 id가 양쪽에 있을 때
  // 무엇이 이기는지를 사용자가 알 수 없어, 되돌릴 수 없는 방식으로 조용히 섞인다.
  // 갈아끼우기는 "이 파일의 상태가 된다"는 한 문장으로 설명되고, 직전 백업으로 되돌아간다.
  //
  // 백업이 실패하면 가져오지 않는다(D-16의 예외) — 이행 전 백업은 실패해도 이행이
  // 진행될 이유가 있지만(스키마를 안 올리면 앱을 못 쓴다), 가져오기는 사용자가 지금
  // 고른 행위라 되돌릴 자리가 없으면 하지 않는 편이 낫다.
  function importAll(data) {
    if (!db || !state.ok) throw new Error('store not open');
    const bad = validateExport(data);
    if (bad) throw new Error(bad);
    const backup = backupNow('import');
    withTransaction(db, () => {
      db.exec('DELETE FROM item');
      db.exec('DELETE FROM event');
      db.exec('DELETE FROM project');
      const ip = db.prepare('INSERT INTO project (id, name, status, sort) VALUES (?, ?, ?, ?)');
      // 옛 내보내기 파일에는 abbr이 들어 있다 — 그 필드는 그냥 버린다(스키마에 자리가 없다).
      // schema_version이 지금보다 낮은 파일은 validateExport가 통과시키므로 여기서 깨지면 안 된다.
      for (const r of data.project) ip.run(r.id, r.name, r.status ?? 'active', r.sort ?? 0);
      const ii = db.prepare(
        `INSERT INTO item (id, project_id, kind, title, due, waiting_for, captured_at, done_at,
                           source, context, note, nudged_at, nudge_count, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const r of data.item) {
        ii.run(
          r.id, r.project_id ?? null, r.kind ?? 'inbox', r.title, r.due ?? null, r.waiting_for ?? null,
          r.captured_at, r.done_at ?? null, r.source ?? 'manual',
          // context는 객체로 내보냈으면 객체로 돌아와야 한다 — 문자열이면 그대로 둔다
          r.context == null ? null : typeof r.context === 'string' ? r.context : JSON.stringify(r.context),
          r.note ?? null, r.nudged_at ?? null, Number(r.nudge_count ?? 0), r.deleted_at ?? null
        );
      }
      const ie = db.prepare('INSERT INTO event (id, at, kind, detail) VALUES (?, ?, ?, ?)');
      for (const r of data.event ?? []) ie.run(r.id ?? null, r.at, r.kind, r.detail ?? null);
    });
    return { backup, project: data.project.length, item: data.item.length, event: (data.event ?? []).length };
  }

  // 가져오기 직전 백업 — 이행 전 백업과 같은 자리에 같은 방식으로 둔다(WAL 먼저 합친다).
  // 여기서는 실패를 삼키지 않는다: 되돌릴 자리가 없으면 가져오기 자체를 하지 않는다.
  function backupNow(reason = 'manual') {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const dir = path.join(path.dirname(file), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    // `.`을 이스케이프하지 않으면(/..+$/) 아무 문자에나 붙어 문자열 전체를 먹는다 —
    // 실제로 그래서 이름이 `store-import-.sqlite`로 나왔고, 가져오기를 두 번 하면
    // 두 번째가 첫 번째 백업을 덮어써 되돌릴 자리가 사라진다.
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    const dest = path.join(dir, `store-${reason}-${stamp}.sqlite`);
    fs.copyFileSync(file, dest);
    pruneOldBackups(dir);
    return dest;
  }

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
    deleteProject,
    restoreProject,
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
    schemaVersion: () => MIGRATIONS.length,
    exportAll,
    importAll,
    backupNow,
    file,
  };
}
