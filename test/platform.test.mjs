import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 플랫폼 모듈은 electron을 import한다 — node --test에서는 electron이 없으므로
// 파일을 읽어 계약을 검사한다. 이 테스트가 지키려는 것은 **두 구현이 어긋나지 않는 것**이다:
// macOS 쪽이 깨져도 이 개발 환경(Windows)에서는 영영 드러나지 않는다.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, 'main', 'platform', f), 'utf8');

// 두 구현이 반드시 내보내야 하는 이름. 하나라도 빠지면 그 OS에서만 undefined가 되어
// 호출하는 순간 죽는다 — 그 순간을 실기기에서 처음 만나면 늦다.
const CONTRACT = [
  'name',
  'defaultHotkey',
  'hotkeyLabel',
  'firstRunHint',
  'prepareApp',
  'trayImage',
  'setLoginItem',
  'getLoginItem',
  'activate',
  'deactivate',
];

for (const impl of ['win32.mjs', 'darwin.mjs']) {
  test(`${impl}는 플랫폼 계약의 모든 이름을 내보낸다`, () => {
    const src = read(impl);
    for (const key of CONTRACT) {
      assert.match(src, new RegExp(`\\b${key}\\s*[:(]`), `${impl}에 ${key}가 없다`);
    }
  });
}

test('OS 분기는 main/platform/ 안에만 있다 (PLAT-06)', () => {
  // lifecycle·ipc·jobs·store가 process.platform을 직접 보기 시작하면 분기가 번진다.
  const files = ['lifecycle.mjs', 'ipc.mjs', 'jobs.mjs', 'store.mjs', 'queue.mjs', 'settings.mjs'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, 'main', f), 'utf8');
    assert.ok(!/process\.platform/.test(src), `main/${f}가 process.platform을 직접 본다`);
    assert.ok(!/\bdarwin\b/.test(src), `main/${f}에 darwin 분기가 있다`);
  }
});

test('플랫폼 진입점은 darwin일 때만 darwin 구현을 고른다', () => {
  const src = read('index.mjs');
  assert.match(src, /process\.platform === 'darwin' \? darwin : win32/);
});

test('macOS는 Dock 아이콘을 감춘다 (메뉴바 상주, PLAT-06)', () => {
  assert.match(read('darwin.mjs'), /app\.dock\?\.hide\(\)/);
  // Windows에는 dock이 없다 — 있으면 잘못 복사한 것이다
  assert.ok(!/app\.dock/.test(read('win32.mjs')));
});

test('macOS 메뉴바 아이콘은 Template로 넘긴다 — 다크 모드에서 뭉개지지 않게', () => {
  assert.match(read('darwin.mjs'), /setTemplateImage\(true\)/);
});

test('Windows는 알림 귀속을 위해 AppUserModelId를 세운다', () => {
  assert.match(read('win32.mjs'), /setAppUserModelId/);
});

test('자동 시작은 설정한 뒤 실제로 켜졌는지 돌려받아 확인한다 (PLAT-03)', () => {
  // 미서명 macOS에서 setLoginItemSettings는 실패해도 던지지 않는다 —
  // getLoginItemSettings로 되읽지 않으면 조용히 안 켜진 채로 켜졌다고 표시된다.
  for (const impl of ['win32.mjs', 'darwin.mjs']) {
    const src = read(impl);
    assert.match(src, /getLoginItemSettings\(\)\.openAtLogin === openAtLogin/, `${impl}가 되읽어 확인하지 않는다`);
  }
});

test('두 OS의 첫 실행 안내는 아이콘 위치와 단축키를 모두 말한다 (PLAT-05)', () => {
  // 안내의 목적은 "앱이 어디 있는지"다 — 위치를 빼면 안내가 아니다.
  assert.match(read('win32.mjs'), /트레이/);
  assert.match(read('darwin.mjs'), /메뉴바/);
  for (const impl of ['win32.mjs', 'darwin.mjs']) {
    assert.match(read(impl), /firstRunHint: \(hotkeyLabel\)/, `${impl}의 안내가 단축키를 받지 않는다`);
    assert.match(read(impl), /1~9/, `${impl}의 안내에 숫자키 분류가 없다`);
  }
});

test('Windows는 minimize→hide로 숨기고 restore→자리→show→focus로 보인다 (D8)', () => {
  // hide()만으로는 직전 창에 포커스가 돌아오지 않는다 — minimize를 거쳐 숨기고, 그래서 보일 때 restore가 먼저다.
  // restore 뒤 show()를 빼면 렌더러가 프레임을 내지 않아 화면이 굳는다(WHENCOMMAND D-29).
  // 최소화 중의 setPosition은 버려지므로(실측 2026-10-07) 자리 잡기는 restore 뒤여야 한다.
  const win = read('win32.mjs');
  assert.match(win, /deactivate\(win\) \{\s*if \(!win\.isMinimized\(\)\) win\.minimize\(\);\s*win\.hide\(\);/, 'minimize → hide 순서가 아니다');
  assert.match(win, /activate\(win, place\) \{\s*if \(win\.isMinimized\(\)\) win\.restore\(\);\s*place\?\.\(\);\s*win\.show\(\);\s*win\.focus\(\);/, 'restore → place → show → focus 순서가 아니다');
  // macOS는 hide()로 직전 앱에 돌아간다. app.hide()는 다른 창(오늘 뷰)까지 숨기므로 쓰지 않는다
  const mac = read('darwin.mjs');
  assert.match(mac, /deactivate\(win\) \{\s*win\.hide\(\);\s*\}/);
  assert.ok(!/^\s*app\.hide\(\);/m.test(mac), 'app.hide()는 열려 있던 다른 창까지 숨긴다');
});

test('창을 숨기는 곳은 전부 platform.deactivate를 탄다 — 맨 hide()가 남으면 그 길만 포커스가 안 돌아온다 (D8)', () => {
  const count = (f) => (fs.readFileSync(path.join(ROOT, 'main', f), 'utf8').match(/\.hide\(\)/g) ?? []).length;
  assert.equal(count('lifecycle.mjs'), 0, 'lifecycle.mjs가 hide()를 직접 부른다');
  // ipc.mjs의 하나는 app:open — 캡처를 접고 바로 오늘 뷰를 띄우므로 직전 창으로 돌아갈 일이 없다
  assert.equal(count('ipc.mjs'), 1, 'ipc.mjs의 hide()는 app:open 하나여야 한다');
});

test('macOS 구현에는 실기기 미검증 경고가 남아 있다', () => {
  // 검증되면 지우는 주석이다. 지워졌는데 이 테스트가 남아 있으면 같이 지운다 —
  // 검증 전에 조용히 사라지는 것을 막는 게 목적이다.
  assert.match(read('darwin.mjs'), /실기기에서 검증되지 않았다/);
});
