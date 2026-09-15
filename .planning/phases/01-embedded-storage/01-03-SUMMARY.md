---
phase: 01-embedded-storage
plan: 03
subsystem: infra
tags: [electron, sqlite, queue, tray, ipc]

# Dependency graph
requires:
  - phase: 01-02
    provides: "main/store.mjs — createStore(file), insertCaptures/getViewState, open/close/reopen/status"
provides:
  - "main/queue.mjs — replayPending(consume): rename→반영→삭제, 실행 중 append-only"
  - "main/jobs.mjs — replayQueueOnce(ctx): 시작 시 1회만 큐를 저장소에 반영, 주기 타이머 없음"
  - "main/ipc.mjs — saveCapture(ctx, title, context): queue.append 동기 직후 store.insertCaptures 동기 시도·재시도(reopen)·ctx.pending 집계, capture:save/capture:followUp 공용"
  - "ctx.pending — 이번 실행에서 즉시 반영에 실패한 캡처 수(큐 줄 수 아님)"
  - "트레이 툴팁·메뉴·오늘 뷰가 store.status().notice/ctx.pending을 드러냄"
affects: [01-04, 01-05, 01-06, 01-07]

# Actuals (#2632)
actuals:
  tokens: 5900
  tasks: 3
  commits: 4

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "큐 원자적 rename — 실행 중에는 append-only, 시작 시 1회 rename으로 옆에 치운 뒤 반영·삭제(경합 창 제거)"
    - "단일 캡처 저장 경로 — saveCapture(ctx, title, context)를 capture:save/capture:followUp/(향후 01-07 주입 모드)가 공유"
    - "저장소 상태 문구 우선순위 — status().notice > pending 안내 > 정상, 트레이·오늘 뷰가 같은 문구를 재사용"

key-files:
  created: []
  modified:
    - main/queue.mjs
    - test/queue.test.mjs
    - main/jobs.mjs
    - main/ipc.mjs
    - main/lifecycle.mjs
    - renderer/today.js
    - renderer/capture.js

key-decisions:
  - "Task 1 GREEN 커밋에서 main/jobs.mjs의 ctx.queue.drain( ) 호출부를 replayPending( )으로 최소 수정 — Task 1 acceptance criteria(grep으로 옛 이름 호출부 검사)가 main/ 전체를 대상으로 해 jobs.mjs를 건드리지 않으면 통과 불가능했고, 방치하면 실제로도 존재하지 않는 함수를 호출하는 런타임 버그였다. flush() 전체 재작성은 계획대로 Task 2가 맡았다"
  - "capture:followUp도 saveCapture를 통해 parseCaptureToken을 거치게 되어, 회의 후속 캡처도 #약어를 인식하게 됐다(이전에는 followUp이 제목을 그대로만 썼다) — D-01이 요구한 '두 경로가 같다'는 원칙을 문자 그대로 따른 결과이며 회귀가 아니라 통합"
  - "ctx.pending은 시작 시 replayQueueOnce가 항상 0으로 되돌린다 — 이전 실행이 남긴 큐 파일이 이번 반영에서도 실패해 디스크에 남더라도, 그 사실은 다음 재기동 때 다시 시도될 뿐 ctx.pending에는 반영하지 않는다(ctx.pending은 '이번 세션에서 방금 실패한 캡처 수'만 의미)"

patterns-established:
  - "Pattern: 저장소 상태 단일 진실 공급원 — main/lifecycle.mjs의 storeStatusLine()이 store.status().notice/ctx.pending을 조합해 트레이 툴팁·메뉴·오늘 뷰가 같은 우선순위로 문구를 만든다. 다음 페이즈가 트레이·오늘 뷰 문구를 더 다듬을 때 이 함수만 바꾸면 된다"

requirements-completed: [STOR-02]

