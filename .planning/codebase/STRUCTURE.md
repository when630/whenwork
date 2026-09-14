---
last_mapped_commit: 9d00e31f990696b01cfc743195d7e5b8f553aed4
last_mapped_at: 2026-09-14
---
# Codebase Structure

**Analysis Date:** 2026-09-14

## Directory Layout

```
D:/AIProject/whenwork/
├── main/                        # Electron main process (Node.js)
│   ├── index.mjs               # Entry point, window/IPC/lifecycle management (1480 lines)
│   ├── db.mjs                  # PostgreSQL schema, connection pool, queries
│   ├── queue.mjs               # Append-only JSONL local capture buffer
│   ├── ai.mjs                  # Claude CLI integration (claude -p spawn)
│   ├── collect.mjs             # Git repository scanning (14 days of commits)
│   ├── issues.mjs              # GitHub/GitLab issue/PR fetching (gh/glab CLIs)
│   ├── repo.mjs                # Repository state tracking (dirty/ahead/stash)
│   ├── calendar.mjs            # Google Calendar sync via Apps Script webhook
│   ├── brief.mjs               # Morning notification schedule logic
│   ├── backup.mjs              # Daily DB export to SQL file
│   ├── settings.mjs            # JSON config file persistence
│   ├── parse.mjs               # Capture token parsing, due date parsing, ISO week
│   ├── vault.mjs               # Obsidian vault markdown file writing
│   ├── place.mjs               # Window position calculation
│   ├── context.mjs             # Foreground window title tracking
│   └── preload.cjs             # Electron preload script (IPC bridge to renderer)
│
├── renderer/                    # Web-based UI (JavaScript/HTML/CSS)
│   ├── today.html              # Today view HTML layout
│   ├── today.js                # Today view logic (71KB, 7 tabs, keyboard-driven)
│   ├── capture.html            # Quick capture window HTML
│   ├── capture.js              # Quick capture logic (5.5KB)
│   ├── view.js                 # Pure functions for rendering/grouping (testable)
│   ├── md.js                   # Markdown rendering for AI-generated cards
│   ├── icons.js                # SVG icon utilities
│   ├── tokens.css              # Design tokens (colors, spacing, fonts)
│   └── fonts/                  # Font files (Noto Sans CJK, etc.)
│
├── test/                       # Node test files (node --test)
│   ├── ai-error.test.mjs
│   ├── backup.test.mjs
│   ├── brief.test.mjs
│   ├── calendar.test.mjs
│   ├── collect.test.mjs
│   ├── context.test.mjs
│   ├── parse.test.mjs
│   ├── place.test.mjs
│   ├── queue.test.mjs
│   ├── repo.test.mjs
│   ├── settings.test.mjs
│   ├── suggest.test.mjs
│   ├── vault.test.mjs
│   └── view.test.mjs           # Tests for renderer/view.js pure functions
│
├── tools/                      # Build/dev utilities
│   └── make-icon.mjs           # Icon generation script
│
├── docs/                       # Documentation
│   └── mockups/                # Design mockups
│
├── build/                      # Generated assets (build artifacts)
│   ├── icon.png
│   ├── tray.png
│   └── [other icon sizes]
│
├── dist/                       # Packaged app output (electron-builder)
│
├── package.json                # npm manifest, Electron config, build config
├── package-lock.json           # Dependency lockfile
├── README.md                   # Project overview
├── docker-compose.yml          # PostgreSQL dev environment
│
└── .planning/                  # Codebase analysis documents (this directory)
    └── codebase/
        ├── ARCHITECTURE.md     # Architecture & layers (this file you're reading)
        ├── STRUCTURE.md        # Directory layout & naming (this file)
        ├── CONVENTIONS.md      # Code style, naming, patterns
        ├── TESTING.md          # Test framework & patterns
        ├── STACK.md            # Technology stack
        └── INTEGRATIONS.md     # External APIs & services
```

