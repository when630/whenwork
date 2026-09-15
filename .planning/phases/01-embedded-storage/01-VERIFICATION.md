---
phase: 01-embedded-storage
verified: 2026-09-15T02:00:00Z
status: human_needed
score: 5/5 must-haves verified
covered_files: [".planning/REQUIREMENTS.md", ".planning/ROADMAP.md", ".planning/phases/01-embedded-storage/01-01-PLAN.md", ".planning/phases/01-embedded-storage/01-01-SUMMARY.md", ".planning/phases/01-embedded-storage/01-02-PLAN.md", ".planning/phases/01-embedded-storage/01-02-SUMMARY.md", ".planning/phases/01-embedded-storage/01-03-PLAN.md", ".planning/phases/01-embedded-storage/01-03-SUMMARY.md", ".planning/phases/01-embedded-storage/01-04-PLAN.md", ".planning/phases/01-embedded-storage/01-04-SUMMARY.md", ".planning/phases/01-embedded-storage/01-05-PLAN.md", ".planning/phases/01-embedded-storage/01-05-SUMMARY.md", ".planning/phases/01-embedded-storage/01-06-PLAN.md", ".planning/phases/01-embedded-storage/01-06-SUMMARY.md", ".planning/phases/01-embedded-storage/01-07-PLAN.md", ".planning/phases/01-embedded-storage/01-07-SUMMARY.md", ".planning/phases/01-embedded-storage/01-CONTEXT.md", "main/index.mjs", "main/ipc.mjs", "main/jobs.mjs", "main/lifecycle.mjs", "main/queue.mjs", "main/store.mjs", "package.json", "renderer/capture.js", "renderer/today.js", "test/capture-crash-smoke.test.mjs", "test/queue.test.mjs", "test/store.test.mjs"]
covered_digest: "v1:sha256:10a260e98d895fd30917767d50a682d7548a138492cd0692a41158a4ac23b22a"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "실제 Windows 데스크톱에서 앱을 띄워 전역 단축키(Ctrl+Alt+Space)로 캡처하고, 트레이 툴팁·오늘 뷰 상단에서 대기 건수·저장소 안내가 정상 렌더링되는지 눈으로 확인한다. store.sqlite가 있는 폴더를 잠근 뒤 캡처해 (a) 캡처 창이 평소처럼 '저장됨'만 보이고 (b) OS 알림이 뜨지 않으며 (c) 트레이 툴팁·오늘 뷰 상단에만 대기 건수가 뜨는지 확인한다"
    expected: "캡처 창은 실패를 보이지 않고, 트레이 툴팁·오늘 뷰 상단에 대기 건수/손상 안내가 조용히 드러나며, OS 알림은 뜨지 않는다 (D-03)"
    why_human: "이 검증 환경은 전역 단축키가 등록되지 않고 트레이 아이콘을 렌더링/조작할 수 없어(01-01~01-05 SUMMARY가 반복 기록한 샌드박스 한계) 실제 시각적 확인이 불가능하다. 01-03-PLAN.md Task 3의 <human-check>가 이 항목을 명시적으로 이월했다"
  - test: "앱을 몇 분 띄워 두고 트레이 메뉴를 연다. 수집·백업·주간 리뷰 항목이 없고 git·gh·glab·claude 프로세스가 하나도 뜨지 않는지 확인한다. 아침 브리핑 시각을 방금 지난 시각으로 설정을 바꿨을 때 OS 알림이 한 번 뜨는지 확인한다"
    expected: "레거시 백그라운드 작업(수집·백업·주간 리뷰·재개 카드·완료 제안)이 전혀 동작하지 않고, 남은 배경 작업은 큐 반영(1회)·아침 브리핑·purge뿐이다 (D-06)"
    why_human: "같은 샌드박스 한계로 트레이 메뉴 UI와 실제 알림 팝업은 육안 확인이 필요하다. 01-05-PLAN.md Task 2의 <human-check>가 이 항목을 명시적으로 이월했다"
  - test: "macOS 실기기에서 `npm run smoke:crash`를 한 번 더 돌린다"
    expected: "Windows와 동일하게 캡처 직후 SIGKILL → 재기동 → 오늘 뷰 인박스에 캡처가 있음이 재현된다"
    why_human: "이 세션·검증 환경 모두 macOS 실기기가 없어 검증 자체가 불가능하다. D-04가 요구하는 '두 OS에서 돈다'의 macOS 쪽은 Phase 4/5(REL-05)로 명시적으로 이월되어 있다(01-07-PLAN.md Task 2의 <human-check>, 01-07-SUMMARY.md 'macOS 미검증 갭')"
