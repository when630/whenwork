import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeWeekly, weeklyPath, guessVaultRoot } from '../main/vault.mjs';

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
