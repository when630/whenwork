// tools/license-keygen.mjs — 라이선스 토큰 서명 키(Ed25519)를 만든다(docs/07_Pro_설계.md D-P05).
//
//   node tools/license-keygen.mjs <개인키를 저장할 경로> [kid]
//
// 개인키는 라이선스 서버(Cloudflare Worker)의 비밀값으로만 둔다. **이 리포 안에는 쓰지 않는다** —
// 공개 리포라 커밋되는 순간 누구나 Pro 토큰을 만들 수 있다. 그래서 리포 안 경로를 주면 거절한다.
// 공개키는 출력된 한 줄을 main/license.mjs의 PUBLIC_KEYS에 넣는다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function insideRepo(target, root = ROOT) {
  const rel = path.relative(root, path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function generate(kid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  return { kid, x: pub.x, privateJwk: { ...priv, kid } };
}

if (process.argv[1] && process.argv[1].endsWith('license-keygen.mjs')) {
  const [out, kid = `k${new Date().toISOString().slice(0, 7).replace('-', '')}`] = process.argv.slice(2);
  if (!out) {
    console.error('사용법: node tools/license-keygen.mjs <개인키를 저장할 경로(리포 밖)> [kid]');
    process.exit(2);
  }
  if (insideRepo(out)) {
    console.error('개인키를 리포 안에 쓰지 않습니다 — 공개 리포에 커밋되면 누구나 토큰을 만들 수 있습니다. 리포 밖 경로를 주세요.');
    process.exit(2);
  }
  if (fs.existsSync(out)) {
    console.error(`${out}이(가) 이미 있습니다 — 덮어쓰면 그 키로 서명된 토큰을 검증할 길이 사라집니다.`);
    process.exit(2);
  }
  const k = generate(kid);
  fs.writeFileSync(out, JSON.stringify(k.privateJwk, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  console.log(`개인키 → ${out} (Worker 비밀값으로 옮긴 뒤 이 파일은 안전한 곳에 보관)`);
  console.log(`main/license.mjs PUBLIC_KEYS에 추가:\n  ${k.kid}: '${k.x}',`);
}
