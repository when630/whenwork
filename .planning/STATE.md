---
gsd_state_version: "1.0"
current_phase: 01
current_phase_name: 내장 저장소 전환
status: verifying
stopped_at: Completed 01-07-PLAN.md
last_updated: "2026-09-15T01:36:28.685Z"
last_activity: 2026-09-14
last_activity_desc: Phase 01 execution started
state_head: 51789eb85c873f75958f104701dc0be20f7a007d
progress:
  total_phases: 5
  completed_phases: 0
  total_plans: 7
  completed_plans: 7
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-09-14)

**Core value:** 설치 파일 하나를 받아 실행한 사람이, 다른 것을 아무것도 깔지 않고, 단축키로 던진 할 일을 절대 잃지 않는다.
**Current focus:** Phase 01 — 내장 저장소 전환

## Current Position

Phase: 01 (내장 저장소 전환) — EXECUTING
Plan: 7 of 7
Status: Phase complete — ready for verification
Last activity: 2026-09-14 — Phase 01 execution started

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: - min
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: -
- Trend: -

*Updated after each plan completion*
**Per-Plan Metrics:**

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 01 P01 | 54 min | 3 tasks | 4 files |
| Phase 01 P02 | 12 min | 2 tasks | 4 files |
| Phase 01 P03 | 12min | 3 tasks | 7 files |
| Phase 01 P04 | 3min | 2 tasks | 2 files |
| Phase 01 P05 | 17min | 2 tasks | 4 files |
| Phase 01 P01-06 | 7min | 2 tasks | 7 files |
| Phase 01 P07 | 6min | 2 tasks | 4 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Phase 1]: 저장소는 PostgreSQL·Docker 대신 node:sqlite로 교체하고, API가 부족하면 같은 store.mjs 경계 뒤에서 better-sqlite3로 대체 (연구 요약)
- [Phase 1]: main/index.mjs 구조 정리(lifecycle/ipc/jobs 분리)를 저장소 교체보다 먼저 하는 순수 리팩터로 진행 (연구 요약, 안전망으로 기존 테스트 활용)
- [Phase 2]: 제거 대상 모듈은 새 저장소 스키마에 테이블을 아예 만들지 않는 방식으로, 이전 스크립트가 죽은 테이블을 신경 쓰지 않게 한다
- [Phase 5]: 공개 리포는 새 저장소·새 히스토리로 시작(캘린더 웹훅 토큰 등 개인 이력 분리)
- [Phase 01]: main/index.mjs 1479줄을 lifecycle/jobs/ipc 3파일로 D-08 그대로 분할 — 저장소 교체(01-02)보다 먼저, 별도 커밋으로
- [Phase 01]: index.mjs가 아직 옮기지 않은 코드가 lifecycle.mjs/jobs.mjs 함수를 불러야 할 때는 ctx 필드로 다리를 놓고 다음 태스크에서 정리 — 태스크마다 npm test/smoke로 분할 전과 동일함을 확인
- [Phase 01]: reviewing/generatingCards/lastCalendarError는 여러 파일이 함께 읽고 써야 해서 jobs.mjs 클로저 대신 ctx 필드로 둠
- [Phase 01]: 01-02: v1 스키마 lean 채택 — 인덱스 최소, 외래키 강제 끔, event.id 정수 autoincrement — PG 스키마와 같은 보장 수준, Phase 3 이전 스크립트가 삽입 순서를 신경 쓰지 않아도 됨, 프로젝트는 archive만 하고 삭제 않는 설계에서 외래키 강제 이득 작음
- [Phase 01]: 01-02: open()의 손상/newer/그 외 오류 판정을 하나의 경계로 통합해 되돌리기 확인이 실제로 유효하도록 재구성 — construction 실패를 무조건 non-corrupt로 하드코딩하면 잠김 테스트가 isCorruptError를 거치지 않아 되돌리기 확인이 무의미해짐
- [Phase 01]: [Phase 01] 01-03: main/jobs.mjs의 옛 ctx.queue.drain 호출부를 Task 1에서 replayPending으로 최소 수정 — Task 1 acceptance criteria(grep)가 main/ 전체를 검사해 방치하면 통과 불가능했고, 실제로도 없는 함수를 부르는 런타임 버그였다. flush() 전체 재작성은 계획대로 Task 2가 맡았다
- [Phase 01]: [Phase 01] 01-03: capture:save/capture:followUp을 saveCapture(ctx,title,context)로 통합하며 followUp도 parseCaptureToken을 거치게 됨 — D-01의 두 경로가 같다는 원칙을 그대로 따른 결과(회귀 아님)
- [Phase 01]: [Phase 01] 01-03: ctx.pending은 이번 세션에서 즉시 반영에 실패한 캡처 수로 한정 — 큐 파일 줄 수와는 분리한다(D-02, 큐는 실행 중 append-only라 성공한 캡처까지 쌓인다)
- [Phase 01]: [Phase 01] 01-04: getProjects()는 신설한 독립 함수이며, 01-02가 getViewState() 안에 이미 인라인해 둔 프로젝트 조회(정렬 기준 다름: sort,name)는 그대로 둠 — 기존 통과 테스트를 건드리지 않는 최소 변경 범위 판단
- [Phase 01]: [Phase 01] 01-04: briefing()의 oldest_todo_days는 MIN(captured_at) FILTER 대신 ORDER BY captured_at ASC LIMIT 1로 가져와 JS에서 날수 계산 — count(*) FILTER만 research_resolution이 확인했으므로 다른 집계 함수의 FILTER 지원 불확실성을 피함
- [Phase 01]: D1: review:get의 주 라벨 계산을 jobs.mjs의 weekOf에서 ipc.mjs의 지역 순수 함수(weekLabel)로 옮김 — 주간 리뷰 클러스터 전량 제거(Task 2)와 review:get 존속(Task 1)이 서로 부딪히지 않게 분리
- [Phase 01]: D2: 레거시 IPC 채널(issue/resume/review/calendar/backup/inbox 등)은 삭제 대신 D-06 무해 스텁으로 전환 — 저장소·파일·프로세스에 아무것도 쓰지 않음
- [Phase 01]: D3: main/jobs.mjs에서 collectAll·backupNow·makeWeeklyReview·resumePayload·maybeSuggestDone 등 제거 대상 배경 작업과 타이머를 전량 삭제(471→98줄), replayQueueOnce·maybeBrief·purgeOnce만 남김
- [Phase 01]: D4: main/ 어디에서도 ctx.db·main/db.mjs를 부르지 않게 됨 — main/db.mjs는 이제 아무도 부르지 않는 죽은 파일(삭제는 01-06)
- [Phase 01]: main/db.mjs·main/backup.mjs·test/backup.test.mjs 삭제, pg를 devDependencies로 격하(D-05/D-07/D-09) — 두 저장소가 공존하는 기간을 두지 않는다는 D-05 one-way 결정을 실행. STOR-05 가드는 이미 test/store.test.mjs로 이관되어 있어 안전하게 삭제. electron-builder는 devDependencies를 패키징하지 않아 pg가 설치본에 실리지 않음
- [Phase 01]: v-personal 태그를 두 지점(both)에 나눠 생성 — v-personal(98c17e3, 페이즈 시작 직전)과 v-personal-lastmix(d9416cc, 삭제 직전 HEAD) — 사용자 결정: 돌아갈 지점과 비교할 지점을 분리해 둘 다 잃지 않는다. Phase 5 공개 리포 분리 때 무엇을 남길지 한 번 정한다
- [Phase 01]: [Phase 01] 01-07: Task 2의 RED을 스킵-with-reason 처리 — Task 1이 이미 주입 서브모드(--inject-capture/CAPTURE_INJECTED/saveCapture 동기 이중 기록)를 구현해 테스트가 작성 즉시 통과하므로 인위적 RED을 조작하지 않고, 대신 되돌리기 확인 (a)(b)로 실제 실패 증거를 만들었다
- [Phase 01]: [Phase 01] 01-07: '캡처 직후'의 진짜 위험 구간(큐 append 이후·저장소 삽입 완료 이전)은 saveCapture가 완전 동기라 커밋된 테스트의 '로그 본 뒤 죽이기' 방식으로는 재현되지 않는다 — 되돌리기 확인에서는 저장소 삽입 직전에 임시 지연을 넣어 창을 벌렸다(미커밋)
- [Phase 01]: [Phase 01] 01-07: macOS 미검증 갭을 STOR-03 완료 기준에서 제외하고 Phase 4/5로 이관 — 실기기 부재는 기존 STATE.md Blockers/Concerns와 동일한 한계

