// main/ipc.mjs — 모든 ipcMain 핸들러 등록 (D-08 분할, main/index.mjs에서 이동)
import { BrowserWindow, ipcMain, shell, dialog } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseCaptureToken, parseDue } from './parse.mjs';
import { validateExport } from './store.mjs';
import { platform } from './platform/index.mjs';
import { NOTIFY_AT_DEFAULT } from './brief.mjs';

// 캡처 저장의 단일 경로(D-01/D-03). capture:save·capture:followUp 두 핸들러와
// 01-07의 주입 모드가 모두 이 함수를 부른다 — 경로가 하나여야 테스트가 실경로를 밟는다.
//
// 순서 자체가 계약이다:
// 1) 제목을 다듬고 약어를 분리한다. 빈 제목이면 { ok: false }.
// 2) queue.append — 동기, fs만 의존. 여기까지 오면 캡처는 이미 보존된 것이다.
// 3) store.insertCaptures를 동기로 즉시 시도한다.
// 4) 던지면 store.reopen() 후 한 번 더 시도한다(D-03).
// 5) 그래도 던지면 ctx.pending += 1. 예외를 위로 올리지 않는다.
// 6) refreshTrayMenu 후 { ok: true, pending: ctx.pending }을 돌려준다.
export function saveCapture(ctx, title, context = null) {
  const { title: text, abbr } = parseCaptureToken(title);
  if (!text) return { ok: false };
  const entry = {
    id: crypto.randomUUID(),
    title: text,
    abbr, // #약어 — 프로젝트로 푸는 건 저장소 반영 시점에서
    // 그 약어가 어느 프로젝트도 아니면 원문을 그대로 되살린다 — 앞에 붙은 "#201 이슈 확인"이
    // 어순이 바뀐 채 남으면 안 된다
    raw: abbr ? String(title).trim() : null,
    captured_at: new Date().toISOString(),
    context,
  };
  ctx.queue.append(entry); // 먼저 큐에 남긴다 — 아래가 실패해도 이 줄은 이미 디스크에 있다(D1/D-01)
  try {
    ctx.store.insertCaptures([entry]);
  } catch {
    try {
      ctx.store.reopen(); // D-03: 한 번 닫았다 다시 열어 재시도
      ctx.store.insertCaptures([entry]);
    } catch {
      ctx.pending += 1; // 재시도까지 실패 — 대기 건수로만 드러낸다. 예외는 위로 올리지 않는다
    }
  }
  ctx.refreshTrayMenu();
  // id는 01-07의 --inject-capture 주입 분기가 CAPTURE_INJECTED 뒤에 찍는 값이다 —
  // 기존 호출부(capture:save/capture:followUp)는 이 필드를 그냥 무시한다.
  return { ok: true, pending: ctx.pending, id: entry.id };
}

