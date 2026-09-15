// main/lifecycle.mjs — 앱 수명·창·트레이·단축키·ctx 생성 (D-08 분할, main/index.mjs에서 이동)
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  screen,
  Notification,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from './platform/index.mjs';
import { createQueue } from './queue.mjs';
import { createStore } from './store.mjs';
import { createSettings } from './settings.mjs';
import { pickPosition } from './place.mjs';
import { scheduleJobs } from './jobs.mjs';
import { registerIpc, saveCapture } from './ipc.mjs';
import { setupUpdater, updateLine } from './update.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
// 기본 조합은 플랫폼 모듈이 정한다(PLAT-06). 사용자가 바꾼 값은 settings의 hotkey에 있다.
const APP_ID = 'com.when630.whenwork';
const TODAY_W = 880; // 오늘 뷰 — 화면 중앙, 가로 넓게
const TODAY_H = 680;
const CAPTURE_H = 88; // 퀵캡처 — 한 줄 입력 + 힌트 푸터에 딱 맞는 높이
const SMOKE = process.argv.includes('--smoke');

// 01-07: 둘 다 --smoke와 함께일 때만 의미가 있다. 없으면 --smoke는 지금까지와 똑같이 동작한다
// (REL-05가 의존하는 경로를 건드리지 않기 위해서다 — RESEARCH Open Question 2의 권고).
function argValue(prefix) {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}
const SMOKE_DATA = argValue('--smoke-data=');
const INJECT_CAPTURE = argValue('--inject-capture=');
// 릴리스 확인만 한 번 돌리고 결과를 찍은 뒤 끝낸다. 평상시 확인은 60초 뒤에 일어나
// --smoke(1.2초)로는 볼 수 없어, 업데이트 경로가 실제로 도는지 확인할 자리가 없었다.
// 창도 트레이도 만들지 않는다.
const CHECK_UPDATE = process.argv.includes('--check-update');

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
  for (const t of ['inbox', 'waiting', 'projects', 'settings', 'today']) {
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
  await step('history', () => openHistory(7));
  await step('history:close', () => closeHistory());
  await new Promise((r) => setTimeout(r, 300));
  return {
    view: !!window.VIEW,
    tabs: document.getElementById('tabs') ? document.getElementById('tabs').children.length : -1,
    body: document.getElementById('body') ? document.getElementById('body').children.length : -1,
    // 01-07: 강제종료 스모크가 재기동 후 오늘 뷰 상태에서 주입한 캡처를 찾는 창.
    // 스모크는 state.inbox를 갈아끼우지 않으므로 이 값은 여기까지 와도 진짜다.
    inbox: (typeof state !== 'undefined' && state && state.inbox)
      ? state.inbox.map(function (i) { return i.title; })
      : [],
    errors,
  };
})()`;

// 퀵캡처 렌더러 점검. 창 폭이 560px로 고정이라 힌트가 하나 늘면 안내가 조용히 잘리고,
// `#약어` 피드백은 이 창에만 있으므로 실제로 쳐 보지 않으면 깨진 것을 알 수 없다.
const CAPTURE_PROBE = `(async () => {
  const errors = [];
  // 창을 만들자마자 보낸 push는 리스너가 없어 사라진다 — 렌더러가 직접 가져와야 한다.
  // 가져오기는 비동기라 잠깐 기다려 준다(그래도 안 오면 그게 결함이다).
  for (let i = 0; i < 30 && !projects.length; i++) await new Promise((r) => setTimeout(r, 50));
  if (!projects.length) errors.push('약어 목록을 가져오지 못했다 (#약어가 통하지 않는 상태)');
  if (document.getElementById('tokenHint').textContent === '#약어') {
    errors.push('힌트가 실제 약어를 보여주지 않는다: ' + document.getElementById('tokenHint').textContent);
  }
  const foot = document.querySelector('.foot');
  if (foot.scrollWidth > foot.clientWidth + 1) {
    errors.push('푸터가 폭을 넘었다: ' + foot.scrollWidth + ' > ' + foot.clientWidth);
  }
  projects = [{ abbr: 'ex', name: '샘플프로젝트' }];
  const type = function (v) {
    input.value = v;
    input.dispatchEvent(new Event('input'));
    return msg.textContent;
  };
  const hit = type('보고서 초안 #ex');
  if (hit.indexOf('샘플프로젝트') < 0) errors.push('아는 약어인데 프로젝트를 알려주지 않았다: ' + hit);
  // 앞에 치는 손도 받는다 (끝만 받던 동안 조용히 인박스로 갔다)
  const head = type('#ex 보고서 초안');
  if (head.indexOf('샘플프로젝트') < 0) errors.push('앞에 붙인 약어를 알아보지 못했다: ' + head);
  const miss = type('보고서 초안 #exx');
  if (miss.indexOf('없는 약어') < 0) errors.push('없는 약어를 알려주지 않았다: ' + miss);
  const none = type('보고서 초안');
  if (none.indexOf('인박스') < 0) errors.push('토큰이 없으면 기본 안내로 돌아와야 한다: ' + none);
  // 가장 긴 저장 안내가 들어가는지 — 힌트가 늘면 여기가 먼저 잘린다
  msg.className = 'msg ok';
  msg.textContent = '✓ 샘플프로젝트로 저장 · 이번에 3건';
  if (msg.scrollWidth > msg.clientWidth + 1) {
    errors.push('저장 안내가 잘린다: ' + msg.scrollWidth + ' > ' + msg.clientWidth);
  }
  type('');
  return errors;
})()`;

