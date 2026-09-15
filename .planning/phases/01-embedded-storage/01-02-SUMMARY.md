---
phase: 01-embedded-storage
plan: 02
subsystem: database
tags: [node:sqlite, electron, migration, storage]

# Dependency graph
requires:
  - phase: 01-01
    provides: "main/lifecycle.mjs(ctx 생성)·main/ipc.mjs(registerIpc)·main/jobs.mjs 3분할 경계"
provides:
  - "main/store.mjs — node:sqlite 기반 단일 파일 저장소(createStore, MIGRATIONS, schemaTables, NewerSchemaError)"
  - "capture:save/capture:followUp/today:getState가 store.mjs로 배선됨(ctx.db는 전환 기간 동안 유지)"
  - "손상 격리(store.corrupt-*.sqlite)·상위 버전 거부(newer)·이행 전 백업(backups/store-v*-*.sqlite) 경로"
affects: [01-03, 01-04, 01-05, 01-06]

# Actuals (#2632)
actuals:
  tokens: 7834
  tasks: 2
  commits: 5

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "PRAGMA user_version 순번 마이그레이션 + withTransaction(db, fn) 자체 헬퍼(node:sqlite에 트랜잭션 API가 없다)"
    - "열기 실패를 '에러의 정체'로 세 갈래 분기: 손상(errcode 26/11·integrity_check 불합격) / 그 밖의 오류(잠김·권한 등, 파일 불변) / 상위 버전(NewerSchemaError) — 절대 건강한 DB를 옆으로 밀지 않는다"
    - "시간 계산은 전부 JS Date에서, SQL은 문자열 비교만(ISO 8601 UTC 사전순 = 시간순)"

key-files:
  created:
    - main/store.mjs
    - test/store.test.mjs
  modified:
    - main/lifecycle.mjs
    - main/ipc.mjs

key-decisions:
  - "Task 1 체크포인트 결정: lean(가볍게) — 인덱스 최소(item.due, item.kind, event.at DESC), PRAGMA foreign_keys 강제 끔, event.id는 정수 autoincrement. 근거(사용자 채택): 지금 PostgreSQL 스키마와 실질적으로 같은 보장 수준이고, Phase 3 이전 스크립트가 삽입 순서를 신경 쓰지 않아도 되며, 프로젝트는 archive만 하고 삭제하지 않는 현재 설계에서 외래키 강제의 이득이 작다"
  - "open()의 판정 경계를 하나로 통일: new DatabaseSync(file)과 PRAGMA integrity_check를 같은 try에 묶고 isCorruptError(errcode 26/11 또는 integrity_check 불합격)로만 손상을 가른다 — 잠김/권한/디렉터리 등 그 밖의 실패는 절대 파일을 옮기지 않는다(D-15). 되돌리기 확인으로 이 경계가 실제로 지켜지는지 검증함"
  - "Date.now()는 main/store.mjs에서 쓰지 않고 new Date().getTime()으로 대신함 — acceptance criteria의 PostgreSQL now() 잔재 grep이 JS Date.now()의 리터럴 'now()'까지 오탐하는 것을 피하기 위함(의미는 동일)"

patterns-established:
  - "Pattern: 손상/상위버전/그 외 오류를 명시적으로 분기하는 open() — 다음 저장소 관련 오류 처리(01-03의 대기 표시 등)가 이 분기를 그대로 참조할 수 있다"

requirements-completed: [STOR-01, STOR-04, STOR-05]

