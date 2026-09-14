---
phase: 01-embedded-storage
plan: 01
subsystem: infra
tags: [electron, ipc, refactor, module-split]

# Dependency graph
requires: []
provides:
  - "main/lifecycle.mjs — bootstrap(ctx) 창·트레이·단축키·앱 수명"
  - "main/jobs.mjs — scheduleJobs(ctx) 백그라운드 작업과 타이머"
  - "main/ipc.mjs — registerIpc(ctx) 모든 ipcMain 핸들러"
  - "main/index.mjs — bootstrap() 호출만 남은 9줄 엔트리포인트"
  - "ctx 객체 공유 패턴 — 세 모듈이 순환 참조 없이 가변 상태를 주고받는 경계"
affects: [01-02, 01-03, 01-04, 01-05, 01-06, 01-07]

# Actuals (#2632)
actuals:
  tokens: 36896
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ctx 객체 주입 — lifecycle.mjs가 만든 하나의 가변 상태 객체를 registerIpc(ctx)/scheduleJobs(ctx)에 전달"
    - "lifecycle → { ipc, jobs } 단방향 import (ipc.mjs와 jobs.mjs는 서로 import하지 않음)"

key-files:
  created:
    - main/lifecycle.mjs
    - main/jobs.mjs
    - main/ipc.mjs
  modified:
    - main/index.mjs

key-decisions:
  - "main/index.mjs 1479줄을 lifecycle/jobs/ipc 3파일로 D-08 그대로 분할 — 저장소 교체(01-02)보다 먼저, 별도 커밋으로"
  - "Task 1~2 중간 상태에서 아직 옮기지 않은 index.mjs 코드가 lifecycle.mjs/jobs.mjs의 함수를 불러야 할 때는 ctx 필드(ctx.flush 등, 이후 ctx.jobs.*)로 다리를 놓고 각 후속 태스크에서 정리 — 동작은 각 태스크 끝마다 npm test/npm run smoke로 분할 전과 동일함을 확인"
  - "review:get이 읽는 reviewing, resume:generate가 읽는 generatingCards, settings:get이 읽는 lastCalendarError는 jobs.mjs 클로저가 아니라 ctx 필드로 두어 index.mjs(현재)/ipc.mjs(Task 3 이후)가 실시간 값을 읽을 수 있게 함"

patterns-established:
  - "Pattern: ctx 공유 객체 — 새 모듈이 index.mjs의 전역 let을 대체할 때는 ctx 필드로 옮기고, 여러 모듈이 같은 값을 읽고 써야 하면 클로저가 아니라 ctx에 둔다"

requirements-completed: [STOR-01]

coverage:
  - id: D1
    description: "main/lifecycle.mjs의 bootstrap() — ctx 생성, 창/트레이/단축키/앱 수명 이벤트를 index.mjs에서 순수 이동"
    requirement: "STOR-01"
    verification:
      - kind: unit
        ref: "npm test (187/187 pass, 분할 전과 동일)"
        status: pass
      - kind: automated_ui
        ref: "npm run smoke"
        status: unknown
    human_judgment: true
    rationale: "이 샌드박스 환경은 분할 전(git stash로 확인한 베이스라인)에도 SMOKE_FAIL(hotkey=false, 이슈 그룹핑 테스트용 실데이터 없음)이라 SMOKE_OK 자체를 낼 수 없다. 분할 전후 출력이 문자 그대로 동일함은 확인했지만, 실제 데스크톱(전역 단축키·트레이가 동작하는 환경)에서 SMOKE_OK로 한 번 더 확인하는 것을 권한다."
  - id: D2
    description: "main/jobs.mjs의 scheduleJobs(ctx) — flush/collectAll/주간리뷰/캘린더/백업/브리핑/완료제안/재개카드 백그라운드 함수와 모든 타이머 등록을 순수 이동"
    requirement: "STOR-01"
    verification:
      - kind: unit
        ref: "npm test (187/187 pass)"
        status: pass
      - kind: automated_ui
        ref: "npm run smoke"
        status: unknown
    human_judgment: true
    rationale: "D1과 동일한 샌드박스 한계. jobs.mjs가 ipc.mjs를 import하지 않음은 grep으로 별도 확인(순환 참조 없음)."
  - id: D3
    description: "main/ipc.mjs의 registerIpc(ctx) — 남은 모든 ipcMain.handle/.on을 순수 이동하고 main/index.mjs를 bootstrap() 호출 하나뿐인 9줄로 축소"
    requirement: "STOR-01"
    verification:
      - kind: unit
        ref: "npm test (187/187 pass)"
        status: pass
      - kind: automated_ui
        ref: "npm run smoke"
        status: unknown
      - kind: other
        ref: "main/preload.cjs의 모든 invoke/send/on 채널을 ipc.mjs·lifecycle.mjs·jobs.mjs와 직접 대조 (스크립트로 각 채널의 등록/발신처 확인)"
        status: pass
    human_judgment: true
    rationale: "smoke 관련 사유는 D1과 동일. 채널 대조는 자동 스크립트로 전부 pass했지만, 렌더러가 실제로 그 데이터를 문제없이 그리는지는 사람이 눈으로 한 번 보는 편이 안전하다."

