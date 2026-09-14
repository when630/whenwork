# Phase 1: 내장 저장소 전환 - Pattern Map

**Mapped:** 2026-09-14
**Files analyzed:** 10 (신규 4, 수정 3, 삭제 3 — 삭제분도 "무엇을 없애는가"를 명확히 하기 위해 표에 포함)
**Analogs found:** 9 / 10 (스모크 하네스는 부분 analog — SMOKE_PROBE 골격은 있으나 "두 프로세스 수명"에 대한 analog는 코드베이스에 없음)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `main/store.mjs` (신규) | model/service (팩토리) | CRUD | `main/db.mjs` (`createDb`) + `main/queue.mjs` (`createQueue`) | role-match (동기 팩토리 패턴은 queue.mjs가 더 가깝고, CRUD 함수 집합은 db.mjs가 원본) |
| `main/lifecycle.mjs` (신규, index.mjs 분할) | controller (앱 수명) | event-driven | `main/index.mjs` 1390-1479행(`app.whenReady`/`before-quit`/`will-quit`) | exact (순수 이동) |
| `main/ipc.mjs` (신규, index.mjs 분할) | controller (IPC 핸들러) | request-response | `main/index.mjs` 1041-1396행(`ipcMain.handle` 블록) | exact (순수 이동) |
| `main/jobs.mjs` (신규, index.mjs 분할) | service (백그라운드 타이머) | batch | `main/index.mjs` 422-432행(`flush`), 1408-1429행(`setInterval` 블록) | exact (순수 이동) |
| `main/queue.mjs` (수정, `drain` 재작성) | utility (append-only 파일 I/O) | file-I/O | 자기 자신(현재 `drain`, 36-61행) | exact (같은 파일의 함수 하나만 교체) |
| `test/store.test.mjs` (신규) | test | CRUD/batch | `test/queue.test.mjs`(임시 파일 DB 관례) + `test/backup.test.mjs`(스키마 가드 패턴, 92-95행) | role-match |
| STOR-03 kill/restart 스모크 러너 (신규, `test/` 또는 `tools/`) | test (외부 프로세스 하네스) | event-driven | `main/index.mjs` 58-324행(`SMOKE_PROBE`), 328행(`CAPTURE_PROBE`), 1432-1468행(`--smoke` 처리) | partial (단일 프로세스 점검 골격만 analog, 2-프로세스 kill·재기동은 신규 설계) |
| `package.json` (수정, `pg` 이동) | config | — | 자기 자신(`dependencies`/`devDependencies` 블록) | exact |
| `main/db.mjs` (삭제) | — | — | — | 삭제 대상, analog 불필요 |
| `main/backup.mjs` + `test/backup.test.mjs` (삭제) | — | — | — | 삭제 대상, analog 불필요(단 `test/backup.test.mjs`의 스키마 가드 패턴만 `test/store.test.mjs`로 이관) |

## Pattern Assignments

### `main/store.mjs` (model, CRUD) — 신규

**Analog 1 — 팩토리 함수 형태:** `main/queue.mjs`(전체 64행) / `main/settings.mjs`(전체 42행)

두 모듈 모두 "파일 경로를 받아 클로저 상태(`draining`/`timer`)를 쥔 객체를 반환"하는 동일한 팩토리 관용구를 쓴다. `store.mjs`도 이 형태를 그대로 따른다.

```javascript
// main/queue.mjs:7-14 — 팩토리 시그니처와 mkdir 관례
export function createQueue(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let draining = false;
  function append(entry) {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  }
  ...
  return { append, readAll, count, drain, file };
}
```

`store.mjs`는 `export function createStore(file) { ... return { insertCaptures, getViewState, ..., close }; }` 형태로 대응한다. `node:sqlite`의 `DatabaseSync`는 동기 API이므로 `db.mjs`의 `async function` 래핑은 걷어내고 queue.mjs처럼 동기 함수로 쓴다(D-01 요구사항과 일치).

**Analog 2 — 살아남는 CRUD 함수의 원본 SQL(의미 이전 대상):** `main/db.mjs`

