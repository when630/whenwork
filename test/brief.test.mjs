import test from 'node:test';
import assert from 'node:assert/strict';
import { briefDecision, briefingLines, reviewDue, dayKey } from '../main/brief.mjs';

const at = (h, m = 0) => new Date(2026, 7, 5, h, m);

test('설정 시각 전에는 아무것도 하지 않는다', () => {
  assert.equal(briefDecision({ now: at(8, 59), at: '09:00' }), 'wait');
});

test('설정 시각을 지나면 알린다', () => {
  assert.equal(briefDecision({ now: at(9, 0), at: '09:00' }), 'brief');
  assert.equal(briefDecision({ now: at(11, 30), at: '09:00' }), 'brief');
});

test('창(3시간)을 놓친 날은 알리지 않고 오늘로 표시만 한다', () => {
  assert.equal(briefDecision({ now: at(19, 0), at: '09:00' }), 'skip');
});

test('오늘 이미 알렸으면 다시 알리지 않는다', () => {
  const now = at(10, 0);
  assert.equal(briefDecision({ now, at: '09:00', lastBriefing: dayKey(now) }), 'wait');
});

test('어제 알린 기록은 오늘을 막지 않는다', () => {
  assert.equal(briefDecision({ now: at(10, 0), at: '09:00', lastBriefing: '2026-08-04' }), 'brief');
});

test('꺼져 있으면 알리지 않는다', () => {
  assert.equal(briefDecision({ now: at(10, 0), at: '09:00', enabled: false }), 'wait');
});

test('시각 설정이 깨졌으면 알리지 않는다', () => {
  for (const bad of ['', '9시', '25:00', '09:75', null]) {
    assert.equal(briefDecision({ now: at(23, 0), at: bad }), 'wait', String(bad));
  }
});

test('시각을 안 넘기면 기본값(09:00)을 쓴다', () => {
  assert.equal(briefDecision({ now: at(9, 30) }), 'brief');
  assert.equal(briefDecision({ now: at(8, 0) }), 'wait');
});

test('자정 직후 설정이면 그날 안에서만 유효하다', () => {
  assert.equal(briefDecision({ now: at(0, 5), at: '00:00' }), 'brief');
  assert.equal(briefDecision({ now: at(4, 0), at: '00:00' }), 'skip');
});

test('브리핑 문구는 급한 순서대로, 0인 항목은 빠진다', () => {
  const parts = briefingLines({ overdue: 2, due_today: 0, stale_waiting: 1, inbox: 3 });
  assert.deepEqual(parts, ['지연 2건', '5일 넘게 기다림 1건', '인박스 3건']);
});

test('오늘 일정은 건수와 첫 시각을 함께 알린다', () => {
  const events = [
    { start_at: new Date(2026, 7, 6, 10, 0) },
    { start_at: new Date(2026, 7, 6, 14, 10) },
  ];
  const parts = briefingLines({ overdue: 1 }, { events });
  assert.deepEqual(parts, ['지연 1건', '일정 2건 (첫 일정 10:00)']);
});

test('일정만 있어도 알린다', () => {
  assert.deepEqual(briefingLines({}, { events: [{ start_at: new Date(2026, 7, 6, 9, 5) }] }), [
    '일정 1건 (첫 일정 09:05)',
  ]);
});

test('챙길 게 없으면 빈 배열 — 호출부가 알림을 생략한다', () => {
  assert.deepEqual(briefingLines({ overdue: 0, due_today: 0, stale_waiting: 0, inbox: 0 }), []);
  assert.deepEqual(briefingLines({}), []);
});

// ── 마감을 쓰지 않는 주에도 말이 있어야 한다 (실사용에서 8/7~8/10 브리핑이 통째로 침묵했다)

test('급한 게 하나도 없으면 손에 든 할 일을 대신 말한다', () => {
  assert.deepEqual(briefingLines({ open_todo: 7, oldest_todo_days: 5 }), [
    '할 일 7건 (가장 오래된 건 5일째)',
  ]);
});

test('오늘내일 담은 것에는 날짜를 붙이지 않는다', () => {
  assert.deepEqual(briefingLines({ open_todo: 2, oldest_todo_days: 1 }), ['할 일 2건']);
  assert.deepEqual(briefingLines({ open_todo: 1, oldest_todo_days: 0 }), ['할 일 1건']);
});

test('급한 게 있으면 할 일 총계는 빠진다 — 지연은 이미 그 안에 있다', () => {
  assert.deepEqual(briefingLines({ overdue: 2, open_todo: 7, oldest_todo_days: 9 }), ['지연 2건']);
});

test('할 일이 0건이면 여전히 조용하다', () => {
  assert.deepEqual(briefingLines({ open_todo: 0, oldest_todo_days: 0 }), []);
});

