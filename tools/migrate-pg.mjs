// tools/migrate-pg.mjs — 개인용 PostgreSQL 데이터를 내장 저장소(store.sqlite)로 한 번 옮긴다.
//
// **공개 앱 UI에는 노출되지 않는다**(DATA-04). 작성자 본인이 옛 데이터를 새 앱으로
// 가져오는 1회성 도구라 tools/ 아래에 두고, 앱은 이 파일을 import하지 않는다
// (electron-builder의 files에도 main/·renderer/만 들어간다).
//
//   node tools/migrate-pg.mjs --out <store.sqlite 경로> [--dry-run]
//
// 접속 정보는 PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE 환경변수를 따른다 —
// 기본값은 개인용 docker-compose와 같다. 옮기는 표는 project·item·event 셋뿐이다:
// activity·issue·resume_card·repo_state·cal_event·review는 제거된 기능의 것이라
// 새 스키마에 자리가 없다(STOR-05, D-09).
//
// 네 가지를 옮기고 나서 **스스로 검사한다**(실패하면 0이 아닌 코드로 끝난다):
//   1) 행 수 일치 — 옮긴 쪽과 읽은 쪽의 건수가 같은가
//   2) UTC 보존 — timestamptz를 로컬 시각으로 바꿔 적지 않았는가
//   3) context JSON 왕복 — jsonb가 객체 그대로 돌아오는가
//   4) soft-delete 판정 — deleted_at이 있는 행이 삭제된 것으로 남는가
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { createStore } from '../main/store.mjs';

const args = process.argv.slice(2);
const argValue = (name) => {
  const hit = args.find((a) => a.startsWith(name));
  return hit ? hit.slice(name.length) : null;
};
const OUT = argValue('--out=');
const DRY = args.includes('--dry-run');

// PostgreSQL의 timestamptz는 pg 드라이버가 로컬 Date로 준다. 새 저장소는 ISO UTC 문자열로
// 적으므로 toISOString()이 곧 보존이다 — 여기서 로컬 포맷으로 찍으면 9시간이 밀린다.
const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

// due는 PostgreSQL date(시각 없음)다. Date로 받으면 로컬 자정이 되어 UTC로 바꾸는 순간
// 날짜가 하루 당겨진다(KST 자정 → 전날 15:00Z). 날짜는 날짜로만 적는다.
const dateOnly = (v) => {
  if (v == null) return null;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
};

async function main() {
  const client = new pg.Client({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5433),
    user: process.env.PGUSER ?? 'whenwork',
    password: process.env.PGPASSWORD ?? 'whenwork',
    database: process.env.PGDATABASE ?? 'whenwork',
    connectionTimeoutMillis: 5000,
  });
  await client.connect();

  const projects = (
    await client.query('SELECT id, name, status, sort FROM project ORDER BY sort, id')
  ).rows;

  // 제거된 기능이 만든 컬럼(suggested_project_id·issue_*·done_suggest_*)은 읽지 않는다 —
  // 새 스키마에 자리가 없고, 있었어도 그 기능이 사라졌으니 의미가 없다.
  const items = (
    await client.query(
      `SELECT id, project_id, kind, title, due, waiting_for, captured_at, done_at,
              source, context, note, nudged_at, nudge_count, deleted_at
         FROM item ORDER BY captured_at`
    )
  ).rows;

  const events = (await client.query('SELECT id, at, kind, detail FROM event ORDER BY at')).rows;

  await client.end();

  const payload = {
    project: projects.map((r) => ({
      id: Number(r.id),
      name: r.name,
      status: r.status ?? 'active',
      sort: Number(r.sort ?? 0),
    })),
    item: items.map((r) => ({
      id: String(r.id),
      project_id: r.project_id == null ? null : Number(r.project_id),
      kind: r.kind ?? 'inbox',
      title: r.title,
      due: dateOnly(r.due),
      waiting_for: r.waiting_for ?? null,
      captured_at: iso(r.captured_at),
      done_at: iso(r.done_at),
      source: r.source ?? 'manual',
      // jsonb는 드라이버가 이미 객체로 준다 — 문자열로 굳히지 않고 그대로 넘긴다
      context: r.context ?? null,
      note: r.note ?? null,
      nudged_at: iso(r.nudged_at),
      nudge_count: Number(r.nudge_count ?? 0),
      deleted_at: iso(r.deleted_at),
    })),
    event: events.map((r) => ({
      id: Number(r.id),
      at: iso(r.at),
      kind: r.kind,
      detail: r.detail ?? null,
    })),
  };

  console.log(`읽음 — 프로젝트 ${payload.project.length} · 항목 ${payload.item.length} · 이벤트 ${payload.event.length}`);

  if (DRY) {
    console.log('--dry-run: 저장소에 쓰지 않고 끝냅니다');
    return 0;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const store = createStore(OUT);
  store.open();
  const st = store.status();
  if (!st.ok) {
    console.error(`저장소를 열 수 없습니다: ${st.notice ?? '원인 불명'}`);
    return 1;
  }

  // 가져오기와 같은 길을 쓴다 — 검증·직전 백업·갈아끼우기가 한 곳에만 있어야
  // 이전 스크립트만 조용히 다른 규칙으로 쓰는 일이 생기지 않는다.
  const out = store.importAll({
    app: 'whenwork',
    export_version: 1,
    schema_version: store.schemaVersion(),
    exported_at: new Date().toISOString(),
    ...payload,
  });

  const problems = verify(store, payload);
  store.close();

  if (problems.length) {
    console.error('검사 실패:');
    for (const p of problems) console.error('  - ' + p);
    console.error(`직전 상태는 ${out.backup} 에 남아 있습니다`);
    return 1;
  }
  console.log(`옮김 — 프로젝트 ${out.project} · 항목 ${out.item} · 이벤트 ${out.event}`);
  console.log(`직전 상태 백업: ${out.backup}`);
  console.log('검사 통과 — 행 수 일치 · UTC 보존 · context 왕복 · soft-delete 판정');
  return 0;
}

