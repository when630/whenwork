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

// 어떤 커밋을 "내가 한 일"로 볼지 정하는 규칙 (오픈이슈 #2).
//
// auto-worklog(`worklog-common.ps1`)와 같은 커밋을 세야 한다 — 같은 주를 주간 리뷰와 일일
// 업무일지가 다르게 세면 회고가 어긋난다. 갈리던 것은 `--all` 하나였다: 없으면 체크아웃한
// 브랜치의 조상만 세므로 **아직 머지하지 않은 브랜치의 작업이 빠진다**(실측 gowrite 241 vs 242).
// 저자는 이름을 코드에 박지 않고 리포의 user.email로 거른다(회사 리포에는 남의 커밋도 있다) —
// 설정이 없으면 거르지 않는다. auto-worklog가 쓰는 이름 정규식보다 이쪽이 견고하다.
export function logArgs(email) {
  return [
    'log',
    '--all',
    '--no-merges',
    `--since=${SINCE}`,
    ...(email ? [`--author=${email}`] : []),
    `--pretty=%H${SEP}%aI${SEP}%s`,
  ];
}

async function scanRepo(repoPath) {
  const email = (await git(['config', 'user.email'], repoPath).catch(() => '')).trim();
  const out = await git(logArgs(email), repoPath);
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
