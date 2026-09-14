# Architecture Research

**Domain:** Offline-first Electron tray quick-capture to-do app (embedded storage, Windows + macOS)
**Researched:** 2026-09-14
**Confidence:** MEDIUM (Electron/Node version facts cross-checked against official docs; component-boundary and build-order recommendations are architectural judgment applied to the existing WHENWORK codebase, not third-party case studies)

## Context Recap (from codebase docs)

This is a *subtraction-and-replatform* milestone on an existing, working app, not a greenfield build. The current shape (per `.planning/codebase/ARCHITECTURE.md`, `STRUCTURE.md`, `CONCERNS.md`):

- `main/index.mjs` (1479 lines) — lifecycle, 40+ IPC handlers (`ipcMain.handle`/`.on`), tray, hotkey, all `setInterval`/`setTimeout` job scheduling.
- `main/queue.mjs` — dependency-free, synchronous-append JSONL capture buffer. Has a known race in `drain()` (`main/queue.mjs:36-61`): read → consume → re-read tail → rename. Concurrent append during drain can lose data (flagged in CONCERNS.md "Queue drain file replacement").
- `main/db.mjs` (997 lines) — PostgreSQL via `pg.Pool`, inline idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN IF NOT EXISTS` schema block run on every connect.
- Modules being deleted wholesale: `collect.mjs`, `repo.mjs`, `issues.mjs` (git/gh/glab), `calendar.mjs` (Apps Script), `ai.mjs` (`claude -p`), `vault.mjs` (Obsidian), `backup.mjs` (pg_dump-style SQL export), `context.mjs` (Windows-only PowerShell foreground-title probe).
- Surviving DB tables: `project`, `item`, `event`. Removed: `activity`, `issue`, `resume_card`, `repo_state`, `cal_event`, `review`.
- `main/place.mjs` is already OS-agnostic (pure math over Electron `display`/`workArea` data) — no changes needed there.
- Electron `^43.2.0`, `pg ^8.13.0`, no other native deps today. `electron-builder` currently targets `nsis`/x64 only.

## Standard Architecture

### System Overview (target state)

```
┌──────────────────────────────────────────────────────────────────┐
│  Renderer (unchanged: vanilla JS, no framework)                  │
│  ┌──────────────────┬───────────────┬─────────────────────────┐ │
│  │ today.js/.html    │ capture.js/   │ view.js / md.js / icons │ │
│  │ (issues/review    │ .html         │ (pure, tested)          │ │
│  │  tabs removed)    │               │                         │ │
│  └──────────────────┴───────────────┴─────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
              │ preload.cjs (IPC bridge, unchanged shape)
              ▼
┌──────────────────────────────────────────────────────────────────┐
│  main/ipc.mjs (NEW — extracted from index.mjs)                   │
│  Handlers for capture/item/project/settings/export/import only.  │
│  Deleted namespaces: issue:*, review:*, resume:*, calendar:*      │
└──────────────────────────────────────────────────────────────────┘
              │
   ┌──────────┼───────────────────────────────┐
   ▼          ▼                               ▼
┌────────┐ ┌────────────────┐        ┌──────────────────┐
│ capture│ │ store.mjs (NEW) │        │ jobs.mjs (NEW)    │
│ path:  │ │ replaces db.mjs │        │ replaces the      │
│ synchr-│ │ node:sqlite,    │        │ setInterval/       │
│ onous  │ │ WAL, versioned  │        │ setTimeout block   │
│ insert │ │ migrations,     │        │ at index.mjs:1408+ │
│ into   │ │ project/item/   │        │ (brief only; no    │
│ store, │ │ event tables    │        │ collect/AI/cal)    │
│ JSONL  │ └────────┬────────┘        └──────────┬────────┘
│ file as│          │                             │
│ fallb- │          ▼                             ▼
│ ack    │  ┌──────────────────┐          ┌──────────────────┐
└───┬────┘  │ export-import.mjs│          │ platform/ (NEW)   │
    │       │ human-readable   │          │ tray.mjs, hotkey. │
    │       │ JSON dump/load + │          │ mjs, notify.mjs,  │
    │       │ one-time pg→embed│          │ login.mjs — thin  │
    │       │ migration CLI    │          │ OS branches       │
    │       └──────────────────┘          └──────────────────┘
    └──────────────────────────────────────────┘
                     ▼
         userData/whenwork.sqlite (+ .wal, .shm)
         userData/queue.jsonl  (emergency fallback only)
