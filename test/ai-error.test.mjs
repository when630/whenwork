import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyError } from '../main/ai.mjs';

// CLI는 API 오류를 stdout에 찍고 코드 1로 끝난다 — 그 문장을 사람이 읽을 말로 바꾼다
test('529는 서버 혼잡으로 안내한다', () => {
  const msg = friendlyError('API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.');
  assert.match(msg, /혼잡/);
  assert.match(msg, /529/);
});

test('사용량 한도', () => {
  assert.match(friendlyError('Claude usage limit reached'), /한도/);
});

test('로그인 필요', () => {
  assert.match(friendlyError('Error: Not logged in'), /로그인/);
});

test('모르는 오류는 첫 줄만 잘라 그대로', () => {
  assert.equal(friendlyError('something odd happened\nsecond line'), 'something odd happened');
});

test('빈 문자열은 null', () => {
  assert.equal(friendlyError('   '), null);
});