### Pending Todos

None yet.

### Blockers/Concerns

- [Phase 1] node:sqlite는 Node 24 기준 RC 단계 API — 프라그마·트랜잭션·동시 접근이 기존 쿼리 패턴을 충분히 커버하는지 스파이크로 먼저 확인 필요 (research/SUMMARY.md 참고)
- [Phase 1] 큐 drain의 읽기-쓰기 사이 경합(main/queue.mjs)은 저장소 교체로 자동 해결되지 않음 — 원자적 교체(rename)로 명시적으로 재설계하고 강제 종료 테스트로 검증해야 함
- [Phase 4] macOS 실기기 미확보 상태 — Accessibility 권한, globalShortcut 조용한 실패 여부, 미서명 로그인 항목 동작은 실기기 확보 전까지 검증 불가
- [Phase 5] 공개 전 git 이력에 남은 캘린더 웹훅 토큰 스캔 필요 — 새 히스토리로 시작하는 결정과 별개로 확인 필요
- 설정 파일(settings.json)을 PowerShell로 쓰면 BOM이 붙어 앱이 빈 설정으로 시작함 — 이전 스크립트·문서 갱신 작업은 Node로 쓸 것

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-09-15T01:36:15.926Z
Stopped at: Completed 01-07-PLAN.md
Resume file: None
