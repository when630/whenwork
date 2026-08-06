// 퀵캡처 — 입력→Enter→저장까지 어떤 선택지도 띄우지 않는다 (설계 7절 게이트).
// 저장해도 창은 닫지 않는다: 연달아 던지거나 Tab으로 앱을 열 수 있게. 닫기는 Esc(또는 단축키 재입력).
const input = document.getElementById('in');
const msg = document.getElementById('msg');
let saving = false;
let sessionCount = 0; // 이번에 연달아 던진 개수
let msgTimer = null;
let projects = []; // [{ abbr, name }] — main이 열 때마다 내려준다

window.whenwork.onReset(() => {
  saving = false;
  sessionCount = 0;
  input.value = '';
  showDefaultMsg();
  input.focus();
  loadProjects(); // 프로젝트·약어는 수시로 바뀐다 — 열 때마다 새로 가져온다
});

// 약어 목록은 **가져온다**. main이 창을 만들자마자 보내면 리스너가 아직 없어 그 메시지가
// 사라지고(앱 재시작 후 첫 퀵캡처가 그 경우다) 어떤 약어도 인식하지 못했다.
async function loadProjects() {
  const list = await window.whenwork.projects();
  if (!Array.isArray(list)) return;
  projects = list;
  updateTokenHint();
  showTokenMsg(); // 목록이 늦게 와도 이미 친 토큰을 그때 알아본다
}

// 힌트에 실제로 통하는 약어를 보여준다 — 「#약어」라고만 적어두면 그 글자를 그대로 치게 된다
function updateTokenHint() {
  const sample = projects.find((p) => p.abbr)?.abbr;
  document.getElementById('tokenHint').textContent = sample ? `#${sample}` : '#약어';
}

// ── 끝의 #약어
//
// 약어를 타이핑하는 곳은 이 창뿐인데 확인할 화면은 여기서 볼 수 없다 — 그래서 치는 동안
// 어느 프로젝트로 가는지(또는 그런 약어가 없다는 것을) 바로 보여준다.
// 규칙은 main/parse.mjs의 parseCaptureToken과 같아야 한다: 여기서 알려주고 푸는 건 저쪽이다.
const TOKEN_END = /\s#([A-Za-z0-9_-]{1,16})$/;
const TOKEN_HEAD = /^#([A-Za-z0-9_-]{1,16})\s/;

function tokenOf(text) {
  const s = String(text ?? '');
  const end = s.match(TOKEN_END);
  const head = end ? null : s.match(TOKEN_HEAD);
  // 본문이 통째로 토큰이면 토큰으로 보지 않는다
  if (end && !s.slice(0, end.index).trim()) return null;
  if (head && !s.slice(head[0].length).trim()) return null;
  const abbr = (end ?? head)?.[1];
  if (!abbr) return null;
  const hit = projects.find((p) => p.abbr && p.abbr.toLowerCase() === abbr.toLowerCase());
  return { abbr, project: hit ? hit.name : null };
}

// 기본 안내 — 컨텍스트가 함께 저장된다는 표시로 창 아이콘을 앞에 둔다
function showDefaultMsg() {
  msg.className = 'msg';
  msg.replaceChildren(
    document.createTextNode('인박스로 저장 · '),
    window.ICONS.context(),
    document.createTextNode(' 컨텍스트 기록')
  );
  document.body.classList.remove('flash');
}

function showMsg(kind, text, holdMs = 0) {
  clearTimeout(msgTimer);
  msg.className = 'msg' + (kind ? ' ' + kind : '');
  msg.textContent = text;
  document.body.classList.toggle('flash', kind === 'ok');
  if (holdMs) msgTimer = setTimeout(showDefaultMsg, holdMs);
}

// 입력 중에는 토큰 상태를, 아니면 기본 안내를
function showTokenMsg() {
  const t = tokenOf(input.value);
  if (!t) return showDefaultMsg();
  if (t.project) return showMsg('hint', `#${t.abbr} → ${t.project}`);
  showMsg('warn', `#${t.abbr} — 없는 약어`);
}

showDefaultMsg();
loadProjects();

// 전역 단축키(Ctrl+Alt+Space)의 Space가 갓 포커스된 입력창으로 새어 들어온다.
// 타이밍으로 거르면 놓치는 경우가 생기므로 **선두 공백 입력 자체를 금지**한다 —
// 할 일 제목이 공백으로 시작할 일은 없으니 잃는 것도 없다.
input.addEventListener('beforeinput', (e) => {
  if (e.data === ' ' && input.selectionStart === 0) e.preventDefault();
});
input.addEventListener('input', () => {
  if (/^\s/.test(input.value)) input.value = input.value.replace(/^\s+/, '');
  showTokenMsg();
});

document.addEventListener('keydown', async (e) => {
  if (e.code === 'Space' && (e.ctrlKey || e.altKey)) return e.preventDefault();
  if (e.key === 'Escape') return window.whenwork.hide();
  if (e.key === 'Tab') {
    e.preventDefault();
    return window.whenwork.openApp();
  }
  if (e.key !== 'Enter' || saving) return;

  const title = input.value.trim();
  if (!title) return;
  const token = tokenOf(title); // 지우기 전에 어디로 갈지 잡아둔다
  saving = true;
  const res = await window.whenwork.save(title);
  saving = false;
  if (!res.ok) return;

  sessionCount++;
  input.value = ''; // 다음 입력을 바로 받는다 — 창은 그대로 열려 있다
  input.focus();
  const more = sessionCount > 1 ? ` · 이번에 ${sessionCount}건` : '';
  if (!res.dbOnline) {
    // DB가 꺼져 있으면 약어는 플러시 시점에 풀린다 — 지금은 큐에 들어간 사실만 알린다
    showMsg('warn', `✓ 저장 · DB 대기 — 로컬 큐 ${res.pending}건`, 3000);
  } else if (token && !token.project) {
    // 없는 약어는 제목에 그대로 남는다 (인박스에서 E로 고치면 된다)
    showMsg('warn', `✓ 인박스로 저장 · #${token.abbr} 없는 약어`, 3000);
  } else if (token) {
    showMsg('ok', `✓ ${token.project}로 저장${more}`, 2000);
  } else {
    showMsg('ok', `✓ 인박스로 저장${more}`, 2000);
  }
});

window.addEventListener('focus', () => input.focus());
