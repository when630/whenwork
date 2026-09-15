---
phase: 01-embedded-storage
reviewed: 2026-09-15T00:00:00Z
depth: standard
files_reviewed: 12
files_reviewed_list:
  - main/index.mjs
  - main/lifecycle.mjs
  - main/ipc.mjs
  - main/jobs.mjs
  - main/queue.mjs
  - main/store.mjs
  - renderer/capture.js
  - renderer/today.js
  - test/queue.test.mjs
  - test/store.test.mjs
  - test/capture-crash-smoke.test.mjs
  - package.json
findings:
  critical: 1
  warning: 6
  info: 2
  total: 9
status: issues_found
---

# Phase 01-embedded-storage: Code Review Report

**Reviewed:** 2026-09-15
**Depth:** standard
**Files Reviewed:** 12
**Status:** issues_found

## Summary

캡처 → 큐 → 저장소 반영 경로, `node:sqlite` 기반 `store.mjs`의 열기/마이그레이션/손상 격리 로직, `lifecycle.mjs`/`ipc.mjs`/`jobs.mjs` 분할, 그리고 강제종료 스모크 하네스를 중심으로 표준 깊이 리뷰를 수행했다. `.planning/phases/01-embedded-storage/01-CONTEXT.md`에 잠긴 결정(D-01~D-17, 특히 스텁 IPC·레거시 UI 잔존은 D-06 의도)은 결함으로 보고하지 않았다.

가장 중요한 발견은 **`insertCaptures`가 저장소가 열려 있지 않을 때 예외를 던지지 않고 조용히 `{inserted:0}`을 돌려주는 결함**이다. 이 때문에 `queue.replayPending`은 "실패"를 감지하지 못하고 반영되지 않은 대기 파일을 그대로 삭제해 버린다 — 즉 저장소가 잠김·손상·상위 버전 등으로 열리지 못한 상태에서 앱을 재기동하면 큐에 안전하게 쌓여 있던 캡처가 **영구히 사라진다**. 스크래치 스크립트로 직접 재현해 확인했다(아래 CR-01 참고). 이는 이 프로젝트의 제1가치("아무것도 깔지 않고 단축키로 던진 할 일을 절대 잃지 않는다")와 D-13이 명시한 "모르는 스키마에는 쓰지 않되 캡처는 큐에 남아 업데이트 후 반영된다"는 약속을 직접 위반한다.

그 외에 저장소 이행 전 백업이 WAL을 체크포인트하지 않고 복사하는 문제, 아침 브리핑의 "오늘" 계산이 UTC 기준이라 자정 전후(한국 시간 00~09시) 마감 판정이 틀어지는 문제, IPC 핸들러 간 예외 처리 일관성 부족, 단일 인스턴스 락 실패 시 조기 반환 누락, 강제종료 스모크 하네스의 프로세스 정리 경합 등을 발견했다.

## Critical Issues

### CR-01: `insertCaptures`가 저장소 미가동 시 예외 없이 성공한 것처럼 반환 — 큐 반영 파이프라인 전체에서 캡처가 영구 유실됨

**File:** `main/store.mjs:292-293`, `main/queue.mjs:86-93`, `main/jobs.mjs:32-40`, `main/ipc.mjs:59-69`

**Issue:**

`store.mjs`의 `insertCaptures`는 저장소가 열려 있지 않으면(`!db || !state.ok`) 아무것도 하지 않고 `{ inserted: 0 }`을 **정상 반환**한다(예외를 던지지 않는다).

```js
// main/store.mjs:292-293
function insertCaptures(entries) {
  if (!db || !state.ok) return { inserted: 0 };
  ...
```

이 함수는 두 군데에서 "예외를 던지면 실패, 안 던지면 성공"이라는 계약으로 호출된다.

1. `main/queue.mjs`의 `replayPending`(86-93행):
```js
try {
  consume(entries); // 실패(throw)하면 이 파일은 그대로 — 다음 기동에서 재시도
  fs.unlinkSync(full);
  replayed += entries.length;
} catch {
  break;
}
```
`consume`은 `main/jobs.mjs`의 `replayQueueOnce`(32-40행)에서 `(entries) => ctx.store.insertCaptures(entries)`로 전달된다. 저장소가 닫혀 있거나 손상·상위 버전 등으로 `state.ok === false`인 상태에서 앱이 재기동하면, `insertCaptures`는 아무 것도 삽입하지 않고도 던지지 않으므로 `consume(entries)`는 "성공"으로 간주되고, 반영되지 않은 대기 파일(`queue.pending-*.jsonl`)이 그대로 `fs.unlinkSync`로 **삭제**된다. `replayQueueOnce`는 이어서 `ctx.pending = 0`까지 설정해 트레이 툴팁·오늘 뷰 어디에도 유실을 알리는 표시가 남지 않는다.

