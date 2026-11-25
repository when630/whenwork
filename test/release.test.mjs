import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 릴리스 빌드 설정(D-P30) — 여기가 틀리면 macOS 공증이 거절되거나(강화된 런타임·권한 없음),
// 서명된 앱이 켜지자마자 죽거나(JIT 권한 없음), Secrets가 없을 때 빌드가 깨지거나,
// Gatekeeper가 거부하는 dmg가 그대로 나간다.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8').replace(/\r\n/g, '\n');

test('macOS 빌드는 강화된 런타임과 권한 파일로 — 서명을 설정에서 끄지 않는다', () => {
  const mac = pkg.build.mac;
  assert.equal(mac.hardenedRuntime, true);
  assert.equal(mac.entitlements, 'assets/mac/entitlements.mac.plist');
  assert.equal(mac.entitlementsInherit, 'assets/mac/entitlements.mac.plist');
  assert.ok(!('identity' in mac), 'identity: null이 남아 있으면 Secrets가 있어도 서명하지 않는다');
  // build/는 .gitignore(아이콘을 빌드 때 굽는 곳) — 여기 두면 CI에 올라가지 않아 서명 빌드가 깨진다
  const ignored = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim().replace(/\/$/, ''));
  assert.ok(!ignored.includes(mac.entitlements.split('/')[0]), `${mac.entitlements}가 .gitignore에 걸린다`);
  const plist = fs.readFileSync(path.join(ROOT, 'assets', 'mac', 'entitlements.mac.plist'), 'utf8');
  assert.match(plist, /com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\/>/);
  assert.match(plist, /com\.apple\.security\.cs\.allow-unsigned-executable-memory<\/key>\s*<true\/>/);
});

test('CI — Secrets가 있으면 서명·공증·Gatekeeper 확인, 없으면 지금처럼 서명 없이', () => {
  assert.ok(wf.includes("HAS_MAC_SIGN: ${{ secrets.MAC_CERT_P12 != '' }}"));
  // 서명 없는 경로: Windows 전부 + Secrets 없는 macOS. 러너 키체인을 뒤지지 않는다
  const plain = wf.slice(wf.indexOf('      - name: build\n'), wf.indexOf('      - name: build (서명·공증)'));
  assert.ok(plain.includes("if: matrix.os != 'macos-latest' || env.HAS_MAC_SIGN != 'true'"));
  assert.ok(plain.includes('CSC_IDENTITY_AUTO_DISCOVERY: false'));
  // 서명 경로: 공증을 켜고 인증서·Apple 계정을 넘긴다
  const signed = wf.slice(wf.indexOf('      - name: build (서명·공증)'), wf.indexOf('      - name: 서명·공증 확인'));
  assert.ok(signed.includes("if: matrix.os == 'macos-latest' && env.HAS_MAC_SIGN == 'true'"));
  assert.ok(signed.includes('-c.mac.notarize=true'));
  for (const k of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) assert.ok(signed.includes(`${k}: \${{ secrets.`), k);
  // 확인 단계: 실패하면 업로드까지 가지 않는다
  const verify = wf.slice(wf.indexOf('      - name: 서명·공증 확인'), wf.indexOf('      - uses: actions/upload-artifact'));
  for (const cmd of ['codesign --verify --deep --strict', 'xcrun stapler validate', 'spctl --assess --type execute']) assert.ok(verify.includes(cmd), cmd);
});

test('릴리스는 여전히 드래프트로 — 사람이 보고 공개한다', () => {
  assert.ok(wf.includes('draft: true'));
});
