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
  warning: 1
  info: 2
  total: 4
status: issues_found
---

# Phase 01-embedded-storage: Code Review Report (재검토)

**Reviewed:** 2026-09-15
**Depth:** standard
**Files Reviewed:** 12
**Status:** issues_found

## Summary

656beaa 리뷰가 낸 9건(CR-01, WR-01~06, IN-01~02) 중 CR-01·WR-01~06 일곱 건의 수정 커밋(d8a7d47..61217c9)을 소스에서 직접 대조했다. 여섯 건(CR-01, WR-01, WR-02, WR-03, WR-04, WR-05)은 코드를 읽고 재현 스크립트로 검증한 결과 실제로 고쳐졌다. 그러나 **WR-06("손상된 항목 하나가 큐 전체를 막는다")의 수정이 CR-01이 막으려던 바로 그 유형의 영구 유실을 다른 경로로 되살렸다** — 이번 리뷰의 핵심 발견이자 새 CR-01이다(아래 참고). IN-01·IN-02는 여전히 열려 있어 그대로 이월한다.

**검증 방법:** 각 수정 지점을 소스에서 읽고, CR-01 관련해서는 스크래치 스크립트로 `insertCaptures`·`replayPending`을 직접 호출해 재현했다(소스는 건드리지 않았다). `npm test`(206건, capture-crash-smoke 포함)는 전부 통과했지만, 아래 새 CR-01이 노출하는 실패 경로는 기존 테스트 스위트가 검사하지 않는 입력(개별 항목의 데이터 결함으로 인한 INSERT 실패)이라 통과와 무관하게 재현된다.

### 검증 결과 요약

| 항목 | 상태 | 비고 |
|---|---|---|
| CR-01 (구, insertCaptures가 안 열려 있어도 조용히 성공) | ✅ 고쳐짐 | `store.mjs:301`에서 던진다. 재현 스크립트로 확인 — `newer` 상태에서 `insertCaptures` 호출 시 throw |
| WR-01 (briefing() UTC 기준 날짜) | ✅ 고쳐짐 | `store.mjs:557`에서 `dayKey()`(로컬 날짜) 사용 |
| WR-02 (이행 전 백업이 WAL 체크포인트 안 함) | ✅ 고쳐짐 | `store.mjs:119`에서 복사 전 `wal_checkpoint(TRUNCATE)` |
| WR-03 (today:getState try/catch 없음) | ✅ 고쳐짐 | `ipc.mjs:174-178`에서 감쌈 |
| WR-04 (단일 인스턴스 락 실패 시 계속 진행) | ✅ 고쳐짐 | `lifecycle.mjs:390-393`에서 `return ctx` |
| WR-05 (스모크 하네스 kill 후 즉시 rmSync) | ✅ 고쳐짐 | `capture-crash-smoke.test.mjs:116-126`에서 `waitForExit` 대기 후 삭제 |
| WR-06 (손상 항목 하나가 파일 전체를 막음) | ⚠️ **회귀 유발** | 항목 단위 격리는 됐지만, 그 방식이 진짜 저장 실패까지 삼켜 CR-01과 같은 유형의 영구 유실을 재도입했다 — **새 CR-01 참고** |
| IN-01 (index.mjs 헤더가 PostgreSQL 언급) | ⚠️ 여전히 열림 | 이월 |
| IN-02 (퀵캡처 저장 실패 시 무피드백) | ⚠️ 여전히 열림 | 이월 |

## Critical Issues

### CR-01: `insertCaptures`의 항목별 catch가 "데이터 결함"과 "진짜 저장 실패"를 가리지 않고 전부 삼켜, WR-06 이전에 CR-01이 막으려던 영구 유실을 다른 경로로 재도입한다

**File:** `main/store.mjs:308-334` (`insertCaptures`의 `withTransaction` 안 항목별 `try/catch`), `main/queue.mjs:86-93` (`replayPending`), `main/ipc.mjs:60-69` (`saveCapture`)

**Issue:**

WR-06 수정은 "파일 안 항목 하나가 예외를 내도 그 항목만 건너뛴다"는 의도로 각 항목의 삽입을 개별 `try/catch`로 감쌌다:

