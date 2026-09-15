---
phase: 01-embedded-storage
plan: 07
subsystem: testing
tags: [electron, sqlite, crash-recovery, smoke, node-test]

# Dependency graph
requires:
  - phase: 01-03
    provides: "main/queue.mjs replayPending, main/jobs.mjs replayQueueOnce(!SMOKE 가드 밖에서 1회 호출), main/ipc.mjs saveCapture(ctx,title,context)"
provides:
  - "--smoke의 캡처 주입 서브모드(--inject-capture=<title>, --smoke-data=<dir>) — 실제 saveCapture 경로를 밟아 CAPTURE_INJECTED <id>를 찍고 스스로 종료하지 않는다"
  - "saveCapture 반환값의 id 필드"
  - "SMOKE_PROBE 반환의 inbox 필드(오늘 뷰 인박스 제목 배열)"
  - "test/capture-crash-smoke.test.mjs — 두 프로세스 수명에 걸친 STOR-03 강제종료 내구성 자동 테스트"
  - "npm run smoke:crash 스크립트"
affects: []

# Actuals (#2632)
actuals:
  tokens: 2588
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "두 프로세스 수명에 걸친 강제종료 하네스 — 실제 Electron 프로세스(electron 패키지가 내보내는 바이너리 경로)를 spawn하고 SIGKILL로 죽인 뒤 같은 --smoke-data로 재기동해 오늘 뷰 상태를 검사"
    - "--smoke 서브모드 분기(SMOKE && INJECT_CAPTURE) — 기존 --smoke 프로브 경로(REL-05가 의존)를 건드리지 않고 별도 분기로 얹음"

key-files:
  created:
    - test/capture-crash-smoke.test.mjs
  modified:
    - main/lifecycle.mjs
    - main/ipc.mjs
    - package.json

key-decisions:
  - "Task 2의 RED 단계는 '스킵-with-reason'으로 처리했다 — Task 1이 이미 --inject-capture/CAPTURE_INJECTED/saveCapture의 큐+저장소 동기 이중 기록을 구현해 두어서, 테스트 파일을 쓰는 순간 이미 통과한다(인위적으로 실패를 조작하지 않았다). 대신 프로젝트 제약(고친 코드를 되돌려 실패를 확인)에 따라 별도의 되돌리기 확인 (a)(b)로 실제 실패 증거를 만들었다(아래 서술)"
  - "되돌리기 확인에서 '직후'의 진짜 위험 구간(큐 append 이후·저장소 삽입 완료 이전)은 saveCapture가 완전히 동기이고 CAPTURE_INJECTED가 그 함수가 반환한 뒤에만 찍히므로, 커밋된 테스트의 '로그 본 뒤 죽이기' 방식으로는 절대 재현되지 않는다는 것을 확인했다 — RESEARCH가 이미 예견한 대로(강제종료 스모크 하네스 설계 스케치), 그 구간을 들여다보려면 저장소 삽입 직전에 인위적 지연을 넣어 창을 벌려야 했다(플랜 Task 2 action 문구 그대로). 이 지연은 되돌리기 확인 전용 임시 코드이며 커밋되지 않았다"
  - "saveCapture(ctx, title, context) 시그니처는 그대로 두고 반환 객체에 id만 추가 — 기존 capture:save/capture:followUp 호출부는 추가 필드를 무시하므로 회귀 없음"

patterns-established:
  - "Pattern: --smoke 서브모드 분기(if (SMOKE && INJECT_CAPTURE) {...} else if (SMOKE) {...}) — 이후 페이즈가 또 다른 두 프로세스 시나리오가 필요하면 같은 형태로 얹을 수 있다"

requirements-completed: [STOR-03]

