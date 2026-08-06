// WHENWORK — 트레이 상주. 퀵캡처(전역 단축키) → 로컬 큐 → PostgreSQL 동기화(D1).
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  globalShortcut,
  screen,
  shell,
  Notification,
  dialog,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createQueue } from './queue.mjs';
import { createDb } from './db.mjs';
import { createSettings } from './settings.mjs';
import { pickPosition } from './place.mjs';
import { foregroundTitle } from './context.mjs';
import { collectProject } from './collect.mjs';
import { syncProjectIssues } from './issues.mjs';
import { generateResumeCard, classifyInbox, generateWeeklyReview } from './ai.mjs';
import { parseCaptureToken, parseDue, isoWeek, weekRange } from './parse.mjs';
import { writeWeekly, weeklyPath, guessVaultRoot, statsLine } from './vault.mjs';
import { writeBackup } from './backup.mjs';
import { syncCalendar, maskUrl, calendarRange } from './calendar.mjs';
import {
  briefDecision,
  briefingLines,
  dayKey,
  NOTIFY_AT_DEFAULT,
  STALE_WAITING_DAYS,
} from './brief.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const HOTKEY = 'Control+Alt+Space'; // 설계 11절 — Claude 쪽 바인딩은 사용자가 해제함
const FLUSH_MS = 30_000;
const COLLECT_MS = 6 * 60 * 60 * 1000; // git·이슈 백그라운드 수집 주기 (설계의 "일 1회"보다 촘촘하게)
const COLLECT_DELAY_MS = 30_000; // 켜자마자 긁으면 부팅이 무거워진다 — 조금 뒤에
const PURGE_DAYS = 30; // 소프트 삭제한 항목을 실제로 비우기까지 두는 기간
const TODAY_W = 880; // 오늘 뷰 — 화면 중앙, 가로 넓게
const TODAY_H = 680;
const CAPTURE_H = 88; // 퀵캡처 — 한 줄 입력 + 힌트 푸터에 딱 맞는 높이
const SMOKE = process.argv.includes('--smoke');

