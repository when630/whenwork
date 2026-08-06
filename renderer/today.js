// 오늘 뷰 — 탭 3개(오늘/인박스/대기), 마우스 없이 전 조작 가능 (설계 11절).
// Tab 탭 전환 · ↑↓/jk 이동 · Space 완료 · 1~9 프로젝트 지정 · W 대기 · X 삭제 · Esc 닫기
const PROJ_COLORS = ['#f7768e', '#9ece6a', '#7aa2f7', '#e0af68', '#bb9af7', '#7dcfff', '#ff9e64'];
const TABS = [
  { key: 'today', label: '오늘' },
  { key: 'inbox', label: '인박스' },
  { key: 'waiting', label: '대기' },
  // 열린 이슈는 재개 카드 안에만 있어 오늘 뷰에서 놓쳤다(열린 이슈 16건 vs todo 4건) —
  // 탭 배지에 건수가 늘 보이고, 여기서 T로 오늘 할 일로 세운다
  { key: 'issues', label: '이슈' },
  { key: 'projects', label: '프로젝트' },
  { key: 'review', label: '리뷰' },
  { key: 'settings', label: '설정' },
];

// 앱에서 만지는 설정. DB 접속은 여기 없다 — settings.json을 고치고 재시작하는 쪽이 안전하다.
const SETTING_FIELDS = [
  {
    key: 'vaultRoot',
    label: '볼트 경로',
    kind: 'folder',
    hint: '주간 리뷰를 내보낼 Obsidian 볼트 루트. 비우면 DB에만 남는다',
  },
  { key: 'backupDir', label: '백업 폴더', kind: 'folder', hint: '비우면 앱 데이터 폴더 안의 backups' },
  {
    key: 'notifyEnabled',
    label: '아침 브리핑 알림',
    kind: 'bool',
    hint: '오늘 마감·지연·오래 기다린 항목을 하루 한 번 알린다',
  },
  { key: 'notifyAt', label: '알림 시각', kind: 'time', hint: 'HH:MM' },
  {
    key: 'calendarUrl',
    label: '캘린더 웹앱 URL',
    kind: 'secret',
    hint: 'Apps Script 웹앱 주소(토큰 포함). 비우면 캘린더를 쓰지 않는다',
  },
];

let state = null; // 마지막으로 받은 서버 상태
// 첫 화면은 오늘 — 인박스를 기본으로 두었더니 다 분류해 둔 날은 빈 화면으로 열렸다.
// 인박스에 쌓인 게 있으면 첫 로드에서 그쪽으로 옮기고(refresh), 퀵캡처에서 Tab으로
// 건너온 길은 방금 던진 것을 정리하러 온 것이므로 그때도 인박스를 본다.
let tab = 'today';
let firstLoad = true;
let sel = 0; // 현재 탭에서 선택된 행
let dlgResolve = null; // 텍스트 입력 다이얼로그가 기다리는 resolve
let review = { offset: 0, data: null, loaded: false, generating: false, error: null }; // 리뷰 탭 상태
let cfg = null; // 설정 탭이 받아둔 값 (DB와 무관하게 따로 읽는다)
let filter = ''; // 검색어 — 탭을 옮겨도 유지된다 (어느 탭에 있는지 모를 때 찾으려고)
let searchOn = false; // 검색 입력에 포커스가 가 있는 동안
let dueOnly = false; // 오늘 탭: 마감 있는 것만 보기 (F)
let history = null; // 완료 기록 화면 상태 (H)
let view = 'list'; // 'list' | 'resume'
let resume = null; // { projectId, data, loading, generating, error, sel }
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
  issueBadge,
  focusEvent,
  captureContext,
  matches,
  todayGroups,
  hhmm,
  eventState,
  eventTime,
  eventRelative,
  timeline,
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
// "GoWrite가 1번"을 눈으로 익게 한다 — 번호만 따로 적어두면 아무도 외우지 않는다.
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

// 화면에 그려지는 순서 그대로를 돌려준다.
// 오늘 탭은 묶어서 그리므로 그 정렬을 여기서 해야 한다 —
// 안 그러면 선택 강조(그리는 순서)와 실제 대상(원본 순서)이 어긋나 엉뚱한 항목이 지워진다.
function currentList() {
  // 설정은 DB와 무관하게 항상 보여준다 — DB가 꺼져 있을 때 오히려 봐야 하는 화면이다
  if (tab === 'settings') return SETTING_FIELDS;
  if (tab === 'review') return [];
  if (!state?.online) return [];
  if (tab === 'projects') return filtered(state.projects ?? []);
  if (tab === 'issues') return filtered(state.issues ?? []);
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
  head.append(back, el('span', 'pname', `완료 기록 — 최근 ${history.days}일`));
  body.append(head);

  if (history.loading) {
    body.append(el('div', 'empty', '불러오는 중…'));
    return;
  }
  const days = historyDays(history.data);
  if (!days.length) {
    body.append(el('div', 'empty', '이 기간에 완료한 항목도 커밋도 없음'));
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
  const list = currentList();
  $('searchCnt').textContent = filter ? `${list.length}건` : '';
}

// ── 전체 키맵 (?)
//
// 하단 힌트는 그 화면에서 지금 쓸 것 네 칸으로 줄이고, 나머지는 여기서 본다.
// 열 칸이 넘어가면 아무것도 읽히지 않는다 — 관심별로 모아두면 오히려 배우기 쉽다.
const KEYMAP = [
  ['이동', [['↑↓', 'jk 이동'], ['Home/End', '처음·끝'], ['PgUp/PgDn', '10줄'], ['Tab', '탭 전환'], ['/', '검색'], ['Esc', '닫기']]],
  ['항목', [['Space', '완료'], ['E', '제목'], ['D', '마감'], ['N', '메모'], ['W', '대기로'], ['X', '삭제'], ['U', '되돌리기'], ['1~9', '프로젝트'], ['O', '이슈 원본'], ['Enter', '재개 카드']]],
  ['오늘', [['F', '마감만'], ['H', '완료 기록'], ['M', '회의 후속']]],
  ['인박스', [['A', 'AI 분류'], ['Enter', '제안 확정']]],
  ['대기', [['Space', '회신 옴'], ['P', '재촉함']]],
  ['이슈', [['T', '할 일로'], ['Enter/O', '원본'], ['/', '검색']]],
  ['프로젝트', [['N', '추가'], ['E', '이름'], ['A', '약어'], ['R', '리포'], ['Shift+↑↓', '순서'], ['X', '보관']]],
  ['재개 카드', [['R', '다시 생성'], ['Enter/O', '브라우저'], ['T', '할 일로'], ['PgUp/PgDn', '스크롤']]],
  ['리뷰', [['G', '초안 생성'], ['←→', '주 이동'], ['O', '볼트에서 열기']]],
  ['설정', [['Enter', '변경'], ['X', '기본값'], ['B', '백업'], ['C', '캘린더'], ['O', 'settings.json']]],
  ['퀵캡처', [['Ctrl+Alt+Space', '열기·닫기'], ['#약어', '프로젝트 지정'], ['Tab', '오늘 뷰']]],
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
      s.append(el('kbd', null, key), document.createTextNode(' ' + label));
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
// 약어(#gw)를 함께 적는 이유는 캡처 토큰과 같은 어휘를 한자리에서 익히게 하려는 것이다.
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
    if (p.abbr) s.append(el('span', 'ab', `#${p.abbr}`));
    band.append(s);
  });
}

