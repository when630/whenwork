# Stack Research

**Domain:** Offline-first Electron tray to-do app — embedded storage migration + unsigned dual-OS distribution
**Researched:** 2026-09-14
**Confidence:** HIGH (storage choice, macOS build config) / MEDIUM (node:sqlite long-term stability, active-window TCC behavior)

**Scope note:** This is a *subsequent milestone* on an existing app. Electron 43.2.0, vanilla JS renderer, `node --test`, and electron-builder 26.15.3 are already in place and NOT re-evaluated here — see `.planning/codebase/STACK.md` for the existing baseline. This document covers only what changes: storage, export/import, migration, macOS packaging, and the foreground-window feature.

## Recommended Stack

### Core Technologies (changed/added this milestone)

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `node:sqlite` (built into Node) | Ships with Electron 43.2.0 → Node **24.17.0** (Electron 43 blog / releases.electronjs.org) | Embedded relational storage, replaces PostgreSQL | Zero native module. No `node-gyp`, no prebuilt-binary matrix, no `electron-rebuild`/`@electron/rebuild` step, no `asarUnpack` for a `.node` file. This directly eliminates the single biggest packaging risk named in this milestone's brief — "must survive electron-builder rebuild on both OSes" stops being a question because there is nothing to rebuild. The API (`DatabaseSync`) is synchronous, matching the existing `main/db.mjs` calling style. Status in Node 24 is **Stability 1.2 (Release Candidate)** — no longer behind a flag, API considered settled barring major issues. Because Electron pins its own bundled Node version (you don't control end-user Node upgrades), the "still experimental" label is far less risky here than in a generic server app: whatever RC behavior ships in Electron 43 is what every installed copy gets, forever, until you bump Electron. |
| `better-sqlite3` | **13.0.3** (npm, checked live) | Fallback embedded storage if `node:sqlite` proves insufficient | Documented as the standard pick for Electron + SQLite (multiple 2026 comparison sources concur: "if you are building a desktop app with Electron, better-sqlite3 is the package to pick"). Synchronous API, prebuilt binaries for common targets, and electron-builder has first-class handling for it (`npmRebuild` runs `@electron/rebuild` automatically before packaging; native `.node` files are auto-detected for `asarUnpack`). Keep this as the named Plan B, not the primary pick — see rationale below. |
| electron-builder `mac` target | Already-installed **26.15.3** (no version bump needed) | Add macOS `dmg` + `zip` targets alongside existing `nsis` | electron-builder's own default macOS targets are exactly `["zip", "dmg"]` when `mac.target` is unset (confirmed via electron-builder source, Context7). No extra packages needed — this is config-only. |
| GitHub Actions `macos-latest` + `windows-latest` matrix | n/a (CI config) | Build both installers per tag push, publish to GitHub Releases | electron-builder's own CI docs show this exact job shape; only difference from their signed example is *omitting* `CSC_LINK`/`CSC_KEY_PASSWORD`/`APPLE_*` secrets, which cleanly no-ops signing rather than requiring extra flags. |

### Why NOT to jump straight to better-sqlite3 as primary

