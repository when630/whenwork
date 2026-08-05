// git 수집기 (M2) — 프로젝트 repo_paths에서 내 커밋을 activity로 적재한다.
// "한 일"은 자동 수집이 원칙(설계 2절). 실패한 리포는 건너뛴다 — 수집은 부가 레이어다.
import { execFile } from 'node:child_process';

const SINCE = '14 days';
const SEP = '\x1f'; // 커밋 메시지에 나올 수 없는 구분자

function git(args, cwd, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

// 리포 하나에서 내 커밋만 — 회사 리포에는 남의 커밋도 있으므로 리포의 user.email로 거른다
async function scanRepo(repoPath) {
  const email = (await git(['config', 'user.email'], repoPath).catch(() => '')).trim();
  const args = ['log', `--since=${SINCE}`, '--no-merges', `--pretty=%H${SEP}%aI${SEP}%s`];
  if (email) args.splice(1, 0, `--author=${email}`);
  const out = await git(args, repoPath);
  return out
    .split('\n')
    .filter((l) => l.includes(SEP))
    .map((l) => {
      const [sha, date, subject] = l.split(SEP);
      return { ref: sha.slice(0, 12), occurred_at: date, summary: subject };
    });
}

export async function collectProject(db, project) {
  let n = 0;
  for (const repo of project.repo_paths ?? []) {
    try {
      const rows = await scanRepo(repo);
      await db.insertActivities(project.id, rows);
      n += rows.length;
    } catch {
      // 리포가 없거나 git이 아니면 조용히 — 다른 리포·프로젝트 수집은 계속
    }
  }
  return n;
}

export async function collectAll(db) {
  const projects = await db.getProjects();
  for (const p of projects) await collectProject(db, p);
}
