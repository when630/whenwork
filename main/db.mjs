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
CREATE UNIQUE INDEX IF NOT EXISTS activity_uniq ON activity (project_id, ref) WHERE ref IS NOT NULL;
`;

// 초기 프로젝트 시드. repo는 리모트로 확실히 확인된 것만 — 나머지는 사용자가 채운다.
const SEED = [
  { name: '시재건설', abbr: 'sj', repos: [] },
  { name: '서식갤러리', abbr: 'fg', repos: ['D:/AIProject/formgallery'] },
  { name: 'GoWrite', abbr: 'gw', repos: ['D:/AIProject/gowrite'] },
  { name: 'eformsign', abbr: 'ef', repos: [] },
  { name: 'whenwork', abbr: 'ww', repos: ['D:/AIProject/whenwork'] },
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
    // repo 경로 채우기 — 사용자가 손대지 않은(빈) 것만, 언제 켜도 멱등
    for (const s of SEED) {
      if (s.repos?.length) {
        await pool.query(
          "UPDATE project SET repo_paths = $2 WHERE name = $1 AND repo_paths = '{}'",
          [s.name, s.repos]
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
      "SELECT id, name, abbr, repo_paths, sort FROM project WHERE status = 'active' ORDER BY sort, id"
    );
    return rows;
  }

  // ── M2: 수집기·재개 카드
  async function insertActivities(projectId, rows) {
    await ensureSchema();
    for (const a of rows) {
      await pool.query(
        `INSERT INTO activity (project_id, occurred_at, kind, ref, summary)
         VALUES ($1, $2, 'commit', $3, $4)
         ON CONFLICT (project_id, ref) WHERE ref IS NOT NULL DO NOTHING`,
        [projectId, a.occurred_at, a.ref, a.summary]
      );
    }
  }

  async function getActivities(projectId, limit = 10) {
    const { rows } = await pool.query(
      'SELECT occurred_at, kind, ref, summary FROM activity WHERE project_id = $1 ORDER BY occurred_at DESC LIMIT $2',
      [projectId, limit]
    );
    return rows;
  }

  async function upsertIssues(projectId, issues) {
    await ensureSchema();
    for (const i of issues) {
      await pool.query(
        `INSERT INTO issue (project_id, provider, number, title, state, relation, url, updated_at, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (project_id, provider, number)
         DO UPDATE SET title = $4, state = $5, relation = $6, url = $7, updated_at = $8, synced_at = now()`,
        [projectId, i.provider, i.number, i.title, i.state, i.relation, i.url, i.updated_at]
      );
    }
  }

  async function getIssues(projectId, limit = 8) {
    // 열림 우선, 닫힘은 최근 것만 딸려온다 (설계 11절)
    const { rows } = await pool.query(
      `SELECT provider, number, title, state, relation, url, updated_at, synced_at
       FROM issue WHERE project_id = $1
       ORDER BY (state = 'open') DESC, updated_at DESC LIMIT $2`,
      [projectId, limit]
    );
    return rows;
  }

  async function getDoneItems(projectId, days = 7) {
    const { rows } = await pool.query(
      `SELECT title, done_at FROM item
       WHERE project_id = $1 AND done_at > now() - ($2 || ' days')::interval
       ORDER BY done_at DESC LIMIT 20`,
      [projectId, String(days)]
    );
    return rows;
  }

  async function getResumeCard(projectId) {
    const { rows } = await pool.query(
      'SELECT last_work, stuck_point, next_action, generated_at FROM resume_card WHERE project_id = $1',
      [projectId]
    );
    return rows[0] ?? null;
  }

  async function saveResumeCard(projectId, card) {
    await pool.query(
      `INSERT INTO resume_card (project_id, last_work, stuck_point, next_action, generated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (project_id)
       DO UPDATE SET last_work = $2, stuck_point = $3, next_action = $4, generated_at = now()`,
      [projectId, card.last_work, card.stuck_point, card.next_action]
    );
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
    insertActivities,
    getActivities,
    upsertIssues,
    getIssues,
    getDoneItems,
    getResumeCard,
    saveResumeCard,
    completeItem,
    uncompleteItem,
    assignProject,
    toWaiting,
    removeItem,
    close,
  };
}
