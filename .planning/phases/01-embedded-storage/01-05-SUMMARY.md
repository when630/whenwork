---
phase: 01-embedded-storage
plan: 05
subsystem: infra
tags: [electron, ipc, sqlite, store, refactor]

# Dependency graph
requires:
  - phase: 01-03
    provides: "main/queue.mjs replayPending, main/jobs.mjs replayQueueOnce, main/ipc.mjs saveCapture(ctx,title,context), ctx.pending"
  - phase: 01-04
    provides: "main/store.mjs 프로젝트 CRUD·항목 조작·getHistory·briefing 20개 함수"
provides:
  - "main/ipc.mjs — 살아남는 모든 핸들러가 ctx.store로 위임(itemOps·item:nudge/nudgeUndo/due·history:get·capture:projects)"
  - "main/ipc.mjs — 레거시 채널(issue:promote·project:repos·inbox:classify·item:doneSuggestMute·calendar:sync·backup:now·review:generate/openFile·resume:get/sync/generate)이 D-06 무해 스텁으로 등록 유지"
  - "main/jobs.mjs — replayQueueOnce·maybeBrief·purgeOnce 세 함수와 그 타이머만 남은 98줄 배경 작업 모듈"
  - "main/lifecycle.mjs — ctx.db(PostgreSQL) 생성 제거, 트레이 메뉴에서 수집·백업·주간리뷰 항목 제거, 설정 탭이 저장소 파일·상태를 보여줌"
  - "main/db.mjs — 코드베이스 어디에서도 부르지 않는 죽은 파일(삭제는 01-06)"
affects: [01-06, 01-07]

# Actuals (#2632)
actuals:
  tokens: 12315
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "review:get의 주(week) 라벨 계산을 main/ipc.mjs의 순수 함수(weekLabel)로 옮겨 main/jobs.mjs의 weekOf/주간리뷰 클러스터 전체 제거와 review:get 존속을 분리 — 두 관심사가 서로를 붙잡지 않게 함"
    - "D-06 레거시 스텁 — 채널은 삭제 없이 등록만 남기고 본문을 값 하나로 축소, 저장소·파일·프로세스 호출 없음"
    - "스모크 전용 데이터 시드 — SMOKE 모드에서 store에 프로젝트 하나(abbr 포함)를 미리 만들어 CAPTURE_PROBE가 외부(PostgreSQL) 실데이터 없이도 약어 인식을 검증하게 함"

key-files:
  created: []
  modified:
    - main/ipc.mjs
    - main/jobs.mjs
    - main/lifecycle.mjs
    - renderer/today.js

key-decisions:
  - "review:get이 필요로 하는 주(week) 라벨 계산을 main/jobs.mjs의 weekOf()에서 main/ipc.mjs의 지역 순수 함수(weekLabel)로 옮김 — weekOf는 주간 리뷰 생성 클러스터(makeWeeklyReview·maybeReview·reviewNotice)와 함께 전량 제거 대상이었는데, review:get이 그 중 라벨 계산 부분만 계속 필요로 해서 두 작업(Task 2의 완전 제거, Task 1의 review:get 존속)이 서로 부딪히지 않게 분리했다"
  - "settings:get이 쓰는 ctx.jobs.BACKUP_DIR_DEFAULT는 main/jobs.mjs에 상수로만 남김 — backupNow 자체는 D-06 스텁이지만 설정 화면의 '백업 폴더' 기본값 표시 형태는 Phase 2가 걷어낼 때까지 유지해야 해서(Task 1 action의 '나머지 키는 형태를 유지한다' 지시)"
  - "ctx.reviewing·ctx.generatingCards는 완전히 제거 — review:get이 이제 generating:false를 문자 그대로 반환하고 resume:* 세 채널이 전부 스텁이라 이 두 ctx 필드를 읽는 곳이 어디에도 남지 않았다"
  - "main/lifecycle.mjs의 ctx.db = createDb() 및 createDb import를 Task 2에서 제거 — main/jobs.mjs가 마지막 ctx.db 호출부(collectAll 등)를 걷어내는 순간 이 대입이 완전히 죽은 코드가 되므로, Task 1에서 남겨둔 상태를 Task 2가 이어서 정리했다(파일 자체 삭제는 01-06)"

