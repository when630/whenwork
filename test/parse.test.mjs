import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCaptureToken, parseDue, isoWeek, weekRange } from '../main/parse.mjs';

// ── #약어 토큰
test('끝에 붙은 #약어를 떼어낸다', () => {
  assert.deepEqual(parseCaptureToken('웹훅 재시도 답장 #ef'), { title: '웹훅 재시도 답장', abbr: 'ef' });
});

test('토큰이 없으면 제목 그대로', () => {
  assert.deepEqual(parseCaptureToken('그냥 할 일'), { title: '그냥 할 일', abbr: null });
});

test('앞에 붙은 #약어도 떼어낸다 — 손이 먼저 가는 자리가 앞이면 그쪽도 받는다', () => {
  assert.deepEqual(parseCaptureToken('#gw 오늘 할일'), { title: '오늘 할일', abbr: 'gw' });
});

// 앞을 열면 이 습관과 부딪힌다. 다만 어느 프로젝트도 아닌 토큰은 플러시 때 원문(raw)이
// 그대로 되살아나므로(insertCaptures) 제목을 잃지 않는다.
test('앞의 이슈 번호도 일단 토큰으로 본다 — 못 풀면 원문이 되살아난다', () => {
  assert.deepEqual(parseCaptureToken('#201 이슈 확인하기'), { title: '이슈 확인하기', abbr: '201' });
});

test('본문 중간의 #는 토큰이 아니다', () => {
  assert.deepEqual(parseCaptureToken('이슈 #201 확인하기'), { title: '이슈 #201 확인하기', abbr: null });
});

test('토큰만 입력하면 본문으로 둔다', () => {
  assert.deepEqual(parseCaptureToken('#gw'), { title: '#gw', abbr: null });
});

// ── 마감일
const NOW = new Date(2026, 7, 5); // 2026-08-05 (수)

test('빈 값은 마감 해제', () => {
  assert.deepEqual(parseDue('', NOW), { ok: true, value: null });
});

test('오늘·내일·모레', () => {
  assert.equal(parseDue('오늘', NOW).value, '2026-08-05');
  assert.equal(parseDue('내일', NOW).value, '2026-08-06');
  assert.equal(parseDue('모레', NOW).value, '2026-08-07');
});

test('+N / N일 상대 지정', () => {
  assert.equal(parseDue('+3', NOW).value, '2026-08-08');
  assert.equal(parseDue('10일', NOW).value, '2026-08-15');
});

test('M/D는 올해로, 이미 지났으면 내년으로', () => {
  assert.equal(parseDue('8/12', NOW).value, '2026-08-12');
  assert.equal(parseDue('1/5', NOW).value, '2027-01-05');
});

test('ISO 날짜', () => {
  assert.equal(parseDue('2026-12-31', NOW).value, '2026-12-31');
});

test('없는 날짜와 알 수 없는 말은 거절', () => {
  assert.equal(parseDue('2026-02-30', NOW).ok, false);
  assert.equal(parseDue('13/45', NOW).ok, false);
  assert.equal(parseDue('아무말', NOW).ok, false);
});

// ── 주차
test('ISO 주차와 주 범위(월~일)', () => {
  assert.deepEqual(isoWeek(NOW), { year: 2026, week: 32 });
  const { from, to } = weekRange(NOW);
  assert.equal(from.getDay(), 1); // 월요일 시작
  assert.equal(Math.round((to - from) / 86400000), 7);
});