2. `main/ipc.mjs`의 `saveCapture`(59-69행)도 같은 계약에 기대어 재시도를 판단한다:
```js
ctx.queue.append(entry);
try {
  ctx.store.insertCaptures([entry]);
} catch {
  try {
    ctx.store.reopen();
    ctx.store.insertCaptures([entry]);
  } catch {
    ctx.pending += 1;
  }
}
```
저장소가 `!state.ok` 상태이면 `insertCaptures`가 던지지 않으므로 `catch`(재시도·`ctx.pending += 1`) 경로가 전혀 실행되지 않는다. 즉시 반영에 실패했는데도 대기 건수가 올라가지 않아 D-03이 약속한 "N건이 기다리고 있어요" 표시가 뜨지 않는다.

**재현 확인** (스크래치 스크립트, 소스는 수정하지 않음):
```
store2.status(): { ok: false, reason: 'newer', notice: '새 버전으로 만든 데이터입니다 — 앱을 업데이트해 주세요', quarantined: null }
replayed count returned by replayPending: 1   // 실제로는 아무 것도 저장 안 됨
queue.count() after replay: 0
leftover pending files: []                     // 대기 파일도 사라짐 → 캡처 완전 유실
```
`store.status().ok === false`(newer/locked/error 어느 경우든)인 상태에서 `replayPending`을 호출하면 큐 항목이 저장소에도, 큐 파일에도, 대기 파일에도 남지 않는다 — 데이터가 어디에도 존재하지 않게 된다.

D-13은 명시적으로 "모르는 스키마에 쓰지 않는다. **캡처는 큐에 남아 업데이트 후 반영된다**"고 정해 두었는데, 구현은 정확히 그 반대로 동작한다(큐에서 지워버린다).

**Fix:**

`insertCaptures`가 저장소 비가동 상태에서 던지도록 바꿔 기존 호출부(재시도·대기 파일 보존 로직)가 이미 전제하고 있는 throw 계약을 실제로 만족시킨다.

```js
// main/store.mjs
function insertCaptures(entries) {
  if (!db || !state.ok) throw new Error('store not open'); // 호출부(replayPending·saveCapture)는 이미 throw를 실패 신호로 쓴다
  ...
```

`insertCaptures`를 호출하는 다른 자리(있다면)도 이 예외를 무시하지 않는지 함께 점검하고, `store.mjs`·`queue.mjs`·`jobs.mjs`를 함께 구동하는 통합 테스트(예: "store가 `ok:false`인 상태에서 replayPending을 호출하면 대기 파일이 삭제되지 않고 남는다")를 추가해 이 상호작용이 다시 깨지는 것을 막을 것을 권장한다. 현재 `test/queue.test.mjs`와 `test/store.test.mjs`는 각 모듈을 독립적으로만 검증해 이 결합 지점이 테스트되지 않았다.

## Warnings

### WR-01: `briefing()`의 "오늘" 기준이 UTC라 한국 시간 자정~09시 사이 마감 판정이 어긋난다

**File:** `main/store.mjs:534` (`briefing` 함수 내부)

**Issue:**
```js
const today = new Date().toISOString().slice(0, 10);
```
`due`는 D-10에 따라 타임존 없는 `YYYY-MM-DD`(로컬 캘린더 날짜 의미)로 저장되는데, `today`는 `toISOString()`으로 **UTC 날짜**를 뽑는다. 한국(UTC+9) 기준 00:00~09:00 사이에는 로컬 날짜가 이미 다음 날로 넘어갔지만 UTC 날짜는 아직 전날이라, 이 시간대에 `overdue`(`due < today`)·`due_today`(`due = today`) 판정이 실제 로컬 날짜와 하루 어긋난다. 예: 로컬 09-15 03:00(=UTC 09-14 18:00)에 `due='2026-09-15'`인 항목은 `overdue`에도 `due_today`에도 잡히지 않고 조용히 빠진다.

같은 파일 밖(`main/ipc.mjs`의 `weekLabel`의 `fmt`)에서는 `getFullYear()/getMonth()/getDate()` 같은 **로컬** 컴포넌트를 쓰고 있어, 이 모듈 안에서도 날짜 계산 관례가 일관되지 않다.

**Fix:**
```js
function localToday(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
...
const today = localToday();
```
`due` 값을 만드는 `parseDue`(main/parse.mjs)가 실제로 로컬 날짜를 쓰는지도 함께 확인해 계산 기준을 맞춘다.

### WR-02: 이행 직전 백업이 WAL을 체크포인트하지 않고 본 파일만 복사한다 — 크래시 직후 이행 시 백업이 최신 데이터를 놓칠 수 있다