patterns-established: []

requirements-completed: [STOR-01]

coverage:
  - id: D1
    description: "main/ipc.mjs의 itemOps 맵과 item:nudge/nudgeUndo/due, history:get, capture:projects가 전부 ctx.db 대신 ctx.store로 위임한다"
    requirement: "STOR-01"
    verification:
      - kind: unit
        ref: "npm test (219/219 pass, 변경 전과 동일)"
        status: pass
      - kind: other
        ref: "grep -rn 'ctx.db' main/ — 매치 없음(플랜 전체 종료 시점 기준)"
        status: pass
      - kind: automated_ui
        ref: "npm run smoke → SMOKE_OK"
        status: pass
    human_judgment: true
    rationale: "itemOps로 위임된 각 store 함수(completeItem·assignProject·nudgeItem 등)는 01-04의 단위 테스트로 이미 검증됐고, ipc.mjs의 위임 자체는 시그니처 대조와 스모크로 확인했다. 다만 실제 데스크톱에서 캡처·완료·프로젝트 생성·대기 전환·마감 지정을 눈으로 눌러보는 확인은 이 샌드박스(전역 단축키·트레이 미등록, 01-01~01-04 SUMMARY와 동일한 한계)에서 할 수 없다."
  - id: D2
    description: "레거시 채널(issue:promote·project:repos·inbox:classify·item:doneSuggestMute·calendar:sync·backup:now·review:generate·review:openFile·resume:get/sync/generate)이 삭제되지 않고 무해한 값만 돌려준다 — 저장소·파일·프로세스에 쓰지 않는다(D-06)"
    requirement: "STOR-01"
    verification:
      - kind: unit
        ref: "main/preload.cjs의 모든 invoke/send/on 채널을 main/ipc.mjs와 대조하는 스크립트 — push 이벤트 4건(capture:reset/today:refresh/card:done/today:openReview) 제외 전부 등록 확인, 채널 삭제 0건"
        status: pass
      - kind: automated_ui
        ref: "npm run smoke → SMOKE_OK (이슈·리뷰·프로젝트·설정 탭이 스텁 응답으로도 예외 없이 그려짐)"
        status: pass
    human_judgment: false
  - id: D3
    description: "settings:get이 PostgreSQL 접속 정보 대신 저장소(store.mjs) 파일 위치와 상태를 돌려주고, renderer/today.js의 설정 탭이 그 값을 보여준다"
    requirement: "STOR-01"
    verification:
      - kind: unit
        ref: "npm test (219/219) — settings:get을 직접 부르는 렌더러 단위 테스트는 없으나 view.js/브리핑 관련 회귀 테스트는 전부 유지"
        status: pass
      - kind: automated_ui
        ref: "npm run smoke → SMOKE_OK (설정 탭 렌더 경로 통과)"
        status: pass
    human_judgment: true
    rationale: "설정 탭에 실제로 그려지는 저장소 파일 경로·상태 문구의 시각적 확인은 사람이 데스크톱에서 한 번 보는 편이 안전하다(01-03 SUMMARY의 저장소 상태 문구와 같은 한계)."
  - id: D4
    description: "main/jobs.mjs에서 collectAll·prewarmCards·maybeBackup·maybeReview·maybeSuggestDone·withAiLog·makeWeeklyReview·reviewNotice·resumePayload·buildResumeCard·findProject·syncCalendarNow·todayEvents·backupNow가 전부 제거되고, replayQueueOnce·maybeBrief·purgeOnce 세 함수와 타이머 3개만 남는다(140줄 미만)"
    requirement: "STOR-01"
    verification:
      - kind: unit
        ref: "npm test (219/219 pass, 순수 모듈 테스트 test/brief.test.mjs·calendar.test.mjs·collect.test.mjs·repo.test.mjs·suggest.test.mjs·vault.test.mjs 80건 별도 재확인 포함, 통과 수 감소 없음)"
        status: pass
      - kind: other
        ref: "grep -rn 'collectAll|prewarmCards|maybeBackup|maybeReview|maybeSuggestDone' main/jobs.mjs main/lifecycle.mjs — 매치 없음. main/jobs.mjs 98줄(<140). node -e 스크립트로 setInterval|setTimeout 3개 확인"
        status: pass
    human_judgment: true
    rationale: "타이머가 실제로 며칠씩 돌지 않는지, 트레이 메뉴에서 git·gh·glab·claude 프로세스가 정말 하나도 뜨지 않는지는 실제 데스크톱에서 몇 분 띄워 두고 눈으로 확인해야 한다(플랜의 human-check 항목)."
  - id: D5
    description: "트레이 메뉴에서 '주간 리뷰 초안 만들기'·'지금 수집'·'지금 백업' 항목과 그 상태 줄(마지막 수집/백업/리뷰 실패)이 사라지고, 저장소 상태 한 줄만 남는다"
    requirement: "STOR-01"
    verification:
      - kind: other
        ref: "grep -n '지금 수집|지금 백업|주간 리뷰' main/lifecycle.mjs — 코드(메뉴 템플릿) 안에는 매치 없음(남은 매치는 무관한 주석 두 줄)"
        status: pass
    human_judgment: true
    rationale: "실제 트레이 아이콘의 컨텍스트 메뉴 모양은 이 샌드박스(트레이 미등록)에서 볼 수 없다."