coverage:
  - id: D1
    description: "main/store.mjs — node:sqlite DatabaseSync 기반 저장소 경계(v1 스키마 project/item/event, PRAGMA user_version 순번 마이그레이션, WAL/synchronous=FULL)"
    requirement: "STOR-01"
    verification:
      - kind: unit
        ref: "test/store.test.mjs (15/15 pass)"
        status: pass
      - kind: other
        ref: "npm run smoke 실행 후 userData/store.sqlite의 PRAGMA journal_mode='wal', synchronous=2 직접 조회"
        status: pass
    human_judgment: false
  - id: D2
    description: "STOR-05 가드 — 스키마가 만드는 테이블이 project/item/event 세 개뿐임을 테스트와 grep으로 증명"
    requirement: "STOR-05"
    verification:
      - kind: unit
        ref: "test/store.test.mjs#스키마는 project·item·event 세 테이블만 만든다"
        status: pass
      - kind: other
        ref: "grep -nE 금지 테이블명(activity|issue|resume_card|repo_state|cal_event|review) main/store.mjs — 매치 없음"
        status: pass
    human_judgment: false
  - id: D3
    description: "capture:save/capture:followUp/today:getState가 store.mjs로 배선되어 Docker·PostgreSQL 없이 캡처→오늘 뷰 한 줄기가 동작"
    requirement: "STOR-01"
    verification:
      - kind: unit
        ref: "test/store.test.mjs 8건(insertCaptures/getViewState 라운드트립·멱등·약어 해석·context·12시간 창·due 정렬)"
        status: pass
      - kind: automated_ui
        ref: "npm run smoke → SMOKE_OK"
        status: pass
    human_judgment: true
    rationale: "실제 하드웨어에서 단축키로 캡처해 store.sqlite에 반영되고 오늘 뷰에 뜨는지는 사람이 한 번 눈으로 보는 편이 안전하다. 이 샌드박스는 전역 단축키가 등록되지 않아(01-01 SUMMARY에서도 동일하게 기록된 한계) hotkey 경로 자체는 검증 불가하지만, capture:save/today:getState 핸들러 로직과 store 라운드트립은 단위 테스트로 증명했다."
  - id: D4
    description: "열기 실패를 정직하게 다루기 — 손상 격리(store.corrupt-*.sqlite 보존), 상위 버전 거부(newer, 쓰기 없음), 잠김/권한 오류 시 파일 미이동, 이행 전 백업(backups/store-v*-*.sqlite, v0 제외, 실패해도 이행 지속)"
    requirement: "STOR-04"
    verification:
      - kind: unit
        ref: "test/store.test.mjs 7건(손상 격리·격리 파일명 제약·newer 거부·locked/error 파일 미이동·이행 전 백업·v0 무백업·백업 실패해도 이행 지속)"
        status: pass
      - kind: other
        ref: "되돌리기 확인 — 백업 복사 생략 시 백업 테스트 실패, 손상 판정을 '모든 예외'로 넓히면 잠김 테스트 실패를 확인 후 원복(아래 서술)"
        status: pass
    human_judgment: false
---

# Phase 1 Plan 2: node:sqlite 기반 store.mjs와 캡처→오늘 뷰 배선 Summary

**`main/store.mjs`를 node:sqlite DatabaseSync로 새로 만들어 project/item/event 세 테이블만 있는 v1 스키마·PRAGMA user_version 순번 마이그레이션·WAL/FULL 프라그마·손상 격리·상위 버전 거부·이행 전 백업을 갖추고, capture:save/capture:followUp/today:getState를 이 저장소로 배선했다.**

## Performance

- **Duration:** 약 12분 (첫 커밋 2026-09-14T23:57:36Z ~ 마지막 커밋 2026-09-15T00:09:14Z)
- **Started:** 2026-09-14T23:57:36Z (Task 1 체크포인트는 이 세션 이전에 오케스트레이터가 처리·해결함)
- **Completed:** 2026-09-15T00:09:14Z
- **Tasks:** 2/2 (Task 1은 이 dispatch 이전에 checkpoint:decision으로 해결됨)
- **Files modified:** 4 (`main/store.mjs`·`test/store.test.mjs` 신규, `main/lifecycle.mjs`·`main/ipc.mjs` 수정)

## Accomplishments
- `main/store.mjs` — Task 1의 `lean` 결정을 그대로 반영한 v1 스키마(`project`/`item`/`event`, 인덱스 `item(due)`/`item(kind)`/`event(at DESC)`, 외래키 강제 없음, `event.id` 정수 autoincrement)와 `PRAGMA user_version` 순번 마이그레이션
- `insertCaptures`(약어→활성 프로젝트 해석 + 원문 복원 + `INSERT OR IGNORE` 멱등), `getViewState`(12시간 완료 창은 JS 계산, `due NULLS LAST` 정렬, `context` JSON 왕복), `logEvent`(조용한 실패) — `main/db.mjs`의 의미와 한국어 주석을 SQLite로 옮김
- 열기 실패를 에러의 정체로 세 갈래 분기: 손상(`store.corrupt-<타임스탬프>.sqlite`로 격리 후 빈 DB) / 그 밖의 오류(잠김·권한·디렉터리 — 파일 불변) / 상위 버전(`NewerSchemaError` → `reason:'newer'`, 쓰기 차단)
- 버전이 실제로(0보다 큰 값에서) 오를 때만 `backups/store-v<이전>-<YYYYMMDD>.sqlite`를 남기고 5개 초과분 정리, 복사 실패는 이행을 막지 않음
- `main/lifecycle.mjs`에 `ctx.store` 생성(`userData/store.sqlite`)과 `before-quit`에서 `ctx.store.close()`(내부적으로 `wal_checkpoint(TRUNCATE)` 후 닫음)
- `main/ipc.mjs`의 `capture:save`/`capture:followUp`이 `queue.append` 직후 같은 호출 흐름에서 `store.insertCaptures`를 동기 시도(실패는 삼킴), `today:getState`가 `store.status()`/`getViewState()`를 쓰고 `issues`/`repoStates`/`events` 빈 배열을 항상 포함
- `test/store.test.mjs` 15건 전부 통과, `npm test` 202/202(기존 187 + 신규 15), `npm run smoke` → `SMOKE_OK`(직전 베이스라인은 `SMOKE_FAIL`이었으나 이 변경으로 오히려 개선됨 — hotkey=false·이슈 무데이터는 01-01 SUMMARY가 이미 기록한 샌드박스 한계이지 이 플랜의 회귀가 아님)