duration: 54min
completed: 2026-09-14
status: complete
---

# Phase 1 Plan 1: main/index.mjs 3분할(lifecycle/jobs/ipc) Summary

**1479줄짜리 `main/index.mjs`를 동작 변경 없이 `lifecycle.mjs`(앱 수명·창·트레이·단축키) / `jobs.mjs`(백그라운드 작업·타이머) / `ipc.mjs`(모든 IPC 핸들러)로 3분할하고, `index.mjs`는 `bootstrap()` 호출 하나만 남은 9줄 엔트리포인트가 됨. 세 파일은 `lifecycle.mjs`가 만든 `ctx` 객체로만 가변 상태를 주고받으며 서로 순환 참조하지 않는다.**

## Performance

- **Duration:** 약 54분 (git 커밋 시각 기준: phase-plan 작성 직후 07:44:32Z ~ Task 3 커밋 08:38:06Z)
- **Started:** 2026-09-14T07:44:32Z (근사, phase-plan 커밋 직후)
- **Completed:** 2026-09-14T08:38:06Z
- **Tasks:** 3/3
- **Files modified:** 4 (`main/lifecycle.mjs`·`main/jobs.mjs`·`main/ipc.mjs` 신규, `main/index.mjs` 축소)

## Accomplishments
- `main/lifecycle.mjs` — `bootstrap()`이 `ctx`(tray/captureWin/todayWin/dbOnline/hotkeyOk/queue/settings/db 등)를 만들고, 창 생성·트레이 메뉴·전역 단축키·앱 수명 이벤트(`whenReady`/`before-quit`/`will-quit`/`window-all-closed`)를 등록
- `main/jobs.mjs` — `scheduleJobs(ctx)`가 큐 flush, git/이슈 수집, 주간 리뷰 초안, 캘린더 동기화, 백업, 아침 브리핑, 완료 제안, 재개 카드 프리웜과 그 타이머를 전부 맡고, IPC가 불러야 하는 함수는 `ctx.jobs`에 모아 둠
- `main/ipc.mjs` — `registerIpc(ctx)`가 캡처·오늘뷰·항목/프로젝트 CRUD·이슈 승격·재촉·마감·완료제안 뮤트·인박스 분류·주간리뷰 핸들러·재개카드 핸들러·설정·캘린더·백업·열기 채널 전부를 등록
- `main/index.mjs`가 `import { bootstrap } from './lifecycle.mjs'; bootstrap();` 뿐인 9줄로 줄어듦
- 세 태스크 각각 끝에서 `npm test`(187/187, 분할 전과 동일)와 `npm run smoke`(분할 전 베이스라인과 바이트 단위로 동일한 출력)를 확인 — 저장소 코드(`main/db.mjs`)는 전 구간 무변경

## Task Commits

Each task was committed atomically:

1. **Task 1: main/lifecycle.mjs 추출** - `9b024b2` (refactor)
2. **Task 2: main/jobs.mjs 추출** - `48a3152` (refactor)
3. **Task 3: main/ipc.mjs 추출, index.mjs 엔트리포인트화** - `07fdfd1` (refactor)

**Plan metadata:** (다음 커밋에서 추가 — 이 SUMMARY.md/STATE.md/ROADMAP.md/REQUIREMENTS.md)

## Files Created/Modified
- `main/lifecycle.mjs` (신규, 752줄) - ctx 생성, 창·트레이·전역 단축키·앱 수명
- `main/jobs.mjs` (신규, 471줄) - 백그라운드 작업 함수와 타이머 등록, `ctx.jobs` 표면
- `main/ipc.mjs` (신규, 337줄) - 모든 `ipcMain.handle`/`.on` 등록
- `main/index.mjs` (1479줄 → 9줄) - `bootstrap()` 호출만 남은 엔트리포인트

