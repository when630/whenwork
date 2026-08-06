// 아침 브리핑 판단 (오픈이슈 #3) — Electron·DB 없이 검증할 수 있게 순수 함수로 둔다.
//
// 규칙은 셋이다: 하루 한 번만, 설정 시각을 지난 뒤에, 그 창을 놓친 날은 조용히 넘긴다.
// 마지막 규칙이 없으면 저녁에 컴퓨터를 켠 날 아침 브리핑이 튀어나온다.

export const NOTIFY_AT_DEFAULT = '09:00';
export const BRIEFING_WINDOW_MIN = 180;
export const STALE_WAITING_DAYS = 5;

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
export function briefingLines(b = {}, { staleDays = STALE_WAITING_DAYS, events = [] } = {}) {
  const parts = [];
  if (b.overdue) parts.push(`지연 ${b.overdue}건`);
  if (b.due_today) parts.push(`오늘 마감 ${b.due_today}건`);
  if (events.length) {
    const first = hhmm(events[0].start_at ?? events[0].start);
    parts.push(`일정 ${events.length}건${first ? ` (첫 일정 ${first})` : ''}`);
  }
  if (b.stale_waiting) parts.push(`${staleDays}일 넘게 기다림 ${b.stale_waiting}건`);
  if (b.inbox) parts.push(`인박스 ${b.inbox}건`);
  return parts;
}