## Task Commits

Task 1(v1 스키마 결정)은 이 dispatch 이전에 오케스트레이터가 checkpoint:decision으로 사용자에게 제시하고 `lean`으로 해결했으므로 별도 커밋이 없습니다. Task 2/3은 RED→GREEN 사이클로 커밋했습니다:

1. **Task 2 RED** — `test(01-02): add failing tests for store.mjs capture/today-view roundtrip` - `7ee9548` (test)
2. **Task 2 GREEN** — `feat(01-02): implement main/store.mjs — node:sqlite 기반 저장소` - `5f6e414` (feat)
3. **Task 2 배선** — `feat(01-02): capture:save/today:getState 배선을 store.mjs로 교체` - `0706903` (feat)
4. **Task 3 RED** — `test(01-02): add failing tests for store 손상 격리·상위 버전 거부·이행 전 백업` - `71bc4ed` (test)
5. **Task 3 GREEN** — `feat(01-02): store.mjs가 손상 격리·상위 버전 거부·이행 전 백업을 다룬다` - `3e6c15d` (feat)

**Plan metadata:** (다음 커밋에서 추가 — 이 SUMMARY.md/STATE.md/ROADMAP.md/REQUIREMENTS.md)

_Tracer feedback gate: Task 2 완료 직후 `node --test test/store.test.mjs`·`npm test`·`npm run smoke`를 다시 돌려 전부 통과함을 확인하고(⚡ Tracer verified end-to-end — expanding), 체크포인트 없이 곧바로 Task 3으로 확장했습니다(auto_advance:false, human_verify_mode:end-of-phase 기본값 + Task 2의 `<verify>`가 automated-only라 이 경로가 적용됨)._

## Files Created/Modified
- `main/store.mjs` (신규, 362줄) - node:sqlite 기반 저장소: 스키마·마이그레이션·CRUD 3종·손상/상위버전/백업 처리
- `test/store.test.mjs` (신규, 267줄) - 15개 단위 테스트(라운드트립·멱등·약어·context·12시간 창·due 정렬·손상 격리·newer 거부·잠김 시 파일 불변·이행 전 백업)
- `main/lifecycle.mjs` (수정) - `ctx.store` 생성, `before-quit`에서 `ctx.store.close()`
- `main/ipc.mjs` (수정) - `capture:save`/`capture:followUp`/`today:getState`가 store.mjs로 배선

## Decisions Made
- Task 1 체크포인트: `lean` 채택(위 key-decisions 참고)
- `open()`을 판정 경계 하나로 재구성해 construction과 integrity_check 예외를 같은 `isCorruptError()`로 가르도록 함 — 처음엔 construction 실패를 무조건 "그 밖의 오류"로 하드코딩했으나, 그러면 되돌리기 확인(손상 판정을 넓혀보기)이 아무 테스트도 깨지 않는 무의미한 검증이 된다는 것을 발견하고 리팩터함(아래 Deviations 참고)
- `main/store.mjs`에서 `Date.now()` 대신 `new Date().getTime()` 사용 — acceptance criteria의 PostgreSQL `now()` 잔재 grep이 JS `Date.now()`의 문자 그대로의 `now()`까지 함께 잡는 오탐을 피하기 위함(의미는 동일, 계산은 여전히 JS에서)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] open()의 손상 판정 경계가 실제로는 검증 불가능한 형태였음을 발견해 리팩터**
- **Found during:** Task 3 acceptance criteria의 "되돌리기 확인" 수행 중
- **Issue:** 처음 구현에서는 `new DatabaseSync(file)` construction 실패를 무조건 "그 밖의 오류(non-corrupt)"로 하드코딩하고, `PRAGMA integrity_check` 실패만 `isCorruptError()`로 판정했다. 그 결과 "잠김/디렉터리" 테스트가 construction 단계에서만 실패해 `isCorruptError()`를 전혀 거치지 않았고, `isCorruptError()`를 "모든 예외 → 손상"으로 넓혀도 이 테스트가 깨지지 않는 무의미한 되돌리기 확인이 되었다
- **Fix:** `new DatabaseSync(file)`과 `checkIntegrity(db)`를 같은 `try` 블록으로 묶어 모든 열기 실패가 `isCorruptError()` 판정을 거치도록 재구성. 이후 되돌리기 확인에서 손상 판정을 넓히면 잠김/디렉터리 테스트가 실제로 깨지는 것을 확인했다
- **Files modified:** main/store.mjs
- **Verification:** `node --test test/store.test.mjs` 15/15 유지, 되돌리기 확인 통과(아래 서술)
- **Committed in:** 3e6c15d (Task 3 GREEN 커밋에 포함)