coverage:
  - id: D1
    description: "main/queue.mjs — drain을 replayPending으로 재작성: 시작 시 1회 rename→반영→삭제, 실행 중 append-only, 반영 중 들어온 캡처는 새 큐 파일에 남고 섞이지 않음, 이전 실행이 남긴 대기 파일도 오래된 순으로 함께 반영"
    requirement: "STOR-02"
    verification:
      - kind: unit
        ref: "test/queue.test.mjs (7/7 pass)"
        status: pass
      - kind: unit
        ref: "gsd-tools check tdd-red-evidence — RED_EVIDENCE_OK (target test: 'replayPending은 큐 두 항목을 반영하고 큐 파일과 대기 파일을 모두 지운다')"
        status: pass
    human_judgment: false
  - id: D2
    description: "main/jobs.mjs — replayQueueOnce(ctx)가 scheduleJobs 안에서 !SMOKE 가드 밖에 정확히 한 번 호출됨. FLUSH_MS·주기 타이머 제거"
    requirement: "STOR-02"
    verification:
      - kind: unit
        ref: "npm test (203/203 pass)"
        status: pass
      - kind: other
        ref: "grep -rn FLUSH_MS main/ (매치 없음), node -e 스크립트로 setInterval(replayQueueOnce|flush) 부재 확인"
        status: pass
    human_judgment: false
  - id: D3
    description: "main/ipc.mjs — saveCapture(ctx, title, context)가 queue.append(동기) 직후 store.insertCaptures를 동기 시도하고, 실패하면 store.reopen() 후 한 번 더 시도하고, 그래도 실패하면 ctx.pending을 늘리되 예외를 올리지 않는다. capture:save/capture:followUp 둘 다 이 함수를 쓰고 dbOnline 필드는 응답에서 빠졌다"
    requirement: "STOR-02"
    verification:
      - kind: unit
        ref: "scratchpad 검증 스크립트 — store.insertCaptures가 두 번(최초+reopen 후) 모두 throw해도 saveCapture는 {ok:true}를 돌려주고 queue.count()가 1 늘고 ctx.pending이 1 늘어남을 확인. 성공 경로에서는 ctx.pending이 늘지 않음도 별도로 확인"
        status: pass
      - kind: unit
        ref: "npm test (203/203 pass) — 회귀 없음"
        status: pass
    human_judgment: false
  - id: D4
    description: "트레이 툴팁·메뉴, 오늘 뷰 상단·하단이 store.status().notice/ctx.pending을 드러내고, 캡처 창은 실패를 보이지 않는다(dbOnline 분기 제거). today:getState 응답은 issues/repoStates/events 빈 배열을 항상 포함"
    requirement: "STOR-02"
    verification:
      - kind: unit
        ref: "scratchpad 검증 스크립트 — storeStatusLine/tooltip 로직을 소스와 동일하게 복제해 정상/대기/에러/손상 네 조합에서 기대 문구를 냄을 확인"
        status: pass
      - kind: other
        ref: "grep -rn 'DB 대기' main/ renderer/, grep -rn whenwork-db renderer/, grep dbOnline renderer/capture.js — 모두 매치 없음"
        status: pass
      - kind: automated_ui
        ref: "npm run smoke → SMOKE_OK"
        status: pass
    human_judgment: true
    rationale: "실제 트레이 아이콘 툴팁·컨텍스트 메뉴, 오늘 뷰 상단 배너의 실제 렌더링 모습과, 저장소 파일을 실제로 잠근 채 캡처했을 때 OS 알림이 뜨지 않는지는 이 샌드박스(트레이·전역 단축키가 등록되지 않는 환경, 01-01/01-02 SUMMARY와 동일한 한계)에서 눈으로 볼 수 없다. 로직은 소스와 동일한 스크립트로 검증했지만 실제 데스크톱에서 한 번 더 확인을 권한다."

duration: 12min
completed: 2026-09-15
status: complete
---

# Phase 1 Plan 3: 큐 재설계와 캡처 즉시 반영·대기 표시 Summary