```js
// main/store.mjs:308-333
withTransaction(db, () => {
  for (const e of entries) {
    try {
      let projectId = null;
      if (e.abbr) { ... }
      const title = e.abbr && !projectId ? (e.raw ?? `${e.title} #${e.abbr}`) : e.title;
      const context = e.context != null ? JSON.stringify(e.context) : null;
      const result = insert.run(e.id, projectId, projectId ? 'todo' : 'inbox', title, e.captured_at, context);
      if (result.changes) inserted += 1;
    } catch (err) {
      console.error('insertCaptures: 항목 하나를 건너뛴다(손상 의심)', e?.id, err);
    }
  }
});
return { inserted };
```

주석은 "저장소 자체가 열리지 않는 등 실제 반영 불가 상태(db.exec 실패 등)는 여전히 위로 던져 replayPending이 파일을 보존하고 재시도하게 둔다 — 여기서 잡는 건 항목 단위 손상뿐이다"라고 적었지만, 코드에는 그 구분이 없다. `catch (err)`는 에러의 정체(제약 위반인지, 디스크 풀·I/O 오류인지, 바인딩 타입 오류인지)를 전혀 가리지 않고 **전부** 삼킨다. `item.title`은 `NOT NULL` 제약이 걸려 있는데(V1_SQL:37), 큐 항목이 `title`이 비거나 `null`인 채로 들어오면(미래 큐 포맷 변경, 수동 편집, 혹은 이 페이즈가 직접 우려한 "깨진 줄" 부류의 손상) 이 제약 위반은 SQLite 트랜잭션 자체를 무효화하지 않는다 — 딱 그 INSERT 문 하나만 실패하고 트랜잭션은 계속 유효하다. 그래서 `withTransaction`의 `COMMIT`이 정상적으로 실행되고, `insertCaptures`는 **아무것도 저장하지 못했는데도 예외 없이** `{ inserted: 0 }`을 돌려준다.

이것이 정확히 CR-01(656beaa 리뷰)이 막으려던 계약 위반이다: `replayPending`과 `saveCapture` 둘 다 "던지면 실패, 안 던지면 성공"을 전제로 짜여 있다. 파일 안의 **모든** 항목이 같은 결함을 공유하면(예: 손 편집된 큐 파일, 옛/새 포맷 불일치, 이번에 재현한 것처럼 `title: null`), 개별 항목 catch가 전부를 삼켜 `insertCaptures`는 결코 던지지 않고, `replayPending`은 그 대기 파일을 성공으로 간주해 삭제한다 — 캡처는 저장소에도, 큐 파일에도 어디에도 남지 않는다.

**재현(스크래치 스크립트, 소스는 수정하지 않음):**

```js
// queue.append로 title이 null인 항목을 하나 큐에 넣고 replayPending으로 반영 시도
queue.append({ id: 'lost-1', title: null, abbr: null, captured_at: new Date().toISOString() });
const replayed = queue.replayPending((entries) => store.insertCaptures(entries));
```

결과:
```
replayPending returned (entries "replayed"): 1        // 성공으로 보고됨
files left in data dir: [ 'store.sqlite', 'store.sqlite-shm', 'store.sqlite-wal' ]
                                                        // pending 파일이 이미 삭제됨
