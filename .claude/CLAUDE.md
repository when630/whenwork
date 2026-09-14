<!-- GSD:project-start source:PROJECT.md -->

## Project

**WHENNOTE — 누구나 쓰는 퀵캡처 트레이 앱**

WHENNOTE(구 WHENWORK)는 생각난 할 일을 글로벌 단축키 한 번으로 던져 두고, 오늘 볼 것만 한 화면에서 보는 트레이 상주 앱이다. 지금까지는 1인 개발자인 나의 환경(PostgreSQL·Docker, Claude CLI, git·gh·glab, Apps Script 캘린더, Obsidian 볼트)에 맞춘 개인용이었다. 이번 작업은 그 의존성과 과한 기능을 걷어내고, 비개발자를 포함한 한국어 사용자 누구나 설치 파일 하나로 쓰는 공개 앱으로 다시 세우는 일이다.

**Core Value:** **설치 파일 하나를 받아 실행한 사람이, 다른 것을 아무것도 깔지 않고, 단축키로 던진 할 일을 절대 잃지 않는다.**

캡처 손실 제로가 원래의 제1목적이었고(설계 v2.16 §1), 이번에는 그 앞에 "아무 준비 없이"가 붙는다. 다른 모든 것이 실패해도 이것은 지켜야 한다.

### Constraints

- **Tech stack**: Electron + vanilla JS 유지 — 이미 돌아가는 UI를 다시 쓰지 않는다. 저장소만 교체한다
- **저장소**: 네이티브 모듈이 필요하면 Windows·macOS 두 빌드에서 electron-builder 리빌드가 깨지지 않아야 한다. 형태 선택은 리서치에서 결정
- **배포**: GitHub Releases, 미서명. 설치 파일 외에 사용자가 받아야 할 것이 없어야 한다. 공개 리포는 새 히스토리(개인 이력·토큰이 남지 않도록)
- **플랫폼**: Windows 11 + macOS. 두 OS에서 트레이·글로벌 단축키·알림·창 위치 기억이 검증되어야 한다. macOS 검증 장비 확보가 전제
- **언어**: 한국어 UI 하나
- **데이터 이전**: 나의 기존 PostgreSQL 데이터를 잃지 않는다. 이전 후 개인용 코드는 태그로 보존한다
- **테스트**: 남는 기능의 기존 테스트는 계속 통과해야 하고, 새로 넣는 스모크·테스트는 고친 코드를 되돌려 실패를 확인한다

<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->

## Technology Stack

## Languages

- JavaScript (ES modules) - All runtime code, main and renderer processes

## Runtime

- Node.js (version not pinned, using `npm` ES module resolution)
- npm
- Lockfile: `package-lock.json` (present)

## Frameworks & Platforms

- Electron 43.2.0 - Desktop application container and IPC layer
- Vanilla HTML/CSS/JavaScript (no framework)
- PostgreSQL 16 (via Docker)
- Node built-in test runner (`node --test`)
- electron-builder 26.15.3 - Windows NSIS installer (.exe)

## Key Dependencies

- `pg` (8.13.0) - PostgreSQL client for Node.js
- `electron` (43.2.0) - Desktop framework
- `electron-builder` (26.15.3) - Windows installer generation

## Fonts & Assets

- Pretendard (OFL license) - Included in `renderer/fonts/`
- Generated at build time from `build/icon.png`
- Generated tool: `tools/make-icon.mjs`

## Configuration