---

# Phase 1: 내장 저장소 전환 Verification Report

**Phase Goal:** main/index.mjs 구조 정리(동작 변경 없는 순수 리팩터)를 먼저 마치고, 그 위에 PostgreSQL·Docker 없는 내장 저장소(node:sqlite)로 교체해 "캡처는 절대 유실되지 않는다"는 원래 보장을 유지한다.
**Verified:** 2026-09-15T02:00:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | 앱은 PostgreSQL·Docker 등 외부 프로세스 없이 실행되고, 프로젝트·항목·이벤트가 앱 데이터 폴더 안의 단일 파일 저장소에 저장된다 | ✓ VERIFIED | 실제로 Electron 앱을 격리된 임시 `userData` 경로로 `--smoke` 기동해 확인: `store.sqlite` 파일이 생성되고 `PRAGMA journal_mode='wal'`, `PRAGMA synchronous=2`(FULL), `PRAGMA user_version=1`. `schemaTables()` 가드 테스트가 `['event','item','project']` 세 테이블만 확인(`test/store.test.mjs`). `main/db.mjs`(PostgreSQL) 파일 자체가 리포에서 삭제됨(`git rm`, 커밋 920821a), `pg`는 `devDependencies`에만 존재하고 런타임 import(`grep "'pg'" main/ renderer/`) 0건 |
| 2 | 저장소 쓰기가 실패해도 캡처는 로컬 큐 폴백에 남고, 다음 실행 시 자동으로 반영된다 | ✓ VERIFIED | `main/ipc.mjs`의 `saveCapture()` 소스 확인: `ctx.queue.append(entry)`(동기, fs만 의존)가 먼저 실행되고, 그 뒤 `store.insertCaptures` 시도 → 실패 시 `reopen()` 후 재시도 → 그래도 실패하면 예외를 삼키고 `ctx.pending`만 증가(예외가 위로 올라가지 않음). `main/jobs.mjs`의 `replayQueueOnce(ctx)`가 `!SMOKE` 가드 밖에서 기동 시 정확히 1회 호출되어 큐를 저장소에 반영. 01-07 SUMMARY가 저장소 삽입 직전 인위적 지연을 넣어 이 경로를 되돌려 확인한 결과, 큐 선기록이 없으면 실제로 유실되고(재현됨), 선기록이 있으면 유실되지 않음(`test/queue.test.mjs` 7/7, `node --test test/queue.test.mjs` 재실행 확인) |
| 3 | 캡처 직후 강제 종료해도 그 캡처가 유실되지 않음을 자동 테스트가 재현해서 증명한다 | ✓ VERIFIED | `npm run smoke:crash`를 이 세션에서 직접 재실행 — `test/capture-crash-smoke.test.mjs`가 실제 Electron 프로세스를 `--smoke --inject-capture=<표식>`으로 띄워 `CAPTURE_INJECTED`를 확인한 뒤 `SIGKILL`(OS 분기 없음)로 죽이고, 같은 `--smoke-data`로 재기동해 `SMOKE_OK`의 `renderer.inbox`에 그 표식이 있음을 단언 — **1/1 pass**(직접 재실행 결과, SUMMARY 주장이 아니라 이 검증에서 실제로 실행함) |
| 4 | 앱을 업데이트해도 사용자 개입 없이 저장소 스키마가 최신 버전으로 자동 이행된다 | ✓ VERIFIED | `main/store.mjs`의 `migrate()`가 `PRAGMA user_version`을 읽어 현재 버전부터 `MIGRATIONS.length`까지 순번대로(트랜잭션으로 감싸) 적용. 앱보다 높은 `user_version`을 만나면 `NewerSchemaError`를 던지고 쓰기를 차단(`test/store.test.mjs`의 newer 거부 테스트로 확인). 실제 앱 기동으로 빈 파일 → v1 자동 생성(user_version=1)을 직접 확인. 버전이 실제로 오를 때만 `backups/store-v<이전>-<YYYYMMDD>.sqlite` 백업 생성(단위 테스트로 v0 제외·백업 실패해도 이행 지속 확인) |
| 5 | 새 저장소 스키마에는 제거 대상 테이블(activity, issue, resume_card, repo_state, cal_event, review)이 처음부터 만들어지지 않는다 | ✓ VERIFIED | `grep -nE "\b(activity|issue|resume_card|repo_state|cal_event|review)\b" main/store.mjs` — 매치 없음(직접 재실행 확인). `test/store.test.mjs`의 `schemaTables()` 가드 테스트가 정확히 `['event','item','project']`만 나옴을 단언(31/31 pass, 직접 재실행 확인) |

