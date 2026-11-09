import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appxSquares, place } from '../tools/make-icon.mjs';

// Microsoft Store(MSIX) 빌드 설정이 조용히 어긋나는 자리를 지킨다(docs/07_Pro_설계.md D-P16).
// 어느 것이 틀려도 빌드는 성공하고 앱도 뜬다 — 사용자가 앱을 지우거나 재부팅해 봐야 드러난다.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const appx = pkg.build.appx;
const manifest = fs.readFileSync(path.join(ROOT, appx.customManifestPath), 'utf8');

test('스토어판 데이터는 가상화되지 않는다 — 앱을 지워도 할 일이 남는다', () => {
  // 기본값이면 새로 설치한 사람의 store.sqlite가 LocalCache에 쓰이고 제거와 함께 사라진다(실측)
  assert.match(manifest, /<desktop6:FileSystemWriteVirtualization>disabled<\/desktop6:FileSystemWriteVirtualization>/);
  assert.ok(appx.capabilities.includes('unvirtualizedResources'), '가상화를 끄려면 unvirtualizedResources가 필요하다');
  assert.ok(appx.capabilities.includes('runFullTrust'));
  // desktop6는 1809(17763)부터 — 그 아래를 허용하면 설치는 되는데 이 줄이 무시된다
  assert.ok(appx.minVersion >= '10.0.17763.0', `minVersion ${appx.minVersion}`);
});

test('딥링크 스킴은 package.json과 매니페스트가 같다', () => {
  const schemes = pkg.build.protocols.flatMap((p) => p.schemes);
  const declared = [...manifest.matchAll(/<uap:Protocol Name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(declared.sort(), schemes.sort());
});

test('로그인 시 자동 시작은 StartupTask로 선언된다', () => {
  // setLoginItemSettings는 패키지 안에서 효과가 없다 — 이게 없으면 스토어판은 재부팅 뒤 뜨지 않는다
  assert.match(manifest, /Category="windows\.startupTask"/);
  assert.match(manifest, /<desktop:StartupTask TaskId="\w+" Enabled="true"/);
});

test('매니페스트에는 electron-builder가 아는 매크로만 있다', () => {
  // 모르는 매크로는 빌드를 "Macro x is not defined"로 멈춘다 — 주석 안에 적어도 마찬가지다
  const known = new Set([
    'publisher', 'publisherDisplayName', 'version', 'applicationId', 'identityName', 'executable',
    'displayName', 'description', 'backgroundColor', 'logo', 'square150x150Logo', 'square44x44Logo',
    'lockScreen', 'defaultTile', 'splashScreen', 'arch', 'resourceLanguages', 'capabilities',
    'extensions', 'minVersion', 'maxVersionTested',
  ]);
  for (const m of manifest.matchAll(/\$\{([a-zA-Z0-9]+)\}/g)) assert.ok(known.has(m[1]), `모르는 매크로 ${m[1]}`);
  // 확장은 직접 적었다 — 자동 생성분까지 넣으면 프로토콜이 두 번 선언된다
  assert.ok(!manifest.includes('${extensions}'));
});

test('스토어 언어는 한국어다', () => {
  assert.deepEqual(appx.languages, ['ko-KR']);
});

test('스토어 타일 이미지를 전부 굽는다 — 빠지면 Electron 로고가 들어간다', () => {
  const names = appxSquares().map(([n]) => n);
  for (const need of ['StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png']) {
    assert.ok(names.includes(need), `${need}가 없다`);
  }
  // 작업 표시줄이 쓰는 크기별 이미지
  for (const t of [16, 24, 32, 48]) assert.ok(names.includes(`Square44x44Logo.targetsize-${t}_altform-unplated.png`));
  const sizes = Object.fromEntries(appxSquares());
  assert.equal(sizes['StoreLogo.png'], 50);
  assert.equal(sizes['Square150x150Logo.png'], 150);
});

test('넓은 타일은 아이콘을 가운데 둔다', () => {
  const px = Buffer.alloc(2 * 2 * 4, 255); // 불투명 흰 2x2
  const out = place(px, 2, 6, 4);
  const alpha = (x, y) => out[(y * 6 + x) * 4 + 3];
  assert.equal(alpha(2, 1), 255);
  assert.equal(alpha(3, 2), 255);
  assert.equal(alpha(0, 0), 0);
  assert.equal(alpha(5, 3), 0);
  assert.equal(alpha(1, 1), 0, '가운데보다 왼쪽으로 치우쳤다');
});