function openSearch() {
  if (tab === 'review' || tab === 'settings' || view !== 'list') return; // 목록이 있는 화면에서만
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
  if (view === 'resume') {
    $('tabs').replaceChildren();
    renderResume();
  } else if (view === 'history') {
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

// 이슈 한 줄 — 재개 카드 3단과 이슈 탭이 같은 모양을 쓴다.
// promoted는 이미 오늘 할 일로 세웠다는 표시다 (다시 T를 눌러도 두 줄이 되지 않는다).
function issueRow(i, selected, promoted) {
  const row = el('div', 'issue' + (selected ? ' selected' : ''));
  row.append(el('span', 'st ' + i.state), el('span', 'prov', i.provider === 'github' ? 'GH' : 'GL'));
  if (i.kind === 'pr') row.append(el('span', 'kind', i.provider === 'gitlab' ? 'MR' : 'PR'));
  // 원본으로 가는 문은 번호다 — 항목 행의 이슈 배지와 같은 규칙이고, 행 클릭은 선택으로 남긴다.
  // (더블클릭에 걸었더니 클릭마다 행이 다시 그려져 노드가 갈리는 통에 믿을 수 없었다.)
  const num = el('span', 'num', `#${i.number}`);
  num.title = '원본 열기';
  num.onclick = (ev) => {
    ev.stopPropagation();
    window.whenwork.openUrl(i.url);
  };
  row.append(num, el('span', 'tt', i.title));
  if (promoted) row.append(el('span', 'asg todo', '할 일'));
  if (i.draft) row.append(el('span', 'asg draft', '초안'));
  if (i.relation === 'reviewer') row.append(el('span', 'asg rev', '리뷰'));
  else if (i.relation !== 'author') row.append(el('span', 'asg', '할당'));
  row.append(el('span', 'when', fmtWhen(i.updated_at)));
  return row;
}

// ── 재개 카드 (M2, 목업 03) — AI 카드 + git 활동 + 내 이슈 3단
function fmtWhen(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? `오늘 ${hm}` : `${d.getMonth() + 1}/${d.getDate()}`;
}

function renderResume() {
  const body = $('body');
  body.replaceChildren();
  const p = state?.projects?.find((x) => x.id === resume.projectId);
  if (!p) return;

  const head = el('div', 'rhead');
  const back = el('span', 'back', '‹');
  back.onclick = closeResume;
  const pname = el('span', 'pname');
  const dot = el('span', 'dot');
  dot.style.background = projColor(p.id);
  pname.append(dot, document.createTextNode(p.name));
  head.append(back, pname);
  const card = resume.data?.card;
  if (card) {
    const gen = el('span', 'gen-at', `✦ ${fmtWhen(card.generated_at)} 생성`);
    // 카드를 만든 뒤로 쌓인 커밋 — 시각만 보고는 카드가 낡았는지 알 수 없다(R를 누를 근거)
    const fresh = resume.data?.fresh ?? 0;
    if (fresh) gen.append(el('span', 'stale-n', `이후 커밋 ${fresh}`));
    head.append(gen);
  }
  body.append(head);

  const rbody = el('div', 'rbody');
  body.append(rbody);

  // 1단: AI 카드 — 생성 중이면 스켈레톤, 실패해도 아래 원본(git·이슈)은 그대로
  const cardBox = el('div', 'card');
  if (resume.generating) {
    const st = el('div', 'gen-status');
    st.append(el('span', 'spin'), document.createTextNode('재개 카드 생성 중… (claude -p)'));
    const sk = el('div', 'skeleton');
    for (const w of ['85%', '70%', '78%']) {
      const s = el('div', 'sk');
      s.style.width = w;
      sk.append(s);
    }
    cardBox.append(st, sk);
  } else if (resume.error) {
    const err = el('div', 'err');
    err.append(el('div', 't', '카드 생성 실패'), el('div', null, resume.error));
    cardBox.append(err);
  } else if (card) {
    const sec = (label, text, ai) => {
      const s = el('div', 'sec');
      const h = el('div', 'h');
      if (ai) h.append(el('span', 'badge-ai', '✦ AI'));
      h.append(document.createTextNode(label));
      s.append(h, el('div', 'v', text || '—'));
      return s;
    };
    cardBox.append(sec('마지막 작업', card.last_work, true), sec('멈춘 지점', card.stuck_point));
    const nsec = el('div', 'sec');
    nsec.append(el('div', 'h', '다음 액션'));
    const next = el('div', 'next');
    next.append(el('span', 'arrow', '→'), el('div', 'v', card.next_action || '—'));
    nsec.append(next);
    cardBox.append(nsec);
  } else {
    cardBox.append(el('div', 'v', resume.loading ? '불러오는 중…' : '카드 없음 — R로 생성'));
  }
  rbody.append(cardBox);

  const data = resume.data;
  // 아래 두 단은 gh/glab을 새로 긁는 동안 이유 없이 늦게 바뀌어 보였다 — 도는 중임을 밝힌다
  const secHead = (text) => {
    const h = el('div', 'sec-h');
    h.append(document.createTextNode(text));
    if (resume.syncing) {
      const live = el('span', 'sync-live');
      live.append(el('span', 'spin'), document.createTextNode('수집 중'));
      h.append(live);
    }
    return h;
  };

  // 2단: git 활동 — 로컬 데이터라 항상 먼저 그린다
  const gitSec = el('div');
  gitSec.append(secHead('최근 활동 (git · 자동 수집)'));
  const acts = data?.activities ?? [];
  if (acts.length === 0) gitSec.append(el('div', 'sync-note', '수집된 커밋 없음 — repo_paths 미설정이거나 최근 14일 커밋 없음'));
  for (const a of acts) {
    const c = el('div', 'commit');
    c.append(el('span', 'sha', a.ref?.slice(0, 7) ?? ''), el('span', null, a.summary), el('span', 'when', fmtWhen(a.occurred_at)));
    gitSec.append(c);
  }
  rbody.append(gitSec);

  // 3단: 내 이슈 (작성·할당)
  const issSec = el('div');
  issSec.append(secHead('내 이슈·PR — 작성·할당·리뷰 요청 (Enter/O 브라우저 · T 할 일로)'));
  const issues = data?.issues ?? [];
  const promoted = new Set(data?.promoted ?? []);
  if (issues.length === 0) issSec.append(el('div', 'sync-note', '이슈·PR 없음 또는 동기화 전'));
  issues.forEach((i, idx) => {
    const row = issueRow(i, idx === resume.sel, promoted.has(i.url));
    // 행 클릭은 선택 — 마우스로 고른 뒤 T로 할 일로 세울 수 있다 (원본은 번호를 누른다)
    row.onclick = () => {
      resume.sel = idx;
      render();
    };
    issSec.append(row);
  });
  if (issues[0]?.synced_at) issSec.append(el('div', 'sync-note', `동기화 ${fmtWhen(issues[0].synced_at)}`));
  rbody.append(issSec);
}

async function openResume(projectId) {
  view = 'resume';
  resume = { projectId, data: null, loading: true, generating: false, error: null, sel: 0, syncing: true };
  resetScroll = true;
  render();
  const first = await window.whenwork.resumeGet(projectId);
  if (view !== 'resume' || resume.projectId !== projectId) return;
  resume.data = first.ok ? first : null;
  resume.loading = false;
  resume.generating = !!first.generating;
  render();
  // 백그라운드로 git·이슈를 새로 긁는다 — 끝나면 갱신 (방금 긁었으면 main이 건너뛴다)
  const synced = await window.whenwork.resumeSync(projectId);
  if (view !== 'resume' || resume.projectId !== projectId) return;
  resume.syncing = false;
  if (synced.ok) resume.data = synced;
  render();
  // 카드가 없거나, 24시간 넘게 묵었고 **그 뒤로 새 커밋이 있으면** 자동 재생성.
  // 커밋이 없으면 같은 자료로 같은 카드를 다시 만드는 것뿐이라 기다릴 값이 없다
  // (main의 백그라운드 선갱신도 같은 기준을 쓴다 — 보통은 여기 오기 전에 이미 갱신돼 있다).
  // 방금 실패했다면(서버 혼잡 등) 쿨다운 동안은 자동으로 다시 매달리지 않는다 — R로 직접 재시도.
  const card = resume.data?.card;
  const aged = card && Date.now() - new Date(card.generated_at).getTime() > 24 * 3600 * 1000;
  const stale = !card || (aged && (resume.data?.fresh ?? 0) > 0);
  const cooling = resume.data?.retryAfter && resume.data.retryAfter > Date.now();
  if (stale && !resume.generating && !cooling) await regenerate(projectId);
  else if (stale && cooling && !card) {
    resume.error = '직전 생성 실패로 잠시 쉬는 중 — R로 다시 시도';
    render();
  }
}

async function regenerate(projectId) {
  resume.generating = true;
  resume.error = null;
  render();
  const res = await window.whenwork.resumeGenerate(projectId);
  if (view !== 'resume' || resume.projectId !== projectId) return;
  resume.generating = false;
  if (res.ok) resume.data = res;
  else if (!res.busy) resume.error = res.error ?? 'claude -p 응답 없음 (구독 한도 또는 네트워크)';
  render();
}

function closeResume() {
  view = 'list';
  resume = null;
  resetScroll = true;
  refresh();
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.replaceChildren();
  for (const t of TABS) {
    // 검색 중에는 탭 숫자도 매칭 건수 — 어느 탭에 있는지 배지만 보고 알 수 있다
    const n = t.key === 'review' || t.key === 'settings' ? null
      : !state?.online ? 0
      : t.key === 'projects' ? filtered(state.projects ?? []).length
      : t.key === 'issues' ? filtered(state.issues ?? []).length // 이슈는 열린 것만 오므로 그대로 센다
      : filtered(state[t.key] ?? []).filter((i) => !i.done_at).length;
    const node = el('div', 'tab' + (tab === t.key ? ' on' : ''));
    node.append(el('span', null, t.label));
    if (n !== null) node.append(el('span', 'n', String(n)));
    node.onclick = () => switchTab(t.key);
    tabs.append(node);
  }
}

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
  const isu = issueBadge(it);
  if (badge || isu) {
    const meta = el('div', 'meta');
    if (badge) meta.append(el('span', 'due ' + badge.cls, badge.text));
    // 이슈에서 세운 할 일 — 원본이 닫히면 여기서 알려주고, 완료는 Space로 사람이 찍는다
    if (isu) {
      const tag = el('span', 'isu ' + isu.cls, isu.text);
      tag.onclick = (ev) => {
        ev.stopPropagation();
        window.whenwork.openUrl(it.issue_url);
      };
      meta.append(tag);
    }
    row.append(meta);
  }
  if (tab === 'inbox') {
    if (it.suggested_project_id) {
      // AI 제안은 사람 입력과 늘 구분해서 보여준다 (✦ 보라)
      const s = el('div', 'suggest');
      s.append(
        el('span', 'badge-ai', '✦ AI'),
        projChip(it.suggested_project_id, it.suggested_project_name),
        el('span', 'act', 'Enter 확정')
      );
      row.append(s);
    }
    const ctxText = captureContext(it);
    if (ctxText) {
      const ctx = el('div', 'ctx');
      ctx.append(window.ICONS.context(), document.createTextNode(` ${ctxText}`));
      row.append(ctx);
    }
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

// ── 주간 리뷰 탭 — DB에 저장된 초안을 보여주고, 없으면 생성하게 한다
//
// 불러오는 동안 본문을 비우지 않는다. 비우면 「초안 없음」 빈 화면이 한 프레임 끼어들어
// 주를 옮길 때마다 화면이 들썩였다(경계에서는 깜빡임으로 보였다). 옛 본문을 흐리게 두고
// 머리(주차)만 먼저 바꾼다 — 자리가 안 움직이므로 눈에 걸리지 않는다.
function weekLabel(offset) {
  if (offset === 0) return '이번 주';
  if (offset === -1) return '지난 주';
  return `${-offset}주 전`;
}

function renderReview() {
  const body = $('body');
  body.replaceChildren();
  const d = review.data;
  const loading = !!review.loading;

  const head = el('div', 'rv-head');
  const nav = el('div', 'rv-nav');
  const prev = el('span', null, '‹');
  prev.title = '지난 주';
  prev.onclick = () => moveWeek(-1);
  // 이번 주면 오른쪽은 갈 데가 없다 — 흐리게 해서 눌러도 아무 일이 없는 이유를 드러낸다
  const next = el('span', review.offset === 0 ? 'dim' : null, '›');
  next.title = review.offset === 0 ? '이번 주가 마지막' : '다음 주';
  next.onclick = () => moveWeek(1);
  nav.append(prev, next);
  const title = el('div');
  // 불러오는 중에는 옛 주차가 남아 있으면 안 된다 — offset만으로 만든 이름을 쓴다
  const settled = d && !loading;
  const wk = el('div', 'wk', settled ? `${d.year}년 ${d.week}주차` : weekLabel(review.offset));
  // 이번 주는 배지로 — 제목 뒤에 괄호로 달면 주차 숫자와 뒤섞여 읽힌다
  if (settled && review.offset === 0) wk.append(el('span', 'now', '이번 주'));
  // 기간 줄은 비어 있어도 자리를 지킨다(min-height) — 접혔다 펴지면 아래가 들썩인다
  title.append(wk, el('div', 'range', (settled && d.label) || ''));
  head.append(nav, title);
  if (loading) {
    const live = el('span', 'gen-at');
    live.append(el('span', 'spin'), document.createTextNode(' 불러오는 중'));
    head.append(live);
  } else if (d?.review?.generated_at) {
    head.append(el('span', 'gen-at', `✦ ${fmtWhen(d.review.generated_at)} 생성`));
  }
  body.append(head);

  const box = el('div', 'rv-body');
  if (review.generating) {
    const st = el('div', 'gen-status');
    st.append(el('span', 'spin'), document.createTextNode('주간 리뷰 초안 생성 중… (claude -p, 30초~1분)'));
    const sk = el('div', 'skeleton');
    for (const w of ['92%', '86%', '70%', '80%']) {
      const s = el('div', 'sk');
      s.style.width = w;
      sk.append(s);
    }
    box.append(st, sk);
  } else if (review.error) {
    const err = el('div', 'err');
    err.append(el('div', 't', '생성 실패'), el('div', null, review.error));
    box.append(err);
  } else if (d?.review) {
    if (loading) box.classList.add('stale'); // 옛 본문 — 자리는 그대로 두고 흐리게만
    box.append(window.MD.render(d.review.body));
  } else if (!review.loaded || loading) {
    // 아직 모르는 것을 「초안 없음」이라고 하면 안 된다. 늦어지지 않으면 글자도 없이
    // 자리만 지킨다 — 몇 ms 스치는 「불러오는 중」이 곧 깜빡임이다.
    const e = el('div', 'empty', loading ? '불러오는 중…' : '');
    e.style.height = '260px';
    box.append(e);
  } else {
    const e = el('div', 'empty');
    const hint = el('div');
    hint.append(el('kbd', null, 'G'), document.createTextNode(' 로 이 주의 초안 만들기'));
    e.append(el('div', 'big', '◎'), el('div', null, '아직 만든 초안 없음'), hint);
    e.style.height = '260px';
    box.append(e);
  }
  body.append(box);

  if (d?.review?.file) {
    const f = el('div', 'rv-file');
    f.append(window.ICONS.context(), document.createTextNode(` ${d.review.file} — 열기`));
    f.onclick = () => window.whenwork.reviewOpenFile(d.review.file);
    body.append(f);
  }
}

// 로컬 DB는 보통 몇 ms라 「불러오는 중」이 한 프레임 스치고 사라진다 — 표시 자체가 깜빡임이 된다.
// 그래서 늦어질 때만(DB가 꺼져 접속을 기다리는 등) 표시한다.
const LOADING_DELAY_MS = 180;
let loadingTimer = null;

function scheduleLoading() {
  clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => {
    review.loading = true;
    render();
  }, LOADING_DELAY_MS);
}

async function loadReview() {
  const at = review.offset;
  scheduleLoading();
  const res = await window.whenwork.reviewGet(at);
  if (at !== review.offset) return; // 그 사이 다른 주로 옮겼다 — 늦게 온 답은 버린다
  clearTimeout(loadingTimer);
  review.loading = false;
  review.loaded = true; // 이제 "없다"고 말할 수 있다 (그 전까지는 모르는 것이다)
  review.data = res.ok ? res : null;
  review.generating = !!res.generating;
  resetScroll = true; // 새 본문은 맨 위부터
  render();
}

function moveWeek(delta) {
  const next = Math.min(0, review.offset + delta); // 미래 주는 볼 게 없다
  // 경계에서는 아무 일도 하지 않는다 — 자리는 그대로인데 화면을 비우고 다시 불러오면
  // 누를 때마다 한 번씩 비었다 채워져 깜빡인다
  if (next === review.offset) return;
  review.offset = next;
  review.error = null;
  // 본문(review.data)은 그대로 둔다 — 비우면 빈 화면이 한 프레임 끼어들어 화면이 들썩인다.
  // 로딩 표시도 여기서 켜지 않는다 — loadReview가 늦어질 때만 켠다.
  render();
  loadReview();
}

async function generateReview() {
  if (review.generating) return;
  review.generating = true;
  review.error = null;
  render();
  const res = await window.whenwork.reviewGenerate(review.offset);
  review.generating = false;
  if (res.ok) await loadReview();
  else {
    review.error = res.busy ? '이미 생성 중' : (res.error ?? 'claude -p 응답 없음');
    render();
  }
}

// ── 설정 탭
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
    row.append(el('span', 'set-val' + (isDefault ? ' dim' : ''), settingDisplay(f, cfg.values, cfg.defaults)));
    row.append(el('div', 'ctx', f.hint));
    row.onclick = () => {
      sel = idx;
      render();
    };
    body.append(row);
  });

  const dbSec = el('div', 'set-foot');
  dbSec.append(el('div', 'sec-h', 'DB — settings.json의 db로 바꾸고 재시작'));
  dbSec.append(
    el('div', 'ctx', `${cfg.db.host}:${cfg.db.port}/${cfg.db.database} — ${cfg.db.online ? '연결됨' : '대기 중'}`)
  );
  const backup = el('div', 'rv-file');
  backup.append(
    window.ICONS.context(),
    document.createTextNode(
      // 실패가 있으면 그것부터 — 마지막 성공 시각만 보이면 그 뒤로 못 남긴 걸 알 수 없다
      cfg.lastBackupError
        ? ` 백업 실패 — ${cfg.lastBackupError} — 다시 시도 (B)`
        : cfg.lastBackup
          ? ` 마지막 백업 ${fmtWhen(cfg.lastBackup)} — 지금 백업 (B)`
          : ' 백업 이력 없음 — 지금 백업 (B)'
    )
  );
  backup.onclick = runBackup;
  dbSec.append(backup);
  if (cfg.values.calendarUrl) {
    const c = cfg.calendar ?? {};
    const cal = el('div', 'rv-file');
    cal.append(
      window.ICONS.context(),
      document.createTextNode(
        c.error
          ? ` 캘린더 오류 — ${c.error}`
          : c.lastSync
            ? ` 캘린더 동기화 ${fmtWhen(c.lastSync)} — 지금 동기화 (C)`
            : ' 캘린더 아직 동기화 전 — 지금 동기화 (C)'
      )
    );
    cal.onclick = runCalendarSync;
    dbSec.append(cal);
  }
  const open = el('div', 'rv-file');
  open.append(window.ICONS.context(), document.createTextNode(` ${cfg.file} — 열기`));
  open.onclick = () => window.whenwork.settingsOpenFile();
  dbSec.append(open);
  body.append(dbSec);
}