coverage:
  - id: D1
    description: "--smoke에 --smoke-data=<dir>(userData 격리 경로 지정)와 --inject-capture=<title>(진짜 saveCapture 경로로 캡처 후 CAPTURE_INJECTED <id>를 찍고 종료하지 않음) 서브모드를 더했다. 기존 --smoke 프로브 경로는 그대로다"
    requirement: "STOR-03"
    verification:
      - kind: automated_ui
        ref: "npm run smoke → SMOKE_OK, renderer= JSON에 inbox 키 포함"
        status: pass
      - kind: e2e
        ref: "test/capture-crash-smoke.test.mjs#캡처 직후 강제 종료해도 재기동 시 그 캡처가 오늘 뷰 인박스에 있다"
        status: pass
    human_judgment: false
  - id: D2
    description: "test/capture-crash-smoke.test.mjs — 실제 Electron 프로세스를 --smoke --inject-capture로 띄워 캡처하고 SIGKILL로 강제 종료한 뒤 같은 --smoke-data로 재기동해 오늘 뷰 인박스에서 그 캡처를 찾는다. OS 분기 없음(child.kill('SIGKILL') 한 줄). npm run smoke:crash로 실행되고 파일명이 기존 글롭에 맞아 npm test에도 포함된다"
    requirement: "STOR-03"
    verification:
      - kind: e2e
        ref: "npm run smoke:crash (1/1 pass)"
        status: pass
      - kind: unit
        ref: "npm test (206/206 pass, 이 테스트 포함)"
        status: pass
    human_judgment: false
  - id: D3
    description: "되돌리기 확인 두 건 — (a) saveCapture에서 큐 append를 빼고 저장소 삽입 직전에 지연을 두면 그 창에서 죽였을 때 캡처가 완전히 유실됨을 관찰. (b) main/jobs.mjs의 시작 시 큐 반영(replayQueueOnce) 호출을 지우고 같은 창에서 죽이면 큐에는 남아도(pending=1) 저장소·오늘 뷰에는 끝내 반영되지 않음을 관찰. 둘 다 원복 후 npm test 206/206·npm run smoke SMOKE_OK로 재확인"
    requirement: "STOR-03"
    verification: []
    human_judgment: true
    rationale: "임시 코드 변경(지연 삽입, 호출 제거)으로 관찰한 일회성 실험이라 영구 테스트로 남아 있지 않다 — 관찰 결과와 재현 절차를 아래 '되돌리기 확인' 섹션에 스크립트 출력과 함께 기록했으니, 이 기록이 실제로 그 실패를 만들어냈는지는 이 SUMMARY의 서술을 사람이 한 번 읽고 판단하는 편이 안전하다."
  - id: D4
    description: "macOS 미검증 — 이 페이즈는 Windows 통과를 완료 기준으로 삼는다. D-04가 요구하는 '두 OS에서 돈다'의 macOS 쪽은 실기기가 없어 검증 불가하고 Phase 4/5의 실기기 확보 시점으로 넘긴다"
    verification: []
    human_judgment: true
    rationale: "macOS 실기기가 없어 이 세션에서 검증 자체가 불가능하다(RESEARCH `## Environment Availability`와 STATE.md Blockers/Concerns가 이미 기록한 갭). 실기기 확보 후 사람이 `npm run smoke:crash`를 그 기기에서 한 번 돌려야 한다."

duration: 6min
completed: 2026-09-15
status: complete
---

# Phase 1 Plan 7: 강제종료 캡처 유실 방지 자동 테스트 Summary

**`--smoke`에 실제 `saveCapture` 경로를 밟는 캡처 주입 서브모드(`--inject-capture`/`--smoke-data`)를 더하고, 그 위에 두 프로세스 수명에 걸친 `test/capture-crash-smoke.test.mjs`(SIGKILL 강제종료 → 재기동 → 오늘 뷰 인박스 확인)를 얹어 STOR-03("캡처 직후 강제 종료해도 유실 없음")을 자동 재현 테스트로 증명했다.**

## Performance

