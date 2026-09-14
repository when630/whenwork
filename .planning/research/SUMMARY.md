# Project Research Summary

**Project:** WHENWORK — 개인용 → 공개 미서명 Windows+macOS 퀵캡처 트레이 앱
**Domain:** Offline-first Electron tray/menu-bar quick-capture to-do app; subsequent milestone (subtract-and-replatform, not greenfield)
**Researched:** 2026-09-14
**Confidence:** MEDIUM-HIGH

## Executive Summary

This milestone is not a new build; it is a subtraction-and-replatform on a working, dogfooded app. The four research streams converge on one low-risk core decision and one high-discipline execution challenge. The low-risk decision: replace PostgreSQL/Docker with node:sqlite (built into Electron 43 bundled Node 24.17.0) rather than better-sqlite3. Because node:sqlite requires zero native modules, it eliminates the single biggest packaging risk this milestone would otherwise face -- ABI mismatches, asarUnpack misconfiguration, and macOS universal-build fat-binary conflicts, all flagged independently by both STACK.md and PITFALLS.md as the top two critical pitfalls of the alternative path. Choosing node:sqlite largely neutralizes that entire pitfall category before it can occur; keep better-sqlite3 only as a documented Plan B behind the same store.mjs boundary.

The high-discipline challenge is everything else: this milestone deletes six modules (collect, repo, issues, calendar, ai, vault, backup, context) and their DB tables, rewrites the storage layer, adds a one-time personal PostgreSQL migration, and ships a second OS (macOS) for the first time -- all while preserving the app one non-negotiable guarantee ("capture is never lost"). PITFALLS.md most load-bearing warning is that feature removal in a vanilla-JS/no-type-system codebase is deceptively easy to leave half-done (renderer tab deleted, but IPC handler, preload bridge, settings key, DB table, or test all still present) -- rated critical precisely because "looks done" is trivial to achieve and easy to mistake for "is done." The second-most load-bearing risk is macOS being an entirely new target: unsigned Gatekeeper friction, silent globalShortcut failures, and setLoginItemSettings requiring signing to work reliably are documented platform gaps Windows-only development to date has never surfaced.

Recommended approach: split main/index.mjs first (pure refactor, zero behavior change, still backed by the full Postgres/AI-era test suite as a safety net), then build the new store.mjs storage boundary standing alone, then delete the doomed modules one-per-commit with a mandatory grep-verification gate, then build export/import plus the one-time migration reusing store.mjs own insert functions, then tackle macOS platform branches last (once the feature surface is final and does not need a real macOS machine to iterate on doomed code first). Cross-cutting risks -- the capture-queue crash-safety guarantee, and the public-repo git-history secret scan before any repo goes public -- must be explicit completion gates in whichever phase touches storage/deletion, not deferred as "someone will get to it."

## Key Findings

### Recommended Stack

Almost the entire stack (Electron 43.2.0, vanilla JS renderer, node --test, electron-builder 26.15.3) is already in place and unchanged this milestone. What is new: node:sqlite (primary storage, zero native deps, RC-stability in Node 24 -- acceptable because Electron pins the Node version for every user, removing the usual "will the OS Node upgrade break this" risk), better-sqlite3@13.0.3 (documented fallback only, behind the same module boundary), plain JSON.stringify/fs for export/import (human-readable, engine-agnostic, doubles as the migration script intermediate format), csv-stringify@6.8.3 (bonus export convenience only, not the round-trip format), and electron-builder already-present mac target (config-only addition -- no version bump, no new package). pg moves from dependencies to a personal-only migration script and is removed from the shipped app entirely.

**Core technologies:**
- node:sqlite (DatabaseSync): embedded relational storage, replaces PostgreSQL -- synchronous API matches existing db.mjs calling style; zero native-module packaging risk
- better-sqlite3@13.0.3: named fallback only, if node:sqlite RC-stage API proves insufficient -- swap is contained to store.mjs
- JSON (stdlib): primary export/import format -- human-readable per requirement, and the shared intermediate format for the one-time PostgreSQL migration
- electron-builder mac target (dmg+zip, unsigned): config-only addition to already-installed electron-builder -- no code changes needed