test('지난주 리뷰는 맨 뒤에 한 마디로 붙는다', () => {
  assert.deepEqual(briefingLines({ overdue: 1 }, { review: 'ready' }), [
    '지연 1건',
    '지난주 리뷰 준비됨',
  ]);
  assert.deepEqual(briefingLines({}, { review: 'pending' }), ['지난주 리뷰 아직']);
});

// ── reviewDue — 주가 끝난 뒤에 다시 만든다

const END = new Date(2026, 7, 10); // 32주의 상한 = 8/10(월) 0시
const mon = (h = 9) => new Date(2026, 7, 10, h);

test('주가 끝났는데 리뷰가 없으면 만든다', () => {
  assert.equal(reviewDue({ now: mon(), weekEnd: END }), true);
});

test('그 주가 끝나기 전에 만든 초안은 낡은 것으로 본다', () => {
  // 실제로 32주 리뷰가 8/5(수)에 만들어진 채 주가 끝나도 그대로였다
  assert.equal(reviewDue({ now: mon(), weekEnd: END, generatedAt: new Date(2026, 7, 5, 17) }), true);
});

test('주가 끝난 뒤에 만든 것은 그대로 둔다', () => {
  assert.equal(reviewDue({ now: mon(11), weekEnd: END, generatedAt: mon(10) }), false);
});

test('아직 끝나지 않은 주는 건드리지 않는다', () => {
  assert.equal(reviewDue({ now: new Date(2026, 7, 9, 23), weekEnd: END }), false);
});

test('월요일 이른 시각에도 지난주는 이미 끝나 있다', () => {
  // weekEnd가 자정으로 정규화되지 않으면 월요일 오전 내내 막힌다
  assert.equal(reviewDue({ now: mon(0), weekEnd: END }), true);
});

test('실패한 날은 더 두드리지 않는다 — AI 호출이 붙어 있다', () => {
  const now = mon();
  assert.equal(reviewDue({ now, weekEnd: END, lastTry: dayKey(now) }), false);
  assert.equal(reviewDue({ now, weekEnd: END, lastTry: '2026-08-09' }), true);
});

test('값이 깨졌으면 다시 만드는 쪽으로, 어느 주인지 모르면 손대지 않는다', () => {
  assert.equal(reviewDue({ now: mon(), weekEnd: END, generatedAt: '뭐라고?' }), true);
  assert.equal(reviewDue({ now: mon(), weekEnd: null }), false);
  assert.equal(reviewDue({ now: mon(), weekEnd: '뭐라고?' }), false);
});

// ── 손 입력을 요구하지 않는 것들 (이슈 · 끝내지 않고 둔 자리)
test('급한 것이 없으면 지금 손대는 프로젝트의 이슈를 말한다', () => {
  const lines = briefingLines({ active_issues: 3, active_issue_projects: 'sj·co' });
  assert.deepEqual(lines, ['sj·co 이슈 3건']);
});

test('할 일과 이슈는 나란히 선다', () => {
  const lines = briefingLines({
    open_todo: 6, oldest_todo_days: 5, active_issues: 3, active_issue_projects: 'sj·co',
  });
  assert.deepEqual(lines, ['할 일 6건 (가장 오래된 건 5일째)', 'sj·co 이슈 3건']);
});

test('급한 것이 있는 날에는 이슈를 붙이지 않는다', () => {
  // 그날은 이미 할 말이 있다 — 다 붙이면 알림 한 줄이 읽히지 않는다
  const lines = briefingLines({ overdue: 2, active_issues: 3, active_issue_projects: 'sj', stale_repos: 1 });
  assert.deepEqual(lines, ['지연 2건']);
});

test('끝내지 않고 둔 자리는 가장 오래된 하나만 말하고 나머지는 곳 수로 줄인다', () => {
  assert.deepEqual(
    briefingLines({ stale_repos: 1, stale_repo_label: 'gw stash 1건', oldest_repo_days: 11 }),
    ['gw stash 1건 (11일째)']
  );
  assert.deepEqual(
    briefingLines({ stale_repos: 3, stale_repo_label: 'gw stash 1건', oldest_repo_days: 11 }),
    ['gw stash 1건 (11일째) 외 2곳']
  );
});

test('막 생긴 자리에는 날짜를 붙이지 않는다', () => {
  // 어제 둔 작업본에까지 "1일째"를 붙이면 잔소리가 된다
  assert.deepEqual(
    briefingLines({ stale_repos: 1, stale_repo_label: 'ww 작업본 4개', oldest_repo_days: 0 }),
    ['ww 작업본 4개']
  );
});

test('아무것도 없으면 여전히 조용하다', () => {
  assert.deepEqual(briefingLines({ active_issues: 0, stale_repos: 0 }), []);
});