```

### Component Responsibilities

| Component | Responsibility | File(s) |
|-----------|-----------------|---------|
| Capture path | Take one line of text, resolve `#abbr`, write it durably with zero dependencies on the rest of the app being healthy | `main/parse.mjs` (kept), capture write function in `store.mjs` |
| Store | Own the embedded database: schema, migrations, CRUD for project/item/event, WAL checkpointing | `main/store.mjs` (replaces `main/db.mjs`) |
| Emergency queue | Last-resort durability net for the rare case the store write itself throws (disk full, file locked, corruption) | `main/queue.mjs` (kept, radically shrunk) |
| IPC | Translate renderer requests to store/settings/export calls | `main/ipc.mjs` (new, carved out of `index.mjs`) |
| Lifecycle | App/window/tray/menu bootstrap, hotkey registration, quit handling | `main/lifecycle.mjs` (new, carved out of `index.mjs`) |
| Jobs | The handful of surviving timers: queue flush (if kept), morning brief, WAL checkpoint/prune | `main/jobs.mjs` (new) |
| Platform shims | Anything that differs Windows vs macOS: login-item flags, notification quirks, tray icon template mode, accessibility-permission prompts | `main/platform/*.mjs` (new) |
| Export/Import | Human-readable full-data export; import validation; one-time Postgres→embedded migration | `main/migrate.mjs` (new) |
| Settings | JSON config I/O, debounced writes | `main/settings.mjs` (kept as-is) |
| Window placement | Pure position math | `main/place.mjs` (kept as-is, already OS-agnostic) |
| Renderer | Today view + capture view, minus issues/review tabs | `renderer/today.js`, `renderer/capture.js` (trimmed) |

## Q1 — Storage boundary: does the JSONL queue collapse into the store?

**Recommendation: collapse it, but keep a minimal emergency fallback. Do not keep the current two-stage queue→drain→DB design.**

Reasoning:

