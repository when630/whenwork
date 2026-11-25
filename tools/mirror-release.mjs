// 릴리스를 공개 리포(when630/whenwork-releases)로 옮긴다 — 코드 리포(when630/whenwork)는 비공개로 간다(D-P31).
//
//   node tools/mirror-release.mjs v0.4.3
//
// 원본 릴리스의 제목·안내문·파일(설치 파일, latest.yml·latest-mac.yml 포함)을 그대로 올리고 "최신"으로 둔다.
// 앱의 자동 업데이트(electron-updater)와 사이트 받기 버튼은 공개 리포를 본다 — latest*.yml이 빠지면
// 앱이 새 버전을 보지 못하므로, 올린 뒤 원본과 파일 목록이 같은지 확인한다.
// gh CLI 로그인(repo 권한)을 쓴다 — CI에 따로 토큰을 두지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SOURCE = 'when630/whenwork';
export const TARGET = 'when630/whenwork-releases';

const gh = (args, opts = {}) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
const json = (args) => JSON.parse(gh(args));

function main(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) throw new Error('사용법: node tools/mirror-release.mjs v0.4.3');
  const src = json(['release', 'view', tag, '--repo', SOURCE, '--json', 'name,body,isDraft,assets']);
  if (src.isDraft) throw new Error(`${SOURCE} ${tag}가 아직 드래프트입니다 — 안내문을 확인해 공개한 뒤 옮깁니다`);
  const names = src.assets.map((a) => a.name).sort();
  if (!names.includes('latest.yml') || !names.includes('latest-mac.yml')) throw new Error('latest.yml·latest-mac.yml이 없는 릴리스는 옮기지 않습니다(앱이 업데이트를 못 본다)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-mirror-'));
  try {
    gh(['release', 'download', tag, '--repo', SOURCE, '--dir', dir]);
    const notes = path.join(dir, '__notes.md');
    fs.writeFileSync(notes, src.body ?? '');
    const files = names.map((n) => path.join(dir, n));
    let exists = true;
    try {
      gh(['release', 'view', tag, '--repo', TARGET, '--json', 'tagName'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      exists = false;
    }
    if (exists) {
      gh(['release', 'upload', tag, ...files, '--repo', TARGET, '--clobber']);
      gh(['release', 'edit', tag, '--repo', TARGET, '--title', src.name, '--notes-file', notes, '--latest']);
    } else {
      gh(['release', 'create', tag, ...files, '--repo', TARGET, '--title', src.name, '--notes-file', notes, '--latest']);
    }
    const out = json(['release', 'view', tag, '--repo', TARGET, '--json', 'assets,isDraft,url']);
    const got = out.assets.map((a) => a.name).sort();
    if (out.isDraft || JSON.stringify(got) !== JSON.stringify(names)) throw new Error(`옮긴 파일이 다릅니다: ${got.join(', ')}`);
    console.log(`옮김: ${out.url} (${got.length}개 파일)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const self = fileURLToPath(import.meta.url); // 경로에 한글이 있으면 URL pathname은 %인코딩이라 비교가 어긋난다
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  try {
    main(process.argv[2]);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
