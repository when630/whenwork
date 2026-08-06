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

-- 나중에 붙인 칼럼들. CREATE TABLE IF NOT EXISTS는 기존 테이블을 손대지 않으므로 따로 건다.
ALTER TABLE item ADD COLUMN IF NOT EXISTS suggested_project_id int REFERENCES project(id);
ALTER TABLE item ADD COLUMN IF NOT EXISTS note text;
-- 삭제는 지우지 않고 표시만 한다 — 한 키에 사라지는 항목이 있으면 "캡처 손실 0건"이 성립하지 않는다.
-- 되돌릴 수 있는 창(PURGE_DAYS)이 지나면 물리 삭제한다.
ALTER TABLE item ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- issue 테이블은 PR/MR까지 담는다. GitHub는 이슈와 PR이 번호를 공유하지만 GitLab의
-- issue iid와 MR iid는 별개 공간이라 kind 없이는 서로를 덮어쓴다 — 유일성을 kind까지 넣어 다시 잡는다.
ALTER TABLE issue ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'issue';
ALTER TABLE issue ADD COLUMN IF NOT EXISTS draft boolean NOT NULL DEFAULT false;
ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_kind_check;
ALTER TABLE issue ADD CONSTRAINT issue_kind_check CHECK (kind IN ('issue','pr'));
-- 리뷰 요청받은 PR이 늘어난 관계다. 자기 PR에 자기를 리뷰어로 넣을 수는 없으니 조합은 생기지 않는다.
ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_relation_check;
ALTER TABLE issue ADD CONSTRAINT issue_relation_check
  CHECK (relation IN ('author','assignee','both','reviewer'));
ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_project_id_provider_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS issue_uniq ON issue (project_id, provider, kind, number);

-- KPI 원장 (9절). 앱이 남기는 사용 흔적 — 지표 계산용이라 지워도 기능에는 영향 없다.
CREATE TABLE IF NOT EXISTS event (
  id     bigserial PRIMARY KEY,
  at     timestamptz NOT NULL DEFAULT now(),
  kind   text NOT NULL,
  detail text
);
CREATE INDEX IF NOT EXISTS event_at ON event (at DESC);