This app is a solo/small-scale personal tool (single user, single machine, modest row counts — items/projects/events, not millions of rows). The properties better-sqlite3 wins on — SQLCipher-style encryption, maximum raw throughput, long production track record — are not this project's bottleneck. The project's actual constraint, stated explicitly in the brief, is **"must survive electron-builder packaging on both Windows and macOS."** `node:sqlite` answers that constraint directly by removing the native-module axis entirely, at the cost of an RC-stability label that matters little when Electron pins the Node version for you. If in practice `node:sqlite`'s API turns out to be missing something needed (e.g., a specific pragma, a corruption edge case, or Node 24.17's implementation has a bug), **fall back to better-sqlite3** — the migration path is a thin data-access module (`main/db.mjs` already isolates all SQL), so swapping the driver underneath is a contained change, not a rewrite.

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@electron/rebuild` | **4.2.0** | Native module rebuild for Electron target | Only needed if you fall back to `better-sqlite3` (or any other native dep). electron-builder invokes this internally via `npmRebuild: true` (default), so you typically don't call it directly — but pin it as a devDependency anyway so `npm run start`/local dev rebuilds match what CI does. Not needed at all if you stay on `node:sqlite`. |
| `csv-stringify` | **6.8.3** | CSV export convenience format | Use only for the human-readable **export** side, not as the round-trip format. Freeform Korean capture text will contain commas/quotes/newlines; hand-rolled CSV escaping is a known footgun. JSON should be the authoritative, re-importable export format (see below); CSV is a bonus "open in Excel" convenience, generated from the same in-memory rows, no separate schema to maintain. |
| Node built-in `JSON.stringify`/`fs` | n/a (stdlib) | Primary export/import format | No dependency needed. Export walks `project`/`item`/`event` tables to a single JSON document (array-of-rows per table, or one array of item objects with embedded project ref — pick whichever `main/db.mjs`'s existing query shapes make cheapest). Import re-validates and re-inserts. This is also the format the one-time PostgreSQL→embedded migration script should emit as an intermediate artifact (dump `pg` → JSON → load into `node:sqlite`), so the same import path is exercised by both migration and everyday export/import — one code path, two callers. |
| `pg` (existing, 8.13.0) | keep only in a migration-only script, remove from runtime `dependencies` | One-time PostgreSQL → embedded migration | Move from `dependencies` to a scratch/dev-only script (not shipped in the packaged app). The migration is "for the author only" per requirements — it should not ship in the public installer's `node_modules`. Simplest approach: a standalone `tools/migrate-from-postgres.mjs` that the author runs once locally against the still-running Docker Postgres, reading `item`/`project`/`event` and writing the same JSON shape the export/import feature already understands, then deletes `pg` from `package.json` dependencies entirely once migration is done. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `node --test` (existing) | Unit tests for new storage module | No new test framework needed; existing 187 tests already use this. Add a `main/db.test.mjs` (currently absent per codebase map) covering the new storage layer — this was flagged as a pre-existing gap and this milestone is the natural point to close it since `db.mjs` is being rewritten anyway. |
| GitHub Actions | CI build + release matrix | See workflow sketch below. |

## Installation

```bash
# Primary storage: no install needed — node:sqlite is built into the Node
# runtime Electron 43.2.0 already bundles (Node 24.17.0). Verify in your
# Electron main process with: node -e "console.log(process.versions.node)"
# (should print 24.x) and `import { DatabaseSync } from 'node:sqlite'`.

# Fallback storage (only if node:sqlite proves insufficient):
npm install better-sqlite3@13.0.3
npm install -D @electron/rebuild@4.2.0

# Export convenience (CSV):
npm install csv-stringify@6.8.3

