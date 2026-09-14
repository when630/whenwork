---
last_mapped_commit: 9d00e31f990696b01cfc743195d7e5b8f553aed4
last_mapped_at: 2026-09-14
---
<!-- refreshed: 2026-09-14 -->

# Architecture

**Analysis Date:** 2026-09-14

## System Overview

WHENWORK is a personal project-based work management tray app built with Electron. It operates as a three-layer offline-first system:

```text
┌──────────────────────────────────────────────────────────────┐
│                    Renderer Layer (Web)                       │
│  ┌─────────────────────┬──────────┬──────────────────────┐   │
│  │   Today View        │ Capture  │  Shared Utilities    │   │
│  │  `renderer/today`   │ `capture`│  `view.js` `md.js`   │   │
│  └─────────────────────┴──────────┴──────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
         │                          │
         ▼                          ▼
┌──────────────────────────────────────────────────────────────┐
│           IPC Channel (ipcMain handlers)                      │
│            `main/index.mjs` — 40+ handlers                    │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│                   Main Process Layer                          │
│                                                               │
│  ┌─────────────┐  ┌─────────┐  ┌─────────────────┐          │
│  │   Queue     │  │   DB    │  │ Background Jobs │          │
│  │ queue.mjs   │  │ db.mjs  │  │ - collect.mjs   │          │
│  │ (JSONL)     │  │(PostgreSQL)│ - issues.mjs  │          │
│  └─────────────┘  └─────────┘  │ - ai.mjs        │          │
│                                  │ - sync tasks    │          │
│  ┌────────────────────────────── └─────────────────┘          │
│  │ Utilities Layer                                            │
│  │ parse.mjs · brief.mjs · settings.mjs · backup.mjs         │
│  │ vault.mjs · place.mjs · context.mjs · calendar.mjs        │
│  └────────────────────────────────────────────────────────────
│
└──────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│           External Systems                                    │
│  ┌────────────────┐  ┌──────────┐  ┌─────────────────┐      │
│  │  PostgreSQL    │  │ git CLI  │  │  Claude AI      │      │
│  │  (D2 system)   │  │  (local) │  │  (claude -p)    │      │
│  └────────────────┘  └──────────┘  └─────────────────┘      │
└──────────────────────────────────────────────────────────────┘
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

**Overall:** Electron tray app with **offline-first local queue** + **PostgreSQL sync** + **background job scheduler**

**Key Characteristics:**

- **Offline-first capture:** Hotkey writes to local queue immediately (append-only JSONL), syncs to DB when online
- **Structured data flow:** Capture → Queue → DB flush → Collection → AI processing → Display refresh
- **IPC-driven UI:** Renderer initiates actions via ipcMain handlers; main process responds with state
- **Pure functions in business logic:** View grouping, filtering, parsing extracted to `view.js` for testability
- **Background autonomous systems:** Daily backup, weekly review, morning brief, git collection all auto-trigger
- **AI integration via CLI:** `claude -p` spawned as subprocess; JSON passed via stdin to avoid argument length issues

## Layers

**Tray & Window Layer:**

- Purpose: Electron app lifecycle, window management, hotkey registration, menu
- Location: `main/index.mjs` (main process entry point, 1480 lines)
- Contains: BrowserWindow creation, tray menu, position memory (place.mjs), foreground tracking
- Depends on: Electron, all other modules for initialization
- Used by: Electron runtime

**IPC Layer:**

- Purpose: Bi-directional message passing between main and renderer processes
- Location: `main/index.mjs` (40+ `ipcMain.handle` + `ipcMain.on` handlers)
- Contains: Handlers for capture, item operations, project operations, AI generation, settings, history
- Depends on: db, queue, ai, collect, backup, calendar, brief
- Used by: Renderer processes (today.js, capture.js) via `window.electron` preload

**Queue Layer (Offline-first):**

- Purpose: Persist capture attempts to disk immediately, even if DB is down
- Location: `main/queue.mjs` (append-only JSONL file at userData/queue.jsonl)
- Contains: `append()` (sync), `drain()` (async consume), `readAll()`, `count()`
- Depends on: Node fs only (no DB, Electron, or network)
- Used by: index.mjs flush loop (every 30s)

**Database Layer:**

- Purpose: PostgreSQL persistence, schema, query execution
- Location: `main/db.mjs` (PostgreSQL client with pg Pool)
- Contains: Schema definition (CREATE TABLE), connection management, CRUD for projects/items/activities/issues/reviews/calendar
- Depends on: pg (npm), connection config from settings
- Used by: All modules that need persistence (collect, issues, ai, backup, calendar)

**Collection Layer:**

- Purpose: Background gathering of external data (git, issues, calendar)
- Location: `main/collect.mjs`, `main/issues.mjs`, `main/calendar.mjs`, `main/repo.mjs`
- Contains: `collectProject()` (git log parsing), `syncProjectIssues()` (gh/glab CLI), `syncCalendar()` (Apps Script), repo state tracking
- Depends on: child_process (execFile for git/gh/glab), https (calendar webhook), db
- Used by: Background interval timers and user-triggered "sync now" actions

**AI Processing Layer:**

- Purpose: Call claude -p CLI for content generation and classification
- Location: `main/ai.mjs` (spawns claude.exe subprocess)
- Contains: `claudeP()` (subprocess management), prompts for resume cards, inbox classification, done suggestions, weekly review
- Depends on: child_process, claude CLI installed locally
- Used by: Card prewarming, inbox classification, done suggestion, weekly review generation

**Business Logic / Utilities Layer:**

- Purpose: Stateless calculation and decision functions
- Location: Multiple modules:
  - `main/parse.mjs` — parse capture tokens, due dates, ISO weeks
  - `main/brief.mjs` — morning notification schedule logic
  - `main/backup.mjs` — backup file naming and export
  - `main/vault.mjs` — obsidian vault file writing
  - `main/place.mjs` — window positioning calculations
  - `main/context.mjs` — foreground window title tracking
  - `main/settings.mjs` — JSON config file I/O
  - `renderer/view.js` — grouping, filtering, rendering calculations (PURE FUNCTIONS, tested)
- Depends on: Minimal external dependencies (mostly stdlib)
- Used by: Main process, tests

**Renderer Layer (Today View):**

- Purpose: Display and interact with work items, projects, reviews
- Location: `renderer/today.html` + `renderer/today.js` (71KB)
- Contains: 7 tabs (today/inbox/waiting/issues/projects/review/settings), keyboard-driven navigation, state management
- Depends on: Electron IPC preload, view.js, md.js, icons.js
- Used by: User interaction, background state refreshes from main

**Renderer Layer (Capture View):**

- Purpose: Quick one-line input window for rapid task capture
- Location: `renderer/capture.html` + `renderer/capture.js`
- Contains: Text input, live abbreviation lookup feedback, project hints
- Depends on: Electron IPC preload, view.js
- Used by: Hotkey (Ctrl+Alt+Space) or "Quick Capture" menu item

## Data Flow

### Primary Request Path (Capture → Queue → DB → Display)

1. **User presses Ctrl+Alt+Space** → Opens capture window (getCaptureWin) with foreground context tracked (`main/index.mjs:887`)
2. **User types "fix auth #gw"** → Input validation + abbreviation lookup in real-time (`renderer/capture.js`)
3. **User presses Enter** → IPC `capture:save` → Parsed by parseCaptureToken (`main/parse.mjs`) to extract title + abbr
4. **Appended to queue** → queue.append() writes to userData/queue.jsonl synchronously (`main/queue.mjs:11`)
5. **Flush loop runs** (every 30s or on-demand) → queue.drain() reads file, calls db.insertCaptures() (`main/index.mjs:427`)
6. **DB inserts item** → Abbr resolved to project_id (or inbox if unknown), context saved (`main/db.mjs`)
7. **Tray refreshes** → Shows pending queue count if sync not yet done (`main/index.mjs:958`)
8. **Today window refreshes** → Renderer requests `today:getState` → Items rendered in "today" tab (`renderer/today.js`)

### Background Collection & AI Flow

1. **Collection interval fires** (6 hours, or 30s after app start) → collectAll() (`main/index.mjs:1417`)
2. **For each project with repo_paths:**
   - collectProject() → git log --all → insertActivities() (`main/collect.mjs:45`)
   - collectRepoStates() → git status parsing → repo_state table update (`main/repo.mjs`)
   - syncProjectIssues() → gh/glab API via CLI → issue table update (`main/issues.mjs`)
   - syncCalendarNow() (if URL set) → Apps Script webhook → cal_event table (`main/calendar.mjs`)
3. **After collection** → prewarmCards() → For projects with new commits → buildResumeCard() (`main/index.mjs:1347`)
4. **Card generation:**
   - Fetch activities (last 15 commits), issues (last 14), todos, done items (`main/index.mjs:1318`)
   - Call ai.js generateResumeCard() → spawn claude -p with prompt → JSON resume card (`main/ai.mjs`)
   - Save to resume_card table (`main/db.mjs`)
   - Notify renderer with `card:done` event (`main/index.mjs:1334`)
5. **Renderer updates resume card** → User opens project → resume:get handler → Fresh card displayed

### Morning Brief Flow

1. **Brief check interval** (every 60s) → maybeBrief() checks if notification should fire (`main/index.mjs:755`)
2. **Conditions check** (time matches, not already briefed today, db online) → briefDecision() (`main/brief.mjs`)
3. **Fetch briefing data** → db.briefing(STALE_WAITING_DAYS) → Items due today + overdue + stale waiting (`main/index.mjs:774`)
4. **Format & show notification** → Notification.show() with parts joined by " · " (`main/index.mjs:780`)
5. **User clicks notification** → showToday() → Window opens to today tab

### Weekly Review Flow

1. **Auto-review trigger** (daily check) → maybeReview() → reviewDue() logic (`main/index.mjs:572`)
2. **Generate draft** → makeWeeklyReview() → db.weeklyMaterial() → ai.generateWeeklyReview() → claude -p (`main/index.mjs:509`)
3. **Save to vault** (if configured) → writeWeekly() → Obsidian markdown file (`main/vault.mjs`)
4. **Save to DB** → db.saveReview() → review table (`main/index.mjs:522`)
5. **Display in review tab** → Renderer fetches `review:get` → Markdown rendered in today.js review tab

**State Management:**

- **Main process state:** `dbOnline`, `lastForeground`, `captureWin`, `todayWin`, `queue`, `settings`, `collecting`, `reviewing`
- **Renderer state:** `state` (full view state from db), `tab`, `sel` (selection index), `resume`, `review`, `filter`
- **DB tables:** item, project, activity, issue, resume_card, event (KPI log), repo_state, cal_event, review

## Key Abstractions

**Capture Context:**

- Purpose: Preserve the foreground window title when quick capture is triggered
- Examples: `main/context.mjs` (foregroundTitle), `main/index.mjs:383-395` (cachedForeground)
- Pattern: Async context tracking with 120s cache; used to label captured items with meeting/window context

**Project Abbreviation:**

- Purpose: Quick project lookup by shorthand (e.g., `#gw` for "GoWrite")
- Examples: `main/parse.mjs` (parseCaptureToken), `renderer/capture.js` (real-time feedback)
- Pattern: Extract `#abbr` token from input; resolve to project_id at DB flush time; fallback to abbr string if unknown

