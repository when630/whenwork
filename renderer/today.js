// 오늘 뷰 — 탭 3개(오늘/인박스/대기), 마우스 없이 전 조작 가능 (설계 11절).
// Tab 탭 전환 · ↑↓/jk 이동 · Space 완료 · 1~9 프로젝트 지정 · W 대기 · X 삭제 · Esc 닫기
const PROJ_COLORS = ['#f7768e', '#9ece6a', '#7aa2f7', '#e0af68', '#bb9af7', '#7dcfff', '#ff9e64'];
const TABS = [
  { key: 'today', label: '오늘' },
  { key: 'inbox', label: '인박스' },
  { key: 'waiting', label: '대기' },
  { key: 'projects', label: '프로젝트' },
];

let state = null; // 마지막으로 받은 서버 상태
let tab = 'inbox'; // 캡처 직후 열면 인박스부터 보는 게 자연스럽다
let sel = 0; // 현재 탭에서 선택된 행
let dlgResolve = null; // 텍스트 입력 다이얼로그가 기다리는 resolve
let view = 'list'; // 'list' | 'resume'
let resume = null; // { projectId, data, loading, generating, error, sel }

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

// 화면에 그려지는 순서 그대로를 돌려준다.
// 오늘 탭은 프로젝트별로 묶어 그리므로 그 정렬을 여기서 해야 한다 —
// 안 그러면 선택 강조(그리는 순서)와 실제 대상(원본 순서)이 어긋나 엉뚱한 항목이 지워진다.
function currentList() {
  if (!state?.online) return [];
  if (tab === 'projects') return state.projects ?? [];
  const list = state[tab] ?? [];
  if (tab !== 'today') return list;
  const groupOrder = new Map(); // 프로젝트별 첫 등장 순서 = 그룹 순서
  for (const it of list) {
    const pid = it.project_id ?? 0;
    if (!groupOrder.has(pid)) groupOrder.set(pid, groupOrder.size);
  }
  return list
    .map((it, i) => ({ it, i }))
    .sort((a, b) =>
      groupOrder.get(a.it.project_id ?? 0) - groupOrder.get(b.it.project_id ?? 0) || a.i - b.i
    )
    .map((x) => x.it);
}

// ── 렌더
function render() {
  $('date').textContent = fmtDate();
  if (view === 'resume') {
    $('tabs').replaceChildren();
    renderResume();
    renderFooter();
    return;
  }
  renderTabs();
  renderBody();
  renderFooter();
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
  issSec.append(el('div', 'sec-h', '내 이슈 — 작성·할당 (Enter/O 브라우저)'));
  const issues = data?.issues ?? [];
  if (issues.length === 0) issSec.append(el('div', 'sync-note', '이슈 없음 또는 동기화 전'));
  issues.forEach((i, idx) => {
    const row = el('div', 'issue' + (idx === resume.sel ? ' selected' : ''));
    row.append(el('span', 'st ' + i.state), el('span', 'prov', i.provider === 'github' ? 'GH' : 'GL'), el('span', 'num', `#${i.number}`), el('span', 'tt', i.title));
    if (i.relation === 'assignee') row.append(el('span', 'asg', '할당'));
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
  // 카드가 없거나 24시간 넘게 묵었으면 자동 재생성 (일 1회 정책)
  const card = resume.data?.card;
  const stale = !card || Date.now() - new Date(card.generated_at).getTime() > 24 * 3600 * 1000;
  if (stale && !resume.generating) await regenerate(projectId);
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
  refresh();
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.replaceChildren();
  for (const t of TABS) {
    const n = !state?.online ? 0
      : t.key === 'projects' ? (state.projects?.length ?? 0)
      : (state[t.key]?.filter((i) => !i.done_at).length ?? 0);
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
    if (tab === 'projects') {
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
    // list는 이미 프로젝트별로 묶인 순서(currentList) — 그대로 훑으며 그룹이 바뀔 때 머리글을 넣는다
    let lastPid;
    list.forEach((it, idx) => {
      const pid = it.project_id ?? 0;
      if (pid !== lastPid) {
        lastPid = pid;
        const h = el('div', 'group-h');
        const chip = el('span', 'chip');
        const dot = el('span', 'dot');
        dot.style.background = projColor(pid);
        chip.append(dot, document.createTextNode(it.project_name ?? '미지정'));
        h.append(chip);
        body.append(h);
      }
      body.append(itemRow(it, idx));
    });
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
  if (view === 'resume') {
    add('R', '다시 생성');
    add('Enter', '이슈 열기');
    add('Esc', '뒤로');
    return;
  }
  add('Tab', '탭');
  if (tab === 'projects') {
    add('N', '추가');
    add('E', '이름');
    add('A', '약어');
    add('R', '리포');
    add('Shift+↕', '순서');
    add('X', '보관');
    return;
  }
  if (tab === 'inbox') {
    add('1~9', '프로젝트');
    add('W', '대기');
  } else if (tab === 'waiting') {
    add('Space', '회신 옴');
  } else {
    add('Space', '완료');
  }
  add('E', '제목');
  add('X', '삭제');
  add('Enter', '재개 카드');
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

function closeDlg(commit) {
  const resolve = dlgResolve;
  dlgResolve = null;
  $('dlg').classList.remove('show');
  resolve?.(commit ? $('dlgIn').value.trim() : null);
}

document.addEventListener('keydown', async (e) => {
  // 다이얼로그 입력 중에는 그 입력만 받는다
  if (dlgResolve) {
    if (e.key === 'Enter') closeDlg(true);
    if (e.key === 'Escape') closeDlg(false);
    e.stopPropagation();
    return;
  }

  // 재개 카드 화면
  if (view === 'resume') {
    const issues = resume?.data?.issues ?? [];
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
      return window.whenwork.hide();
    case 'Tab': {
      e.preventDefault();
      const i = TABS.findIndex((t) => t.key === tab);
      return switchTab(TABS[(i + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length].key);
    }
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
  if (['e', 'w'].includes(e.key.toLowerCase())) e.preventDefault();
  switch (e.key) {
    case 'Enter':
      if (it?.project_id) openResume(it.project_id);
      return;
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