```javascript
// main/db.mjs:219-241 — insertCaptures: 약어 해석 + 원문 복원 + 멱등 INSERT
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
    const title = e.abbr && !projectId ? (e.raw ?? `${e.title} #${e.abbr}`) : e.title;
    await pool.query(
      `INSERT INTO item (id, project_id, kind, title, captured_at, source, context)
       VALUES ($1, $2, $3, $4, $5, 'manual', $6)
       ON CONFLICT (id) DO NOTHING`,
      [e.id, projectId, projectId ? 'todo' : 'inbox', title, e.captured_at, e.context ?? null]
    );
  }
}
```
SQLite 이식: `pool.query(sql, params)` → `db.prepare(sql).run(...params)`, `ON CONFLICT (id) DO NOTHING` → `INSERT OR IGNORE INTO ...`(RESEARCH.md SQL 변환 표, 스파이크로 `changes:0` 멱등 확인됨). 약어 해석·원문 복원 로직(주석 포함)은 그대로 옮긴다.

```javascript
// main/db.mjs:469-495 — getViewState: 12시간 완료 창 + NULLS LAST 정렬
async function getViewState() {
  await ensureSchema();
  const items = await pool.query(
    `SELECT ... FROM item i
     LEFT JOIN project p ON p.id = i.project_id
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
```
SQLite 이식: `now() - interval '12 hours'` → 호출부에서 `new Date(Date.now() - 12*3600_000).toISOString()`을 파라미터로 바인딩(D-10, RESEARCH Pattern 3). `NULLS LAST`는 SQLite 3.30+(3.53.1)에서 네이티브 지원(스파이크 확인) — `ORDER BY due NULLS LAST, captured_at` 그대로 사용 가능. D-11에 따라 `suggested_project_id`·`issue_url`·`done_suggested_at` 등 제거 대상 칼럼/조인은 SELECT 절에서 통째로 뺀다.

```javascript
// main/db.mjs:646-653 — purgeDeleted: PG interval → JS Date 계산 전형
async function purgeDeleted(days = 30) {
  await ensureSchema();
  const { rowCount } = await pool.query(
    "DELETE FROM item WHERE deleted_at < now() - ($1 || ' days')::interval",
    [String(days)]
  );
  return rowCount;
}
```
SQLite 이식(RESEARCH.md 예시 그대로): `const cutoff = new Date(Date.now() - days*86400_000).toISOString(); db.prepare('DELETE FROM item WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(cutoff).changes`

```javascript
// main/db.mjs:528-538 — nudgeItem: 30분 dedup 판정(JS Date.now() 사용, 이식 변경 없음)
async function nudgeItem(id) {
  const before = await pool.query('SELECT nudged_at, nudge_count FROM item WHERE id = $1', [id]);
  const prev = before.rows[0];
  if (!prev) return null;
  const repeated =
    !!prev.nudged_at && Date.now() - new Date(prev.nudged_at).getTime() < NUDGE_DEDUP_MIN * 60_000;
  const { rows } = await pool.query(
    'UPDATE item SET nudged_at = now(), nudge_count = $2 WHERE id = $1 RETURNING nudge_count',
    [id, Number(prev.nudge_count ?? 0) + (repeated ? 0 : 1)]
  );
  return { ... };
}
```
이 함수는 이미 JS `Date.now()`로 판정을 해왔으므로 SQL 방언 차이는 `now()`/`RETURNING`뿐이다. SQLite도 `RETURNING`을 지원(스파이크 확인)하므로 `UPDATE ... SET nudged_at = ? RETURNING nudge_count` 형태로 그대로 옮긴다(`nudged_at` 값은 `new Date().toISOString()`을 파라미터로).

```javascript
// main/db.mjs:783-843 — briefing: 대폭 축소 대상(Pitfall 1 참고, 전체를 옮기지 말 것)
async function briefing(staleDays = 5, activeDays = ACTIVE_PROJECT_DAYS) {
  ...
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE due < current_date)   AS overdue,
       count(*) FILTER (WHERE due = current_date)   AS due_today,
       count(*) FILTER (WHERE kind = 'inbox')                          AS inbox,
       count(*) FILTER (WHERE kind = 'todo')                           AS open_todo,
       coalesce(max(current_date - captured_at::date)
                  FILTER (WHERE kind = 'todo'), 0)                     AS oldest_todo_days,
       ...
       count(*) FILTER (WHERE kind = 'waiting'
                          AND coalesce(nudged_at, captured_at) < now() - ($1 || ' days')::interval) AS stale_waiting
     FROM item
     WHERE deleted_at IS NULL AND done_at IS NULL`,
    [String(staleDays)]
  );
  ...
}
```
새 `store.briefing()`은 `active_issues`/`stale_repos`/`done_suggest` 관련 서브쿼리(`issue`/`activity` 테이블 조인, `done_suggested_at` 칼럼)를 전부 드롭하고 `overdue`/`due_today`/`inbox`/`open_todo`/`oldest_todo_days`/`stale_waiting` 여섯 필드만 계산한다. `main/brief.mjs`의 `briefingLines()`가 없는 필드를 falsy 가드로 이미 감싸고 있으므로(RESEARCH.md Pitfall 1) 안전하다. `FILTER (WHERE ...)`는 미검증(A1)이므로 `SUM(CASE WHEN ... THEN 1 ELSE 0 END)`를 기본으로 쓴다. `current_date`는 JS에서 `YYYY-MM-DD` 계산 후 바인딩.

**스키마/마이그레이션 골격:** RESEARCH.md "Pattern 2: PRAGMA user_version 순번 마이그레이션"(200-254행)의 `MIGRATIONS` 배열 + `migrate(db)` 함수를 그대로 채택한다. D-12/D-13/STOR-04를 만족.

**손상 파일 처리(D-15):** RESEARCH.md 스파이크 로그의 `PRAGMA integrity_check` 에러 형태(`errcode: 26` SQLITE_NOTADB, `errcode: 11` SQLITE_CORRUPT — 코드 확인 필요, 로그엔 26만 실측)를 판별 조건으로 쓴다. 잠김(`errcode: 5`, "database is locked")은 D-03의 재시도·대기표시 경로로 분기하고 파일을 옮기지 않는다.

**WAL 체크포인트(D-17):** `lifecycle.mjs`의 `before-quit`/`will-quit`에서 `store.checkpoint()`(내부에서 `db.exec('PRAGMA wal_checkpoint(TRUNCATE)')`)를 호출하도록 `store.mjs`가 이 함수를 export한다.

---

### `main/lifecycle.mjs` / `main/ipc.mjs` / `main/jobs.mjs` (controller, event-driven / request-response / batch) — index.mjs 3분할

**Analog:** `main/index.mjs`(전체, 특히 아래 구간)

이동 대상 구간(순수 이동, 로직 변경 없음 — D-08):

```javascript
// main/index.mjs:1390-1479 → lifecycle.mjs
app.setAppUserModelId('com.when630.whenwork');
app.setName('whenwork');
app.whenReady().then(async () => {
  tray = new Tray(trayImage());
  ...
  refreshTrayMenu();
  // (jobs.mjs로 옮겨갈 타이머 등록은 여기서 scheduleJobs(ctx) 호출로 위임)
});
app.on('before-quit', () => { quitting = true; settings.flush(); /* + store.checkpoint() 추가 */ });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => {});
```

```javascript
// main/index.mjs:1042-1094 → ipc.mjs
ipcMain.handle('capture:save', async (_e, title) => {
  const { title: text, abbr } = parseCaptureToken(title);
  if (!text) return { ok: false };
  ...
  queue.append({ id: crypto.randomUUID(), title: text, abbr, raw: ..., captured_at: new Date().toISOString(), context: fg ? { fg } : null });
  flush(); // 기다리지 않는다 — 저장 완결은 큐가 이미 보장
  refreshTrayMenu();
  return { ok: true, dbOnline, pending: queue.count() };
});
```
D-01에 따라 `flush()` 호출부는 "같은 호출 흐름에서 `store.insertCaptures`를 동기로 즉시 시도"하는 형태로 바뀐다(비동기 `flush()` 트리거가 아니라 동기 try/재시도 — D-03). IPC 핸들러 등록 패턴(`ipcMain.handle(channel, async (_e, ...args) => {...})`, 1104-1128행의 `itemOps` 맵 순회 등록 패턴)은 그대로 유지한다.

```javascript
// main/index.mjs:422-432 → jobs.mjs (D-02 방식으로 재작성)
async function flush() {
  try {
    dbOnline = await db.online();
    if (!dbOnline) return;
    await queue.drain((entries) => db.insertCaptures(entries));
  } catch { dbOnline = false; }
  refreshTrayMenu();
}
```
새 버전은 "앱 시작 시 1회만" 큐 전체를 반영하는 함수로 바뀌고(D-02), `setInterval(flush, FLUSH_MS)`(1408행)는 **삭제**한다(Pitfall 3 — 되살리면 안 됨).

**컨텍스트 공유 패턴:** RESEARCH.md Architecture Pattern 1(173-191행)의 `ctx` 객체 주입 방식을 그대로 채택 — `lifecycle.mjs`가 `ctx = { tray, captureWin, todayWin, dbOnline, hotkeyOk, queue, settings, store }`를 만들고 `registerIpc(ctx)`/`scheduleJobs(ctx)`로 넘긴다. 순환 참조(`ipc.mjs` ↔ `jobs.mjs`) 금지.

---

### `main/queue.mjs`의 `drain` 재작성 (utility, file-I/O)

**Analog:** 자기 자신의 현재 구현(36-61행)

```javascript
// main/queue.mjs:36-61 — 현재: 읽기 → consume → 재읽기 → tail만 남기고 rename
async function drain(consume) {
  if (draining) return 0;
  if (!fs.existsSync(file)) return 0;
  draining = true;
  try {
    const data = fs.readFileSync(file, 'utf8');
    ...
    await consume(entries);
    const after = fs.readFileSync(file, 'utf8');
    const tail = after.slice(data.length);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, tail, 'utf8');
    fs.renameSync(tmp, file);
    return entries.length;
  } finally { draining = false; }
}
```
D-02가 요구하는 새 형태: 시작 시 `queue.jsonl`을 **rename으로 옆에 치우고**(새 캡처는 새 파일에 append), 치운 파일 전체를 store에 반영(`INSERT OR IGNORE`)한 뒤에만 삭제한다. `append`/`readAll`/`count`(11-32행)는 변경 없이 재사용. 기존 CONCERNS.md가 지적한 "읽기-쓰기 사이 경합"은 이 구조에서 사라진다(RESEARCH.md 상세 설계는 Wave 0 Gaps 참고).

---

### `test/store.test.mjs` (test, CRUD/batch) — 신규

**Analog 1 — 임시 파일 DB 관례:** `test/queue.test.mjs`(전체) / `test/backup.test.mjs`(전체)

```javascript
// test/queue.test.mjs:8-11
function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-q-'));
  return path.join(dir, 'queue.jsonl');
}
```
`store.test.mjs`는 `fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-s-'))` + `path.join(dir, 'store.sqlite')`로 동일 관례를 따른다.

