---
phase: 01-embedded-storage
fixed_at: 2026-09-15T02:22:07Z
review_path: .planning/phases/01-embedded-storage/01-REVIEW.md
iteration: 1
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Phase 01-embedded-storage: Code Review Fix Report

**Fixed at:** 2026-09-15T02:22:07Z
**Source review:** .planning/phases/01-embedded-storage/01-REVIEW.md (재검토)
**Iteration:** 1

**Summary:**
- Findings in scope: 4 (CR-01, WR-01, IN-01, IN-02)
- Fixed: 4
- Skipped: 0

**Verification environment:** All edits, syntax checks, and the full `node --test` run happened inside an isolated git worktree (`workflow.use_worktrees` was not set to `false`), then fast-forwarded onto `main`. The numbers below are reproducible against `main` after that fast-forward.

## Fixed Issues

### CR-01: `insertCaptures`의 항목별 catch가 데이터 결함과 진짜 저장 실패를 가리지 않고 전부 삼켜, WR-06 이전에 CR-01이 막았던 영구 유실을 다른 경로로 재도입한 회귀

**Files modified:** `main/store.mjs`, `test/store.test.mjs`
**Commit:** `4f204f4`
**Applied fix:** `insertCaptures`의 `for` 루프에서 `insert.run()` 자체를 감싸던 try/catch를 제거했다. 대신 삽입 시도 **전에** JS에서 필수 필드(`id`, `captured_at`, 그리고 약어로 못 붙는 경우의 `title`)를 검증해 구조적으로 결함 있는 항목만 `continue`로 건너뛴다 — 이 `continue`는 SQL을 실행하지 않으므로 트랜잭션을 무효화하지 않는다. `insert.run()`이 던지는 예외는 이제 전부 "진짜 저장 실패"로 취급되어 트랜잭션 전체를 롤백시키고 위로 전파되며, `queue.replayPending`이 대기 파일을 보존해 다음 기동에서 재시도하게 한다(WR-06 이전 계약으로 복귀). 추가로, 리뷰의 원안을 넘어선 안전장치를 넣었다: 파일 안 항목이 **모두** 구조 결함으로 건너뛰어졌다면(부분 성공이 전혀 없다면) `insertCaptures`가 명시적으로 `throw`한다 — 리뷰가 제안한 코드는 그 경우에도 `{ inserted: 0 }`을 조용히 반환해 `replayPending`이 대기 파일을 지우는 문제가 그대로 남았을 것이기 때문이다. 일부 항목만 결함이고 나머지가 정상 반영되는 WR-06의 원래 시나리오는 그대로 성공 처리된다(부분 성공이 존재하면 skipped===entries.length가 거짓이 되어 던지지 않는다).

**회귀 테스트 검증 (오케스트레이터 지시대로 수행):**
- `test/store.test.mjs`에 리뷰의 재현을 그대로 승격한 테스트를 추가했다: title이 `null`인 항목 하나만 든 대기 파일을 `queue.replayPending`으로 반영 시도.
- **수정 전(pre-fix) 코드에 대해 먼저 실행 — FAIL 확인:** `replayed=1, pendingLeft=[]` — 손상 항목이 "반영됨"으로 오보고되고 대기 파일이 즉시 삭제됨 (`AssertionError`로 실패). 이는 리뷰가 스크래치 스크립트로 관찰한 것과 정확히 일치한다.
- **수정 후(post-fix) 코드에 대해 재실행 — PASS 확인:** `insertCaptures`가 던지고 `replayPending`이 대기 파일을 보존해(`pendingLeft.length === 1`) 캡처가 저장소에도 큐에도 남는다(유실되지 않는다).
- 기존 테스트는 하나도 약화·삭제하지 않았다. 단 하나, 손상 재현에 쓰인 `title: null` 항목은 리뷰의 원본 스크래치 스크립트가 이미 지목한 것을 테스트로 승격한 것뿐이며 기존 스위트가 이 결함 유형을 검사하지 않았다는 사실은 리뷰의 진단(WR-01) 그대로다.

