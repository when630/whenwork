// 오늘 뷰 — 탭 4개(오늘/인박스/대기/프로젝트), 마우스 없이 전 조작 가능 (설계 11절).
// Tab 탭 전환 · ↑↓/jk 이동 · Space 완료 · 1~9 프로젝트 지정 · W 대기 · X 삭제 · Esc 닫기
const PROJ_COLORS = ['#f7768e', '#9ece6a', '#7aa2f7', '#e0af68', '#bb9af7', '#7dcfff', '#ff9e64'];
const TABS = [
  { key: 'today', label: '오늘' },
  { key: 'inbox', label: '인박스' },
  { key: 'waiting', label: '대기' },
  { key: 'projects', label: '프로젝트' },
  { key: 'settings', label: '설정' },
];

// 앱에서 만지는 설정. DB 접속은 여기 없다 — settings.json을 고치고 재시작하는 쪽이 안전하다.
const SETTING_FIELDS = [
  {
    key: 'hotkey',
    label: '퀵캡처 단축키',
    kind: 'hotkey',
    hint: 'Enter를 누르고 원하는 조합을 그대로 누르세요 — 등록되는지 그 자리에서 확인합니다',
  },
  {
    key: 'notifyEnabled',
    label: '아침 브리핑 알림',
    kind: 'bool',
    hint: '오늘 마감·지연·오래 기다린 항목을 하루 한 번 알린다',
  },
  { key: 'notifyAt', label: '알림 시각', kind: 'time', hint: 'HH:MM' },
];

let state = null; // 마지막으로 받은 서버 상태
// 첫 화면은 오늘 — 인박스를 기본으로 두었더니 다 분류해 둔 날은 빈 화면으로 열렸다.
// 인박스에 쌓인 게 있으면 첫 로드에서 그쪽으로 옮기고(refresh), 퀵캡처에서 Tab으로
// 건너온 길은 방금 던진 것을 정리하러 온 것이므로 그때도 인박스를 본다.
let tab = 'today';
let firstLoad = true;
let sel = 0; // 현재 탭에서 선택된 행
let dlgResolve = null; // 텍스트 입력 다이얼로그가 기다리는 resolve
let cfg = null; // 설정 탭이 받아둔 값 (DB와 무관하게 따로 읽는다)
let filter = ''; // 검색어 — 탭을 옮겨도 유지된다 (어느 탭에 있는지 모를 때 찾으려고)
let searchOn = false; // 검색 입력에 포커스가 가 있는 동안
let dueOnly = false; // 오늘 탭: 마감 있는 것만 보기 (F)
let history = null; // 완료 기록 화면 상태 (H)
let view = 'list'; // 'list' | 'history'
let resetScroll = false; // 탭·뷰가 바뀐 렌더에서만 맨 위로
// 되돌릴 수 있는 조작 스택 (U) — 최근 것부터. 삭제와 재촉이 함께 쌓인다:
// 둘 다 확인 없이 한 키에 끝나고 취소할 방법이 없던 조작이다.
const undoStack = [];

const clip = (s, n = 24) => (String(s ?? '').length > n ? String(s).slice(0, n) + '…' : String(s ?? ''));

const $ = (id) => document.getElementById(id);

// 계산은 view.js에 있다 (DOM을 만지지 않는 부분 — 테스트 대상)
const {
  dueBadge,
  waitMeta,
  matches,
  todayGroups,
  elapsedDays,
  historyDays,
  dayLabel,
  settingDisplay,
} = window.VIEW;

// ── 스크롤
//
// 렌더는 본문을 통째로 다시 그리므로(replaceChildren) 아무것도 안 하면 스크롤이 매번 위로 튄다.
// 그래서 render가 위치를 기억해 되돌리고, 선택된 행만 보이는 데까지 최소로 끌어온다.
function keepSelectionVisible() {
  $('body').querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
}

// 문서형 화면(리뷰 본문·재개 카드)은 선택 대신 본문을 직접 굴린다
function scrollBody(to) {
  const b = $('body');
  if (to === 'top') b.scrollTop = 0;
  else if (to === 'bottom') b.scrollTop = b.scrollHeight;
  else b.scrollTop += to;
}

function pageStep() {
  return Math.max(120, $('body').clientHeight - 60);
}

// 문서형 화면 공통 스크롤 키. 처리했으면 true.
function handleDocScroll(e, { arrows = false } = {}) {
  switch (e.key) {
    case 'PageDown':
      e.preventDefault();
      scrollBody(pageStep());
      return true;
    case 'PageUp':
      e.preventDefault();
      scrollBody(-pageStep());
      return true;
    case 'Home':
      e.preventDefault();
      scrollBody('top');
      return true;
    case 'End':
      e.preventDefault();
      scrollBody('bottom');
      return true;
    case ' ':
      e.preventDefault();
      scrollBody(e.shiftKey ? -pageStep() : pageStep());
      return true;
    case 'ArrowDown':
    case 'j':
      if (!arrows) return false;
      e.preventDefault();
      scrollBody(80);
      return true;
    case 'ArrowUp':
    case 'k':
      if (!arrows) return false;
      e.preventDefault();
      scrollBody(-80);
      return true;
  }
  return false;
}

function projColor(p) {
  const idx = state?.projects?.findIndex((x) => x.id === p) ?? -1;
  return PROJ_COLORS[idx >= 0 ? idx % PROJ_COLORS.length : 0];
}

// 인박스·오늘·대기 탭의 1~9는 프로젝트 탭 순서다. 그 번호를 이름 옆에 늘 붙여
// "어느 프로젝트가 1번"인지 눈으로 익게 한다 — 번호만 따로 적어두면 아무도 외우지 않는다.
function projNum(pid) {
  const i = state?.projects?.findIndex((x) => x.id === pid) ?? -1;
  return i >= 0 && i < 9 ? String(i + 1) : null;
}

// 프로젝트 이름 칩 — 색점 · 번호 · 이름. 쓰이는 곳이 셋이라 한 곳에서 만든다.
function projChip(pid, name) {
  const chip = el('span', 'chip');
  const dot = el('span', 'dot');
  dot.style.background = projColor(pid);
  chip.append(dot);
  const n = projNum(pid);
  if (n) chip.append(el('b', 'pn', n));
  chip.append(document.createTextNode(name ?? ''));
  return chip;
}

// 지금 등록된 퀵캡처 조합의 사람 표기. main이 platform.hotkeyLabel로 만들어 getState에 실어 준다 —
// 화면 어디서든 조합을 말할 때는 이것만 쓴다. 글자로 박아 두면 바꾼 사람에게 거짓말이 된다.
function hotkeyLabel() {
  return state?.hotkeyLabel || 'Ctrl+Alt+Space';
}