// 옮긴 결과를 저장소에서 **다시 읽어** 원본과 맞춰 본다. 쓴 값을 그대로 믿지 않는다 —
// 이 네 가지가 조용히 어긋나는 것이 이전 작업에서 실제로 잃는 것들이다.
export function verify(store, src) {
  const problems = [];
  const after = store.exportAll();

  // 1) 행 수 일치
  for (const t of ['project', 'item', 'event']) {
    if (after[t].length !== src[t].length) {
      problems.push(`${t} 행 수가 다릅니다: 원본 ${src[t].length} → 저장소 ${after[t].length}`);
    }
  }

  const byId = new Map(after.item.map((r) => [r.id, r]));

  for (const s of src.item) {
    const d = byId.get(s.id);
    if (!d) {
      problems.push(`항목이 빠졌습니다: ${s.id}`);
      continue;
    }
    // 2) UTC 보존 — 문자열이 같아야 한다(로컬로 찍혔으면 여기서 어긋난다)
    for (const f of ['captured_at', 'done_at', 'nudged_at', 'deleted_at']) {
      if ((s[f] ?? null) !== (d[f] ?? null)) {
        problems.push(`${s.id}의 ${f}가 달라졌습니다: ${s[f]} → ${d[f]}`);
      }
    }
    if ((s.due ?? null) !== (d.due ?? null)) {
      problems.push(`${s.id}의 due가 달라졌습니다: ${s.due} → ${d.due}`);
    }
    // 3) context JSON 왕복
    const back = d.context == null ? null : typeof d.context === 'string' ? JSON.parse(d.context) : d.context;
    if (JSON.stringify(s.context ?? null) !== JSON.stringify(back ?? null)) {
      problems.push(`${s.id}의 context가 왕복하지 않았습니다`);
    }
  }

  // 4) soft-delete 판정 — 지운 것은 지워진 채로, 살아 있는 것은 화면에 보이게
  const srcDeleted = new Set(src.item.filter((r) => r.deleted_at).map((r) => r.id));
  const view = store.getViewState();
  const visible = new Set([...view.today, ...view.inbox, ...view.waiting].map((r) => r.id));
  for (const id of srcDeleted) {
    if (visible.has(id)) problems.push(`지운 항목이 화면에 남았습니다: ${id}`);
  }
  for (const s of src.item) {
    if (!s.deleted_at && (byId.get(s.id)?.deleted_at ?? null) !== null) {
      problems.push(`지우지 않은 항목이 삭제된 것으로 들어갔습니다: ${s.id}`);
    }
  }
  return problems;
}

// import해서 verify만 쓰는 경우(테스트)에는 실행하지 않는다
if (process.argv[1] && process.argv[1].endsWith('migrate-pg.mjs')) {
  if (!OUT) {
    console.error('사용법: node tools/migrate-pg.mjs --out=<store.sqlite 경로> [--dry-run]');
    process.exit(2);
  }
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('이전 실패:', err?.message ?? err);
      process.exit(1);
    });
}