**Analog 2 — 스키마 가드 테스트(STOR-05):** `test/backup.test.mjs:92-95`

```javascript
// test/backup.test.mjs:92-95
test('스키마의 모든 테이블이 백업에 담긴다', () => {
  assert.deepEqual([...EXPORT_TABLES].sort(), [...schemaTables()].sort());
});
```
`store.mjs`도 `db.mjs`의 `schemaTables()`(164-166행, `SCHEMA` 문자열에서 `CREATE TABLE` 이름을 정규식으로 추출)와 같은 형태의 export를 두고, `store.test.mjs`에 다음 형태의 가드를 이관한다:
```javascript
test('스키마는 project·item·event 세 테이블만 만든다 (STOR-05)', () => {
  assert.deepEqual([...schemaTables()].sort(), ['event', 'item', 'project']);
});
```
`main/db.mjs:164-166`(`schemaTables()` 구현), `main/db.mjs:171-181`(`EXPORT_TABLES` — 9개 테이블 나열, 대조 대상)을 참고해 정규식 추출 방식은 유지하되(`SQLite`는 `CREATE TABLE IF NOT EXISTS` 대신 `CREATE TABLE`을 쓸 수 있으므로 정규식 패턴을 `/CREATE TABLE (\w+)/g`로 조정).