function fmtDate(d = new Date()) {
  return `${d.getMonth() + 1}/${d.getDate()} (${'일월화수목금토'[d.getDay()]})`;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function filtered(list) {
  return filter ? list.filter((r) => matches(r, filter)) : list;
}

function todayView() {
  if (!state?.online) return [];
  let list = filtered(state.today ?? []);
  // 마감 필터: 방금 완료한 것은 남겨둔다 (Space를 잘못 눌렀는지 확인할 창)
  if (dueOnly) list = list.filter((it) => it.due || it.done_at);
  // 그룹 순서는 프로젝트 탭 순서를 따른다 — 마감 순서를 따르면 자리가 매일 바뀐다
  return todayGroups(list, state.projects ?? []);
}

// ── 이슈 탭의 서브탭 (←→)
// 화면에 그려지는 순서 그대로를 돌려준다.
// 오늘 탭은 묶어서 그리므로 그 정렬을 여기서 해야 한다 —
// 안 그러면 선택 강조(그리는 순서)와 실제 대상(원본 순서)이 어긋나 엉뚱한 항목이 지워진다.
function currentList() {
  // 설정은 DB와 무관하게 항상 보여준다 — DB가 꺼져 있을 때 오히려 봐야 하는 화면이다
  if (tab === 'settings') return SETTING_FIELDS;
  if (!state?.online) return [];
  if (tab === 'projects') return filtered(state.projects ?? []);
  if (tab === 'today') return todayView().flatMap((g) => g.items);
  return filtered(state[tab] ?? []);
}

// ── 완료 기록 (H)
//
// 오늘 뷰는 완료를 12시간만 남기므로 "어제 뭐 했지"를 볼 창구가 없었다.
// 체크한 항목과 git 커밋을 하루 단위로 합쳐 보여준다 — 주간 리뷰의 일 단위 짝이다.
const COMMITS_PER_DAY = 12; // 하루에 커밋이 수십 건이어도 윤곽만 보이면 된다

function renderHistory() {
  const body = $('body');
  body.replaceChildren();

  const head = el('div', 'rhead');
  const back = el('span', 'back', '‹');
  back.onclick = closeHistory;
  head.append(back, el('span', 'pname', `완료 기록 — ${historyLabel(history.days)}`));
  body.append(head);

  if (history.loading) {
    body.append(el('div', 'empty', '불러오는 중…'));
    return;
  }
  // / 검색은 여기서도 통한다 — 목록 화면과 같은 matches로 제목·프로젝트·메모를 훑는다
  const data = filter
    ? { ...history.data, items: (history.data?.items ?? []).filter((it) => matches(it, filter)) }
    : history.data;
  const days = historyDays(data);
  if (!days.length) {
    body.append(el('div', 'empty', filter ? `"${filter}"에 맞는 완료 항목 없음` : '이 기간에 완료한 항목도 커밋도 없음'));
    return;
  }

  for (const day of days) {
    const h = el('div', 'hist-day');
    h.append(document.createTextNode(dayLabel(day.key)));
    h.append(el('span', 'n', `완료 ${day.items.length} · 커밋 ${day.commits.length}`));
    body.append(h);
    for (const it of day.items) {
      const row = el('div', 'hist-row');
      row.append(el('span', 'mark', '✓'), el('span', 'tt', it.title));
      if (it.project_name) row.append(el('span', 'p', it.project_name));
      row.append(el('span', 'when', fmtWhen(it.done_at)));
      body.append(row);
    }
    // 커밋은 하루에 수십 건이 될 수 있다 — 그날의 윤곽만 보이면 되므로 잘라 보여준다
    for (const c of day.commits.slice(0, COMMITS_PER_DAY)) {
      const row = el('div', 'hist-row commit-row');
      row.append(el('span', 'mark', '·'), el('span', 'tt', c.summary));
      if (c.project_name) row.append(el('span', 'p', c.project_name));
      row.append(el('span', 'when', fmtWhen(c.occurred_at)));
      body.append(row);
    }
    if (day.commits.length > COMMITS_PER_DAY) {
      const more = el('div', 'hist-row commit-row');
      more.append(el('span', 'mark', ''), el('span', 'tt', `… 커밋 ${day.commits.length - COMMITS_PER_DAY}건 더`));
      body.append(more);
    }
  }
}

// 기간은 7일 → 30일 → 전체로 돈다. 완료 항목은 이 앱의 기억이라 끝까지 닿아야 한다 —
// 7일 고정일 때는 22건 중 19건이 어디서도 보이지 않았다.
const HISTORY_RANGES = [7, 30, null];
const historyLabel = (days) => (days == null ? '전체' : `최근 ${days}일`);

async function openHistory(days = 7) {
  view = 'history';
  history = { days, data: null, loading: true };
  resetScroll = true;
  render();
  const res = await window.whenwork.historyGet(days);
  if (view !== 'history') return;
  history.data = res.ok ? res : null;
  history.loading = false;
  render();
}

function closeHistory() {
  view = 'list';
  history = null;
  resetScroll = true;
  render();
}

// ── 검색
function renderSearch() {
  const bar = $('search');
  const on = searchOn || !!filter;
  bar.classList.toggle('show', on);
  bar.classList.toggle('idle', !searchOn && !!filter);
  if (!on) return;
  const n =
    view === 'history'
      ? (history?.data?.items ?? []).filter((it) => matches(it, filter)).length
      : currentList().length;
  $('searchCnt').textContent = filter ? `${n}건` : '';
}

// ── 전체 키맵 (?)
//
// 하단 힌트는 그 화면에서 지금 쓸 것 네 칸으로 줄이고, 나머지는 여기서 본다.
// 열 칸이 넘어가면 아무것도 읽히지 않는다 — 관심별로 모아두면 오히려 배우기 쉽다.
const KEYMAP = [
  ['이동', [['↑↓', 'jk 이동'], ['Home/End', '처음·끝'], ['PgUp/PgDn', '10줄'], ['Tab', '탭 전환'], ['/', '검색'], ['Esc', '닫기']]],
  ['항목', [['Space', '완료'], ['E', '제목'], ['D', '마감'], ['N', '메모'], ['W', '대기로'], ['X', '삭제'], ['U', '되돌리기'], ['1~9', '프로젝트']]],
  ['오늘', [['F', '마감만'], ['H', '완료 기록']]],
  ['완료 기록', [['←→', '7일·30일·전체'], ['/', '검색'], ['Esc', '뒤로']]],
  ['대기', [['Space', '회신 옴'], ['P', '재촉함']]],
  ['프로젝트', [['N', '추가'], ['E', '이름'], ['Shift+↑↓', '순서'], ['X', '삭제'], ['U', '지운 것 골라 되돌리기']]],
  ['설정', [['Enter', '변경'], ['X', '기본값'], ['E', '내보내기'], ['I', '가져오기'], ['R', '업데이트'], ['O', 'settings.json']]],
  ['퀵캡처', [['{hotkey}', '열기·닫기'], ['Enter', '저장'], ['Tab', '오늘 뷰']]],
];

let keysOpen = false;

function openKeys() {
  const body = $('keysBody');
  body.replaceChildren();
  for (const [group, keys] of KEYMAP) {
    body.append(el('div', 'g', group));
    const ks = el('div', 'ks');
    for (const [key, label] of keys) {
      const s = el('span');
      // {hotkey}는 사용자가 설정한 조합으로 — 기본값을 박아 두면 바꾼 사람에게 거짓말이 된다
      s.append(el('kbd', null, key === '{hotkey}' ? hotkeyLabel() : key), document.createTextNode(' ' + label));
      ks.append(s);
    }
    body.append(ks);
  }
  keysOpen = true;
  setModal(true);
  $('keys').classList.add('show');
}

function closeKeys() {
  keysOpen = false;
  setModal(false);
  $('keys').classList.remove('show');
}

// ── 프로젝트 번호 띠
//
// 1~9로 프로젝트를 지정할 수 있는 탭에서만, 스크롤 밖 고정 자리에 세운다.
// 약어(#ex)를 함께 적는 이유는 캡처 토큰과 같은 어휘를 한자리에서 익히게 하려는 것이다.
const NUM_TABS = ['today', 'inbox', 'waiting'];

function renderLegend() {
  const band = $('numlegend');
  const on = view === 'list' && NUM_TABS.includes(tab) && !!state?.online && !!state?.projects?.length;
  band.classList.toggle('show', on);
  band.replaceChildren();
  if (!on) return;
  state.projects.slice(0, 9).forEach((p, i) => {
    const s = el('span');
    s.append(el('b', null, String(i + 1)), document.createTextNode(p.name));
    band.append(s);
  });
}

function openSearch() {
  if (tab === 'settings') return; // 설정에는 검색할 목록이 없다
  searchOn = true;
  render();
  const input = $('searchIn');
  input.value = filter;
  input.focus();
  input.select();
}

// keep=false면 필터까지 해제한다 (Esc)
function closeSearch(keep) {
  searchOn = false;
  if (!keep) filter = '';
  $('searchIn').blur();
  sel = 0;
  resetScroll = true;
  render();
}

// ── 렌더
function render() {
  const body = $('body');
  const keep = resetScroll ? 0 : body.scrollTop;
  resetScroll = false;
  $('date').textContent = fmtDate();
  renderSearch();
  if (view === 'history') {
    $('tabs').replaceChildren();
    renderHistory();
  } else {
    renderTabs();
    renderBody();
  }
  renderLegend();
  renderFooter();
  body.scrollTop = keep;
  keepSelectionVisible();
}

// 완료 기록 등에서 쓰는 짧은 시각 표기
function fmtWhen(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? `오늘 ${hm}` : `${d.getMonth() + 1}/${d.getDate()}`;
}


function renderTabs() {
  const tabs = $('tabs');
  tabs.replaceChildren();
  for (const t of TABS) {
    // 검색 중에는 탭 숫자도 매칭 건수 — 어느 탭에 있는지 배지만 보고 알 수 있다
    const n = t.key === 'settings' ? null
      : !state?.online ? 0
      : t.key === 'projects' ? filtered(state.projects ?? []).length
      : filtered(state[t.key] ?? []).filter((i) => !i.done_at).length;
    const node = el('div', 'tab' + (tab === t.key ? ' on' : ''));
    node.append(el('span', null, t.label));
    if (n !== null) node.append(el('span', 'n', String(n)));
    node.onclick = () => switchTab(t.key);
    tabs.append(node);
  }
}

// 이슈 탭에서만 서는 두 번째 띠. 프로젝트가 몇 개뿐이라 목록보다 탭이 읽기 빠르다.
function itemRow(it, idx) {
  const row = el('div', 'item' + (idx === sel ? ' selected' : '') + (it.done_at ? ' done' : ''));
  // 체크박스는 눌러도 되게 생겼으니 실제로 눌리게 한다 (키보드는 Space)
  const cb = el('div', 'cb');
  cb.onclick = (ev) => {
    ev.stopPropagation();
    sel = idx;
    toggleDone(it);
  };
  row.append(cb, el('div', 't', it.title));
  const badge = dueBadge(it.due);
  if (badge) {
    const meta = el('div', 'meta');
    meta.append(el('span', 'due ' + badge.cls, badge.text));
    row.append(meta);
  }
  if (it.note) row.append(el('div', 'ctx', `↳ ${it.note}`));
  if (tab === 'waiting') {
    const w = waitMeta(it);
    const meta = el('div', 'wait-meta');
    meta.append(document.createTextNode(`→ ${it.waiting_for || '(미지정)'} · `));
    meta.append(el('span', 'elapsed' + (w.hot ? ' hot' : ''), w.label));
    if (w.nudges) meta.append(el('span', 'nudge-n', `재촉 ${w.nudges}회`));
    // 어느 프로젝트의 대기인지 — 이 표시가 없어서 1~9로 프로젝트를 지정해도 화면이 그대로였다
    if (it.project_name) meta.append(projChip(it.project_id, it.project_name));
    row.append(meta);
  }
  row.onclick = () => {
    sel = idx;
    render();
  };
  return row;
}

function renderSettings() {
  const body = $('body');
  body.replaceChildren();
  if (!cfg) {
    body.append(el('div', 'empty', '설정을 불러오는 중…'));
    return;
  }

  SETTING_FIELDS.forEach((f, idx) => {
    const row = el('div', 'item' + (idx === sel ? ' selected' : ''));
    row.append(el('div', 't', f.label));
    const v = cfg.values[f.key];
    const isDefault = f.kind === 'bool' ? false : !v;
    row.append(el('span', 'set-val' + (isDefault ? ' dim' : ''), settingDisplay(f, cfg.values, cfg.defaults, { hotkeyOk: cfg.hotkeyOk })));
    row.append(el('div', 'ctx', f.hint));
    row.onclick = () => {
      sel = idx;
      render();
    };
    body.append(row);
  });

  const dbSec = el('div', 'set-foot');
  dbSec.append(el('div', 'sec-h', '저장소'));
  // 저장소 파일 위치와 상태 — 사용자 자신의 데이터 파일 위치라 화면에 그대로 드러내도 된다
  // (오류 안내에는 절대 경로를 넣지 않는다는 규칙과는 별개).
  dbSec.append(
    el('div', 'ctx', `${cfg.store.file} — ${cfg.store.ok ? '정상' : (cfg.store.notice ?? '대기 중')}`)
  );
  const open = el('div', 'set-act');
  open.append(window.ICONS.context(), document.createTextNode(` ${cfg.file} — 열기`));
  open.onclick = () => window.whenwork.settingsOpenFile();
  dbSec.append(open);

  // ── 업데이트
  const upSec = el('div', 'set-foot');
  upSec.append(el('div', 'sec-h', '업데이트'));
  const up = cfg.update ?? {};
  upSec.append(el('div', 'ctx', up.line ?? `현재 ${up.current ?? ''}`));
  if (!up.canAutoUpdate) {
    // 미서명 macOS는 자동 설치가 불가능하다 — 왜 직접 받아야 하는지 그 자리에서 말한다
    upSec.append(el('div', 'ctx', '서명하지 않은 앱이라 macOS에서는 자동 설치가 되지 않습니다 — 새 버전은 직접 받아 주세요'));
  }
  const upAct = el('div', 'set-act');
  const ready = up.status === 'ready' || up.status === 'available';
  upAct.append(
    window.ICONS.context(),
    document.createTextNode(ready ? (up.canAutoUpdate ? ' 지금 설치 (R)' : ' 받는 곳 열기 (R)') : ' 지금 확인 (R)')
  );
  upAct.onclick = runUpdate;
  upSec.append(upAct);
  body.append(upSec);

  // ── 내 데이터 (DATA-01~03)
  const dataSec = el('div', 'set-foot');
  dataSec.append(el('div', 'sec-h', '내 데이터'));
  dataSec.append(el('div', 'ctx', 'JSON 파일 하나로 내보내고, 다른 PC에서 그 파일로 되살립니다'));
  const exp = el('div', 'set-act');
  exp.append(window.ICONS.context(), document.createTextNode(' 내보내기 (E)'));
  exp.onclick = runExport;
  const imp = el('div', 'set-act');
  imp.append(window.ICONS.context(), document.createTextNode(' 가져오기 (I) — 지금 데이터를 덮어씁니다'));
  imp.onclick = runImport;
  dataSec.append(exp, imp);
  body.append(dataSec);
  body.append(dbSec);
}

// 확인과 설치를 한 키(R)에 둔다 — 상태에 따라 할 일이 하나뿐이라 고르게 할 이유가 없다.
async function runUpdate() {
  const up = cfg?.update ?? {};
  if (up.status === 'ready' || up.status === 'available') {
    const res = await window.whenwork.updateInstall();
    // installing이 false면 자동 설치가 안 되는 쪽이라 받는 곳을 열었다는 뜻이다
    if (!res.installing) toast('받는 곳을 열었습니다 — 내려받아 덮어써 주세요', { holdMs: 5000 });
    return;
  }
  toast('업데이트 확인 중…', { spinner: true, holdMs: 0 });
  const res = await window.whenwork.updateCheck();
  toast(res.line ?? '확인했습니다', { holdMs: 4000 });
  return loadSettings();
}

async function runExport() {
  const res = await window.whenwork.dataExport();
  if (res.canceled) return;
  if (!res.ok) return toast(res.error ?? '내보내기 실패');
  toast(`내보냄 — 프로젝트 ${res.project}건 · 항목 ${res.item}건`);
}

// 가져오기는 되돌릴 수 없게 보이면 안 된다 — 직전 백업이 자동으로 남는다는 사실을
// 확인 문구에 함께 적는다(그 백업이 없으면 store.importAll이 아예 가져오지 않는다).
async function runImport() {
  const yes = await promptText('가져오면 지금 데이터가 파일의 내용으로 바뀝니다 (직전 상태는 자동 백업). 계속하려면 y', '');
  if (yes?.toLowerCase() !== 'y') return;
  const res = await window.whenwork.dataImport();
  if (res.canceled) return;
  if (!res.ok) return toast(res.error ?? '가져오기 실패', { holdMs: 6000 });
  toast(`가져옴 — 프로젝트 ${res.project}건 · 항목 ${res.item}건`, { holdMs: 4000 });
  await loadSettings();
  return refresh();
}

async function loadSettings() {
  cfg = await window.whenwork.settingsGet();
  render();
}

async function editSetting(f) {
  if (!f || !cfg) return;
  if (f.kind === 'bool') {
    await window.whenwork.settingsSet(f.key, cfg.values[f.key] === false);
    return loadSettings();
  }
  if (f.kind === 'hotkey') {
    const accel = await captureHotkey(cfg.values.hotkey ?? '');
    if (!accel) return;
    const res = await window.whenwork.hotkeySet(accel);
    if (!res.ok) return toast(res.error ?? '단축키를 등록하지 못했습니다', { holdMs: 5000 });
    toast(`단축키 ${res.label} 로 바뀌었습니다`);
    return loadSettings();
  }
  const raw = await promptText(`${f.label} (${f.hint})`, cfg.values[f.key] ?? cfg.defaults?.notifyAt ?? '');
  if (raw === null) return;
  if (!raw) {
    await window.whenwork.settingsSet(f.key, null);
    return loadSettings();
  }
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return toast('시각 형식이 아님 — HH:MM');
  await window.whenwork.settingsSet(f.key, `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`);
  return loadSettings();
}

async function clearSetting(f) {
  if (!f) return;
  // 토큰이 박힌 값은 지우면 앱에서 되살릴 수 없다(화면에는 가린 값만 있다) —
  // 프로젝트 삭제와 같은 y 확인을 받는다. 폴더·시각은 다시 고르면 되니 묻지 않는다.
  if (f.kind === 'secret' && cfg?.values?.[f.key]) {
    const yes = await promptText(`${f.label} 해제? 지우려면 y 입력`, '');
    if (yes?.toLowerCase() !== 'y') return;
  }
  await window.whenwork.settingsSet(f.key, null);
  toast(`${f.label} — ${f.kind === 'secret' ? '해제' : '기본값으로'}`);
  return loadSettings();
}

function renderBody() {
  const body = $('body');
  if (tab === 'settings') return renderSettings();
  body.replaceChildren();

  if (!state) return;
  if (!state.online) {
    const e = el('div', 'empty');
    e.append(
      el('div', 'big', '⏳'),
      el('div', null, state.notice || '저장소를 열지 못했습니다'),
      el('div', null, `대기 ${state.pending}건 · 캡처는 계속 가능`)
    );
    body.append(e);
    return;
  }

  // 저장소는 열려 있지만 대기 건이 있거나(D-03) 방금 손상을 격리했다는 안내(D-15)가
  // 있으면 목록을 그리기 전에 오늘 뷰 상단에 한 줄 붙인다.
  if (state.pending > 0 || state.notice) {
    const notice = el('div', 'sync-note');
    notice.textContent = state.notice
      ? state.notice
      : `${state.pending}건이 기다리고 있어요 — 다시 시작하면 반영됩니다`;
    body.append(notice);
  }

  const list = currentList();
  sel = Math.min(sel, Math.max(0, list.length - 1));

  if (list.length === 0) {
    const e = el('div', 'empty');
    if (filter) {
      const hint = el('div');
      hint.append(el('kbd', null, 'Esc'), document.createTextNode(' 로 검색 해제'));
      e.append(el('div', 'big', '◎'), el('div', null, `"${filter}"에 맞는 항목 없음`), hint);
    } else if (tab === 'projects') {
      const hint = el('div');
      hint.append(el('kbd', null, 'N'), document.createTextNode(' 으로 추가'));
      e.append(el('div', 'big', '◎'), el('div', null, '프로젝트 없음'), hint);
    } else {
      const hint = el('div');
      hint.append(document.createTextNode('생각나면 '));
      // 사용자가 바꾼 조합을 그대로 보여준다. macOS 표기(⌃⌥Space)는 +가 없어 한 덩이로 온다.
      hotkeyLabel()
        .split('+')
        .filter(Boolean)
        .forEach((k, i) => {
          if (i) hint.append(document.createTextNode('+'));
          hint.append(el('kbd', null, k));
        });
      hint.append(document.createTextNode(' 로 던져두기'));
      e.append(el('div', 'big', '◎'), el('div', null, '항목 없음'), hint);
    }
    body.append(e);
    return;
  }


  if (tab === 'projects') {
    list.forEach((p, idx) => {
      const row = el('div', 'item' + (idx === sel ? ' selected' : ''));
      row.append(el('span', 'proj-num', idx < 9 ? String(idx + 1) : ''));
      // 색점만. #약어를 걷어내기 전에는 여기 약어 알약이 섰고, 약어가 없는 프로젝트는
      // 빈 자리를 '—'로 채웠다 — 그 작대기가 약어처럼 읽혔다. 색은 1~9 번호와 짝을 이뤄
      // 다른 탭에서도 같은 프로젝트를 가리키므로 그대로 쓸모가 있다.
      const dot = el('span', 'dot bare');
      dot.style.background = projColor(p.id);
      row.append(el('div', 't', p.name), dot);
      row.onclick = () => {
        sel = idx;
        render();
      };
      body.append(row);
    });
    return;
  }

  if (tab === 'today') {
    // 그룹 구성은 todayView가 정한다 — currentList의 flat 순서와 같은 순서라 선택 인덱스가 맞는다
    let idx = 0;
    for (const g of todayView()) {
      const h = el('div', 'group-h');
      h.append(projChip(g.pid, g.label));
      body.append(h);
      for (const it of g.items) body.append(itemRow(it, idx++));
    }
  } else {
    list.forEach((it, idx) => body.append(itemRow(it, idx)));
  }

}

function renderFooter() {
  const sync = $('sync');
  const online = state?.online;
  sync.classList.toggle('off', !online);
  $('syncText').textContent = online
    ? state.pending ? `대기 ${state.pending}건 — 다시 시작하면 반영` : '저장소 정상'
    : `저장소 대기 — 대기 ${state?.pending ?? 0}건`;

  // 지금 화면에서 자주 쓰는 것만 — 나머지는 ?(전체 키맵)에서 본다.
  // 힌트가 열 칸을 넘어가면 결국 아무것도 읽히지 않는다.
  const hints = $('hints');
  hints.replaceChildren();
  const add = (key, label) => {
    const s = el('span');
    s.append(el('kbd', null, key), document.createTextNode(' ' + label));
    hints.append(s);
  };
  if (view === 'history') {
    add('←→', '기간');
    add('/', '검색');
    add('Esc', '뒤로');
  } else if (tab === 'settings') {
    add('Enter', '변경');
    add('E', '내보내기');
    add('I', '가져오기');
    add('R', '업데이트');
  } else if (tab === 'projects') {
    add('N', '추가');
    add('E', '이름');
    add('X', '삭제');
    add('U', '지운 것 되돌리기');
  } else if (tab === 'inbox') {
    add('1~9', '프로젝트');
    add('W', '대기로');
  } else if (tab === 'waiting') {
    add('Space', '회신 옴');
    add('P', '재촉함');
    add('1~9', '프로젝트');
  } else {
    add('Space', '완료');
    add('E', '제목');
    add('D', '마감');
    add('W', '대기로');
  }
  // Esc의 뜻이 바뀌는 순간만 알린다 (평소엔 창 닫기라 관습으로 안다)
  if (filter && view === 'list') add('Esc', '검색 해제');
  add('?', '전체 키');
}

// ── 회의 후속 캡처 (M)
//

// 완료 토글 — Space와 체크박스 클릭이 같은 길을 쓴다
async function toggleDone(it) {
  if (!it) return;
  if (it.done_at) await window.whenwork.uncomplete(it.id);
  else await window.whenwork.complete(it.id);
  return refresh();
}

// ── 동작
async function refresh() {
  state = await window.whenwork.getState();
  // PLAT-04: 알림이 막혀 대체된 말 — 알림 대신이므로 오래 세워 둔다
  if (state?.notice) toast(state.notice, { holdMs: 9000 });
  // 첫 로드에서만 탭을 고른다 — 인박스에 쌓인 게 있으면 그것부터 치우는 게 순서다.
  // 매번 고르면 일하는 중에 탭이 저절로 바뀐다.
  // DB가 아직 안 붙었으면 판단을 미룬다 — 오프라인 첫 로드에서 기회를 잃지 않게
  if (firstLoad && state?.online) {
    firstLoad = false;
    if (state.inbox?.length) tab = 'inbox';
  }
  // 퀵캡처에서 Tab으로 건너왔다 — 방금 던진 것을 정리하러 온 길이다. 인박스에 쌓인 게 있으면
  // 거기로, 비어 있으면(저장이 실패했거나 던진 게 없으면) 정리할 것이 없으니 오늘 탭으로.
  if (state?.openTab === 'inbox' && view === 'list') {
    tab = state.online && state.inbox?.length ? 'inbox' : 'today';
    sel = 0;
    resetScroll = true;
  }
  render();
}

function switchTab(key) {
  tab = key;
  sel = 0;
  resetScroll = true;
  render();
  if (key === 'settings') loadSettings();
}

function selectedItem() {
  return currentList()[sel] ?? null;
}

// 다이얼로그·키맵이 떠 있는 동안은 뒤쪽 화면을 클릭으로도 만지지 못하게 한다.
// 키는 이미 막았는데 마우스는 열려 있어서, 마감일을 묻는 창을 띄운 채 다른 행의 체크박스를
// 눌러 엉뚱한 항목을 완료할 수 있었다. #dlg·#keys는 .app 밖이라 그대로 쓸 수 있다.
function setModal(on) {
  document.querySelector('.app').style.pointerEvents = on ? 'none' : '';
}

// 한 줄 텍스트 입력 — null이면 취소.
// 호출부는 반드시 keydown을 preventDefault한 뒤에 부른다. 안 그러면 다이얼로그를 연 그 키의
// 기본 동작(문자 입력)이 방금 포커스된 입력창으로 들어간다 — 아래 rAF 리셋은 그 2차 방어.
function promptText(label, initial = '') {
  return new Promise((resolve) => {
    dlgResolve = resolve;
    setModal(true);
    $('dlgLabel').textContent = label;
    $('dlgIn').value = initial;
    $('dlg').classList.add('show');
    $('dlgIn').focus();
    requestAnimationFrame(() => {
      if (dlgResolve === resolve && $('dlgIn').value !== initial) {
        $('dlgIn').value = initial;
        $('dlgIn').select();
      }
    });
  });
}

// 프로젝트 순서 이동 — 선택 표시도 함께 따라간다
// 지운 프로젝트를 골라서 되돌린다. 프로젝트 탭의 U는 "마지막 조작 취소"가 아니라 이것이다 —
// 지운 것은 화면에서 사라지므로 어느 것을 되돌릴지 사용자가 볼 자리가 여기밖에 없고,
// 재시작 뒤에는 U 스택이 비어 있어도 store의 deletedProjects는 남아 있다.
//
// 이번 실행에서 지운 것이면 U 스택에 그때 인박스로 보낸 항목 id가 있어 함께 데려온다.
// 재시작 뒤라면 그 목록이 없다 — 항목은 인박스에 그대로 두고 프로젝트만 되살린다(사용자가
// 그 사이 다른 데로 옮겼을 수도 있는 것을 되돌리기가 뒤집지 않는다).
async function restoreProjectPick() {
  const gone = state?.deletedProjects ?? [];
  if (!gone.length) return toast('되돌릴 프로젝트 없음');
  const lines = gone.slice(0, 9).map((g, i) => `${i + 1} ${g.name}`).join(' · ');
  const raw = await promptText(`되돌릴 프로젝트 번호 (최근 순): ${lines}`, '1');
  if (raw === null) return;
  const n = Number(raw);
  const pick = gone[n - 1];
  if (!pick) return toast('그 번호의 프로젝트가 없습니다');
  const i = undoStack.findLastIndex((u) => u.kind === 'projectDelete' && u.id === pick.id);
  const itemIds = i >= 0 ? undoStack[i].itemIds : [];
  if (i >= 0) undoStack.splice(i, 1);
  const res = await window.whenwork.projectRestore(pick.id, itemIds);
  if (!res.ok) return toast('되돌리기 실패');
  toast(`되돌림 — "${clip(pick.name)}"${itemIds.length ? ` · 할 일 ${itemIds.length}건도 함께` : ''}`);
  return refresh();
}

async function moveProject(dir) {
  const p = currentList()[sel];
  if (!p) return;
  await window.whenwork.projectMove(p.id, dir);
  sel = Math.max(0, Math.min(sel + (dir === 'up' ? -1 : 1), currentList().length - 1));
  await refresh();
}

// Tab 순환의 다음 탭. 검색 중에도 같은 순서로 옮겨야 하므로 한 곳에 둔다.
function nextTabKey(shift) {
  const i = TABS.findIndex((t) => t.key === tab);
  return TABS[(i + (shift ? TABS.length - 1 : 1)) % TABS.length].key;
}

// 짧은 알림 — 오래 걸리는 AI 작업의 진행 상태를 보여준다
let toastTimer = null;
function toast(text, { spinner = false, holdMs = 2400 } = {}) {
  const node = $('toast');
  clearTimeout(toastTimer);
  node.replaceChildren();
  if (spinner) node.append(el('span', 'spin'));
  node.append(document.createTextNode(text));
  node.classList.add('show');
  if (holdMs) toastTimer = setTimeout(() => node.classList.remove('show'), holdMs);
}

// ── 단축키 잡기 — 글자로 치는 대신 실제로 누른다
//
// "Control+Alt+Space"를 타자로 치라는 건 Electron 표기법을 외우라는 말이다. 여기서는 조합을
// 누르면 그 자리에서 읽어 준다. 수식키만 누르고 있으면 미리보기만 바뀌고, 글자·숫자·기능키
// 하나가 떨어지는 순간 확정된다. Esc는 취소, 수식키 없는 키 하나는 받지 않는다 — 전역
// 단축키가 맨 글자 하나를 가로채면 그 글자를 다른 앱에서 칠 수 없게 된다.
let hotkeyCapture = null; // { resolve, isMac }

// KeyboardEvent.code → Electron 가속기 키 이름. 레이아웃에 흔들리지 않게 code를 쓴다
// (key를 쓰면 한글 자판에서 'ㅁ' 같은 것이 온다).
const CODE_TO_ACCEL = {
  Space: 'Space', Enter: 'Return', NumpadEnter: 'Return', Tab: 'Tab', Backspace: 'Backspace',
  Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  // 백틱은 `으로 쓴다 — 맨 백틱이 작은따옴표 안에 있으면 renderer-refs 가드의
  // 리터럴 제거기가 템플릿 시작으로 읽어 그 뒤 함수 정의를 통째로 지운다
  Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\',
};
// 따옴표와 백틱은 문자 코드로 넣는다. 소스에 맨 문자로 쓰면 renderer-refs 가드의 리터럴
// 제거기가 다른 문자열의 시작으로 읽어 그 뒤 함수 정의를 통째로 지운다 — 실제로 그래서
// captureHotkey가 "정의되지 않은 함수"로 잡혔다. 가드도 순서대로 스캔하게 고쳤지만,
// 편집 도구가 \u 이스케이프를 실제 문자로 풀어 쓰는 일도 있어 코드로 두는 쪽이 안전하다.
CODE_TO_ACCEL.Backquote = String.fromCharCode(96);
CODE_TO_ACCEL.Quote = String.fromCharCode(39);
function accelKeyOf(e) {
  const code = e.code || '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return 'num' + code.slice(6);
  return CODE_TO_ACCEL[code] ?? null;
}
function accelModsOf(e, isMac) {
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push(isMac ? 'Command' : 'Super');
  return mods;
}
// 미리보기용 사람 표기 — main의 platform.hotkeyLabel과 같은 규칙을 화면에서 흉내낸다
function accelLabel(parts, isMac) {
  if (isMac) {
    const m = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘' };
    return parts.map((x) => m[x] ?? x).join('');
  }
  return parts.map((x) => (x === 'Control' ? 'Ctrl' : x === 'Super' ? 'Win' : x)).join('+');
}

function captureHotkey(current = '') {
  return new Promise((resolve) => {
    const isMac = cfg?.platform === 'darwin';
    hotkeyCapture = { resolve, isMac };
    setModal(true);
    $('dlgLabel').textContent = `퀵캡처 단축키 — 원하는 조합을 지금 누르세요 (Esc 취소)`;
    const input = $('dlgIn');
    input.readOnly = true;
    input.value = current ? `지금: ${accelLabel(current.split('+'), isMac)}` : '';
    $('dlg').classList.add('show');
    input.focus();
  });
}
function finishHotkeyCapture(accel) {
  const cap = hotkeyCapture;
  hotkeyCapture = null;
  const input = $('dlgIn');
  input.readOnly = false;
  input.value = '';
  setModal(false);
  $('dlg').classList.remove('show');
  cap?.resolve(accel);
}
function onHotkeyCaptureKey(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') return finishHotkeyCapture(null);
  const mods = accelModsOf(e, hotkeyCapture.isMac);
  const key = accelKeyOf(e);
  const input = $('dlgIn');
  if (!key) {
    // 수식키만 눌린 상태 — 여기까지 잡혔다고 보여 준다. 아무 것도 안 눌렸으면 안내로 돌아간다.
    input.value = mods.length ? accelLabel(mods, hotkeyCapture.isMac) + ' + …' : '';
    return;
  }
  if (!mods.length) {
    input.value = `${accelLabel([key], hotkeyCapture.isMac)} — 수식키(Ctrl·Alt·Shift)를 함께 눌러 주세요`;
    return;
  }
  finishHotkeyCapture([...mods, key].join('+'));
}

function closeDlg(commit) {
  const resolve = dlgResolve;
  dlgResolve = null;
  setModal(false);
  $('dlg').classList.remove('show');
  resolve?.(commit ? $('dlgIn').value.trim() : null);
}

// 입력할 때마다 걸러 보여준다 — 확정을 기다리면 오타를 알아채기 어렵다
$('searchIn').addEventListener('input', (e) => {
  filter = e.target.value.trim();
  sel = 0;
  resetScroll = true;
  render();
});

document.addEventListener('keydown', async (e) => {
  // 다이얼로그 입력 중에는 그 입력만 받는다
  if (hotkeyCapture) return onHotkeyCaptureKey(e);

  if (dlgResolve) {
    if (e.key === 'Enter') closeDlg(true);
    if (e.key === 'Escape') closeDlg(false);
    e.stopPropagation();
    return;
  }

  // 검색 입력 중에는 글자가 입력창으로 가야 한다 — 단축키를 가로채지 않는다
  if (searchOn) {
    if (e.key === 'Escape') closeSearch(false);
    else if (e.key === 'Enter') closeSearch(true); // 필터는 남기고 목록으로 돌아간다
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      closeSearch(true);
    } else if (e.key === 'Tab') {
      // 필터를 걸어둔 채 탭을 옮기는 게 검색의 목적이다(11절) — 여기서 처리하지 않으면
      // 기본 동작(포커스 이동)으로 입력창에서 커서만 빠지고 searchOn이 남아 모든 키가 삼켜진다.
      e.preventDefault();
      closeSearch(true);
      switchTab(nextTabKey(e.shiftKey));
    }
    e.stopPropagation();
    return;
  }

  // 전체 키맵 — 어느 화면에서든 ?로 열고, 열려 있는 동안은 읽는 데만 쓴다
  if (keysOpen) {
    if (e.key === 'Escape' || e.key === '?') {
      e.preventDefault();
      closeKeys();
    }
    e.stopPropagation();
    return;
  }
  if (e.key === '?') {
    e.preventDefault();
    return openKeys();
  }

  // 완료 기록 — 읽는 화면이지만 기간과 검색은 움직인다
  if (view === 'history') {
    if (handleDocScroll(e, { arrows: true })) return;
    switch (e.key) {
      case 'Escape':
        if (filter) return closeSearch(false); // 필터부터 푼다 — 한 번 더 누르면 뒤로
        return closeHistory();
      case 'Backspace':
      case 'h':
      case 'H':
        return closeHistory();
      case '/':
        e.preventDefault();
        return openSearch();
      case 'ArrowRight':
      case 'l':
      case 'L':
      case 'ArrowLeft': {
        e.preventDefault();
        const i = HISTORY_RANGES.indexOf(history.days);
        const step = e.key === 'ArrowLeft' ? -1 : 1;
        const next = HISTORY_RANGES[(i + step + HISTORY_RANGES.length) % HISTORY_RANGES.length];
        return openHistory(next);
      }
    }
    return;
  }

  // 공통: 닫기·탭 전환·이동
  switch (e.key) {
    case 'Escape':
      if (filter) return closeSearch(false); // 필터부터 푼다 — 창은 한 번 더 누르면 닫힌다
      return window.whenwork.hide();
    case '/':
      e.preventDefault();
      return openSearch();
    case 'Tab':
      e.preventDefault();
      return switchTab(nextTabKey(e.shiftKey));
  }

  switch (e.key) {
    case 'ArrowDown':
    case 'j':
    case 'J':
      if (tab === 'projects' && e.shiftKey) return moveProject('down');
      sel = Math.min(sel + 1, currentList().length - 1);
      return render();
    case 'ArrowUp':
    case 'k':
    case 'K':
      if (tab === 'projects' && e.shiftKey) return moveProject('up');
      sel = Math.max(sel - 1, 0);
      return render();
    // 목록에서는 Page·Home·End가 스크롤이 아니라 선택 점프다 — 스크롤은 선택을 따라온다
    case 'Home':
      e.preventDefault();
      sel = 0;
      return render();
    case 'End':
      e.preventDefault();
      sel = Math.max(0, currentList().length - 1);
      return render();
    case 'PageDown':
      e.preventDefault();
      sel = Math.max(0, Math.min(sel + 10, currentList().length - 1));
      return render();
    case 'PageUp':
      e.preventDefault();
      sel = Math.max(sel - 10, 0);
      return render();
  }

  // 설정 탭
  if (tab === 'settings') {
    const f = SETTING_FIELDS[sel] ?? null;
    if (['x', 'o', 'b', 'c'].includes(e.key.toLowerCase())) e.preventDefault();
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        return editSetting(f);
      case 'x':
      case 'X':
        return clearSetting(f);
      case 'o':
      case 'O':
        return window.whenwork.settingsOpenFile();
      case 'e':
      case 'E':
        e.preventDefault();
        return runExport();
      case 'i':
      case 'I':
        e.preventDefault();
        return runImport();
      case 'r':
      case 'R':
        e.preventDefault();
        return runUpdate();
    }
    return;
  }

  // 프로젝트 탭 — 프로젝트 자체를 관리한다 (시드·하드코딩 없음)
  if (tab === 'projects') {
    const p = currentList()[sel] ?? null;
    // 다이얼로그를 여는 키는 기본 동작을 먼저 끊는다 (안 그러면 그 글자가 입력창에 찍힌다)
    if (['n', 'e', 'a', 'r', 'x'].includes(e.key.toLowerCase())) e.preventDefault();
    switch (e.key) {
      case 'n':
      case 'N': {
        const name = await promptText('새 프로젝트 이름');
        if (name) {
          await window.whenwork.projectCreate(name);
          await refresh();
        }
        return;
      }
      case 'e':
      case 'E': {
        if (!p) return;
        const name = await promptText('프로젝트 이름', p.name);
        if (name) {
          await window.whenwork.projectUpdate(p.id, { name });
          await refresh();
        }
        return;
      }
      case 'u':
      case 'U':
        return restoreProjectPick();
      case 'x':
      case 'X': {
        if (!p) return;
        // 항목이 있으면 무슨 일이 일어나는지 미리 말한다 — 삭제는 항목의 X와 같은 소프트 삭제라
        // 완료 기록은 그대로 남고, 아직 안 끝난 것만 인박스로 간다.
        const live = [...(state.today ?? []), ...(state.inbox ?? []), ...(state.waiting ?? [])].filter(
          (it) => it.project_id === p.id && !it.done_at
        ).length;
        const warn = live ? ` 남은 할 일 ${live}건은 인박스로 갑니다.` : '';
        const yes = await promptText(`"${p.name}" 삭제?${warn} 완료 기록은 남습니다 (U로 되돌림). 지우려면 y`, '');
        if (yes?.toLowerCase() === 'y') {
          const res = await window.whenwork.projectDelete(p.id);
          if (!res.ok) return toast('삭제 실패');
          undoStack.push({ kind: 'projectDelete', id: p.id, title: p.name, itemIds: res.movedItemIds ?? [] });
          toast(`삭제 — "${clip(p.name)}"${live ? ` · 할 일 ${live}건 인박스로` : ''} · U로 되돌리기`);
          await refresh();
        }
        return;
      }
      // Enter는 재개 카드를 여는 자리였다. 그 화면은 Phase 2에서 걷어냈는데 호출이
      // 남아 있어, 프로젝트를 고르고 Enter를 누르면 openResume이 없어 터졌다.
    }
    return;
  }

  // 항목 탭 (오늘·인박스·대기)
  const it = selectedItem();
  // 다이얼로그를 여는 키는 기본 동작을 먼저 끊는다 (그 글자가 입력창에 찍히지 않게)
  if (['e', 'w', 'd', 'n', 'm'].includes(e.key.toLowerCase())) e.preventDefault();
  switch (e.key) {
    case 'd':
    case 'D': {
      if (!it) return;
      const text = await promptText('마감일 — 오늘 / 내일 / +3 / 8-12 / 2026-08-12 (비우면 해제)', it.due ? String(it.due).slice(0, 10) : '');
      if (text === null) return;
      const res = await window.whenwork.setDue(it.id, text);
      if (!res.ok) toast('날짜 형식이 아님 — 오늘 / 내일 / +3 / 8-12');
      return refresh();
    }
    case 'n':
    case 'N': {
      if (!it) return;
      const note = await promptText('메모 (대기 재촉 기록 등, 비우면 삭제)', it.note ?? '');
      if (note === null) return;
      await window.whenwork.setNote(it.id, note);
      return refresh();
    }
    case 'e':
    case 'E': {
      if (!it) return;
      const title = await promptText('제목 수정', it.title);
      if (title) {
        await window.whenwork.rename(it.id, title);
        await refresh();
      }
      return;
    }
    case ' ':
      e.preventDefault();
      return toggleDone(it);
    case 'w':
    case 'W': {
      if (!it || tab === 'waiting') return;
      const who = await promptText('누구를 기다리나요? (비워도 됨)');
      if (who !== null) {
        await window.whenwork.toWaiting(it.id, who || null);
        await refresh();
      }
      return;
    }
    case 'p':
    case 'P': {
      // 재촉 — 대기 탭에서만. 경과 시계가 지금부터 다시 돌아 브리핑도 그 기준으로 알린다.
      // 30분 안에 다시 누른 것은 횟수를 올리지 않고(db), 어느 쪽이든 U로 되돌릴 수 있다.
      if (tab !== 'waiting' || !it) return;
      e.preventDefault();
      const res = await window.whenwork.nudge(it.id);
      if (!res.ok) return toast('재촉 기록 실패');
      undoStack.push({ kind: 'nudge', id: it.id, title: it.title, at: res.prev.at, count: res.prev.count });
      toast(
        res.repeated
          ? `방금 재촉함 · ${res.count}회째`
          : `재촉 ${res.count}회째 — "${clip(it.title)}" · U로 되돌리기`
      );
      return refresh();
    }
    case 'h':
    case 'H':
      e.preventDefault();
      return openHistory();
    case 'f':
    case 'F': {
      if (tab !== 'today') return;
      e.preventDefault();
      dueOnly = !dueOnly;
      sel = 0;
      resetScroll = true;
      toast(dueOnly ? '마감 있는 것만' : '전체');
      return render();
    }
    case 'x':
    case 'X':
      if (!it) return;
      await window.whenwork.remove(it.id);
      // 지운 것은 되돌릴 수 있다 — 연달아 지웠으면 U를 누른 만큼 거꾸로 살아난다
      undoStack.push({ kind: 'delete', id: it.id, title: it.title });
      toast(`삭제 — "${clip(it.title)}" · U로 되돌리기`);
      return refresh();
    case 'u':
    case 'U': {
      const last = undoStack.pop();
      if (!last) return toast('되돌릴 것 없음');
      if (last.kind === 'nudge') await window.whenwork.nudgeUndo(last.id, last.at, last.count);
      else if (last.kind === 'projectDelete') await window.whenwork.projectRestore(last.id, last.itemIds);
      else await window.whenwork.restore(last.id);
      toast(`되돌림 — "${clip(last.title)}"`);
      return refresh();
    }
    default: {
      // 1~9: 프로젝트 지정 (인박스 항목을 todo로 보낸다 — 다른 탭에서는 재지정)
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && it) {
        const p = state.projects[n - 1];
        if (!p) return;
        // 대기 탭에서는 프로젝트만 바꾼다 — kind까지 todo로 돌리면 대기에서 사라진다.
        // 결과는 행의 프로젝트 칩으로 바로 보이므로 따로 알리지 않는다.
        await window.whenwork.assign(it.id, p.id, tab === 'waiting');
        await refresh();
      }
    }
  }
});

// "32분 뒤" 같은 말은 가만히 두면 틀어진다 — 오늘 탭을 보고 있는 동안만 1분마다 다시 그린다
setInterval(() => {
}, 60_000);

// 백그라운드로 만들던 카드가 완성됐다 — 그 카드를 열어둔 채 스켈레톤을 보고 있었으면 채워준다.
// 열람 수(KPI)는 늘리지 않는다(log=false).
window.whenwork.onRefresh(refresh);
// 트레이에서 리뷰를 만들면 그 탭을 바로 열어준다
refresh();