**Resume Card:**

- Purpose: AI-generated next-action suggestion for a project
- Examples: `main/ai.mjs` (generateResumeCard), `main/index.mjs:1311-1336` (buildResumeCard)
- Pattern: Combine activities + issues + todos → claude -p prompt → save JSON + timestamp

**Item Suggestion:**

- Purpose: AI-generated project assignment for inbox items (M3)
- Examples: `main/ai.mjs` (classifyInbox), `main/index.mjs:1224-1239` (inbox:classify)
- Pattern: Send inbox items + project list → claude -p → suggested_project_id saved to item table

**Done Suggestion (M3):**

- Purpose: Propose items as complete based on closed issues / merged PRs / commits
- Examples: `main/ai.mjs` (suggestDoneItems), `main/index.mjs:1181-1210` (maybeSuggestDone)
- Pattern: Gather todos + commits + closed issues → claude -p → done_suggested_at + done_suggest_why saved

## Entry Points

**Application Entry:**

- Location: `main/index.mjs`
- Triggers: Electron app start or hotkey press
- Responsibilities: Initialize DB, queue, settings; register hotkey; create tray; start background timers

**Quick Capture Hotkey:**

- Location: `main/index.mjs:1400` (globalShortcut.register)
- Triggers: Ctrl+Alt+Space (or user-reassigned)
- Responsibilities: Toggle capture window; track foreground context; fetch abbreviation hints

