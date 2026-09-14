---
last_mapped_commit: 9d00e31f990696b01cfc743195d7e5b8f553aed4
last_mapped_at: 2026-09-14
---
# Codebase Concerns

**Analysis Date:** 2026-09-14

## Tech Debt

**Large monolithic main file:**

- Issue: `main/index.mjs` is 1479 lines containing initialization, IPC handlers, menu system, and background job orchestration
- Files: `main/index.mjs`
- Impact: Difficult to test, single point of failure for app lifecycle, hard to maintain
- Fix approach: Split into focused modules (lifecycle.mjs, ipc.mjs, menu.mjs, jobs.mjs)

**Large renderer module:**

- Issue: `renderer/today.js` is 1854 lines containing UI rendering, event handling, and state management
- Files: `renderer/today.js`
- Impact: Difficult to debug, monolithic DOM manipulation, CSS and JS tightly coupled
- Fix approach: Componentize into logical sections (tabs, rendering layers, event handlers)

**Synchronous I/O in queue append:**

- Issue: `queue.mjs` uses `fs.appendFileSync()` for every capture, blocking the app
- Files: `main/queue.mjs:13`
- Impact: Slow captures on busy disks, app responsiveness degradation
- Fix approach: Buffer writes to batch them (e.g., async flush every 500ms or 10 items)

**Context foreground caching with potential staleness:**

- Issue: Foreground window context cached for 120 seconds (`FG_CACHE_MS`), may capture wrong context if user switches windows quickly
- Files: `main/index.mjs:382-395`
- Impact: Captured items may have wrong context (wrong project, misleading title)
- Fix approach: Reduce cache TTL or implement window tracking to detect stale cache; validate captured context against current foreground when saving

## Known Bugs

**Settings file encoding on Windows PowerShell:**

- Symptoms: Settings file becomes unreadable JSON after editing with PowerShell, app loses vault path/calendar URL/window positions
- Files: `main/settings.mjs`, `main/index.mjs:613-640`
- Trigger: Using PowerShell's `Set-Content -Encoding UTF8` to edit `%APPDATA%\whenwork\settings.json`
- Workaround: Use Node.js to write settings; create backup before editing. Documented in user memory but not in code comments.

**Queue file corruption handling:**

- Symptoms: Corrupted JSON lines silently dropped, but file never truncated, causing drain to re-process
- Files: `main/queue.mjs:44-49`, `main/queue.mjs:36-61`
- Trigger: App crash mid-write during `fs.appendFileSync()` creates partial JSON line
- Workaround: Silent skip handles it but doesn't prevent the same line being re-parsed; no checksum to detect partial data

## Security Considerations

**Secrets in settings file:**

- Risk: Calendar URL contains OAuth token; stored in plaintext in `%APPDATA%\whenwork\settings.json`
- Files: `main/index.mjs:615`, `main/calendar.mjs:33`
- Current mitigation: Token masked in UI display (`maskUrl()`), not logged to screen, app access controlled by OS file permissions
- Recommendations: Consider OS credential store (Windows Credential Manager) for sensitive URLs; implement read-only masking throughout; document secret handling

**External CLI tool dependencies:**

- Risk: App security depends on `git`, `gh`, `glab` CLI tools being installed, authenticated, and not compromised
- Files: `main/issues.mjs`, `main/repo.mjs`, `main/ai.mjs`
- Current mitigation: Failures silently skip that repo/tool, no auth prompt
- Recommendations: Verify CLI tool signatures or versions on startup; document minimum version requirements

**AI prompt injection risk:**

- Risk: User-controlled text (captured titles, git commit messages) fed directly to `claude -p` without escaping
- Files: `main/ai.mjs:67-91`, `main/ai.mjs:94-130`, `main/ai.mjs:145-170`
- Current mitigation: Prompts instruct model to ignore extra text, examples show strict validation of output
- Recommendations: Add prompt escaping layer; limit prompt size; add abuse detection for unusual suggestion patterns

## Performance Bottlenecks

**AI call quota sharing with Claude Code:**

- Problem: Calls to `claude -p` share subscription quota with user's Claude Code work; slowdown/limits affect app
- Files: `main/index.mjs:465-476`
- Cause: Fixed daily quota, no backpressure, retries happen inside claude CLI (up to 4 minutes)
- Improvement path: Implement quota checking before calling, adaptive rate limiting (reduce frequency if quota near limit), queue AI jobs for off-peak

**Repeated queue reads for every operation:**

- Problem: `queue.readAll()` reads entire JSONL file on every count check; `queue.drain()` reads file twice (before/after)
- Files: `main/queue.mjs:16-27`, `main/queue.mjs:36-61`
- Cause: No in-memory state of queue length
- Improvement path: Cache queue length, only update on append/drain; use file watchers if cross-process queue needed

**PostgreSQL connection pool too small for concurrent operations:**

- Problem: Pool size = 3, but background collection (git, issues, calendar) may need 4+ connections
- Files: `main/db.mjs:184-195`
- Cause: Tradeoff between idle connection cost and concurrent requests
- Improvement path: Increase to 5-10 and monitor idle connections; add queue for DB operations if pool exhausted

**Calendar fetch on every UI view:**

- Problem: `todayEvents()` queries DB on every tab switch; events may be stale between sync intervals (15 min)
- Files: `main/index.mjs:694-703`
- Cause: No client-side caching, UI doesn't know sync status
- Improvement path: Cache events in renderer state; send sync status to UI; refresh only after sync succeeds

## Fragile Areas

**Weekly review triggering:**

