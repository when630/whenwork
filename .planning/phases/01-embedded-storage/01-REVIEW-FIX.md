---
phase: 01-embedded-storage
fixed_at: 2026-09-15T00:00:00Z
review_path: .planning/phases/01-embedded-storage/01-REVIEW.md
iteration: 1
findings_in_scope: 7
fixed: 7
skipped: 0
status: all_fixed
---

# Phase 01-embedded-storage: Code Review Fix Report

**Fixed at:** 2026-09-15
**Source review:** .planning/phases/01-embedded-storage/01-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 7 (Critical: 1, Warning: 6 — `fix_scope=critical_warning`, so IN-01/IN-02 were out of scope and not attempted)
- Fixed: 7
- Skipped: 0

**Verification environment:** All edits, syntax checks, and `node --test` runs were performed inside an isolated git worktree (`.claude/worktrees/rf-01-*`) created for this run, then fast-forwarded into `main`. Full suite (`node --test`, 206 tests) passed after all seven fixes were applied together.

## Fixed Issues

### CR-01: `insertCaptures`가 저장소 미가동 시 예외 없이 성공한 것처럼 반환

**Files modified:** `main/store.mjs`, `test/store.test.mjs`
**Commit:** `d8a7d47`
**Applied fix:** `insertCaptures` now `throw new Error('store not open')` when `!db || !state.ok`, matching the throw-as-failure contract already assumed by `queue.replayPending` and `ipc.saveCapture`. Updated the one existing test that asserted the old (buggy) `{inserted:0}` return for a "newer schema" store to instead assert the call throws (`assert.throws`), since that test was directly exercising the reported defect.
**Verification:** `node -c`, then `node --test test/store.test.mjs test/queue.test.mjs` (38 pass), then full suite (206 pass).

### WR-01: `briefing()`의 "오늘" 기준이 UTC라 자정~09시 마감 판정이 어긋남

**Files modified:** `main/store.mjs`
**Commit:** `170cd15`
**Applied fix:** Imported `dayKey` from `main/brief.mjs` (an existing pure local-date helper already used elsewhere in the codebase, e.g. `main/ipc.mjs`'s `weekLabel`) instead of introducing a duplicate `localToday()` function as the review's inline suggestion showed. Replaced `new Date().toISOString().slice(0,10)` with `dayKey()` so `today` is computed from local date components, consistent with how `due` is stored (confirmed `parseDue` in `main/parse.mjs` already uses local components).
**Verification:** `node -c`, `node --test test/store.test.mjs` (31 pass).

### WR-02: 이행 직전 백업이 WAL 체크포인트 없이 본 파일만 복사

**Files modified:** `main/store.mjs`
**Commit:** `02145ab`
**Applied fix:** Added `db` parameter to `backupBeforeMigrate(db, file, fromVersion)` and call `db.exec('PRAGMA wal_checkpoint(TRUNCATE)')` before `fs.copyFileSync`, so any captures still sitting in `-wal` after a crash are folded into the main file before the backup copy is made. Updated the call site in `migrate()` to pass `db`.
**Verification:** `node -c`, `node --test test/store.test.mjs` (31 pass, including the existing "백업 폴더를 만들 수 없어도 마이그레이션은 끝까지 진행된다" test).

### WR-03: `today:getState`에 `getViewState()` 호출 try/catch 누락

**Files modified:** `main/ipc.mjs`
**Commit:** `c762898`
**Applied fix:** Wrapped the `ctx.store.getViewState()` call in try/catch, matching the pattern already used by `history:get` and item-op handlers in the same file. On exception, returns `{ ...base, online: false, notice: '저장소 조회 중 오류가 있었습니다' }` instead of letting the exception surface as an unhandled renderer promise rejection.
**Verification:** `node -c` (no dedicated IPC test file exists in this project — Tier 3 fallback, Tier 1 re-read confirmed).

### WR-04: `requestSingleInstanceLock()` 실패 시 초기화 계속 진행

**Files modified:** `main/lifecycle.mjs`
**Commit:** `fb5623d`
**Applied fix:** Changed `if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();` to call `app.quit()` and then `return ctx;` immediately, since `app.quit()` is async and does not itself halt execution. This stops the second-instance code path from opening a duplicate `store.sqlite` handle or creating a duplicate tray/window before Electron's quit takes effect.
**Verification:** `node -c` (no dedicated lifecycle test file exists — Tier 3 fallback, Tier 1 re-read confirmed; `ctx` was already fully constructed above this line before store/queue/settings/tray are attached, so returning it early is safe).

### WR-05: 강제종료 스모크 하네스가 `kill` 뒤 종료를 기다리지 않고 임시 폴더 삭제

**Files modified:** `test/capture-crash-smoke.test.mjs`
**Commit:** `9101e41`
**Applied fix:** In the `finally` block, added `await waitForExit(child)` after each `child.kill('SIGKILL')` call, and added `maxRetries: 5, retryDelay: 100` to `fs.rmSync` for extra resilience against transient Windows file-handle release delays.
**Verification:** `node -c`, then ran the actual smoke test (`node --test test/capture-crash-smoke.test.mjs`, which spawns real Electron processes) — passed in ~2.9s.

### WR-06: 대기 파일 단위 전부-아니면-전무 트랜잭션이 손상된 항목 하나로 큐 전체를 영구히 막을 수 있음

**Files modified:** `main/store.mjs`
**Commit:** `61217c9`
**Applied fix:** Wrapped the per-entry insert logic inside `insertCaptures`'s transaction loop in its own try/catch. A single entry that throws (e.g. a bad SQLite parameter binding on a corrupted queue record) is now logged and skipped, while the rest of the entries in that file still commit normally. This directly addresses the reviewer's primary concern — a single malformed item can no longer roll back the whole file's transaction and can no longer trigger `replayPending`'s `break`, which previously would have frozen all earlier pending files indefinitely. Genuine store-level failures (e.g. the store itself not being open, per CR-01) still propagate and are NOT caught by this per-entry try/catch, so `replayPending` still correctly retries on real store outages.

Scoped this to the minimal option the review offered ("항목 단위로 개별 삽입을 시도해 문제 있는 항목만 건너뛰고 나머지는 반영") rather than also building a quarantine-file mechanism for skipped entries, which the review phrased as an optional follow-up to "consider" (검토한다), not a required part of the fix.
**Verification:** `node -c`, `node --test test/store.test.mjs` (31 pass) and `node --test test/queue.test.mjs` (7 pass, including "replayPending 중 consume이 throw하면 대기 파일이 남고..." and "깨진 줄은 건너뛰고 나머지는 살린다").

## Skipped Issues

None — all in-scope findings were fixed.

---

_Fixed: 2026-09-15_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
