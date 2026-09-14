---
gsd_state_version: "1.0"
current_phase: 01
current_phase_name: 내장 저장소 전환
status: executing
stopped_at: Completed 01-01-PLAN.md
last_updated: "2026-09-14T08:41:47.643Z"
last_activity: 2026-09-14
last_activity_desc: Phase 01 execution started
state_head: 07fdfd1ef7a1a285b2c759503f490d7a464557cd
progress:
  total_phases: 5
  completed_phases: 0
  total_plans: 7
  completed_plans: 1
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-09-14)

**Core value:** 설치 파일 하나를 받아 실행한 사람이, 다른 것을 아무것도 깔지 않고, 단축키로 던진 할 일을 절대 잃지 않는다.
**Current focus:** Phase 01 — 내장 저장소 전환

## Current Position

Phase: 01 (내장 저장소 전환) — EXECUTING
Plan: 2 of 7
Status: Ready to execute
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

Last session: 2026-09-14T08:41:47.629Z
Stopped at: Completed 01-01-PLAN.md
Resume file: None