-- 주간 리뷰 초안. DB가 원본이고 볼트 파일은 거기서 만든 뷰다(D5) — 앱은 파일 없이도 보여준다.
CREATE TABLE IF NOT EXISTS review (
  year         int NOT NULL,
  week         int NOT NULL,
  body         text NOT NULL,
  range_label  text,
  file         text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (year, week)
);
`;

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
    // 프로젝트 시드 없음 — 프로젝트는 앱의 프로젝트 탭에서 사용자가 만든다 (DB가 유일 원본)
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

  // 큐 항목 반영 — id(uuid)가 멱등 키라 재시도돼도 중복이 없다.
  // 캡처에 #약어가 붙어 있었으면 여기서 프로젝트로 풀어 인박스를 건너뛴다(캡처 경로는 DB를 모른다).
  async function insertCaptures(entries) {
    await ensureSchema();
    for (const e of entries) {
      let projectId = null;
      if (e.abbr) {
        const { rows } = await pool.query(
          "SELECT id FROM project WHERE lower(abbr) = lower($1) AND status = 'active'",
          [e.abbr]
        );
        projectId = rows[0]?.id ?? null;
      }
      await pool.query(
        `INSERT INTO item (id, project_id, kind, title, captured_at, source, context)
         VALUES ($1, $2, $3, $4, $5, 'manual', $6)
         ON CONFLICT (id) DO NOTHING`,
        [e.id, projectId, projectId ? 'todo' : 'inbox', e.title, e.captured_at, e.context ?? null]
      );
    }
  }

  async function logEvent(kind, detail = null) {
    try {
      await pool.query('INSERT INTO event (kind, detail) VALUES ($1, $2)', [kind, detail]);
    } catch {
      // 지표 기록이 기능을 막지 않는다
    }
  }

  async function getProjects() {
    await ensureSchema();
    const { rows } = await pool.query(
      "SELECT id, name, abbr, repo_paths, sort FROM project WHERE status = 'active' ORDER BY sort, id"
    );
    return rows;
  }

  // ── 프로젝트 관리 — 시드·하드코딩 없이 전부 여기서
  async function createProject(name) {
    await ensureSchema();
    const { rows } = await pool.query(
      'INSERT INTO project (name, sort) VALUES ($1, (SELECT coalesce(max(sort), 0) + 1 FROM project)) ON CONFLICT (name) DO NOTHING RETURNING id',
      [name]
    );
    return rows[0]?.id ?? null;
  }

  async function updateProject(id, fields) {
    if (fields.name != null) await pool.query('UPDATE project SET name = $2 WHERE id = $1', [id, fields.name]);
    if (fields.abbr != null) await pool.query('UPDATE project SET abbr = $2 WHERE id = $1', [id, fields.abbr || null]);
  }

  async function setRepoPaths(id, paths) {
    await pool.query('UPDATE project SET repo_paths = $2 WHERE id = $1', [id, paths]);
  }

  async function archiveProject(id) {
    await pool.query("UPDATE project SET status = 'archived' WHERE id = $1", [id]);
  }

  // 순서 변경 — 이웃과 자리를 바꾸고 sort를 0..n으로 정규화해 충돌을 없앤다
  async function moveProject(id, dir) {
    const projects = await getProjects();
    const i = projects.findIndex((p) => p.id === id);
    const j = i + (dir === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= projects.length) return;
    [projects[i], projects[j]] = [projects[j], projects[i]];
    for (let k = 0; k < projects.length; k++) {
      await pool.query('UPDATE project SET sort = $2 WHERE id = $1', [projects[k].id, k]);
    }
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
        `INSERT INTO issue (project_id, provider, kind, number, title, state, relation, url, draft, updated_at, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (project_id, provider, kind, number)
         DO UPDATE SET title = $5, state = $6, relation = $7, url = $8, draft = $9,
                       updated_at = $10, synced_at = now()`,
        [
          projectId,
          i.provider,
          i.kind ?? 'issue',
          i.number,
          i.title,
          i.state,
          i.relation,
          i.url,
          i.draft ?? false,
          i.updated_at,
        ]
      );
    }
  }

  async function getIssues(projectId, limit = 12) {
    // 열림 우선, 그중에서도 내 리뷰를 기다리는 것부터 — 남을 막고 있는 일이 가장 급하다.
    // 닫힘·머지는 최근 것만 딸려온다 (설계 11절)
    const { rows } = await pool.query(
      `SELECT provider, kind, number, title, state, relation, url, draft, updated_at, synced_at
       FROM issue WHERE project_id = $1
       ORDER BY (state = 'open') DESC, (relation = 'reviewer') DESC, updated_at DESC LIMIT $2`,
      [projectId, limit]
    );
    return rows;
  }

  async function getDoneItems(projectId, days = 7) {
    const { rows } = await pool.query(
      `SELECT title, done_at FROM item
       WHERE project_id = $1 AND deleted_at IS NULL
         AND done_at > now() - ($2 || ' days')::interval
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
              i.waiting_for, i.captured_at, i.done_at, i.context, i.note,
              i.suggested_project_id, s.name AS suggested_project_name
       FROM item i
       LEFT JOIN project p ON p.id = i.project_id
       LEFT JOIN project s ON s.id = i.suggested_project_id
       WHERE i.deleted_at IS NULL
         AND (i.done_at IS NULL OR i.done_at > now() - interval '12 hours')
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
      "UPDATE item SET project_id = $2, kind = 'todo', suggested_project_id = NULL WHERE id = $1",
      [id, projectId]
    );
  }

  async function setDue(id, due) {
    await pool.query('UPDATE item SET due = $2 WHERE id = $1', [id, due]);
  }

  async function setNote(id, note) {
    await pool.query('UPDATE item SET note = $2 WHERE id = $1', [id, note || null]);
  }

  // AI 분류 제안 — 사람 입력이 아니므로 언제든 덮어쓰고 버릴 수 있다 (설계 6절)
  async function setSuggestions(pairs) {
    for (const { id, project_id } of pairs) {
      await pool.query('UPDATE item SET suggested_project_id = $2 WHERE id = $1', [id, project_id]);
    }
  }

  async function getInbox() {
    const { rows } = await pool.query(
      "SELECT id, title, context FROM item WHERE kind = 'inbox' AND done_at IS NULL AND deleted_at IS NULL ORDER BY captured_at"
    );
    return rows;
  }

  async function toWaiting(id, waitingFor) {
    await pool.query(
      "UPDATE item SET kind = 'waiting', waiting_for = $2 WHERE id = $1",
      [id, waitingFor ?? null]
    );
  }

  async function renameItem(id, title) {
    await pool.query('UPDATE item SET title = $2 WHERE id = $1', [id, title]);
  }

  // 삭제는 표시만 — 되돌릴 수 있어야 한다(U). 실제 삭제는 purgeDeleted가 나중에 한다.
  async function removeItem(id) {
    await pool.query('UPDATE item SET deleted_at = now() WHERE id = $1', [id]);
  }

  async function restoreItem(id) {
    await pool.query('UPDATE item SET deleted_at = NULL WHERE id = $1', [id]);
  }

  // 되돌릴 수 있는 창이 지난 삭제분을 실제로 비운다. 기동 시 1회.
  async function purgeDeleted(days = 30) {
    await ensureSchema();
    const { rowCount } = await pool.query(
      "DELETE FROM item WHERE deleted_at < now() - ($1 || ' days')::interval",
      [String(days)]
    );
    return rowCount;
  }

  // 주간 리뷰 재료 — 기간 안의 완료 항목·커밋·대기·열린 이슈를 프로젝트별로 모은다
  async function weeklyMaterial(from, to) {
    await ensureSchema();
    const done = await pool.query(
      `SELECT p.name AS project, i.title, i.done_at
       FROM item i LEFT JOIN project p ON p.id = i.project_id
       WHERE i.deleted_at IS NULL AND i.done_at >= $1 AND i.done_at < $2
       ORDER BY p.name NULLS LAST, i.done_at`,
      [from, to]
    );
    const commits = await pool.query(
      `SELECT p.name AS project, a.summary, a.occurred_at
       FROM activity a JOIN project p ON p.id = a.project_id
       WHERE a.occurred_at >= $1 AND a.occurred_at < $2
       ORDER BY p.name, a.occurred_at`,
      [from, to]
    );
    const waiting = await pool.query(
      `SELECT p.name AS project, i.title, i.waiting_for, i.captured_at
       FROM item i LEFT JOIN project p ON p.id = i.project_id
       WHERE i.kind = 'waiting' AND i.done_at IS NULL AND i.deleted_at IS NULL
       ORDER BY i.captured_at`
    );
    const openTodos = await pool.query(
      `SELECT p.name AS project, i.title, i.due
       FROM item i LEFT JOIN project p ON p.id = i.project_id
       WHERE i.kind = 'todo' AND i.done_at IS NULL AND i.deleted_at IS NULL
       ORDER BY i.due NULLS LAST`
    );
    return {
      done: done.rows,
      commits: commits.rows,
      waiting: waiting.rows,
      openTodos: openTodos.rows,
    };
  }

  // 완료 기록 — 오늘 뷰는 12시간만 보여주므로 "어제 뭐 했지"를 볼 창구가 없었다.
  // 손으로 체크한 항목과 git이 자동 수집한 커밋을 같이 내려보낸다 (설계 2절: 한 일은 자동 수집)
  async function getHistory(days = 7) {
    await ensureSchema();
    const items = await pool.query(
      `SELECT i.id, i.title, i.kind, i.done_at, i.project_id, p.name AS project_name
       FROM item i LEFT JOIN project p ON p.id = i.project_id
       WHERE i.deleted_at IS NULL AND i.done_at > now() - ($1 || ' days')::interval
       ORDER BY i.done_at DESC`,
      [String(days)]
    );
    const commits = await pool.query(
      `SELECT a.ref, a.summary, a.occurred_at, a.project_id, p.name AS project_name
       FROM activity a JOIN project p ON p.id = a.project_id
       WHERE a.occurred_at > now() - ($1 || ' days')::interval
       ORDER BY a.occurred_at DESC`,
      [String(days)]
    );
    return { items: items.rows, commits: commits.rows };
  }

  // 아침 브리핑 재료 (오픈이슈 #3) — 지금 챙겨야 하는 것의 건수만 센다
  async function briefing(staleDays = 5) {
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT
         count(*) FILTER (WHERE kind = 'todo' AND due < current_date)   AS overdue,
         count(*) FILTER (WHERE kind = 'todo' AND due = current_date)   AS due_today,
         count(*) FILTER (WHERE kind = 'inbox')                          AS inbox,
         count(*) FILTER (WHERE kind = 'waiting'
                            AND captured_at < now() - ($1 || ' days')::interval) AS stale_waiting
       FROM item
       WHERE deleted_at IS NULL AND done_at IS NULL`,
      [String(staleDays)]
    );
    // count(*)는 bigint라 문자열로 온다 — 숫자로 바꿔 넘긴다
    return Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]));
  }

  async function getReview(year, week) {
    await ensureSchema();
    const { rows } = await pool.query(
      'SELECT year, week, body, range_label, file, generated_at FROM review WHERE year = $1 AND week = $2',
      [year, week]
    );
    return rows[0] ?? null;
  }

  async function saveReview({ year, week, body, range_label, file }) {
    await pool.query(
      `INSERT INTO review (year, week, body, range_label, file, generated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (year, week)
       DO UPDATE SET body = $3, range_label = $4, file = $5, generated_at = now()`,
      [year, week, body, range_label, file]
    );
  }

  // 백업용 전량 덤프. 되살릴 때 순서가 중요하므로(참조 관계) 배열 순서를 지킨다.
  const EXPORT_TABLES = ['project', 'item', 'activity', 'issue', 'resume_card', 'review', 'event'];

  async function exportAll() {
    await ensureSchema();
    const out = {};
    for (const t of EXPORT_TABLES) {
      const { rows } = await pool.query(`SELECT * FROM ${t}`);
      out[t] = rows;
    }
    return out;
  }

  async function close() {
    await pool.end();
  }

  return {
    online,
    insertCaptures,
    getProjects,
    getViewState,
    createProject,
    updateProject,
    setRepoPaths,
    archiveProject,
    moveProject,
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
    renameItem,
    removeItem,
    restoreItem,
    purgeDeleted,
    setDue,
    setNote,
    setSuggestions,
    getInbox,
    logEvent,
    weeklyMaterial,
    getHistory,
    briefing,
    getReview,
    saveReview,
    exportAll,
    close,
  };
}