## Directory Purposes

**main/:**

- Purpose: Electron main process (Node.js runtime)
- Contains: All business logic, DB, IPC, background jobs, integrations
- Key files: `index.mjs` (lifecycle/IPC), `db.mjs` (persistence), `ai.mjs` (Claude), `collect.mjs` (git)
- Entry point: `package.json` main field points to `main/index.mjs`

**renderer/:**

- Purpose: Web-based UI (HTML/CSS/JavaScript in Electron WebContents)
- Contains: Today view (7-tab interface), quick capture window, view logic, utilities
- Key files: `today.js` (71KB, main UI), `capture.js` (input window), `view.js` (testable rendering functions)
- Loaded by: BrowserWindow.loadFile() in index.mjs

**test/:**

- Purpose: Unit & integration tests for business logic
- Contains: Node.js tests for all major modules (1:1 with main/ files)
- Naming: `*.test.mjs` suffix; run via `npm test`
- Note: Renderer tests (view.js) run as Node tests, not in browser

**tools/:**

- Purpose: Build-time utilities
- Contains: Icon generation script
- Run: Automatically on `npm postinstall`

**docs/:**

- Purpose: Design documentation and mockups
- Contains: Mockups of UI layouts
- Status: Reference only, not used at runtime

**build/:**

- Purpose: Generated assets for packaging
- Contains: App icon (icon.png), tray icon (tray.png)
- Generated by: `tools/make-icon.mjs` on postinstall

**dist/:**

- Purpose: Packaged .exe installer and app files
- Generated by: `npm run build` (electron-builder)
- Not committed to git

**.planning/codebase/:**

- Purpose: Analysis documents (this directory)
- Contains: ARCHITECTURE.md, STRUCTURE.md, CONVENTIONS.md, TESTING.md, STACK.md, INTEGRATIONS.md
- Created by: `/gsd-map-codebase` agent

## Key File Locations

**Entry Points:**

- `main/index.mjs` — Electron main process entry (1480 lines)
- `renderer/today.html` — Today view layout (27KB HTML)
- `renderer/capture.html` — Quick capture window (2.5KB HTML)
- `main/preload.cjs` — IPC bridge to renderer

**Configuration:**

- `package.json` — Project manifest, build config, npm scripts
- `.env*` files — (Not present; secrets in settings.json or docker-compose.yml)
- `docker-compose.yml` — PostgreSQL dev environment
- `main/settings.mjs` — Settings file I/O (userData/settings.json)

**Core Logic:**

- `main/db.mjs` — PostgreSQL schema and queries (all CRUD operations)
- `main/queue.mjs` — Offline-first capture queue (append-only JSONL)
- `main/ai.mjs` — Claude -p CLI spawning and prompt building
- `main/collect.mjs` — Git log parsing
- `renderer/view.js` — Pure rendering functions (14KB, all tested)

**Testing:**

- `test/view.test.mjs` — Tests for view.js pure functions
- `test/*.test.mjs` — Tests for all main/ modules
- Run: `npm test` (Node.js built-in test runner)

**Styling:**

- `renderer/tokens.css` — Design tokens (colors, spacing, typography)
- Inline CSS in HTML files (not a separate stylesheet directory)

## Naming Conventions

**Files:**

- `.mjs` extension — ES modules (main process)
- `.js` extension — CommonJS or ES modules (renderer, can use either)
- `.cjs` extension — CommonJS only (preload.cjs)
- `.test.mjs` extension — Test files
- `*.html` — Renderer UI layouts
- `*.css` — Stylesheets (inline or in tokens.css)

**Directories:**

- `main/` — Electron main process modules
- `renderer/` — Web UI modules
- `test/` — Test files
- `build/` — Generated build artifacts
- `dist/` — Packaged app output

**Functions:**

- `camelCase` — All functions (consistent across codebase)
- Examples: `createQueue()`, `createDb()`, `parseCaptureToken()`, `todayGroups()`