**Score:** 5/5 truths verified (0 present, behavior-unverified)

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| STOR-01 | 01-01, 01-02, 01-04, 01-05, 01-06 | 앱은 외부 DB·컨테이너 없이 앱 데이터 폴더 안의 내장 저장소(단일 파일)에 프로젝트·항목·이벤트를 저장한다 | ✓ SATISFIED | `store.sqlite` 단일 파일, `main/db.mjs`/`pg` 런타임 제거, 실제 기동 확인 |
| STOR-02 | 01-03 | 캡처는 저장소 상태와 무관하게 절대 실패하지 않는다 | ✓ SATISFIED | `saveCapture()` 큐 선기록 + 동기 즉시 반영 + reopen 재시도, 되돌리기 확인으로 실제 실패 관찰 |
| STOR-03 | 01-07 | 캡처 직후 강제 종료해도 유실 없음, 자동 테스트로 재현 | ✓ SATISFIED | `npm run smoke:crash` 1/1 pass(직접 재실행) |
| STOR-04 | 01-02 | 저장소 스키마 버전 관리 + 자동 마이그레이션 | ✓ SATISFIED | `PRAGMA user_version` 순번 마이그레이션, newer 거부, 단위 테스트 |
| STOR-05 | 01-02, 01-04 | 제거 대상 테이블 미생성 | ✓ SATISFIED | grep 0건 + 가드 테스트 |

