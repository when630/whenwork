// 리포에 "끝내지 않고 둔 자리" — 라벨은 순수 함수라 그대로 보고,
// 스캔은 임시 리포를 실제로 만들어 git에게 물어본다(형식이 바뀌면 여기서 걸린다).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { repoStateLabel, scanRepoState, nextSince, isUnclean, STALE_REPO_DAYS } from '../main/repo.mjs';

test('라벨은 급한 순서로 이어 붙인다', () => {
  assert.equal(repoStateLabel({ stash_count: 2, dirty: 3, ahead: 1 }), 'stash 2건 · 작업본 3개 · 안 올린 커밋 1건');
  assert.equal(repoStateLabel({ dirty: 3 }), '작업본 3개');
  assert.equal(repoStateLabel({ stash_count: 1 }), 'stash 1건');
});

test('둔 자리가 없으면 라벨도 비어 있다', () => {
  // 빈 문자열이어야 화면·브리핑이 "말할 것 없음"으로 읽는다
  assert.equal(repoStateLabel({}), '');
  assert.equal(repoStateLabel({ dirty: 0, ahead: 0, stash_count: 0 }), '');
});

test('경계는 사흘 — 어제 만든 stash는 아직 작업 중인 자리다', () => {
  assert.equal(STALE_REPO_DAYS, 3);
});

// ── 실제 git으로 확인
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-r-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', '테스트');
  fs.writeFileSync(path.join(dir, 'a.txt'), '처음\n');
  git('add', '.');
  git('commit', '-q', '-m', '첫 커밋');
  return { dir, git };
}

test('깨끗한 리포는 아무것도 남기지 않는다', async () => {
  const { dir } = tmpRepo();
  const s = await scanRepoState(dir);
  assert.equal(s.dirty, 0);
  assert.equal(s.stash_count, 0);
  assert.equal(s.ahead, 0); // upstream이 없으면 "안 올렸다"고 말할 수 없다
  assert.equal(s.branch, 'main');
  assert.equal(repoStateLabel(s), '');
});

test('손대다 만 작업본을 센다', async () => {
  const { dir } = tmpRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), '고침\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), '새 파일\n');
  const s = await scanRepoState(dir);
  assert.equal(s.dirty, 2); // 추적 중인 것과 아닌 것 둘 다
  assert.equal(repoStateLabel(s), '작업본 2개');
});

test('stash는 개수와 만든 시각·이름을 함께 남긴다', async () => {
  const { dir, git } = tmpRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), '치우는 중\n');
  git('stash', 'push', '-m', '나중에');
  const s = await scanRepoState(dir);
  assert.equal(s.stash_count, 1);
  assert.equal(s.dirty, 0); // stash로 치웠으니 작업본은 없다
  assert.ok(s.stash_label.includes('나중에'));
  assert.ok(Date.now() - new Date(s.stash_at).getTime() < 60_000);
});

test('stash가 여럿이면 가장 오래된 것을 기준으로 삼는다', async () => {
  // 며칠 묵었는지를 재는 자리라 최근 것이 아니라 오래된 것이 기준이어야 한다
  const { dir, git } = tmpRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), '첫 번째\n');
  git('stash', 'push', '-m', '먼저 둔 것');
  fs.writeFileSync(path.join(dir, 'a.txt'), '두 번째\n');
  git('stash', 'push', '-m', '나중에 둔 것');
  const s = await scanRepoState(dir);
  assert.equal(s.stash_count, 2);
  assert.ok(s.stash_label.includes('먼저 둔 것'));
});

test('git 리포가 아니면 조용히 물러난다', async () => {
  // 수집은 부가 레이어다 — 리포 하나가 없어져도 나머지 수집이 멈추면 안 된다
  assert.equal(await scanRepoState(fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-x-'))), null);
  assert.equal(await scanRepoState(path.join(os.tmpdir(), '없는-경로-12345')), null);
});

// ── "언제부터 이러고 있었나"의 시계
const T0 = new Date(2026, 7, 5, 10, 0);
const T1 = new Date(2026, 7, 9, 10, 0);

test('깨끗해지면 시계를 지운다', () => {
  // 다음에 다시 지저분해지면 그날부터 다시 세야 한다
  assert.equal(nextSince({ dirty: 3, since: T0 }, { dirty: 0 }, T1), null);
  assert.equal(nextSince(null, {}, T1), null);
});

test('막 지저분해졌으면 지금부터 센다', () => {
  assert.equal(nextSince(null, { dirty: 1 }, T1), T1);
  assert.equal(nextSince({ dirty: 0, ahead: 0, stash_count: 0, since: null }, { dirty: 1 }, T1), T1);
});

test('이어지고 있으면 먼젓번 시각을 물려준다', () => {
  // 스캔할 때마다 새로 찍으면 사흘째 방치한 것도 늘 "오늘"이 된다
  assert.equal(nextSince({ dirty: 3, since: T0 }, { dirty: 5 }, T1), T0);
  assert.equal(nextSince({ stash_count: 1, since: T0 }, { dirty: 2 }, T1), T0); // 종류가 바뀌어도 이어진 것
});

test('이어지는데 시계가 없으면 지금부터 센다', () => {
  // 컬럼을 나중에 붙였을 때 — 값이 없다고 영영 못 세면 안 된다
  assert.equal(nextSince({ dirty: 3, since: null }, { dirty: 3 }, T1), T1);
});

test('셋 중 무엇이든 있으면 지저분한 것이다', () => {
  assert.equal(isUnclean({ dirty: 1 }), true);
  assert.equal(isUnclean({ ahead: 1 }), true);
  assert.equal(isUnclean({ stash_count: 1 }), true);
  assert.equal(isUnclean({ dirty: 0, ahead: 0, stash_count: 0 }), false);
  assert.equal(isUnclean(null), false);
});