// 스모크에서 렌더러 안에서 돌리는 점검. 탭을 한 바퀴 돌리고 검색·완료 기록까지 열어보므로
// "특정 화면에서만 터지는" 오류도 앱을 눈으로 보지 않고 잡힌다.
//
// ※ 이 문자열은 템플릿 리터럴이다 — 안에서 `${...}`를 쓰면 렌더러가 아니라 **여기서** 보간되어
//   ReferenceError로 모듈 초기화가 깨진다(앱이 뜨지 않고 매달린다). 문자열은 +로 잇는다.
const SMOKE_PROBE = `(async () => {
  const errors = [];
  window.addEventListener('error', (e) => errors.push('error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push('reject: ' + ((e.reason && e.reason.message) || e.reason)));
  const step = async (name, fn) => {
    try { await fn(); } catch (e) { errors.push(name + ': ' + ((e && e.message) || e)); }
  };
  for (const t of ['inbox', 'waiting', 'projects', 'review', 'settings', 'today']) {
    await step('tab:' + t, () => switchTab(t));
    await new Promise((r) => setTimeout(r, 60));
  }
  await step('search', () => { openSearch(); closeSearch(false); });
  // 검색 중 Tab — 예전에는 기본 동작으로 입력 포커스만 빠지고 searchOn이 남아
  // 그 뒤 모든 키가 삼켜졌다(Esc·Enter·화살표 말고는 무반응). 눌러서 상태로 확인한다.
  await step('search:tab', () => {
    switchTab('today');
    openSearch();
    filter = '없을만한검색어';
    document.getElementById('searchIn').value = filter;
    const before = tab;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    if (searchOn) throw new Error('검색 중 Tab을 눌렀는데 검색 상태가 남았다');
    if (tab === before) throw new Error('검색 중 Tab이 탭을 옮기지 않았다: ' + tab);
    if (filter !== '없을만한검색어') throw new Error('Tab이 필터를 지웠다 — 탭을 넘어 유지돼야 한다');
    closeSearch(false);
  });
  // 프로젝트 번호 띠 — 1~9를 쓰는 탭에서만 스크롤 밖 고정 자리에 서고, 이름 칩도 번호를 단다
  await step('legend', () => {
    if (!state || !state.online || !state.projects.length) return;
    var band = document.getElementById('numlegend');
    switchTab('inbox');
    if (!band.classList.contains('show')) throw new Error('인박스에서 번호 띠가 보이지 않는다');
    if (!band.querySelector('b')) throw new Error('번호 띠에 번호가 없다');
    switchTab('settings');
    if (band.classList.contains('show')) throw new Error('설정 탭에서는 번호 띠를 감춰야 한다');
    switchTab('today');
    var gchip = document.querySelector('.group-h .chip:not(.cal-chip)');
    if (gchip && !gchip.querySelector('.pn')) throw new Error('오늘 탭 그룹 칩에 번호가 없다');
  });
  // 하단 힌트는 몇 칸으로 줄여두고 나머지는 ?(전체 키맵)로 본다 — 다시 길어지지 않게 재 둔다
  await step('keys', () => {
    switchTab('today');
    var hints = document.getElementById('hints');
    if (hints.children.length > 6) throw new Error('하단 힌트가 너무 많다: ' + hints.children.length);
    if (hints.scrollWidth > hints.clientWidth + 1) {
      throw new Error('하단 힌트가 잘린다: ' + hints.scrollWidth + ' > ' + hints.clientWidth);
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    var panel = document.getElementById('keys');
    if (!panel.classList.contains('show')) throw new Error('?로 전체 키맵이 열리지 않았다');
    if (!panel.querySelector('kbd')) throw new Error('전체 키맵이 비어 있다');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (panel.classList.contains('show')) throw new Error('Esc로 전체 키맵이 닫히지 않았다');
  });
  // 캘린더가 붙지 않은 환경에서도 일정 띠 렌더 경로는 밟아 본다 (스모크는 빈 설정으로 돈다)
  await step('cal-strip', () => {
    if (!state || !state.online) return;
    const now = Date.now();
    state.events = [
      { start_at: new Date(now - 7200000).toISOString(), end_at: new Date(now - 3600000).toISOString(), title: '지난 것', all_day: false },
      { start_at: new Date(now - 600000).toISOString(), end_at: new Date(now + 600000).toISOString(), title: '진행 중', all_day: false, location: '회의실' },
      { start_at: new Date(now + 3600000).toISOString(), end_at: new Date(now + 7200000).toISOString(), title: '앞으로', all_day: false },
      { start_at: new Date(now).toISOString(), end_at: new Date(now).toISOString(), title: '종일 것', all_day: true },
    ];
    switchTab('today');
    if (!document.querySelector('.tl .tl-row')) throw new Error('일정 타임라인이 그려지지 않았다');
    if (!document.querySelector('.tl-row.tl-now')) throw new Error('"지금" 표시가 없다');
    if (!document.querySelector('.tl-allday')) throw new Error('종일 일정이 그려지지 않았다');
    // 축과 점이 어긋나는 건 눈으로만 보이고 단위 테스트로는 안 잡힌다 — 좌표를 직접 견준다
    const geom = [...document.querySelectorAll('.tl-row')].map(function (r) {
      const d = r.querySelector('.tl-dot').getBoundingClientRect();
      const rowLeft = r.getBoundingClientRect().left;
      return {
        dot: d.left + d.width / 2 - rowLeft,
        line: parseFloat(getComputedStyle(r, '::before').left) + 0.5,
      };
    });
    for (const g of geom) {
      if (!(Math.abs(g.dot - g.line) <= 0.5)) {
        throw new Error('축이 점과 어긋난다: 점 ' + g.dot.toFixed(1) + ' vs 선 ' + g.line.toFixed(1));
      }
    }
    if (new Set(geom.map(function (g) { return Math.round(g.dot * 10); })).size > 1) {
      throw new Error('행마다 점 위치가 다르다: ' + geom.map(function (g) { return g.dot.toFixed(1); }).join(','));
    }
  });
  // 이슈에서 세운 할 일과 재촉한 대기 — 실제 데이터가 없어도 그리는 경로는 밟아 둔다.
  // (state를 직접 갈아끼우므로 이 뒤로는 화면 데이터가 진짜가 아니다 — 마지막에 둔다)
  await step('item-badges', () => {
    if (!state || !state.online) return;
    var day = 86400000;
    state.today = [{
      id: 'smoke-1', project_id: null, kind: 'todo', title: '이슈에서 온 일',
      issue_url: 'https://example.invalid/1', issue_number: 7,
      issue_provider: 'github', issue_state: 'closed',
    }];
    state.waiting = [{
      id: 'smoke-2', project_id: 1, project_name: '스모크', kind: 'waiting',
      title: '회신 대기', waiting_for: '아무개',
      captured_at: new Date(Date.now() - 6 * day).toISOString(),
      nudged_at: new Date(Date.now() - day).toISOString(), nudge_count: 2,
    }];
    switchTab('today');
    if (!document.querySelector('.isu.closed')) throw new Error('닫힌 이슈 배지가 그려지지 않았다');
    switchTab('waiting');
    if (!document.querySelector('.nudge-n')) throw new Error('재촉 횟수가 그려지지 않았다');
    // 프로젝트 표시가 없으면 대기 탭에서 1~9로 지정해도 화면이 그대로다
    if (!document.querySelector('.wait-meta .chip')) throw new Error('대기 항목의 프로젝트가 그려지지 않았다');
    var el = document.querySelector('.elapsed');
    if (el.textContent.indexOf('재촉 후') !== 0) {
      throw new Error('재촉 뒤로는 그때부터 세야 한다: ' + el.textContent);
    }
  });
  await step('history', () => openHistory(7));
  await step('history:close', () => closeHistory());
  await new Promise((r) => setTimeout(r, 300));
  return {
    view: !!window.VIEW,
    tabs: document.getElementById('tabs') ? document.getElementById('tabs').children.length : -1,
    body: document.getElementById('body') ? document.getElementById('body').children.length : -1,
    errors,
  };
})()`;

// 퀵캡처 렌더러 점검. 창 폭이 560px로 고정이라 힌트가 하나 늘면 안내가 조용히 잘리고,
// `#약어` 피드백은 이 창에만 있으므로 실제로 쳐 보지 않으면 깨진 것을 알 수 없다.
const CAPTURE_PROBE = `(() => {
  const errors = [];
  const foot = document.querySelector('.foot');
  if (foot.scrollWidth > foot.clientWidth + 1) {
    errors.push('푸터가 폭을 넘었다: ' + foot.scrollWidth + ' > ' + foot.clientWidth);
  }
  projects = [{ abbr: 'gw', name: 'GoWrite' }];
  const type = function (v) {
    input.value = v;
    input.dispatchEvent(new Event('input'));
    return msg.textContent;
  };
  const hit = type('복사버튼 추가 #gw');
  if (hit.indexOf('GoWrite') < 0) errors.push('아는 약어인데 프로젝트를 알려주지 않았다: ' + hit);
  const miss = type('복사버튼 추가 #gwx');
  if (miss.indexOf('없는 약어') < 0) errors.push('없는 약어를 알려주지 않았다: ' + miss);
  const none = type('복사버튼 추가');
  if (none.indexOf('인박스') < 0) errors.push('토큰이 없으면 기본 안내로 돌아와야 한다: ' + none);
  // 가장 긴 저장 안내가 들어가는지 — 힌트가 늘면 여기가 먼저 잘린다
  msg.className = 'msg ok';
  msg.textContent = '✓ 서식갤러리로 저장 · 이번에 3건';
  if (msg.scrollWidth > msg.clientWidth + 1) {
    errors.push('저장 안내가 잘린다: ' + msg.scrollWidth + ' > ' + msg.clientWidth);
  }
  type('');
  return errors;
})()`;