- **Duration:** 약 6분 (Task 1 커밋 2026-09-15T10:28:05+09:00 ~ Task 2 커밋 2026-09-15T10:34:11+09:00)
- **Started:** 2026-09-15T10:28:05+09:00
- **Completed:** 2026-09-15T10:34:11+09:00
- **Tasks:** 2/2
- **Files modified:** 4 (`main/lifecycle.mjs`, `main/ipc.mjs`, `test/capture-crash-smoke.test.mjs`(신규), `package.json`)

## Accomplishments
- `main/lifecycle.mjs` — `--smoke-data=<dir>`(SMOKE 모드의 userData 격리 경로 지정, 없으면 기존처럼 `temp/whenwork-smoke` 고정 경로)와 `--inject-capture=<title>`(둘 다 `--smoke`와 함께일 때만 의미가 있고, 기존 `--smoke` 단독 동작은 그대로다 — REL-05가 의존하는 경로 무사) 두 플래그를 더했다. 주입 서브모드는 `scheduleJobs(ctx)`(시작 시 1회 큐 반영 포함)가 끝난 뒤 `saveCapture(ctx, title, null)`을 불러 진짜 캡처 경로로 한 건을 저장하고 `CAPTURE_INJECTED <id>`를 찍은 뒤, 창을 만들지도 프로브를 돌리지도 스스로 종료하지도 않는다(밖에서 SIGKILL로 죽이는 것이 요점)
- `main/ipc.mjs` — `saveCapture`의 반환 객체에 `id`(entry.id) 필드를 추가. 기존 `capture:save`/`capture:followUp` 호출부는 이 필드를 무시하므로 회귀 없음
- `main/lifecycle.mjs`의 `SMOKE_PROBE` 반환에 `inbox`(렌더러 `state.inbox`의 제목 배열, `typeof`/`&&` 가드) 필드를 추가 — 재기동 후 오늘 뷰 상태에서 캡처 존재를 확인하는 창. 템플릿 리터럴 안에 `${...}` 보간을 쓰지 않았다(grep으로 확인)
- `test/capture-crash-smoke.test.mjs`(신규) — `electron` 패키지가 내보내는 실행 파일 경로로 실제 Electron 프로세스를 두 번 spawn한다: 1차는 `--smoke --smoke-data=<mkdtempSync 폴더> --inject-capture=<표식>`으로 띄워 `CAPTURE_INJECTED`를 기다린 뒤 `child.kill('SIGKILL')`(OS 분기 없음, `process.platform`/`taskkill` 미사용) → `exit` 대기, 2차는 같은 `--smoke-data`로 `--smoke`만 주고 띄워 `SMOKE_OK`의 `renderer=` JSON `inbox` 배열에 표식이 있는지 단언한다. 타임아웃(60초)마다 자식을 죽이고 누적 stdout·stderr를 실패 메시지에 담는다. `finally`에서 남은 자식을 정리하고 임시 폴더를 지운다
- `package.json`에 `smoke:crash` 스크립트 추가(`node --test test/capture-crash-smoke.test.mjs`) — 파일명이 `test/**/*.test.mjs` 글롭에 맞아 `npm test`에도 자동 포함된다
- `npm run smoke:crash` 1/1 pass, `npm test` 206/206(기존 205 + 신규 1), `npm run smoke` → `SMOKE_OK`(renderer JSON에 `inbox` 키 포함)

## Task Commits

Task 1은 `type="auto"`(TDD 아님), Task 2는 `tdd="true"`이지만 RED가 스킵-with-reason이라 단일 커밋입니다(아래 "TDD Gate Compliance" 참고):

1. **Task 1: --smoke에 캡처 주입 서브모드와 데이터 폴더 지정 더하기** - `2190e78` (feat)
2. **Task 2: 두 프로세스 강제종료 하네스 작성** - `51789eb` (test)

**Plan metadata:** (다음 커밋에서 추가 — 이 SUMMARY.md/STATE.md/ROADMAP.md/REQUIREMENTS.md)