**`main/queue.mjs`의 `drain`을 원자적 rename 기반 `replayPending`으로 재작성하고, 캡처가 큐 선기록 직후 같은 호출에서 저장소에 동기 반영·재시도되도록 `saveCapture(ctx, title, context)`로 통합했으며, 실패 시 대기 건수(`ctx.pending`)만 트레이·오늘 뷰에 조용히 드러나도록 배선했다.**

## Performance

- **Duration:** 약 12분 (첫 커밋 2026-09-15T00:20:59Z ~ 마지막 커밋 2026-09-15T00:31:57Z)
- **Started:** 2026-09-15T00:20:59Z
- **Completed:** 2026-09-15T00:31:57Z
- **Tasks:** 3/3
- **Files modified:** 7 (`main/queue.mjs`, `test/queue.test.mjs`, `main/jobs.mjs`, `main/ipc.mjs`, `main/lifecycle.mjs`, `renderer/today.js`, `renderer/capture.js`)

## Accomplishments
- `main/queue.mjs` — 실행 중에는 큐 줄을 지우지 않는 append-only 구조로 확정. `replayPending(consume)`이 시작 시 `queue.jsonl`을 원자적 rename으로 치우고(경합 창 제거), 그 파일과 이전 실행이 반영 도중 죽어 남긴 대기 파일들을 오래된 순으로 모아 동기로 반영한다. 실패한 파일은 지우지 않고 다음 기동이 재시도한다
- `main/jobs.mjs` — `FLUSH_MS`·주기 `setInterval(flush, ...)`를 완전히 제거하고 `replayQueueOnce(ctx)`가 `scheduleJobs` 안에서 딱 한 번(스모크 포함) 호출되도록 함
- `main/ipc.mjs` — `saveCapture(ctx, title, context)` 신설: 큐 선기록 → 저장소 동기 즉시 반영 → 실패 시 `store.reopen()` 후 1회 재시도 → 그래도 실패하면 `ctx.pending += 1`. `capture:save`/`capture:followUp` 둘 다 이 함수를 쓰고, 응답에서 `dbOnline` 필드가 빠졌다
- `main/lifecycle.mjs` — `ctx.pending` 필드 신설(시작 시 0), `refreshTrayMenu`가 `store.status().notice`/`ctx.pending`을 조합한 문구로 트레이 툴팁·메뉴를 그림. 큐 반영이 시작 시 1회뿐이므로 `showToday()`의 불필요한 재호출도 제거
- `renderer/today.js` — 오프라인 안내에서 Docker·whenwork-db 문구 삭제, `state.notice`/대기 건수 기반 안내로 교체. 저장소가 열려 있어도 대기가 있거나 손상 격리 안내가 있으면 오늘 뷰 상단에 배너를 붙임
- `renderer/capture.js` — 저장 직후 `dbOnline` 분기 삭제(D-03 — 캡처 창은 실패를 보이지 않는다)
- `npm test` 203/203(기존 202 + 순증 1 — 큐 테스트를 6건→7건으로 재작성), `npm run smoke` → `SMOKE_OK`

## Task Commits

Task 1은 TDD로 RED→GREEN 두 커밋, Task 2·3은 `type="auto"` 표준 커밋입니다:

1. **Task 1 RED** — `test(01-03): add failing tests for queue replayPending` - `d7864a4` (test)
2. **Task 1 GREEN** — `feat(01-03): queue.mjs의 drain을 replayPending으로 재작성` - `ddd9041` (feat)
3. **Task 2** — `feat(01-03): 시작 시 1회 큐 반영과 캡처의 동기 즉시 반영·재시도` - `99b7f7e` (feat)
4. **Task 3** — `feat(01-03): 대기 건수와 저장소 안내를 트레이·오늘 뷰에 드러내기` - `fc5e297` (feat)

**Plan metadata:** (다음 커밋에서 추가 — 이 SUMMARY.md/STATE.md/ROADMAP.md/REQUIREMENTS.md)