---

# Phase 1 Plan 5: 런타임에서 PostgreSQL 위임 끊어내기 — IPC를 store로, 레거시는 스텁으로 Summary

**`main/ipc.mjs`의 모든 살아남는 핸들러(항목·프로젝트 CRUD, 재촉, 마감, 완료 이력, 약어 힌트)를 `ctx.store`로 위임하고, 이슈·재개 카드·주간 리뷰·캘린더·백업 같은 제거 대상 채널은 삭제 대신 무해한 스텁으로 내려앉혔으며, `main/jobs.mjs`의 배경 작업을 큐 반영·아침 브리핑·purge 세 개(471줄 → 98줄)로 줄여 `main/db.mjs`를 아무도 부르지 않는 죽은 파일로 만들었다.**

## Performance

- **Duration:** 약 17분 (직전 phase-plan 커밋 2026-09-15T09:51:08+09:00 ~ Task 2 커밋 2026-09-15T10:08:06+09:00)
- **Started:** 2026-09-15T00:54:00Z (근사)
- **Completed:** 2026-09-15T01:08:06Z
- **Tasks:** 2/2
- **Files modified:** 4 (`main/ipc.mjs`·`main/jobs.mjs`·`main/lifecycle.mjs`·`renderer/today.js`)

## Accomplishments
- `main/ipc.mjs` — itemOps 맵(완료/취소·프로젝트 배정·대기 전환·이름 변경·삭제/복구·메모·프로젝트 생성/수정/보관/순서)과 `item:nudge`·`item:nudgeUndo`·`item:due`·`history:get`·`capture:projects`(약어 힌트, `main/lifecycle.mjs`의 `refreshAbbrHints` 경유)가 전부 `ctx.store`로 위임(`ctx.store.` 호출 23곳)
- `issue:promote`·`project:repos`·`inbox:classify`·`item:doneSuggestMute`·`calendar:sync`·`backup:now`·`review:generate`·`review:openFile`·`resume:get`/`resume:sync`/`resume:generate`를 D-06 무해 스텁으로 전환 — 채널 등록은 그대로, 저장소·파일·프로세스에 아무것도 쓰지 않음. `resume:*` 셋은 원본 `resumePayload`와 같은 키(`card`·`fresh`·`activities`·`issues`·`promoted`·`generating`·`retryAfter`)를 유지해 재개 카드 화면이 깨지지 않음
- `review:get`은 순수 함수(`weekLabel`, `main/parse.mjs`의 `isoWeek`/`weekRange` 재사용)로 주 라벨만 계산하고 본문은 항상 `null` — 저장소도 db도 부르지 않음
- `settings:get`이 PostgreSQL 접속 정보(`host`/`port`/`database`/`online`) 대신 `store: { file, ok, notice }`를 반환, `main/lifecycle.mjs`의 `settings.json` `db` 설정 읽기 제거, `renderer/today.js` 설정 탭이 저장소 파일 경로·상태 한 줄을 보여줌
- `main/jobs.mjs`에서 git·이슈 수집(`collectAll`)·캘린더 동기화/오늘 일정 조회·SQL 덤프 백업(`backupNow`·`maybeBackup`)·주간 리뷰 생성(`makeWeeklyReview`·`maybeReview`·`reviewNotice`·`weekOf`)·재개 카드(`resumePayload`·`buildResumeCard`·`prewarmCards`·`findProject`)·완료 제안(`maybeSuggestDone`)·AI 호출 계량(`withAiLog`)과 각 타이머·상태 플래그를 전부 제거 — 남는 것은 `replayQueueOnce`(시작 시 1회)·`maybeBrief`(`ctx.store.briefing` 기반, 일정·리뷰 인자 없이)·`purgeOnce`(`ctx.store.purgeDeleted`) 셋과 타이머 3개뿐
- `main/lifecycle.mjs` — `ctx.db = createDb(...)`와 `import { createDb } from './db.mjs'` 제거, 트레이 메뉴에서 '주간 리뷰 초안 만들기'·'지금 수집'·'지금 백업' 항목과 마지막 수집/백업/리뷰 실패 상태 줄 제거(저장소 상태 한 줄만 남음)
- `npm test` 219/219(변경 없음, 순수 모듈 테스트 80건 개별 재확인 포함), `npm run smoke` → `SMOKE_OK` (capture=[] — 빈 저장소에서도 약어 인식 검증을 위해 SMOKE 모드에 시드 프로젝트 하나 추가)
- `main/` 전체에서 `ctx.db`·`main/db.mjs` 참조 0건, 실행 진입 체인(`index.mjs`→`lifecycle.mjs`→`ipc.mjs`/`jobs.mjs`) 어디에도 `pg`/`db.mjs` import 없음 — `main/db.mjs`는 이제 아무도 부르지 않는 죽은 파일(삭제는 01-06)