- The JSONL queue exists today to survive a **remote, sometimes-down** dependency (`pg.Pool` over a Docker Postgres that may not be running — see `main/db.mjs:1`'s own comment: "DB는 캡처 경로 밖에 있다"). That reason disappears once storage is embedded: the "store" is a file on the same disk, opened by the same process, with no network hop and no separate service to be down. A capture and a store write become the same kind of operation (local, synchronous, same-process).
- `node:sqlite`'s `DatabaseSync` is a **synchronous** API — an `INSERT` returns or throws immediately, same execution shape as today's `fs.appendFileSync()` in `queue.mjs:13`. So "write straight to the store" preserves the current synchronous-capture guarantee instead of weakening it.
- SQLite **WAL mode** gives you the crash-durability property the JSONL file was providing by being append-only: a `COMMIT` is durable in the WAL before it's merged into the main file, and on next open SQLite replays the WAL to reach a consistent state. This is the direct SQL analogue of "append-only, replay on restart."
- Collapsing removes the exact component flagged in CONCERNS.md as fragile ("Queue drain file replacement" — read/consume/re-read-tail/rename race) **for free**, because there is no more drain step to race.

But keep a **thin emergency fallback**, because "capture never fails" is the one guarantee this project explicitly will not trade away (PROJECT.md Core Value):

- Wrap the capture write: `try { store.insertCapture(entry) } catch { queue.append(entry) }`. Keep `queue.mjs`'s `append()`/`readAll()` almost verbatim — it's dependency-free and already correct for its one remaining job.
- The failure modes this guards against are narrow and rare (SQLite file locked by an AV scanner, disk full mid-write, WAL file corruption, first-run permission error) — not the routine "DB is down" case that justified the old architecture.
- Drain this fallback file **once, at startup, before opening the store for normal traffic**, not on a recurring timer while the app is live. Because it only fires after a store-write exception (an exceptional path, not the steady state), there is no concurrent-append-during-drain window in normal operation — which is exactly the race that broke the old design. If a capture happens to hit the fallback file while a startup drain is mid-flight (edge case: crash-relaunch-loop), keep the same reread-tail-and-rename pattern from today's `queue.mjs:36-61`, but scope it to "only runs once per process lifetime, not every 30s" so the exposure window shrinks by orders of magnitude.
- Do not build a generic bi-directional sync between two durable stores (queue + DB) anymore — that symmetry was the source of the race. The relationship becomes asymmetric: store is primary, JSONL is a rarely-touched safety net, drained once and truncated.

**Net effect on `main/queue.mjs`:** shrinks from "the offline-first buffer for a remote DB" to "the disk-full/locked-file safety net," and its test surface shrinks with it (no more drain-race test needed once drain-while-live is removed).

## Q2 — Deletion order for collect/issues/calendar/ai/vault/backup/context + issues/review tabs

**Recommendation: delete leaf-dependency modules before touching `index.mjs`'s job scheduler, and delete the job scheduler before deleting the DB tables those jobs write to. Do the renderer tab removal last, once the IPC surface it calls no longer exists.**

Dependency facts pulled from `main/index.mjs` imports (`main/index.mjs:19-39`) and `ARCHITECTURE.md`'s "Circular imports: None" note — this is a strict DAG, which makes order safe to reason about:

```
ai.mjs            → (subprocess only, no internal deps)
collect.mjs        → db
repo.mjs            → db
issues.mjs          → db
calendar.mjs        → db
vault.mjs           → (fs only)
backup.mjs          → db
context.mjs         → (child_process only, Windows PowerShell)
index.mjs           → all of the above + queue + settings + place
```

Nothing in `collect/repo/issues/calendar/ai/vault/backup/context` imports another module from that set, and nothing outside `index.mjs` imports any of them. That means each one can be deleted independently, in any order, **as long as `index.mjs` stops importing and calling it first**. So the actual ordering constraint is inside `index.mjs`, not across these modules.

Concrete order:

1. **Kill the timers first** (`main/index.mjs:1408-1430`): remove `collectAll`/`setInterval`, `syncCalendarNow`/`setInterval`, `maybeReview`/`setInterval`, and the AI prewarm calls inside `collectAll`. This stops anything from calling into the doomed modules. Run the existing test suite here — `test/collect.test.mjs`, `test/calendar.test.mjs`, `test/repo.test.mjs` will now be orphaned; delete them in the same commit as their module (step 3), not before, so you never have a window where tests reference deleted files.
2. **Remove the IPC handlers** that surface these features (`issue:*`, `review:*`, `resume:*`, `calendar:*` namespaces, "sync now" actions) from `main/index.mjs`. This is safe once step 1 removed their only callers.
3. **Delete the modules themselves** one at a time, each as its own commit, in this order (safest-to-riskiest, so a mistake surfaces early and cheaply):
   - `context.mjs` — Windows-only, already isolated, zero DB coupling, its own test file. Deleting it first also lets you immediately start the macOS-parity work (Q3) without a stale Windows-only capture-context field confusing that work.
   - `vault.mjs` — fs-only, no DB coupling.
   - `calendar.mjs` — DB-coupled but single table (`cal_event`), no cross-module fan-out.
   - `repo.mjs` then `issues.mjs` — `issues.mjs` doesn't import `repo.mjs` directly today, but both feed the same "issues tab" concept in the renderer, so grouping them keeps the renderer change (step 5) a single coherent commit.
   - `collect.mjs` — depends on nothing else in this list; delete after `repo`/`issues` so the renderer's "activity" concept in the issues/today tabs disappears alongside its data source.
   - `backup.mjs` — delete last of this group, *after* export/import (Q4) exists, so there's no gap where the app has neither the old SQL-dump backup nor the new export.
   - `ai.mjs` — can technically go anytime since it's subprocess-only, but leaving it until here means `claude -p` stays available as a manual escape hatch while you're mid-refactor, in case you want to sanity-check something against the old resume-card logic before it's gone.
4. **Drop the now-dead DB tables** (`activity`, `issue`, `resume_card`, `repo_state`, `cal_event`, `review`) from the schema — but only as part of the Q1/store rewrite (`db.mjs` → `store.mjs`), not as a live `ALTER TABLE DROP COLUMN`/`DROP TABLE` migration against the Postgres instance. Since Q4's one-time migration reads *from* Postgres and writes *into* the new embedded store, the simplest and safest move is: the new store's schema simply never creates those tables. Nothing needs to "migrate away" data you're not carrying forward — the one-time import step (Q4) just doesn't select from them.
5. **Remove the renderer tabs** (`issues`, `review`) from `renderer/today.js`/`today.html` last, once no IPC channel exists for them to call — this way a stray click during development fails loudly (channel not found) rather than silently hitting dead code.

Keeping tests green during removal: delete a module's `.test.mjs` file in the same commit as the module (`git rm main/collect.mjs test/collect.test.mjs`) so `npm test` never has a dangling reference and never has a false gap where an untested module still exists. Run `npm test` after every single-module commit in step 3, not just at the end of the phase — the whole point of one-module-per-commit is a bisectable failure point.

## Q3 — Cross-platform: where do OS branches live?

**Recommendation: one `main/platform/` directory, one file per concern, each exporting the same function signature Windows and macOS both implement — never an inline `if (process.platform === 'darwin')` scattered through `index.mjs`.**

Current state: `index.mjs` already has scattered platform assumptions (`app.setLoginItemSettings` at `main/index.mjs:1017` and `:1413`, `new Tray()` at `:1397`, `globalShortcut.register(HOTKEY, ...)` at `:1406`, `new Notification(...)` at three call sites). None of it is currently branched by OS because the app has only ever shipped for Windows. Adding macOS means every one of these needs a decision, and per the research below each has a real platform difference:

| Concern | Windows | macOS | Source |
|---------|---------|-------|--------|
| Tray icon | Regular PNG, any size convention | Should use a template image (`nativeImage` with `.template` naming) so it adapts to light/dark menu bar; icon should be small (~16-22px) | Electron `Tray` docs pattern (menu-bar convention) |
| Tray position persistence | N/A (Windows keeps it) | `tray.setAutosaveName()` needed on recent Electron (added Electron 38) to keep position across launches | Electron release notes |
| globalShortcut | Reliable | Known bug: doesn't work with non-QWERTY layouts; on macOS 10.14+ accelerators can silently fail to register unless the app is authorized as a trusted accessibility client | Electron GitHub issues / docs |
| Notification | Native toast, works out of the box | Needs a proper `app.setAppUserModelId`-equivalent (bundle id) and, unlike Windows, silently no-ops if Notification permission/Do Not Disturb blocks it — no error thrown | Electron `Notification` docs |
| Login item | `app.setLoginItemSettings({ openAtLogin, args })` works directly | Same API works but on macOS 13+ Apple's newer `SMAppService`-backed path is what Electron uses under the hood; unsigned apps can trigger extra Gatekeeper friction on the login-item toggle itself | Electron docs / macOS launch-agent conventions |
| Foreground-window context (`context.mjs`) | PowerShell + Win32 `user32.dll` calls — being deleted per PROJECT.md, not reimplemented | No equivalent shipped; if ever revived, would need Accessibility API entitlement (different problem class entirely) | Existing code (`main/context.mjs`), PROJECT.md Active list |
| Dock icon | N/A | macOS shows a Dock icon by default for a windowed app; a tray-only app should call `app.dock.hide()` on darwin so it behaves like a menu-bar utility, not a normal Dock app | Electron `app.dock` API (macOS-only namespace) |

Structure:

```
main/platform/
  tray.mjs        // createTray(iconPath) — internally branches template-image naming for darwin
  hotkey.mjs       // registerHotkey(accelerator, cb) — same call on both, but centralizes the
                    // macOS non-QWERTY/accessibility-permission fallback messaging in one place
  notify.mjs        // notify(title, body) — wraps `new Notification`, same call shape both OSes,
                    // but is the one place that would later grow a macOS DND-aware warning
  login.mjs          // setLaunchAtLogin(bool) — same Electron call both OSes; isolated so any
                      // future macOS SMAppService quirk is a one-file change
  dock.mjs            // hideDockIcon() — no-op on win32, app.dock.hide() on darwin
```

Each module does `if (process.platform === 'darwin') { ... } else { ... }` **internally**, and `index.mjs`/`lifecycle.mjs` just calls `tray.createTray(...)`, `hotkey.registerHotkey(...)`, etc., with no OS knowledge at the call site. This is the direct fix for the "where should OS branches live" question: **never at the call site, always inside the platform module**, so `lifecycle.mjs` reads identically regardless of which OS it's running on, and adding a third OS later (hypothetically) only touches these five files.

This mirrors the existing good pattern already in the codebase: `place.mjs` is pure/OS-agnostic and is called uniformly — `platform/*.mjs` should be the same shape, just with real branches where the OS genuinely differs instead of none.

## Q4 — Export/import and one-time Postgres → embedded migration

**Recommendation: two separate, separately-timed components sharing one core (de)serialization module. Do not build "migration" as a special case of "export/import" or vice versa — they have different lifetimes and different trust boundaries.**

- `export-import.mjs` (permanent, ships to every user): `exportAll()` reads `project`/`item`/`event` from the embedded store and writes one human-readable JSON file (matches PROJECT.md's "사람이 읽을 수 있는 형식으로 내보내고, 다시 가져올 수 있다" requirement). `importAll(file)` validates structure/types before writing anything, and should run inside a single SQLite transaction so a bad import can't half-apply.
- `migrate-legacy.mjs` (one-time, personal-use only, not shown in the public UI per PROJECT.md's "공개판 사용자에게는 보이지 않아도 된다"): a standalone script/CLI that opens the *existing* `pg.Pool` connection (the only remaining place `pg` is imported once `db.mjs` is retired), reads `project`/`item` (and `item.context` — PROJECT.md explicitly calls out preserving `context`, the captured foreground-window title, during this one migration even though new captures won't populate it on macOS), and calls the *same* `store.mjs` insert functions the live app uses — not a hand-rolled SQL translator. This guarantees the migrated data is byte-for-byte what the new app would have produced natively, and it means `migrate-legacy.mjs` has almost no logic of its own: it's Postgres-read + store-write, reusing `store.mjs`'s own validation.
- Both should reuse one shared shape-definition (a plain object schema/type describing `project`/`item`/`event` records) so export, import, and legacy-migration all agree on field names and can't drift from each other.
- Keep `pg` as a dependency scoped to `migrate-legacy.mjs` only (or even as a separate one-off script outside the shipped app bundle, run manually once) — it should not appear in the packaged app's `dependencies` once the personal migration is done, so `electron-builder` output for public releases carries zero Postgres footprint. This directly serves the "외부 서비스·CLI·컨테이너 없이" (no external services/CLI/containers) requirement.

Data flow:

```
[one-time, personal machine only]
PostgreSQL (pg.Pool) --read--> migrate-legacy.mjs --calls--> store.mjs insert fns --> whenwork.sqlite

[every user, every release]
whenwork.sqlite --read--> export-import.mjs.exportAll() --> whenwork-export-YYYY-MM-DD.json
whenwork-export-*.json --validate--> export-import.mjs.importAll() --write(txn)--> whenwork.sqlite
```

## Q5 — Should `main/index.mjs` be split?

**Recommendation: yes, and it should happen as step 0 of this milestone, before any deletion work, not as an afterthought once modules are gone.**

Reasoning specific to this milestone (not a generic "big files are bad" argument): once `collect/issues/calendar/ai/vault/backup/context` are deleted, `index.mjs` loses most of its background-job code and most of its OS-specific code in the same pass — meaning the deletion work and the split work touch **the same lines**. Doing the split first means:

- Deletion becomes "delete a whole file" (`jobs.mjs`'s `collectAll`/`syncCalendarNow`/`maybeReview` calls) instead of "carefully excise 200 scattered lines from a 1479-line file while hoping not to break an unrelated handler two screens away."
- The Q3 platform-branch extraction and the Q2 module-deletion work can proceed in parallel once the split exists, because they land in different new files (`platform/*.mjs` vs `jobs.mjs`) instead of both editing `index.mjs` simultaneously.
- CONCERNS.md already names this exact split as the fix for "Large monolithic main file" (`main/index.mjs` 1479 lines) — this milestone is the natural occasion to do it, since roughly half the file's reason to exist is being deleted anyway.

Split shape (four files, matching CONCERNS.md's own suggested fix plus `platform/` from Q3):

- `main/lifecycle.mjs` — `app.whenReady()`, window creation (`getCaptureWin`/`getTodayWin`), tray/menu construction (calling into `platform/tray.mjs`), quit handling.
- `main/ipc.mjs` — all `ipcMain.handle`/`.on` registrations, calling into `store.mjs`/`settings.mjs`/`export-import.mjs`.
- `main/jobs.mjs` — the surviving `setInterval`/`setTimeout` block: queue-fallback drain (if any), `maybeBrief`, WAL checkpoint/prune. Everything currently at `main/index.mjs:1408-1430` that isn't being deleted lands here.
- `main/index.mjs` — shrinks to a thin entry point: import the above, wire them together, nothing else.

## Suggested Build Order (dependency-driven)

This directly answers "suggest build order with dependencies" from the milestone context. Ordering rule: **do the change that de-risks the most subsequent work first, and never do two structural changes to the same file in the same phase.**

1. **Split `main/index.mjs`** (Q5) into `lifecycle.mjs`/`ipc.mjs`/`jobs.mjs` with *zero behavior change* — pure move, verified by the existing test suite + smoke test passing identically before and after. This is pure refactor risk with no feature risk, so do it while the app still has Postgres/AI/git behind it and the smoke test still exercises the full surface as a safety net.
2. **Build the storage boundary** (Q1): `store.mjs` with `node:sqlite`, WAL, versioned migrations, `project`/`item`/`event` schema only. Build and test it standing alone (unit tests against a temp `.sqlite` file, no Electron needed — mirrors how `queue.mjs`/`place.mjs` are tested today). Wire the emergency-fallback JSONL path. This has to exist before deletion work because deletion (step 3) removes the Postgres-coupled code that currently satisfies “where does data live,” and before migration (step 4) because migration writes into it.
3. **Delete the doomed modules** (Q2), one per commit, in the order given above, now that `store.mjs` already exists as the landing zone and `jobs.mjs` already exists as the place to remove timers from. `db.mjs` itself is deleted at the end of this step, once nothing references it — this is also the moment `pg` can be removed from the shipped app's `dependencies` (kept only for the migration script, per Q4).
4. **Build export/import + legacy migration** (Q4), reusing `store.mjs`'s insert functions. Run the legacy migration once, for real, against your personal Postgres data, and verify the result in the new app before decommissioning `docker-compose.yml`/the Postgres container. This is naturally sequenced after step 3 (no more `db.mjs` to confuse with `store.mjs`) and gives you a working, fully-migrated personal install to dogfood the rest of the milestone on.
5. **macOS platform work** (Q3): build `platform/*.mjs`, get a macOS machine, verify tray/hotkey/notification/login-item/dock behavior there. This is ordered last among the structural work because it's the piece requiring physical macOS hardware (PROJECT.md: "macOS 검증 장비 확보가 전제") and because by this point the app is already down to its final feature set — there's no value in debugging macOS quirks against code that's about to be deleted.
6. **Renderer cleanup** (remove issues/review tabs, de-personalize copy) — last, once the IPC surface underneath it is final, so a stray reference to a removed channel fails immediately and visibly during this pass rather than earlier when it would be noise against unrelated changes.
7. **electron-builder dual-target + test/smoke on both OSes** — genuinely last: it validates the sum of everything above (no native-module rebuild step needed since `node:sqlite` ships inside Electron's bundled Node, per the STACK research; both a Windows NSIS and a macOS DMG/ZIP target build from the same `files`/`build` config with OS-specific keys added).

**Why not storage-first-then-split, or deletion-first-then-storage:** doing deletion before the storage boundary exists means you're editing `db.mjs`'s Postgres schema to drop tables you're about to replace anyway — wasted motion. Doing storage before the split means `store.mjs`'s call sites in `index.mjs` get built once, then immediately rewired again when the split happens — also wasted motion. The order above touches each file exactly once for its structural purpose.

## Anti-Patterns to Avoid

### Anti-Pattern 1: Reintroducing a two-stage queue "just in case"

**What people do:** Keep the full `append()`/`drain()`/re-read-tail pattern from today's `queue.mjs` as the *primary* write path into the new embedded store, out of caution.
**Why it's wrong:** It reintroduces the exact race CONCERNS.md flags, for a failure mode (remote DB down) that no longer exists once storage is embedded and local. It also means every capture pays a double-write cost (JSONL append + later SQLite insert) for no durability benefit WAL doesn't already provide.
**Do this instead:** Write straight to the WAL-mode store; keep JSONL only as an exception-triggered fallback, drained once at startup.

### Anti-Pattern 2: Treating SQLite schema evolution like the old Postgres inline-idempotent block

**What people do:** Port `main/db.mjs`'s `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` block verbatim into `store.mjs`.
**Why it's wrong:** SQLite's `ALTER TABLE ADD COLUMN` has no `IF NOT EXISTS` clause — running the Postgres-style block a second time throws "duplicate column name" and crashes startup on the second launch.
**Do this instead:** Use `PRAGMA user_version` and a small ordered array of migration functions (`migrations[0]` creates the base schema, `migrations[1]` adds a column, etc.), applying only the ones newer than the stored version — the standard SQLite migration idiom.

### Anti-Pattern 3: Scattering `process.platform` checks at call sites

**What people do:** Add `if (process.platform === 'darwin') { ... } else { ... }` directly inside `lifecycle.mjs`/`ipc.mjs` wherever a tray/hotkey/notification call happens.
**Why it's wrong:** Every future OS-specific bugfix has to be found by grepping for `platform` across unrelated files; the two OS code paths for the "same" feature end up far apart in the file and drift out of sync.
**Do this instead:** One `platform/*.mjs` file per concern (Q3), each exposing an OS-agnostic function signature; the branch lives inside the module, never at the call site.

## Sources

- Node.js official docs, `node:sqlite` module — https://nodejs.org/api/sqlite.html (confidence: MEDIUM — official docs, cross-checked against community coverage)
- Electron 43 release notes (Node v24.17.0 bundled) — https://www.electronjs.org/blog/electron-43-0, https://releases.electronjs.org/release/v43.1.0 (confidence: MEDIUM — official release notes)
- Node.js SQLite stability discussion (flag removed since 22.13.0/23.4.0, RC status in 24.x) — https://github.com/nodejs/node/issues/53906, https://beta.docs.nodejs.org/sqlite.html (confidence: MEDIUM — cross-checked against Node docs)
- SQLite official docs, Write-Ahead Logging — https://www.sqlite.org/wal.html (confidence: MEDIUM — primary/official source)
- SQLite official docs, ALTER TABLE (no `ADD COLUMN IF NOT EXISTS`) — https://sqlite.org/lang_altertable.html (confidence: MEDIUM — primary/official source)
- Electron official docs — `Tray`, `globalShortcut`, `Notification`, `app.dock` — https://www.electronjs.org/docs/latest/api/tray, https://www.electronjs.org/docs/latest/api/global-shortcut (confidence: MEDIUM — official docs; cross-checked against GitHub issue reports of real-world quirks)
- `better-sqlite3` + `electron-builder` native-module rebuild discussion — https://github.com/electron-userland/electron-builder/issues/5317, https://github.com/WiseLibs/better-sqlite3/issues/1111 (confidence: LOW-MEDIUM — community reports, informs the recommendation to prefer `node:sqlite` and avoid native-module rebuild risk entirely)
- Existing codebase: `.planning/codebase/ARCHITECTURE.md`, `STRUCTURE.md`, `CONCERNS.md` (2026-09-14 mapping); `main/queue.mjs`, `main/db.mjs`, `main/index.mjs`, `main/context.mjs`, `main/place.mjs`, `main/settings.mjs`, `package.json` (confidence: HIGH — read directly from the repository)

---
*Architecture research for: Offline-first Electron tray to-do app, embedded storage migration*
*Researched: 2026-09-14*
