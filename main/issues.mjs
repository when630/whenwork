// GH/GL 이슈 동기화 (D7) — 내가 작성했거나 할당된 이슈를 읽기 전용 캐시로.
// 조회는 gh/glab CLI 인증을 그대로 재사용하고, 리포 디렉터리에서 실행해 리모트를 CLI가 알아내게 한다.
// 계정 불일치(gh 다중 계정, 오픈이슈 #5) 등으로 실패한 리포는 조용히 건너뛴다.
import { execFile } from 'node:child_process';

function run(cmd, args, cwd, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function remoteUrl(repoPath) {
  return (await run('git', ['remote', 'get-url', 'origin'], repoPath).catch(() => '')).trim();
}

// ── GitHub: gh issue list --json (author/assignee 두 번 조회해 relation을 합친다)
async function githubIssues(repoPath) {
  const fields = 'number,title,state,updatedAt,url';
  const base = ['issue', 'list', '--state', 'all', '--limit', '30', '--json', fields];
  const authored = JSON.parse(await run('gh', [...base, '--author', '@me'], repoPath));
  const assigned = JSON.parse(await run('gh', [...base, '--assignee', '@me'], repoPath));
  return merge(
    authored.map((i) => norm('github', i.number, i)),
    assigned.map((i) => norm('github', i.number, i))
  );
}

// ── GitLab(셀프호스트 포함): glab. 사용자명은 리포 컨텍스트의 api user로 알아내 캐시한다.
const glabUserCache = new Map(); // host → username
async function glabUser(repoPath, host) {
  if (glabUserCache.has(host)) return glabUserCache.get(host);
  const me = JSON.parse(await run('glab', ['api', 'user'], repoPath));
  glabUserCache.set(host, me.username);
  return me.username;
}

async function gitlabIssues(repoPath, host) {
  const me = await glabUser(repoPath, host);
  const base = ['issue', 'list', '--all', '--output', 'json', '--per-page', '30'];
  const authored = JSON.parse(await run('glab', [...base, `--author=${me}`], repoPath));
  const assigned = JSON.parse(await run('glab', [...base, `--assignee=${me}`], repoPath));
  return merge(
    authored.map((i) => norm('gitlab', i.iid, i)),
    assigned.map((i) => norm('gitlab', i.iid, i))
  );
}

function norm(provider, number, raw) {
  return {
    provider,
    number,
    title: raw.title,
    // gh는 OPEN/CLOSED, glab은 opened/closed — 저장은 open/closed로 통일
    state: String(raw.state).toLowerCase().startsWith('open') ? 'open' : 'closed',
    url: raw.url ?? raw.web_url,
    updated_at: raw.updatedAt ?? raw.updated_at,
  };
}

function merge(authored, assigned) {
  const map = new Map();
  for (const i of authored) map.set(i.number, { ...i, relation: 'author' });
  for (const i of assigned) {
    const prev = map.get(i.number);
    map.set(i.number, { ...i, relation: prev ? 'both' : 'assignee' });
  }
  return [...map.values()];
}

export async function syncProjectIssues(db, project) {
  let n = 0;
  for (const repo of project.repo_paths ?? []) {
    try {
      const url = await remoteUrl(repo);
      if (!url) continue;
      let issues = null;
      if (url.includes('github.com')) issues = await githubIssues(repo);
      else if (/gitlab|lab\./.test(url)) issues = await gitlabIssues(repo, new URL(url).host);
      if (issues) {
        await db.upsertIssues(project.id, issues);
        n += issues.length;
      }
    } catch {
      // 인증 불일치·네트워크 실패 — 캐시가 남아 있으니 UI는 마지막 동기화를 보여준다
    }
  }
  return n;
}