**추가 커버 범위(마이그레이션):** RESEARCH.md Validation Architecture 표(482-489행) 기준 — v0→v1 마이그레이션 적용 확인, 미래 `user_version` 감지(D-13) 케이스.

---

### STOR-03 kill/restart 스모크 러너 (test, event-driven) — 신규

**Analog(부분):** `main/index.mjs:58-324`(`SMOKE_PROBE` 문자열), `main/index.mjs:1432-1468`(`--smoke` 처리 흐름)

```javascript
// main/index.mjs:1432-1466 — 기존 단일 프로세스 스모크 골격(참고용, 그대로 재사용 불가)
if (SMOKE) {
  const win = getTodayWin();
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      let probe = null;
      try { probe = await win.webContents.executeJavaScript(SMOKE_PROBE); }
      catch (err) { probe = { errors: [String(err?.message ?? err)] }; }
      ...
      console.log(`SMOKE_${ok ? 'OK' : 'FAIL'} hotkey=${hotkeyOk} pending=${queue.count()} ...`);
      quitting = true;
      app.exit(ok ? 0 : 1);
    }, 1200);
  });
}
```
이 골격은 "한 프로세스 수명 안에서 렌더러를 점검하고 스스로 종료"하는 구조라 D-04가 요구하는 "캡처 → 강제종료 → 재기동"(두 프로세스 수명)을 표현할 수 없다(RESEARCH.md 명시). 새 하네스는 RESEARCH.md "강제종료 스모크 하네스 설계 스케치"(392-424행)의 `spawn` + `SIGKILL` + 재기동 구조를 신규 작성하되, `console.log('SMOKE_OK'/'SMOKE_FAIL' ...)` 출력 관례와 `--smoke` 격리 패턴(`app.setPath('userData', ...)`, 400행)은 그대로 이어받는다. `child.kill('SIGKILL')` 한 줄로 Windows·POSIX 모두 커버되므로(Node 공식 문서 확인) OS 분기 코드는 넣지 않는다.

