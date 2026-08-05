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
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createQueue } from './queue.mjs';
import { createDb } from './db.mjs';
import { foregroundTitle } from './context.mjs';
import { collectProject } from './collect.mjs';
import { syncProjectIssues } from './issues.mjs';
import { generateResumeCard } from './ai.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const HOTKEY = 'Control+Alt+Space'; // 설계 11절 — Claude 쪽 바인딩은 사용자가 해제함
const FLUSH_MS = 30_000;
const TODAY_W = 900; // 오늘 뷰 — 화면 중앙, 가로 넓게 (투명 창이라 10px 그림자 여백 포함)
const TODAY_H = 700;
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

// ── 창
function baseWinOpts(w, h) {
  return {
    width: w,
    height: h,
    frame: false,
    show: false,
    resizable: false,
    skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
  };
}

function getCaptureWin() {
  if (captureWin && !captureWin.isDestroyed()) return captureWin;
  captureWin = new BrowserWindow({
    ...baseWinOpts(560, 128),
    transparent: true,
    alwaysOnTop: true,
  });
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
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  win.setPosition(
    Math.round(workArea.x + (workArea.width - 560) / 2),
    Math.round(workArea.y + workArea.height * 0.28)
  );
  win.webContents.send('capture:reset');
  win.show();
  win.focus();
}

function getTodayWin() {
  if (todayWin && !todayWin.isDestroyed()) return todayWin;
  todayWin = new BrowserWindow({ ...baseWinOpts(TODAY_W, TODAY_H), transparent: true, alwaysOnTop: true });
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
  // 커서가 있는 디스플레이의 중앙에 띄운다
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  win.setPosition(
    Math.round(workArea.x + (workArea.width - TODAY_W) / 2),
    Math.round(workArea.y + (workArea.height - TODAY_H) / 2)
  );
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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '오늘 뷰', click: toggleToday },
      { label: `퀵캡처 (${hotkeyOk ? 'Ctrl+Alt+Space' : '단축키 등록 실패!'})`, click: showCapture },
      { type: 'separator' },
      {
        label: dbOnline ? 'DB 연결됨' : `DB 대기 중 — 큐 ${pending}건`,
        enabled: false,
      },
      { type: 'separator' },
      { label: '종료', click: () => app.quit() },
    ])
  );
}

// ── IPC
ipcMain.handle('capture:save', async (_e, title) => {
  const text = String(title ?? '').trim();
  if (!text) return { ok: false };
  const fg = await Promise.race([pendingContext, new Promise((r) => setTimeout(() => r(null), 300))]);
  queue.append({
    id: crypto.randomUUID(),
    title: text,
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
  'item:remove': (id) => db.removeItem(id),
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

// ── M2: 재개 카드
const generatingCards = new Set(); // 프로젝트별 claude -p 중복 호출 방지

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

  if (SMOKE) {
    setTimeout(() => {
      console.log(`SMOKE_OK hotkey=${hotkeyOk} pending=${queue.count()}`);
      app.quit();
    }, 1500);
  }
});

app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
// 창을 모두 닫아도 트레이로 산다
app.on('window-all-closed', () => {});