## Decisions Made
- D-08을 그대로 따라 lifecycle → jobs → ipc 순서(연구 문서 권고 순서)로 3분할했고, 저장소 코드는 한 줄도 건드리지 않음
- Task 1~2 사이의 중간 상태에서 아직 이동하지 않은 index.mjs 코드가 이미 옮겨진 함수를 불러야 하는 문제는 매 태스크마다 `ctx` 필드로 다리를 놓아 해결하고, 다음 태스크가 그 다리를 실제 구조로 대체하도록 함(Task 1 종료 시점의 `ctx.flush`/`ctx.collectAll` 등 임시 브리지는 Task 2에서 `ctx.jobs.*`로 대체되며 사라짐)
- `reviewing`·`generatingCards`·`lastCalendarError`는 `jobs.mjs`가 갱신하지만 아직 index.mjs(향후 ipc.mjs)에 남아 있는 핸들러(`review:get`·`resume:generate`·`settings:get`)가 직접 읽어야 해서 클로저 대신 `ctx` 필드로 둠

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Task 1에서 `capture:projects` IPC 핸들러 누락을 스모크로 발견해 즉시 복구**
- **Found during:** Task 1 (main/lifecycle.mjs 추출 후 `npm run smoke` 1차 실행)
- **Issue:** `main/preload.cjs`의 `projects: () => ipcRenderer.invoke('capture:projects')`에 대응하는 핸들러를 index.mjs 재작성 중 실수로 빠뜨려 `No handler registered for 'capture:projects'` 오류 발생
- **Fix:** `ipcMain.handle('capture:projects', () => ctx.refreshAbbrHints())`를 index.mjs에 복구
- **Files modified:** main/index.mjs
- **Verification:** `npm run smoke` 재실행 결과가 분할 전 베이스라인과 동일해짐
- **Committed in:** 9b024b2 (Task 1 커밋에 포함— 커밋 전에 발견해 고쳤으므로 별도 커밋 없음)

**2. [Rule 3 - Blocking] Task 1의 `main/index.mjs`↔`main/lifecycle.mjs` 상호 의존을 ctx 브리지로 해소**
- **Found during:** Task 1 (계획대로 옮기면 `lifecycle.mjs`의 `app.whenReady` 타이머 블록과 트레이 메뉴가 아직 index.mjs에 남아 있는 `flush`/`collectAll`/`maybeBrief` 등을 참조하게 되어 순수 이동만으로는 모듈이 로드되지 않음)
- **Issue:** 계획 문서는 "이 시점 index.mjs에 남은 코드가 ctx를 쓴다"고만 적었지만, 실제로는 반대 방향(이미 옮겨진 lifecycle.mjs 코드가 아직 안 옮겨진 index.mjs 함수를 부르는) 의존도 있었음
- **Fix:** index.mjs가 `bootstrap()` 직후 `ctx.flush = flush; ctx.collectAll = collectAll; ...` 형태로 자신이 아직 갖고 있는 함수를 ctx에 붙여 lifecycle.mjs가 참조할 수 있게 함(Electron `'ready'`는 항상 비동기라 이 대입이 먼저 끝남을 이용). Task 2에서 해당 함수들이 실제로 jobs.mjs로 옮겨가며 이 브리지는 전부 제거됨
- **Files modified:** main/index.mjs, main/lifecycle.mjs
- **Verification:** Task 1 `npm test` 187/187, `npm run smoke` 베이스라인과 동일
- **Committed in:** 9b024b2

**3. [Rule 3 - Blocking] Task 2 계획의 `ctx.jobs` 목록에 없던 함수·상수를 추가로 노출**
- **Found during:** Task 2 (main/jobs.mjs 작성 중, index.mjs에 남은 `review:get`·`inbox:classify`·`resume:sync`·`settings:get`이 실제로 필요로 하는 것을 추적)
- **Issue:** 계획 예시는 `ctx.jobs = { collectAll, makeWeeklyReview, backupNow, syncCalendarNow, todayEvents, buildResumeCard, resumePayload, flush, prewarmCards }`만 들었지만, `review:get`은 `weekOf`를, `inbox:classify`는 `withAiLog`를, `resume:sync`는 `findProject`를, `settings:get`은 백업 기본 경로(`BACKUP_DIR_DEFAULT`)를 추가로 필요로 함
- **Fix:** 네 가지를 `ctx.jobs`에 추가(`weekOf`, `withAiLog`, `findProject`, `BACKUP_DIR_DEFAULT`)
- **Files modified:** main/jobs.mjs, main/index.mjs
- **Verification:** Task 2 `npm test` 187/187, 모든 핸들러가 예외 없이 등록됨을 스모크로 확인
- **Committed in:** 48a3152