Orphaned requirements: 없음 — `.planning/REQUIREMENTS.md`에 Phase 1로 매핑된 요구사항은 STOR-01~05 다섯 개뿐이고 전부 계획 frontmatter에서 선언·구현됨.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `main/lifecycle.mjs` | ctx 생성, 창·트레이·단축키·앱 수명, `bootstrap()` | ✓ VERIFIED | 존재(752→현재 더 커짐), `bootstrap` export, `ctx.store` 생성·`before-quit`에서 `close()` 호출 확인 |
| `main/ipc.mjs` | `registerIpc(ctx)`, `saveCapture(ctx,title,context)` | ✓ VERIFIED | 존재, 두 함수 모두 export, `ctx.store.*` 위임 다수 확인, 레거시 스텁 확인 |
| `main/jobs.mjs` | `scheduleJobs(ctx)`, `replayQueueOnce`, `maybeBrief`, `purgeOnce` | ✓ VERIFIED | 존재, 3함수만 남고 `FLUSH_MS`/구식 배경 작업 없음 확인 |
| `main/index.mjs` | bootstrap 호출만 남은 엔트리포인트 | ✓ VERIFIED | 8줄, `bootstrap()` 호출 1개만 |
| `main/store.mjs` | node:sqlite 기반 단일 파일 저장소 | ✓ VERIFIED | `DatabaseSync` import, `createStore`/`MIGRATIONS`/`schemaTables`/`NewerSchemaError` 전부 export, PostgreSQL 전용 구문·금지 테이블명 0건 |
| `main/queue.mjs` | append-only + `replayPending` | ✓ VERIFIED | `drain` 완전히 사라지고 `replayPending` 존재, 7개 단위 테스트 통과 |
| `test/store.test.mjs` | 스키마·CRUD·손상·newer·백업 단위 테스트 | ✓ VERIFIED | 31/31 pass(직접 재실행) |
| `test/queue.test.mjs` | 재작성된 큐 회귀 테스트 | ✓ VERIFIED | 7/7 pass(직접 재실행) |
| `test/capture-crash-smoke.test.mjs` | 두 프로세스 강제종료 테스트 | ✓ VERIFIED | 1/1 pass(직접 재실행), `SIGKILL` 사용, OS 분기 없음 확인 |
| `main/db.mjs`, `main/backup.mjs`, `test/backup.test.mjs` | 삭제됨 | ✓ VERIFIED | 워킹트리·git 인덱스 모두에 없음 |
| `package.json`(pg devDependencies) | `pg`가 devDependencies로만 존재 | ✓ VERIFIED | `dependencies.pg=undefined`, `devDependencies.pg='^8.13.0'` |
| git tag `v-personal`, `v-personal-lastmix` | 개인용 버전 보존 표식 | ✓ VERIFIED | `git tag --list 'v-personal*'`로 둘 다 확인 |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `main/index.mjs` | `main/lifecycle.mjs` | `bootstrap()` | ✓ WIRED | 8줄 index.mjs에서 import+호출 확인 |
| `main/lifecycle.mjs` | `main/ipc.mjs`/`main/jobs.mjs` | `registerIpc(ctx)`/`scheduleJobs(ctx)` | ✓ WIRED | 상호 import 없음(순환 없음), ctx로만 상태 공유 |
| `main/lifecycle.mjs` | `main/store.mjs` | `createStore(...)`로 `ctx.store` 생성, `before-quit`에서 `close()` | ✓ WIRED | 직접 grep 확인 |
| `main/ipc.mjs` | `main/store.mjs` | `saveCapture`가 `ctx.store.insertCaptures` 동기 호출 | ✓ WIRED | 소스 확인, 순서(큐 선기록→저장소 반영→재시도)까지 확인 |
| `main/jobs.mjs` | `main/queue.mjs` | `replayQueueOnce`가 `ctx.queue.replayPending` 호출 | ✓ WIRED | 소스 확인 |
| `main/preload.cjs` 채널 전부 | `main/ipc.mjs`/`main/lifecycle.mjs`/`main/jobs.mjs` | invoke/send 채널 대조 | ✓ WIRED | 37개 채널 전부 등록/발신 확인(스크립트 대조, 직접 재실행) |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| `today:getState` 응답 `inbox`/`today`/`waiting` | `getViewState()` | `main/store.mjs`의 실제 SQL 쿼리(`item` LEFT JOIN `project`) | Yes | ✓ FLOWING |
| 캡처 → `store.sqlite` | `insertCaptures` | `saveCapture` → `ctx.store.insertCaptures` | Yes(직접 기동해 파일 생성·PRAGMA 확인) | ✓ FLOWING |
| 트레이 툴팁 대기 건수 | `ctx.pending` | `saveCapture`의 재시도 실패 카운터 | Yes(소스 확인, human 시각 확인은 대기) | ✓ FLOWING (코드) / 시각 확인은 human_verification 항목 |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| 전체 테스트 스위트 | `npm test` | 206/206 pass | ✓ PASS |
| 기존 --smoke 프로브 | `npm run smoke` | `SMOKE_OK hotkey=false pending=0 renderer={...,"inbox":[]}` | ✓ PASS (hotkey=false는 검증 환경 조건 — 데스크톱 세션에 다른 WHENWORK 인스턴스가 전역 단축키를 쥐고 있어서, 실패 아님) |
| 강제종료 내구성 테스트 | `npm run smoke:crash` | 1/1 pass | ✓ PASS |
| `store.mjs` 단위 테스트 | `node --test test/store.test.mjs` | 31/31 pass | ✓ PASS |
| `queue.mjs` 단위 테스트 | `node --test test/queue.test.mjs` | 7/7 pass | ✓ PASS |
| 실제 앱 기동 → 단일 파일 저장소 생성·PRAGMA 확인 | 임시 `--smoke-data`로 Electron 기동 후 `node:sqlite`로 직접 조회 | `store.sqlite` 생성, `journal_mode=wal`, `synchronous=2`, `user_version=1` | ✓ PASS |
| preload 채널 ↔ ipc.mjs 대조 | 채널 목록 추출 후 grep 대조 스크립트 | 37개 채널 전부 등록/발신 확인 | ✓ PASS |
| PostgreSQL/제거 대상 테이블 잔재 없음 | grep 스크립트 | 매치 없음 | ✓ PASS |

