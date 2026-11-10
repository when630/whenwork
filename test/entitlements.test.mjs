import test from 'node:test';
import assert from 'node:assert/strict';
import { entitlements, canAddProject, FREE_PROJECT_LIMIT, PRO_GRACE_DAYS } from '../main/entitlements.mjs';

// 결제 상태가 앱 동작을 정하는 단 하나의 판정(D-P02). 경계가 하루라도 어긋나면 돈을 낸 사람이
// 막히거나, 구독이 끝난 사람이 영영 Pro로 남는다 — 둘 다 앱을 켜 봐서는 알기 어렵다.

const NOW = new Date('2026-11-10T03:00:00.000Z');
const days = (n) => new Date(NOW.getTime() + n * 86400_000).toISOString();

test('아무 라이선스도 없으면 무료 — 광고, 프로젝트 3개, 백업·동기화 없음', () => {
  const e = entitlements({}, NOW);
  assert.equal(e.plan, 'free');
  assert.equal(e.ads, true);
  assert.equal(e.projectLimit, FREE_PROJECT_LIMIT);
  assert.equal(FREE_PROJECT_LIMIT, 3);
  assert.equal(e.backup, false);
  assert.equal(e.sync, false);
  // 인자 없이 불러도 던지지 않는다
  assert.equal(entitlements().plan, 'free');
});

test('광고 제거는 광고만 끈다 — 프로젝트 제한은 그대로', () => {
  const e = entitlements({ adfree: { activatedAt: days(-400) } }, NOW);
  assert.equal(e.plan, 'adfree');
  assert.equal(e.ads, false);
  assert.equal(e.projectLimit, 3);
  assert.equal(e.backup, false);
});

test('광고 제거는 영구다 — 몇 년이 지나도, 재검증 날짜가 없어도', () => {
  const e = entitlements({ adfree: { activatedAt: days(-3650) } }, NOW);
  assert.equal(e.ads, false);
});

test('광고 제거는 서버가 명시적으로 회수했을 때만 사라진다 (환불)', () => {
  assert.equal(entitlements({ adfree: { activatedAt: days(-1), revoked: true } }, NOW).ads, true);
  // revoked가 true가 아닌 다른 값(문자열 등)이면 회수로 보지 않는다 — 회수는 엄격하게
  assert.equal(entitlements({ adfree: { activatedAt: days(-1), revoked: 'yes' } }, NOW).ads, false);
});

test('Pro는 전부 연다 — 광고 없음, 프로젝트 무제한(null), 백업·동기화', () => {
  const e = entitlements({ pro: { expiresAt: days(200) } }, NOW);
  assert.equal(e.plan, 'pro');
  assert.equal(e.ads, false);
  assert.equal(e.projectLimit, null, 'Infinity는 JSON에서 null로 바뀐다 — 처음부터 null로 둔다');
  assert.equal(e.backup, true);
  assert.equal(e.sync, true);
  assert.equal(e.proExpiresAt, days(200));
  assert.equal(e.proGraceUntil, null);
});

test('Pro 만료 순간까지는 정상, 그 뒤 14일은 유예로 유지된다', () => {
  assert.equal(entitlements({ pro: { expiresAt: NOW.toISOString() } }, NOW).proGraceUntil, null, '만료 시각 정각은 아직 유효');
  const g = entitlements({ pro: { expiresAt: days(-1) } }, NOW);
  assert.equal(g.plan, 'pro');
  assert.equal(g.projectLimit, null);
  assert.equal(g.proGraceUntil, days(-1 + PRO_GRACE_DAYS), '유예 중이면 언제까지인지 말해야 화면이 안내할 수 있다');
  assert.equal(PRO_GRACE_DAYS, 14);
});

test('유예 마지막 순간까지는 Pro, 1ms 지나면 무료', () => {
  const exp = new Date(NOW.getTime() - PRO_GRACE_DAYS * 86400_000).toISOString();
  assert.equal(entitlements({ pro: { expiresAt: exp } }, NOW).plan, 'pro');
  const past = new Date(NOW.getTime() - PRO_GRACE_DAYS * 86400_000 - 1).toISOString();
  const e = entitlements({ pro: { expiresAt: past } }, NOW);
  assert.equal(e.plan, 'free');
  assert.equal(e.ads, true);
  assert.equal(e.projectLimit, 3);
  assert.equal(e.proExpiresAt, null);
});

test('Pro가 끝나도 따로 산 광고 제거는 남는다', () => {
  const e = entitlements({ adfree: { activatedAt: days(-500) }, pro: { expiresAt: days(-100) } }, NOW);
  assert.equal(e.plan, 'adfree');
  assert.equal(e.ads, false);
  assert.equal(e.projectLimit, 3);
});

test('회수된 Pro는 유예 없이 바로 끝난다', () => {
  const e = entitlements({ pro: { expiresAt: days(100), revoked: true } }, NOW);
  assert.equal(e.plan, 'free');
});

test('깨진 라이선스는 던지지 않고 무료로 본다 — 라이선스가 캡처를 막으면 안 된다', () => {
  const broken = [
    { adfree: 'x' },
    { adfree: [] },
    { adfree: { activatedAt: '날짜아님' } },
    { adfree: {} },
    { pro: { expiresAt: 'not-a-date' } },
    { pro: { expiresAt: null } },
    { pro: 42 },
    { pro: { expiresAt: NaN } },
  ];
  for (const lic of broken) {
    const e = entitlements(lic, NOW);
    assert.equal(e.plan, 'free', JSON.stringify(lic));
    assert.equal(e.ads, true);
  }
  assert.doesNotThrow(() => entitlements(null ?? undefined, NOW));
});

test('now는 Date·밀리초·ISO 모두 받고, 읽을 수 없으면 지금 시각으로 본다', () => {
  const lic = { pro: { expiresAt: days(1) } };
  assert.equal(entitlements(lic, NOW.getTime()).plan, 'pro');
  assert.equal(entitlements(lic, NOW.toISOString()).plan, 'pro');
  assert.equal(entitlements({ pro: { expiresAt: '2000-01-01T00:00:00Z' } }, 'garbage').plan, 'free');
});

test('결과는 JSON으로 왕복해도 같다 — IPC로 렌더러에 그대로 넘긴다', () => {
  for (const lic of [{}, { adfree: { activatedAt: days(-1) } }, { pro: { expiresAt: days(-2) } }]) {
    const e = entitlements(lic, NOW);
    assert.deepEqual(JSON.parse(JSON.stringify(e)), e);
  }
});

test('프로젝트 추가: 무료는 활성 3개 미만일 때만, Pro는 언제나', () => {
  const free = entitlements({}, NOW);
  assert.equal(canAddProject(free, 0), true);
  assert.equal(canAddProject(free, 2), true);
  assert.equal(canAddProject(free, 3), false);
  const pro = entitlements({ pro: { expiresAt: days(10) } }, NOW);
  assert.equal(canAddProject(pro, 500), true);
});

test('이미 3개를 넘게 쓰는 사람(그랜드파더)은 새로 만들 수만 없다', () => {
  // 개수가 제한을 넘었다는 이유로 판정이 이상해지지 않는다 — 그냥 "더 만들 수 없음"
  assert.equal(canAddProject(entitlements({}, NOW), 7), false);
});

test('개수를 모르면 막지 않는다', () => {
  const free = entitlements({}, NOW);
  assert.equal(canAddProject(free, undefined), true);
  assert.equal(canAddProject(free, NaN), true);
  assert.equal(canAddProject(free, 'x'), true);
});