# Remove once storage migration + author's one-time migration are done:
npm uninstall pg
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `node:sqlite` | `better-sqlite3` | If `node:sqlite`'s RC-stage API is missing a feature you need (e.g. custom functions, specific pragmas untested in your Node 24.17), or you hit a corruption/behavior bug specific to the built-in module. better-sqlite3 has a longer production track record and is explicitly documented as Electron-aware (troubleshooting docs cover `asarUnpack` + `electron-rebuild` directly). |
| `node:sqlite` / `better-sqlite3` | `sql.js` (wasm SQLite) | Only if you needed the DB to also run inside a sandboxed renderer with no Node access at all. Not this app's situation — `main/db.mjs` already runs in the main process with full Node access, so a slower, memory-resident wasm DB buys nothing and loses persistence-to-disk simplicity. |
| `node:sqlite` / `better-sqlite3` | LevelDB-family (`classic-level`, `leveldown`) | If the data model were pure key-value with no relational queries. This app's data (item/project/event with foreign keys, filters like "overdue AND not done") is relational; a KV store would force you to hand-roll indexing/joins that SQLite gives for free. |
| `node:sqlite` / `better-sqlite3` | `electron-store` / plain JSON file | Explicitly ruled out by the project's own constraint list ("사람이 직접 편집하는 파일 저장 — 동시 수정·손상을 앱이 감당해야 해서 내장 저장소로 대신한다"). Fine for `settings.json`-style config (and the app already does this, keep as-is), wrong for the item/project/event dataset which needs queries, not just key lookups. |
| JSON as primary export/import | Direct SQLite file copy as "export" | A raw `.sqlite` file is not "human-readable" per the requirement, and ties the export format to the storage engine's on-disk format (breaks if you ever swap `node:sqlite` → `better-sqlite3` later, or SQLite versions differ). JSON is engine-agnostic and satisfies "사람이 읽을 수 있는 형식". |
| `csv-stringify` | Hand-rolled CSV join | Only if you want zero new dependencies and are willing to defensively quote every field yourself. Given captured titles are freeform Korean text that will contain commas, the library is worth the ~15KB. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `pg` / any networked DB (PostgreSQL, MySQL, etc.) in the shipped app | Directly contradicts "설치 파일 하나로 실행" — requires Docker/a separate server process, exactly the dependency being removed this milestone | `node:sqlite` (or `better-sqlite3` fallback) |
| `sqlite3` (the classic `mapbox/node-sqlite3` package) | Async-callback API (worse fit for the existing synchronous call style in `db.mjs`), historically the most prebuild-fragile of the SQLite options across Electron versions, unmaintained-adjacent compared to better-sqlite3 | `node:sqlite` or `better-sqlite3` |
| PowerShell foreground-window script (existing `main/context.mjs` approach) | Windows-only by construction; cannot run on macOS at all | Drop the feature (see below), don't try to port the PowerShell script |
| `active-win` / `get-windows` (cross-platform foreground-window library) as a drop-in replacement | **Recommend dropping this feature entirely rather than replacing it.** Two independent reasons: (1) On macOS, reading another app's window title requires the **Screen Recording** TCC permission (Privacy & Security settings) since macOS 10.15+ — a confusing, easily-declined prompt for a non-technical "설치 파일 하나 받아 실행" user, and one that is documented to behave unreliably for **unsigned/ad-hoc-signed** binaries (permission grants tied to code signature; an unsigned rebuild can invalidate a previously-granted permission, forcing regrant on every update). This directly undermines the "no setup required" core value for a minor, non-essential feature. (2) The feature's value (labeling a captured item with the foreground window/meeting title) was a personal-workflow nicety, not a validated requirement in the Active list — it's absent from this milestone's Active requirements, only appearing as something to remove/split. | Remove `main/context.mjs` and the foreground-context field from new captures on both OSes. If migrating old data, carry forward the *existing* `item.context` values (historical) but stop writing new ones. If demand resurfaces later, revisit `active-win`/`get-windows` **after** code signing is added (currently out of scope, tagged for a future milestone) — signed builds don't have the permission-churn problem. |
| Auto-detecting native module rebuilds as an afterthought | If you do end up needing `better-sqlite3`, do NOT rely on default electron-builder auto-detection alone without verifying `asarUnpack` covers `**/node_modules/better-sqlite3/**` (or wherever its `.node` binary lands) — Context7-sourced electron-builder troubleshooting notes call this out as the most common Electron+better-sqlite3 packaging failure | Explicitly set `build.asarUnpack` and `build.npmRebuild: true` in `package.json`, and smoke-test the *packaged* app (not just `npm start`) on both OSes before release |

## Stack Patterns by Variant