### Probe Execution

`scripts/*/tests/probe-*.sh` 관례 없음, PLAN/SUMMARY도 이런 프로브를 선언하지 않음 — SKIPPED (no probe convention in this project).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| (없음) | - | - | - | `TBD`/`FIXME`/`XXX`/`HACK`/`PLACEHOLDER`/"not yet implemented" 등 grep 전부 매치 없음(phase가 수정한 전 파일 대상 재확인) |

`main/index.mjs`의 상단 주석("퀵캡처 → 로컬 큐 → PostgreSQL 동기화(D1)")이 이제 사실과 다른 과거 설명을 담고 있음(기능상 영향 없는 stale 주석) — 이 자체는 차단 사유는 아니나 Phase 2(레거시 문구 정리) 또는 사소한 후속 커밋에서 정리할 만하다. **Info, not blocking.**

### Human Verification Required

3건 — 모두 이 검증 환경(전역 단축키·트레이 미등록 샌드박스, macOS 실기기 없음)의 한계로 인한 것이며, 각 PLAN이 명시적으로 이월(`<human-check>`)한 항목이다. 자세한 내용은 frontmatter `human_verification` 참고:

1. **트레이 툴팁·오늘 뷰 대기 표시·손상 안내 육안 확인** — 실제 데스크톱에서 단축키 캡처, 저장소 파일 잠금 후 캡처 시 "저장됨"만 보이는지, OS 알림이 안 뜨는지 확인 (01-03-PLAN.md Task 3)
2. **트레이 메뉴에서 레거시 항목 소거 + 외부 프로세스 미실행 + 아침 브리핑 알림 확인** — 몇 분 띄워 두고 트레이 메뉴를 열어 확인 (01-05-PLAN.md Task 2)
3. **macOS 실기기에서 `smoke:crash` 재실행** — Windows 통과는 이 검증에서 직접 확인했으나 macOS는 실기기가 없어 원천적으로 검증 불가 (01-07-PLAN.md Task 2, 01-07-SUMMARY.md에 갭 명시)

### Gaps Summary

없음. 5개 ROADMAP Success Criteria, STOR-01~05 5개 요구사항이 전부 코드베이스에서 직접 실행·확인됐다(SUMMARY의 주장을 그대로 받아들이지 않고 `npm test`·`npm run smoke`·`npm run smoke:crash`·`node --test test/store.test.mjs`·`node --test test/queue.test.mjs`를 이 세션에서 재실행했고, 실제 Electron 프로세스를 격리된 임시 데이터 폴더로 띄워 `store.sqlite`가 생성되고 WAL/FULL/버전 1로 열리는 것을 `node:sqlite`로 직접 조회했다). `main/db.mjs`·`main/backup.mjs`·`test/backup.test.mjs` 삭제, `pg`의 devDependencies 격하, `v-personal`/`v-personal-lastmix` 태그 존재도 모두 직접 확인됐다.

남는 것은 이 검증 세션의 환경적 한계(전역 단축키·트레이 미등록, macOS 실기기 부재)로 인한 3건의 human_verification뿐이며, 이는 코드 결함이 아니라 실제 데스크톱에서 사람이 한 번 더 눈으로 봐야 하는 항목이다. 이 때문에 상태는 `human_needed`이지 `gaps_found`가 아니다.

---

_Verified: 2026-09-15T02:00:00Z_
_Verifier: Claude (gsd-verifier)_
