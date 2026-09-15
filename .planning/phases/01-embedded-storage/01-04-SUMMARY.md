---
phase: 01-embedded-storage
plan: 04
subsystem: database
tags: [node:sqlite, electron, storage, briefing]

# Dependency graph
requires:
  - phase: 01-02
    provides: "main/store.mjs — createStore(file), insertCaptures/getViewState/logEvent, open/close/reopen/status, withTransaction 헬퍼"
provides:
  - "main/store.mjs — 프로젝트 CRUD(getProjects/createProject/updateProject/archiveProject/moveProject)"
  - "main/store.mjs — 항목 조작(completeItem/uncompleteItem/assignProject/setDue/toWaiting/renameItem/removeItem/restoreItem/setNote/nudgeItem/nudgeRestore/getInbox/purgeDeleted)"
  - "main/store.mjs — getHistory(days)/briefing(staleDays) — 축소된 여섯 필드 브리핑"
affects: [01-05, 01-06]

# Actuals (#2632)
actuals:
  tokens: 6138
  tasks: 2
  commits: 4

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "count(*) FILTER (WHERE ...)를 CASE 문으로 부풀리지 않고 그대로 사용 — 이 페이즈의 research_resolution이 두 SQLite 빌드(시스템 Node 3.50.4, Electron 번들 3.53.1) 모두에서 동작을 이미 확인함(Open Question A1 해소)"
    - "briefing()의 oldest_todo_days는 SQL에서 최소 captured_at 한 행만 가져오고 날수 계산은 JS Date에서 — MIN() 대상 FILTER 지원 여부를 확인할 필요 없이 안전한 형태"
    - "D-05의 살아남는 함수는 db.mjs의 SQL 방언만 바꾸는 것이 아니라, 제거 대상 테이블·칼럼에 기대는 부분을 통째로 드롭하고 다시 쓰는 작업(특히 briefing) — RESEARCH Pitfall 1 그대로 적용"

key-files:
  created: []
  modified:
    - main/store.mjs
    - test/store.test.mjs

key-decisions:
  - "briefing()의 due 비교는 YYYY-MM-DD TEXT 사전순 비교로, today 파라미터는 new Date().toISOString().slice(0,10)으로 호출부에서 계산(D-10과 일치, SQL 안에서 날짜 연산 없음)"
  - "createProject는 원본과 동일하게 INSERT ... RETURNING id 형태를 쓰되 ON CONFLICT 대신 INSERT OR IGNORE로 표기 — 충돌 시 RETURNING이 빈 결과를 내어 null을 돌려주는 의미는 동일"
  - "getProjects()는 이 플랜에서 신설한 별도 함수이며, 01-02가 getViewState() 안에 이미 인라인해 둔 프로젝트 조회(정렬 기준이 다름: sort,name)는 그대로 두었다 — 기존 통과 테스트를 건드리지 않기 위한 최소 변경 범위 판단"

patterns-established: []

requirements-completed: [STOR-01, STOR-05]

