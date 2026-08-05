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
import { writeWeekly, weeklyPath } from './vault.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const HOTKEY = 'Control+Alt+Space'; // 설계 11절 — Claude 쪽 바인딩은 사용자가 해제함
const FLUSH_MS = 30_000;
const COLLECT_MS = 6 * 60 * 60 * 1000; // git·이슈 백그라운드 수집 주기 (설계의 "일 1회"보다 촘촘하게)
const COLLECT_DELAY_MS = 30_000; // 켜자마자 긁으면 부팅이 무거워진다 — 조금 뒤에
const DEFAULT_VAULT = 'C:/Users/forcs/when630/01_work';
const TODAY_W = 880; // 오늘 뷰 — 화면 중앙, 가로 넓게
const TODAY_H = 680;
const CAPTURE_H = 88; // 퀵캡처 — 한 줄 입력 + 힌트 푸터에 딱 맞는 높이
const SMOKE = process.argv.includes('--smoke');

let tray = null;
let captureWin = null;
let todayWin = null;
let quitting = false;
let hotkeyOk = false;
let dbOnline = false;
// 단축키를 누른 "그 순간"의 포그라운드 창 — 팝업이 뜨면 포그라운드가 우리가 되므로 먼저 잡는다
let pendingContext = Promise.resolve(null);

if (!app.requestSingleInstanceLock()) app.quit();

const queue = createQueue(path.join(app.getPath('userData'), 'queue.jsonl'));
const db = createDb();
const settings = createSettings(path.join(app.getPath('userData'), 'settings.json'));

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
  } catch {
    // 수집 실패는 조용히 — 다음 주기에 다시 시도한다
  } finally {
    collecting = false;
  }
}

// ── 주간 리뷰 초안 → 볼트 (D5·오픈이슈 #1)
let reviewing = false;
async function makeWeeklyReview() {
  if (reviewing) return;
  reviewing = true;
  const notify = (body) => new Notification({ title: 'WHENWORK 주간 리뷰', body }).show();
  try {
    if (!(await db.online())) return notify('DB가 꺼져 있어 만들 수 없습니다.');
    const now = new Date();
    const { from, to } = weekRange(now);
    const range = {
      label: `${from.toISOString().slice(0, 10)} ~ ${new Date(to - 86400000).toISOString().slice(0, 10)}`,
    };
    notify('초안 생성 중… (claude -p)');
    const material = await db.weeklyMaterial(from, to);
    const body = await generateWeeklyReview(range, material);
    const week = isoWeek(now);
    const file = weeklyPath(settings.get('vaultRoot') ?? DEFAULT_VAULT, now, week);
    writeWeekly(file, body, { week, range });
    await db.logEvent('weekly_review', file);
    notify(`저장됨 — ${path.basename(file)}`);
    shell.openPath(file);
  } catch (err) {
    notify(`실패: ${String(err?.message ?? err).slice(0, 120)}`);
  } finally {
    reviewing = false;
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
  captureWin.on('blur', () => captureWin.hide()); // 다른 데 클릭하면 캡처는 접는다
  captureWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      captureWin.hide();
    }
  });
  return captureWin;
}

function showCapture() {
  pendingContext = foregroundTitle(); // 팝업이 포커스를 뺏기 전에 먼저
  const win = getCaptureWin();
  placeWindow(win, 'captureBounds', { centerY: false });
  win.webContents.send('capture:reset');
  win.show();
  win.focus();
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
  todayWin.on('blur', () => todayWin.hide());
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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '오늘 뷰', click: toggleToday },
      { label: `퀵캡처 (${hotkeyOk ? 'Ctrl+Alt+Space' : '단축키 등록 실패!'})`, click: showCapture },
      { type: 'separator' },
      { label: '주간 리뷰 초안 만들기', click: makeWeeklyReview },
      { label: '지금 수집 (git · 이슈)', click: collectAll },
      { type: 'separator' },
      {
        label: dbOnline ? 'DB 연결됨' : `DB 대기 중 — 큐 ${pending}건`,
        enabled: false,
      },
      {
        label: lastCollect ? `마지막 수집 ${new Date(lastCollect).toLocaleString('ko-KR')}` : '수집 이력 없음',
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
  const fg = await Promise.race([pendingContext, new Promise((r) => setTimeout(() => r(null), 300))]);
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

ipcMain.handle('today:getState', async () => {
  dbOnline = await db.online().catch(() => false);
  if (!dbOnline) return { online: false, pending: queue.count() };
  await flush();
  const state = await db.getViewState();
  return { online: true, pending: queue.count(), ...state };
});

const itemOps = {
  'item:complete': (id) => db.completeItem(id),
  'item:uncomplete': (id) => db.uncompleteItem(id),
  'item:assign': (id, projectId) => db.assignProject(id, projectId),
  'item:toWaiting': (id, who) => db.toWaiting(id, who),
  'item:rename': (id, title) => db.renameItem(id, title),
  'item:remove': (id) => db.removeItem(id),
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

async function resumePayload(projectId) {
  return {
    ok: true,
    card: await db.getResumeCard(projectId),
    activities: await db.getActivities(projectId, 10),
    issues: await db.getIssues(projectId, 8),
    generating: generatingCards.has(projectId),
  };
}

ipcMain.handle('resume:get', async (_e, projectId) => {
  try {
    // KPI: 카드 열람 수와 프로젝트 전환 수 (9절)
    db.logEvent('resume_open', String(projectId));
    if (lastOpenedProject !== null && lastOpenedProject !== projectId) {
      db.logEvent('project_switch', `${lastOpenedProject}->${projectId}`);
    }
    lastOpenedProject = projectId;
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

ipcMain.handle('resume:generate', async (_e, projectId) => {
  if (generatingCards.has(projectId)) return { ok: false, busy: true };
  generatingCards.add(projectId);
  try {
    const p = await findProject(projectId);
    if (!p) return { ok: false };
    const view = await db.getViewState();
    const card = await generateResumeCard(p, {
      activities: await db.getActivities(projectId, 15),
      doneItems: await db.getDoneItems(projectId, 7),
      issues: await db.getIssues(projectId, 10),
      todos: view.today.filter((t) => t.project_id === projectId && !t.done_at),
    });
    await db.saveResumeCard(projectId, card);
    return await resumePayload(projectId);
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    generatingCards.delete(projectId);
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
  }

  if (SMOKE) {
    setTimeout(() => {
      console.log(`SMOKE_OK hotkey=${hotkeyOk} pending=${queue.count()}`);
      app.quit();
    }, 1500);
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
