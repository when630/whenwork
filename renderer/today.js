// 오늘 뷰 — 탭 3개(오늘/인박스/대기), 마우스 없이 전 조작 가능 (설계 11절).
// Tab 탭 전환 · ↑↓/jk 이동 · Space 완료 · 1~9 프로젝트 지정 · W 대기 · X 삭제 · Esc 닫기
const PROJ_COLORS = ['#f7768e', '#9ece6a', '#7aa2f7', '#e0af68', '#bb9af7', '#7dcfff', '#ff9e64'];
const TABS = [
  { key: 'today', label: '오늘' },
  { key: 'inbox', label: '인박스' },
  { key: 'waiting', label: '대기' },
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
let tab = 'inbox'; // 캡처 직후 열면 인박스부터 보는 게 자연스럽다
let sel = 0; // 현재 탭에서 선택된 행
let dlgResolve = null; // 텍스트 입력 다이얼로그가 기다리는 resolve
let review = { offset: 0, data: null, generating: false, error: null }; // 리뷰 탭 상태
let cfg = null; // 설정 탭이 받아둔 값 (DB와 무관하게 따로 읽는다)
let filter = ''; // 검색어 — 탭을 옮겨도 유지된다 (어느 탭에 있는지 모를 때 찾으려고)
let searchOn = false; // 검색 입력에 포커스가 가 있는 동안
let dueOnly = false; // 오늘 탭: 마감 있는 것만 보기 (F)
let history = null; // 완료 기록 화면 상태 (H)
let view = 'list'; // 'list' | 'resume'
let resume = null; // { projectId, data, loading, generating, error, sel }
let resetScroll = false; // 탭·뷰가 바뀐 렌더에서만 맨 위로
const deleted = []; // 되돌릴 수 있는 삭제 스택 (U) — 최근 것부터 되살린다

const clip = (s, n = 24) => (String(s ?? '').length > n ? String(s).slice(0, n) + '…' : String(s ?? ''));

const $ = (id) => document.getElementById(id);

// 계산은 view.js에 있다 (DOM을 만지지 않는 부분 — 테스트 대상)
const {
  dueBadge,
  elapsedDays,
  matches,
  todayGroups,
  hhmm,
  eventState,
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
  return todayGroups(list);
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
    body.append(el('div', 'empty', '이 기간에 완료한 항목도 커밋도 없습니다'));
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
  renderFooter();
  body.scrollTop = keep;
  keepSelectionVisible();
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
  if (card) head.append(el('span', 'gen-at', `✦ ${fmtWhen(card.generated_at)} 생성`));
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
  // 2단: git 활동 — 로컬 데이터라 항상 먼저 그린다
  const gitSec = el('div');
  gitSec.append(el('div', 'sec-h', '최근 활동 (git · 자동 수집)'));
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
  issSec.append(el('div', 'sec-h', '내 이슈·PR — 작성·할당·리뷰 요청 (Enter/O 브라우저)'));
  const issues = data?.issues ?? [];
  if (issues.length === 0) issSec.append(el('div', 'sync-note', '이슈·PR 없음 또는 동기화 전'));
  issues.forEach((i, idx) => {
    const row = el('div', 'issue' + (idx === resume.sel ? ' selected' : ''));
    row.append(el('span', 'st ' + i.state), el('span', 'prov', i.provider === 'github' ? 'GH' : 'GL'));
    if (i.kind === 'pr') row.append(el('span', 'kind', i.provider === 'gitlab' ? 'MR' : 'PR'));
    row.append(el('span', 'num', `#${i.number}`), el('span', 'tt', i.title));
    if (i.draft) row.append(el('span', 'asg draft', '초안'));
    if (i.relation === 'reviewer') row.append(el('span', 'asg rev', '리뷰'));
    else if (i.relation !== 'author') row.append(el('span', 'asg', '할당'));
    row.append(el('span', 'when', fmtWhen(i.updated_at)));
    row.onclick = () => window.whenwork.openUrl(i.url);
    issSec.append(row);
  });
  if (issues[0]?.synced_at) issSec.append(el('div', 'sync-note', `동기화 ${fmtWhen(issues[0].synced_at)}`));
  rbody.append(issSec);
}

async function openResume(projectId) {
  view = 'resume';
  resume = { projectId, data: null, loading: true, generating: false, error: null, sel: 0 };
  resetScroll = true;
  render();
  const first = await window.whenwork.resumeGet(projectId);
  if (view !== 'resume' || resume.projectId !== projectId) return;
  resume.data = first.ok ? first : null;
  resume.loading = false;
  resume.generating = !!first.generating;
  render();
  // 백그라운드로 git·이슈를 새로 긁는다 — 끝나면 갱신
  const synced = await window.whenwork.resumeSync(projectId);
  if (view !== 'resume' || resume.projectId !== projectId) return;
  if (synced.ok) resume.data = synced;
  render();
  // 카드가 없거나 24시간 넘게 묵었으면 자동 재생성 (일 1회 정책).
  // 방금 실패했다면(서버 혼잡 등) 쿨다운 동안은 자동으로 다시 매달리지 않는다 — R로 직접 재시도.
  const card = resume.data?.card;
  const stale = !card || Date.now() - new Date(card.generated_at).getTime() > 24 * 3600 * 1000;
  const cooling = resume.data?.retryAfter && resume.data.retryAfter > Date.now();
  if (stale && !resume.generating && !cooling) await regenerate(projectId);
  else if (stale && cooling && !card) {
    resume.error = '직전 생성이 실패해 잠시 쉬는 중입니다 — R로 다시 시도할 수 있습니다';
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
  row.append(el('div', 'cb'), el('div', 't', it.title));
  const badge = dueBadge(it.due);
  if (badge) {
    const meta = el('div', 'meta');
    meta.append(el('span', 'due ' + badge.cls, badge.text));
    row.append(meta);
  }
  if (tab === 'inbox') {
    if (it.suggested_project_id) {
      // AI 제안은 사람 입력과 늘 구분해서 보여준다 (✦ 보라)
      const s = el('div', 'suggest');
      const chip = el('span', 'chip');
      const dot = el('span', 'dot');
      dot.style.background = projColor(it.suggested_project_id);
      chip.append(dot, document.createTextNode(it.suggested_project_name ?? ''));
      s.append(el('span', 'badge-ai', '✦ AI'), chip, el('span', 'act', 'Enter 확정'));
      row.append(s);
    }
    if (it.context?.fg) {
      const ctx = el('div', 'ctx');
      ctx.append(window.ICONS.context(), document.createTextNode(` 캡처 당시: ${it.context.fg}`));
      row.append(ctx);
    }
  }
  if (it.note) row.append(el('div', 'ctx', `↳ ${it.note}`));
  if (tab === 'waiting') {
    const days = elapsedDays(it.captured_at);
    const meta = el('div', 'wait-meta');
    meta.append(document.createTextNode(`→ ${it.waiting_for || '(미지정)'} · `));
    meta.append(el('span', 'elapsed' + (days >= 5 ? ' hot' : ''), `경과 ${days}일`));
    row.append(meta);
  }
  row.onclick = () => {
    sel = idx;
    render();
  };
  return row;
}

// ── 주간 리뷰 탭 — DB에 저장된 초안을 보여주고, 없으면 생성하게 한다
function renderReview() {
  const body = $('body');
  body.replaceChildren();
  const d = review.data;

  const head = el('div', 'rv-head');
  const nav = el('div', 'rv-nav');
  const prev = el('span', null, '‹');
  prev.title = '지난 주';
  prev.onclick = () => moveWeek(-1);
  const next = el('span', null, '›');
  next.title = '다음 주';
  next.onclick = () => moveWeek(1);
  nav.append(prev, next);
  const title = el('div');
  title.append(
    el('div', 'wk', d ? `${d.year}년 ${d.week}주차${review.offset === 0 ? ' (이번 주)' : ''}` : '주간 리뷰'),
    el('div', 'range', d?.label ?? '')
  );
  head.append(nav, title);
  if (d?.review?.generated_at) {
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
    box.append(window.MD.render(d.review.body));
  } else {
    const e = el('div', 'empty');
    const hint = el('div');
    hint.append(el('kbd', null, 'G'), document.createTextNode(' 로 이 주의 초안을 만듭니다'));
    e.append(el('div', 'big', '◎'), el('div', null, '아직 만든 초안이 없습니다'), hint);
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

async function loadReview() {
  const res = await window.whenwork.reviewGet(review.offset);
  review.data = res.ok ? res : null;
  review.generating = !!res.generating;
  render();
}

function moveWeek(delta) {
  review.offset = Math.min(0, review.offset + delta); // 미래 주는 볼 게 없다
  review.error = null;
  review.data = null;
  resetScroll = true;
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
    review.error = res.busy ? '이미 생성 중입니다' : (res.error ?? 'claude -p 응답 없음');
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
      cfg.lastBackup ? ` 마지막 백업 ${fmtWhen(cfg.lastBackup)} — 지금 백업 (B)` : ' 백업 이력 없음 — 지금 백업 (B)'
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
  else toast(res.busy ? '이미 백업 중입니다' : `백업 실패 — ${res.error ?? '알 수 없는 오류'}`);
  return loadSettings();
}

async function runCalendarSync() {
  toast('캘린더 동기화 중…', { spinner: true, holdMs: 0 });
  const res = await window.whenwork.calendarSync();
  if (res.ok) toast(`캘린더 — 일정 ${res.count}건`);
  else if (res.skipped) toast('캘린더 URL이 설정되지 않았습니다');
  else toast(`캘린더 실패 — ${res.error ?? '알 수 없는 오류'}`, { holdMs: 6000 });
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
    // 화면에는 가린 값만 있으므로 편집이 아니라 새로 붙여넣는다 (빈 값이면 해제)
    const url = await promptText(`${f.label} — 전체 주소를 붙여넣기 (비우면 사용 안 함)`, '');
    if (url === null) return;
    if (url && !/^https:\/\/script\.google\.com\//.test(url)) {
      return toast('Apps Script 웹앱 주소(https://script.google.com/...)를 넣어주세요');
    }
    await window.whenwork.settingsSet(f.key, url || null);
    await loadSettings();
    if (!url) return toast(`${f.label} — 해제`);
    toast('캘린더 확인 중…', { spinner: true, holdMs: 0 });
    const res = await window.whenwork.calendarSync();
    toast(res.ok ? `캘린더 연결됨 — 일정 ${res.count}건` : `캘린더 실패 — ${res.error ?? '알 수 없음'}`, {
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
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return toast('시각은 HH:MM 형식으로 입력하세요');
  await window.whenwork.settingsSet(f.key, `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`);
  return loadSettings();
}

async function clearSetting(f) {
  if (!f) return;
  await window.whenwork.settingsSet(f.key, null);
  toast(`${f.label} — 기본값으로`);
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
      el('div', null, 'DB 대기 중 — Docker의 whenwork-db가 켜지면 자동 동기화됩니다'),
      el('div', null, `로컬 큐 ${state.pending}건 보관 중 (캡처는 계속 됩니다)`)
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
      const strip = el('div', 'cal-strip');
      for (const ev of events) {
        const row = el('div', `cal ${eventState(ev)}`);
        row.append(el('span', 'cal-t', ev.all_day ? '종일' : hhmm(ev.start_at)));
        row.append(el('span', 'cal-title', ev.title));
        if (ev.location) row.append(el('span', 'cal-loc', ev.location));
        strip.append(row);
      }
      body.append(strip);
    }
  }

  if (list.length === 0) {
    const e = el('div', 'empty');
    if (filter) {
      const hint = el('div');
      hint.append(el('kbd', null, 'Esc'), document.createTextNode(' 로 검색 해제'));
      e.append(el('div', 'big', '◎'), el('div', null, `"${filter}"에 맞는 항목이 없습니다`), hint);
    } else if (tab === 'projects') {
      const hint = el('div');
      hint.append(el('kbd', null, 'N'), document.createTextNode(' 으로 프로젝트를 추가하세요'));
      e.append(el('div', 'big', '◎'), el('div', null, '프로젝트가 없습니다'), hint);
    } else {
      const hint = el('div');
      hint.append(document.createTextNode('생각나면 '));
      ['Ctrl', 'Alt', 'Space'].forEach((k, i) => {
        if (i) hint.append(document.createTextNode('+'));
        hint.append(el('kbd', null, k));
      });
      hint.append(document.createTextNode(' 로 던져두세요'));
      e.append(el('div', 'big', '◎'), el('div', null, '항목이 없습니다'), hint);
    }
    body.append(e);
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
      const h = el('div', 'group-h' + (g.key === 'urgent' ? ' urgent' : ''));
      if (g.key === 'urgent') {
        h.append(el('span', 'hot', g.label));
      } else {
        const chip = el('span', 'chip');
        const dot = el('span', 'dot');
        dot.style.background = projColor(g.pid);
        chip.append(dot, document.createTextNode(g.label));
        h.append(chip);
      }
      body.append(h);
      for (const it of g.items) body.append(itemRow(it, idx++));
    }
  } else {
    list.forEach((it, idx) => body.append(itemRow(it, idx)));
  }

  if (tab === 'inbox' && state.projects.length) {
    const legend = el('div', 'numlegend');
    state.projects.slice(0, 9).forEach((p, i) => {
      const s = el('span');
      s.append(el('b', null, String(i + 1)), document.createTextNode(' ' + p.name));
      legend.append(s);
    });
    body.append(legend);
  }
}

function renderFooter() {
  const sync = $('sync');
  const online = state?.online;
  sync.classList.toggle('off', !online);
  $('syncText').textContent = online
    ? state.pending ? `동기화 중 — 큐 ${state.pending}건` : '동기화됨'
    : `DB 대기 — 큐 ${state?.pending ?? 0}건`;

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
    return;
  }
  if (view === 'resume') {
    add('R', '다시 생성');
    add('Enter', '이슈 열기');
    add('Esc', '뒤로');
    return;
  }
  add('Tab', '탭');
  if (tab === 'review') {
    add('G', review.data?.review ? '다시 생성' : '생성');
    add('↑↓', '스크롤');
    add('←→', '주 이동');
    if (review.data?.review?.file) add('O', '볼트에서 열기');
    add('Esc', '닫기');
    return;
  }
  if (tab === 'settings') {
    add('Enter', '변경');
    add('X', '기본값으로');
    add('B', '지금 백업');
    if (cfg?.values?.calendarUrl) add('C', '캘린더 동기화');
    add('O', 'settings.json');
    add('Esc', '닫기');
    return;
  }
  if (tab === 'projects') {
    add('N', '추가');
    add('E', '이름');
    add('A', '약어');
    add('R', '리포');
    add('Shift+↕', '순서');
    add('X', '보관');
    add('/', '검색');
    add('Esc', filter ? '검색 해제' : '닫기');
    return;
  }
  if (tab === 'inbox') {
    add('A', 'AI 분류');
    add('1~9', '프로젝트');
    add('W', '대기');
  } else if (tab === 'waiting') {
    add('Space', '회신 옴');
    add('N', '메모');
  } else {
    add('Space', '완료');
    add('D', '마감');
    add('F', dueOnly ? '전체' : '마감만');
    add('H', '기록');
  }
  add('E', '제목');
  add('X', '삭제');
  if (deleted.length) add('U', '되돌리기');
  add('/', '검색');
  add('Enter', '재개 카드');
  add('Esc', filter ? '검색 해제' : '닫기');
}

// ── 동작
async function refresh() {
  state = await window.whenwork.getState();
  render();
}

function switchTab(key) {
  tab = key;
  sel = 0;
  resetScroll = true;
  render();
  if (key === 'review' && !review.data) loadReview();
  if (key === 'settings') loadSettings();
}

function selectedItem() {
  return currentList()[sel] ?? null;
}

// 한 줄 텍스트 입력 — null이면 취소.
// 호출부는 반드시 keydown을 preventDefault한 뒤에 부른다. 안 그러면 다이얼로그를 연 그 키의
// 기본 동작(문자 입력)이 방금 포커스된 입력창으로 들어간다 — 아래 rAF 리셋은 그 2차 방어.
function promptText(label, initial = '') {
  return new Promise((resolve) => {
    dlgResolve = resolve;
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
    }
    e.stopPropagation();
    return;
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
    case 'Tab': {
      e.preventDefault();
      const i = TABS.findIndex((t) => t.key === tab);
      return switchTab(TABS[(i + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length].key);
    }
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

  // 항목 탭 (오늘·인박스·대기)
  const it = selectedItem();
  // 다이얼로그를 여는 키는 기본 동작을 먼저 끊는다 (그 글자가 입력창에 찍히지 않게)
  if (['e', 'w', 'd', 'n'].includes(e.key.toLowerCase())) e.preventDefault();
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
      if (!res.ok) toast('날짜를 알아듣지 못했습니다 — 오늘 / 내일 / +3 / 8-12 형식');
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
      if (res.ok) toast(res.suggested ? `${res.total}건 중 ${res.suggested}건 제안 — Enter로 확정` : '제안할 만한 항목이 없습니다');
      else if (res.busy) toast('이미 분류 중입니다');
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
      if (!it) return;
      if (it.done_at) await window.whenwork.uncomplete(it.id);
      else await window.whenwork.complete(it.id);
      return refresh();
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
      toast(dueOnly ? '마감 있는 것만 봅니다' : '오늘 탭 — 전체를 봅니다');
      return render();
    }
    case 'x':
    case 'X':
      if (!it) return;
      await window.whenwork.remove(it.id);
      // 지운 것은 되돌릴 수 있다 — 연달아 지웠으면 U를 누른 만큼 거꾸로 살아난다
      deleted.push({ id: it.id, title: it.title });
      toast(`삭제 — "${clip(it.title)}" · U로 되돌리기`);
      return refresh();
    case 'u':
    case 'U': {
      const last = deleted.pop();
      if (!last) return toast('되돌릴 삭제가 없습니다');
      await window.whenwork.restore(last.id);
      toast(`되돌림 — "${clip(last.title)}"`);
      return refresh();
    }
    default: {
      // 1~9: 프로젝트 지정 (인박스 항목을 todo로 보낸다 — 다른 탭에서는 재지정)
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && it) {
        const p = state.projects[n - 1];
        if (p) {
          await window.whenwork.assign(it.id, p.id);
          await refresh();
        }
      }
    }
  }
});

window.whenwork.onRefresh(refresh);
// 트레이에서 리뷰를 만들면 그 탭을 바로 열어준다
window.whenwork.onOpenReview(() => {
  review = { offset: 0, data: null, generating: false, error: null };
  switchTab('review');
});
refresh();