- Host: `127.0.0.1`
- Port: `5433` (non-standard to avoid conflicts)
- User: `whenwork`
- Password: `whenwork` (dev default)
- Database: `whenwork`
- Connection timeout: 2000ms (connection failures fail fast for tray app)
- Connection pool: max 3 (tray app doesn't hold long connections)
- Error handling: Pooled errors silently caught (app doesn't crash on DB disconnect)
- Application ID: `com.when630.whenwork`
- Product name: `WHENWORK`
- Target: Windows x64 NSIS installer
- Install options: Per-user, no silent install by default, desktop shortcut
- File: `userData/settings.json`
- Contains: Window position, size, user preferences
- Managed by: `main/settings.mjs` (debounced writes)

## Platform Requirements

- Windows 11 Pro (explicit user environment, PowerShell 5.1)
- Node.js (modern ES module support)
- Git (for repo scanning)
- Docker (for PostgreSQL local database)
- Optional: `gh` CLI (GitHub issue sync)
- Optional: `glab` CLI (GitLab issue/MR sync)
- Optional: `claude.exe` CLI (AI features via Claude subscription OAuth)
- Windows 7+ (NSIS supports older Windows)
- PostgreSQL 16 (separate instance or Docker container)
- Git CLI on PATH (for issue/activity collection)
- Optional: GitHub CLI, GitLab CLI, Claude CLI for features

## Architecture Notes

- Main process: `main/index.mjs` - Electron lifecycle, IPC handlers, background tasks
- Renderer process(es): `renderer/*.js` - UI rendering only
- No worker threads (CPU-bound work runs via `child_process` spawning external CLIs)
- Git operations: `node:child_process` spawning `git` CLI
- GitHub operations: Spawning `gh` CLI with JSON output parsing
- GitLab operations: Spawning `glab` CLI with JSON output parsing
- AI operations: Spawning `claude.exe` CLI with stdin prompt input
- No embedded SDKs - all integrations via CLI commands
- Schema: Embedded in `main/db.mjs` as SQL string constant
- Initialization: Lazy on first database connection (`ensureSchema()`)
- Migrations: ALTER TABLE statements for column additions (no migration framework)

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

## Naming Patterns

- Backend modules: `.mjs` (ES modules) - `main/db.mjs`, `main/parse.mjs`, `main/index.mjs`
- Frontend/renderer: `.js` - `renderer/capture.js`, `renderer/today.js`
- Tests: `.test.mjs` - `test/parse.test.mjs`, `test/calendar.test.mjs`
- Configuration: `.json` - `package.json`, `tsconfig.json` (if used)
- camelCase with descriptive names
- Example: `parseCaptureToken`, `createDb`, `insertCaptures`, `completeItem`, `getDoneItems`, `nudgeItem`
- Prefix patterns:
- camelCase: `dbOnline`, `queue`, `settings`, `captureWin`, `todayWin`, `reviewing`
- Module-level state uses lowercase: `ready`, `collecting`, `backingUp`, `syncingCalendar`
- DOM elements with `El` suffix: `input`, `msg`, `document.getElementById('in')`
- UPPER_SNAKE_CASE: `ACTIVE_PROJECT_DAYS`, `SCHEMA`, `EXPORT_TABLES`, `HOTKEY`, `PURGE_DAYS`
- Grouped by concern: timeout constants (`FLUSH_MS`, `COLLECT_MS`), UI dimensions (`TODAY_W`, `TODAY_H`, `CAPTURE_H`)
- Default values: `NOTIFY_AT_DEFAULT`, `BACKUP_DIR_DEFAULT`
- No TypeScript in this project - structure documented in comments
- SQL schema documented inline in `db.mjs` as `SCHEMA` constant
- Request/response shapes documented via JSDoc-style comments (rarely used)

## Code Style

- No explicit linter config found (no .eslintrc, .prettierrc)
- Semicolons present but inconsistent (both `return x;` and `return x` found)
- Spaces around operators: `x > 5`, `a + b`
- 2-space indentation (standard Node.js)
- String literals: single quotes `'string'` and template literals `` `template ${var}` ``
- No linter configuration files at project root
- Code assumes Node.js 18+ (uses `import`, `async/await`, arrow functions)

## Import Organization

- Relative imports used: `'../main/db.mjs'`, `'./queue.mjs'`
- No path alias configuration found
- Full explicit paths preferred for clarity

## Error Handling

- Errors bubble up only for critical operations (schema setup, export)
- Non-critical errors swallowed to maintain app stability (queue survival pattern)

## Logging

## Comments

- Business logic requiring explanation (why, not what): `// 며칠 안에 커밋이 있었으면 그 프로젝트의 열린 이슈는 백로그가 아니라 지금 일이다`
- Complex calculations or state transitions
- Workarounds for known issues: `// 다이얼로그가 뜨면 창이 blur된다 — 그걸로 창을 접지 않는다`
- Architectural decisions with references to design docs (e.g., `D1`, `설계 11절`)
- Not used in this project
- Function signatures documented inline via comments above function
- Korean comments dominate for business logic (user-facing concepts)
- English for technical/generic patterns

## Function Design

- Typical range: 15-50 lines
- Complex functions: 200-300 lines with clear sections marked by `// ──`
- Example: `main/index.mjs` `collectAll()` is ~30 lines, `makeWeeklyReview()` is ~60 lines
- Positional for primary input (usually one): `parseCapture(raw)`
- Named object destructuring for multiple related params:
- Defaults used liberally: `async function getActivities(projectId, limit = 10)`
- Parse functions (`parse.mjs`): Pure, no side effects, testable without setup
- DB functions (`db.mjs`): Pure database operations, idempotent where possible (upserts)
- UI handlers (`today.js`, `capture.js`): Side effects (DOM manipulation, IPC), global state

## Module Design

- Each module exports a factory function or set of related functions:
- Not used; imports are explicit and direct
- `main/db.mjs`: PostgreSQL connection + queries (1000+ lines)
- `main/parse.mjs`: Input string parsing (pure functions, ~80 lines)
- `main/brief.mjs`: Decision logic for notifications (pure functions, ~80 lines)
- `main/index.mjs`: App lifecycle + IPC handlers (1400+ lines)
- `renderer/*.js`: DOM manipulation and user interaction

## Cross-Cutting Patterns

- Module-level variables for app-wide state: `let tray = null`, `let captureWin = null`
- Settings persist to JSON: `settings.get()`, `settings.set()`
- Database pool is singleton via `createDb()` factory
- Background tasks tracked via flags: `collecting`, `reviewing`, `backingUp`, `syncingCalendar`
- Prevents concurrent operations: `if (collecting || ...) return;`
- Promises stored for deferred execution: `pendingContext = Promise.resolve(null)`
- Environment defaults in code (no .env required, but settings.json used)
- Database: `dbConfig.host ?? '127.0.0.1'` pattern throughout
- Constants at module top for tweakable values

<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

## System Overview

```text

```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Tray & Window Manager | App lifecycle, hotkey (Ctrl+Alt+Space), window creation/positioning | `main/index.mjs` |
| IPC Layer | 40+ handlers for capture, today view, settings, AI operations | `main/index.mjs` |
| Queue (Local) | Append-only JSONL capture buffer for offline-first capture | `main/queue.mjs` |
| Database | PostgreSQL schema, queries, project/item/activity/issue CRUD | `main/db.mjs` |
| Git Collection | Scans repo_paths for commits since 14 days ago | `main/collect.mjs` |
| Repo State | Tracks dirty/ahead/stash state of repositories | `main/repo.mjs` |
| Issue Sync | Fetches GitHub/GitLab issues via gh/glab CLIs | `main/issues.mjs` |
| AI Processing | Calls claude -p for card generation, inbox classification, done suggestions | `main/ai.mjs` |
| Calendar Sync | Caches Google Calendar events via Apps Script webhook | `main/calendar.mjs` |
| Settings | Persistent JSON config (vault path, backup dir, notifications, db config) | `main/settings.mjs` |
| Backup | Exports full DB to SQL file daily | `main/backup.mjs` |
| Brief | Computes morning notification logic (daily at user's set time) | `main/brief.mjs` |
| Capture Parsing | Extracts title + `#abbr` tokens from quick capture input | `main/parse.mjs` |
| Today View | Renders tabs (today/inbox/waiting/issues/projects/review/settings) | `renderer/today.js` + `today.html` |
| Capture View | Renders single-line input window with abbreviation hints | `renderer/capture.js` + `capture.html` |
| View Logic | Pure functions for grouping, filtering, rendering (testable) | `renderer/view.js` |
| Markdown Renderer | Renders AI-generated card text as markdown | `renderer/md.js` |
| Icons | SVG icon utilities | `renderer/icons.js` |

## Pattern Overview

- **Offline-first capture:** Hotkey writes to local queue immediately (append-only JSONL), syncs to DB when online
- **Structured data flow:** Capture → Queue → DB flush → Collection → AI processing → Display refresh
- **IPC-driven UI:** Renderer initiates actions via ipcMain handlers; main process responds with state
- **Pure functions in business logic:** View grouping, filtering, parsing extracted to `view.js` for testability
- **Background autonomous systems:** Daily backup, weekly review, morning brief, git collection all auto-trigger
- **AI integration via CLI:** `claude -p` spawned as subprocess; JSON passed via stdin to avoid argument length issues

## Layers

- Purpose: Electron app lifecycle, window management, hotkey registration, menu
- Location: `main/index.mjs` (main process entry point, 1480 lines)
- Contains: BrowserWindow creation, tray menu, position memory (place.mjs), foreground tracking
- Depends on: Electron, all other modules for initialization
- Used by: Electron runtime
- Purpose: Bi-directional message passing between main and renderer processes
- Location: `main/index.mjs` (40+ `ipcMain.handle` + `ipcMain.on` handlers)
- Contains: Handlers for capture, item operations, project operations, AI generation, settings, history
- Depends on: db, queue, ai, collect, backup, calendar, brief
- Used by: Renderer processes (today.js, capture.js) via `window.electron` preload
- Purpose: Persist capture attempts to disk immediately, even if DB is down
- Location: `main/queue.mjs` (append-only JSONL file at userData/queue.jsonl)
- Contains: `append()` (sync), `drain()` (async consume), `readAll()`, `count()`
- Depends on: Node fs only (no DB, Electron, or network)
- Used by: index.mjs flush loop (every 30s)
- Purpose: PostgreSQL persistence, schema, query execution
- Location: `main/db.mjs` (PostgreSQL client with pg Pool)
- Contains: Schema definition (CREATE TABLE), connection management, CRUD for projects/items/activities/issues/reviews/calendar
- Depends on: pg (npm), connection config from settings
- Used by: All modules that need persistence (collect, issues, ai, backup, calendar)
- Purpose: Background gathering of external data (git, issues, calendar)
- Location: `main/collect.mjs`, `main/issues.mjs`, `main/calendar.mjs`, `main/repo.mjs`
- Contains: `collectProject()` (git log parsing), `syncProjectIssues()` (gh/glab CLI), `syncCalendar()` (Apps Script), repo state tracking
- Depends on: child_process (execFile for git/gh/glab), https (calendar webhook), db
- Used by: Background interval timers and user-triggered "sync now" actions
- Purpose: Call claude -p CLI for content generation and classification
- Location: `main/ai.mjs` (spawns claude.exe subprocess)
- Contains: `claudeP()` (subprocess management), prompts for resume cards, inbox classification, done suggestions, weekly review
- Depends on: child_process, claude CLI installed locally
- Used by: Card prewarming, inbox classification, done suggestion, weekly review generation
- Purpose: Stateless calculation and decision functions
- Location: Multiple modules:
- Depends on: Minimal external dependencies (mostly stdlib)
- Used by: Main process, tests
- Purpose: Display and interact with work items, projects, reviews
- Location: `renderer/today.html` + `renderer/today.js` (71KB)
- Contains: 7 tabs (today/inbox/waiting/issues/projects/review/settings), keyboard-driven navigation, state management
- Depends on: Electron IPC preload, view.js, md.js, icons.js
- Used by: User interaction, background state refreshes from main
- Purpose: Quick one-line input window for rapid task capture
- Location: `renderer/capture.html` + `renderer/capture.js`
- Contains: Text input, live abbreviation lookup feedback, project hints
- Depends on: Electron IPC preload, view.js
- Used by: Hotkey (Ctrl+Alt+Space) or "Quick Capture" menu item

## Data Flow

### Primary Request Path (Capture → Queue → DB → Display)

### Background Collection & AI Flow

### Morning Brief Flow

### Weekly Review Flow

- **Main process state:** `dbOnline`, `lastForeground`, `captureWin`, `todayWin`, `queue`, `settings`, `collecting`, `reviewing`
- **Renderer state:** `state` (full view state from db), `tab`, `sel` (selection index), `resume`, `review`, `filter`
- **DB tables:** item, project, activity, issue, resume_card, event (KPI log), repo_state, cal_event, review

## Key Abstractions

- Purpose: Preserve the foreground window title when quick capture is triggered
- Examples: `main/context.mjs` (foregroundTitle), `main/index.mjs:383-395` (cachedForeground)
- Pattern: Async context tracking with 120s cache; used to label captured items with meeting/window context
- Purpose: Quick project lookup by shorthand (e.g., `#gw` for "GoWrite")
- Examples: `main/parse.mjs` (parseCaptureToken), `renderer/capture.js` (real-time feedback)
- Pattern: Extract `#abbr` token from input; resolve to project_id at DB flush time; fallback to abbr string if unknown
- Purpose: AI-generated next-action suggestion for a project
- Examples: `main/ai.mjs` (generateResumeCard), `main/index.mjs:1311-1336` (buildResumeCard)
- Pattern: Combine activities + issues + todos → claude -p prompt → save JSON + timestamp
- Purpose: AI-generated project assignment for inbox items (M3)
- Examples: `main/ai.mjs` (classifyInbox), `main/index.mjs:1224-1239` (inbox:classify)
- Pattern: Send inbox items + project list → claude -p → suggested_project_id saved to item table
- Purpose: Propose items as complete based on closed issues / merged PRs / commits
- Examples: `main/ai.mjs` (suggestDoneItems), `main/index.mjs:1181-1210` (maybeSuggestDone)
- Pattern: Gather todos + commits + closed issues → claude -p → done_suggested_at + done_suggest_why saved

## Entry Points

- Location: `main/index.mjs`
- Triggers: Electron app start or hotkey press
- Responsibilities: Initialize DB, queue, settings; register hotkey; create tray; start background timers
- Location: `main/index.mjs:1400` (globalShortcut.register)
- Triggers: Ctrl+Alt+Space (or user-reassigned)
- Responsibilities: Toggle capture window; track foreground context; fetch abbreviation hints
- Location: `renderer/today.html` loaded by getTodayWin() (`main/index.mjs:895`)
- Triggers: Tray click, hotkey toggle, or "Tab" from capture window
- Responsibilities: Render and allow manipulation of all item/project/review data
- Location: `main/index.mjs` (1042+ lines of ipcMain.handle/on)
- Triggers: Renderer requests via `window.electron.ipc()`
- Responsibilities: Execute item operations, AI generation, settings changes, etc.
- Location: `main/index.mjs:1408-1430` (app.whenReady)
- Triggers: App startup; then recurring intervals
- Responsibilities: Flush queue, collect data, sync calendar, send notifications, backup DB

## Architectural Constraints

- **Threading:** Single-threaded event loop (Electron main + Node event loop). Background tasks (git, db queries) are async but serialized per resource (e.g., no concurrent collect for same project).
- **Global state:** Minimal in main process: `queue`, `settings`, `db`, `tray`, `captureWin`, `todayWin`, `dbOnline`, `collecting`, `reviewing`, `syncing*`. All mutable, all necessary for state management.
- **Circular imports:** None detected. Dependency graph: index.mjs → [queue, db, settings, collect, etc.]; [collect, issues, calendar] → db; ai.mjs → (subprocess only).
- **Offline resilience:** Queue persists to disk before network; collection is non-blocking; DB sync retries; no hard errors on network failure.
- **Data consistency:** Queue entries deduplicated by id (UUID); activities by (project_id, ref); issues by (project_id, provider, kind, number); resume card unique per project; items soft-deleted until purge.

## Anti-Patterns

### Render-blocking DB Calls

### AI Subprocess Timeout Default

### Direct Renderer State Modification in Smoke Tests

## Error Handling

- **Capture path:** Never fails. Queue append is synchronous; flush retries indefinitely.
- **DB offline:** Queue holds data; sync retries; UI shows "DB 대기" in tray tooltip.
- **AI/Claude failure:** Logged with timeout/rate-limit/auth details; card generation skips and retries later (cooldown); user sees loading spinner.
- **Git/GitHub/Calendar sync:** Catch and continue; errors logged to DB event table; tray shows last error if critical (backup failure).
- **File operations:** Vault write failures don't block; review still saves to DB.

## Cross-Cutting Concerns

- Capture titles trimmed and length-limited (300 chars after parse)
- Project abbrs are alphanumeric + underscore
- Due dates parsed via `parseDue()` with natural language support
- Email parsed from git config (sender filter in collect)
- PostgreSQL: host/port/database/user/password in settings.json (or docker-compose for dev)
- Claude: `claude` CLI must be logged in locally (verified at startup if claude -p called)
- GitHub/GitLab: gh/glab CLIs must be authenticated (errors caught; collection skips)
- Google Calendar: Apps Script webhook URL stored in masked form (maskUrl)

<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
