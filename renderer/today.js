// 오늘 뷰 — 탭 3개(오늘/인박스/대기), 마우스 없이 전 조작 가능 (설계 11절).
// Tab 탭 전환 · ↑↓/jk 이동 · Space 완료 · 1~9 프로젝트 지정 · W 대기 · X 삭제 · Esc 닫기
const PROJ_COLORS = ['#f7768e', '#9ece6a', '#7aa2f7', '#e0af68', '#bb9af7', '#7dcfff', '#ff9e64'];
const TABS = [
  { key: 'today', label: '오늘' },
  { key: 'inbox', label: '인박스' },
  { key: 'waiting', label: '대기' },
];

let state = null; // 마지막으로 받은 서버 상태
let tab = 'inbox'; // 캡처 직후 열면 인박스부터 보는 게 자연스럽다
let sel = 0; // 현재 탭에서 선택된 행
let whoTarget = null; // W 입력 대기 중인 item id

const $ = (id) => document.getElementById(id);

function projColor(p) {
  const idx = state?.projects?.findIndex((x) => x.id === p) ?? -1;
  return PROJ_COLORS[idx >= 0 ? idx % PROJ_COLORS.length : 0];
}

function fmtDate(d = new Date()) {
  return `${d.getMonth() + 1}/${d.getDate()} (${'일월화수목금토'[d.getDay()]})`;
}

function dueBadge(due) {
  if (!due) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(due);
  d.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400000);
  if (diff > 0) return { text: `D+${diff}`, cls: 'over' };
  if (diff === 0) return { text: '오늘', cls: 'today' };
  return { text: `D-${-diff}`, cls: '' };
}

function elapsedDays(ts) {
  return Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 86400000));
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function currentList() {
  if (!state?.online) return [];
  return state[tab] ?? [];
}

// ── 렌더
function render() {
  $('date').textContent = fmtDate();
  renderTabs();
  renderBody();
  renderFooter();
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.replaceChildren();
  for (const t of TABS) {
    const n = state?.online ? (state[t.key]?.filter((i) => !i.done_at).length ?? 0) : 0;
    const node = el('div', 'tab' + (tab === t.key ? ' on' : ''));
    node.append(el('span', null, t.label), el('span', 'n', String(n)));
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
  if (tab === 'inbox' && it.context?.fg) {
    row.append(el('div', 'ctx', `📎 캡처 당시: ${it.context.fg}`));
  }
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

function renderBody() {
  const body = $('body');
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

  if (list.length === 0) {
    const e = el('div', 'empty');
    const hint = el('div');
    hint.append(document.createTextNode('생각나면 '));
    ['Ctrl', 'Alt', 'Space'].forEach((k, i) => {
      if (i) hint.append(document.createTextNode('+'));
      hint.append(el('kbd', null, k));
    });
    hint.append(document.createTextNode(' 로 던져두세요'));
    e.append(el('div', 'big', '◎'), el('div', null, '항목이 없습니다'), hint);
    body.append(e);
    return;
  }

  if (tab === 'today') {
    // 프로젝트별 그룹핑 — 그룹 안에서는 서버 정렬(마감 임박 우선) 유지
    const groups = new Map();
    for (const it of list) {
      const key = it.project_id ?? 0;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    let idx = 0;
    for (const [pid, items] of groups) {
      const h = el('div', 'group-h');
      const chip = el('span', 'chip');
      const dot = el('span', 'dot');
      dot.style.background = projColor(pid);
      chip.append(dot, document.createTextNode(items[0].project_name ?? '미지정'));
      h.append(chip);
      body.append(h);
      for (const it of items) body.append(itemRow(it, idx++));
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
  add('Tab', '탭');
  if (tab === 'inbox') {
    add('1~9', '프로젝트');
    add('W', '대기');
  } else if (tab === 'waiting') {
    add('Space', '회신 옴');
  } else {
    add('Space', '완료');
  }
  add('X', '삭제');
  add('Esc', '닫기');
}

// ── 동작
async function refresh() {
  state = await window.whenwork.getState();
  render();
}

function switchTab(key) {
  tab = key;
  sel = 0;
  render();
}

function selectedItem() {
  return currentList()[sel] ?? null;
}

function openWhoDlg(id) {
  whoTarget = id;
  $('whoDlg').classList.add('show');
  $('whoIn').value = '';
  $('whoIn').focus();
}

async function closeWhoDlg(commit) {
  const id = whoTarget;
  whoTarget = null;
  $('whoDlg').classList.remove('show');
  if (commit && id) {
    await window.whenwork.toWaiting(id, $('whoIn').value.trim() || null);
    await refresh();
  }
}

document.addEventListener('keydown', async (e) => {
  // 대기 대상 입력 중에는 그 입력만 받는다
  if (whoTarget) {
    if (e.key === 'Enter') closeWhoDlg(true);
    if (e.key === 'Escape') closeWhoDlg(false);
    e.stopPropagation();
    return;
  }

  const it = selectedItem();
  switch (e.key) {
    case 'Escape':
      return window.whenwork.hide();
    case 'Tab': {
      e.preventDefault();
      const i = TABS.findIndex((t) => t.key === tab);
      return switchTab(TABS[(i + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length].key);
    }
    case 'ArrowDown':
    case 'j':
      sel = Math.min(sel + 1, currentList().length - 1);
      return render();
    case 'ArrowUp':
    case 'k':
      sel = Math.max(sel - 1, 0);
      return render();
    case ' ':
      e.preventDefault();
      if (!it) return;
      if (it.done_at) await window.whenwork.uncomplete(it.id);
      else await window.whenwork.complete(it.id);
      return refresh();
    case 'w':
    case 'W':
      if (it && tab !== 'waiting') openWhoDlg(it.id);
      return;
    case 'x':
    case 'X':
      if (!it) return;
      await window.whenwork.remove(it.id);
      return refresh();
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
refresh();
