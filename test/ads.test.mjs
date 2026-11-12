import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAds, sanitize, pickAd, HOUSE_AD } from '../main/ads.mjs';

// 광고 한 줄·커피 사주기(D-P08~D-P10·D-P22). 서버가 죽어도 앱은 그대로, 보내는 건 이름·버전·OS뿐,
// 광고 주소는 받지 않는다 — 셋 중 하나라도 틀리면 광고가 앱을 깨거나 사용자를 추적하게 된다.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-ads-'));
const NOW = Date.parse('2026-11-12T03:00:00.000Z');

function server(json, { status = 200 } = {}) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    if (json === 'network') throw new TypeError('fetch failed');
    return { ok: status === 200, json: async () => json };
  };
  f.calls = calls;
  return f;
}

test('서버 목록을 받아 두고, 오늘 뷰에는 하우스 광고와 섞어 날짜마다 하나', async () => {
  const dir = tmp();
  const f = server({ ads: [{ id: 'notion-1', strong: 'Notion', text: '팀 문서는 한곳에', weight: 1 }], support: { label: '커피 한 잔' }, ttl: 43200 });
  const ads = createAds({ dir, apiBase: 'https://api.test', version: '0.3.0', os: 'win32', fetchImpl: f });
  await ads.refresh(NOW);
  const seen = new Set();
  for (let d = 0; d < 6; d++) seen.add(ads.today(new Date(NOW + d * 86400_000)).ad.id);
  assert.deepEqual([...seen].sort(), ['house-lite', 'notion-1']);
  assert.deepEqual(ads.today(new Date(NOW)).support, { label: '커피 한 잔' });
  // 같은 날에는 같은 광고
  assert.equal(ads.today(new Date(NOW)).ad.id, ads.today(new Date(NOW + 3600_000)).ad.id);
});

test('보내는 것은 앱 이름·버전·OS뿐 — 기기 번호·라이선스는 없다', async () => {
  const f = server({ ads: [] });
  await createAds({ dir: tmp(), apiBase: 'https://api.test', version: '0.3.0', os: 'darwin', fetchImpl: f }).refresh(NOW);
  const u = new URL(f.calls[0]);
  assert.equal(u.pathname, '/v1/ads');
  assert.deepEqual([...u.searchParams.keys()].sort(), ['app', 'os', 'v']);
});

test('하루 한 번만 묻는다 — ttl 안에는 서버를 부르지 않는다(최소 6시간)', async () => {
  const dir = tmp();
  const f = server({ ads: [], ttl: 60 });
  const ads = createAds({ dir, apiBase: 'https://api.test', fetchImpl: f });
  await ads.refresh(NOW);
  await ads.refresh(NOW + 3600_000);
  assert.equal(f.calls.length, 1, 'ttl이 짧아도 6시간 안에는 다시 묻지 않는다');
  await ads.refresh(NOW + 6 * 3600_000 + 1);
  assert.equal(f.calls.length, 2);
});

test('서버가 죽거나 이상한 걸 줘도 깨지지 않는다 — 지난 목록, 없으면 하우스 광고만', async () => {
  const dir = tmp();
  const good = createAds({ dir, apiBase: 'https://api.test', fetchImpl: server({ ads: [{ id: 'a1', text: '광고', weight: 10 }] }) });
  await good.refresh(NOW);
  for (const bad of ['network', { ads: 'x' }, null]) {
    const a = createAds({ dir, apiBase: 'https://api.test', fetchImpl: server(bad) });
    await a.refresh(NOW + 30 * 86400_000, { force: true });
  }
  const after = createAds({ dir, apiBase: 'https://api.test', fetchImpl: server('network') });
  assert.ok(['a1', 'house-lite'].includes(after.today(new Date(NOW)).ad.id), '지난 목록이 남아 있다');

  const empty = createAds({ dir: tmp(), apiBase: null, fetchImpl: server('network') });
  assert.deepEqual(await empty.refresh(NOW), { changed: false });
  assert.equal(empty.today().ad.id, 'house-lite');
  assert.equal(empty.today().support, null);
  fs.writeFileSync(path.join(dir, 'ads-cache.json'), '{broken');
  assert.equal(createAds({ dir, apiBase: null }).today().ad.id, 'house-lite');
});

test('모양이 틀린 광고는 버리고, 긴 글은 자른다', () => {
  const s = sanitize({
    ads: [
      { id: 'ok-1', text: 'x'.repeat(200), strong: 'y'.repeat(50), weight: 99 },
      { id: 'Bad ID', text: 't' },
      { id: 'no-text', text: '   ' },
      { id: 'js', text: 'click', url: 'javascript:alert(1)' },
    ],
    support: { label: 'z'.repeat(50) },
  });
  assert.deepEqual(s.ads.map((a) => a.id), ['ok-1', 'js']);
  assert.equal(s.ads[0].text.length, 80);
  assert.equal(s.ads[0].strong.length, 30);
  assert.equal(s.ads[0].weight, 10);
  assert.equal('url' in s.ads[1], false, '광고 주소는 받아 두지 않는다');
  assert.equal(s.support.label.length, 30);
});

test('누르면 서버의 /go/<id>만 연다 — 하우스 광고는 주소가 없다(앱 안 구매)', async () => {
  const dir = tmp();
  const ads = createAds({ dir, apiBase: 'https://api.test', fetchImpl: server({ ads: [], support: { label: '커피' } }) });
  assert.equal(ads.clickUrl('notion-1'), 'https://api.test/go/notion-1');
  assert.equal(ads.clickUrl(HOUSE_AD.id), null);
  assert.equal(ads.clickUrl('../../evil'), null);
  assert.equal(ads.supportUrl(), null, '받기 전에는 커피 사주기 주소도 없다');
  await ads.refresh(NOW);
  assert.equal(ads.supportUrl(), 'https://api.test/go/support?app=whenwork');
});

test('무게대로 섞인다', () => {
  const ads = [{ id: 'heavy', text: 'h', weight: 3 }];
  const counts = {};
  for (let d = 0; d < 40; d++) {
    const a = pickAd(ads, new Date(NOW + d * 86400_000));
    counts[a.id] = (counts[a.id] ?? 0) + 1;
  }
  assert.equal(counts.heavy, 30);
  assert.equal(counts['house-lite'], 10);
});