let tray = null;
let captureWin = null;
let todayWin = null;
let quitting = false;
let hotkeyOk = false;
let dbOnline = false;
// 폴더 선택 같은 네이티브 다이얼로그가 뜨면 창이 blur된다 — 그때 창을 숨기면 안 된다
let suppressHide = false;

// ── 캡처 컨텍스트
//
// 창을 열 때 미리 긁어둔다(PowerShell 기동에 300ms쯤 걸려 저장을 기다리게 할 수 없다).
// 우리 창을 후보에서 빼는 건 context.mjs가 하므로 팝업이 뜬 뒤에 실행돼도 답은 같다.
// 그래도 못 받은 경우(입력이 300ms보다 빨랐다)는 방금 받아둔 값으로 대신한다 —
// 퀵캡처는 blur되면 닫히므로 그 값은 사실상 같은 세션의 같은 창이다.
const FG_CACHE_MS = 120_000;
let pendingContext = Promise.resolve(null);
let lastForeground = null; // { title, at }

function trackForeground() {
  pendingContext = foregroundTitle().then((title) => {
    if (title) lastForeground = { title, at: Date.now() };
    return title;
  });
}

function cachedForeground() {
  return lastForeground && Date.now() - lastForeground.at < FG_CACHE_MS ? lastForeground.title : null;
}

// 스모크는 실사용 인스턴스와 부딪히지 않게 격리한다 — 안 그러면 단일 인스턴스 락에 걸려
// 아무것도 검증하지 않고 종료 코드 0으로 끝난다(캐시 점유 오류만 남는다).
// 덤으로 "설정·큐가 빈 첫 실행" 경로를 검증하게 된다.
if (SMOKE) app.setPath('userData', path.join(app.getPath('temp'), 'whenwork-smoke'));

if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();

const queue = createQueue(path.join(app.getPath('userData'), 'queue.jsonl'));
const settings = createSettings(path.join(app.getPath('userData'), 'settings.json'));
// DB 접속은 로컬 도커가 기본이지만 settings.json의 `db`로 덮어쓸 수 있다 (바꾸면 재시작)
const dbConfig = settings.get('db') ?? {};
const db = createDb(dbConfig);

// 볼트 경로는 코드에 박지 않는다 — 설정에 있으면 그걸 쓰고, 없으면 홈에서 한 번 찾아 기억한다.
// 끝까지 못 찾으면 null이고, 주간 리뷰는 DB에만 남는다(설정 탭에서 지정할 수 있다).
function vaultRoot() {
  const saved = settings.get('vaultRoot');
  if (saved) return saved;
  if (settings.get('vaultSearched')) return null; // 이미 찾아봤는데 없었다 — 매번 훑지 않는다
  const found = guessVaultRoot(app.getPath('home'));
  settings.set('vaultSearched', true);
  if (found) settings.set('vaultRoot', found);
  return found;
}

// ── 큐 → DB. 실패는 조용히 — 큐가 원본을 들고 있으니 다음 기회에 다시 흘린다.
async function flush() {
  try {
    dbOnline = await db.online();
    if (!dbOnline) return;
    await queue.drain((entries) => db.insertCaptures(entries));
  } catch {
    dbOnline = false;
  }
  refreshTrayMenu();
}

// ── 백그라운드 수집 (일과 중 언제 카드를 열어도 최신이도록)
let collecting = false;
async function collectAll() {
  if (collecting || !(await db.online().catch(() => false))) return;
  collecting = true;
  try {
    for (const p of await db.getProjects()) {
      if (!p.repo_paths?.length) continue;
      await collectProject(db, p);
      await syncProjectIssues(db, p);
    }
    settings.set('lastCollect', new Date().toISOString());
    await syncCalendarNow();
  } catch {
    // 수집 실패는 조용히 — 다음 주기에 다시 시도한다
  } finally {
    collecting = false;
  }
  // 새로 긁은 커밋을 근거로 카드를 미리 만들어 둔다. collecting을 푼 뒤에 부르는 이유는
  // claude -p가 몇 분씩 걸릴 수 있어 그동안 「지금 수집」이 막히면 안 되기 때문이다.
  prewarmCards().catch(() => {});
}

// ── 주간 리뷰 초안 (D5·오픈이슈 #1)
//
// DB에 저장하고 볼트 파일로도 내보낸다. 앱의 리뷰 탭은 DB 쪽을 읽으므로 볼트가 없어도 볼 수 있다.
let reviewing = false;

// weekOffset: 0=이번 주, -1=지난 주
function weekOf(weekOffset = 0) {
  const base = new Date();
  base.setDate(base.getDate() + weekOffset * 7);
  const { from, to } = weekRange(base);
  const last = new Date(to.getTime() - 86400000);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { base, from, to, week: isoWeek(base), label: `${fmt(from)} ~ ${fmt(last)}` };
}

async function makeWeeklyReview(weekOffset = 0, { notify: useNotification = false } = {}) {
  if (reviewing) return { ok: false, busy: true };
  reviewing = true;
  const notify = (body) => {
    if (useNotification) new Notification({ title: 'WHENWORK 주간 리뷰', body }).show();
  };
  try {
    if (!(await db.online())) {
      notify('DB 꺼짐 — 만들 수 없음');
      return { ok: false, error: 'DB 꺼짐' };
    }
    const w = weekOf(weekOffset);
    const range = { label: w.label };
    notify('초안 생성 중… (claude -p)');
    const material = await db.weeklyMaterial(w.from, w.to);
    // 지표는 사실이라 AI를 거칠 이유가 없다 — 초안 맨 위에 한 줄로 앱이 직접 붙인다
    const body = `${statsLine(material.stats)}\n\n${await generateWeeklyReview(range, material)}`;
    const root = vaultRoot();
    let saved = null;
    if (root) {
      try {
        const file = weeklyPath(root, w.base, w.week);
        writeWeekly(file, body, { week: w.week, range });
        saved = file;
      } catch {
        // 볼트에 못 써도 DB에는 남는다 — 앱에서는 그대로 볼 수 있다
      }
    }
    await db.saveReview({ year: w.week.year, week: w.week.week, body, range_label: w.label, file: saved });
    await db.logEvent('weekly_review', saved ?? `${w.week.year}-W${w.week.week}`);
    notify(
      saved
        ? `저장됨 — ${path.basename(saved)}`
        : root
          ? '생성됨 (볼트 저장 실패 — 앱에서 확인)'
          : '생성됨 (볼트 경로 미설정 — 설정 탭에서 지정)'
    );
    backupNow().catch(() => {}); // 리뷰를 만든 주에는 백업도 한 번 남는다 — 기다리지 않는다
    return { ok: true, review: await db.getReview(w.week.year, w.week.week), ...w, label: w.label };
  } catch (err) {
    const msg = String(err?.message ?? err).slice(0, 160);
    notify(`실패 — ${msg}`);
    return { ok: false, error: msg };
  } finally {
    reviewing = false;
  }
}

