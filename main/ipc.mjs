// main/ipc.mjs — 모든 ipcMain 핸들러 등록 (D-08 분할, main/index.mjs에서 이동)
import { BrowserWindow, ipcMain, shell, dialog } from 'electron';
import crypto from 'node:crypto';
import { parseCaptureToken, parseDue, isoWeek, weekRange } from './parse.mjs';
import { maskUrl } from './calendar.mjs';
import { NOTIFY_AT_DEFAULT } from './brief.mjs';

// D-06 레거시 스텁 — 재개 카드 채널(resume:get/resume:sync/resume:generate) 셋이 공유하는
// 빈 반환 형태. 원본 resumePayload와 같은 키를 유지해야 화면(재개 카드 뷰)이 깨지지 않는다.
function resumeStub() {
  return {
    ok: false,
    card: null,
    fresh: 0,
    activities: [],
    issues: [],
    promoted: [],
    generating: false,
    retryAfter: null,
  };
}

// review:get이 필요로 하는 것은 주(week) 라벨뿐이다 — 원래 jobs.mjs의 weekOf()가 하던 계산 중
// 이 부분만 이리로 옮긴다. 나머지(주간 리뷰 생성용 from/to/base)는 D-06으로 걷어낸 기능 전용이라
// main/jobs.mjs에서 함께 지운다(01-05 Task 2).
function weekLabel(weekOffset = 0) {
  const base = new Date();
  base.setDate(base.getDate() + weekOffset * 7);
  const { from, to } = weekRange(base);
  const last = new Date(to.getTime() - 86400000);
  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { label: `${fmt(from)} ~ ${fmt(last)}`, week: isoWeek(base) };
}

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
  const SETTING_KEYS = ['vaultRoot', 'backupDir', 'notifyEnabled', 'notifyAt', 'calendarUrl'];

  ipcMain.handle('settings:get', () => {
    // 01-05: PostgreSQL 접속 정보 대신 저장소(store.mjs) 파일 위치와 상태를 보여준다
    // (RESEARCH `Runtime State Inventory`의 A3 권고) — 사용자 자신의 데이터 파일 위치라
    // 화면에 그대로 드러내도 된다. 다만 오류 안내에는 절대 경로를 넣지 않는다(01-02 규칙).
    const st = ctx.store.status();
    return {
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
      store: { file: ctx.store.file, ok: st.ok, notice: st.notice },
      file: ctx.settings.file,
    };
  });

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

  // D-06 레거시 스텁 — 캘린더 동기화·백업 타이머는 01-05 Task 2가 끈다. 여기서는 아무것도
  // 쓰지 않고 실패만 돌려준다(T-01-05-01).
  ipcMain.handle('calendar:sync', () => ({ ok: false }));

  ipcMain.handle('backup:now', () => ({ ok: false }));

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

  // ── D-06 레거시 스텁 — 제거 대상 기능의 채널. 삭제하지 않고 무해한 값만 돌려준다
  // (아무것도 쓰지 않는다, T-01-05-01). Phase 2가 스텁과 UI를 함께 걷어낸다.
  ipcMain.handle('project:repos', () => ({ ok: false }));
  ipcMain.handle('issue:promote', () => ({ ok: false }));
  ipcMain.handle('item:doneSuggestMute', () => ({ ok: false }));
  ipcMain.handle('inbox:classify', () => ({ ok: false }));

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

  // ── 주간 리뷰 — D-06: 생성은 스텁, 조회는 주 라벨만 계산하고 본문은 항상 비운다.
  // review:get은 새 저장소·db 어느 쪽도 부르지 않는다(week 계산은 순수 함수).
  ipcMain.handle('review:get', async (_e, weekOffset = 0) => {
    try {
      const w = weekLabel(weekOffset);
      return { ok: true, label: w.label, year: w.week.year, week: w.week.week, generating: false, review: null };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('review:generate', () => ({ ok: false }));
  ipcMain.handle('review:openFile', () => ({ ok: false }));

  // ── M2 재개 카드 — D-06: 셋 다 무해한 빈 값. KPI 로깅(resume_open/project_switch)과
  // git·이슈 재수집(collectProject/syncProjectIssues)은 제거 대상 기능이라 함께 걷어낸다.
  ipcMain.handle('resume:get', () => resumeStub());
  ipcMain.handle('resume:sync', () => resumeStub());
  ipcMain.handle('resume:generate', () => resumeStub());

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
