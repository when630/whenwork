---
last_mapped_commit: 9d00e31f990696b01cfc743195d7e5b8f553aed4
last_mapped_at: 2026-09-14
---
# Technology Stack

**Analysis Date:** 2026-09-14

## Languages

**Primary:**

- JavaScript (ES modules) - All runtime code, main and renderer processes

## Runtime

**Environment:**

- Node.js (version not pinned, using `npm` ES module resolution)

**Package Manager:**

- npm
- Lockfile: `package-lock.json` (present)

## Frameworks & Platforms

**Core:**

- Electron 43.2.0 - Desktop application container and IPC layer
  - Used for: Tray application, window management, global shortcuts, native menus
  - Entry point: `main/index.mjs` via `main: "main/index.mjs"` in package.json

**UI:**

- Vanilla HTML/CSS/JavaScript (no framework)
  - Location: `renderer/` directory
  - Screens: `capture.html` (quick capture), `today.html` (main view)
  - CSS tokens-based design system: `renderer/tokens.css`

**Database:**

- PostgreSQL 16 (via Docker)
  - Default connection: localhost:5433
  - Schema management: Auto-initialization in `main/db.mjs`
  - Client: `pg` npm package 8.13.0

**Testing:**

- Node built-in test runner (`node --test`)
  - Test files: `test/**/*.test.mjs`
  - No Jest or Vitest configuration

**Build & Development:**

- electron-builder 26.15.3 - Windows NSIS installer (.exe)
  - Output: `dist/WHENWORK Setup <version>.exe`
  - Configuration in `package.json` under `build` key
  - Icon generation: `tools/make-icon.mjs` (runs on postinstall)

## Key Dependencies

**Production:**

- `pg` (8.13.0) - PostgreSQL client for Node.js
  - Why: Core data persistence layer
  - Connection pool configuration in `main/db.mjs` (max: 3 connections, timeout: 2s)

**Development:**

- `electron` (43.2.0) - Desktop framework
- `electron-builder` (26.15.3) - Windows installer generation

## Fonts & Assets

**Fonts:**

- Pretendard (OFL license) - Included in `renderer/fonts/`
  - Korean + Latin serif/sans typeface
  - Bundled with app build

**Icons:**

- Generated at build time from `build/icon.png`
- Generated tool: `tools/make-icon.mjs`

## Configuration

**Environment:**
PostgreSQL connection defaults (overridable):

- Host: `127.0.0.1`
- Port: `5433` (non-standard to avoid conflicts)
- User: `whenwork`
- Password: `whenwork` (dev default)
- Database: `whenwork`

**Database Configuration:**

- Connection timeout: 2000ms (connection failures fail fast for tray app)
- Connection pool: max 3 (tray app doesn't hold long connections)
- Error handling: Pooled errors silently caught (app doesn't crash on DB disconnect)

**Build Configuration:**

- Application ID: `com.when630.whenwork`
- Product name: `WHENWORK`
- Target: Windows x64 NSIS installer
- Install options: Per-user, no silent install by default, desktop shortcut

**Application Settings:**

- File: `userData/settings.json`
- Contains: Window position, size, user preferences
- Managed by: `main/settings.mjs` (debounced writes)

## Platform Requirements

**Development:**

- Windows 11 Pro (explicit user environment, PowerShell 5.1)
- Node.js (modern ES module support)
- Git (for repo scanning)
- Docker (for PostgreSQL local database)
- Optional: `gh` CLI (GitHub issue sync)
- Optional: `glab` CLI (GitLab issue/MR sync)
- Optional: `claude.exe` CLI (AI features via Claude subscription OAuth)

**Production (Deployment):**

- Windows 7+ (NSIS supports older Windows)
- PostgreSQL 16 (separate instance or Docker container)
- Git CLI on PATH (for issue/activity collection)
- Optional: GitHub CLI, GitLab CLI, Claude CLI for features

## Architecture Notes

**Single-Process Model:**

- Main process: `main/index.mjs` - Electron lifecycle, IPC handlers, background tasks
- Renderer process(es): `renderer/*.js` - UI rendering only
- No worker threads (CPU-bound work runs via `child_process` spawning external CLIs)

**External Command Execution:**

- Git operations: `node:child_process` spawning `git` CLI
- GitHub operations: Spawning `gh` CLI with JSON output parsing
- GitLab operations: Spawning `glab` CLI with JSON output parsing
- AI operations: Spawning `claude.exe` CLI with stdin prompt input
- No embedded SDKs - all integrations via CLI commands

**Database Initialization:**

- Schema: Embedded in `main/db.mjs` as SQL string constant
- Initialization: Lazy on first database connection (`ensureSchema()`)
- Migrations: ALTER TABLE statements for column additions (no migration framework)

---

*Stack analysis: 2026-09-14*