coverage:
  - id: D1
    description: "프로젝트 CRUD(getProjects/createProject/updateProject/archiveProject/moveProject)가 새 저장소에서 동작하고 moveProject의 다중 UPDATE는 withTransaction으로 원자적이다"
    requirement: "STOR-01"
    verification:
      - kind: unit
        ref: "test/store.test.mjs#createProject는 정수 id를 돌려주고 같은 이름으로 다시 부르면 새 행이 생기지 않는다"
        status: pass
      - kind: unit
        ref: "test/store.test.mjs#moveProject 뒤 getProjects() 순서가 바뀌고 sort가 0..n으로 정규화된다"
        status: pass
      - kind: unit
        ref: "test/store.test.mjs#getProjects()는 status가 active인 것만 sort·id 순으로 돌려준다"
        status: pass
    human_judgment: false
  - id: D2
    description: "항목 조작 함수 전부(완료/취소·프로젝트 배정(대기 유지 분기 포함)·마감·대기 전환·이름 변경·메모·재촉(30분 dedup)·소프트 삭제/복구·purge·getInbox)가 예전과 같은 의미로 동작"
    requirement: "STOR-01"
    verification:
      - kind: unit
        ref: "test/store.test.mjs#assignProject는 kind를 todo로 바꾸지만 keepKind가 true면 대기 항목이 대기 탭에 남는다"
        status: pass
      - kind: unit
        ref: "test/store.test.mjs#completeItem 뒤 done_at이 ISO 8601 UTC 문자열이고 uncompleteItem이 다시 비운다"
        status: pass
      - kind: unit
        ref: "test/store.test.mjs#nudgeItem을 30분 안에 두 번 부르면 두 번째는 repeated:true이고 count가 오르지 않는다, nudgeRestore로 직전 값이 되돌아온다"
        status: pass
      - kind: unit
        ref: "test/store.test.mjs#removeItem 뒤 getViewState()에서 사라지지만 행은 남아 있고 restoreItem이 되살린다"
        status: pass
      - kind: unit
        ref: "test/store.test.mjs#purgeDeleted(30)은 30일보다 오래 전에 지워진 행만 실제로 지우고 그 수를 돌려준다"
        status: pass
      - kind: unit
        ref: "test/store.test.mjs#purgeDeleted 경계 — 29일 전 삭제는 남고 31일 전 삭제는 지워진다 (T-01-04-02)"
        status: pass
      - kind: unit
        ref: "test/store.test.mjs#getInbox()가 인박스 항목의 context를 객체로 돌려준다"
        status: pass
    human_judgment: false
  - id: D3
    description: "getHistory(days)가 완료 이력을 done_at 내림차순·기간 경계로 돌려주고 commits는 항상 빈 배열"
    requirement: "STOR-01"
    verification:
      - kind: unit
        ref: "test/store.test.mjs#getHistory(7)이 최근 7일 완료 항목을 done_at 내림차순으로 돌려주고 8일 전 항목은 빠진다, commits는 항상 빈 배열"
        status: pass
    human_judgment: false
  - id: D4
    description: "briefing()이 제거 대상 테이블·칼럼 없이 overdue/due_today/inbox/open_todo/oldest_todo_days/stale_waiting 여섯 값만 계산하고, brief.mjs의 briefingLines()와 계약이 맞는다"
    requirement: "STOR-01"
    verification:
      - kind: unit
        ref: "test/store.test.mjs#briefing()이 overdue·due_today·inbox·open_todo·oldest_todo_days·stale_waiting 여섯 키를 숫자로 돌려준다"
        status: pass
      - kind: unit
        ref: "test/store.test.mjs#마감이 어제인 항목은 overdue에, 오늘인 항목은 due_today에 잡히고 kind와 무관하다"
        status: pass
      - kind: unit
        ref: "test/store.test.mjs#5일 넘게 손대지 않은 대기 항목은 stale_waiting에 잡히고 어제 재촉한 대기 항목은 잡히지 않는다"
        status: pass
      - kind: unit
        ref: "test/store.test.mjs#완료됐거나 소프트 삭제된 항목은 어느 숫자에도 잡히지 않는다"
        status: pass
      - kind: unit
        ref: "test/store.test.mjs#briefing() 결과를 briefingLines()에 그대로 넣어도 예외 없이 문자열 배열이 나온다 (T-01-04-03)"
        status: pass
    human_judgment: false
  - id: D5
    description: "PostgreSQL 전용 시간 구문·제거 대상 테이블 이름이 store.mjs에 남아 있지 않다(T-01-04-04)"
    requirement: "STOR-05"
    verification:
      - kind: other
        ref: "grep -nE 'now\\(\\)|interval |::date|current_date|\\$[0-9]' main/store.mjs — 매치 없음"
        status: pass
      - kind: other
        ref: "grep -nE '\\b(activity|issue|resume_card|repo_state|cal_event|review)\\b' main/store.mjs — 매치 없음"
        status: pass
      - kind: automated_ui
        ref: "npm run smoke → SMOKE_OK"
        status: pass
    human_judgment: false

duration: 3min
completed: 2026-09-15
status: complete
---

# Phase 1 Plan 4: 프로젝트·항목 조작과 완료 이력·축소된 아침 브리핑 이식 Summary

**`main/db.mjs`의 나머지 살아남는 함수(프로젝트 CRUD, 항목 조작 14종, getHistory, 축소된 briefing) 20개를 `main/store.mjs`로 옮기고, `main/brief.mjs`의 `briefingLines()`가 여섯 필드만으로도 그대로 통과함을 단위 테스트로 고정했다.**

## Performance

- **Duration:** 약 3분 (첫 커밋 2026-09-15T09:43:02+09:00 ~ 마지막 커밋 2026-09-15T09:46:23+09:00)
- **Started:** 2026-09-15T09:43:02+09:00
- **Completed:** 2026-09-15T09:46:23+09:00
- **Tasks:** 2/2
- **Files modified:** 2 (`main/store.mjs`, `test/store.test.mjs`)

