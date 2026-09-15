import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCapture, parseDue, isoWeek, weekRange } from '../main/parse.mjs';

// ── 캡처 제목
//
// #약어를 걷어낸 뒤로 이 함수가 하는 일은 다듬기뿐이다. 그래서 여기서 지키는 것은
// **아무것도 떼어내지 않는다**는 것이다 — 예전에는 `#`가 토큰이라 "#201 이슈 확인"이
// "이슈 확인"이 되어, 어느 프로젝트도 아닌 약어일 때만 원문이 되살아났다.
test('앞뒤 공백만 다듬고 나머지는 그대로 둔다', () => {
  assert.equal(parseCapture('  웹훅 재시도 답장  '), '웹훅 재시도 답장');
});

test('#는 그냥 글자다 — 어디에 있어도 떼어내지 않는다', () => {
  assert.equal(parseCapture('#201 이슈 확인하기'), '#201 이슈 확인하기');
  assert.equal(parseCapture('이슈 #201 확인하기'), '이슈 #201 확인하기');
  assert.equal(parseCapture('웹훅 재시도 답장 #ef'), '웹훅 재시도 답장 #ef');
  assert.equal(parseCapture('#gw'), '#gw');
});

test('빈 입력과 없는 값은 빈 문자열 — 호출부가 이것으로 저장을 막는다', () => {
  assert.equal(parseCapture(''), '');
  assert.equal(parseCapture('   '), '');
  assert.equal(parseCapture(null), '');
  assert.equal(parseCapture(undefined), '');
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
