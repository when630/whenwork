// main/store.mjs — node:sqlite 기반 단일 파일 저장소 (main/db.mjs 대체, D-05)
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

function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  if (current > MIGRATIONS.length) {
    throw new NewerSchemaError(current, MIGRATIONS.length);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    withTransaction(db, () => {
      MIGRATIONS[v](db);
      // PRAGMA는 파라미터 바인딩을 받지 않는다 — 내부에서 계산한 정수라 템플릿 리터럴로 넣는다.
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function createStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db = null;
  let state = { ok: false, reason: null, notice: null, quarantined: null };

  function open() {
    try {
      db = new DatabaseSync(file);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      migrate(db);
      state = { ok: true, reason: null, notice: null, quarantined: null };
    } catch (err) {
      if (db) {
        try {
          db.close();
        } catch {
          // 이미 망가진 핸들이면 닫기도 실패할 수 있다 — 무시한다
        }
      }
      db = null;
      state = {
        ok: false,
        reason: 'error',
        notice: '저장소를 열지 못했습니다 — 캡처는 로컬 큐에 안전하게 쌓입니다',
        quarantined: null,
      };
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

  open();

  return { open, close, reopen, checkpoint, status, insertCaptures, getViewState, logEvent, file };
}