## Task Commits

Each task was committed atomically:

1. **Task 1: IPC 위임을 store로 갈아끼우고 레거시 채널을 스텁으로 내리기** - `b57f11d` (feat)
2. **Task 2: 레거시 백그라운드 작업과 트레이 메뉴 정리** - `a1b15d5` (refactor)

**Plan metadata:** (다음 커밋에서 추가 — 이 SUMMARY.md/STATE.md/ROADMAP.md/REQUIREMENTS.md)

## Files Created/Modified
- `main/ipc.mjs` (수정) - 살아남는 핸들러 store 위임, 레거시 채널 스텁화, `settings:get`/`review:get` 재작성
- `main/jobs.mjs` (수정, 471→98줄) - 제거 대상 배경 작업·타이머 전량 삭제, `replayQueueOnce`/`maybeBrief`/`purgeOnce`만 남김
- `main/lifecycle.mjs` (수정) - `ctx.db` 생성 제거, `refreshAbbrHints`를 store로 위임, 트레이 메뉴 정리
- `renderer/today.js` (수정) - 설정 탭이 저장소 파일·상태를 보여줌

## Decisions Made
- `review:get`이 필요로 하는 주(week) 라벨 계산을 `main/jobs.mjs`의 `weekOf()`에서 `main/ipc.mjs`의 지역 순수 함수(`weekLabel`)로 옮김 — `weekOf`는 원래 주간 리뷰 생성 클러스터와 함께 전량 제거 대상이었는데, `review:get`이 그 중 라벨 계산만 계속 필요로 해서 Task 2의 완전 제거와 Task 1의 `review:get` 존속이 서로 부딪히지 않게 분리했다
- `settings:get`이 쓰는 `ctx.jobs.BACKUP_DIR_DEFAULT`는 `main/jobs.mjs`에 상수로만 남김 — `backupNow` 자체는 스텁이지만 설정 화면 '백업 폴더' 기본값 표시 형태는 Phase 2가 걷어낼 때까지 유지
- `ctx.reviewing`·`ctx.generatingCards`는 완전히 제거 — 더 이상 어디서도 읽지 않는다(`review:get`은 `generating:false`를 문자 그대로 반환, `resume:*` 셋은 전부 스텁)
- SMOKE 모드에서 store에 프로젝트 하나(abbr `gw`)를 시드 — 예전에는 `capture:projects`가 실사용 PostgreSQL의 실제 프로젝트 데이터에 기대어 약어 인식을 검증했지만, 이제 빈 저장소가 정상 상태(D-05)라 외부 데이터 없이 같은 것을 검증하게 함

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] CAPTURE_PROBE가 빈 저장소에서 약어 목록을 가져오지 못해 SMOKE_FAIL로 판정되던 것을 수정**
- **Found during:** Task 1 (`npm run smoke` 1차 실행)
- **Issue:** `capture:projects`를 `ctx.store.getProjects()`로 위임하자 스모크의 새 저장소(SMOKE 격리 임시 디렉터리)가 완전히 비어 있어 `projects.length`가 끝까지 0으로 남았다. 예전에는 이 핸들러가 `ctx.db.getProjects()`(PostgreSQL)를 불렀고, 이 샌드박스에 실제로 살아 있는 PG 인스턴스의 기존 프로젝트(`gw` 등 실제 도그푸딩 데이터)가 있어 우연히 통과하고 있었다 — Docker 없이 동작해야 한다는 이 페이즈의 목적과 정면으로 맞부딪히는 테스트 설계였다
- **Fix:** `main/lifecycle.mjs`의 `bootstrap()`에 SMOKE 전용 시드(프로젝트 하나 생성 + `abbr: 'gw'` 지정)를 추가해, 외부 실데이터 없이도 CAPTURE_PROBE가 같은 것(약어 인식)을 검증하게 했다
- **Files modified:** main/lifecycle.mjs
- **Verification:** `npm run smoke` → `SMOKE_OK`, capture=[] (이전 `["약어 목록을 가져오지 못했다..."]`에서 개선). `npm test` 219/219 영향 없음
- **Committed in:** b57f11d (Task 1 커밋)