// ── D-08: index.mjs 분할의 진입점. ctx를 만들고 창·트레이·단축키·앱 수명을 등록한 뒤 돌려준다.
// 백그라운드 작업(main/jobs.mjs의 scheduleJobs)과 IPC 핸들러(main/ipc.mjs의 registerIpc)는
// 이 함수가 ctx를 만든 직후 각각 호출해 등록한다 — 세 모듈은 서로 순환 참조하지 않는다.
export function bootstrap() {
  const ctx = {
    tray: null,
    captureWin: null,
    todayWin: null,
    todayHiddenAt: 0, // 트레이 클릭 토글용 — 방금 접혔는지
    quitting: false,
    hotkeyOk: false,
    // 이번 실행에서 즉시 반영에 실패한 캡처 수(D-03) — 큐 줄 수가 아니다. 시작 시 0,
    // replayQueueOnce 성공에서 0으로 되돌아가고, saveCapture의 재시도까지 실패할 때만 늘어난다.
    pending: 0,
    // 폴더 선택 같은 네이티브 다이얼로그가 뜨면 창이 blur된다 — 그때 창을 숨기면 안 된다
    suppressHide: false,
    abbrHints: [],
    // 현재 단축키와 그 등록 성공 여부(PLAT-02). applyHotkey가 둘 다 갱신한다.
    hotkey: null,
    // 알림이 막혀 화면으로 대신 보여줄 말(PLAT-04). 오늘 뷰가 읽어 가면 비운다.
    pendingNotice: null,
    SMOKE,
  };
  // PLAT-04: 알림은 조용히 사라지면 안 된다. OS가 지원하지 않거나(리눅스 일부),
  // 권한이 거부됐거나, show()가 던지면 **앱 안 표시로 대체**한다 — 아침 브리핑이
  // 알림 하나에만 얹혀 있으면 권한을 한 번 거부한 사람에게는 영영 말이 없어진다.
  // 돌려주는 값은 "OS 알림으로 실제로 보여줬는가"다(false면 호출부가 대체를 고른다).
  ctx.notify = (title, body, { onClick } = {}) => {
    if (ctx.SMOKE) return true; // 스모크에서 실제 알림을 띄우지 않는다
    try {
      if (!Notification.isSupported()) throw new Error('unsupported');
      const note = new Notification({ title, body });
      if (onClick) note.on('click', onClick);
      note.show();
      return true;
    } catch {
      ctx.pendingNotice = body ? `${title} — ${body}` : title;
      ctx.todayWin?.webContents.send('today:refresh');
      return false;
    }
  };

  // 스모크는 실사용 인스턴스와 부딪히지 않게 격리한다 — 안 그러면 단일 인스턴스 락에 걸려
  // 아무것도 검증하지 않고 종료 코드 0으로 끝난다(캐시 점유 오류만 남는다).
  // 덤으로 "설정·큐가 빈 첫 실행" 경로를 검증하게 된다.
  if (SMOKE) app.setPath('userData', SMOKE_DATA || path.join(app.getPath('temp'), 'whenwork-smoke'));

  // WR-04: app.quit()은 비동기 종료 요청일 뿐 실행을 멈추지 않는다 — return 없이 두면
  // 락을 얻지 못한 두 번째 인스턴스도 아래 초기화를 계속 진행해 같은 store.sqlite에
  // 두 번째 핸들을 열고, quit 처리가 끝나기 전에 whenReady가 해소되면 트레이·창까지
  // 중복 생성한다. 여기서 멈춰 트레이·저장소·IPC를 만들지 않는다.
  if (!SMOKE && !app.requestSingleInstanceLock()) {
    app.quit();
    return ctx;
  }

  ctx.queue = createQueue(path.join(app.getPath('userData'), 'queue.jsonl'));
  ctx.settings = createSettings(path.join(app.getPath('userData'), 'settings.json'));
  // settings.json의 `db`(PostgreSQL 접속) 설정은 더 이상 읽지 않는다 — 이전 PostgreSQL
  // 저장소 모듈은 삭제되었다(D-05, main/ipc.mjs·main/jobs.mjs 모두 store만 쓴다).

  // 새 저장소(D-14) — settings.json·queue.jsonl 옆의 store.sqlite 한 파일이다. 파일 이름에
  // 앱 이름을 넣지 않아 Phase 5 개명이 파일명을 건드리지 않는다.
  ctx.store = createStore(path.join(app.getPath('userData'), 'store.sqlite'));

  // 스모크는 매번 빈 저장소로 시작한다(의도된 "빈 첫 실행" 경로, D-05). 예전에는
  // capture:projects가 저장소의 프로젝트 데이터에 기대어 약어(#ex) 인식을
  // 검증했지만, 이제 그 데이터가 없는 것이 정상이다 — 검증용 프로젝트 하나를 직접 심어
  // CAPTURE_PROBE가 외부 데이터 없이도 같은 것을 확인하게 한다.
  if (SMOKE) {
    const seedId = ctx.store.createProject('스모크프로젝트');
    if (seedId) ctx.store.updateProject(seedId, { abbr: 'gw' });
  }

  // ipcMain.handle/.on 등록은 원래도 모듈 로드 시점(동기)이었다 — app.whenReady보다 먼저,
  // ctx를 만든 직후 등록한다. 핸들러 본문의 ctx.jobs.* 호출은 실제 IPC가 올 때(항상
  // app.whenReady 이후, scheduleJobs(ctx)가 ctx.jobs를 채운 뒤)에야 실행되므로 안전하다.
  registerIpc(ctx);

  // ── 캡처 컨텍스트
  //
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
      saved: ctx.settings.get(key),
      size: { width, height },
      workAreas: screen.getAllDisplays().map((d) => d.workArea),
      cursorArea: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
      centerY,
    });
    win.setPosition(x, y);
  }
  ctx.placeWindow = placeWindow;

  // 옮기거나 크기를 바꾸면 그 자리를 기억한다
  function rememberPosition(win, key) {
    const save = () => {
      if (win.isDestroyed() || !win.isVisible()) return;
      const [x, y] = win.getPosition();
      ctx.settings.set(key, { x, y });
    };
    win.on('moved', save);
    win.on('resized', save);
  }

  function getCaptureWin() {
    if (ctx.captureWin && !ctx.captureWin.isDestroyed()) return ctx.captureWin;
    ctx.captureWin = new BrowserWindow({
      ...baseWinOpts(560, CAPTURE_H),
      // 크기 고정 — resizable은 켜두되 min=max로 실제 리사이즈는 막는다
      minWidth: 560,
      maxWidth: 560,
      minHeight: CAPTURE_H,
      maxHeight: CAPTURE_H,
      backgroundColor: '#1e2027',
    });
    pinOnTop(ctx.captureWin);
    rememberPosition(ctx.captureWin, 'captureBounds');
    ctx.captureWin.loadFile(path.join(ROOT, 'renderer', 'capture.html'));
    ctx.captureWin.on('blur', () => {
      if (!ctx.suppressHide) ctx.captureWin.hide(); // 다른 데 클릭하면 캡처는 접는다
    });
    ctx.captureWin.on('close', (e) => {
      if (!ctx.quitting) {
        e.preventDefault();
        ctx.captureWin.hide();
      }
    });
    return ctx.captureWin;
  }
  ctx.getCaptureWin = getCaptureWin;

  // 퀵캡처가 약어 목록을 알아야 "#ex"가 어느 프로젝트인지 **그 자리에서** 알려줄 수 있다.
  // 약어를 타이핑하는 곳은 이 창뿐인데 정작 확인할 화면(번호 띠·프로젝트 탭)은 그때 볼 수 없었다.
  // 저장소가 꺼져 있으면 마지막 목록으로 답한다 — 캡처 경로에 저장소 실패를 끌어들이지 않는다(D1).
  async function refreshAbbrHints() {
    try {
      const rows = ctx.store.getProjects();
      ctx.abbrHints = rows.filter((p) => p.abbr).map((p) => ({ abbr: p.abbr, name: p.name }));
    } catch {
      // 못 읽으면 이전 목록을 그대로 쓴다
    }
    return ctx.abbrHints;
  }
  ctx.refreshAbbrHints = refreshAbbrHints;

  function showCapture() {
    const win = getCaptureWin();
    placeWindow(win, 'captureBounds', { centerY: false });
    win.webContents.send('capture:reset'); // 창이 이미 살아 있을 때만 뜻이 있다(갓 만든 창은 비어 있다)
    win.show();
    win.focus();
  }
  ctx.showCapture = showCapture;

  function getTodayWin() {
    if (ctx.todayWin && !ctx.todayWin.isDestroyed()) return ctx.todayWin;
    // 오늘 뷰는 실제로 리사이즈해도 되는 창 — 최소 크기만 잡는다
    const size = ctx.settings.get('todaySize') ?? {};
    ctx.todayWin = new BrowserWindow({
      ...baseWinOpts(size.width ?? TODAY_W, size.height ?? TODAY_H),
      minWidth: 560,
      minHeight: 420,
      backgroundColor: '#16171c',
    });
    pinOnTop(ctx.todayWin);
    rememberPosition(ctx.todayWin, 'todayBounds');
    ctx.todayWin.on('resized', () => {
      const [width, height] = ctx.todayWin.getSize();
      ctx.settings.set('todaySize', { width, height });
    });
    ctx.todayWin.loadFile(path.join(ROOT, 'renderer', 'today.html'));
    ctx.todayWin.on('hide', () => {
      ctx.todayHiddenAt = Date.now();
    });
    ctx.todayWin.on('blur', () => {
      if (!ctx.suppressHide) ctx.todayWin.hide();
    });
    ctx.todayWin.on('close', (e) => {
      if (!ctx.quitting) {
        e.preventDefault();
        ctx.todayWin.hide();
      }
    });
    return ctx.todayWin;
  }
  ctx.getTodayWin = getTodayWin;

  // 트레이를 누르면 창이 blur돼 먼저 접히고, 그 뒤에 click이 와서 다시 열린다 —
  // 그래서 트레이로는 창을 닫을 수 없었다. 방금 접힌 직후의 클릭은 "닫으려는 클릭"으로 본다.
  const TOGGLE_GRACE_MS = 400;

  function toggleToday() {
    const win = getTodayWin();
    if (win.isVisible()) return win.hide();
    if (Date.now() - ctx.todayHiddenAt < TOGGLE_GRACE_MS) return;
    showToday();
  }
  ctx.toggleToday = toggleToday;

  function showToday() {
    const win = getTodayWin();
    placeWindow(win, 'todayBounds'); // 옮겨둔 자리가 있으면 거기, 없으면 화면 중앙
    // 큐 반영은 앱 시작 시 1회뿐이다(D-01/D-02) — 여기서 다시 부르지 않는다.
    // 밀린 캡처가 있다면 다음 기동이 반영하고, 이번 실행의 실패 건수는 ctx.pending이 이미 보여준다.
    win.webContents.send('today:refresh');
    win.show();
    win.focus();
  }
  ctx.showToday = showToday;

  // ── 트레이
  const trayImage = () => platform.trayImage(ROOT);

  // 저장소 상태(D-03) — 예전에 DB 접속 상태를 보여주던 툴팁·메뉴 자리를 그대로 쓴다.
  // 값을 다룰 때는 status().notice의 요약 문구와 정수 건수뿐이다(내부 경로·예외 문자열은 노출하지 않는다).
  function storeStatusLine() {
    const st = ctx.store.status();
    if (st.notice) return st.notice;
    if (ctx.pending > 0) return `${ctx.pending}건이 기다리고 있어요 — 다시 시작하면 반영됩니다`;
    return '저장소 정상';
  }

  function refreshTrayMenu() {
    if (!ctx.tray) return;
    const st = ctx.store.status();
    const tooltipBits = [];
    if (!st.ok) tooltipBits.push(st.notice ?? '저장소 대기');
    if (ctx.pending > 0) tooltipBits.push(`대기 ${ctx.pending}건`);
    ctx.tray.setToolTip(`WHENWORK${tooltipBits.length ? ' — ' + tooltipBits.join(' · ') : ''}`);
    // 01-05: 수집·백업·주간 리뷰 항목과 그 상태 줄을 걷어냈다(D-06) — 관련 배경 작업이
    // main/jobs.mjs에서 이미 사라져 눌러도 할 일이 없었다.
    ctx.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '오늘 뷰', click: toggleToday },
        {
          label: ctx.hotkeyOk
            ? `퀵캡처 (${platform.hotkeyLabel(ctx.hotkey)})`
            : `퀵캡처 — 단축키 등록 실패! (설정에서 다른 조합으로)`,
          click: showCapture,
        },
        { type: 'separator' },
        {
          label: storeStatusLine(),
          enabled: false,
        },
        { type: 'separator' },
        {
          label: '로그인 시 자동 시작',
          type: 'checkbox',
          checked: platform.getLoginItem(app),
          click: (menuItem) => {
            // PLAT-03: 미서명 macOS에서는 켜지지 않을 수 있다 — 돌려받은 값으로 확인하고
            // 실패하면 설정에 저장하지 않는다(다음에 켜졌다고 거짓으로 보이지 않게).
            const ok = platform.setLoginItem(app, menuItem.checked);
            if (ok) ctx.settings.set('openAtLogin', menuItem.checked);
            else ctx.notify('자동 시작을 켜지 못했습니다', '시스템 설정의 로그인 항목에서 직접 추가해 주세요');
            refreshTrayMenu();
          },
        },
        {
          label: '창 위치 초기화',
          click: () => {
            for (const key of ['captureBounds', 'todayBounds', 'todaySize']) ctx.settings.remove(key);
            if (ctx.todayWin && !ctx.todayWin.isDestroyed()) {
              ctx.todayWin.setSize(TODAY_W, TODAY_H);
              if (ctx.todayWin.isVisible()) placeWindow(ctx.todayWin, 'todayBounds');
            }
            if (ctx.captureWin && !ctx.captureWin.isDestroyed() && ctx.captureWin.isVisible()) {
              placeWindow(ctx.captureWin, 'captureBounds', { centerY: false });
            }
          },
        },
        { type: 'separator' },
        {
          // 업데이트 상태는 늘 보인다 — 새 버전이 준비돼도 말이 없으면 영영 안 깔린다.
          // 누르면 상태에 따라 설치(Windows)하거나 받는 곳을 연다(미서명 macOS).
          label: updateLine(ctx.update ?? {}, { canAutoUpdate: platform.canAutoUpdate, current: app.getVersion() }),
          enabled: ctx.update?.status === 'ready' || ctx.update?.status === 'available',
          click: () => ctx.installUpdate?.(),
        },
        { type: 'separator' },
        { label: '종료', click: () => app.quit() },
      ])
    );
  }
  ctx.refreshTrayMenu = refreshTrayMenu;

  // ── 앱 수명
  platform.prepareApp(app, { appId: APP_ID });
  // 개발 실행과 설치본이 같은 userData(큐·설정)를 쓰도록 이름을 고정한다 —
  // 안 그러면 productName 기준으로 갈려서 큐에 쌓인 캡처가 한쪽에만 남는다.
  app.setName('whenwork');

  app.whenReady().then(async () => {
    ctx.tray = new Tray(trayImage());
    ctx.tray.on('click', toggleToday);
    // 단축키는 토글 — 열린 창(오늘 뷰든 캡처든)이 있으면 닫고, 없으면 캡처를 연다
    const onHotkey = () => {
      if (ctx.todayWin && !ctx.todayWin.isDestroyed() && ctx.todayWin.isVisible()) return ctx.todayWin.hide();
      if (ctx.captureWin && !ctx.captureWin.isDestroyed() && ctx.captureWin.isVisible()) return ctx.captureWin.hide();
      showCapture();
    };
    // PLAT-02: 등록은 한 곳에서만 한다 — 설정에서 조합을 바꿔도 같은 함수를 부르므로
    // "바꾼 조합이 실제로 잡혔는지"가 처음 등록과 같은 방식으로 확인된다.
    ctx.applyHotkey = (accel) => {
      globalShortcut.unregisterAll();
      const next = accel || ctx.settings.get('hotkey') || platform.defaultHotkey;
      // register()는 이미 남이 쓰는 조합이면 조용히 false만 낸다. isRegistered()로 한 번 더
      // 확인하는 이유는 macOS에서 register()가 true를 내고도 실제로는 안 잡히는 보고가
      // 있어서다(Phase 4 리서치 플래그) — 두 값이 어긋나면 실패로 본다.
      let ok = false;
      try {
        ok = globalShortcut.register(next, onHotkey) && globalShortcut.isRegistered(next);
      } catch {
        ok = false; // 조합 문자열 자체가 잘못된 경우 register가 던진다
      }
      ctx.hotkey = next;
      ctx.hotkeyOk = ok;
      refreshTrayMenu();
      return ok;
    };
    ctx.applyHotkey();
    if (!ctx.hotkeyOk) {
      ctx.notify('단축키를 등록하지 못했습니다', `${platform.hotkeyLabel(ctx.hotkey)} 를 다른 앱이 쓰고 있습니다 — 설정에서 다른 조합으로 바꿔 주세요`);
    }
    setupUpdater(ctx); // 릴리스 확인 — 60초 뒤 첫 확인, 이후 하루 한 번(main/update.mjs)
    if (CHECK_UPDATE) {
      const st = await ctx.checkForUpdate();
      console.log(
        `UPDATE_CHECK status=${st.status} version=${st.version ?? '-'} canAutoUpdate=${platform.canAutoUpdate} line=${updateLine(st, { canAutoUpdate: platform.canAutoUpdate, current: app.getVersion() })}`
      );
      if (st.rawError) console.log(`UPDATE_RAW ${st.rawError}`);
      ctx.quitting = true;
      return app.exit(st.status === 'error' ? 1 : 0);
    }
    scheduleJobs(ctx); // 큐 flush·수집·브리핑·백업·리뷰·캘린더 타이머 등록 (main/jobs.mjs)

    // 패키징본에서만 자동 시작을 걸어둔다 — 개발 실행(electron.exe)을 등록해봐야 쓸모없다
    if (app.isPackaged && ctx.settings.get('openAtLogin') !== false) {
      platform.setLoginItem(app, true);
    }

    // PLAT-05: 첫 실행 한 번만. 트레이/메뉴바 아이콘이 어디 있는지 모르면 앱이 뜬 줄도
    // 모른다 — 알림이 막혀 있으면 오늘 뷰를 열어 같은 말을 화면으로 보여준다.
    if (!SMOKE && !ctx.settings.get('firstRunShown')) {
      const hint = platform.firstRunHint(platform.hotkeyLabel(ctx.hotkey));
      ctx.settings.set('firstRunShown', true);
      if (!ctx.notify(hint.title, hint.body)) {
        ctx.pendingNotice = `${hint.title} — ${hint.body}`;
        ctx.showToday();
      }
    }

    if (SMOKE && INJECT_CAPTURE) {
      // 01-07 주입 서브모드 — 프로브 대신이다. scheduleJobs(ctx)가 이미 시작 시 큐 반영을
      // 끝낸 뒤, saveCapture(ctx, ...)로 진짜 캡처 경로를 그대로 밟아 한 건을 저장한다.
      // 창을 만들지 않고 프로브도 돌리지 않으며 스스로 종료하지 않는다 —
      // 밖에서 SIGKILL로 죽이는 것이 이 강제종료 스모크의 요점이다.
      const res = saveCapture(ctx, INJECT_CAPTURE, null);
      console.log(`CAPTURE_INJECTED ${res.id}`);
    } else if (SMOKE) {
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
            `SMOKE_${ok ? 'OK' : 'FAIL'} hotkey=${ctx.hotkeyOk} pending=${ctx.queue.count()} renderer=${JSON.stringify(probe)} capture=${JSON.stringify(capture)}`
          );
          ctx.quitting = true;
          app.exit(ok ? 0 : 1);
        }, 1200); // 첫 refresh()가 한 바퀴 돌 시간
      });
    }
  });

  app.on('before-quit', () => {
    ctx.quitting = true;
    ctx.settings.flush(); // 디바운스로 미뤄둔 창 위치를 마저 쓴다
    ctx.store.close(); // wal_checkpoint(TRUNCATE) 후 닫는다(D-17) — store.sqlite 하나만 복사해도 온전해야 한다
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
  // 창을 모두 닫아도 트레이로 산다
  app.on('window-all-closed', () => {});

  return ctx;
}