async function runBackup() {
  toast('백업 중…', { spinner: true, holdMs: 0 });
  const res = await window.whenwork.backupNow();
  if (res.ok) toast(`백업 저장 — ${res.file}`);
  else toast(res.busy ? '이미 백업 중' : `백업 실패 — ${res.error ?? '원인 불명'}`);
  return loadSettings();
}

async function runCalendarSync() {
  toast('캘린더 동기화 중…', { spinner: true, holdMs: 0 });
  const res = await window.whenwork.calendarSync();
  if (res.ok) toast(`캘린더 — 일정 ${res.count}건`);
  else if (res.skipped) toast('캘린더 URL 미설정');
  else toast(`캘린더 실패 — ${res.error ?? '원인 불명'}`, { holdMs: 6000 });
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
  if (f.kind === 'folder') {
    const res = await window.whenwork.settingsPickFolder(cfg.values[f.key] ?? '');
    if (!res.ok || !res.path) return;
    await window.whenwork.settingsSet(f.key, res.path);
    toast(`${f.label} — ${res.path}`);
    return loadSettings();
  }
  if (f.kind === 'secret') {
    // 화면에는 가린 값만 있으므로 편집이 아니라 새로 붙여넣는다.
    // **빈 입력은 취소다** — 예전엔 그것이 곧 해제여서, Enter를 무심코 한 번 더 누르면
    // 토큰이 날아가고 앱에서는 되살릴 수 없었다(화면에 가린 값만 있다). 해제는 X로만 한다.
    const url = await promptText(`${f.label} — 전체 주소 붙여넣기 (해제는 X)`, '');
    if (!url) return;
    if (!/^https:\/\/script\.google\.com\//.test(url)) {
      return toast('Apps Script 주소가 아님 — https://script.google.com/… 으로 시작');
    }
    await window.whenwork.settingsSet(f.key, url);
    await loadSettings();
    toast('캘린더 확인 중…', { spinner: true, holdMs: 0 });
    const res = await window.whenwork.calendarSync();
    toast(res.ok ? `캘린더 연결됨 — 일정 ${res.count}건` : `캘린더 실패 — ${res.error ?? '원인 불명'}`, {
      holdMs: 6000,
    });
    await loadSettings();
    return refresh();
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
  // 프로젝트 보관과 같은 y 확인을 받는다. 폴더·시각은 다시 고르면 되니 묻지 않는다.
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
  if (tab === 'review') return renderReview();
  if (tab === 'settings') return renderSettings();
  body.replaceChildren();

  if (!state) return;
  if (!state.online) {
    const e = el('div', 'empty');
    e.append(
      el('div', 'big', '⏳'),
      el('div', null, 'DB 대기 중 — Docker의 whenwork-db가 켜지면 자동 동기화'),
      el('div', null, `로컬 큐 ${state.pending}건 보관 중 · 캡처는 계속 가능`)
    );
    body.append(e);
    return;
  }

  const list = currentList();
  sel = Math.min(sel, Math.max(0, list.length - 1));

  // 오늘 일정은 항목이 아니라 배경이다 — 목록 위에 얇게 깔고, 검색 중에는 비켜준다.
  // 할 일이 하나도 없는 날에도 일정은 보여야 하므로 빈 화면 분기보다 먼저 그린다.
  if (tab === 'today' && !filter) {
    const events = state.events ?? [];
    if (events.length) {
      // 할 일 그룹과 같은 머리글 모양을 쓴다 — 화면에 결이 하나만 남는다
      const head = el('div', 'group-h');
      head.append(el('span', 'chip cal-chip', '오늘 일정'));
      body.append(head);

      const { allDay, rows } = timeline(events);
      // 종일 일정은 놓일 시각이 없어 축 위에 따로 세운다
      for (const ev of allDay) {
        const row = el('div', 'tl-allday');
        row.append(el('span', 'tl-time', '종일'), el('span', 'tl-title', ev.title));
        body.append(row);
      }

      // 후속 할 일을 붙일 그 회의 — 키(M)를 아는 사람만 쓰는 기능이 되지 않게 그 줄에 표식을 둔다
      const focus = focusEvent(events);
      if (rows.length) {
        const tl = el('div', 'tl');
        for (const r of rows) {
          if (r.type === 'now') {
            const row = el('div', 'tl-row tl-now');
            row.append(el('span', 'tl-time', hhmm(Date.now())), el('span', 'tl-dot'));
            row.append(el('span', 'tl-nowline', '지금'));
            tl.append(row);
            continue;
          }
          const ev = r.ev;
          // 상태 클래스에 tl- 접두사를 붙인다 — 이 CSS는 전역이라 next·past 같은 이름은
          // 이미 다른 컴포넌트(재개 카드의 "다음 액션")가 쓰고 있어 그대로 쓰면 규칙이 겹친다
          const row = el('div', 'tl-row tl-' + eventState(ev));
          row.append(el('span', 'tl-time', eventTime(ev).split('–')[0]), el('span', 'tl-dot'));
          const title = el('span', 'tl-title', ev.title);
          if (ev.location) title.append(el('span', 'tl-loc', ` · ${ev.location}`));
          row.append(title);
          const meta = el('span', 'tl-meta');
          const rel = eventRelative(ev);
          meta.textContent = rel ? `${eventTime(ev)} · ${rel}` : eventTime(ev);
          row.append(meta);
          if (ev === focus) {
            const tag = el('span', 'tl-follow', 'M 후속');
            tag.onclick = captureFollowUp;
            row.append(tag);
          }
          tl.append(row);
        }
        body.append(tl);
      }
    }
  }

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
    } else if (tab === 'issues') {
      e.append(
        el('div', 'big', '◎'),
        el('div', null, '열린 이슈 없음'),
        el('div', null, '트레이 「지금 수집」으로 다시 긁기')
      );
    } else {
      const hint = el('div');
      hint.append(document.createTextNode('생각나면 '));
      ['Ctrl', 'Alt', 'Space'].forEach((k, i) => {
        if (i) hint.append(document.createTextNode('+'));
        hint.append(el('kbd', null, k));
      });
      hint.append(document.createTextNode(' 로 던져두기'));
      e.append(el('div', 'big', '◎'), el('div', null, '항목 없음'), hint);
    }
    body.append(e);
    return;
  }

  // 이슈 탭 — 읽기 전용 캐시(D7)를 프로젝트별로 늘어놓는다. 여기서 T로 오늘 할 일이 된다.
  if (tab === 'issues') {
    let pid;
    list.forEach((i, idx) => {
      if (i.project_id !== pid) {
        pid = i.project_id;
        const h = el('div', 'group-h');
        h.append(projChip(pid, i.project_name));
        body.append(h);
      }
      // 목록 안에 서는 행이라 항목 행과 좌우를 맞춘다 (재개 카드 안에서는 음수 마진을 쓴다)
      const row = issueRow(i, idx === sel, i.promoted);
      row.classList.add('in-tab');
      row.onclick = () => {
        sel = idx;
        render();
      };
      body.append(row);
    });
    if (list[0]?.synced_at) body.append(el('div', 'sync-note', `동기화 ${fmtWhen(list[0].synced_at)}`));
    return;
  }

  if (tab === 'projects') {
    list.forEach((p, idx) => {
      const row = el('div', 'item' + (idx === sel ? ' selected' : ''));
      row.append(el('span', 'proj-num', idx < 9 ? String(idx + 1) : ''));
      const chip = el('span', 'chip');
      const dot = el('span', 'dot');
      dot.style.background = projColor(p.id);
      chip.append(dot, document.createTextNode(p.abbr ? `#${p.abbr}` : '—'));
      row.append(el('div', 't', p.name), chip);
      const repos = el('div', 'proj-repos');
      repos.textContent = p.repo_paths?.length ? p.repo_paths.join(' · ') : '연결된 리포 없음 (R로 추가)';
      row.append(repos);
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
    ? state.pending ? `동기화 중 — 큐 ${state.pending}건` : '동기화됨'
    : `DB 대기 — 큐 ${state?.pending ?? 0}건`;

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
    add('↑↓', '스크롤');
    add('Esc', '뒤로');
  } else if (view === 'resume') {
    add('R', '다시 생성');
    add('Enter', '이슈 열기');
    add('T', '할 일로');
    add('Esc', '뒤로');
  } else if (tab === 'review') {
    add('G', review.data?.review ? '다시 생성' : '생성');
    add('←→', '주 이동');
    if (review.data?.review?.file) add('O', '볼트에서 열기');
  } else if (tab === 'settings') {
    add('Enter', '변경');
    add('X', '기본값으로');
    add('B', '지금 백업');
  } else if (tab === 'issues') {
    add('T', '할 일로');
    add('Enter', '원본');
  } else if (tab === 'projects') {
    add('N', '추가');
    add('E', '이름');
    add('R', '리포');
  } else if (tab === 'inbox') {
    add('A', 'AI 분류');
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
    // 후속을 붙일 회의가 실제로 있을 때만 — 붙일 자리가 없는 날까지 힌트를 늘리지 않는다
    if (focusEvent(state?.events ?? [])) add('M', '회의 후속');
  }
  // Esc의 뜻이 바뀌는 순간만 알린다 (평소엔 창 닫기라 관습으로 안다)
  if (filter && view === 'list') add('Esc', '검색 해제');
  add('?', '전체 키');
}

// ── 회의 후속 캡처 (M)
//
// 회의는 할 일을 낳는데, 그것을 적을 유일하게 온전한 시점은 끝난 직후다.
// 퀵캡처와 같은 방식으로 연달아 던지게 하고(빈 입력이면 끝), 회의 제목을 맥락으로 붙여
// 인박스 AI 분류가 그걸 근거로 프로젝트를 고르게 한다.
// 알림으로 부르지는 않는다 — 알림은 아침 브리핑 하나뿐이다(오픈이슈 #3).
async function captureFollowUp() {
  const ev = focusEvent(state?.events ?? []);
  if (!ev) return toast('방금 끝났거나 진행 중인 일정 없음');
  let n = 0;
  for (;;) {
    const title = await promptText(
      `"${clip(ev.title, 28)}" 후속 할 일${n ? ` — ${n}건 담음` : ''} (비우면 끝)`
    );
    if (!title) break;
    const res = await window.whenwork.captureFollowUp(title, { title: ev.title });
    if (!res.ok) break;
    n++;
  }
  if (!n) return;
  toast(`후속 ${n}건 — 인박스에서 A로 분류`);
  return refresh();
}

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
  // 첫 로드에서만 탭을 고른다 — 인박스에 쌓인 게 있으면 그것부터 치우는 게 순서다.
  // 매번 고르면 일하는 중에 탭이 저절로 바뀐다.
  // DB가 아직 안 붙었으면 판단을 미룬다 — 오프라인 첫 로드에서 기회를 잃지 않게
  if (firstLoad && state?.online) {
    firstLoad = false;
    if (state.inbox?.length) tab = 'inbox';
  }
  render();
}