**File:** `main/store.mjs:113-123` (`backupBeforeMigrate`), 호출부 `main/store.mjs:131`

**Issue:**
```js
function backupBeforeMigrate(file, fromVersion) {
  try {
    const dir = path.join(path.dirname(file), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `store-v${fromVersion}-${todayStamp()}.sqlite`);
    fs.copyFileSync(file, dest);
    ...
```
`journal_mode=WAL`인 DB는 최근 커밋이 `-wal` 사이드카 파일에만 있고 본 파일에는 아직 반영되지 않을 수 있다. 정상 종료 시에는 `close()`가 `wal_checkpoint(TRUNCATE)`를 호출해(D-17) `-wal`이 비워지지만, 강제종료(SIGKILL 등, 이 페이즈의 STOR-03 시나리오)로 앱이 죽은 직후 재기동해서 마이그레이션이 필요한 상황이 겹치면, `migrate()`가 `backupBeforeMigrate`를 호출하는 시점에 `-wal`에 아직 체크포인트되지 않은 캡처가 남아 있을 수 있다. 이때 `fs.copyFileSync(file, dest)`는 본 파일만 복사하므로 그 사이 캡처가 빠진, 실제보다 오래된 백업이 만들어진다. 사용자가 나중에 이 백업으로 되돌리면 최근 캡처를 다시 잃는다.

**Fix:** 복사 전에 체크포인트를 강제한다.
```js
function backupBeforeMigrate(db, file, fromVersion) {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // 복사 전에 -wal 내용을 본 파일에 합친다
    const dir = path.join(path.dirname(file), 'backups');
    ...
```
(`migrate(db, file)`가 이미 `db` 핸들을 갖고 있으므로 시그니처에 `db`를 추가해 넘기면 된다.)

### WR-03: `today:getState` 핸들러는 `getViewState()` 호출에 try/catch가 없다 — 같은 파일의 다른 핸들러와 일관되지 않는다

**File:** `main/ipc.mjs:167-172`

**Issue:**
```js
ipcMain.handle('today:getState', async () => {
  const base = { pending: ctx.pending, issues: [], repoStates: [], events: [] };
  const st = ctx.store.status();
  if (!st.ok) return { ...base, online: false, notice: st.notice };
  return { ...base, online: true, notice: st.notice, ...ctx.store.getViewState() };
});
```
`st.ok`가 true인 뒤에도 `ctx.store.getViewState()` 실행 중 SQLite 오류(디스크 I/O 등)가 날 수 있다. 같은 파일의 `history:get`(174-180행)·`itemOps`(196-205행)는 모두 try/catch로 감싸 `{ ok: false }`류를 돌려주는데, 오늘 뷰의 핵심 데이터 소스인 이 핸들러만 무방비다. 렌더러 쪽 `refresh()`(`renderer/today.js`)도 `await window.whenwork.getState()`를 try/catch 없이 부르므로, 예외가 나면 렌더러에서 처리되지 않은 프로미스 거부로 남는다.

**Fix:**
```js
ipcMain.handle('today:getState', async () => {
  const base = { pending: ctx.pending, issues: [], repoStates: [], events: [] };
  const st = ctx.store.status();
  if (!st.ok) return { ...base, online: false, notice: st.notice };
  try {
    return { ...base, online: true, notice: st.notice, ...ctx.store.getViewState() };
  } catch {
    return { ...base, online: false, notice: '저장소 조회 중 오류가 있었습니다' };
  }
});
```

### WR-04: `requestSingleInstanceLock()` 실패 시 초기화를 계속 진행한다 — 중복 트레이·중복 저장소 핸들 생성 위험

**File:** `main/lifecycle.mjs:386-395`

**Issue:**
```js
if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();

ctx.queue = createQueue(...);
ctx.settings = createSettings(...);
ctx.store = createStore(path.join(app.getPath('userData'), 'store.sqlite'));
...
registerIpc(ctx);
...
app.whenReady().then(async () => {
  ctx.tray = new Tray(trayImage());
  ...
```
`app.quit()`는 비동기로 종료를 요청할 뿐 함수 실행을 멈추지 않는다. 락 획득에 실패한 두 번째 인스턴스도 이 라인 이후를 계속 실행해 같은 `store.sqlite`에 두 번째 `DatabaseSync` 핸들을 열고, `app.whenReady()`가 해소되면(quit 처리가 끝나기 전이면) 두 번째 트레이 아이콘과 창을 실제로 만들 수 있다. 원래 `requestSingleInstanceLock`을 쓰는 목적(두 번째 실행은 기존 인스턴스로 흡수되고 새 트레이·창이 생기면 안 됨)이 깨진다.