## Accomplishments
- `main/store.mjs`에 프로젝트 CRUD(`getProjects`/`createProject`/`updateProject`/`archiveProject`/`moveProject`)를 추가 — `moveProject`의 다중 `UPDATE`는 01-02가 만든 `withTransaction`으로 원자적으로 묶음
- 항목 조작 14종(`completeItem`/`uncompleteItem`/`assignProject`(keepKind 분기 유지)/`setDue`/`toWaiting`/`renameItem`/`removeItem`/`restoreItem`/`setNote`/`nudgeItem`/`nudgeRestore`/`getInbox`/`purgeDeleted`) 이식 — `nudgeItem`의 30분 dedup 판정과 `purgeDeleted`의 30일 유예는 원본 의미 그대로, 시각 계산만 JS `Date` + 문자열 바인딩으로 교체
- `getHistory(days=7)` — 완료 항목을 `done_at` 내림차순으로, `commits`는 항상 빈 배열(제거 대상 수집기에서 오던 값이라 계산하지 않되 호출부/렌더러가 읽는 모양은 유지)
- `briefing(staleDays=5)` — 원본의 이슈·활동·리포 상태 서브쿼리를 통째로 드롭하고 overdue·due_today·inbox·open_todo·oldest_todo_days·stale_waiting 여섯 값만 계산하는 형태로 다시 씀(RESEARCH Pitfall 1). `count(*) FILTER (WHERE ...)`는 이 플랜의 `research_resolution`이 이미 확인한 문법을 그대로 사용
- `test/store.test.mjs`에 16개 테스트 추가(Task 1: 10건, Task 2: 6건) — `main/brief.mjs`의 `briefingLines()`를 실제로 import해 축소된 결과로 호출하는 계약 테스트 포함
- `node --test test/store.test.mjs` 31/31, `node --test test/brief.test.mjs` 33/33, `npm test` 219/219(기존 203 + 순증 16), `npm run smoke` → `SMOKE_OK`
- 금지 문자열 grep 둘 다 통과: PostgreSQL 전용 시간 구문(`now()`/`interval '`/`::date`/`current_date`/`$N`)과 제거 대상 테이블명(activity/issue/resume_card/repo_state/cal_event/review) 모두 매치 없음

## Task Commits

Task 1·2 모두 RED→GREEN 두 커밋씩입니다:

1. **Task 1 RED** — `test(01-04): add failing tests for project/item CRUD in store.mjs` - `4293b5c` (test)
2. **Task 1 GREEN** — `feat(01-04): 프로젝트·항목 조작 함수를 store.mjs로 이식` - `a168b3d` (feat)
3. **Task 2 RED** — `test(01-04): add failing tests for getHistory and 축소된 briefing` - `ec3a915` (test)
4. **Task 2 GREEN** — `feat(01-04): 완료 이력과 축소된 아침 브리핑을 store.mjs로 이식` - `6f24811` (feat)

**Plan metadata:** (다음 커밋에서 추가 — 이 SUMMARY.md/STATE.md/ROADMAP.md/REQUIREMENTS.md)

## Files Created/Modified
- `main/store.mjs` (수정, 362→608줄) - 프로젝트 CRUD 5종·항목 조작 12종·getHistory·briefing 추가
- `test/store.test.mjs` (수정, 267→586줄) - 16개 테스트 추가(15→31건)

## Decisions Made
- `getProjects()`는 이 플랜에서 신설한 독립 함수이며, 01-02가 `getViewState()` 안에 이미 인라인해 둔 프로젝트 조회(정렬 기준이 `sort, name`으로 다름)는 그대로 두었다 — 두 조회를 통합하는 리팩터는 계획 범위 밖이라 기존 통과 테스트를 건드리지 않는 쪽을 택함(회귀 없음, D-05가 요구한 함수 이름은 모두 충족)
- `createProject`는 원본의 `ON CONFLICT (name) DO NOTHING RETURNING id`를 `INSERT OR IGNORE ... RETURNING id`로 표기 — 충돌 시 `RETURNING`이 빈 결과를 내어 `null`을 돌려주는 의미는 동일(01-02가 `insertCaptures`에 이미 세운 `INSERT OR IGNORE` 관례와도 일치)
- `briefing()`의 `oldest_todo_days`는 `MIN(captured_at) FILTER (WHERE ...)` 대신 `ORDER BY captured_at ASC LIMIT 1`로 가장 오래된 한 행만 가져와 JS에서 날수를 계산 — `count(*) FILTER`는 이 플랜의 `research_resolution`이 확인했지만 다른 집계 함수의 `FILTER` 지원은 별도 확인이 없었으므로, 이미 검증된 `count(*)` 패턴과 일반 `ORDER BY ... LIMIT 1` 조합만 써서 불확실성을 없앰(계획의 "SQL에서는 해당 그룹의 최소 captured_at만 가져오고 날수 계산은 JS에서 한다" 지시와 정확히 일치)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] briefing() 주석에서 금지 테이블명이 영문 리터럴로 노출된 것을 발견해 수정**
- **Found during:** Task 2 GREEN 구현 직후 acceptance criteria grep 재실행
- **Issue:** `briefing()` 위에 단 한국어 주석이 "제거 대상 테이블(issue/activity/repo_state)"처럼 영문 테이블명을 그대로 적어, `grep -nE "\b(activity|issue|resume_card|repo_state|cal_event|review)\b" main/store.mjs`(T-01-04-04 가드)에 걸렸다. 실제 SQL에는 해당 테이블 참조가 전혀 없었고 순수하게 설명용 주석의 단어 선택 문제였다
- **Fix:** 주석을 "이번 페이즈에서 걷어낸 테이블·칼럼"처럼 테이블명을 나열하지 않는 표현으로 바꿔 같은 의미를 유지했다
- **Files modified:** main/store.mjs
- **Verification:** 두 grep 모두 재실행해 매치 없음 확인, `node --test test/store.test.mjs` 31/31 유지, `npm test` 219/219 유지
- **Committed in:** 6f24811 (Task 2 GREEN 커밋에 포함 — 별도 커밋 없이 같은 GREEN 작업 중 수정)

