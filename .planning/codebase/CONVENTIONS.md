---
last_mapped_commit: 9d00e31f990696b01cfc743195d7e5b8f553aed4
last_mapped_at: 2026-09-14
---
# Coding Conventions

**Analysis Date:** 2026-09-14

## Naming Patterns

**Files:**

- Backend modules: `.mjs` (ES modules) - `main/db.mjs`, `main/parse.mjs`, `main/index.mjs`
- Frontend/renderer: `.js` - `renderer/capture.js`, `renderer/today.js`
- Tests: `.test.mjs` - `test/parse.test.mjs`, `test/calendar.test.mjs`
- Configuration: `.json` - `package.json`, `tsconfig.json` (if used)

**Functions:**

- camelCase with descriptive names
- Example: `parseCaptureToken`, `createDb`, `insertCaptures`, `completeItem`, `getDoneItems`, `nudgeItem`
- Prefix patterns:
  - `get*` for retrieval: `getProjects`, `getViewState`, `getHistory`
  - `create*` for initialization: `createDb`, `createQueue`, `createSettings`
  - `insert*` for database writes: `insertCaptures`, `insertActivities`
  - `set*` for updates: `setDue`, `setNote`, `setSuggestions`
  - `async` for all database/network operations

**Variables:**

- camelCase: `dbOnline`, `queue`, `settings`, `captureWin`, `todayWin`, `reviewing`
- Module-level state uses lowercase: `ready`, `collecting`, `backingUp`, `syncingCalendar`
- DOM elements with `El` suffix: `input`, `msg`, `document.getElementById('in')`

**Constants:**

- UPPER_SNAKE_CASE: `ACTIVE_PROJECT_DAYS`, `SCHEMA`, `EXPORT_TABLES`, `HOTKEY`, `PURGE_DAYS`
- Grouped by concern: timeout constants (`FLUSH_MS`, `COLLECT_MS`), UI dimensions (`TODAY_W`, `TODAY_H`, `CAPTURE_H`)
- Default values: `NOTIFY_AT_DEFAULT`, `BACKUP_DIR_DEFAULT`

**Types/Interfaces:**

- No TypeScript in this project - structure documented in comments
- SQL schema documented inline in `db.mjs` as `SCHEMA` constant
- Request/response shapes documented via JSDoc-style comments (rarely used)

## Code Style

**Formatting:**

- No explicit linter config found (no .eslintrc, .prettierrc)
- Semicolons present but inconsistent (both `return x;` and `return x` found)
- Spaces around operators: `x > 5`, `a + b`
- 2-space indentation (standard Node.js)
- String literals: single quotes `'string'` and template literals `` `template ${var}` ``

**Linting:**

- No linter configuration files at project root
- Code assumes Node.js 18+ (uses `import`, `async/await`, arrow functions)

## Import Organization

**Order:**

1. Node.js built-ins (prefixed with `node:`)
   ```javascript
   import test from 'node:test';
   import assert from 'node:assert/strict';
   import fs from 'node:fs';
   import path from 'node:path';
   ```

2. Third-party packages
   ```javascript
   import pg from 'pg';
   ```

3. Local modules
   ```javascript
   import { createDb } from './db.mjs';
   import { parseCapture } from './parse.mjs';
   ```

**Path Aliases:**

- Relative imports used: `'../main/db.mjs'`, `'./queue.mjs'`
- No path alias configuration found
- Full explicit paths preferred for clarity

## Error Handling

**Patterns:**

1. **Silent failures for non-critical operations:**
   ```javascript
   catch {
     dbOnline = false;
   }
   ```
   Used for DB connection timeouts, background collection failures, calendar sync errors.

2. **Result pattern with ok flag:**
   ```javascript
   return { ok: false, error: msg };
   return { ok: true, file: filename };
   return { created: false };
   ```
   Used for operations that may fail gracefully (backup, review generation, parsing).

3. **Try-catch with logging:**
   ```javascript
   try {
     await db.online();
   } catch {
     db.logEvent('ai_call', `${job}:fail:${secs()}s`);
     throw err;
   }
   ```
   Used for operations that need visibility (AI calls, file writes).

4. **Early returns for guards:**
   ```javascript
   if (!file) return { ok: false };
   if (!dbOnline) return;
   if (i < 0 || j < 0) return;
   ```

5. **Database error resilience:**
   - DB pool has error handler: `pool.on('error', () => {})` to prevent app crashes
   - Null coalescing used: `await db.online().catch(() => false)` to default to offline state

**Exception types:**