**2. [Rule 3 - Blocking] Task 1 종료 시점의 `! grep -rn "ctx.db" main/` acceptance criteria가 main/jobs.mjs(Task 2 소관)에서 불가피하게 계속 매치되는 것을 확인하고 Task 2로 이어 해소**
- **Found during:** Task 1 acceptance criteria 검증
- **Issue:** Task 1의 파일 범위는 `main/ipc.mjs`·`main/lifecycle.mjs`·`renderer/today.js`뿐이라 `main/jobs.mjs`(Task 2가 다룰 `collectAll`·`makeWeeklyReview` 등 20여 개 `ctx.db` 호출)를 건드릴 수 없었다. `ctx.db = createDb()` 자체도 `main/jobs.mjs`가 아직 `ctx.db`를 필요로 하는 한 `main/lifecycle.mjs`에 남아 있어야 했으므로, Task 1 종료 시점에는 이 acceptance criteria가 문자 그대로는 통과할 수 없었다(01-01 SUMMARY의 "Not Satisfied As Literally Written"과 같은 성격의 시퀀싱 문제)
- **Fix:** Task 1에서는 `main/ipc.mjs`·`main/lifecycle.mjs`(capture:projects 경로)의 `ctx.db` 호출만 전부 제거하고 `ctx.db = createDb()` 자체는 남겨 두었다. Task 2가 `main/jobs.mjs`의 관련 함수를 전량 제거한 직후, 같은 Task 2 안에서 `main/lifecycle.mjs`의 `ctx.db = createDb()`와 `import { createDb } from './db.mjs'`도 함께 제거해 플랜 종료 시점에는 `grep -rn "ctx.db" main/`이 완전히 빈 결과를 내게 했다
- **Files modified:** main/lifecycle.mjs (Task 1에서 일부, Task 2에서 완료), main/jobs.mjs (Task 2)
- **Verification:** 플랜 종료 시점 `grep -rn "ctx.db" main/` — 매치 없음(위 확인)
- **Committed in:** b57f11d (Task 1, 부분), a1b15d5 (Task 2, 완료)

