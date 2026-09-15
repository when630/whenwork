// main/lifecycle.mjs — 앱 수명·창·트레이·단축키·ctx 생성 (D-08 분할, main/index.mjs에서 이동)
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  screen,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createQueue } from './queue.mjs';
import { createStore } from './store.mjs';
import { createSettings } from './settings.mjs';
import { pickPosition } from './place.mjs';
import { foregroundTitle } from './context.mjs';
import { guessVaultRoot } from './vault.mjs';
import { scheduleJobs } from './jobs.mjs';
import { registerIpc } from './ipc.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const HOTKEY = 'Control+Alt+Space'; // 설계 11절 — Claude 쪽 바인딩은 사용자가 해제함
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
  for (const t of ['inbox', 'waiting', 'issues', 'projects', 'review', 'settings', 'today']) {
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
  // 리뷰 탭에서 이번 주에 → 를 누르면 아무 일도 없어야 한다 —
  // 자리는 그대로인데 화면을 비우고 다시 불러와서 누를 때마다 깜빡였다
  await step('review:week', () => {
    switchTab('review');
    var sentinel = { year: 2026, week: 32, label: 'x', review: null };
    review.data = sentinel;
    var before = review.offset;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    if (review.offset !== before) throw new Error('이번 주에서 → 로 미래 주로 갔다: ' + review.offset);
    if (review.data !== sentinel) throw new Error('이번 주에서 → 가 화면을 비웠다 (깜빡임)');
    if (!document.querySelector('.rv-nav .dim')) throw new Error('갈 데 없는 화살표가 흐려지지 않았다');
    // 지난 주로 옮길 때도 본문을 비우면 빈 화면이 끼어들어 들썩인다 — 옛 본문을 지고 간다
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    if (review.offset !== before - 1) throw new Error('← 로 지난 주로 가지 않았다: ' + review.offset);
    if (review.data !== sentinel) throw new Error('주를 옮기며 본문을 비웠다 (들썩임)');
    // 로딩 표시는 늦어질 때만 — 몇 ms 스치는 「불러오는 중」이 곧 깜빡임이다
    if (review.loading) throw new Error('옮긴 즉시 로딩 표시를 켰다 (깜빡임)');
    // 이번 주는 배지로 붙는다 (제목 뒤 괄호는 주차 숫자와 뒤섞여 읽혔다)
    review.offset = before;
    review.loading = false;
    review.data = { year: 2026, week: 32, label: '2026-08-03 ~ 2026-08-09', review: null };
    render();
    if (!document.querySelector('.rv-head .wk .now')) throw new Error('이번 주 배지가 없다');
    // 기간 줄이 접히면 아래가 들썩인다 — 비어 있어도 자리를 지켜야 한다.
    // 높이는 **숫자로** 먼저 잡아둔다: 다시 그리면 노드가 떼어져 0이 나온다.
    var withText = document.querySelector('.rv-head .range').getBoundingClientRect().height;
    review.data = null;
    review.loading = true;
    render();
    var whileLoading = document.querySelector('.rv-head .range').getBoundingClientRect().height;
    if (Math.abs(whileLoading - withText) > 1) {
      throw new Error('불러오는 동안 기간 줄이 접힌다: ' + withText + ' → ' + whileLoading);
    }
    review.loading = false;
  });
  // 늦어지면 표시는 떠야 한다 — IPC를 늦출 수 없으니 타이머를 직접 걸어 본다
  await step('review:slow', () => scheduleLoading());
  await new Promise((r) => setTimeout(r, 260));
  await step('review:slow-check', () => {
    if (!review.loading) throw new Error('늦어져도 로딩 표시가 켜지지 않는다');
    if (!document.querySelector('.rv-head .spin')) throw new Error('로딩 표시가 그려지지 않았다');
    review.loading = false;
    render();
  });
  // 이슈 탭 — 재개 카드 안에만 있던 열린 이슈를 여기서 본다
  await step('issues', () => {
    if (!state || !state.online) return;
    switchTab('issues');
    if (document.getElementById('numlegend').classList.contains('show')) {
      throw new Error('이슈 탭에는 1~9가 없으므로 번호 띠를 감춰야 한다');
    }
    if (!state.issues.length) return;
    if (!document.querySelector('.issue')) throw new Error('열린 이슈가 그려지지 않았다');
    if (!document.querySelector('.group-h .chip')) throw new Error('이슈가 프로젝트별로 묶이지 않았다');
    if (typeof document.querySelector('.issue .num').onclick !== 'function') {
      throw new Error('이슈 번호에 원본 열기가 붙어 있지 않다');
    }
  });
  // 이슈 행은 재개 카드용 음수 마진을 쓰므로 목록 안에서는 항목 행과 좌우가 어긋난다 — 재 둔다
  await step('issue-align', () => {
    if (!state || !state.online || !state.issues.length) return;
    switchTab('today');
    var item = document.querySelector('.item');
    if (!item) return;
    var itemLeft = item.getBoundingClientRect().left;
    switchTab('issues');
    var iss = document.querySelector('.issue.in-tab');
    if (!iss) throw new Error('이슈 탭 행에 in-tab이 붙지 않았다');
    var d = Math.abs(iss.getBoundingClientRect().left - itemLeft);
    if (d > 1) throw new Error('이슈 행이 항목 행과 좌우가 어긋난다: ' + d.toFixed(1) + 'px');
  });
  // 오늘 탭 그룹 순서 — 마감 순서를 따라가면 자리가 매일 바뀐다(프로젝트 번호가 오름차순이어야 한다)
  await step('group-order', () => {
    if (!state || !state.online) return;
    switchTab('today');
    var nums = [].slice
      .call(document.querySelectorAll('.group-h .chip:not(.cal-chip) .pn'))
      .map(function (n) { return Number(n.textContent); });
    for (var i = 1; i < nums.length; i++) {
      if (nums[i] < nums[i - 1]) throw new Error('그룹이 프로젝트 순서로 서지 않았다: ' + nums.join(','));
    }
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
    // 키는 막았는데 마우스가 열려 있으면 뒤쪽 체크박스를 눌러 엉뚱한 항목이 완료된다
    if (document.querySelector('.app').style.pointerEvents !== 'none') {
      throw new Error('키맵이 떠 있는 동안 뒤쪽 클릭이 열려 있다');
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (panel.classList.contains('show')) throw new Error('Esc로 전체 키맵이 닫히지 않았다');
    if (document.querySelector('.app').style.pointerEvents === 'none') {
      throw new Error('키맵을 닫았는데 클릭이 여전히 막혀 있다');
    }
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
  // 이슈 탭의 서브탭 — ←→로 프로젝트를 오간다. 목록이 서브탭 하나만큼으로 좁아지므로
  // 선택 인덱스가 그리는 것과 어긋나면 엉뚱한 이슈를 T로 담는다. 실제로 키를 눌러 확인한다.
  await step('issue-subtabs', () => {
    if (!state || !state.online) return;
    state.projects = [{ id: 1, name: '가', abbr: 'ga' }, { id: 2, name: '나', abbr: 'na' }];
    state.issues = [
      { project_id: 1, project_name: '가', provider: 'github', kind: 'issue', number: 1, title: '활동 중인 것', url: 'https://example.invalid/1', state: 'open', relation: 'author', active: true },
      { project_id: 2, project_name: '나', provider: 'github', kind: 'issue', number: 2, title: '백로그', url: 'https://example.invalid/2', state: 'open', relation: 'author', active: false },
      { project_id: 2, project_name: '나', provider: 'github', kind: 'issue', number: 3, title: '백로그 둘', url: 'https://example.invalid/3', state: 'open', relation: 'author', active: false },
    ];
    issueSub = null;
    switchTab('issues');
    var bar = document.getElementById('subtabs');
    if (!bar.classList.contains('show')) throw new Error('이슈 탭인데 서브탭 띠가 서지 않았다');
    var labels = [].map.call(bar.querySelectorAll('.subtab span:first-child'), function (s) { return s.textContent; });
    if (labels.join(',') !== '지금,가,나') throw new Error('서브탭 차례가 다르다: ' + labels.join(','));
    if (document.querySelectorAll('.issue').length !== 1) throw new Error('「지금」은 활동 중인 것만 세워야 한다');
    // →로 옮기면 목록도 함께 좁아져야 한다
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    if (currentIssueTab().label !== '가') throw new Error('→가 서브탭을 옮기지 않았다: ' + currentIssueTab().label);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    if (document.querySelectorAll('.issue').length !== 2) throw new Error('「나」의 이슈 2건이 서지 않았다');
    if (currentList().length !== 2) throw new Error('선택 목록이 서브탭을 따라오지 않았다');
    // 끝에서 한 번 더 — 감싸서 첫 자리로 돌아온다
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    if (currentIssueTab().key !== 'now') throw new Error('끝에서 첫 자리로 감싸지 않았다');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    if (currentIssueTab().label !== '나') throw new Error('←가 뒤로 감싸지 않았다');
    // 다른 탭으로 나가면 띠도 물러난다
    switchTab('today');
    if (bar.classList.contains('show')) throw new Error('오늘 탭에서 서브탭 띠가 남았다');
  });
  // 리포에 끝내지 않고 둔 자리 — 프로젝트 줄에 그대로 드러난다
  await step('repo-left', () => {
    if (!state || !state.online) return;
    state.repoStates = [
      { project_id: 1, repo_path: 'D:/x', dirty: 2, ahead: 0, stash_count: 1, stash_at: new Date(Date.now() - 4 * 86400000).toISOString(), label: 'stash 1건 · 작업본 2개' },
    ];
    switchTab('projects');
    var mark = document.querySelector('.proj-left');
    if (!mark) throw new Error('둔 자리가 프로젝트 줄에 그려지지 않았다');
    if (mark.textContent.indexOf('4일째') < 0) throw new Error('며칠째인지가 빠졌다: ' + mark.textContent);
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
      // 완료 제안 — 배지·근거·다음 키(Space/S)가 한 줄로 서는지도 여기서 본다
      done_suggested_at: new Date().toISOString(), done_suggest_why: '원본 이슈 닫힘',
    }];
    state.waiting = [{
      id: 'smoke-2', project_id: 1, project_name: '스모크', kind: 'waiting',
      title: '회신 대기', waiting_for: '아무개',
      captured_at: new Date(Date.now() - 6 * day).toISOString(),
      nudged_at: new Date(Date.now() - day).toISOString(), nudge_count: 2,
    }];
    switchTab('today');
    if (!document.querySelector('.isu.closed')) throw new Error('닫힌 이슈 배지가 그려지지 않았다');
    // 완료 제안 줄 — 표식·근거·다음 키가 함께 서야 한다 (누르지는 않는다 — 실 DB를 건드린다)
    var sg = document.querySelector('.item .suggest');
    if (!sg) throw new Error('완료 제안 줄이 그려지지 않았다');
    if (sg.textContent.indexOf('끝난 듯') < 0) throw new Error('제안 표식이 없다: ' + sg.textContent);
    if (sg.textContent.indexOf('원본 이슈 닫힘') < 0) throw new Error('제안 근거가 없다: ' + sg.textContent);
    if (sg.textContent.indexOf('S 아직') < 0) throw new Error('각하 키 안내가 없다: ' + sg.textContent);
    // 체크박스는 눌러도 되게 생겼으니 실제로 눌려야 한다 (여기서 누르지는 않는다 — 실 DB를 건드린다)
    if (typeof document.querySelector('.item .cb').onclick !== 'function') {
      throw new Error('체크박스에 클릭이 붙어 있지 않다');
    }
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
  projects = [{ abbr: 'gw', name: 'GoWrite' }];
  const type = function (v) {
    input.value = v;
    input.dispatchEvent(new Event('input'));
    return msg.textContent;
  };
  const hit = type('복사버튼 추가 #gw');
  if (hit.indexOf('GoWrite') < 0) errors.push('아는 약어인데 프로젝트를 알려주지 않았다: ' + hit);
  // 앞에 치는 손도 받는다 (끝만 받던 동안 조용히 인박스로 갔다)
  const head = type('#gw 복사버튼 추가');
  if (head.indexOf('GoWrite') < 0) errors.push('앞에 붙인 약어를 알아보지 못했다: ' + head);
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
    lastForeground: null, // { title, at }
    pendingContext: Promise.resolve(null),
    SMOKE,
  };

  // 스모크는 실사용 인스턴스와 부딪히지 않게 격리한다 — 안 그러면 단일 인스턴스 락에 걸려
  // 아무것도 검증하지 않고 종료 코드 0으로 끝난다(캐시 점유 오류만 남는다).
  // 덤으로 "설정·큐가 빈 첫 실행" 경로를 검증하게 된다.
  if (SMOKE) app.setPath('userData', path.join(app.getPath('temp'), 'whenwork-smoke'));

  if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();

  ctx.queue = createQueue(path.join(app.getPath('userData'), 'queue.jsonl'));
  ctx.settings = createSettings(path.join(app.getPath('userData'), 'settings.json'));
  // settings.json의 `db`(PostgreSQL 접속) 설정은 더 이상 읽지 않는다 — main/db.mjs는
  // 이제 아무도 부르지 않는 죽은 파일이다(D-05, main/ipc.mjs·main/jobs.mjs 모두 store만
  // 쓴다). 파일 자체의 삭제는 01-06 소관이다.

  // 새 저장소(D-14) — settings.json·queue.jsonl 옆의 store.sqlite 한 파일이다. 파일 이름에
  // 앱 이름을 넣지 않아 Phase 5 개명이 파일명을 건드리지 않는다.
  ctx.store = createStore(path.join(app.getPath('userData'), 'store.sqlite'));

  // 스모크는 매번 빈 저장소로 시작한다(의도된 "빈 첫 실행" 경로, D-05). 예전에는
  // capture:projects가 개인용 PostgreSQL의 실제 프로젝트 데이터에 기대어 약어(#gw) 인식을
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
  // 창을 열 때 미리 긁어둔다(PowerShell 기동에 300ms쯤 걸려 저장을 기다리게 할 수 없다).
  // 우리 창을 후보에서 빼는 건 context.mjs가 하므로 팝업이 뜬 뒤에 실행돼도 답은 같다.
  // 그래도 못 받은 경우(입력이 300ms보다 빨랐다)는 방금 받아둔 값으로 대신한다 —
  // 퀵캡처는 blur되면 닫히므로 그 값은 사실상 같은 세션의 같은 창이다.
  const FG_CACHE_MS = 120_000;

  function trackForeground() {
    ctx.pendingContext = foregroundTitle().then((title) => {
      if (title) ctx.lastForeground = { title, at: Date.now() };
      return title;
    });
  }
  ctx.trackForeground = trackForeground;

  function cachedForeground() {
    return ctx.lastForeground && Date.now() - ctx.lastForeground.at < FG_CACHE_MS
      ? ctx.lastForeground.title
      : null;
  }
  ctx.cachedForeground = cachedForeground;

  // 볼트 경로는 코드에 박지 않는다 — 설정에 있으면 그걸 쓰고, 없으면 홈에서 한 번 찾아 기억한다.
  // 끝까지 못 찾으면 null이고, 주간 리뷰는 DB에만 남는다(설정 탭에서 지정할 수 있다).
  function vaultRoot() {
    const saved = ctx.settings.get('vaultRoot');
    if (saved) return saved;
    if (ctx.settings.get('vaultSearched')) return null; // 이미 찾아봤는데 없었다 — 매번 훑지 않는다
    const found = guessVaultRoot(app.getPath('home'));
    ctx.settings.set('vaultSearched', true);
    if (found) ctx.settings.set('vaultRoot', found);
    return found;
  }
  ctx.vaultRoot = vaultRoot;

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

  // 퀵캡처가 약어 목록을 알아야 "#gw"가 어느 프로젝트인지 **그 자리에서** 알려줄 수 있다.
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
    trackForeground(); // 저장 시점에 기다리지 않게 미리
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
  function trayImage() {
    const p = path.join(ROOT, 'build', 'tray.png');
    return fs.existsSync(p)
      ? nativeImage.createFromBuffer(fs.readFileSync(p))
      : nativeImage.createEmpty();
  }

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
        { label: `퀵캡처 (${ctx.hotkeyOk ? 'Ctrl+Alt+Space' : '단축키 등록 실패!'})`, click: showCapture },
        { type: 'separator' },
        {
          label: storeStatusLine(),
          enabled: false,
        },
        { type: 'separator' },
        {
          label: '로그인 시 자동 시작',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (menuItem) => {
            app.setLoginItemSettings({ openAtLogin: menuItem.checked, args: [] });
            ctx.settings.set('openAtLogin', menuItem.checked);
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
        { label: '종료', click: () => app.quit() },
      ])
    );
  }
  ctx.refreshTrayMenu = refreshTrayMenu;

  // ── 앱 수명
  app.setAppUserModelId('com.when630.whenwork');
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
    // register()는 이미 남이 쓰는 조합이면 조용히 false만 낸다 — 메뉴에 실패를 드러낸다
    ctx.hotkeyOk = globalShortcut.register(HOTKEY, onHotkey);
    refreshTrayMenu();
    scheduleJobs(ctx); // 큐 flush·수집·브리핑·백업·리뷰·캘린더 타이머 등록 (main/jobs.mjs)

    // 패키징본에서만 자동 시작을 걸어둔다 — 개발 실행(electron.exe)을 등록해봐야 쓸모없다
    if (app.isPackaged && ctx.settings.get('openAtLogin') !== false) {
      app.setLoginItemSettings({ openAtLogin: true, args: [] });
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