ipcMain.handle('review:get', async (_e, weekOffset = 0) => {
  try {
    const w = weekOf(weekOffset);
    return {
      ok: true,
      label: w.label,
      year: w.week.year,
      week: w.week.week,
      generating: reviewing,
      review: await db.getReview(w.week.year, w.week.week),
    };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle('review:generate', (_e, weekOffset = 0) => makeWeeklyReview(weekOffset));

ipcMain.handle('review:openFile', async (_e, file) => {
  if (!file) return { ok: false };
  const err = await shell.openPath(file);
  return { ok: !err };
});

// ── 설정
//
// DB가 꺼져 있어도 봐야 하는 화면이라(접속 정보 확인) DB 경로를 타지 않는다.
// 앱에서 만지는 건 아래 네 개뿐이고, DB 접속은 settings.json을 직접 고쳐 재시작한다.
const SETTING_KEYS = ['vaultRoot', 'backupDir', 'notifyEnabled', 'notifyAt', 'calendarUrl'];
const BACKUP_DIR_DEFAULT = path.join(app.getPath('userData'), 'backups');

ipcMain.handle('settings:get', () => ({
  ok: true,
  // 캘린더 URL에는 토큰이 박혀 있다 — 화면에는 가린 값만 내려보내고 원본은 main에만 둔다
  values: Object.fromEntries(
    SETTING_KEYS.map((k) => [k, k === 'calendarUrl' ? maskUrl(settings.get(k)) : settings.get(k)])
  ),
  calendar: { lastSync: settings.get('lastCalendarSync'), error: lastCalendarError },
  defaults: { notifyAt: NOTIFY_AT_DEFAULT, backupDir: BACKUP_DIR_DEFAULT },
  lastBackup: settings.get('lastBackup'),
  db: {
    host: dbConfig.host ?? '127.0.0.1',
    port: dbConfig.port ?? 5433,
    database: dbConfig.database ?? 'whenwork',
    online: dbOnline,
  },
  file: settings.file,
}));

ipcMain.handle('settings:set', (_e, key, value) => {
  if (!SETTING_KEYS.includes(key)) return { ok: false };
  if (value === null || value === '') settings.remove(key);
  else settings.set(key, value);
  settings.flush(); // 설정은 미루지 않고 바로 쓴다
  return { ok: true };
});

ipcMain.handle('settings:pickFolder', async (e, current) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  suppressHide = true; // 다이얼로그가 뜨면 창이 blur된다 — 그걸로 창을 접지 않는다
  try {
    const res = await dialog.showOpenDialog(win, {
      title: '폴더 선택',
      defaultPath: current || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return { ok: !res.canceled, path: res.filePaths?.[0] ?? null };
  } catch {
    return { ok: false };
  } finally {
    suppressHide = false;
    win?.focus();
  }
});

ipcMain.handle('settings:openFile', async () => {
  settings.flush();
  const err = await shell.openPath(settings.file);
  return { ok: !err };
});

// ── 캘린더 (오픈이슈 #6)
//
// Apps Script 웹앱을 주기적으로 긁어 DB에 캐시한다. 실패해도 캐시는 그대로 둬서
// 네트워크가 끊긴 동안에도 오늘 일정은 계속 보인다. 마지막 오류는 설정 화면에 드러낸다.
const CALENDAR_MS = 15 * 60 * 1000;
let lastCalendarError = null;
let syncingCalendar = false;

async function syncCalendarNow() {
  const url = settings.get('calendarUrl');
  if (!url || syncingCalendar) return { ok: false, skipped: true };
  syncingCalendar = true;
  try {
    if (!(await db.online().catch(() => false))) return { ok: false, error: 'DB 꺼짐' };
    const res = await syncCalendar(db, url);
    lastCalendarError = null;
    settings.set('lastCalendarSync', new Date().toISOString());
    return res;
  } catch (err) {
    lastCalendarError = String(err?.message ?? err).slice(0, 200);
    return { ok: false, error: lastCalendarError };
  } finally {
    syncingCalendar = false;
  }
}

ipcMain.handle('calendar:sync', () => syncCalendarNow());

// 오늘 0시부터 내일 0시까지 — 오늘 뷰가 쓰는 창
async function todayEvents() {
  if (!settings.get('calendarUrl')) return [];
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  try {
    return await db.getCalendar(base, new Date(base.getTime() + 86400000));
  } catch {
    return [];
  }
}

// ── 백업
//
// 데이터가 도커 볼륨 하나에만 있는 상태를 없앤다. 주간 리뷰를 만들 때 곁들여 돌리고
// (그 주에 한 번은 반드시 남는다) 트레이에서 직접 돌릴 수도 있다.
let backingUp = false;
async function backupNow() {
  if (backingUp) return { ok: false, busy: true };
  backingUp = true;
  try {
    if (!(await db.online())) return { ok: false, error: 'DB 꺼짐' };
    const dir = settings.get('backupDir') || BACKUP_DIR_DEFAULT;
    const file = writeBackup(dir, await db.exportAll());
    settings.set('lastBackup', new Date().toISOString());
    refreshTrayMenu();
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err).slice(0, 160) };
  } finally {
    backingUp = false;
  }
}

ipcMain.handle('backup:now', () => backupNow());

// ── 아침 브리핑 (오픈이슈 #3). 판단은 main/brief.mjs (테스트 대상), 여기서는 알림만 띄운다.
const BRIEFING_CHECK_MS = 60_000;

async function maybeBrief() {
  if (!Notification.isSupported()) return;
  const today = dayKey();
  const decision = briefDecision({
    at: settings.get('notifyAt') ?? NOTIFY_AT_DEFAULT,
    lastBriefing: settings.get('lastBriefing'),
    enabled: settings.get('notifyEnabled') !== false,
  });
  if (decision === 'wait') return;
  if (decision === 'skip') {
    settings.set('lastBriefing', today); // 창을 놓친 날은 넘기고 내일 다시
    return;
  }
  if (!(await db.online().catch(() => false))) return; // DB가 붙은 뒤에 다시 시도한다
  try {
    const parts = briefingLines(await db.briefing(STALE_WAITING_DAYS), {
      events: await todayEvents(),
    });
    settings.set('lastBriefing', today);
    if (!parts.length) return; // 챙길 게 없으면 조용히
    const note = new Notification({ title: '오늘 WHENWORK', body: parts.join(' · ') });
    note.on('click', () => showToday());
    note.show();
  } catch {
    // 브리핑 실패는 조용히 — 다음 날 다시
  }
}

// ── 창
//
// 그림자·라운드 코너는 CSS가 아니라 Windows가 그린다. 다만 프레임리스 창은
// **resizable을 끄면 WS_THICKFRAME이 빠져** 그 둘이 함께 사라진다
// (Electron native_window_views.cc: `if (CanResize()) frame_style |= WS_THICKFRAME`).
// 그래서 창은 resizable로 두고, 크기를 고정하고 싶으면 min=max로 묶는다.
function baseWinOpts(w, h) {
  return {
    width: w,
    height: h,
    frame: false,
    show: false,
    skipTaskbar: true,
    roundedCorners: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
  };
}

// alwaysOnTop 기본 레벨(floating)은 Windows에서 창을 작업 표시줄 뒤로 보내
// 다른 창을 누르면 가라앉는다 — pop-up-menu부터가 그 위다 (claude-office에서 확인된 패턴).
function pinOnTop(win) {
  win.setAlwaysOnTop(true, 'pop-up-menu');
}

// ── 창 위치 기억
//
// 사용자가 드래그로 옮긴 자리를 다음에도 쓴다. 다만 저장된 자리가 지금 화면 밖이면
// (모니터를 뺐거나 해상도가 바뀌면) 창이 안 보이는 곳에 뜨므로 그때는 가운데로 되돌린다.
// 계산은 main/place.mjs (테스트 대상), 여기서는 화면 정보만 넘긴다.
function placeWindow(win, key, { centerY = true } = {}) {
  const [width, height] = win.getSize();
  const { x, y } = pickPosition({
    saved: settings.get(key),
    size: { width, height },
    workAreas: screen.getAllDisplays().map((d) => d.workArea),
    cursorArea: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
    centerY,
  });
  win.setPosition(x, y);
}

// 옮기거나 크기를 바꾸면 그 자리를 기억한다
function rememberPosition(win, key) {
  const save = () => {
    if (win.isDestroyed() || !win.isVisible()) return;
    const [x, y] = win.getPosition();
    settings.set(key, { x, y });
  };
  win.on('moved', save);
  win.on('resized', save);
}

function getCaptureWin() {
  if (captureWin && !captureWin.isDestroyed()) return captureWin;
  captureWin = new BrowserWindow({
    ...baseWinOpts(560, CAPTURE_H),
    // 크기 고정 — resizable은 켜두되 min=max로 실제 리사이즈는 막는다
    minWidth: 560,
    maxWidth: 560,
    minHeight: CAPTURE_H,
    maxHeight: CAPTURE_H,
    backgroundColor: '#1e2027',
  });
  pinOnTop(captureWin);
  rememberPosition(captureWin, 'captureBounds');
  captureWin.loadFile(path.join(ROOT, 'renderer', 'capture.html'));
  captureWin.on('blur', () => {
    if (!suppressHide) captureWin.hide(); // 다른 데 클릭하면 캡처는 접는다
  });
  captureWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      captureWin.hide();
    }
  });
  return captureWin;
}

