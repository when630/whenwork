// 아침 브리핑 판단 (오픈이슈 #3) — Electron·DB 없이 검증할 수 있게 순수 함수로 둔다.
//
// 규칙은 셋이다: 하루 한 번만, 설정 시각을 지난 뒤에, 그 창을 놓친 날은 조용히 넘긴다.
// 마지막 규칙이 없으면 저녁에 컴퓨터를 켠 날 아침 브리핑이 튀어나온다.

export const NOTIFY_AT_DEFAULT = '09:00';
export const BRIEFING_WINDOW_MIN = 180;
export const STALE_WAITING_DAYS = 5;
// 며칠 묵어야 "오래됐다"고 말할 값어치가 있는가. 어제 담은 것에까지 날짜를 붙이면 잔소리가 된다.
export const STALE_TODO_DAYS = 3;

export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 'wait'  — 아직 시각 전이거나 이미 오늘 처리됨. 아무것도 하지 않는다
// 'brief' — 지금 알린다 (건수가 0이면 호출자가 알림을 생략한다)
// 'skip'  — 알리지 않지만 오늘은 처리한 것으로 표시한다 (창을 놓친 날)
export function briefDecision({
  now = new Date(),
  at = NOTIFY_AT_DEFAULT,
  lastBriefing = null,
  enabled = true,
  windowMin = BRIEFING_WINDOW_MIN,
} = {}) {
  if (!enabled) return 'wait';
  const m = String(at ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 'wait'; // 시각 설정이 깨졌으면 알리지 않는다 (설정 화면에서 고칠 일이다)
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return 'wait';
  if (lastBriefing === dayKey(now)) return 'wait';
  const mins = now.getHours() * 60 + now.getMinutes();
  const target = hh * 60 + mm;
  if (mins < target) return 'wait';
  return mins > target + windowMin ? 'skip' : 'brief';
}

function hhmm(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 브리핑 한 줄. 급한 순서로 늘어놓는다 —
// 지연 → 오늘 마감 → 일정(시각이 박혀 있어 구속력이 크다) → 오래된 대기 → 인박스.
export function briefingLines(
  b = {},
  { staleDays = STALE_WAITING_DAYS, events = [], review = null } = {}
) {
  const parts = [];
  if (b.overdue) parts.push(`지연 ${b.overdue}건`);
  if (b.due_today) parts.push(`오늘 마감 ${b.due_today}건`);
  if (events.length) {
    const first = hhmm(events[0].start_at ?? events[0].start);
    parts.push(`일정 ${events.length}건${first ? ` (첫 일정 ${first})` : ''}`);
  }
  if (b.stale_waiting) parts.push(`${staleDays}일 넘게 기다림 ${b.stale_waiting}건`);
  if (b.inbox) parts.push(`인박스 ${b.inbox}건`);
  // 급한 것이 하나도 없어도 손에 든 일은 있다. 마감을 쓰지 않기 시작하자 위의 다섯 줄이
  // 한꺼번에 0이 되어 브리핑이 통째로 침묵했다 — 열린 할 일이 11건 있던 아침에도 그랬다.
  // 아침에 아무 말이 없으니 앱을 열 이유도 없어졌다. 브리핑이 마감이라는 습관 하나에
  // 얹혀 있던 셈이라, 그것이 비었을 때 대신 말할 것을 둔다(급한 게 있으면 이건 중복이다).
  if (!parts.length && b.open_todo) {
    const oldest = Number(b.oldest_todo_days) || 0;
    const tail = oldest >= STALE_TODO_DAYS ? ` (가장 오래된 건 ${oldest}일째)` : '';
    parts.push(`할 일 ${b.open_todo}건${tail}`);
  }
  // 주간 리뷰는 알림을 따로 갖지 않는다(알림은 아침 브리핑 하나 — 오픈이슈 #3).
  if (review === 'ready') parts.push('지난주 리뷰 준비됨');
  else if (review === 'pending') parts.push('지난주 리뷰 아직');
  return parts;
}

// 지난주 리뷰를 만들 때인가. 백업과 같은 규칙을 쓴다(하루 한 번, 실패한 날은 손을 뗀다).
//
// 있어도 다시 만드는 경우가 있다: 주가 **끝나기 전에** 만든 초안은 그 주의 절반만 담고 있다.
// 실제로 32주 리뷰가 그 주 수요일에 만들어진 채 남았고, 주가 끝난 뒤에도 아무도 다시
// 만들지 않았다 — 백업을 자립시키면서 리뷰는 사람의 기억에 얹어둔 탓이다.
export function reviewDue({
  now = new Date(),
  weekEnd = null, // 지난주의 상한(이번 주 월요일 0시). 이 시각 전에 만든 초안은 낡은 것으로 본다
  generatedAt = null,
  lastTry = null,
} = {}) {
  if (lastTry === dayKey(now)) return false;
  if (!weekEnd) return false; // 어느 주를 말하는지 모르면 손대지 않는다
  const end = new Date(weekEnd);
  if (Number.isNaN(end.getTime()) || now < end) return false; // 아직 끝나지 않은 주
  if (!generatedAt) return true;
  const at = new Date(generatedAt);
  if (Number.isNaN(at.getTime())) return true; // 값이 깨졌으면 다시 만드는 쪽으로 기운다
  return at < end;
}
