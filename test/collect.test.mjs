// git 수집 규칙 — auto-worklog와 같은 커밋을 세는지(오픈이슈 #2)를 인자로 확인한다.
// 실제 리포를 스캔하지 않는 이유는 이 규칙이 "무엇을 세는지"의 선언이고, 어긋나면
// 주간 리뷰와 일일 업무일지가 같은 주를 다르게 세기 때문이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logArgs } from '../main/collect.mjs';

test('브랜치를 가리지 않는다 — --all이 빠지면 머지 전 작업이 누락된다', () => {
  assert.ok(logArgs('me@example.com').includes('--all'));
});

test('머지 커밋은 세지 않고 최근 14일만 본다', () => {
  const args = logArgs('me@example.com');
  assert.ok(args.includes('--no-merges'));
  assert.ok(args.includes('--since=14 days'));
});

test('저자는 리포의 user.email로 거른다', () => {
  assert.ok(logArgs('me@example.com').includes('--author=me@example.com'));
});

test('user.email이 없으면 거르지 않는다 (그 리포는 내 것뿐이라고 본다)', () => {
  assert.ok(!logArgs('').some((a) => a.startsWith('--author')));
  assert.ok(!logArgs().some((a) => a.startsWith('--author')));
});

test('sha·시각·제목을 구분자로 뽑는다 (커밋 메시지에 나올 수 없는 문자)', () => {
  const pretty = logArgs('me@example.com').find((a) => a.startsWith('--pretty='));
  assert.match(pretty, /%H/);
  assert.match(pretty, /%aI/);
  assert.match(pretty, /%s/);
  assert.match(pretty, /\x1f/);
});