---

### `package.json` (config) — `pg` 위치 이동

**Analog:** 자기 자신의 `dependencies`/`devDependencies` 블록(D-07). `pg`: `dependencies` → `devDependencies`, 버전(8.13.0) 변경 없음. `build.files`(`main/**/*`)는 수정 불필요 — 새 모듈은 자동 포함.

---

## Shared Patterns

### 동기·무의존 캡처 경로(D1 원칙)
**Source:** `main/queue.mjs` 전체(팩토리 패턴, 동기 `appendFileSync`)
**Apply to:** `main/store.mjs`(동기 `DatabaseSync` API가 이 원칙과 자연히 맞음), `main/ipc.mjs`의 `capture:save`/`capture:followUp`

### 비치명 오류를 조용히 삼키는 태도 + 드러내기는 별도 신호로
**Source:** `main/queue.mjs:23-25`(깨진 줄 스킵), `main/settings.mjs:10-11`(설정 읽기 실패 시 기본값), `main/db.mjs:243-249`(`logEvent`의 try/catch)
**Apply to:** `main/store.mjs`(store open/재시도 실패 시 throw하지 않고 D-03의 대기 표시로 전환), `main/jobs.mjs`(WAL 체크포인트·purge 실패)

### 파라미터 바인딩(SQL 인젝션 방지) — 변경 없이 유지
**Source:** `main/db.mjs` 전역(`pool.query(sql, [params])` 패턴)
**Apply to:** `main/store.mjs`의 모든 CRUD 함수(`db.prepare(sql).run(...params)`/`.get(...)`/`.all(...)`로 치환, 문자열 결합 금지). 단 PRAGMA 문(`user_version`, `journal_mode` 등)은 예외적으로 템플릿 리터럴 직접 삽입(RESEARCH.md Pitfall 4, 내부 계산값만 삽입).

### 팩토리 함수 + 클로저 상태, 무기명 export 객체 반환
**Source:** `main/queue.mjs`(`createQueue`), `main/settings.mjs`(`createSettings`), `main/db.mjs`(`createDb`)
**Apply to:** `main/store.mjs`(`createStore`) — 세 analog 모두 `export function createX(...) { ...; return { ...함수들 }; }` 형태.

### 소프트 삭제 + 유예 기간 물리 삭제
**Source:** `main/db.mjs`의 `deleted_at`/`purgeDeleted`(646-653행), `PURGE_DAYS`(`main/index.mjs`)
**Apply to:** `main/store.mjs`의 `item.deleted_at` 칼럼과 `purgeDeleted` 재구현 — 유지, PG interval만 JS Date 계산으로 교체.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| STOR-03 kill/restart 스모크 러너의 "두 프로세스 수명에 걸친 하네스" 부분 | test | event-driven | 기존 `SMOKE_PROBE`는 단일 프로세스 점검용이라 이 시나리오(spawn → 대기 → SIGKILL → 재기동 → 상태 확인)의 analog가 코드베이스에 없음. RESEARCH.md의 설계 스케치(392-424행)를 1차 근거로 삼는다 |
| `main/store.mjs`의 `PRAGMA user_version` 순번 마이그레이션 배열 | model | batch | 기존 `db.mjs`는 PG 방식 멱등 `ALTER TABLE`을 쓰지 SQLite 스타일 버전 마이그레이션을 쓴 적이 없음 — RESEARCH.md Architecture Pattern 2(200-254행)가 유일한 근거 |

## Metadata

**Analog search scope:** `main/` 전체(`db.mjs`, `queue.mjs`, `settings.mjs`, `index.mjs`, `backup.mjs`), `test/` 전체(`queue.test.mjs`, `backup.test.mjs`)
**Files scanned:** 7개 소스 + 2개 테스트 파일(모두 git-tracked 확인: `git ls-files`로 검증)
**Pattern extraction date:** 2026-09-14
