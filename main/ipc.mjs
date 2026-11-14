// main/ipc.mjs — 모든 ipcMain 핸들러 등록 (D-08 분할, main/index.mjs에서 이동)
import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseCapture, parseDue } from './parse.mjs';
import { validateExport } from './store.mjs';
import { platform } from './platform/index.mjs';
import { updateLine } from './update.mjs';
import { NOTIFY_AT_DEFAULT, dayKey } from './brief.mjs';
import { SALES_OPEN, SHOP_URL, BUY_KINDS, buyUrl, projectGate } from './plan.mjs';

// 캡처 저장의 단일 경로(D-01/D-03). capture:save 핸들러와 01-07의 주입 모드가 모두
// 이 함수를 부른다 — 경로가 하나여야 테스트가 실경로를 밟는다.
//
// 순서 자체가 계약이다:
// 1) 제목을 다듬는다(던진 글 그대로). 빈 제목이면 { ok: false }.
// 2) queue.append — 동기, fs만 의존. 여기까지 오면 캡처는 이미 보존된 것이다.
// 3) store.insertCaptures를 동기로 즉시 시도한다.
// 4) 던지면 store.reopen() 후 한 번 더 시도한다(D-03).
// 5) 그래도 던지면 ctx.pending += 1. 예외를 위로 올리지 않는다.
// 6) refreshTrayMenu 후 { ok: true, pending: ctx.pending }을 돌려준다.
export function saveCapture(ctx, title, context = null) {
  const text = parseCapture(title);
  if (!text) return { ok: false };
  const entry = {
    id: crypto.randomUUID(),
    title: text,
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
  // 창 고정 모드면 오늘 뷰를 띄워 둔 채로 캡처한다 — 방금 던진 것이 그 화면에 바로 보여야 한다
  const tw = ctx.todayWin;
  if (tw && !tw.isDestroyed() && tw.isVisible()) tw.webContents.send('today:refresh');
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
  const SETTING_KEYS = ['notifyEnabled', 'notifyAt', 'keepOpen', 'keepOnTop', 'hotkey', 'inboxHotkey'];

  // 전역 단축키 두 개. 값은 settings:set이 아니라 hotkey:set으로만 바꾼다 — 등록 성공까지
  // 확인해야 저장할 수 있다. label은 서로 같은 조합을 고르려 할 때 어느 쪽과 겹치는지 말할 때 쓴다.
  const HOTKEYS = {
    hotkey: { apply: (a) => ctx.applyHotkey(a), fallback: platform.defaultHotkey, label: '퀵캡처' },
    inboxHotkey: { apply: (a) => ctx.applyInboxHotkey(a), fallback: platform.defaultInboxHotkey, label: '인박스' },
  };

  ipcMain.handle('settings:get', () => {
    // 01-05: PostgreSQL 접속 정보 대신 저장소(store.mjs) 파일 위치와 상태를 보여준다
    // (RESEARCH `Runtime State Inventory`의 A3 권고) — 사용자 자신의 데이터 파일 위치라
    // 화면에 그대로 드러내도 된다. 다만 오류 안내에는 절대 경로를 넣지 않는다(01-02 규칙).
    const st = ctx.store.status();
    return {
      ok: true,
      values: {
        ...Object.fromEntries(
          SETTING_KEYS.map((k) => [k, k in HOTKEYS ? (ctx[k] ?? HOTKEYS[k].fallback) : ctx.settings.get(k)])
        ),
        // 창 고정 모드는 기본이 꺼짐 — 화면의 토글(값 === false면 켠다)이 그대로 맞도록 불리언으로 준다
        keepOpen: ctx.settings.get('keepOpen') === true,
        // 고정 창을 맨 앞에 두기는 기본이 켜짐 — 고정 모드를 처음 켠 사람은 지금까지와 같은 창을 본다
        keepOnTop: ctx.settings.get('keepOnTop') !== false,
      },
      defaults: { notifyAt: NOTIFY_AT_DEFAULT, hotkey: platform.defaultHotkey, inboxHotkey: platform.defaultInboxHotkey },
      // PLAT-02: 지금 조합이 실제로 잡혀 있는지. 화면이 이 값으로 실패를 드러낸다.
      hotkeyOk: ctx.hotkeyOk,
      inboxHotkeyOk: ctx.inboxHotkeyOk,
      platform: platform.name,
      // PLAT-04: 알림이 막혀 화면으로 대신 보여줄 말. 한 번 읽어 가면 비운다.
      notice: (() => {
        const n = ctx.pendingNotice;
        ctx.pendingNotice = null;
        return n;
      })(),
      store: { file: ctx.store.file, ok: st.ok, notice: st.notice },
      update: {
        ...(ctx.update ?? { status: 'idle' }),
        line: updateLine(ctx.update ?? {}, { canAutoUpdate: platform.canAutoUpdate, current: app.getVersion() }),
        canAutoUpdate: platform.canAutoUpdate,
        current: app.getVersion(),
      },
      file: ctx.settings.file,
    };
  });

  ipcMain.handle('settings:set', (_e, key, value) => {
    if (key in HOTKEYS) return { ok: false, reason: 'use hotkey:set' };
    if (!SETTING_KEYS.includes(key)) return { ok: false };
    if (value === null || value === '') ctx.settings.remove(key);
    else ctx.settings.set(key, value);
    ctx.settings.flush(); // 설정은 미루지 않고 바로 쓴다
    // 창이 앞에 머무는 방식은 띄워 둔 오늘 뷰에 바로 먹인다 — 재시작을 기다리지 않는다
    if (key === 'keepOpen' || key === 'keepOnTop') ctx.applyTodayLayer?.();
    return { ok: true };
  });

  ipcMain.handle('settings:openFile', async () => {
    ctx.settings.flush();
    const err = await shell.openPath(ctx.settings.file);
    return { ok: !err };
  });

  ipcMain.handle('capture:save', (_e, title) => saveCapture(ctx, title));

  ipcMain.handle('today:getState', async () => {
    // PLAT-04: OS 알림이 막혀 대체된 말은 어느 화면에서든 한 번은 보여야 한다.
    // 한 번 실어 보내면 비운다 — 같은 말이 새로고침마다 다시 뜨면 그게 더 성가시다.
    const notice = ctx.pendingNotice;
    ctx.pendingNotice = null;
    // 화면이 조합을 말할 때 쓰는 사람 표기 — 설정을 바꾼 사람에게 기본값을 보여주면 거짓말이다
    const hotkeyLabel = platform.hotkeyLabel(ctx.hotkey ?? platform.defaultHotkey);
    // 인박스 단축키는 실제로 잡혔을 때만 — 안 잡힌 조합을 키맵에 적으면 눌러도 아무 일이 없다
    const inboxHotkeyLabel = ctx.inboxHotkeyOk ? platform.hotkeyLabel(ctx.inboxHotkey) : null;
    // 퀵캡처 Tab이 남긴 "이 탭으로 열어라". 한 번 실어 보내면 비운다 — 다음 새로고침마다
    // 인박스로 튀면 그게 더 성가시다.
    const openTab = ctx.openTab ?? null;
    ctx.openTab = null;
    // 결제 상태가 허용하는 것(D-P03) — 렌더러는 이 값으로 그리기만 하고 스스로 판단하지 않는다
    const ent = ctx.plan();
    // 광고는 결제 상태가 허용할 때만 싣는다(무료). 커피 사주기는 요금제와 상관없이 — 서버가 주소를 둔 앱만
    let ad = null;
    let support = null;
    try {
      const t = ctx.ads.today();
      ad = ent.ads ? t.ad : null;
      support = t.support;
    } catch {}
    const base = { pending: ctx.pending, notice, hotkeyLabel, inboxHotkeyLabel, openTab, ent, ad, support };
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

  // days가 null이면 전 기간이다 — 기본값 인자로 두면 null이 7로 바뀌지 않으므로 그대로 넘긴다
  ipcMain.handle('history:get', async (_e, days = 7) => {
    try {
      return { ok: true, days, ...ctx.store.getHistory(days) };
    } catch {
      return { ok: false };
    }
  });

  // 목록 밖(오래된 완료·지운 항목)까지 검색하려고 검색창을 열 때 한 번 받아 간다
  ipcMain.handle('search:archive', async () => {
    try {
      return { ok: true, items: ctx.store.searchArchive() };
    } catch {
      return { ok: false, items: [] };
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
    'project:update': (id, fields) => ctx.store.updateProject(id, fields),
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

  // 프로젝트 삭제 — 인박스로 보낸 항목 id를 돌려줘야 U가 그것들을 다시 데려갈 수 있다.
  // itemOps(ok만 반환)와 따로 둔다.
  ipcMain.handle('project:delete', async (_e, id) => {
    try {
      return { ok: true, ...ctx.store.deleteProject(id) };
    } catch {
      return { ok: false };
    }
  });

  // 프로젝트 개수 제한(D-P11~13) — 새로 만들기와 지운 것 되살리기에만. 저장소가 아니라 여기서 건다:
  // 가져오기(importAll)·이전 도구가 같은 저장소 함수를 지나도 잘리지 않게(원칙 3).
  // 이미 제한을 넘게 쓰는 사람(그랜드파더)은 아무것도 잃지 않는다 — 새로 늘리지만 못한다.
  function gate() {
    let count = NaN;
    try {
      count = ctx.store.getProjects().length;
    } catch {}
    return projectGate(ctx.plan(), count);
  }

  ipcMain.handle('project:create', async (_e, name) => {
    const g = gate();
    if (!g.ok) return { ok: false, reason: g.reason, limit: g.limit };
    try {
      ctx.store.createProject(name);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('project:restore', async (_e, id, movedItemIds = []) => {
    const g = gate();
    if (!g.ok) return { ok: false, reason: g.reason, limit: g.limit };
    try {
      ctx.store.restoreProject(id, Array.isArray(movedItemIds) ? movedItemIds : []);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

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
  //
  // 비워서 부르면 기본 조합으로 돌린다 — 설정 탭의 X가 이 길을 탄다. 예전에는 X가 settings:set을
  // 불러 거절당하고도 "기본값으로"라고 말했다.
  ipcMain.handle('hotkey:set', (_e, accel, key = 'hotkey') => {
    const slot = HOTKEYS[key];
    if (!slot) return { ok: false, error: '알 수 없는 단축키입니다' };
    const reset = String(accel ?? '').trim() === '';
    const next = reset ? slot.fallback : String(accel).trim();
    // 두 단축키가 같은 조합이면 나중에 등록한 쪽이 먼저 것을 조용히 빼앗는다
    const other = Object.keys(HOTKEYS).find((k) => k !== key && ctx[k] === next);
    if (other) return { ok: false, error: `${HOTKEYS[other].label} 단축키와 같은 조합입니다` };
    const prev = ctx[key];
    if (slot.apply(next)) {
      if (reset) ctx.settings.remove(key);
      else ctx.settings.set(key, next);
      ctx.settings.flush();
      return { ok: true, hotkey: next, label: platform.hotkeyLabel(next) };
    }
    slot.apply(prev); // 되돌린다 — 새 조합이 안 잡히는데 옛 조합까지 풀려 있으면 안 된다
    return { ok: false, error: '그 조합은 다른 앱이 쓰고 있거나 잘못된 형식입니다' };
  });

  // ── 업데이트 (릴리스 감지)
  ipcMain.handle('update:check', async () => {
    const st = await (ctx.checkForUpdate?.() ?? Promise.resolve(ctx.update));
    return { ok: true, ...st, line: updateLine(st ?? {}, { canAutoUpdate: platform.canAutoUpdate, current: app.getVersion() }) };
  });

  // Windows는 설치(재시작), 미서명 macOS는 받는 곳 열기 — 돌려주는 값이 그 차이를 말한다
  ipcMain.handle('update:install', () => ({ ok: true, installing: !!ctx.installUpdate?.() }));

  // ── 내보내기·가져오기 (DATA-01~03)
  //
  // 파일 대화상자를 여는 동안 창이 blur된다 — settings:pickFolder가 쓰던 suppressHide를
  // 같은 이유로 쓴다(그걸로 창을 접으면 사용자가 고른 경로가 갈 곳이 없어진다).
  ipcMain.handle('data:export', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    ctx.suppressHide = true;
    try {
      // 로컬 날짜로 — toISOString()은 UTC라 한국 시간 00~09시에 내보내면 어제 날짜가 붙었다
      const stamp = dayKey();
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
      ctx.sync?.markAllDirty?.(); // 동기화가 켜져 있으면 가져온 행을 다시 올린다 — 다른 PC의 더 최근 변경은 남는다
      ctx.todayWin?.webContents.send('today:refresh');
      return { ok: true, ...out };
    } catch {
      return { ok: false, error: '가져오기에 실패했습니다' };
    } finally {
      ctx.suppressHide = false;
      win?.focus();
    }
  });

  // Esc·헤더 ×가 부른다. 숨기는 순서는 platform이 안다(D8) — Windows는 minimize를 거쳐야 직전 창에 포커스가 돌아온다
  // ── 라이선스 (D-P05). 키 원문은 렌더러로 보내지 않는다 — summary가 앞뒤 4자만 준다.
  const refreshViews = () => {
    const tw = ctx.todayWin;
    if (tw && !tw.isDestroyed()) tw.webContents.send('today:refresh');
  };

  ipcMain.handle('license:get', () => ({
    support: (() => {
      try {
        return ctx.ads.today().support;
      } catch {
        return null;
      }
    })(),
    selling: SALES_OPEN,
    plan: ctx.plan(),
    summary: ctx.license.summary(),
    buyKinds: SALES_OPEN ? BUY_KINDS : [],
    watching: !!ctx.jobs?.purchaseWatching?.(),
  }));

  ipcMain.handle('license:activate', async (_e, key) => {
    const r = await ctx.license.activate(key);
    if (r.ok) refreshViews();
    return r;
  });

  ipcMain.handle('license:deactivate', async (_e, kind) => {
    const r = await ctx.license.deactivate(kind);
    refreshViews();
    return r;
  });

  // 앱 안 구매 — 결제 페이지를 열고, 결제가 끝나면 키 입력 없이 풀리도록 지켜본다
  ipcMain.handle('license:buy', async (_e, kind) => {
    if (!SALES_OPEN) return { ok: false, error: '아직 판매를 시작하지 않았습니다' };
    const url = buyUrl(kind, ctx.license.instanceId());
    if (!url) return { ok: false, error: '살 수 없는 상품입니다' };
    await shell.openExternal(url);
    ctx.jobs?.watchPurchase?.(kind);
    return { ok: true };
  });

  // "결제를 마쳤는데 아직 그대로예요" — 지켜보기를 기다리지 않고 바로 물어본다
  ipcMain.handle('license:claim', async () => {
    const r = await ctx.license.claim();
    if (r.ok) refreshViews();
    return r;
  });

  // 구매 복원(D-P21) — 결제한 이메일로 코드를 받고, 맞으면 이 기기에 켠다
  ipcMain.handle('license:restoreStart', (_e, email) => ctx.license.restoreStart(email));
  ipcMain.handle('license:restoreVerify', async (_e, email, code) => {
    const r = await ctx.license.restoreVerify(email, code);
    if (r.ok) refreshViews();
    return r;
  });

  // ── 클라우드 백업(D-P23). 암호는 렌더러에서 받아 바로 키로 바꾸고 버린다 — 어디에도 저장하지 않는다
  const backupState = () => ({ available: !!ctx.plan().backup, ...ctx.backup.status() });
  ipcMain.handle('backup:get', () => backupState());
  ipcMain.handle('backup:enable', async (_e, password) => {
    const r = await ctx.backup.enable(password);
    return { ...r, state: backupState() };
  });
  ipcMain.handle('backup:disable', () => ({ ...ctx.backup.disable(), state: backupState() }));
  ipcMain.handle('backup:now', async () => {
    const r = await (ctx.jobs?.runBackup ? ctx.jobs.runBackup({ force: true }) : ctx.backup.run({ force: true }));
    return { ...r, state: backupState() };
  });
  ipcMain.handle('backup:list', () => ctx.backup.list());
  ipcMain.handle('backup:restore', async (_e, id, password) => {
    const r = await ctx.backup.restore(id, password || null);
    if (r.ok) {
      ctx.sync?.markAllDirty?.();
      refreshViews();
    }
    return r;
  });

  // ── 기기 간 동기화(D-P26). 암호는 키로 바꾸고 버린다
  const syncState = () => ({ available: !!ctx.plan().sync, ...ctx.sync.status() });
  ipcMain.handle('sync:get', () => syncState());
  ipcMain.handle('sync:enable', async (_e, password, reset) => {
    const r = await ctx.sync.enable(password, { reset: !!reset });
    if (r.ok && r.pulled > 0) refreshViews();
    return { ...r, state: syncState() };
  });
  ipcMain.handle('sync:disable', () => ({ ...ctx.sync.disable(), state: syncState() }));
  ipcMain.handle('sync:now', async () => {
    const r = await (ctx.jobs?.runSync ? ctx.jobs.runSync() : ctx.sync.run());
    return { ...r, state: syncState() };
  });

  ipcMain.on('shop:open', () => shell.openExternal(SHOP_URL));

  // 광고를 눌렀다. 하우스 광고(Lite 안내)는 앱 안 구매로, 나머지는 서버의 /go/<id>로 — 앱은 광고 주소를 모른다
  ipcMain.handle('ad:open', async (_e, id) => {
    const url = ctx.ads.clickUrl(id);
    if (url) {
      await shell.openExternal(url);
      return { ok: true };
    }
    if (!SALES_OPEN) return { ok: false, error: '아직 판매를 시작하지 않았습니다' };
    await shell.openExternal(buyUrl('lite', ctx.license.instanceId()));
    ctx.jobs?.watchPurchase?.('lite');
    return { ok: true, buying: true };
  });

  // 개발자에게 커피 사주기(D-P22) — 서버가 정한 주소로(/go/support)
  ipcMain.handle('support:open', async () => {
    const url = ctx.ads.supportUrl();
    if (!url) return { ok: false };
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.on('win:hide', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win && !win.isDestroyed()) platform.deactivate(win);
  });

  // 퀵캡처에서 Tab — 캡처를 접고 오늘 뷰를 **인박스 탭으로** 연다. 방금 던진 것을 정리하러 온 길이다.
  //
  // 어느 탭으로 열지는 push하지 않고 상태에 실어 둔다(openTab). 창을 지금 만드는 중이면
  // 렌더러에 리스너가 아직 없어 push는 조용히 사라진다 — 그래서 첫 Tab이 늘 오늘 탭으로
  // 열렸다. 렌더러는 어차피 첫 로드에서 getState를 부르므로 거기서 읽어 가면 시점과 무관하다.
  ipcMain.on('app:open', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.hide();
    // 'triage' — 인박스가 비었으면 오늘 탭으로(렌더러 refresh). 인박스 단축키·딥링크의 'inbox'는 비어도 인박스다
    ctx.openTab = 'triage';
    ctx.showToday(); // 이미 열려 있으면 today:refresh를 보내고, 그 refresh가 openTab을 읽는다
  });
}
