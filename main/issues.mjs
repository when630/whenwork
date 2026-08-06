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
    authored.map((i) => norm('github', 'issue', i.number, i)),
    assigned.map((i) => norm('github', 'issue', i.number, i))
  );
}

// ── GitHub PR. `gh issue list`는 PR을 포함하지 않으므로 따로 긁는다.
// 리뷰 요청받은 PR은 남을 막고 있는 일이라 재개 판단에 이슈보다 직접적이다.
async function githubPulls(repoPath) {
  const fields = 'number,title,state,updatedAt,url,isDraft';
  const base = ['pr', 'list', '--state', 'all', '--limit', '30', '--json', fields];
  const authored = JSON.parse(await run('gh', [...base, '--author', '@me'], repoPath));
  const toReview = JSON.parse(
    await run('gh', [...base, '--search', 'review-requested:@me'], repoPath)
  );
  const mine = authored.map((p) => norm('github', 'pr', p.number, p));
  const theirs = toReview.map((p) => ({ ...norm('github', 'pr', p.number, p), relation: 'reviewer' }));
  // 내가 쓴 PR이 우선 — 내 PR에 내가 리뷰어로 붙는 경우는 없다
  const map = new Map();
  for (const p of theirs) map.set(p.number, p);
  for (const p of mine) map.set(p.number, { ...p, relation: 'author' });
  return [...map.values()];
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
    authored.map((i) => norm('gitlab', 'issue', i.iid, i)),
    assigned.map((i) => norm('gitlab', 'issue', i.iid, i))
  );
}

// ── GitLab MR — 작성한 것과 내 리뷰를 기다리는 것
async function gitlabMRs(repoPath, host) {
  const me = await glabUser(repoPath, host);
  const base = ['mr', 'list', '--all', '--output', 'json', '--per-page', '30'];
  const authored = JSON.parse(await run('glab', [...base, `--author=${me}`], repoPath));
  const toReview = JSON.parse(await run('glab', [...base, `--reviewer=${me}`], repoPath));
  const map = new Map();
  for (const m of toReview) map.set(m.iid, { ...norm('gitlab', 'pr', m.iid, m), relation: 'reviewer' });
  for (const m of authored) map.set(m.iid, { ...norm('gitlab', 'pr', m.iid, m), relation: 'author' });
  return [...map.values()];
}

function norm(provider, kind, number, raw) {
  const state = String(raw.state ?? '').toLowerCase();
  return {
    provider,
    kind,
    number,
    title: raw.title,
    // gh는 OPEN/CLOSED/MERGED, glab은 opened/closed/merged — open/merged/closed로 통일한다.
    // 머지된 PR은 닫힌 것과 성격이 달라(그 작업이 끝났다는 신호) 구분해 남긴다.
    state: state.startsWith('open') ? 'open' : state === 'merged' ? 'merged' : 'closed',
    url: raw.url ?? raw.web_url,
    draft: Boolean(raw.isDraft ?? raw.draft ?? raw.work_in_progress ?? false),
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

// 이슈와 PR은 따로 조회한다 — 한쪽이 실패해도 다른 쪽은 살려야 하므로 개별로 감싼다.
async function safely(fn) {
  try {
    return await fn();
  } catch {
    return []; // 인증 불일치·네트워크 실패 — 캐시가 남아 있으니 UI는 마지막 동기화를 보여준다
  }
}

export async function syncProjectIssues(db, project) {
  let n = 0;
  for (const repo of project.repo_paths ?? []) {
    try {
      const url = await remoteUrl(repo);
      if (!url) continue;
      let rows = null;
      if (url.includes('github.com')) {
        rows = [...(await safely(() => githubIssues(repo))), ...(await safely(() => githubPulls(repo)))];
      } else if (/gitlab|lab\./.test(url)) {
        const host = new URL(url).host;
        rows = [
          ...(await safely(() => gitlabIssues(repo, host))),
          ...(await safely(() => gitlabMRs(repo, host))),
        ];
      }
      if (rows?.length) {
        await db.upsertIssues(project.id, rows);
        n += rows.length;
      }
    } catch {
      // 리모트를 못 읽는 등 리포 단위 실패 — 다른 리포는 계속 긁는다
    }
  }
  return n;
}