// 퀵캡처가 약어 목록을 알아야 "#gw"가 어느 프로젝트인지 **그 자리에서** 알려줄 수 있다.
// 약어를 타이핑하는 곳은 이 창뿐인데 정작 확인할 화면(번호 띠·프로젝트 탭)은 그때 볼 수 없었다.
// DB가 꺼져 있으면 마지막 목록으로 답한다 — 캡처 경로에 DB를 끌어들이지 않는다(D1).
let abbrHints = [];
async function refreshAbbrHints() {
  try {
    const rows = await db.getProjects();
    abbrHints = rows.filter((p) => p.abbr).map((p) => ({ abbr: p.abbr, name: p.name }));
  } catch {
    // 못 읽으면 이전 목록을 그대로 쓴다
  }
  return abbrHints;
}

function showCapture() {
  trackForeground(); // 저장 시점에 기다리지 않게 미리
  const win = getCaptureWin();
  placeWindow(win, 'captureBounds', { centerY: false });
  win.webContents.send('capture:reset', abbrHints); // 우선 캐시로 열고
  win.show();
  win.focus();
  refreshAbbrHints().then((list) => {
    if (!win.isDestroyed()) win.webContents.send('capture:projects', list); // 새 목록이 오면 갈아끼운다
  });
}

function getTodayWin() {
  if (todayWin && !todayWin.isDestroyed()) return todayWin;
  // 오늘 뷰는 실제로 리사이즈해도 되는 창 — 최소 크기만 잡는다
  const size = settings.get('todaySize') ?? {};
  todayWin = new BrowserWindow({
    ...baseWinOpts(size.width ?? TODAY_W, size.height ?? TODAY_H),
    minWidth: 560,
    minHeight: 420,
    backgroundColor: '#16171c',
  });
  pinOnTop(todayWin);
  rememberPosition(todayWin, 'todayBounds');
  todayWin.on('resized', () => {
    const [width, height] = todayWin.getSize();
    settings.set('todaySize', { width, height });
  });
  todayWin.loadFile(path.join(ROOT, 'renderer', 'today.html'));
  todayWin.on('blur', () => {
    if (!suppressHide) todayWin.hide();
  });
  todayWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      todayWin.hide();
    }
  });
  return todayWin;
}

