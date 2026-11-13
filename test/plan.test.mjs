import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentPlan, projectGate, buyUrl, SALES_OPEN, BUY_KINDS } from '../main/plan.mjs';

// 앱이 지금 무엇을 허용하나(D-P02·D-P03). 가장 위험한 실수는 결제할 길이 없는 빌드에서
// 모두에게 광고와 3개 제한을 거는 것이다 — 그건 업데이트 한 번으로 기능을 빼앗는 일이다(원칙 2).

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-11-12T03:00:00.000Z');

test('판매가 열리지 않은 빌드는 제한이 없다 — 광고 없음, 프로젝트 무제한', () => {
  const p = currentPlan({ selling: false, licenseState: {}, now: NOW });
  assert.equal(p.plan, 'open');
  assert.equal(p.ads, false);
  assert.equal(p.projectLimit, null);
  assert.equal(projectGate(p, 50).ok, true);
});

test('이 빌드는 판매가 열려 있다(0.3.0~) — 서버 주소와 공개키가 둘 다 있어야 열린다', () => {
  // 판매를 다시 닫는 빌드를 내야 하면 API_BASE를 null로 — 이 테스트가 그 변경을 드러낸다
  assert.equal(SALES_OPEN, true);
  assert.equal(currentPlan({ licenseState: {}, now: NOW }).plan, 'free', '판매가 열리면 라이선스 없는 사람은 무료');
});

test('판매가 열리면 라이선스 상태대로 — 무료는 광고·3개, Lite는 둘 다 없음', () => {
  const free = currentPlan({ selling: true, licenseState: {}, now: NOW });
  assert.deepEqual([free.plan, free.ads, free.projectLimit], ['free', true, 3]);
  const lite = currentPlan({ selling: true, licenseState: { lite: { activatedAt: NOW.toISOString() } }, now: NOW });
  assert.deepEqual([lite.plan, lite.ads, lite.projectLimit], ['lite', false, null]);
  // 깨진 상태는 무료로 — 던지지 않는다
  assert.equal(currentPlan({ selling: true, licenseState: null, now: NOW }).plan, 'free');
});

test('프로젝트 문: 무료 3개 미만만 열리고, 막을 때는 제한 숫자를 함께 준다', () => {
  const free = currentPlan({ selling: true, licenseState: {}, now: NOW });
  assert.deepEqual(projectGate(free, 2), { ok: true });
  assert.deepEqual(projectGate(free, 3), { ok: false, reason: 'limit', limit: 3 });
  assert.deepEqual(projectGate(free, NaN), { ok: true }, '개수를 모르면 막지 않는다');
});

test('구매 주소: 1단계는 Lite만, 이 기기 번호와 앱 이름을 싣는다', () => {
  assert.deepEqual(BUY_KINDS, ['lite']);
  const u = new URL(buyUrl('lite', '1b4e28ba-2fa1-11d2-883f-0016d3cca427'));
  assert.equal(u.origin + u.pathname, 'https://whendesk.app/buy');
  assert.equal(u.searchParams.get('plan'), 'lite');
  assert.equal(u.searchParams.get('app'), 'whenwork');
  assert.equal(u.searchParams.get('i'), '1b4e28ba-2fa1-11d2-883f-0016d3cca427');
  assert.equal(buyUrl('pro', 'x'), null, 'Pro는 아직 팔지 않는다');
  assert.equal(buyUrl('../evil', 'x'), null);
});

test('제한은 IPC에서만 건다 — 저장소에 넣으면 가져오기가 잘린다(D-P11, 원칙 3)', () => {
  const ipc = fs.readFileSync(path.join(ROOT, 'main', 'ipc.mjs'), 'utf8');
  for (const ch of ['project:create', 'project:restore']) {
    const start = ipc.indexOf(`ipcMain.handle('${ch}'`);
    assert.ok(start >= 0, ch);
    const body = ipc.slice(start, ipc.indexOf('});', start));
    assert.match(body, /gate\(\)/, `${ch}가 제한을 묻지 않는다`);
  }
  const store = fs.readFileSync(path.join(ROOT, 'main', 'store.mjs'), 'utf8');
  assert.doesNotMatch(store, /projectLimit|canAddProject|entitlements/, '저장소가 결제 상태를 알면 안 된다');
});

test('광고는 오늘 뷰에만 — 퀵캡처 창에는 광고 자리가 없다(원칙 4)', () => {
  const cap = fs.readFileSync(path.join(ROOT, 'renderer', 'capture.html'), 'utf8') + fs.readFileSync(path.join(ROOT, 'renderer', 'capture.js'), 'utf8');
  assert.doesNotMatch(cap, /adline|광고|licenseBuy/);
});