anything in store for this id? false                  // 저장소에도 없음 — 영구 유실
```

단일 `insertCaptures` 호출로도 같은 결과가 나온다:
```
store.status(): { ok: true, ... }
threw: false result: { inserted: 0 }
inbox length (should be 0, nothing actually saved): 0
```

`main/ipc.mjs`의 `saveCapture`도 같은 계약에 기댄다 — 진짜 저장 실패(디스크 풀 등)가 개별 항목 catch에 걸리면 `insertCaptures`가 던지지 않으므로 `reopen()` 재시도도, `ctx.pending += 1`도 실행되지 않는다. 다만 `queue.jsonl`은 실행 중 지우지 않으므로(D-02) 이 경로에서는 다음 재기동의 `replayPending`이 다시 시도할 기회가 있다 — 문제는 그 재시도에서 **같은 결함이 재현되면**(옛 포맷 항목처럼 구조적으로 고쳐지지 않는 경우) 위 재현대로 그 시점에 영구 유실된다는 것이다.

WR-06이 원래 겨냥한 시나리오("항목 하나만 나쁘고 나머지는 멀쩡한 파일")에서는 이 수정이 실제로 도움이 된다(나머지 항목은 반영된다). 문제는 "파일 안 모든 항목이 같은 이유로 실패하는" 경우를 성공으로 오인한다는 것 — 이는 데이터 결함과 저장소 자체 실패를 구분하지 않는 한 항상 존재하는 구멍이다.

**Fix:**

에러의 정체로 나누지 말고(node:sqlite가 이를 신뢰성 있게 구분해 주지 않는다), 삽입을 시도하기 **전에** 필수 필드를 JS에서 검증해 구조적으로 결함 있는 항목만 조용히 건너뛰고, `insert.run()` 자체는 더 이상 개별 항목 catch로 감싸지 않는다 — 이렇게 하면 `insert.run()`이 던지는 예외는 전부 "예상하지 못한 진짜 실패"이므로 트랜잭션 전체를 롤백시키고 위로 올라가 `replayPending`이 파일을 보존하게 둔다(WR-06 이전 동작으로 복귀, 단 사전 검증이 있어 흔한 데이터 결함은 여전히 격리된다):

```js
withTransaction(db, () => {
  for (const e of entries) {
    // 구조적으로 결함 있는 항목만 여기서 걸러 건너뛴다 — SQL은 건드리지 않으므로
    // 트랜잭션을 무효화하지 않고, 저장소 자체의 진짜 실패(디스크 풀·I/O 등)는
    // 아래 insert.run()이 던지도록 그대로 둔다.
    if (!e?.id || !e?.captured_at || (e.abbr ? false : !e.title)) {
      console.error('insertCaptures: 필수 필드 결함으로 항목을 건너뛴다', e?.id);
      continue;
    }
    let projectId = null;
    if (e.abbr) {
      const row = findAbbr.get(e.abbr);
      projectId = row?.id ?? null;
    }
    const title = e.abbr && !projectId ? (e.raw ?? `${e.title} #${e.abbr}`) : e.title;
    if (!title) { console.error('insertCaptures: title 결함으로 항목을 건너뛴다', e.id); continue; }
    const context = e.context != null ? JSON.stringify(e.context) : null;
    const result = insert.run(e.id, projectId, projectId ? 'todo' : 'inbox', title, e.captured_at, context);
    if (result.changes) inserted += 1;
  }
});
```

아울러 `test/store.test.mjs`에 "파일 안 항목 전부가 같은 결함을 공유하면 `insertCaptures`가 던져(또는 최소한 `replayPending`이 그 파일을 지우지 않아) 유실되지 않는다"는 통합 테스트를 추가할 것을 권한다(656beaa 리뷰의 CR-01 권고와 같은 결의 테스트 — store·queue 결합 지점은 여전히 단위 테스트만으로는 드러나지 않는다).

## Warnings

### WR-01: 이번에 고친 안전장치(WR-02 WAL 체크포인트, WR-04 조기 반환, WR-06 항목 격리)에 전용 회귀 테스트가 없다

**File:** `test/store.test.mjs`, `test/queue.test.mjs` (WR-02·WR-06에 해당하는 테스트 없음), `main/lifecycle.mjs:390-393`(WR-04에 해당하는 테스트 없음)

**Issue:** `test/store.test.mjs`에는 이행 직전 백업이 실제로 `wal_checkpoint`를 호출하는지 확인하는 테스트가 없다(예: WAL에만 있고 아직 체크포인트되지 않은 커밋이 이행 전 백업에 포함되는지 검증). `test/queue.test.mjs`·`test/store.test.mjs` 어디에도 "파일 안 항목 일부만 결함이 있어도 나머지는 반영되고 대기 파일은 지워진다"는 WR-06의 의도를 직접 검증하는 테스트가 없다 — 위 CR-01이 같은 코드 경로의 반대 극단(전부 결함)에서 조용히 깨지는 것을 이 리뷰가 스크래치 스크립트로 찾아야 했던 이유다. `lifecycle.mjs`의 단일 인스턴스 락 조기 반환(WR-04)도 `app.requestSingleInstanceLock`을 모킹해 검증하는 테스트가 없다(Electron 의존이라 순수 단위 테스트로 만들기 어렵다는 점은 이해하나, 최소한 회귀 시 조용히 깨질 수 있다는 점은 기록해 둔다).

**Fix:** 최소한 아래 테스트를 추가한다.
- `store.test.mjs`: WAL에 쓰고 체크포인트 전 상태를 만든 뒤 마이그레이션을 트리거해, 백업 파일에 그 데이터가 포함되는지 확인.
- `store.test.mjs` + `queue.test.mjs` 결합: 위 CR-01의 재현을 그대로 회귀 테스트로 승격 — "구조적으로 결함 있는 항목 하나만 든 대기 파일은 반영 실패로 남아야 한다(대기 파일이 지워지면 안 된다)".

## Info

### IN-01: `main/index.mjs` 헤더 주석이 여전히 PostgreSQL을 가리킨다 (이월, 656beaa 리뷰의 IN-01)

**File:** `main/index.mjs:1`
**Issue:** `// WHENWORK — 트레이 상주. 퀵캡처(전역 단축키) → 로컬 큐 → PostgreSQL 동기화(D1).` — 저장소가 `node:sqlite`(`main/store.mjs`)로 교체된 지 한참인데(D-05) 진입점 파일의 설명 주석은 그대로다. 파일 자체가 `bootstrap()` 한 줄로 줄었으니 고치는 비용도 낮다.
**Fix:** `// ... → 로컬 큐 → 내장 SQLite 저장소(store.mjs) 반영(D1).` 등으로 갱신.

### IN-02: 퀵캡처에서 Enter로 저장 실패(`res.ok === false`) 시 사용자 피드백이 전혀 없다 (이월, 656beaa 리뷰의 IN-02)

**File:** `renderer/capture.js:112`
**Issue:**
```js
const res = await window.whenwork.save(title);
saving = false;
if (!res.ok) return;
```
`saveCapture`(main/ipc.mjs)가 `{ ok: false }`를 돌려주는 유일한 경로(`parseCaptureToken`이 빈 제목을 반환)는 지금은 도달하기 어렵지만(112줄 앞에서 이미 `title = input.value.trim(); if (!title) return;`로 빈 입력을 걸렀다), 이론적으로 도달 가능한 분기가 조용히 아무것도 하지 않는 것은 여전히 결함이다. 입력창도 지워지지 않고 오류 메시지도 뜨지 않아 왜 저장이 안 됐는지 사용자가 알 방법이 없다.
**Fix:** 최소한 짧은 경고 메시지(`showMsg('warn', '저장할 내용이 없습니다', 1500)` 등)를 보여준다.

---

_Reviewed: 2026-09-15_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