## Files Created/Modified
- `main/lifecycle.mjs` (수정) - `--smoke-data`/`--inject-capture` 플래그, 주입 분기, `SMOKE_PROBE`의 `inbox` 필드
- `main/ipc.mjs` (수정) - `saveCapture` 반환에 `id` 추가
- `test/capture-crash-smoke.test.mjs` (신규, 124줄) - 두 프로세스 강제종료 내구성 테스트
- `package.json` (수정) - `smoke:crash` 스크립트

## Decisions Made
- Task 2의 RED 단계를 '스킵-with-reason'으로 처리 — 이유와 근거는 위 key-decisions 참고
- 되돌리기 확인에서 "직후"의 진짜 위험 구간은 saveCapture가 완전 동기이고 CAPTURE_INJECTED가 반환 후에만 찍히므로 커밋된 테스트의 방식으로는 재현되지 않는다는 것을 확인 — RESEARCH가 예견한 대로 저장소 삽입 직전 인위적 지연이 필요했다(임시 코드, 미커밋)
- saveCapture 시그니처는 그대로 두고 반환 객체에 id만 추가

## Deviations from Plan

None - plan executed exactly as written. (플랜의 Claude's Discretion 영역 — 커밋 형태·RED 스킵 근거 문서화 방식 — 은 위 key-decisions로 명시했지만 규칙 1~4에 해당하는 자동 수정은 없었다.)

## TDD Gate Compliance

Task 2는 `tdd="true"`였지만, 이 플랜의 실행 지침(`execution_context`)이 명시적으로 허용한 대로 RED 단계를 "스킵-with-reason" 처리했습니다:

- **왜 고전적 RED가 불가능했나:** Task 1(이 플랜의 앞선 `type="auto"` 태스크)이 `--inject-capture`/`CAPTURE_INJECTED`/`saveCapture`의 큐+저장소 동기 이중 기록을 이미 구현했습니다. `test/capture-crash-smoke.test.mjs`를 작성한 순간 그 아래 기능이 이미 완비되어 있어, 테스트를 먼저 커밋해도 즉시 통과합니다(`npm run smoke:crash` 1/1 pass, 첫 실행부터). 실패를 관찰하려고 기능을 깎아내는 것은 이미 완성된 프로덕션 코드를 역행하는 것이라 의미가 없었습니다.
- **실제 커밋 패턴:** `feat(01-07): ...`(Task 1, `2190e78`)가 `test(01-07): ...`(Task 2, `51789eb`)보다 먼저 있습니다 — 고전적 RED→GREEN의 시간 순서와 반대입니다. `gsd_run check tdd-red-evidence`는 호출하지 않았습니다(투입할 실패 증거 자체가 없었기 때문 — 인위적으로 실패를 조작하면 오히려 #3770 INVALID_RED에 해당했을 것입니다).
- **대체 증거:** 프로젝트 CLAUDE.md 제약("새로 넣는 스모크·테스트는 고친 코드를 되돌려 실패를 확인한다")에 따라, 커밋된 테스트 대신 두 가지 임시 코드 변경 + 재현 스크립트로 실제 실패를 관찰했습니다(아래 "되돌리기 확인" 참고). 이것이 이 플랜이 요구하는 실질적 RED-등가 증거입니다.

## 되돌리기 확인 (프로젝트 CLAUDE.md 제약 + Task 2 acceptance criteria)

두 가지 핵심 보증이 실제로 코드에 의존하는지 각각 되돌려(임시 수정) 실패를 관찰한 뒤 원복했습니다. 두 실험 모두 스크래치 스크립트로 재현했으며 커밋되지 않았습니다.

**(a) `saveCapture`에서 `ctx.queue.append(entry)`를 빼고, 저장소 삽입 직전에 3초 바쁜대기(busy-wait)를 넣어 창을 벌림.** 스크래치 스크립트가 1차 프로세스를 spawn하고 1초 뒤(지연 창 안, `CAPTURE_INJECTED`가 뜨기 전) `SIGKILL`로 죽였습니다. 관찰: `CAPTURE_INJECTED`는 찍히지 않았고(창 안에서 죽음이 확인됨), 재기동한 2차 프로세스의 `renderer.inbox`에 표식이 **없었습니다**(`marker found: false`) — 큐 선기록이 없으면 이 창에서 죽을 때 캡처가 완전히 유실됨을 확인했습니다. 원복 후 `git diff main/ipc.mjs`가 비어 있음을 확인하고 `npm test` 206/206 재확인.

**(b) `main/jobs.mjs`의 `replayQueueOnce()` 호출(시작 시 1회 큐 반영)을 지우고, `saveCapture`에서 큐 append는 그대로 둔 채 저장소 삽입 직전에 같은 3초 지연을 넣음.** 1초 뒤 죽여 큐에는 표식이 남았지만(`queue.jsonl`에 표식 확인, `queue has marker: true`) 저장소 삽입은 일어나지 않은 상태를 만들었습니다. 재기동한 2차 프로세스는 `pending=1`(큐에 남은 대기 건수)을 보고했지만 `replayQueueOnce`가 빠져 있어 그 대기분을 저장소로 옮기지 못했고, `renderer.inbox`에도 표식이 **없었습니다**(`marker found: false`) — 시작 시 큐 반영이 빠지면 큐에는 남아도 오늘 뷰에는 끝내 나타나지 않음을 확인했습니다. 원복 후 `git diff main/ipc.mjs main/jobs.mjs`가 비어 있음을 확인하고 `npm test` 206/206·`npm run smoke` `SMOKE_OK`·`npm run smoke:crash` 1/1 pass로 재확인.

두 실험 모두 임시 수정이 정확히 의도한 지점에서만 실패를 만들어냈고(다른 205개 테스트는 영향 없음), 원복 후 전체 스위트가 깨끗하게 복구됨을 확인했습니다.

## macOS 미검증 갭

이 페이즈는 Windows 통과를 완료 기준으로 삼습니다. D-04가 요구하는 "두 OS 빌드에서 돈다"의 macOS 쪽은 이 세션에 실기기가 없어 검증이 불가능합니다(RESEARCH `## Environment Availability`, STATE.md Blockers/Concerns가 이미 동일하게 기록). macOS 실기기를 확보하면 그 기기에서 같은 `npm run smoke:crash`를 한 번 더 돌려야 합니다 — Phase 4/5(REL-05)가 이어받습니다.

## Issues Encountered
None beyond the RED-skip and revert-check documentation above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- STOR-01~05가 모두 이 페이즈에서 자동 테스트로 증명되었다 — Phase 1(내장 저장소 전환)의 모든 계획(01-01~01-07)이 완료되었다
- macOS 실기기 확보 전까지는 `smoke:crash`의 macOS 쪽 검증이 미뤄져 있다 — Phase 4(플랫폼 분기)·Phase 5(릴리스)가 이 갭을 이어받아야 한다
- 블로커 없음

## Self-Check: PASSED

- FOUND: main/lifecycle.mjs, main/ipc.mjs, test/capture-crash-smoke.test.mjs, package.json
- FOUND commit: 2190e78, 51789eb
- Re-ran plan-level `<verification>`: `npm run smoke:crash` exit 0 (1/1 pass), `npm test` exit 0 (206/206), `npm run smoke` 출력에 `SMOKE_OK` 포함(`inbox` 키 포함), 되돌리기 확인 (a)(b) 실패 관찰 기록 위 서술, macOS 미검증 갭 위 서술
- `plan_head_before: 3dba9cccd1a75d2fae3c8be36435a68a19c20478`, `commits: 2` (측정: `git rev-list --count 3dba9cc..HEAD`)

---
*Phase: 01-embedded-storage*
*Completed: 2026-09-15*
