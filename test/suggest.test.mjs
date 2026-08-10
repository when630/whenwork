import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDoneSuggestPrompt, parseDoneSuggestions } from '../main/ai.mjs';

// ── 완료 제안 (12.11) — 프롬프트가 근거를 다 실었는지, 모델이 지어낸 것이 걸러지는지.
// 실제 claude -p 호출은 여기서 검증하지 않는다(구독 한도) — 경계의 순수 로직만 본다.

const TODOS = [
  { id: 'a1', title: '웹훅 점검', project: 'sj', project_id: 2 },
  { id: 'b2', title: '조직도', project: 'sj', project_id: 2 },
];

const EVIDENCE = {
  commits: [
    { project_id: 2, project: 'sj', summary: '웹훅 재시도 추가', occurred_at: '2026-08-09T14:00:00+09:00' },
  ],
  closedIssues: [
    { project_id: 2, project: 'sj', kind: 'issue', number: 38, title: '웹훅 죽음', state: 'closed' },
  ],
};

test('프롬프트에 할 일·커밋·닫힌 이슈가 전부 실린다', () => {
  const p = buildDoneSuggestPrompt(TODOS, EVIDENCE);
  assert.match(p, /id=a1 \[sj\] 웹훅 점검/);
  assert.match(p, /웹훅 재시도 추가/);
  assert.match(p, /#38 웹훅 죽음 \(closed\)/);
  // 보수적으로 고르라는 지침 — 틀린 제안이 빈 제안보다 나쁘다 (인박스 분류와 같은 규칙)
  assert.match(p, /틀린 제안이 빈 제안보다 나쁘다/);
  assert.match(p, /JSON만 출력/);
});

test('근거가 없으면 없다고 적는다 — 빈 절을 지어내게 두지 않는다', () => {
  const p = buildDoneSuggestPrompt(TODOS, { commits: [], closedIssues: [] });
  assert.match(p, /## 최근 커밋\n- \(없음\)/);
  assert.match(p, /## 최근 닫힌 이슈·PR\n- \(없음\)/);
});

test('모델이 없는 id를 지어내도 DB에 닿지 않는다', () => {
  const out = parseDoneSuggestions(
    { done: [{ id: 'a1', why: '8/9 커밋 "웹훅 재시도 추가"' }, { id: '유령', why: 'x' }] },
    TODOS
  );
  assert.deepEqual(out.map((d) => d.id), ['a1']);
});

test('근거 없는 제안·깨진 응답은 버린다', () => {
  // why가 비면 화면에 세울 말이 없다 — 근거를 못 대는 제안은 제안이 아니다
  assert.deepEqual(parseDoneSuggestions({ done: [{ id: 'a1', why: '' }] }, TODOS), []);
  assert.deepEqual(parseDoneSuggestions({ done: '뭐라고?' }, TODOS), []);
  assert.deepEqual(parseDoneSuggestions({}, TODOS), []);
  assert.deepEqual(parseDoneSuggestions(null, TODOS), []);
});

test('why는 80자에서 자른다 — 제안 줄은 한 구절이다', () => {
  const out = parseDoneSuggestions({ done: [{ id: 'a1', why: 'x'.repeat(200) }] }, TODOS);
  assert.equal(out[0].why.length, 80);
});