function toggleToday() {
  const win = getTodayWin();
  if (win.isVisible()) return win.hide();
  showToday();
}

function showToday() {
  const win = getTodayWin();
  placeWindow(win, 'todayBounds'); // 옮겨둔 자리가 있으면 거기, 없으면 화면 중앙
  flush(); // 열 때 밀린 큐부터
  win.webContents.send('today:refresh');
  win.show();
  win.focus();
}

// ── 트레이
function trayImage() {
  const p = path.join(ROOT, 'build', 'tray.png');
  return fs.existsSync(p)
    ? nativeImage.createFromBuffer(fs.readFileSync(p))
    : nativeImage.createEmpty();
}

function refreshTrayMenu() {
  if (!tray) return;
  const pending = queue.count();
  tray.setToolTip(
    `WHENWORK${dbOnline ? '' : ' — DB 대기'}${pending ? ` · 큐 ${pending}건` : ''}`
  );
  const lastCollect = settings.get('lastCollect');
  const lastBackup = settings.get('lastBackup');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '오늘 뷰', click: toggleToday },
      { label: `퀵캡처 (${hotkeyOk ? 'Ctrl+Alt+Space' : '단축키 등록 실패!'})`, click: showCapture },
      { type: 'separator' },
      {
        label: '주간 리뷰 초안 만들기',
        click: async () => {
          const res = await makeWeeklyReview(0, { notify: true });
          if (res?.ok) {
            showToday();
            todayWin?.webContents.send('today:openReview');
          }
        },
      },
      { label: '지금 수집 (git · 이슈 · PR)', click: collectAll },
      {
        label: '지금 백업',
        click: async () => {
          const res = await backupNow();
          new Notification({
            title: 'WHENWORK 백업',
            body: res.ok ? `저장됨 — ${path.basename(res.file)}` : `실패 — ${res.error ?? '원인 불명'}`,
          }).show();
        },
      },
      { type: 'separator' },
      {
        label: dbOnline ? 'DB 연결됨' : `DB 대기 중 — 큐 ${pending}건`,
        enabled: false,
      },
      {
        label: lastCollect ? `마지막 수집 ${new Date(lastCollect).toLocaleString('ko-KR')}` : '수집 이력 없음',
        enabled: false,
      },
      {
        label: lastBackup ? `마지막 백업 ${new Date(lastBackup).toLocaleString('ko-KR')}` : '백업 이력 없음',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: '로그인 시 자동 시작',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (menuItem) => {
          app.setLoginItemSettings({ openAtLogin: menuItem.checked, args: [] });
          settings.set('openAtLogin', menuItem.checked);
          refreshTrayMenu();
        },
      },
      {
        label: '창 위치 초기화',
        click: () => {
          for (const key of ['captureBounds', 'todayBounds', 'todaySize']) settings.remove(key);
          if (todayWin && !todayWin.isDestroyed()) {
            todayWin.setSize(TODAY_W, TODAY_H);
            if (todayWin.isVisible()) placeWindow(todayWin, 'todayBounds');
          }
          if (captureWin && !captureWin.isDestroyed() && captureWin.isVisible()) {
            placeWindow(captureWin, 'captureBounds', { centerY: false });
          }
        },
      },
      { type: 'separator' },
      { label: '종료', click: () => app.quit() },
    ])
  );
}

// ── IPC
ipcMain.handle('capture:save', async (_e, title) => {
  const { title: text, abbr } = parseCaptureToken(title);
  if (!text) return { ok: false };
  const fg =
    (await Promise.race([pendingContext, new Promise((r) => setTimeout(() => r(null), 300))])) ??
    cachedForeground();
  queue.append({
    id: crypto.randomUUID(),
    title: text,
    abbr, // #약어 — 프로젝트로 푸는 건 플러시 시점(DB)에서
    captured_at: new Date().toISOString(),
    context: fg ? { fg } : null,
  });
  flush(); // 기다리지 않는다 — 저장 완결은 큐가 이미 보장
  refreshTrayMenu();
  return { ok: true, dbOnline, pending: queue.count() };
});

// 회의 후속 캡처 — 회의는 할 일을 낳는데 그 경로가 손 입력뿐이었다.
// 캡처 경로는 퀵캡처와 같다(큐 선기록, D1) — 맥락만 창 제목 대신 회의 제목이다.
ipcMain.handle('capture:followUp', async (_e, title, meeting) => {
  const text = String(title ?? '').trim();
  if (!text) return { ok: false };
  queue.append({
    id: crypto.randomUUID(),
    title: text,
    captured_at: new Date().toISOString(),
    context: { meeting: String(meeting?.title ?? '').slice(0, 200) },
  });
  flush();
  refreshTrayMenu();
  return { ok: true, pending: queue.count() };
});

ipcMain.handle('today:getState', async () => {
  dbOnline = await db.online().catch(() => false);
  if (!dbOnline) return { online: false, pending: queue.count() };
  await flush();
  const state = await db.getViewState();
  return { online: true, pending: queue.count(), events: await todayEvents(), ...state };
});

ipcMain.handle('history:get', async (_e, days = 7) => {
  try {
    return { ok: true, days, ...(await db.getHistory(days)) };
  } catch {
    return { ok: false };
  }
});