### Expected Features

**Must have (table stakes) -- gaps to close this milestone:**
- Hotkey conflict detection plus rebinding UI -- globalShortcut.register() silently fails when another app owns the combo; currently no UI surfaces this
- Launch-at-login toggle, explicitly verified on a real unsigned macOS build -- Electron docs state this can silently fail unsigned/unnotarized
- Notification permission handling with graceful fallback for the morning brief -- macOS notifications can be silently denied
- Tray discoverability first-run hint (per-OS phrasing) -- both OSes hide/bury tray icons by default
- Unsigned-install README with per-OS screenshots (SmartScreen + Gatekeeper) -- zero code cost, prevents "looks malicious" abandonment

**Must have (already built, must survive the swap unchanged):**
- Append-only local capture queue -- the project core differentiator; must not be weakened during the storage swap
- Hash-abbreviation inline project tagging, today view, manual inbox classification, waiting-for view, morning brief core logic, keyboard-driven UI

**Should have / correctly scoped (differentiators):**
- Human-readable export/import -- data ownership without sync, an Active requirement
- "No AI, no account, no sync" positioned as a positive trust pitch, not a gap

**Defer / explicitly rejected (do not build):**
- Code signing, auto-update, cross-app import interoperability, AI classification, calendar integration, multi-level subtasks -- all correctly already Out of Scope in PROJECT.md and independently corroborated as reasonable exclusions by feature research

### Architecture Approach

Target shape: main/index.mjs (1479 lines today) splits into lifecycle.mjs / ipc.mjs / jobs.mjs; main/db.mjs is replaced by main/store.mjs (node:sqlite, WAL, PRAGMA user_version-driven migrations, project/item/event only); main/queue.mjs shrinks from a full queue-then-drain buffer to a rarely-touched exception-triggered fallback, drained once at startup rather than on a recurring timer; a new main/platform/ directory holds one file per OS-varying concern (tray, hotkey, notify, login, dock), each exposing an OS-agnostic function signature with the branch living inside the module, never at the call site; main/migrate.mjs/export-import.mjs share one (de)serialization shape across export, import, and the one-time legacy migration.

