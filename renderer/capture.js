// 퀵캡처 — 입력→Enter→저장까지 어떤 선택지도 띄우지 않는다 (설계 7절 게이트).
// 저장해도 창은 닫지 않는다: 연달아 던지거나 Tab으로 앱을 열 수 있게. 닫기는 Esc(또는 단축키 재입력).
const input = document.getElementById('in');
const msg = document.getElementById('msg');
let saving = false;
let sessionCount = 0; // 이번에 연달아 던진 개수
let msgTimer = null;

window.whenwork.onReset(() => {
  saving = false;
  sessionCount = 0;
  input.value = '';
  showDefaultMsg();
  input.focus();
});

// 기본 안내
function showDefaultMsg() {
  msg.className = 'msg';
  msg.textContent = '인박스로 저장';
  document.body.classList.remove('flash');
}

function showMsg(kind, text, holdMs = 0) {
  clearTimeout(msgTimer);
  msg.className = 'msg' + (kind ? ' ' + kind : '');
  msg.textContent = text;
  document.body.classList.toggle('flash', kind === 'ok');
  if (holdMs) msgTimer = setTimeout(showDefaultMsg, holdMs);
}

showDefaultMsg();

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
  saving = true;
  const res = await window.whenwork.save(title);
  saving = false;
  if (!res.ok) {
    // IN-02: saveCapture가 { ok: false }를 돌려주는 유일한 경로(제목이 비어 있는 경우)는 앞의 !title 가드로 지금은 도달하기 어렵지만, 이론적으로 도달 가능한
    // 분기가 조용히 아무것도 하지 않으면 사용자는 왜 저장이 안 됐는지 알 방법이 없다.
    // 입력은 지우지 않는다 — 저장되지 않았으므로 다시 고쳐 보낼 수 있어야 한다.
    showMsg('warn', '저장할 내용이 없습니다', 1500);
    return;
  }

  sessionCount++;
  input.value = ''; // 다음 입력을 바로 받는다 — 창은 그대로 열려 있다
  input.focus();
  const more = sessionCount > 1 ? ` · 이번에 ${sessionCount}건` : '';
  // 저장소가 즉시 반영에 실패해도 창은 실패를 보이지 않는다(D-03) — 대기 건수는
  // 트레이 툴팁과 오늘 뷰 상단에서만 드러난다.
  showMsg('ok', `✓ 인박스로 저장${more}`, 2000);
});

window.addEventListener('focus', () => input.focus());
