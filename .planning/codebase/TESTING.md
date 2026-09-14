---
last_mapped_commit: 9d00e31f990696b01cfc743195d7e5b8f553aed4
last_mapped_at: 2026-09-14
---
# Testing Patterns

**Analysis Date:** 2026-09-14

## Test Framework

**Runner:**

- Node.js built-in `test` module (no external framework)
- Version: Node.js 18+ (built-in since v18.0.0)
- Config: `package.json` script
  ```json
  "test": "node --test \"test/**/*.test.mjs\""
  ```

**Assertion Library:**

- `node:assert/strict` - strict equality checks, no tolerance for coercion

**Run Commands:**

```bash
npm test              # Run all tests in test/**/*.test.mjs

# No watch mode, coverage, or filtering built in

# Tests run sequentially

```

**Test Execution:**

- Single run via `npm test` 
- Exit code 0 on all pass, non-zero on failure
- Output to stdout (test name + pass/fail)
- No parallel execution (single test process)

## Test File Organization

**Location:**

- `test/` directory at project root
- Co-located semantically (not co-located in same directory as source)

**Naming:**

- `{module-name}.test.mjs` pattern
- Examples:
  - `test/parse.test.mjs` tests `main/parse.mjs`
  - `test/backup.test.mjs` tests `main/backup.mjs`
  - `test/calendar.test.mjs` tests `main/calendar.mjs`

**Structure:**

```
test/
├── backup.test.mjs
├── brief.test.mjs
├── calendar.test.mjs
├── collect.test.mjs
├── context.test.mjs
├── parse.test.mjs
├── place.test.mjs
├── queue.test.mjs
├── repo.test.mjs
├── settings.test.mjs
├── suggest.test.mjs
├── vault.test.mjs
└── view.test.mjs
```

## Test Structure

**Suite Organization:**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCaptureToken, parseDue } from '../main/parse.mjs';

// Section separator - thematic grouping
// ── #약어 토큰

test('끝에 붙은 #약어를 떼어낸다', () => {
  assert.deepEqual(parseCaptureToken('웹훅 재시도 답장 #ef'), { title: '웹훅 재시도 답장', abbr: 'ef' });
});

test('토큰이 없으면 제목 그대로', () => {
  assert.deepEqual(parseCaptureToken('그냥 할 일'), { title: '그냥 할 일', abbr: null });
});

// ── 마감일

test('빈 값은 마감 해제', () => {
  assert.deepEqual(parseDue('', NOW), { ok: true, value: null });
});
```

**Key Characteristics:**

- No `describe()` - flat test list with comments for sections
- Section comments use `// ── Name` pattern (matches source code style)
- Tests execute in definition order
- Each test is independent (no shared setup between tests)

**Setup/Teardown:**

- No global before/after hooks used
- Test-local setup (inline):
  ```javascript
  const NOW = new Date(2026, 7, 5);
  
  test('description', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefix-'));
    try {
      // Test code
    } finally {
      // Cleanup if needed
    }
  });
  ```

## Assertion Patterns

**Common Assertions:**

1. **Equality:**
   ```javascript
   assert.equal(result, expected);
   assert.strictEqual(value, 5);  // strict checking
   ```

2. **Deep equality (for objects/arrays):**
   ```javascript
   assert.deepEqual(parseCaptureToken('...'), { title: '...', abbr: 'xy' });
   assert.deepEqual(staleBackups(names, 3), ['file1', 'file2']);
   ```

3. **Boolean/existence:**
   ```javascript
   assert.ok(a < b);  // truthy
   assert.match(url, /pattern/);  // regex match
   assert.throws(() => fn());  // expects exception
   ```

4. **Negative checks:**
   ```javascript
   assert.equal(result.ok, false);  // check ok:false pattern
   assert.notEqual(a, b);
   ```

**Error Testing:**

```javascript
test('없는 날짜와 알 수 없는 말은 거절', () => {
  assert.equal(parseDue('2026-02-30', NOW).ok, false);
  assert.equal(parseDue('아무말', NOW).ok, false);
});
```

## Mocking

**Framework:** None - manual function injection

**Pattern - Dependency Injection:**

```javascript
function fakeFetch(response) {
  return async (url) => {
    fakeFetch.lastUrl = String(url);  // Track call site
    return response;
  };
}

test('back·ahead를 쿼리에 붙여 부른다', async () => {
  const f = fakeFetch(ok({ events: [] }));
  await fetchCalendar(WEBAPP, { fetchImpl: f });  // Inject mock
  assert.match(fakeFetch.lastUrl, /back=7/);      // Assert call
});
```

**Test Data:**

```javascript
const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

test('깨진 한 건 때문에 나머지를 잃지 않는다', () => {
  const got = normalizeEvents({
    events: [
      { id: 'a', title: '멀쩡', start: '2026-08-06T01:00:00Z' },
      { id: 'b', title: '깨짐', start: '어제' },
      null,
    ],
  });
  assert.equal(got.length, 1);
});
```

**What to Mock:**

- External fetch calls (calendar sync)
- Date/time (provide `now` param to pure functions)
- Temporary filesystem operations (fs.mkdtempSync)

**What NOT to Mock:**

- Pure functions - test them directly (parsing, date math)
- Database - use real PostgreSQL connection in integration tests (none currently)
- Built-in modules (fs, path, crypto) - use directly

## Fixtures and Factories

**Test Data:**