**If `node:sqlite` works cleanly in a spike (recommended first step of the implementation phase):**
- Use it as the sole storage layer. No native-module CI concerns, no `asarUnpack`, no `@electron/rebuild`.
- Because `import { DatabaseSync } from 'node:sqlite'` only resolves inside a real Node/Electron main-process runtime (not in a bundler's browser-target resolution), keep the app's existing no-bundler, direct `.mjs` entry-point setup — do not introduce Vite/webpack for the main process. (A known community issue is Vite externalizing `node:sqlite` for "browser compatibility" when a bundler is inserted between source and Electron; this app currently has no such bundler, so the issue does not apply — keep it that way for the main process.)

**If a `node:sqlite` limitation is hit during implementation:**
- Swap to `better-sqlite3` behind the same `main/db.mjs` module boundary. Add `npmRebuild: true`, `asarUnpack: ["**/node_modules/better-sqlite3/**"]` to the `build` key in `package.json`, and add `@electron/rebuild` as a devDependency for local-dev parity with CI.

**For the GitHub Actions release workflow:**
- Use a `strategy.matrix.os: [windows-latest, macos-latest]` job, `npm ci`, then `npx electron-builder --win` / `--mac --publish always` per OS (or `--win --mac` combined isn't cross-buildable — macOS artifacts must build on a real macOS runner; electron-builder cannot cross-compile `dmg` on Windows or vice versa).
- Do NOT set `CSC_LINK`/`CSC_KEY_PASSWORD`/`APPLE_*` env vars — their absence is what keeps the build unsigned; electron-builder's own docs confirm signing is skipped automatically when no certificate is discoverable. Optionally set `mac.identity: null` explicitly in `package.json` `build.mac` to make the "intentionally unsigned" choice self-documenting in the repo rather than implicit via absent secrets.
- Set `permissions: contents: write` on the workflow so the built-in `GITHUB_TOKEN` can publish release assets.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `node:sqlite` | Node ≥ 22.5 (flagged) / Node ≥ 24 (unflagged, RC) | Electron 43.2.0 bundles Node 24.17.0 — unflagged, RC-stability `node:sqlite` available with no CLI flag needed in the main process. |
| `better-sqlite3@13.0.3` | Node engines `>=22` (per npm metadata, checked live) | Also requires Electron-specific rebuild — do not `npm install` and run as-is inside Electron without `@electron/rebuild` or electron-builder's `npmRebuild`, or you'll get a `NODE_MODULE_VERSION` mismatch (module compiled against system Node ABI, not Electron's). |
| `electron-builder@26.15.3` (already pinned) | Electron `43.2.0` (already pinned) | No version bump needed for this milestone — mac target support is present in the already-installed version; this is purely a `build.mac` config addition in `package.json`. |
| `csv-stringify@6.8.3` | Node ≥ 18 (well within existing Node 24 runtime) | No conflicts expected; pure JS, no native component. |

## Sources

- Context7 `/wiselibs/better-sqlite3` — Electron troubleshooting (electron-rebuild + asarUnpack requirement), install/init API, native-addon build prerequisites. Confidence: HIGH (official repo docs).
- Context7 `/electron-userland/electron-builder` — `mac.sign: null` for unsigned builds, default `macOsDefaultTargets = ["zip", "dmg"]`, GitHub Actions workflow shape for mac signing/notarization envs. Confidence: HIGH (official repo source + docs).
- electronjs.org/blog/electron-43-0 and releases.electronjs.org/release/v43.0.0 (via WebSearch) — Electron 43 bundles Node v24.17.0, Chromium 150, V8 15.0; last version with 32-bit prebuilts. Confidence: HIGH (official Electron blog, cross-checked across two search results).
- npm registry (live `npm view`) — `better-sqlite3@13.0.3`, `csv-stringify@6.8.3`, `@electron/rebuild@4.2.0`, `better-sqlite3` `engines.node >=22`. Confidence: HIGH (live registry query, not memory).
- WebSearch aggregate (pkgpulse.com, sqg.dev, codenote.net, Node.js SQLite docs) — `node:sqlite` Stability 1.2 (RC) in Node 24, no `--experimental-sqlite` flag needed since ~22.5, full stabilization targeted for Node 26; "better-sqlite3 is the package to pick" for Electron desktop apps generally. Confidence: MEDIUM (aggregated blog/community sources, not a single primary doc, but consistent across independent sources).
- WebSearch aggregate (npmjs.com/active-win, sindresorhus/get-windows GitHub repo, general macOS TCC documentation across multiple support sites) — cross-platform active-window libraries exist but macOS window-title access requires Screen Recording TCC permission; permission/signature coupling for unsigned apps inferred from general TCC behavior documentation, not verified against this exact library's issue tracker. Confidence: MEDIUM — treat the "drop the feature" recommendation as sound (backed by the requirement scope + general TCC friction for unsigned apps), but re-verify the specific permission-persistence-across-unsigned-rebuilds claim empirically if the feature is ever revisited.

---
*Stack research for: Electron offline-first tray app — embedded storage migration + unsigned macOS/Windows distribution*
*Researched: 2026-09-14*