- Errors bubble up only for critical operations (schema setup, export)
- Non-critical errors swallowed to maintain app stability (queue survival pattern)

## Logging

**Framework:** Native `console` or custom `db.logEvent()`

**Patterns:**

1. **Event logging for KPI tracking:**
   ```javascript
   db.logEvent('ai_call', `${job}:ok:${secs()}s`);
   db.logEvent('weekly_review', saved ?? `${w.week.year}-W${w.week.week}`);
   db.logEvent('project_switch', detail);
   ```
   Logs to `event` table in PostgreSQL for metrics and debugging.

2. **No console logs in production flow:**
   - Only used in test output
   - Background operations fail silently with event logging fallback

3. **Notification system:**
   - `new Notification({ title, body })` for user-facing messages (Electron)
   - Used for errors that require user awareness (backup failures, review status)

## Comments

**When to Comment:**

- Business logic requiring explanation (why, not what): `// 며칠 안에 커밋이 있었으면 그 프로젝트의 열린 이슈는 백로그가 아니라 지금 일이다`
- Complex calculations or state transitions
- Workarounds for known issues: `// 다이얼로그가 뜨면 창이 blur된다 — 그걸로 창을 접지 않는다`
- Architectural decisions with references to design docs (e.g., `D1`, `설계 11절`)

**JSDoc/TSDoc:**

- Not used in this project
- Function signatures documented inline via comments above function

**Comment Style:**

```javascript
// Section comment — always with this pattern
// Explains what this section does and why

// Sub-section comment about specific behavior
function doSomething() {
  // Inline comment for complex logic
}
```

**Language:**

- Korean comments dominate for business logic (user-facing concepts)
- English for technical/generic patterns

## Function Design

**Size:**

- Typical range: 15-50 lines
- Complex functions: 200-300 lines with clear sections marked by `// ──`
- Example: `main/index.mjs` `collectAll()` is ~30 lines, `makeWeeklyReview()` is ~60 lines

**Parameters:**

- Positional for primary input (usually one): `parseCapture(raw)`
- Named object destructuring for multiple related params:
  ```javascript
  export function briefingLines(b = {}, { staleDays = STALE_WAITING_DAYS, events = [], review = null } = {})
  ```
- Defaults used liberally: `async function getActivities(projectId, limit = 10)`

**Return Values:**

1. **Async database functions:**
   ```javascript
   const { rows } = await pool.query(...);
   return rows;
   ```

2. **Parse/validation functions:**
   ```javascript
   return { ok: true, value: null };
   return { ok: false };
   return { title: '...', abbr: 'xy' };
   ```

3. **Status reporting:**
   ```javascript
   return { ok: true, file };
   return { ok: false, busy: true };
   ```

**Pure vs. Side-Effect:**

- Parse functions (`parse.mjs`): Pure, no side effects, testable without setup
- DB functions (`db.mjs`): Pure database operations, idempotent where possible (upserts)
- UI handlers (`today.js`, `capture.js`): Side effects (DOM manipulation, IPC), global state

## Module Design

**Exports:**

- Each module exports a factory function or set of related functions:
  ```javascript
  export function createDb(config) {
    return { online, insertCaptures, getProjects, ... };
  }
  ```
  or
  ```javascript
  export function parseCaptureToken(raw) { ... }
  export const ACTIVE_PROJECT_DAYS = 3;
  ```

**Barrel Files:**

- Not used; imports are explicit and direct

**Module Responsibilities:**

- `main/db.mjs`: PostgreSQL connection + queries (1000+ lines)
- `main/parse.mjs`: Input string parsing (pure functions, ~80 lines)
- `main/brief.mjs`: Decision logic for notifications (pure functions, ~80 lines)
- `main/index.mjs`: App lifecycle + IPC handlers (1400+ lines)
- `renderer/*.js`: DOM manipulation and user interaction

## Cross-Cutting Patterns

**Global State:**

- Module-level variables for app-wide state: `let tray = null`, `let captureWin = null`
- Settings persist to JSON: `settings.get()`, `settings.set()`
- Database pool is singleton via `createDb()` factory

**Async Coordination:**

- Background tasks tracked via flags: `collecting`, `reviewing`, `backingUp`, `syncingCalendar`
- Prevents concurrent operations: `if (collecting || ...) return;`
- Promises stored for deferred execution: `pendingContext = Promise.resolve(null)`

**Configuration:**

- Environment defaults in code (no .env required, but settings.json used)
- Database: `dbConfig.host ?? '127.0.0.1'` pattern throughout
- Constants at module top for tweakable values

---

*Convention analysis: 2026-09-14*
