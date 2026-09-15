import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// update.mjs는 electron과 electron-updater를 import한다 — node --test에서는 둘 다 없다.
// 순수 함수만 떼어 검사할 수 있도록 소스에서 그 부분을 읽어 평가한다. 여기서 지키려는
// 것은 **사용자가 읽는 말**이다: 상태에 따라 무엇을 말하는지, 오류에 내부 정보가
// 새지 않는지. 둘 다 틀려도 앱은 돌기 때문에 테스트가 없으면 아무도 모른다.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'main', 'update.mjs'), 'utf8');

function extract(name) {
  const re = new RegExp(`export function ${name}\\([\\s\\S]*?\\n\\}`, 'm');
  const m = SRC.match(re);
  if (!m) throw new Error(`${name}을 찾지 못했다`);
  return m[0].replace(/^export /, '');
}

const mod = new Function(`${extract('updateLine')}\n${extract('friendlyUpdateError')}\nreturn { updateLine, friendlyUpdateError };`)();
const { updateLine, friendlyUpdateError } = mod;

test('아무 일도 없으면 현재 버전을 말한다', () => {
  assert.equal(updateLine({ status: 'idle' }, { current: '0.1.0' }), '최신 버전 (0.1.0)');
});

test('자동 설치가 되는 쪽과 안 되는 쪽이 다른 말을 한다', () => {
  const state = { status: 'available', version: '0.2.0' };
  // Windows: 알아서 받는다 — 사용자가 할 일이 없다
  assert.match(updateLine(state, { canAutoUpdate: true }), /내려받는 중/);
  // 미서명 macOS: 사용자가 직접 받아야 한다 — 그 사실을 말하지 않으면 기다리기만 한다
  assert.match(updateLine(state, { canAutoUpdate: false }), /눌러서 받기/);
});

test('받는 중에는 진행률을 정수로 말한다', () => {
  const line = updateLine({ status: 'downloading', version: '0.2.0', percent: 41.7 });
  assert.match(line, /42%/);
  assert.ok(!line.includes('41.7'), '소수점이 그대로 나오면 안 된다');
});

test('준비되면 "언제 설치되는지"를 말한다 — 스스로 재시작하지 않기 때문이다', () => {
  const line = updateLine({ status: 'ready', version: '0.2.0' });
  assert.match(line, /종료할 때 설치/);
});

test('개발 실행에서는 확인 자체가 안 된다고 말한다', () => {
  assert.match(updateLine({ status: 'unsupported' }), /설치본에서만/);
});

test('실패는 이유를 말하되 원인 문자열을 그대로 쏟지 않는다', () => {
  const line = updateLine({ status: 'error', error: '네트워크에 연결할 수 없습니다' });
  assert.match(line, /확인 실패/);
  assert.match(line, /네트워크/);
});

test('오류 문구에 내부 경로·URL·스택이 새지 않는다', () => {
  const leaky = new Error(
    'Cannot download "https://github.com/when630/whenwork/releases/download/v0.2.0/latest.yml", ' +
      'ENOTFOUND at C:\\Users\\someone\\AppData\\Local\\Programs\\WHENWORK\\resources\\app.asar'
  );
  const msg = friendlyUpdateError(leaky);
  assert.equal(msg, '네트워크에 연결할 수 없습니다');
  for (const leak of ['http', 'C:\\', 'app.asar', 'Users']) {
    assert.ok(!msg.includes(leak), `오류 문구에 ${leak}가 남았다`);
  }
});

test('흔한 실패는 사람이 고칠 수 있는 말로 갈린다', () => {
  assert.match(friendlyUpdateError(new Error('HTTP 404 Not Found')), /릴리스가 없/);
  // 릴리스가 하나도 없을 때 electron-updater가 실제로 내는 문장 (패키징본으로 확인)
  assert.match(friendlyUpdateError(new Error('No published versions on GitHub')), /릴리스가 없/);
  assert.match(friendlyUpdateError(new Error('403 API rate limit exceeded')), /한도/);
  // 릴리스를 막 공개한 직후 실제로 나온 문장 — 피드 전파 전까지 몇 분간 이렇게 온다
  assert.match(
    friendlyUpdateError(new Error('Cannot parse releases feed: Unable to find latest version on GitHub: HttpError: 406')),
    /잠시 뒤 다시/
  );
  assert.match(friendlyUpdateError(new Error('code signature validation failed')), /직접 내려받아/);
  assert.match(friendlyUpdateError(new Error('무언가 이상한 일')), /알 수 없/);
});

// ── 플랫폼 계약 (자동 업데이트 가능 여부)

test('macOS는 자동 업데이트를 할 수 없다고 선언한다 — 서명이 없기 때문이다', () => {
  const darwin = fs.readFileSync(path.join(ROOT, 'main', 'platform', 'darwin.mjs'), 'utf8');
  assert.match(darwin, /canAutoUpdate: false/);
  // 왜 false인지가 코드 옆에 남아 있어야 한다 — 나중에 누가 true로 바꾸려 할 때 읽으라고
  assert.match(darwin, /코드 서명이 필수/);
});

test('Windows는 미서명이어도 자동 업데이트가 된다', () => {
  const win = fs.readFileSync(path.join(ROOT, 'main', 'platform', 'win32.mjs'), 'utf8');
  assert.match(win, /canAutoUpdate: true/);
});

test('업데이트를 스스로 설치하며 재시작하지 않는다', () => {
  // 퀵캡처 앱이 쓰려는 순간 재시작하면 그 캡처가 갈 곳이 없다.
  assert.match(SRC, /autoInstallOnAppQuit = true/);
  assert.ok(!/autoUpdater\.quitAndInstall\(\)\s*;?\s*\n\s*}\s*\n\s*setTimeout/.test(SRC), '확인 직후 재시작하면 안 된다');
});

test('개발 실행에서는 업데이터를 아예 붙이지 않는다', () => {
  // 붙이면 dev-app-update.yml을 찾다가 매번 오류를 뱉는다
  assert.match(SRC, /if \(!app\.isPackaged\)/);
});