**Today Window:**

- Location: `renderer/today.html` loaded by getTodayWin() (`main/index.mjs:895`)
- Triggers: Tray click, hotkey toggle, or "Tab" from capture window
- Responsibilities: Render and allow manipulation of all item/project/review data

**IPC Handlers:**

- Location: `main/index.mjs` (1042+ lines of ipcMain.handle/on)
- Triggers: Renderer requests via `window.electron.ipc()`
- Responsibilities: Execute item operations, AI generation, settings changes, etc.

**Background Timers:**

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

**What happens:** Today view requests state with `today:getState`, which may call db.getViewState(), db.getOpenIssues(), etc., blocking IPC response.
**Why it's wrong:** If DB is slow or network is congested, UI freezes; no timeout or loading indicator in main.
**Do this instead:** Use background prefetch (like prewarmCards) to keep DB up-to-date; add timeouts or async streaming.

### AI Subprocess Timeout Default

**What happens:** `claudeP()` default timeout is 300s (5 minutes), which is very long if claude CLI has stalled.
**Why it's wrong:** User sees no feedback for 5 minutes; could appear hung.
**Do this instead:** Add in-progress indicator in renderer; implement shorter timeout with retry strategy (as planned in opeNissues).

### Direct Renderer State Modification in Smoke Tests