**4. [Rule 1 - Bug] 두 커밋의 jobs.mjs/ipc.mjs 문서 주석이 자기 자신의 acceptance 검사를 스스로 걸리게 한 것을 수정**
- **Found during:** Task 2, Task 3 (각 태스크의 acceptance criteria `! grep -q "ipc.mjs" main/jobs.mjs` / `! grep -q "jobs.mjs" main/ipc.mjs` 검사)
- **Issue:** "IPC 핸들러는 main/ipc.mjs가 꺼내 쓴다" 같은 설명 주석이 파일명을 문자열 그대로 담고 있어, import 여부와 무관하게 grep이 실패로 판정함
- **Fix:** 주석 문구를 "IPC 핸들러 모듈"/"백그라운드 작업 모듈" 식으로 바꿔 실제 import 관계(순환 없음)는 그대로 유지하면서 검사를 통과시킴
- **Files modified:** main/jobs.mjs, main/ipc.mjs
- **Verification:** `grep -q "ipc.mjs" main/jobs.mjs` / `grep -q "jobs.mjs" main/ipc.mjs` 둘 다 실패(=매치 없음) 확인
- **Committed in:** 48a3152, 07fdfd1

---

**Total deviations:** 4 auto-fixed (3 blocking-issue 수정, 1 bug/self-tripping-check 수정)
**Impact on plan:** 전부 D-08의 "순수 이동, 동작 무변경" 원칙을 지키기 위한 배관 수정이며 실제 런타임 동작을 바꾸지 않음(매 태스크 `npm test`/`npm run smoke`로 확인). 스코프 크리프 없음.

## Not Satisfied As Literally Written (documented, not silently skipped)

계획의 acceptance criteria 두 가지는 실제로는 만족 불가능하거나 검사 방식 자체가 부정확함이 확인되어, 아래처럼 대체 검증으로 갈음했다(2회 이상 시도 후에도 원 문구를 그대로 만족시킬 방법이 없음을 확인):

1. **Task 3 — `test $(grep -c "ipcMain" main/ipc.mjs) -ge 35`**: 실제 값은 30(핸들러 등록 28건 + import줄 1 + 파일 상단 설명 주석 1). 원본 `main/index.mjs`도 IPC 핸들러 등록 지점은 28곳뿐이었고(그중 13곳은 `itemOps` 순회 등록 패턴 한 줄이 담당 — 계획 스스로 "형태를 유지한 채"라고 못박아 풀어 헤칠 수 없음), 35라는 문턱은 애초에 이 코드베이스로는 순수 이동만으로 도달 불가능한 값이었다. 대신 `main/preload.cjs`가 노출하는 모든 채널(invoke 26건·send 3건·on(push) 5건)을 스크립트로 하나하나 대조해 전부 등록/발신됨을 확인했다(위 커밋 메시지·아래 검증 로그 참고).
2. **Task 3 — "main/preload.cjs가 노출하는 모든 채널 이름이 main/ipc.mjs 안에 등장한다"**: `capture:reset`·`card:done`·`today:openReview`·`today:refresh` 네 채널은 렌더러로 보내는 push 이벤트라 그 이벤트를 실제로 일으키는 `main/lifecycle.mjs`(창 열기)·`main/jobs.mjs`(카드 생성 완료)에서 `webContents.send(...)`로 보낸다 — `ipc.mjs`는 애초에 `ipcMain.handle`/`.on`만 등록하는 파일이라 이 네 채널이 문자 그대로 등장할 이유가 없다. 기능은 100% 보존(각 발신처 grep으로 확인)했지만 문자열 매칭 기준은 이 아키텍처와 맞지 않는다.

## Issues Encountered
None beyond the deviations documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `main/index.mjs`·`main/lifecycle.mjs`·`main/jobs.mjs`·`main/ipc.mjs` 경계가 섰으므로, 01-02(저장소를 `node:sqlite` 기반 `main/store.mjs`로 교체)는 "이 파일의 이 함수"로 좁혀서 작업할 수 있다
- `main/db.mjs`와 pg 풀은 이 계획에서 한 줄도 바뀌지 않았다 — 01-02가 온전히 새로 시작한다
- 이 샌드박스 환경은 전역 단축키 등록과 실제 GitHub 이슈 데이터가 없어 `npm run smoke`가 분할 전부터 `SMOKE_FAIL`이었다(git stash로 베이스라인 확인). 실제 Windows 데스크톱에서 `npm run smoke`가 `SMOKE_OK`로 끝나는지 한 번 더 확인하는 것을 권장한다
- 블로커 없음

## Self-Check: PASSED

- FOUND: main/lifecycle.mjs, main/jobs.mjs, main/ipc.mjs, main/index.mjs
- FOUND commit: 9b024b2, 48a3152, 07fdfd1
- Re-ran plan-level `<verification>`: `npm test` exit 0 (187/187 pass, matches baseline), `main/index.mjs` 9 lines (< 60), `main/db.mjs` unchanged across all three commits (`git diff --stat 98c17e3..HEAD -- main/db.mjs` empty)
- `npm run smoke` output identical to the pre-split baseline (verified via `git stash`) — documented above as a pre-existing sandbox limitation, not a regression

---
*Phase: 01-embedded-storage*
*Completed: 2026-09-14*