// ── D-08: index.mjs에 남아 있던 모든 ipcMain.handle/.on 등록. ctx를 받아 그 안의
// db/queue/settings/tray·백그라운드 작업 모듈·창 함수(main/lifecycle)를 쓴다.
// ipc.mjs는 백그라운드 작업 모듈을 import하지 않는다.
export function registerIpc(ctx) {
  // ── 설정
  //
  // DB가 꺼져 있어도 봐야 하는 화면이라(접속 정보 확인) DB 경로를 타지 않는다.
  // 앱에서 만지는 건 아래 네 개뿐이고, DB 접속은 settings.json을 직접 고쳐 재시작한다.
  const SETTING_KEYS = ['notifyEnabled', 'notifyAt', 'hotkey'];

  ipcMain.handle('settings:get', () => {
    // 01-05: PostgreSQL 접속 정보 대신 저장소(store.mjs) 파일 위치와 상태를 보여준다
    // (RESEARCH `Runtime State Inventory`의 A3 권고) — 사용자 자신의 데이터 파일 위치라
    // 화면에 그대로 드러내도 된다. 다만 오류 안내에는 절대 경로를 넣지 않는다(01-02 규칙).
    const st = ctx.store.status();
    return {
      ok: true,
      values: Object.fromEntries(
        SETTING_KEYS.map((k) => [k, k === 'hotkey' ? (ctx.hotkey ?? platform.defaultHotkey) : ctx.settings.get(k)])
      ),
      defaults: { notifyAt: NOTIFY_AT_DEFAULT, hotkey: platform.defaultHotkey },
      // PLAT-02: 지금 조합이 실제로 잡혀 있는지. 화면이 이 값으로 실패를 드러낸다.
      hotkeyOk: ctx.hotkeyOk,
      platform: platform.name,
      // PLAT-04: 알림이 막혀 화면으로 대신 보여줄 말. 한 번 읽어 가면 비운다.
      notice: (() => {
        const n = ctx.pendingNotice;
        ctx.pendingNotice = null;
        return n;
      })(),
      store: { file: ctx.store.file, ok: st.ok, notice: st.notice },
      file: ctx.settings.file,
    };
  });

  ipcMain.handle('settings:set', (_e, key, value) => {
    if (key === 'hotkey') return { ok: false, reason: 'use hotkey:set' };
    if (!SETTING_KEYS.includes(key)) return { ok: false };
    if (value === null || value === '') ctx.settings.remove(key);
    else ctx.settings.set(key, value);
    ctx.settings.flush(); // 설정은 미루지 않고 바로 쓴다
    return { ok: true };
  });

  ipcMain.handle('settings:openFile', async () => {
    ctx.settings.flush();
    const err = await shell.openPath(ctx.settings.file);
    return { ok: !err };
  });

  // ── IPC
  // 목록은 **렌더러가 가져가게** 한다(push 아님). 첫 핫키에서는 getCaptureWin()이 창을
  // 만드는 중이어서 곧바로 보낸 메시지를 받을 리스너가 아직 없다 — 그래서 앱 재시작 후
  // 첫 퀵캡처에서는 약어 목록이 영원히 비어 있었고 어떤 약어도 인식하지 못했다.
  ipcMain.handle('capture:projects', () => ctx.refreshAbbrHints());

  ipcMain.handle('capture:save', (_e, title) => saveCapture(ctx, title));

  ipcMain.handle('today:getState', async () => {
    // PLAT-04: OS 알림이 막혀 대체된 말은 어느 화면에서든 한 번은 보여야 한다.
    // 한 번 실어 보내면 비운다 — 같은 말이 새로고침마다 다시 뜨면 그게 더 성가시다.
    const notice = ctx.pendingNotice;
    ctx.pendingNotice = null;
    const base = { pending: ctx.pending, notice };
    const st = ctx.store.status();
    if (!st.ok) return { ...base, online: false, notice: st.notice };
    // WR-03: st.ok가 true인 뒤에도 getViewState() 실행 중 SQLite 오류(디스크 I/O 등)가 날 수
    // 있다 — 같은 파일의 history:get·itemOps처럼 try/catch로 감싸 렌더러의 처리되지 않은
    // 프로미스 거부를 막는다.
    try {
      return { ...base, online: true, notice: st.notice, ...ctx.store.getViewState() };
    } catch {
      return { ...base, online: false, notice: '저장소 조회 중 오류가 있었습니다' };
    }
  });

  ipcMain.handle('history:get', async (_e, days = 7) => {
    try {
      return { ok: true, days, ...ctx.store.getHistory(days) };
    } catch {
      return { ok: false };
    }
  });

  const itemOps = {
    'item:complete': (id) => ctx.store.completeItem(id),
    'item:uncomplete': (id) => ctx.store.uncompleteItem(id),
    'item:assign': (id, projectId, keepKind) => ctx.store.assignProject(id, projectId, keepKind),
    'item:toWaiting': (id, who) => ctx.store.toWaiting(id, who),
    'item:rename': (id, title) => ctx.store.renameItem(id, title),
    'item:remove': (id) => ctx.store.removeItem(id),
    'item:restore': (id) => ctx.store.restoreItem(id),
    'item:note': (id, note) => ctx.store.setNote(id, note),
    'project:create': (name) => ctx.store.createProject(name),
    'project:update': (id, fields) => ctx.store.updateProject(id, fields),
    'project:archive': (id) => ctx.store.archiveProject(id),
    'project:move': (id, dir) => ctx.store.moveProject(id, dir),
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

  // 재촉 — 몇 번째인지와 직전 값(되돌리기용)을 돌려줘야 해서 itemOps(ok만 반환)와 따로 둔다
  ipcMain.handle('item:nudge', async (_e, id) => {
    try {
      const res = ctx.store.nudgeItem(id);
      return res ? { ok: true, ...res } : { ok: false };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('item:nudgeUndo', async (_e, id, at, count) => {
    try {
      ctx.store.nudgeRestore(id, at, count);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  // 마감일은 "오늘/내일/8·12" 같은 말로 받는다 — 못 알아들으면 되묻게 ok:false를 돌려준다
  ipcMain.handle('item:due', async (_e, id, text) => {
    const parsed = parseDue(text);
    if (!parsed.ok) return { ok: false, reason: 'parse' };
    try {
      ctx.store.setDue(id, parsed.value);
      return { ok: true, due: parsed.value };
    } catch {
      return { ok: false };
    }
  });

  // PLAT-02: 조합을 바꾸면 **그 조합의 등록 성공 여부까지** 확인해서 돌려준다.
  // 실패하면 설정에 저장하지 않고 이전 조합으로 되돌린다 — 저장해 두면 다음 실행에서도
  // 안 잡히는 조합으로 조용히 시작한다.
  ipcMain.handle('hotkey:set', (_e, accel) => {
    const next = String(accel ?? '').trim();
    if (!next) return { ok: false, error: '조합이 비어 있습니다' };
    const prev = ctx.hotkey;
    if (ctx.applyHotkey(next)) {
      ctx.settings.set('hotkey', next);
      ctx.settings.flush();
      return { ok: true, hotkey: next, label: platform.hotkeyLabel(next) };
    }
    ctx.applyHotkey(prev); // 되돌린다 — 새 조합이 안 잡히는데 옛 조합까지 풀려 있으면 안 된다
    return { ok: false, error: '그 조합은 다른 앱이 쓰고 있거나 잘못된 형식입니다' };
  });

  // ── 내보내기·가져오기 (DATA-01~03)
  //
  // 파일 대화상자를 여는 동안 창이 blur된다 — settings:pickFolder가 쓰던 suppressHide를
  // 같은 이유로 쓴다(그걸로 창을 접으면 사용자가 고른 경로가 갈 곳이 없어진다).
  ipcMain.handle('data:export', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    ctx.suppressHide = true;
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const res = await dialog.showSaveDialog(win, {
        title: '데이터 내보내기',
        defaultPath: `whenwork-${stamp}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      const data = ctx.store.exportAll();
      fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2), 'utf8');
      return { ok: true, path: res.filePath, project: data.project.length, item: data.item.length };
    } catch {
      // 경로를 이유에 넣지 않는다(01-02) — 사용자가 볼 화면에는 사실만 짧게
      return { ok: false, error: '내보내기에 실패했습니다' };
    } finally {
      ctx.suppressHide = false;
      win?.focus();
    }
  });

  ipcMain.handle('data:import', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    ctx.suppressHide = true;
    try {
      const res = await dialog.showOpenDialog(win, {
        title: '데이터 가져오기 — 지금 데이터는 이 파일의 내용으로 바뀝니다',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true };
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
      } catch {
        return { ok: false, error: '읽을 수 없는 파일입니다' };
      }
      const bad = validateExport(parsed);
      if (bad) return { ok: false, error: bad };
      const out = ctx.store.importAll(parsed);
      ctx.todayWin?.webContents.send('today:refresh');
      return { ok: true, ...out };
    } catch {
      return { ok: false, error: '가져오기에 실패했습니다' };
    } finally {
      ctx.suppressHide = false;
      win?.focus();
    }
  });

  ipcMain.on('win:hide', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.hide();
  });

  // 퀵캡처에서 Tab — 캡처를 접고 오늘 뷰를 연다.
  // 방금 던진 것을 정리하러 온 길이라 인박스에 쌓인 게 있으면 그 탭부터 보여준다.
  ipcMain.on('app:open', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.hide();
    ctx.showToday();
    ctx.todayWin?.webContents.send('today:fromCapture');
  });
}