function switchTab(key) {
  tab = key;
  sel = 0;
  resetScroll = true;
  render();
  // 처음 열 때는 아직 모르는 상태다 — 「초안 없음」을 스쳐 보이지 않게 loaded로 가른다
  if (key === 'review' && !review.loaded) loadReview();
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

  // 완료 기록 — 읽기만 하는 화면이라 스크롤과 닫기만 있다
  if (view === 'history') {
    if (handleDocScroll(e, { arrows: true })) return;
    if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'h' || e.key === 'H') {
      return closeHistory();
    }
    return;
  }

  // 재개 카드 화면 — ↑↓는 이슈 선택에 쓰므로 스크롤은 Page·Home·End·Space만
  if (view === 'resume') {
    const issues = resume?.data?.issues ?? [];
    if (handleDocScroll(e)) return;
    switch (e.key) {
      case 'Escape':
      case 'Backspace':
        return closeResume();
      case 'r':
      case 'R':
        if (!resume.generating) regenerate(resume.projectId);
        return;
      case 'ArrowDown':
      case 'j':
        resume.sel = Math.min(resume.sel + 1, Math.max(0, issues.length - 1));
        return render();
      case 'ArrowUp':
      case 'k':
        resume.sel = Math.max(resume.sel - 1, 0);
        return render();
      case 'Enter':
      case 'o':
      case 'O':
        if (issues[resume.sel]) window.whenwork.openUrl(issues[resume.sel].url);
        return;
      case 't':
      case 'T': {
        // 이슈를 오늘 할 일로 세운다 — 열린 이슈가 재개 카드 안에만 있으면 오늘 뷰에서 놓친다
        const i = issues[resume.sel];
        if (!i) return;
        e.preventDefault();
        const res = await window.whenwork.promoteIssue(resume.projectId, { url: i.url, title: i.title });
        if (!res.ok) return toast('할 일로 세우기 실패');
        toast(res.created ? `오늘 할 일로 — "${clip(i.title, 30)}"` : '이미 할 일에 있음');
        if (res.created) {
          const fresh = await window.whenwork.resumeGet(resume.projectId, false);
          if (view === 'resume' && fresh.ok) {
            resume.data = fresh;
            render();
          }
        }
        return;
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

  // 리뷰 탭 — 목록이 아니라 문서라 조작이 다르다 (↑↓·j·k까지 스크롤로 쓴다)
  if (tab === 'review') {
    if (handleDocScroll(e, { arrows: true })) return;
    switch (e.key) {
      case 'g':
      case 'G':
        e.preventDefault();
        return generateReview();
      case 'o':
      case 'O':
        if (review.data?.review?.file) window.whenwork.reviewOpenFile(review.data.review.file);
        return;
      case 'ArrowLeft':
      case 'h':
        return moveWeek(-1);
      case 'ArrowRight':
      case 'l':
        return moveWeek(1);
    }
    return;
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
      case 'b':
      case 'B':
        return runBackup();
      case 'c':
      case 'C':
        return runCalendarSync();
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
      case 'a':
      case 'A': {
        if (!p) return;
        const abbr = await promptText('약어 (#토큰용, 비우면 없음)', p.abbr ?? '');
        if (abbr !== null) {
          await window.whenwork.projectUpdate(p.id, { abbr });
          await refresh();
        }
        return;
      }
      case 'r':
      case 'R': {
        if (!p) return;
        const raw = await promptText('리포 경로 — 여러 개는 ; 로 구분', (p.repo_paths ?? []).join('; '));
        if (raw !== null) {
          const paths = raw.split(';').map((s) => s.trim()).filter(Boolean);
          await window.whenwork.projectRepos(p.id, paths);
          await refresh();
        }
        return;
      }
      case 'x':
      case 'X': {
        if (!p) return;
        const yes = await promptText(`"${p.name}" 보관? 지우려면 y 입력`, '');
        if (yes?.toLowerCase() === 'y') {
          await window.whenwork.projectArchive(p.id);
          await refresh();
        }
        return;
      }
      case 'Enter':
        if (p) openResume(p.id);
        return;
    }
    return;
  }

  // 이슈 탭 — 읽기 전용 캐시(D7)라 여기서 고치는 것은 없다. 할 일로 세우거나 원본으로 간다.
  if (tab === 'issues') {
    const i = currentList()[sel] ?? null;
    switch (e.key) {
      case 'Enter':
      case 'o':
      case 'O':
        if (i) window.whenwork.openUrl(i.url);
        return;
      case 't':
      case 'T': {
        if (!i) return;
        e.preventDefault();
        const res = await window.whenwork.promoteIssue(i.project_id, { url: i.url, title: i.title });
        if (!res.ok) return toast('할 일로 세우기 실패');
        toast(res.created ? `오늘 할 일로 — "${clip(i.title, 30)}"` : '이미 할 일에 있음');
        return refresh();
      }
    }
    return;
  }

  // 항목 탭 (오늘·인박스·대기)
  const it = selectedItem();
  // 다이얼로그를 여는 키는 기본 동작을 먼저 끊는다 (그 글자가 입력창에 찍히지 않게)
  if (['e', 'w', 'd', 'n', 'm'].includes(e.key.toLowerCase())) e.preventDefault();
  switch (e.key) {
    case 'Enter':
      // 인박스에서 AI 제안이 있으면 Enter가 곧 확정 — 없으면 재개 카드로
      if (tab === 'inbox' && it?.suggested_project_id) {
        await window.whenwork.assign(it.id, it.suggested_project_id);
        return refresh();
      }
      if (it?.project_id) openResume(it.project_id);
      return;
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
    case 'a':
    case 'A': {
      if (tab !== 'inbox') return;
      toast('인박스 분류 중… (claude -p)', { spinner: true, holdMs: 0 });
      const res = await window.whenwork.classifyInbox();
      if (res.ok) toast(res.suggested ? `${res.total}건 중 ${res.suggested}건 제안 — Enter로 확정` : '제안할 항목 없음');
      else if (res.busy) toast('이미 분류 중');
      else toast('분류 실패 — claude -p 응답 없음');
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
    case 'o':
    case 'O':
      // 이슈에서 세운 할 일은 원본으로 건너갈 수 있어야 한다 (재개 카드의 O와 같은 뜻)
      if (it?.issue_url) window.whenwork.openUrl(it.issue_url);
      return;
    case 'm':
    case 'M':
      if (tab !== 'today') return;
      return captureFollowUp();
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
  if (view === 'list' && tab === 'today' && !dlgResolve && state?.events?.length) render();
}, 60_000);

// 백그라운드로 만들던 카드가 완성됐다 — 그 카드를 열어둔 채 스켈레톤을 보고 있었으면 채워준다.
// 열람 수(KPI)는 늘리지 않는다(log=false).
window.whenwork.onCardDone(async (projectId) => {
  if (view !== 'resume' || resume?.projectId !== projectId) return;
  const res = await window.whenwork.resumeGet(projectId, false);
  if (view !== 'resume' || resume?.projectId !== projectId) return;
  if (res.ok) {
    resume.data = res;
    resume.generating = !!res.generating;
    resume.error = null;
  }
  render();
});

window.whenwork.onRefresh(refresh);
// 퀵캡처에서 Tab으로 건너왔다 — 방금 던진 것을 정리하러 온 길이다
window.whenwork.onFromCapture(async () => {
  await refresh();
  if (view !== 'list') return;
  switchTab(state?.online && state.inbox?.length ? 'inbox' : 'today');
});
// 트레이에서 리뷰를 만들면 그 탭을 바로 열어준다
window.whenwork.onOpenReview(() => {
  review = { offset: 0, data: null, loaded: false, generating: false, error: null };
  switchTab('review');
});
refresh();