**Fix:**
```js
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
  return ctx; // 여기서 초기화를 멈춘다 — 트레이·저장소·IPC를 만들지 않는다
}
```

### WR-05: 강제종료 스모크 하네스가 `kill` 뒤 프로세스 종료를 기다리지 않고 바로 임시 폴더를 지운다 — Windows에서 경합 가능

**File:** `test/capture-crash-smoke.test.mjs:111-122`

**Issue:**
```js
} finally {
  for (const child of [p1, p2]) {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}
```
정상 경로에서는 `try` 블록 안에서 이미 `waitForExit(p1)`/`waitForExit(p2)`를 기다렸으므로 문제가 없지만, 이 프로젝트의 주 플랫폼인 Windows에서 `waitForOutput`이 타임아웃으로 실패한 경로(내부에서 `child.kill('SIGKILL')` 후 곧바로 reject)에서는 `finally`가 실행될 때 자식 프로세스가 아직 파일 핸들을 쥔 채로 종료 처리 중일 수 있다. 이 상태에서 곧바로 `fs.rmSync(dataDir, ...)`를 부르면 `store.sqlite`(-wal 포함)를 아직 잡고 있는 프로세스 때문에 `EBUSY`/`EPERM`으로 삭제가 실패하거나, 원래 실패의 원인을 가리는 2차 예외가 발생할 수 있다. 임시 폴더가 남아 쌓이는 부작용도 있다.

**Fix:** kill 후 실제 종료를 기다린 다음 삭제한다.
```js
} finally {
  for (const child of [p1, p2]) {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
      await waitForExit(child);
    }
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
```

### WR-06: 대기 파일 단위의 전부-아니면-전무 트랜잭션 + "첫 실패에서 중단" 구조는 손상된 항목 하나로 큐 전체를 영구히 막을 수 있다

**File:** `main/store.mjs:300-314` (`insertCaptures`의 `withTransaction`), `main/queue.mjs:86-93` (`replayPending`의 `break`)

**Issue:** `insertCaptures`는 여러 항목을 하나의 트랜잭션으로 묶어 처리하므로, 파일 안의 항목 하나라도 삽입 중 예외(예: NOT NULL 제약 위반을 일으키는 손상된 레코드)를 내면 그 파일 전체가 롤백되고, `replayPending`은 그 파일에서 `break`해 뒤에 남은(시간상 더 이른) 대기 파일들까지 이번 기동에서는 건드리지 않는다. 정상 경로(`saveCapture`가 만드는 항목)에서는 `title`·`captured_at`이 항상 채워지므로 당장 트리거되긴 어렵지만, 향후 큐 포맷이 바뀌거나 수동 편집된 큐 파일이 섞이면 그 파일 하나가 이후 모든 재기동에서 동일하게 실패해 뒤에 쌓인 모든 캡처의 반영을 영구히 막는 단일 장애점이 된다.

**Fix:** 최소한, 항목 단위로 개별 삽입을 시도해 문제 있는 항목만 건너뛰고 나머지는 반영하도록 하거나(예: 트랜잭션을 항목 단위로 나누고 실패한 항목만 별도로 격리 보관), 반복 실패하는 파일을 무한정 재시도하지 않도록 재시도 횟수·격리 파일명 규칙을 추가하는 것을 검토한다.

## Info

### IN-01: `main/index.mjs` 헤더 주석이 여전히 PostgreSQL을 가리킨다

**File:** `main/index.mjs:1`
**Issue:** `// WHENWORK — 트레이 상주. 퀵캡처(전역 단축키) → 로컬 큐 → PostgreSQL 동기화(D1).` — 이 페이즈에서 저장소가 `node:sqlite`(`main/store.mjs`)로 교체됐는데(D-05), 앱 진입점 파일의 설명 주석은 갱신되지 않았다.
**Fix:** `// ... → 로컬 큐 → 내장 SQLite 저장소(store.mjs) 반영(D1).` 등으로 갱신.

### IN-02: 퀵캡처에서 Enter로 저장 실패(`res.ok === false`) 시 사용자 피드백이 전혀 없다

**File:** `renderer/capture.js:110-112`
**Issue:**
```js
const res = await window.whenwork.save(title);
saving = false;
if (!res.ok) return;
```
`saveCapture`(main/ipc.mjs)가 빈 제목 등으로 `{ ok: false }`를 돌려주면 이 분기는 조용히 아무 것도 하지 않는다 — 입력창도 지워지지 않고 오류 메시지도 뜨지 않아, 왜 저장이 안 됐는지 사용자가 알 방법이 없다.
**Fix:** 최소한 짧은 경고 메시지(`showMsg('warn', '저장할 내용이 없습니다', 1500)` 등)를 보여준다.

---

_Reviewed: 2026-09-15_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