## Files Created/Modified
- `main/queue.mjs` (재작성) - `drain` 삭제, `replayPending` 신설
- `test/queue.test.mjs` (재작성) - 7개 테스트: append/readAll, 반영 성공, 반영 실패 후 재시도, 반영 중 유입 캡처 격리, 이전 실행 대기 파일 합류, 깨진 줄 스킵, 빈 큐
- `main/jobs.mjs` (수정) - `flush`/`FLUSH_MS` 삭제, `replayQueueOnce` 신설·1회 호출
- `main/ipc.mjs` (수정) - `saveCapture` 신설, `capture:save`/`capture:followUp`이 이를 공유, `today:getState`의 `pending`이 `ctx.pending`을 씀
- `main/lifecycle.mjs` (수정) - `ctx.pending` 필드, `storeStatusLine()`, 트레이 툴팁/메뉴가 저장소 상태 기반, `showToday()`의 불필요한 flush 제거
- `renderer/today.js` (수정) - 오프라인 안내·상단 배너·footer 문구를 저장소/대기 건수 기준으로 교체
- `renderer/capture.js` (수정) - `dbOnline` 분기 삭제

## Decisions Made
- Task 1 GREEN 커밋에서 `main/jobs.mjs`의 옛 `ctx.queue.drain(...)` 호출부를 `replayPending(...)`으로 최소 수정 — 자세한 이유는 Deviations 참고
- `saveCapture`를 통해 `capture:followUp`도 `parseCaptureToken`을 거치게 됨 — D-01의 "두 경로가 같다" 원칙을 그대로 따른 결과(회귀 아님, Deviations 참고)
- `ctx.pending`은 "이번 세션에서 즉시 반영에 실패한 캡처 수"로 한정하고, 큐 파일에 남은 줄 수와는 분리했다(D-02 — 큐는 실행 중 append-only라 성공한 캡처까지 쌓인다)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Task 1 acceptance criteria(그리고 실질적인 런타임 버그) 때문에 main/jobs.mjs의 `.drain(` 호출부를 Task 1에서 미리 고침**
- **Found during:** Task 1 (acceptance criteria `! grep -q "\.drain(" main/ test/ -r` 실행)
- **Issue:** `main/queue.mjs`가 더 이상 `drain`을 export하지 않는데 `main/jobs.mjs:47`의 `flush()`가 여전히 `ctx.queue.drain(...)`을 불렀다. Task 1의 파일 범위는 `main/queue.mjs`·`test/queue.test.mjs`뿐이지만, acceptance criteria의 grep은 `main/` 전체를 검사해 이 호출부가 남아 있으면 통과할 수 없었고, 방치하면 큐 반영 시점(앱 구동 30초 뒤)에 `TypeError: ctx.queue.drain is not a function`으로 죽는 실제 버그였다
- **Fix:** `flush()` 안의 호출부만 `ctx.queue.replayPending(...)`으로 바꿨다(await는 필요 없어졌지만 값 자체는 무해해 그대로 두지 않고 제거). `flush()` 자체의 전면 재작성(삭제하고 `replayQueueOnce`로 교체)은 계획대로 Task 2가 맡았다
- **Files modified:** main/jobs.mjs
- **Verification:** `grep -rn "\.drain(" main/ test/` 매치 없음, `npm test` 203/203
- **Committed in:** ddd9041 (Task 1 GREEN 커밋)

**2. [Rule 2 - Missing Critical] `showToday()`의 `ctx.jobs.flush()` 호출 제거**
- **Found during:** Task 2 (`flush`를 `ctx.jobs`에서 빼는 중, `main/lifecycle.mjs`의 `showToday()`가 여전히 `ctx.jobs.flush()`를 부르는 것을 발견)
- **Issue:** Task 2가 `ctx.jobs.flush`를 없애면 오늘 뷰를 열 때마다 `TypeError: ctx.jobs.flush is not a function`으로 죽는다. 계획의 Task 2 action에는 이 호출부가 언급되지 않았다
- **Fix:** 그 호출을 지우고 이유를 주석으로 남겼다 — 큐 반영은 이제 시작 시 1회뿐이라(D-01/D-02) 창을 열 때 다시 부를 근거가 없다
- **Files modified:** main/lifecycle.mjs
- **Verification:** `npm test` 203/203, `npm run smoke` → `SMOKE_OK` (오늘 뷰를 실제로 여는 스모크 경로 포함)
- **Committed in:** 99b7f7e (Task 2 커밋)