```javascript
// Constants at top
const NOW = new Date(2026, 7, 5); // 2026-08-05 (수)
const WEBAPP = 'https://script.google.com/macros/s/AKfyc.../exec?token=secret-value';

// Factories inline or reused
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-b-'));
}

test('백업을 쓰고 되읽을 수 있다', () => {
  const dir = tmpDir();
  const file = writeBackup(dir, { project: [{ id: 1, name: '가' }], item: [] }, { now: new Date(2026, 7, 5, 10, 0) });
  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(back.app, 'whenwork');
});
```

**Location:**

- Fixtures defined in each test file (no shared fixtures directory)
- Constants at module level (same as production code)
- Factories as functions at top of file

## Coverage

**Requirements:** None enforced

**No coverage tooling integrated** - run: `npm test` only

**Test types by module:**

- `parse.test.mjs`: Full coverage of parsing functions (token, due date, ISO week)
- `backup.test.mjs`: Full coverage of backup naming, scheduling, export tables
- `calendar.test.mjs`: Event normalization, URL masking, fetch mocking
- `brief.test.mjs`: Decision logic for notifications and briefing text
- `context.test.mjs`: Foreground window detection (Electron-specific)
- `place.test.mjs`: Window positioning logic (requires screen geometry)
- `queue.test.mjs`: Local queue persistence
- `repo.test.mjs`: Repository state parsing and labeling
- `vault.test.mjs`: File writing for Obsidian vault
- `collect.test.mjs`: Git repository collection (may require git commands)
- `settings.test.mjs`: Settings file I/O
- `suggest.test.mjs`: AI classification suggestions
- `view.test.mjs`: State aggregation (drawing tests)

## Test Types

**Unit Tests:**

- Scope: Pure functions with no dependencies
- Approach: Direct function calls, parametric test data
- Examples: `parseCaptureToken()`, `parseDue()`, `isoWeek()`, `briefDecision()`
- **Ratio:** ~70% of tests (parsing, validation, state logic)

**Integration Tests:**

- Scope: Functions requiring setup (file I/O, SQL schema)
- Approach: Real filesystem, real database operations (none running in CI currently)
- Examples: `writeBackup()`, `db.insertCaptures()` (tests exist but may not run in all environments)
- **Ratio:** ~30% of tests (backup logic, schema validation)

**E2E Tests:**

- Framework: **Not used for API/server flow** (Electron app is the single "API")
- Smoke Tests: `SMOKE_PROBE` in `main/index.mjs` - embedded test suite that:
  - Runs in-app when `--smoke` flag passed
  - Tabs through all UI, checks rendering, verifies keyboard shortcuts
  - Located: Lines 53-324 of `main/index.mjs` (wrapped in template literal for renderer)
  - Run: `npm run smoke` (via package.json if configured)

**Snapshot Tests:**

- Not used in this project

## Common Patterns

**Async Testing:**

```javascript
test('마지막 수집 시각을 기록한다', async () => {
  // Async function returns Promise
  const res = await collectAll();
  assert.ok(res.ok);
});

// No explicit `done` callback - Promise automatically waits
```

**Error Testing:**

```javascript
test('없는 파일을 읽으면 실패', () => {
  // Wrap throw in function for assert.throws
  assert.throws(() => {
    readFileSync('/nonexistent/file.json');
  });
});

// Or check error state
test('파싱 실패는 ok:false로 돌려준다', () => {
  const result = parseDue('invalid', NOW);
  assert.equal(result.ok, false);
});
```

**Date/Time Testing:**

```javascript
const NOW = new Date(2026, 7, 5); // Fixed date for reproducibility

test('오늘·내일·모레', () => {
  assert.equal(parseDue('오늘', NOW).value, '2026-08-05');
  assert.equal(parseDue('내일', NOW).value, '2026-08-06');
  assert.equal(parseDue('모레', NOW).value, '2026-08-07');
});

// Always pass `now` param to control time in pure functions
```

**Filesystem Testing:**

```javascript
test('없는 폴더도 만들어서 쓴다', () => {
  const dir = path.join(tmpDir(), 'nested', 'backups');
  const file = writeBackup(dir, { item: [] });
  assert.ok(fs.existsSync(file));
});

// Use tmpDir() for isolation, no cleanup needed (OS clears temp)
```

**Parametric Tests:**

- No built-in parametric/data-driven test support
- Workaround: Multiple test cases:
  ```javascript
  test('keep개를 넘는 오래된 것만 지울 목록에 오른다', () => {
    assert.deepEqual(staleBackups(['a','b','c','d','e'], 3), ['a','b']);
    assert.deepEqual(staleBackups(['a','b','c','d','e'], 5), []);
    assert.deepEqual(staleBackups(['a','b','c','d','e'], 9), []);
  });
  ```

## Database Testing

**Approach:** Tests avoid database entirely (no `db` fixtures)

**Why:**

- App requires PostgreSQL running (docker compose up -d)
- Tests should run without external services
- DB schema tested via schema introspection:
  ```javascript
  test('스키마의 모든 테이블이 백업에 담긴다', () => {
    // cal_event가 실제로 빠져 있었다
    assert.deepEqual([...EXPORT_TABLES].sort(), [...schemaTables()].sort());
  });
  ```

**If adding DB tests:**

- Use `db.online()` check before test
- Seed data in test setup
- Clean up after (or use transactions that rollback)
- Mark as requiring Docker: `test.skip()` if DB unavailable

## Test Maintenance

**Adding tests:**

1. Create `test/module.test.mjs` for new module `main/module.mjs`
2. Import with relative path: `import { ... } from '../main/module.mjs'`
3. Use existing imports pattern: `import test from 'node:test'`
4. Keep tests pure (no side effects on app state)

**Running specific tests:**

- Not supported by Node.js test runner
- Workaround: Comment out other tests or use `node --test test/specific.test.mjs`

---

*Testing analysis: 2026-09-14*
