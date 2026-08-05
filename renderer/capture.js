// 퀵캡처 — 입력→Enter→닫힘까지 어떤 선택지도 띄우지 않는다 (설계 7절 게이트)
const input = document.getElementById('in');
const queueEl = document.getElementById('queue');
let saving = false;
let shownAt = 0;

window.whenwork.onReset(() => {
  saving = false;
  shownAt = Date.now();
  document.body.classList.remove('saved', 'offline');
  input.value = '';
  input.focus();
});

// 전역 단축키(Ctrl+Alt+Space)의 Space가 갓 포커스된 입력창으로 새어 들어온다 — 둘 다 막는다:
// ① 수식키가 눌린 Space는 무시 ② 표시 직후 200ms 안의 공백-only 입력은 지운다
input.addEventListener('input', () => {
  if (Date.now() - shownAt < 200 && input.value.trim() === '') input.value = '';
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
  if (!res.ok) {
    saving = false;
    return;
  }
  document.body.classList.add('saved');
  if (!res.dbOnline) {
    document.body.classList.add('offline');
    queueEl.textContent = `⏳ DB 대기 중 — 로컬 큐 ${res.pending}건 (연결되면 자동 동기화)`;
  }
  // 저장 피드백을 잠깐 보여주고 닫는다 — 오프라인 안내는 읽을 시간을 조금 더 준다
  setTimeout(() => window.whenwork.hide(), res.dbOnline ? 400 : 1200);
});

window.addEventListener('focus', () => input.focus());