---

**Total deviations:** 2 auto-fixed (1 blocking-이슈 수정, 1 missing-critical 수정)
**Impact on plan:** 둘 다 계획이 지정한 파일 재작성이 자연스럽게 남긴 배관 문제이며, D-01/D-02(큐 반영은 시작 시 1회, 옛 이름 호출부 제거)의 취지를 그대로 따랐다. 스코프 크리프 없음.

## 되돌리기 확인 (Task 1 acceptance criteria)

`replayPending`의 rename 단계를 빼고 원래 `drain()`처럼 "읽기 → consume → 재읽기 → tail만 남기고 쓰기"로 되돌린 뒤 `node --test test/queue.test.mjs`를 다시 돌렸습니다. 결과: 7건 중 3건 실패 — "반영 중 들어온 캡처는 새 큐 파일에 남고 이번 반영 대상에 섞이지 않는다"(목표 테스트), "replayPending 중 consume이 throw하면..."(재시도 흐름), "이전 실행이 남긴 대기 파일도..."(대기 파일 스캔 자체가 rename 없이는 아무것도 못 찾음). 원복 후 7/7 재확인. rename 단계가 실제로 세 가지 보장(경합 제거·재시도·이전 실행 합류)을 만들어낸다는 것을 확인했습니다.

## Issues Encountered
None beyond the deviations documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `main/queue.mjs`(`replayPending`)·`main/jobs.mjs`(`replayQueueOnce`)·`main/ipc.mjs`(`saveCapture`)의 계약이 섰으므로, 01-04(나머지 CRUD 이관)는 저장소 함수 확장에만 집중할 수 있다
- 01-07(강제종료 스모크)이 기댈 지점: `replayQueueOnce()`가 `!SMOKE` 가드 밖에서 정확히 한 번 불리므로, 두 번째 기동에서 큐 반영이 실제로 일어나는지를 검증하는 하네스를 그대로 얹을 수 있다
- 이 샌드박스는 전역 단축키가 등록되지 않고 트레이 아이콘을 눈으로 볼 수 없어(01-01/01-02 SUMMARY와 동일한 한계) 트레이 툴팁·메뉴·오늘 뷰 배너의 실제 렌더링과 "저장소를 잠근 채 캡처해도 OS 알림이 뜨지 않는다"는 실제 데스크톱에서 한 번 더 확인을 권장한다
- 블로커 없음

## Self-Check: PASSED

- FOUND: main/queue.mjs (replayPending export 포함), main/jobs.mjs (replayQueueOnce 포함), main/ipc.mjs (saveCapture export 포함), main/lifecycle.mjs, renderer/today.js, renderer/capture.js
- FOUND commit: d7864a4, ddd9041, 99b7f7e, fc5e297
- Re-ran plan-level `<verification>`: `node --test test/queue.test.mjs` exit 0 (7/7 ≥ 6 요구 충족), `npm test` exit 0 (203/203), `npm run smoke` 출력에 `SMOKE_OK` 포함, `grep -rn FLUSH_MS main/` 매치 없음, `setInterval(replayQueueOnce|flush)` 부재 확인, 저장소가 항상 throw하는 상태를 흉내낸 스크립트에서 `saveCapture`가 `{ok:true}`를 돌려주고 큐 줄이 늘어남을 확인
- `plan_head_before: 10a6ce043fc5600d5ead58ca67fc2db58b4a1766`, `commits: 4` (측정: `git rev-list --count 10a6ce0..HEAD`)

---
*Phase: 01-embedded-storage*
*Completed: 2026-09-15*