const itemOps = {
  'item:complete': (id) => db.completeItem(id),
  'item:uncomplete': (id) => db.uncompleteItem(id),
  'item:assign': (id, projectId, keepKind) => db.assignProject(id, projectId, keepKind),
  'item:toWaiting': (id, who) => db.toWaiting(id, who),
  'item:rename': (id, title) => db.renameItem(id, title),
  'item:remove': (id) => db.removeItem(id),
  'item:restore': (id) => db.restoreItem(id),
  'item:note': (id, note) => db.setNote(id, note),
  'project:create': (name) => db.createProject(name),
  'project:update': (id, fields) => db.updateProject(id, fields),
  'project:repos': (id, paths) => db.setRepoPaths(id, paths),
  'project:archive': (id) => db.archiveProject(id),
  'project:move': (id, dir) => db.moveProject(id, dir),
};
for (const [ch, fn] of Object.entries(itemOps)) {
  ipcMain.handle(ch, async (_e, ...args) => {
    try {
      await fn(...args);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });
}

// 이슈를 오늘 할 일로 세운다 — 원본 이슈는 그대로 두고 로컬 todo만 만든다(D7)
ipcMain.handle('issue:promote', async (_e, projectId, issue) => {
  try {
    const res = await db.promoteIssue(projectId, {
      url: String(issue?.url ?? ''),
      title: String(issue?.title ?? '').slice(0, 300),
    });
    return { ok: true, ...res };
  } catch {
    return { ok: false };
  }
});

// 재촉 — 몇 번째인지를 화면에 돌려줘야 해서 itemOps(ok만 반환)와 따로 둔다
ipcMain.handle('item:nudge', async (_e, id) => {
  try {
    return { ok: true, count: await db.nudgeItem(id) };
  } catch {
    return { ok: false };
  }
});

// 마감일은 "오늘/내일/8·12" 같은 말로 받는다 — 못 알아들으면 되묻게 ok:false를 돌려준다
ipcMain.handle('item:due', async (_e, id, text) => {
  const parsed = parseDue(text);
  if (!parsed.ok) return { ok: false, reason: 'parse' };
  try {
    await db.setDue(id, parsed.value);
    return { ok: true, due: parsed.value };
  } catch {
    return { ok: false };
  }
});

// ── M3: 인박스 AI 분류. 제안만 남기고 확정은 사람이 한다 (D4)
let classifying = false;
ipcMain.handle('inbox:classify', async () => {
  if (classifying) return { ok: false, busy: true };
  classifying = true;
  try {
    const [items, projects] = [await db.getInbox(), await db.getProjects()];
    if (!items.length) return { ok: true, suggested: 0 };
    const pairs = await classifyInbox(items, projects);
    await db.setSuggestions(pairs);
    await db.logEvent('inbox_classify', `${pairs.length}/${items.length}`);
    return { ok: true, suggested: pairs.length, total: items.length };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    classifying = false;
  }
});

// ── M2: 재개 카드
const generatingCards = new Set(); // 프로젝트별 claude -p 중복 호출 방지
let lastOpenedProject = null; // 프로젝트 전환 수(9절 KPI)를 세기 위한 직전 프로젝트

async function findProject(projectId) {
  return (await db.getProjects()).find((p) => p.id === projectId) ?? null;
}

// AI 호출이 실패하면(서버 혼잡 등) 카드를 열 때마다 몇 분씩 다시 매달리지 않도록 잠시 쉰다.
// 수동 재생성(R)은 이 쿨다운을 무시한다.
const CARD_COOLDOWN_MS = 10 * 60 * 1000;
const cardFailure = new Map();

async function resumePayload(projectId) {
  const failedAt = cardFailure.get(projectId) ?? 0;
  const card = await db.getResumeCard(projectId);
  return {
    ok: true,
    card,
    // 카드를 만든 뒤로 쌓인 커밋 수 — 카드가 얼마나 낡았는지는 시각보다 이 숫자가 정확하다
    fresh: card ? await db.newActivityCount(projectId, card.generated_at) : 0,
    activities: await db.getActivities(projectId, 10),
    issues: await db.getIssues(projectId, 12), // 이슈에 PR/MR까지 섞이므로 조금 넉넉하게
    promoted: await db.promotedIssueUrls(projectId), // 이미 할 일로 세운 이슈
    generating: generatingCards.has(projectId),
    retryAfter: failedAt + CARD_COOLDOWN_MS > Date.now() ? failedAt + CARD_COOLDOWN_MS : null,
  };
}

// log=false는 화면을 다시 채우려는 호출이다 — 열람 수(KPI)를 부풀리지 않는다
ipcMain.handle('resume:get', async (_e, projectId, log = true) => {
  try {
    // KPI: 카드 열람 수와 프로젝트 전환 수 (9절)
    if (log) {
      db.logEvent('resume_open', String(projectId));
      if (lastOpenedProject !== null && lastOpenedProject !== projectId) {
        db.logEvent('project_switch', `${lastOpenedProject}->${projectId}`);
      }
      lastOpenedProject = projectId;
    }
    return await resumePayload(projectId);
  } catch {
    return { ok: false };
  }
});

// git·이슈를 새로 긁고 최신 상태를 돌려준다 — 열 때마다 백그라운드로 부른다
ipcMain.handle('resume:sync', async (_e, projectId) => {
  try {
    const p = await findProject(projectId);
    if (p) {
      await collectProject(db, p);
      await syncProjectIssues(db, p);
    }
    return await resumePayload(projectId);
  } catch {
    return { ok: false };
  }
});

// 카드 한 장을 실제로 만든다 — 화면의 R와 백그라운드 선갱신이 같은 경로를 쓴다.
async function buildResumeCard(projectId) {
  if (generatingCards.has(projectId)) throw new Error('busy');
  generatingCards.add(projectId);
  try {
    const p = await findProject(projectId);
    if (!p) throw new Error('프로젝트 없음');
    const view = await db.getViewState();
    const card = await generateResumeCard(p, {
      activities: await db.getActivities(projectId, 15),
      doneItems: await db.getDoneItems(projectId, 7),
      issues: await db.getIssues(projectId, 14),
      todos: view.today.filter((t) => t.project_id === projectId && !t.done_at),
    });
    await db.saveResumeCard(projectId, card);
    cardFailure.delete(projectId);
  } catch (err) {
    cardFailure.set(projectId, Date.now());
    throw err;
  } finally {
    generatingCards.delete(projectId);
    // 백그라운드로 만드는 동안 사용자가 그 카드를 열어놓았을 수 있다 — 스켈레톤에 갇히지 않게 알린다
    if (todayWin && !todayWin.isDestroyed()) todayWin.webContents.send('card:done', projectId);
  }
}

// 카드를 **열 때가 아니라 수집 뒤에** 미리 만들어 둔다. 열어서 30초를 기다리면
// "프로젝트 열기 전에 카드부터 본다"(M2 완료 판정)는 습관이 붙지 않는다.
// 대상은 커밋이 새로 들어온 프로젝트뿐이고(projectsNeedingCard), 한 번에 한 장씩 만든다.
const CARD_STALE_HOURS = 24;
let prewarming = false;
async function prewarmCards() {
  if (prewarming) return;
  prewarming = true;
  try {
    for (const t of await db.projectsNeedingCard(CARD_STALE_HOURS)) {
      if (generatingCards.has(t.id)) continue;
      const failedAt = cardFailure.get(t.id) ?? 0;
      if (failedAt + CARD_COOLDOWN_MS > Date.now()) continue; // 방금 실패한 것은 쉬게 둔다
      try {
        await buildResumeCard(t.id);
      } catch {
        // 실패는 조용히 — 다음 수집 주기에 다시 시도한다 (사용자가 R로 직접 만들 수도 있다)
      }
    }
  } catch {
    // DB가 꺼져 있는 등 — 다음 주기에
  } finally {
    prewarming = false;
  }
}

ipcMain.handle('resume:generate', async (_e, projectId) => {
  if (generatingCards.has(projectId)) return { ok: false, busy: true };
  try {
    await buildResumeCard(projectId);
    return await resumePayload(projectId);
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});

ipcMain.on('open:url', (_e, url) => {
  if (/^https:\/\//.test(String(url))) shell.openExternal(String(url));
});

ipcMain.on('win:hide', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.hide();
});

// 퀵캡처에서 Tab — 캡처를 접고 오늘 뷰를 연다
ipcMain.on('app:open', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.hide();
  showToday();
});

// ── 앱 수명
app.setAppUserModelId('com.when630.whenwork');
// 개발 실행과 설치본이 같은 userData(큐·설정)를 쓰도록 이름을 고정한다 —
// 안 그러면 productName 기준으로 갈려서 큐에 쌓인 캡처가 한쪽에만 남는다.
app.setName('whenwork');

app.whenReady().then(async () => {
  tray = new Tray(trayImage());
  tray.on('click', toggleToday);
  // 단축키는 토글 — 열린 창(오늘 뷰든 캡처든)이 있으면 닫고, 없으면 캡처를 연다
  const onHotkey = () => {
    if (todayWin && !todayWin.isDestroyed() && todayWin.isVisible()) return todayWin.hide();
    if (captureWin && !captureWin.isDestroyed() && captureWin.isVisible()) return captureWin.hide();
    showCapture();
  };
  // register()는 이미 남이 쓰는 조합이면 조용히 false만 낸다 — 메뉴에 실패를 드러낸다
  hotkeyOk = globalShortcut.register(HOTKEY, onHotkey);
  refreshTrayMenu();
  setInterval(flush, FLUSH_MS);
  flush();

  // 패키징본에서만 자동 시작을 걸어둔다 — 개발 실행(electron.exe)을 등록해봐야 쓸모없다
  if (app.isPackaged && settings.get('openAtLogin') !== false) {
    app.setLoginItemSettings({ openAtLogin: true, args: [] });
  }

  if (!SMOKE) {
    setTimeout(collectAll, COLLECT_DELAY_MS);
    setInterval(collectAll, COLLECT_MS);
    // 오래 전에 지운 것만 실제로 비운다 — 되돌릴 창을 지난 뒤다
    setTimeout(() => db.purgeDeleted(PURGE_DAYS).catch(() => {}), COLLECT_DELAY_MS);
    setTimeout(maybeBrief, COLLECT_DELAY_MS); // 켠 직후 한 번 (DB가 붙을 시간을 준다)
    setInterval(maybeBrief, BRIEFING_CHECK_MS);
    // 캘린더는 git보다 자주 바뀐다 — 6시간 주기와 따로 돈다
    setInterval(syncCalendarNow, CALENDAR_MS);
  }

  if (SMOKE) {
    // 렌더러가 실제로 그려지는지까지 본다 — main만 띄워서는 화면 로직 오류가 잡히지 않는다.
    // 창은 만들되 show하지 않으므로 화면에는 나타나지 않는다.
    const win = getTodayWin();
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        let probe = null;
        try {
          probe = await win.webContents.executeJavaScript(SMOKE_PROBE);
        } catch (err) {
          probe = { errors: [String(err?.message ?? err)] };
        }
        // 퀵캡처 창도 만들어 그려 본다 (show하지 않으므로 화면에는 나타나지 않는다)
        let capture = null;
        try {
          const cap = getCaptureWin();
          if (cap.webContents.isLoading()) {
            await new Promise((r) => cap.webContents.once('did-finish-load', r));
          }
          capture = await cap.webContents.executeJavaScript(CAPTURE_PROBE);
        } catch (err) {
          capture = [String(err?.message ?? err)];
        }
        const ok =
          probe?.view === true &&
          probe?.tabs > 0 &&
          probe?.body >= 0 &&
          probe?.errors?.length === 0 &&
          capture?.length === 0;
        console.log(
          `SMOKE_${ok ? 'OK' : 'FAIL'} hotkey=${hotkeyOk} pending=${queue.count()} renderer=${JSON.stringify(probe)} capture=${JSON.stringify(capture)}`
        );
        quitting = true;
        app.exit(ok ? 0 : 1);
      }, 1200); // 첫 refresh()가 한 바퀴 돌 시간
    });
  }
});

app.on('before-quit', () => {
  quitting = true;
  settings.flush(); // 디바운스로 미뤄둔 창 위치를 마저 쓴다
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
// 창을 모두 닫아도 트레이로 산다
app.on('window-all-closed', () => {});