- Files: `main/index.mjs:572-592`, `main/brief.mjs` (reviewDue)
- Why fragile: Depends on correct `lastReviewTry` and `lastReviewError` state; if one field gets cleared, logic breaks. Used to create initial state if keys missing.
- Safe modification: Always check both existing generation timestamp AND user settings before deciding to generate; add defensive null checks
- Test coverage: `test/brief.test.mjs` covers `reviewDue()` but not end-to-end trigger in index.mjs

**Background collection race conditions:**

- Files: `main/index.mjs:435-458`
- Why fragile: `collecting` flag prevents overlaps but doesn't guarantee atomicity; if app crashes during collect, flag stays true until restart
- Safe modification: Add startup check to reset flag if stale; use persistent markers (e.g., timestamp in DB) instead of memory flag
- Test coverage: No integration test for collect flow

**Issue/PR relation merging:**

- Files: `main/issues.mjs:95-103`, `main/issues.mjs:41-44`, `main/issues.mjs:73-76`
- Why fragile: Multiple code paths merge issue/PR lists with Map logic; if API response order changes or new relation types added, logic may silently produce wrong relation
- Safe modification: Add test case for each merge path; validate `relation` enum at DB insert time
- Test coverage: No test for `issues.mjs`; logic checked only in smoke test UI

**Queue drain file replacement:**

- Files: `main/queue.mjs:36-61`
- Why fragile: Reads entire file, passes entries to consumer, reads file AGAIN to get `tail`, then writes new file. If file changes between first and second read (concurrent append), data loss occurs.
- Safe modification: Use atomic file operations (lock file or write-to-new-file-then-rename); test concurrent append during drain
- Test coverage: `test/queue.test.mjs` only tests sequential happy path

## Scaling Limits

**Single PostgreSQL instance (Docker local):**

- Current capacity: Millions of items but single-node, no backup strategy defined
- Limit: Database file corruption or host failure = total data loss
- Scaling path: Add scheduled backup validation, multi-node replication (PostgreSQL streaming), automated failover

**Git CLI performance on large repos:**

- Current capacity: `git status --porcelain`, `git stash list`, `rev-list --count` each spawn new process
- Limit: Repos with 50K+ files slow down collection cycle; app may miss sync windows
- Scaling path: Batch git operations; use `git` API (libgit2) directly; cache git state between runs

**Renderer DOM size (1854 lines, many dynamic elements):**

- Current capacity: ~100 items per tab renders fine; large projects with 500+ items may cause jank
- Limit: Browser becomes unresponsive scrolling large lists
- Scaling path: Virtual scrolling; lazy render; split tabs into sub-views

## Dependencies at Risk

**Node pg 8.13.0:**

- Risk: PostgreSQL node driver; version pinned but may have known CVEs
- Impact: Database injection vulnerability, connection pool leaks
- Migration plan: Monitor security advisories; test pg 8.14+ before upgrading

**Electron 43.2.0:**

- Risk: Chromium + Node version; security patches lag behind Node LTS
- Impact: Renderer process exploits, IPC security holes
- Migration plan: Monitor Electron releases; test major versions quarterly

**Apps Script web app for calendar (external dependency):**

- Risk: Google APIs change, Apps Script deploy becomes stale, user loses access
- Impact: Calendar sync fails silently, app shows stale calendar data indefinitely
- Migration plan: Implement Google Calendar API direct client; cache validation and expiry checks

## Missing Critical Features

**Feature gap: Data export/import:**

- Problem: No built-in export to CSV/JSON; users cannot audit data or migrate between instances
- Blocks: Data portability, compliance, recovery from corruption
- Impact: High - user trapped if DB corrupts

**Feature gap: Conflict resolution for concurrent edits:**

- Problem: If user runs app on two machines, queue/DB writes collide with no merge strategy
- Blocks: Multi-device workflows
- Impact: Medium - niche use case but data loss possible

**Feature gap: Auditable completion ratios:**

- Problem: Completed items are marked `done_at` but reason (checkbox vs. auto-close vs. manual) not tracked
- Blocks: Retrospective analysis of completion patterns
- Impact: Low - informational only

## Test Coverage Gaps

**No tests for `main/db.mjs`:**

- What's not tested: Connection pool behavior, transaction handling, schema migration, SQL injection patterns
- Files: `main/db.mjs` (997 lines)
- Risk: DB layer changes silently break data integrity
- Priority: High

**No tests for `main/issues.mjs`:**

- What's not tested: GitHub/GitLab CLI parsing, multi-provider merging, draft PR/MR handling
- Files: `main/issues.mjs` (139 lines)
- Risk: Issue sync silently returns wrong data; relation merging produces incorrect categories
- Priority: High

**No tests for `main/index.mjs` app lifecycle:**

- What's not tested: IPC handler edge cases, background job orchestration, graceful shutdown
- Files: `main/index.mjs` (1479 lines)
- Risk: App hangs on quit, crashes when jobs overlap, orphaned processes
- Priority: Medium (smoke test provides partial coverage)

**No tests for renderer layer (`renderer/*.js`):**

- What's not tested: DOM rendering correctness, event handling, CSS class application, keyboard navigation
- Files: `renderer/today.js` (1854 lines), `renderer/capture.js` (131 lines), others
- Risk: UI bugs discovered only by manual testing; smoke test does basic checks but not comprehensive
- Priority: Medium

**Incomplete calendar sync testing:**

- What's not tested: Google Apps Script failure modes, network timeouts, malformed events
- Files: `main/calendar.mjs` (93 lines), test file 103 lines
- Risk: Calendar fetches may leave DB in inconsistent state
- Priority: Low (gracefully degrades to stale cache)

---

*Concerns audit: 2026-09-14*
