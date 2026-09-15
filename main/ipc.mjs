// main/ipc.mjs — 모든 ipcMain 핸들러 등록 (D-08 분할, main/index.mjs에서 이동)
import { BrowserWindow, ipcMain, shell, dialog } from 'electron';
import crypto from 'node:crypto';
import { collectProject } from './collect.mjs';
import { syncProjectIssues } from './issues.mjs';
import { classifyInbox } from './ai.mjs';
import { parseCaptureToken, parseDue } from './parse.mjs';
import { maskUrl } from './calendar.mjs';
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
  return { ok: true, pending: ctx.pending };
}

// ── D-08: index.mjs에 남아 있던 모든 ipcMain.handle/.on 등록. ctx를 받아 그 안의
// db/queue/settings/tray·백그라운드 작업 모듈·창 함수(main/lifecycle)를 쓴다.
// ipc.mjs는 백그라운드 작업 모듈을 import하지 않는다.
export function registerIpc(ctx) {
  // ── 설정
  //
  // DB가 꺼져 있어도 봐야 하는 화면이라(접속 정보 확인) DB 경로를 타지 않는다.
  // 앱에서 만지는 건 아래 네 개뿐이고, DB 접속은 settings.json을 직접 고쳐 재시작한다.
  const SETTING_KEYS = ['vaultRoot', 'backupDir', 'notifyEnabled', 'notifyAt', 'calendarUrl'];

  ipcMain.handle('settings:get', () => ({
    ok: true,
    // 캘린더 URL에는 토큰이 박혀 있다 — 화면에는 가린 값만 내려보내고 원본은 main에만 둔다
    values: Object.fromEntries(
      SETTING_KEYS.map((k) => [k, k === 'calendarUrl' ? maskUrl(ctx.settings.get(k)) : ctx.settings.get(k)])
    ),
    calendar: { lastSync: ctx.settings.get('lastCalendarSync'), error: ctx.lastCalendarError },
    defaults: { notifyAt: NOTIFY_AT_DEFAULT, backupDir: ctx.jobs.BACKUP_DIR_DEFAULT },
    lastBackup: ctx.settings.get('lastBackup'),
    lastBackupError: ctx.settings.get('lastBackupError'),
    lastReviewError: ctx.settings.get('lastReviewError'),
    db: {
      host: ctx.dbConfig.host ?? '127.0.0.1',
      port: ctx.dbConfig.port ?? 5433,
      database: ctx.dbConfig.database ?? 'whenwork',
      online: ctx.dbOnline,
    },
    file: ctx.settings.file,
  }));

  ipcMain.handle('settings:set', (_e, key, value) => {
    if (!SETTING_KEYS.includes(key)) return { ok: false };
    if (value === null || value === '') ctx.settings.remove(key);
    else ctx.settings.set(key, value);
    ctx.settings.flush(); // 설정은 미루지 않고 바로 쓴다
    return { ok: true };
  });

  ipcMain.handle('settings:pickFolder', async (e, current) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    ctx.suppressHide = true; // 다이얼로그가 뜨면 창이 blur된다 — 그걸로 창을 접지 않는다
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
      ctx.suppressHide = false;
      win?.focus();
    }
  });

  ipcMain.handle('settings:openFile', async () => {
    ctx.settings.flush();
    const err = await shell.openPath(ctx.settings.file);
    return { ok: !err };
  });

  ipcMain.handle('calendar:sync', () => ctx.jobs.syncCalendarNow());

  ipcMain.handle('backup:now', () => ctx.jobs.backupNow());

  // ── IPC
  // 목록은 **렌더러가 가져가게** 한다(push 아님). 첫 핫키에서는 getCaptureWin()이 창을
  // 만드는 중이어서 곧바로 보낸 메시지를 받을 리스너가 아직 없다 — 그래서 앱 재시작 후
  // 첫 퀵캡처에서는 약어 목록이 영원히 비어 있었고 어떤 약어도 인식하지 못했다.
  ipcMain.handle('capture:projects', () => ctx.refreshAbbrHints());

  ipcMain.handle('capture:save', async (_e, title) => {
    const fg =
      (await Promise.race([ctx.pendingContext, new Promise((r) => setTimeout(() => r(null), 300))])) ??
      ctx.cachedForeground();
    return saveCapture(ctx, title, fg ? { fg } : null);
  });

  // 회의 후속 캡처 — 회의는 할 일을 낳는데 그 경로가 손 입력뿐이었다.
  // 캡처 경로는 퀵캡처와 같다(큐 선기록, D1) — 맥락만 창 제목 대신 회의 제목이다.
  ipcMain.handle('capture:followUp', async (_e, title, meeting) => {
    return saveCapture(ctx, title, { meeting: String(meeting?.title ?? '').slice(0, 200) });
  });

  // D-05 전환 기간: 이 핸들러만 새 저장소(store.mjs)를 쓴다. issues/repoStates/events는
  // 제거 대상 기능의 자리였고 store.getViewState()가 채우지 않으므로 빈 배열을 반드시
  // 담아 보낸다 — 렌더러의 SMOKE_PROBE가 state.issues.length를 가드 없이 읽는다.
  ipcMain.handle('today:getState', async () => {
    const base = { pending: ctx.pending, issues: [], repoStates: [], events: [] };
    const st = ctx.store.status();
    if (!st.ok) return { ...base, online: false, notice: st.notice };
    return { ...base, online: true, notice: st.notice, ...ctx.store.getViewState() };
  });

  ipcMain.handle('history:get', async (_e, days = 7) => {
    try {
      return { ok: true, days, ...(await ctx.db.getHistory(days)) };
    } catch {
      return { ok: false };
    }
  });

  const itemOps = {
    'item:complete': (id) => ctx.db.completeItem(id),
    'item:uncomplete': (id) => ctx.db.uncompleteItem(id),
    'item:assign': (id, projectId, keepKind) => ctx.db.assignProject(id, projectId, keepKind),
    'item:toWaiting': (id, who) => ctx.db.toWaiting(id, who),
    'item:rename': (id, title) => ctx.db.renameItem(id, title),
    'item:remove': (id) => ctx.db.removeItem(id),
    'item:restore': (id) => ctx.db.restoreItem(id),
    'item:note': (id, note) => ctx.db.setNote(id, note),
    'project:create': (name) => ctx.db.createProject(name),
    'project:update': (id, fields) => ctx.db.updateProject(id, fields),
    'project:repos': (id, paths) => ctx.db.setRepoPaths(id, paths),
    'project:archive': (id) => ctx.db.archiveProject(id),
    'project:move': (id, dir) => ctx.db.moveProject(id, dir),
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
      const res = await ctx.db.promoteIssue(projectId, {
        url: String(issue?.url ?? ''),
        title: String(issue?.title ?? '').slice(0, 300),
      });
      return { ok: true, ...res };
    } catch {
      return { ok: false };
    }
  });

  // 재촉 — 몇 번째인지와 직전 값(되돌리기용)을 돌려줘야 해서 itemOps(ok만 반환)와 따로 둔다
  ipcMain.handle('item:nudge', async (_e, id) => {
    try {
      const res = await ctx.db.nudgeItem(id);
      return res ? { ok: true, ...res } : { ok: false };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('item:nudgeUndo', async (_e, id, at, count) => {
    try {
      await ctx.db.nudgeRestore(id, at, count);
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
      await ctx.db.setDue(id, parsed.value);
      return { ok: true, due: parsed.value };
    } catch {
      return { ok: false };
    }
  });

  // "아직 안 끝났다"는 답 — 각하한 항목은 다시 제안하지 않는다. U로 되돌린다.
  ipcMain.handle('item:doneSuggestMute', async (_e, id, muted = true) => {
    try {
      await ctx.db.muteDoneSuggest(id, muted);
      return { ok: true };
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
      const [items, projects] = [await ctx.db.getInbox(), await ctx.db.getProjects()];
      if (!items.length) return { ok: true, suggested: 0 };
      const pairs = await ctx.jobs.withAiLog('inbox_classify', () => classifyInbox(items, projects));
      await ctx.db.setSuggestions(pairs);
      await ctx.db.logEvent('inbox_classify', `${pairs.length}/${items.length}`);
      return { ok: true, suggested: pairs.length, total: items.length };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    } finally {
      classifying = false;
    }
  });

  // ── 주간 리뷰 (핸들러만 — 생성 로직은 Task 2의 백그라운드 작업 모듈(makeWeeklyReview))
  ipcMain.handle('review:get', async (_e, weekOffset = 0) => {
    try {
      const w = ctx.jobs.weekOf(weekOffset);
      return {
        ok: true,
        label: w.label,
        year: w.week.year,
        week: w.week.week,
        generating: ctx.reviewing,
        review: await ctx.db.getReview(w.week.year, w.week.week),
      };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('review:generate', (_e, weekOffset = 0) => ctx.jobs.makeWeeklyReview(weekOffset));

  ipcMain.handle('review:openFile', async (_e, file) => {
    if (!file) return { ok: false };
    const err = await shell.openPath(file);
    return { ok: !err };
  });

  // ── M2: 재개 카드 (핸들러만 — 생성·조회 로직은 Task 2의 백그라운드 작업 모듈)
  let lastOpenedProject = null; // 프로젝트 전환 수(9절 KPI)를 세기 위한 직전 프로젝트

  // log=false는 화면을 다시 채우려는 호출이다 — 열람 수(KPI)를 부풀리지 않는다
  ipcMain.handle('resume:get', async (_e, projectId, log = true) => {
    try {
      // KPI: 카드 열람 수와 프로젝트 전환 수 (9절)
      if (log) {
        ctx.db.logEvent('resume_open', String(projectId));
        if (lastOpenedProject !== null && lastOpenedProject !== projectId) {
          ctx.db.logEvent('project_switch', `${lastOpenedProject}->${projectId}`);
        }
        lastOpenedProject = projectId;
      }
      return await ctx.jobs.resumePayload(projectId);
    } catch {
      return { ok: false };
    }
  });

  // git·이슈를 새로 긁고 최신 상태를 돌려준다 — 열 때마다 백그라운드로 부른다.
  // 다만 카드를 열 때마다 gh/glab을 전량 다시 돌리면 리포마다 CLI를 네댓 번 부르는 셈이라,
  // 방금 긁은 프로젝트는 건너뛴다(6시간 주기 수집과 재개 카드 선갱신이 따로 돌고 있다).
  const RESUME_SYNC_MS = 5 * 60 * 1000;
  const lastResumeSync = new Map();

  ipcMain.handle('resume:sync', async (_e, projectId) => {
    try {
      const last = lastResumeSync.get(projectId) ?? 0;
      if (Date.now() - last > RESUME_SYNC_MS) {
        const p = await ctx.jobs.findProject(projectId);
        if (p) {
          await collectProject(ctx.db, p);
          await syncProjectIssues(ctx.db, p);
          lastResumeSync.set(projectId, Date.now());
        }
      }
      return await ctx.jobs.resumePayload(projectId);
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('resume:generate', async (_e, projectId) => {
    if (ctx.generatingCards.has(projectId)) return { ok: false, busy: true };
    try {
      await ctx.jobs.buildResumeCard(projectId);
      return await ctx.jobs.resumePayload(projectId);
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

  // 퀵캡처에서 Tab — 캡처를 접고 오늘 뷰를 연다.
  // 방금 던진 것을 정리하러 온 길이라 인박스에 쌓인 게 있으면 그 탭부터 보여준다.
  ipcMain.on('app:open', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.hide();
    ctx.showToday();
    ctx.todayWin?.webContents.send('today:fromCapture');
  });
}