**3. [Rule 1 - Bug] main/lifecycle.mjs의 stale 주석이 Task 2 acceptance criteria(banned-name grep)를 스스로 걸리게 한 것을 수정**
- **Found during:** Task 2 acceptance criteria 재확인 (`grep -rn "collectAll|prewarmCards|maybeBackup|maybeReview|maybeSuggestDone" main/jobs.mjs main/lifecycle.mjs`)
- **Issue:** `bootstrap()` 위에 01-01 시절 남은 주석("Task 1(이 커밋) 시점에는 백그라운드 작업(flush·collectAll·maybeBrief 등)과...")이 `collectAll` 문자열을 그대로 담고 있어, 실제 코드에는 없는데도 grep이 걸렸다
- **Fix:** 더 이상 사실과 맞지 않는(이미 오래전에 끝난 브릿지를 설명하는) 주석을 지금 구조를 설명하는 문구로 교체
- **Files modified:** main/lifecycle.mjs
- **Verification:** `grep -rn "collectAll|prewarmCards|maybeBackup|maybeReview|maybeSuggestDone" main/jobs.mjs main/lifecycle.mjs` — 매치 없음
- **Committed in:** a1b15d5 (Task 2 커밋)

---

**Total deviations:** 3 auto-fixed (1 bug — 스모크 시드 없이는 통과 불가능한 테스트 설계, 1 blocking — 두 태스크에 걸친 acceptance criteria 시퀀싱, 1 bug — 자기 자신을 걸리게 한 stale 주석)
**Impact on plan:** 전부 D-05/D-06("Docker 없이 동작", "레거시는 무해한 스텁")의 취지를 정확히 지키기 위한 수정이며 스코프 크리프 없음. 특히 1번은 이 페이즈의 핵심 목적(외부 데이터 의존 제거)과 정확히 같은 방향의 수정이다.

## Issues Encountered
None beyond the deviations documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `main/db.mjs`를 부르는 곳이 코드베이스 어디에도 없다 — 01-06이 `main/db.mjs`·`main/backup.mjs`·`test/backup.test.mjs` 삭제와 `pg`의 `devDependencies` 이동을 안전하게 진행할 수 있다
- `main/jobs.mjs`(98줄)·`main/ipc.mjs`가 전부 store 경계 뒤에서만 움직이므로, Phase 2의 레거시 UI·스텁 제거 작업은 "이 채널을 지운다"는 국소적인 작업으로 좁혀진다
- 이 샌드박스는 전역 단축키·트레이가 등록되지 않고(01-01~01-04 SUMMARY와 동일한 한계) 실제 PostgreSQL 인스턴스가 (뜻밖에도) 살아 있어 이전 플랜들의 스모크가 그 실데이터에 우연히 의존하고 있었다 — 이번 플랜에서 그 의존을 걷어냈으니, 실제 Windows 데스크톱에서 한 번 더 다음을 확인하는 것을 권한다: (1) 트레이 메뉴에 수집·백업·주간 리뷰 항목이 없고 git·gh·glab·claude 프로세스가 뜨지 않는지, (2) 아침 브리핑 시각을 방금 지난 시각으로 바꿨을 때 알림이 뜨는지, (3) Docker/PostgreSQL을 완전히 끈 상태에서 캡처·완료·프로젝트 생성·대기 전환·마감 지정이 전부 동작하는지
- 블로커 없음

## Self-Check: PASSED

- FOUND: main/ipc.mjs, main/jobs.mjs, main/lifecycle.mjs, renderer/today.js
- FOUND commit: b57f11d, a1b15d5
- Re-ran plan-level `<verification>`: `npm test` exit 0 (219/219, 통과 수 유지 — 순수 모듈 테스트 80건 개별 재확인 포함), `npm run smoke` 출력에 `SMOKE_OK` 포함(capture=[]), `grep -rn "ctx.db" main/` 매치 없음, `grep -rln "from './db.mjs'"  main/` 매치 없음, `main/jobs.mjs` 98줄(<140), `node -e` 스크립트로 `setInterval|setTimeout` 3개 확인, 트레이 메뉴 템플릿(코드)에 '지금 수집'·'지금 백업'·'주간 리뷰 초안 만들기' 없음
- `plan_head_before: 2dbec7a44f47d9214c670a55a46e675e39ebcdb1`, `commits: 2` (측정: `git rev-list --count 2dbec7a..HEAD`)

---
*Phase: 01-embedded-storage*
*Completed: 2026-09-15*
