// PostgreSQL 저장소 (D2). DB는 캡처 경로 밖에 있다 — 연결 실패는 조용히 견디고
// 큐가 쌓아둔 것을 다음 기회에 흘려보낸다.
import pg from 'pg';

const { Pool } = pg;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  id      serial PRIMARY KEY,
  name    text NOT NULL UNIQUE,
  abbr    text,
  repo_paths text[] NOT NULL DEFAULT '{}',
  status  text NOT NULL DEFAULT 'active',
  sort    int  NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS item (
  id          uuid PRIMARY KEY,
  project_id  int REFERENCES project(id),
  kind        text NOT NULL DEFAULT 'inbox' CHECK (kind IN ('inbox','todo','waiting')),
  title       text NOT NULL,
  due         date,
  waiting_for text,
  captured_at timestamptz NOT NULL,
  done_at     timestamptz,
  source      text NOT NULL DEFAULT 'manual',
  context     jsonb
);
CREATE TABLE IF NOT EXISTS activity (
  id          bigserial PRIMARY KEY,
  project_id  int NOT NULL REFERENCES project(id),
  occurred_at timestamptz NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('commit','note')),
  ref         text,
  summary     text NOT NULL
);
CREATE TABLE IF NOT EXISTS issue (
  id         bigserial PRIMARY KEY,
  project_id int NOT NULL REFERENCES project(id),
  provider   text NOT NULL CHECK (provider IN ('github','gitlab')),
  number     int NOT NULL,
  title      text NOT NULL,
  state      text NOT NULL,
  relation   text NOT NULL CHECK (relation IN ('author','assignee','both')),
  url        text NOT NULL,
  updated_at timestamptz NOT NULL,
  synced_at  timestamptz NOT NULL,
  UNIQUE (project_id, provider, number)
);
CREATE TABLE IF NOT EXISTS resume_card (
  project_id   int PRIMARY KEY REFERENCES project(id),
  last_work    text,
  stuck_point  text,
  next_action  text,
  generated_at timestamptz NOT NULL
);
`;

// 초기 프로젝트 시드 — 이름·약어만 넣는다. repo_paths는 사용자가 채운다(M2 수집기 전까진 안 쓴다).
const SEED = [
  { name: '시재건설', abbr: 'sj' },
  { name: '서식갤러리', abbr: 'fg' },
  { name: 'GoWrite', abbr: 'gw' },
  { name: 'eformsign', abbr: 'ef' },
  { name: 'whenwork', abbr: 'ww' },
];

export function createDb(config = {}) {
  const pool = new Pool({
    host: config.host ?? '127.0.0.1',
    port: config.port ?? 5433,
    user: config.user ?? 'whenwork',
    password: config.password ?? 'whenwork',
    database: config.database ?? 'whenwork',
    // 트레이 상주 앱이라 연결을 오래 붙들 이유가 없다 — 실패도 빨리 알아야 한다
    connectionTimeoutMillis: 2000,
    max: 3,
  });
  // 유휴 클라이언트가 끊겨도(DB 재시작 등) 앱은 죽지 않는다
  pool.on('error', () => {});

  let ready = false;

  async function ensureSchema() {
    if (ready) return;
    await pool.query(SCHEMA);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM project');
    if (rows[0].n === 0) {
      for (let i = 0; i < SEED.length; i++) {
        await pool.query(
          'INSERT INTO project (name, abbr, sort) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING',
          [SEED[i].name, SEED[i].abbr, i]
        );
      }
    }
    ready = true;
  }

  async function online() {
    try {
      await pool.query('SELECT 1');
      await ensureSchema();
      return true;
    } catch {
      ready = false;
      return false;
    }
  }

  // 큐 항목 반영 — id(uuid)가 멱등 키라 재시도돼도 중복이 없다
  async function insertCaptures(entries) {
    await ensureSchema();
    for (const e of entries) {
      await pool.query(
        `INSERT INTO item (id, kind, title, captured_at, source, context)
         VALUES ($1, 'inbox', $2, $3, 'manual', $4)
         ON CONFLICT (id) DO NOTHING`,
        [e.id, e.title, e.captured_at, e.context ?? null]
      );
    }
  }

  async function getProjects() {
    await ensureSchema();
    const { rows } = await pool.query(
      "SELECT id, name, abbr, sort FROM project WHERE status = 'active' ORDER BY sort, id"
    );
    return rows;
  }

  // 오늘 뷰 한 번에 — 탭 3개 분량을 묶어 내려보낸다
  async function getViewState() {
    await ensureSchema();
    const items = await pool.query(
      `SELECT i.id, i.project_id, p.name AS project_name, i.kind, i.title, i.due,
              i.waiting_for, i.captured_at, i.done_at, i.context
       FROM item i LEFT JOIN project p ON p.id = i.project_id
       WHERE i.done_at IS NULL OR i.done_at > now() - interval '12 hours'
       ORDER BY i.due NULLS LAST, i.captured_at`
    );
    return {
      projects: await getProjects(),
      today: items.rows.filter((r) => r.kind === 'todo'),
      inbox: items.rows.filter((r) => r.kind === 'inbox'),
      waiting: items.rows.filter((r) => r.kind === 'waiting'),
    };
  }

  async function completeItem(id) {
    await pool.query('UPDATE item SET done_at = now() WHERE id = $1', [id]);
  }

  async function uncompleteItem(id) {
    await pool.query('UPDATE item SET done_at = NULL WHERE id = $1', [id]);
  }

  async function assignProject(id, projectId) {
    await pool.query(
      "UPDATE item SET project_id = $2, kind = 'todo' WHERE id = $1",
      [id, projectId]
    );
  }

  async function toWaiting(id, waitingFor) {
    await pool.query(
      "UPDATE item SET kind = 'waiting', waiting_for = $2 WHERE id = $1",
      [id, waitingFor ?? null]
    );
  }

  async function removeItem(id) {
    await pool.query('DELETE FROM item WHERE id = $1', [id]);
  }

  async function close() {
    await pool.end();
  }

  return {
    online,
    insertCaptures,
    getProjects,
    getViewState,
    completeItem,
    uncompleteItem,
    assignProject,
    toWaiting,
    removeItem,
    close,
  };
}