### WR-01: 이번에 고친 안전장치(WR-02 WAL 체크포인트, WR-06 항목 격리)에 전용 회귀 테스트가 없다

**Files modified:** `test/store.test.mjs`
**Commit:** `2efea3d` (CR-01 재현을 승격한 테스트는 위 CR-01 커밋 `4f204f4`에 이미 포함됨)
**Applied fix:** 리뷰가 요구한 두 테스트 중 남은 하나를 추가했다 — WAL에만 있고 아직 체크포인트되지 않은 캡처가 이행 전 백업(`backupBeforeMigrate`)에 포함되는지 확인하는 테스트. 두 개의 `DatabaseSync` 연결을 사용한다: 첫 연결(`store1`)로 캡처를 커밋하되 **닫지 않고** 유지해(WAL 모드에서 마지막 연결을 닫으면 SQLite가 자동으로 체크포인트해 버려 검증 의미가 사라지므로) 그 캡처가 `-wal`에만 남게 하고, 두 번째 연결(`store2`)이 다음 마이그레이션을 트리거해 `backupBeforeMigrate`의 `PRAGMA wal_checkpoint(TRUNCATE)`가 실행되게 한 뒤, 생성된 백업 파일을 독립적으로 열어 그 캡처가 있는지 확인한다.
**검증:** `main/store.mjs:119`의 `db.exec('PRAGMA wal_checkpoint(TRUNCATE)')`를 임시로 주석 처리해 이 새 테스트가 FAIL하는지 먼저 확인했다(`Error: no such table: item` — 체크포인트 없이는 백업 파일의 메인 테이블 자체가 비어 있었다). 원복 후 재실행해 PASS를 확인했고, `git diff --stat`로 `main/store.mjs`가 CR-01 커밋 그대로임을 대조해 실수로 다른 변경이 섞이지 않았음을 확인했다.
**WR-04(단일 인스턴스 락 조기 반환) 테스트는 이번에 추가하지 않았다:** 리뷰 자체가 "Electron 의존이라 순수 단위 테스트로 만들기 어렵다는 점은 이해하나, 최소한 회귀 시 조용히 깨질 수 있다는 점은 기록해 둔다"고만 적었고 **Fix** 절이 요구한 것은 WAL 체크포인트 테스트와 CR-01 승격 테스트 두 가지뿐이었다 — 둘 다 완료했다.

### IN-01: `main/index.mjs` 헤더 주석이 여전히 PostgreSQL을 가리킨다

**Files modified:** `main/index.mjs`
**Commit:** `dcade35`
**Applied fix:** 1번째 줄 주석을 `// WHENWORK — 트레이 상주. 퀵캡처(전역 단축키) → 로컬 큐 → 내장 SQLite 저장소(store.mjs) 반영(D1).`로 갱신 — 저장소가 `node:sqlite`(D-05)로 교체된 사실을 반영한다.

### IN-02: 퀵캡처에서 Enter로 저장 실패(`res.ok === false`) 시 사용자 피드백이 전혀 없다

**Files modified:** `renderer/capture.js`
**Commit:** `d33b917`
**Applied fix:** `if (!res.ok) return;`를 `showMsg('warn', '저장할 내용이 없습니다', 1500)`로 짧은 경고를 띄운 뒤 반환하도록 바꿨다. 입력값은 지우지 않는다 — 저장되지 않았으므로 사용자가 그대로 고쳐 다시 보낼 수 있어야 한다.

## Skipped Issues

None — all findings were addressed.

## Full Test Suite

`node --test` (전체, `test/capture-crash-smoke.test.mjs` 포함): **208 passed, 0 failed** (이전 재검토의 206건에서 이번에 추가한 회귀 테스트 2건만큼 늘었다).

---

_Fixed: 2026-09-15T02:22:07Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