**What happens:** SMOKE_PROBE directly mutates `state`, `review`, `issueSub` in renderer to fake test data.
**Why it's wrong:** Modifying render-critical state directly can mask real rendering bugs; better to mock data at API boundary.
**Do this instead:** Inject test data via IPC mock, not direct state mutation.

## Error Handling

**Strategy:** Fail gracefully and quietly for optional features; loud for critical paths.

**Patterns:**

- **Capture path:** Never fails. Queue append is synchronous; flush retries indefinitely.
- **DB offline:** Queue holds data; sync retries; UI shows "DB 대기" in tray tooltip.
- **AI/Claude failure:** Logged with timeout/rate-limit/auth details; card generation skips and retries later (cooldown); user sees loading spinner.
- **Git/GitHub/Calendar sync:** Catch and continue; errors logged to DB event table; tray shows last error if critical (backup failure).
- **File operations:** Vault write failures don't block; review still saves to DB.

## Cross-Cutting Concerns

**Logging:** `db.logEvent()` records all user actions and AI calls to event table for KPI tracking (9절). No structured logging framework; events are (kind, detail, timestamp).

**Validation:** 

- Capture titles trimmed and length-limited (300 chars after parse)
- Project abbrs are alphanumeric + underscore
- Due dates parsed via `parseDue()` with natural language support
- Email parsed from git config (sender filter in collect)

**Authentication:**

- PostgreSQL: host/port/database/user/password in settings.json (or docker-compose for dev)
- Claude: `claude` CLI must be logged in locally (verified at startup if claude -p called)
- GitHub/GitLab: gh/glab CLIs must be authenticated (errors caught; collection skips)
- Google Calendar: Apps Script webhook URL stored in masked form (maskUrl)

---

*Architecture analysis: 2026-09-14*
