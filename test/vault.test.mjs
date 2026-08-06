import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeWeekly, weeklyPath, guessVaultRoot, statsLine } from '../main/vault.mjs';

const week = { year: 2026, week: 32 };
const range = { label: '2026-08-03 ~ 2026-08-09' };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-v-'));
}

test('경로는 월 폴더 아래 주간리뷰 파일', () => {
  const p = weeklyPath('/vault', new Date(2026, 7, 5), week);
  assert.equal(p.replace(/\\/g, '/'), '/vault/00_업무일지/2026년/08월/00_주간리뷰_2026-W32.md');
});

test('없던 파일은 프론트매터와 함께 새로 만든다', () => {
  const file = path.join(tmpDir(), 'w.md');
  writeWeekly(file, '## 이번 주 흐름\n초안 본문', { week, range });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^---\ntitle: 주간 리뷰 2026-W32/);
  assert.match(text, /type\/review/);
  assert.match(text, /초안 본문/);
});

test('다시 생성하면 마커 안쪽만 바뀌고 사람이 쓴 부분은 남는다', () => {
  const file = path.join(tmpDir(), 'w.md');
  writeWeekly(file, '첫 번째 초안', { week, range });
  fs.appendFileSync(file, '\n## 내 메모\n직접 적은 내용\n', 'utf8');

  writeWeekly(file, '두 번째 초안', { week, range });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /두 번째 초안/);
  assert.doesNotMatch(text, /첫 번째 초안/);
  assert.match(text, /직접 적은 내용/); // 사람 글은 보존
  assert.equal(text.match(/AUTO:WEEKLY:START/g).length, 1);
});

// ── 볼트 자동 탐색 (경로를 코드에 박지 않기 위한 것)
// 실제 디스크를 훑지 않도록 readdir을 주입해 트리를 흉내낸다.
function fakeTree(tree) {
  return (dir) => tree[dir.replace(/\\/g, '/')] ?? [];
}

test('홈 아래 두 단계까지 내려가 00_업무일지를 가진 폴더를 찾는다', () => {
  const readdir = fakeTree({
    '/home': ['docs', 'work'],
    '/home/work': ['01_work'],
    '/home/work/01_work': ['00_업무일지', '10_문서'],
  });
  assert.equal(guessVaultRoot('/home', { readdir }).replace(/\\/g, '/'), '/home/work/01_work');
});

test('표식이 없으면 null', () => {
  const readdir = fakeTree({ '/home': ['docs'], '/home/docs': ['a'] });
  assert.equal(guessVaultRoot('/home', { readdir }), null);
});

test('깊이 제한을 넘어선 곳은 찾지 않는다', () => {
  const readdir = fakeTree({
    '/home': ['a'],
    '/home/a': ['b'],
    '/home/a/b': ['c'],
    '/home/a/b/c': ['00_업무일지'],
  });
  assert.equal(guessVaultRoot('/home', { readdir, depth: 2 }), null);
});

test('숨김·시스템 폴더는 훑지 않는다', () => {
  const seen = [];
  const readdir = (dir) => {
    seen.push(dir.replace(/\\/g, '/'));
    return { '/home': ['.git', '$Recycle', 'work'] }[dir.replace(/\\/g, '/')] ?? [];
  };
  guessVaultRoot('/home', { readdir });
  assert.ok(!seen.some((d) => d.includes('.git') || d.includes('$Recycle')));
  assert.ok(seen.includes('/home/work'));
});

test('마커 없는 기존 파일에는 아래에 덧붙인다', () => {
  const file = path.join(tmpDir(), 'w.md');
  fs.writeFileSync(file, '# 기존 문서\n원래 있던 내용\n', 'utf8');
  writeWeekly(file, '새 초안', { week, range });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /원래 있던 내용/);
  assert.match(text, /새 초안/);
});

// ── 주간 지표 한 줄 (사실 데이터라 AI를 거치지 않는다)
test('지표는 인용 한 줄로, 기본 셋은 0이어도 적는다', () => {
  const line = statsLine({ captured: 12, done: 7, commits: 41 });
  assert.equal(line, '> 캡처 12 · 완료 7 · 커밋 41');
  assert.equal(statsLine({}), '> 캡처 0 · 완료 0 · 커밋 0');
  assert.equal(statsLine(), '> 캡처 0 · 완료 0 · 커밋 0');
});

test('있을 때만 붙는 항목 — 열지 않은 카드·전환 없는 주는 적지 않는다', () => {
  const line = statsLine({ captured: 3, done: 2, commits: 9, resume_open: 5, switches: 2 });
  assert.match(line, /재개 카드 5회/);
  assert.match(line, /프로젝트 전환 2회/);
  assert.ok(!statsLine({ captured: 1, done: 1, commits: 1 }).includes('재개 카드'));
});

test('회의 시간은 30분 미만이면 생략하고 소수 한 자리로 적는다', () => {
  assert.match(statsLine({ meeting_hours: 3.46 }), /회의 3\.5시간/);
  // AI 호출은 구독 한도를 나눠 쓰므로 회고에 숫자로 남는다 (오픈이슈 #4)
  assert.match(statsLine({ ai_calls: 12 }), /AI 호출 12회/);
  assert.match(statsLine({ ai_calls: 12, ai_fails: 2 }), /AI 호출 12회 \(실패 2\)/);
  assert.ok(!statsLine({ ai_calls: 12 }).includes('실패')); // 실패 0은 붙이지 않는다
  assert.ok(!statsLine({}).includes('AI 호출'));
  assert.match(statsLine({ meeting_hours: 0.5 }), /회의 0\.5시간/);
  assert.ok(!statsLine({ meeting_hours: 0.2 }).includes('회의'));
  assert.ok(!statsLine({}).includes('회의'));
});
