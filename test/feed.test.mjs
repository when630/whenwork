import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 업데이트·받기 주소(D-P31) — 코드 리포(when630/whenwork)를 비공개로 돌린 뒤에도 설치본이 새 버전을 보려면
// 앱과 사이트와 릴리스 복사 스크립트가 모두 같은 공개 리포를 가리켜야 한다.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('업데이트·받기는 공개 릴리스 리포를 본다 — 코드 리포는 비공개', async () => {
  assert.deepEqual(pkg.build.publish, [{ provider: 'github', owner: 'when630', repo: 'whenwork-releases' }]);
  const upd = fs.readFileSync(path.join(ROOT, 'main', 'update.mjs'), 'utf8');
  assert.ok(upd.includes("const RELEASES_URL = 'https://github.com/when630/whenwork-releases/releases/latest';"));
  const { SOURCE, TARGET } = await import('../tools/mirror-release.mjs');
  assert.equal(TARGET, `${pkg.build.publish[0].owner}/${pkg.build.publish[0].repo}`, '옮기는 곳 = 앱이 보는 곳');
  assert.equal(SOURCE, 'when630/whenwork');
});