**Variables:**

- `camelCase` for locals/params
- `SCREAMING_SNAKE_CASE` for module-level constants
- Examples: `HOTKEY = 'Control+Alt+Space'`, `FLUSH_MS = 30_000`, `MAX_BUFFER = 4 * 1024 * 1024`

**Types (Database):**

- Table names: `snake_case` (project, item, activity, issue, resume_card, event, repo_state, cal_event)
- Column names: `snake_case` (project_id, captured_at, done_at, etc.)
- Enums in CHECK constraints: `snake_case` (kind: 'inbox'|'todo'|'waiting', status: 'active'|'archived')

**IPC Messages:**

- Format: `namespace:action` (e.g., `capture:save`, `item:complete`, `today:getState`, `review:generate`)
- Request direction: Renderer → Main (ipcMain.handle) or Main → Renderer (webContents.send)

## Where to Add New Code

**New Feature:**

- **Primary code:** `main/[feature].mjs` (new module if substantial, or add to index.mjs if small IPC handler)
- **Tests:** `test/[feature].test.mjs` (Node.js test file)
- **Renderer changes:** `renderer/today.js` for UI, `renderer/view.js` for pure functions
- **Database schema:** Add ALTER TABLE to `main/db.mjs` (schema is defined inline, not migrated)

**New UI Component:**

- **HTML layout:** Add to `renderer/today.html` (single monolithic HTML file)
- **Logic:** Add to `renderer/today.js` (single 71KB file with all tab logic)
- **Rendering helper:** Add to `renderer/view.js` if stateless; add to today.js if stateful

**New IPC Handler:**

- **Location:** `main/index.mjs` around line 1104+ (grouped by feature, e.g., item ops, project ops)
- **Pattern:** 
  ```javascript
  ipcMain.handle('namespace:action', async (_e, ...args) => {
    try {
      const result = await someModule.doThing(...args);
      return { ok: true, ...result };
    } catch {
      return { ok: false };
    }
  });
  ```

**New Utility Function:**

- **Location:** Create new file `main/[name].mjs` or add to existing utility (parse, place, etc.)
- **Export:** Use `export function` for all public functions
- **Testing:** Add `test/[name].test.mjs` with Node.js test syntax

**New Database Table:**

- **Location:** Add CREATE TABLE to SCHEMA variable in `main/db.mjs`
- **Queries:** Add functions to export in db.mjs
- **Cleanup:** Add to db.purgeDeleted() if soft-deletes needed

**New Background Job:**

- **Location:** Create function in appropriate module, then add timer in app.whenReady() (around line 1408)
- **Pattern:**
  ```javascript
  setTimeout(myJob, DELAY_MS);
  setInterval(myJob, INTERVAL_MS);
  ```

## Special Directories

**build/:**

- Purpose: Generated assets for packaging
- Generated: `npm postinstall` runs `node tools/make-icon.mjs`
- Committed: Yes (icon.png, tray.png are in git)
- Contains: PNG icons in multiple sizes for Windows installer

**dist/:**

- Purpose: Packaged application and installer
- Generated: `npm run build` (electron-builder)
- Committed: No (.gitignore)
- Contains: NSIS installer, app executable, resources

**docs/mockups/:**

- Purpose: UI design mockups for reference
- Committed: Yes
- Status: Informational only

**.planning/codebase/:**

- Purpose: Generated codebase analysis documents
- Generated: `/gsd-map-codebase` agent
- Committed: Yes (to .planning/ which is git-ignored, but agent writes them)
- Contains: ARCHITECTURE.md, STRUCTURE.md, CONVENTIONS.md, TESTING.md, etc.

**.claude/:**

- Purpose: Claude Code harness config (settings.json, hooks, skills)
- Committed: No (.gitignore)
- Contains: Session-specific configuration

---

*Structure analysis: 2026-09-14*