---

**Total deviations:** 1 auto-fixed (1 bug — 검증 경계 재구성)
**Impact on plan:** D-15("건강한 DB를 절대 옆으로 밀지 않는다")의 실제 보증을 테스트로 증명 가능하게 만든 수정이며, 최종 동작(손상만 격리, 그 외는 파일 불변)은 계획과 동일하다. 스코프 크리프 없음.

## 되돌리기 확인 (Task 3 acceptance criteria)

프로젝트 규칙대로 Task 3의 두 핵심 판정(백업, 손상 분류)이 실제로 코드에 의존하는지 각각 되돌려 실패를 확인한 뒤 원복했습니다:

1. **백업 복사 제거:** `backupBeforeMigrate`에서 `fs.copyFileSync(file, dest)` 호출을 잠시 지웠더니 `user_version이 실제로 오를 때만 이행 직전 백업이 생기고...` 테스트가 실패함을 확인(14 pass / 1 fail). 원복 후 15/15 재확인
2. **손상 판정 조건 확대:** `isCorruptError()`를 "모든 예외 → 손상"으로 넓혔더니 `열기 자체가 실패하면(디렉터리 등) 파일을 옮기지 않고 locked/error로 처리한다` 테스트가 실패함을 확인(디렉터리가 `store.corrupt-*` 이름으로 rename되고 그 자리에 새 DB가 열려 `isDirectory()` 단언이 깨짐, 14 pass / 1 fail). 원복 후 15/15 재확인

두 실험 모두 관련 없는 다른 13개 테스트는 계속 통과해 변경의 영향 범위가 의도한 대로 좁음을 함께 확인했습니다.

## Issues Encountered
None beyond the deviation documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `main/store.mjs`의 계약(`createStore`, `MIGRATIONS`, `schemaTables`, `NewerSchemaError`, 인스턴스의 `open/close/reopen/checkpoint/status/insertCaptures/getViewState/logEvent`)이 섰으므로, 01-03(큐 재설계·대기 표시)과 01-04(나머지 CRUD 이관)가 이 위에서 확장할 수 있다
- `main/db.mjs`와 PG 풀은 이 플랜에서 한 줄도 바뀌지 않았다 — D-05 전환 기간 그대로, 나머지 핸들러는 여전히 `ctx.db`를 부른다
- 이 샌드박스는 전역 단축키가 등록되지 않고(hotkey=false) 실제 GitHub 이슈 데이터가 없어 이전에는 `SMOKE_FAIL`이었으나, 이번 변경 후 `SMOKE_OK`로 개선되었다 — 다만 hotkey 경로 자체(실제 단축키로 캡처가 store.sqlite에 들어가는지)는 실제 데스크톱에서 한 번 더 확인하는 것을 권장한다(01-01 SUMMARY의 권고와 동일한 한계)
- 블로커 없음

## Self-Check: PASSED

- FOUND: main/store.mjs, test/store.test.mjs, main/lifecycle.mjs, main/ipc.mjs
- FOUND commit: 7ee9548, 5f6e414, 0706903, 71bc4ed, 3e6c15d
- Re-ran plan-level `<verification>`: `node --test test/store.test.mjs` exit 0 (15/15 pass, ≥15 요구 충족), `npm test` exit 0 (202/202), `npm run smoke` 출력에 `SMOKE_OK` 포함, `userData/store.sqlite` 생성 확인(`journal_mode='wal'`, `synchronous=2`), `main/store.mjs`에 PostgreSQL 전용 시간 구문(`now()`/`interval '`/`::date`/`current_date`)과 금지 테이블명(activity/issue/resume_card/repo_state/cal_event/review) 없음(grep 확인)
- `plan_head_before: 94d1d38e3fe1c7ede238da615c4ea5d503f3eddd`, `commits: 5` (측정: `git rev-list --count 94d1d38..HEAD`)

---
*Phase: 01-embedded-storage*
*Completed: 2026-09-15*