---

**Total deviations:** 1 auto-fixed (1 bug — 가드 위반 주석 수정)
**Impact on plan:** 실제 동작에는 영향 없는 주석 표현 수정. 스코프 크리프 없음.

## 되돌리기 확인 (Task 2 action)

`briefing()`의 `stale_waiting` 계산에서 `coalesce(nudged_at, captured_at)`을 `captured_at`으로 바꿔(재촉 시각을 무시하도록) `node --test test/store.test.mjs`를 다시 돌렸습니다. 결과: 31건 중 정확히 1건만 실패 — "5일 넘게 손대지 않은 대기 항목은 stale_waiting에 잡히고 어제 재촉한 대기 항목은 잡히지 않는다"(목표 테스트, `id-fresh`가 어제 재촉했음에도 10일 전 캡처 시각 기준으로 다시 잡혔다). 다른 30건은 영향 없이 통과해 변경의 영향 범위가 의도한 대로 좁음을 확인했습니다. 원복 후 31/31 재확인, `npm test` 219/219 재확인.

## Issues Encountered
None beyond the deviation documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `main/store.mjs`가 D-05의 "살아남는 함수" 목록(`insertCaptures`·`getViewState`·`logEvent` + 이 플랜의 20개)을 전부 구현했으므로, 01-05가 `main/ipc.mjs`의 나머지 위임(프로젝트·항목·완료 이력·브리핑 IPC 핸들러)을 `ctx.db` 대신 `ctx.store`로 한 번에 갈아끼울 수 있다
- `main/db.mjs`와 `pg` 풀은 이 플랜에서 한 줄도 바뀌지 않았다 — D-05 전환 기간 그대로, `main/ipc.mjs`의 해당 핸들러들은 여전히 `ctx.db`를 부른다(01-05가 배선을 교체)
- `main/ipc.mjs`는 계획대로 건드리지 않았다 — 파일 범위(`main/store.mjs`, `test/store.test.mjs`)를 벗어난 변경 없음
- 이 샌드박스는 전역 단축키가 등록되지 않아(01-01/01-02/01-03 SUMMARY와 동일한 한계) hotkey 경로 자체는 검증 불가하지만, 이 플랜은 hotkey와 무관한 저장소 함수 확장이라 영향 없음
- 블로커 없음

## Self-Check: PASSED

- FOUND: main/store.mjs (getProjects/createProject/updateProject/archiveProject/moveProject/completeItem/uncompleteItem/assignProject/setDue/toWaiting/renameItem/removeItem/restoreItem/setNote/nudgeItem/nudgeRestore/getInbox/purgeDeleted/getHistory/briefing 20개 함수 모두 export 확인), test/store.test.mjs
- FOUND commit: 4293b5c, a168b3d, ec3a915, 6f24811
- Re-ran plan-level `<verification>`: `node --test test/store.test.mjs` exit 0 (31/31, ≥30 요구 충족), `node --test test/brief.test.mjs` exit 0 (33/33), `npm test` exit 0 (219/219), `npm run smoke` 출력에 `SMOKE_OK` 포함, `main/store.mjs`에 PostgreSQL 전용 시간 구문과 금지 테이블명 모두 grep 매치 없음
- `plan_head_before: 9155465a9f8892594ea47642dfbcf3e17c1bbd6f`, `commits: 4` (측정: `git rev-list --count 9155465..HEAD`)

---
*Phase: 01-embedded-storage*
*Completed: 2026-09-15*