**Major components:**
1. store.mjs -- owns schema, versioned migrations, CRUD for project/item/event, WAL checkpointing (replaces db.mjs)
2. platform/*.mjs -- one function-signature-matched module per OS-varying concern (tray/hotkey/notify/login/dock), branch lives inside, never at call sites
3. export-import.mjs / migrate-legacy.mjs -- permanent human-readable export/import (ships to every user) vs. one-time personal Postgres migration (author-only, never shown in public UI) -- two separately-timed components sharing one schema shape, not one built as a special case of the other
4. queue.mjs (shrunk) -- exception-only emergency fallback, not the primary write path once storage is embedded and local

### Critical Pitfalls

1. **Dead code after "feature removal"** -- renderer tab deleted but ipcMain.handle, preload.cjs bridge function, settings.json key, DB table, or test file left behind. Avoid with a mandatory per-feature checklist (UI, preload, IPC, module file, settings schema, DB table, test) and a grep-to-zero gate on every removed module name across the whole codebase.
2. **Queue/store crash-race inherited across the storage swap** -- the existing queue.mjs drain race (read, consume, re-read-tail, rename) is not automatically fixed by switching storage engines; must be explicitly redesigned (atomic rename, startup-only drain) and verified with an actual forced-kill-during-capture test, not assumed safe. This is the project Core Value; never defer it to a later phase.
3. **PostgreSQL migration silent corruption** -- timezone (timestamptz to naive string) drift, JSONB (item.context) double/under-encoding, and soft-delete rows resurrecting are all realistic one-shot-migration failure modes. Mitigate with UTC-everywhere storage, a round-trip parse test on context, an explicit deleted_at filtering decision, and a pre/post row-count diff -- plus preserving the original pg_dump in case of a bad run.
4. **Unsigned macOS Gatekeeper "damaged" first-run block** -- near-total non-developer abandonment if undocumented. Requires a top-of-README, screenshot-backed xattr -cr instruction, tested against an actual browser-downloaded (quarantine-flagged) copy, not just a locally-built one.
5. **git history exposing the old calendar webhook token** once the repo goes public -- must be scanned (git log -p --all) and either invalidated plus filter-repo'd or replaced with a fresh-history public repo, as an explicit final gate before flipping repository visibility -- not folded into the feature-removal work itself.

## Implications for Roadmap

### Phase 1: Structural split (no behavior change)
**Rationale:** ARCHITECTURE.md Q5 argues this must happen first -- deletion and storage work in later phases both touch the same lines index.mjs currently holds; splitting first means each later phase edits a fresh, narrow file instead of a 1479-line monolith, and the existing Postgres/AI-era test suite is still available as a safety net while nothing behavioral has changed yet.
**Delivers:** main/lifecycle.mjs, main/ipc.mjs, main/jobs.mjs carved out of index.mjs, verified as a pure move (tests plus smoke pass identically before/after).
**Avoids:** doing two structural changes to the same file in the same phase (ARCHITECTURE.md explicit anti-pattern).

### Phase 2: Embedded storage plus queue crash-safety (combined, not split)
**Rationale:** This reconciles the one real cross-document tension. ARCHITECTURE.md build order puts storage before deletion (store.mjs must exist as the landing zone before old DB-coupled modules are removed, and before migration can write into it). PITFALLS.md separately argues deletion should happen early so the migration script does not have to care about soon-deleted tables (activity, issue, resume_card, repo_state, cal_event, review). These resolve cleanly once you notice PITFALLS.md actual concern is satisfied by ARCHITECTURE.md own design: the new store.mjs schema simply never creates the doomed tables in the first place -- nothing needs to "migrate away" data that was never being carried forward, since the one-time migration in Phase 4 selects only from project/item/event. So storage-before-deletion (ARCHITECTURE.md order) does not reintroduce the risk PITFALLS.md was warning about -- it only would if the new schema accidentally carried the old tables forward, which it explicitly does not. Recommended order stands: storage (Phase 2) before deletion (Phase 3), with the explicit design note that store.mjs schema omits the doomed tables by construction. Because node:sqlite needs no native module, PITFALLS.md native-module ABI/asarUnpack/universal-build pitfalls (its top two critical items) are structurally avoided by this stack choice -- flag them in this phase plan only as "verify avoided," not as active risks to mitigate.
**Delivers:** store.mjs (WAL, versioned migrations via PRAGMA user_version, project/item/event schema only), queue.mjs redesigned to an exception-only fallback drained once at startup, and a forced-kill-during-capture test proving zero capture loss.
**Avoids:** Pitfall 1/2 (native ABI/universal-build -- avoided by stack choice), Pitfall 8 (queue/store crash race -- must not be deferred, per PITFALLS.md own explicit instruction).
**Research flag:** needs a spike verifying node:sqlite API sufficiency (pragmas, transaction behavior) before committing further phases to it.

### Phase 3: Delete doomed modules plus dead-code verification gate
**Rationale:** Now that store.mjs exists as the landing zone and jobs.mjs exists as the place to remove timers from, each module (context, then vault, then calendar, then repo/issues, then collect, then backup, then ai, in that safest-to-riskiest order) can be deleted one-per-commit with npm test run after each.
**Delivers:** All six-plus modules removed at all layers (renderer/preload/IPC/module/settings-schema/DB-table/test), grep-to-zero verification on every removed module name, dead DB tables absent from the new schema (already true from Phase 2 design).
**Addresses:** PROJECT.md Active requirements to remove AI/git/calendar/vault dependencies.
**Avoids:** Pitfall 6 (dead code after "feature removal" -- the critical, easy-to-fake-done pitfall).

### Phase 4: Export/import plus one-time Postgres migration
**Rationale:** Naturally sequenced after storage exists and doomed modules are gone (no db.mjs left to confuse with store.mjs); reuses store.mjs own insert functions so the migrated data is guaranteed byte-identical to what native capture would produce.
**Delivers:** Permanent export-import.mjs (JSON export/import, shipped to every user) and one-time migrate-legacy.mjs (author-only, reads Postgres, writes via store.mjs), plus a dry-run, row-count-diff, and round-trip parse test as completion criteria.
**Avoids:** Pitfall 7 (timezone/JSONB/soft-delete silent corruption during migration) -- requires UTC-everywhere storage and explicit soft-delete filtering decision.

### Phase 5: macOS platform work
**Rationale:** Ordered last among structural work because it requires physical macOS hardware and because by this point the feature set is final -- no value debugging macOS quirks against code about to be deleted.
**Delivers:** main/platform/*.mjs (tray, hotkey, notify, login, dock), each with the OS branch inside the module not at call sites; hotkey conflict detection plus rebind UI verified on macOS specifically (silent isRegistered() true-but-not-working risk); notification permission fallback; launch-at-login verified on an actual unsigned build.
**Addresses:** Table-stakes gaps (hotkey conflict UI, launch-at-login verification, notification fallback, tray discoverability).
**Avoids:** Pitfall 4 (silent globalShortcut failure on macOS), Pitfall 5 (unsigned mac build config mistakes -- hardenedRuntime/identity:null must be set together).

### Phase 6: Renderer cleanup plus electron-builder dual-target release prep
**Rationale:** Last, since it validates the sum of everything above; renderer tab removal happens once the IPC surface beneath it is already final (a stray reference to a removed channel fails loudly, not silently).
**Delivers:** Issues/review tabs removed from renderer; both Windows NSIS and macOS DMG/ZIP targets building via electron-builder from the same config; smoke tests passing on packaged installs on both OSes; unsigned-install README (SmartScreen plus Gatekeeper instructions, screenshots); git-history secret scan gate before making the repo public.
**Avoids:** Pitfall 3 (Gatekeeper "damaged" block), Pitfall 9 (leaked calendar token in git history), Pitfall 10 (undocumented SmartScreen warning).

### Phase Ordering Rationale

- Structural split first because it is the only zero-risk step and de-risks every subsequent phase by giving each one a narrow, single-purpose file to edit instead of a 1479-line monolith.
- Storage before deletion (resolving the cross-document tension) because the new schema is designed to never create the doomed tables -- this satisfies PITFALLS.md underlying concern (migration should not target soon-deleted tables) without needing to reorder ARCHITECTURE.md dependency-driven sequence.
- Deletion before migration/export because migration/export code should be written against the final, doomed-module-free codebase, not against code about to change underneath it.
- macOS work last because it is the only phase requiring physical hardware and benefits from a final, stable feature surface to test against.
- Public-release gates (README, git history scan) last because they are irreversible-once-public steps that should be the final checklist, not woven into earlier phases.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 2 (embedded storage):** node:sqlite API sufficiency is MEDIUM confidence (RC-stability, less community track record than better-sqlite3) -- recommend a short spike/research-phase pass to confirm no missing pragma/feature before committing the full storage rewrite to it.
- **Phase 5 (macOS platform work):** MEDIUM confidence on active-window/accessibility-permission and login-item signing behavior -- these claims are inferred from general TCC/Electron documentation, not verified against this exact app; needs empirical verification on real hardware, likely worth a research-phase pass focused specifically on Accessibility permission flows for globalShortcut.

Phases with standard patterns (skip research-phase):
- **Phase 1 (structural split):** pure refactor, well-understood, existing test suite is the safety net.
- **Phase 3 (module deletion):** mechanical, dependency graph already mapped as a strict DAG in ARCHITECTURE.md; no unknowns.
- **Phase 4 (export/import/migration):** standard JSON serialization pattern; risk is in careful validation (timezone/JSONB/soft-delete), not in unknown technology.
- **Phase 6 (release prep):** electron-builder unsigned-build configuration is well-documented (official docs, Context7-sourced); README patterns for unsigned-app onboarding have existing community templates to copy.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH (storage choice, macOS build config) / MEDIUM (node:sqlite long-term stability, active-window TCC behavior) | Live npm registry checks plus official Electron/Node release docs for version facts; node:sqlite RC-stage maturity and macOS TCC permission-persistence-for-unsigned-apps are inferred/aggregated, not verified against this exact app |
| Features | MEDIUM | Cross-corroborated across 2+ independent sources per claim, but most individual sources are LOW-confidence web content (blogs, forums); the load-bearing platform-behavior claims (silent hotkey failure, login-item signing requirement, Notification failed event) are sourced from official Electron docs via Context7 and treated as HIGH within that subset |
| Architecture | MEDIUM | Electron/Node version facts cross-checked against official docs (HIGH); component-boundary and build-order recommendations are architectural judgment applied directly to the real codebase (read directly, HIGH for facts) rather than validated against third-party case studies |
| Pitfalls | MEDIUM | Official docs plus Electron/electron-builder GitHub issues cross-checked; actual macOS build/signing behavior and xattr/Gatekeeper flow are NOT yet empirically verified against this app -- flagged explicitly as needing field verification |

**Overall confidence:** MEDIUM-HIGH -- the core architectural and stack decisions are well-supported and largely de-risk each other (node:sqlite neutralizing the native-module pitfall category); remaining uncertainty is concentrated in macOS-specific runtime behavior that can only be resolved by testing on real hardware during Phase 5.

### Gaps to Address

- **node:sqlite API sufficiency:** unverified against this app actual query patterns (indexes, pragmas, transaction semantics) -- resolve via an early spike in Phase 2 before committing further phases to the rewrite.
- **macOS unsigned Gatekeeper/xattr instructions:** README guidance is templated from community sources, not yet tested against a real browser-downloaded (quarantine-flagged) copy of this specific app -- must be verified during Phase 6, not assumed correct from research alone.
- **macOS globalShortcut/Accessibility permission behavior:** isRegistered() can reportedly return true even when registration silently failed -- this specific behavior needs empirical confirmation on real macOS hardware during Phase 5, since it directly affects whether the hotkey conflict detection table-stakes feature can even be reliably implemented on macOS.
- **git history secret exposure:** not yet scanned; PITFALLS.md flags this as a mandatory gate before the repository is made public -- treat as an open action item, not yet resolved by research.

## Sources

### Primary (HIGH confidence)
- Context7 /electron-userland/electron-builder -- mac unsigned config, default targets, npmRebuild/asarUnpack behavior
- Context7 /wiselibs/better-sqlite3 -- Electron rebuild/asarUnpack requirements
- Node.js official docs (node:sqlite), Electron 43 release notes (electronjs.org/blog, releases.electronjs.org) -- bundled Node 24.17.0, node:sqlite RC status
- SQLite official docs -- WAL, ALTER TABLE (no ADD COLUMN IF NOT EXISTS)
- Electron official docs (Tray, globalShortcut, Notification, app.dock) via Context7
- Live npm registry queries -- better-sqlite3@13.0.3, csv-stringify@6.8.3, @electron/rebuild@4.2.0
- Existing codebase, read directly -- .planning/codebase/ARCHITECTURE.md, STRUCTURE.md, CONCERNS.md; main/queue.mjs, main/db.mjs, main/index.mjs, main/context.mjs, main/place.mjs, package.json

### Secondary (MEDIUM confidence)
- WebSearch aggregate (pkgpulse.com, sqg.dev, codenote.net) -- node:sqlite stability trajectory, "better-sqlite3 is the standard Electron pick" consensus
- electron/electron GitHub issues -- globalShortcut macOS quirks (non-QWERTY, silent registration failures)
- Community electron-builder plus native-module issue threads (WiseLibs/better-sqlite3#1111, electron-builder#5317) -- informs preference for node:sqlite over native modules
- Official Todoist help docs -- hash-Project inline quick-add syntax corroboration

### Tertiary (LOW confidence)
- Web comparison articles (Things vs OmniFocus vs Todoist, Superlist reviews) -- competitive feature landscape, single-source each but cross-corroborated across 2+ independent articles per claim
- DEV Community / Medium posts -- macOS Gatekeeper xattr workaround, universal-build native-module conflicts -- usable as README templates but not yet empirically verified against this app
- General TCC/Screen-Recording-permission documentation -- active-window library macOS behavior, informs "drop the feature" recommendation but not verified against a specific library issue tracker

---
*Research completed: 2026-09-14*
*Ready for roadmap: yes*
