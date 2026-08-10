// 리포에 "끝내지 않고 둔 자리"를 읽는다 — 커밋(activity)이 *한 일*이라면 이쪽은 *덜 한 일*이다.
//
// 실사용에서 손 캡처가 마르는 동안에도 커밋은 매일 수십 건씩 났다. 사람이 적지 않아도
// 이미 존재하는 할 일을 앱이 스스로 찾아내자는 게 이 파일의 목적이고, 여기서 보는 것은 셋이다:
//   ① 작업본(uncommitted) ② stash ③ 안 올린 커밋(ahead)
//
// **커밋 이력은 보지 않는다.** "커밋했는데 안 닫힌 이슈"를 찾아보려 했지만 실측에서 0건이었다 —
// 최근 7일 커밋이 참조한 번호와 열린 이슈 번호가 하나도 겹치지 않았다(이슈를 잘 닫는 사람이다).
// 없는 신호를 화면에 세우면 빈칸만 남으므로 그 축은 버렸다.
import { execFile } from 'node:child_process';

// stash가 며칠 묵어야 말을 거는가. 어제 만든 stash는 아직 작업 중인 자리다.
export const STALE_REPO_DAYS = 3;

function git(args, cwd, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

// 한 줄 요약. 화면·브리핑이 같은 말을 쓰도록 여기 한 곳에서만 만든다.
// 순서는 급한 순 — stash는 잊히고, 작업본은 눈앞에 있고, 안 올린 커밋은 남이 못 본다.
export function repoStateLabel(r = {}) {
  const parts = [];
  if (r.stash_count > 0) parts.push(`stash ${r.stash_count}건`);
  if (r.dirty > 0) parts.push(`작업본 ${r.dirty}개`);
  if (r.ahead > 0) parts.push(`안 올린 커밋 ${r.ahead}건`);
  return parts.join(' · ');
}

export function isUnclean(s) {
  return (s?.dirty ?? 0) > 0 || (s?.ahead ?? 0) > 0 || (s?.stash_count ?? 0) > 0;
}

// "언제부터 이러고 있었나"의 시계. 스캔할 때마다 새로 찍으면 며칠째인지를 셀 수 없어
// 지금 손대는 중인 작업본과 사흘째 방치한 것이 같아 보인다(실측에서 그 둘이 섞였다).
//   깨끗해졌으면 시계를 지운다 — 다음에 다시 지저분해지면 그날부터 다시 센다.
//   이어지고 있으면 먼젓번 시각을 그대로 물려준다.
export function nextSince(prev, next, now = new Date()) {
  if (!isUnclean(next)) return null;
  if (!prev || !isUnclean(prev)) return now;
  return prev.since ?? now;
}

// 리포 하나의 지금 상태. 실패하면 null — 수집은 부가 레이어라 한 리포가 죽어도 멈추지 않는다.
export async function scanRepoState(repoPath) {
  try {
    const [status, stash, branch] = await Promise.all([
      git(['status', '--porcelain=v1'], repoPath),
      // %ct는 초 단위 epoch. 가장 최근 stash가 첫 줄이므로 **마지막 줄**이 가장 오래된 것이다.
      git(['stash', 'list', '--format=%ct%x1f%gs'], repoPath),
      git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath),
    ]);
    const stashes = stash.split('\n').filter((l) => l.includes('\x1f'));
    const oldest = stashes[stashes.length - 1]?.split('\x1f') ?? null;
    // upstream이 없으면 "안 올렸다"고 말할 수 없다 — 올릴 곳이 없는 브랜치다
    const ahead = await git(['rev-list', '--count', '@{upstream}..HEAD'], repoPath).catch(() => '0');
    return {
      repo_path: repoPath,
      branch: branch.trim() || null,
      dirty: status.split('\n').filter((l) => l.trim()).length,
      ahead: Number(ahead.trim()) || 0,
      stash_count: stashes.length,
      stash_at: oldest ? new Date(Number(oldest[0]) * 1000).toISOString() : null,
      stash_label: oldest ? oldest[1].slice(0, 200) : null,
    };
  } catch {
    return null; // 리포가 없거나 git이 아니다
  }
}

export async function collectRepoStates(db, project) {
  const states = [];
  for (const repo of project.repo_paths ?? []) {
    const s = await scanRepoState(repo);
    if (s) states.push(s);
  }
  await db.saveRepoStates(project.id, states);
  return states.length;
}
