import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  createLicense,
  verifyToken,
  maskKey,
  dueForRevalidation,
  PUBLIC_KEYS,
  API_BASE,
  REVALIDATE_MS,
} from '../main/license.mjs';
import { entitlements } from '../main/entitlements.mjs';
import { generate, insideRepo } from '../tools/license-keygen.mjs';

// 라이선스는 "돈을 낸 사람이 막히지 않는가"와 "네트워크가 결제 상태를 바꾸지 않는가"를 지킨다.
// 서버는 아직 없다 — 테스트용 키로 서명하는 가짜 서버로 응답을 흉내 낸다.

const K = generate('t1');
const KEYS = { t1: K.x };
const priv = crypto.createPrivateKey({ key: K.privateJwk, format: 'jwk' });

function sign(payload, { kid = 't1', key = priv } = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const msg = `v1.${kid}.${body}`;
  return `${msg}.${crypto.sign(null, Buffer.from(msg, 'utf8'), key).toString('base64url')}`;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-license-'));
}

// 가짜 서버. handler(route, body) → { status, json } | 'network'
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    const route = url.split('/').pop();
    const body = JSON.parse(init.body);
    calls.push({ route, body });
    const r = await handler(route, body);
    if (r === 'network') throw new TypeError('fetch failed');
    return { ok: r.status >= 200 && r.status < 300, json: async () => r.json };
  };
  impl.calls = calls;
  return impl;
}

const NOW = Date.parse('2026-11-10T03:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

// 키 문자열로 무엇을 샀는지 정하는 가짜 결제 서버
function store(overrides = {}) {
  return (route, { key, instance }) => {
    if (overrides[route]) return overrides[route]({ key, instance });
    if (route === 'deactivate') return { status: 200, json: { ok: true } };
    if (key === 'ADFREE-KEY-0001')
      return { status: 200, json: { token: sign({ kind: 'adfree', instance, activatedAt: iso(NOW), issuedAt: iso(NOW) }) } };
    if (key === 'PRO-KEY-00000001')
      return {
        status: 200,
        json: { token: sign({ kind: 'pro', instance, activatedAt: iso(NOW), expiresAt: iso(NOW + 365 * 86400_000), issuedAt: iso(NOW) }) },
      };
    return { status: 404, json: { error: 'invalid_key' } };
  };
}

const make = (dir, handler, extra = {}) =>
  createLicense({ dir, publicKeys: KEYS, apiBase: 'https://lic.test', fetchImpl: fakeFetch(handler), ...extra });

test('배포 기본값은 아무것도 믿지 않는다 — 공개키·서버 주소가 정해지기 전', () => {
  assert.deepEqual(PUBLIC_KEYS, {}, '키 없이 내보낸 빌드가 아무 토큰이나 믿으면 안 된다');
  assert.equal(API_BASE, null);
  const tok = sign({ kind: 'pro', instance: 'x', expiresAt: iso(NOW + 1e10) });
  assert.equal(verifyToken(tok), null, '기본 공개키 목록으로는 어떤 토큰도 통과하지 못한다');
});

test('서버 주소가 없으면 활성화는 "아직 판매 전"이라고 말하고 아무것도 쓰지 않는다', async () => {
  const dir = tmpDir();
  const lic = createLicense({ dir, publicKeys: KEYS });
  const r = await lic.activate('PRO-KEY-00000001');
  assert.equal(r.ok, false);
  assert.match(r.error, /판매/);
  assert.ok(!fs.existsSync(lic.file));
});

test('서명 검증: 맞는 키로 서명한 토큰만, 다른 키·변조·모르는 kid는 거절', () => {
  const p = { kind: 'pro', instance: 'i1', expiresAt: iso(NOW) };
  assert.deepEqual(verifyToken(sign(p), { publicKeys: KEYS }), p);
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.equal(verifyToken(sign(p, { key: other }), { publicKeys: KEYS }), null, '다른 키로 서명');
  assert.equal(verifyToken(sign(p, { kid: 'zz' }), { publicKeys: KEYS }), null, '모르는 kid');
  // payload만 바꿔 끼우기 — 만료일을 늘리는 변조
  const [v, kid, , sig] = sign(p).split('.');
  const forged = Buffer.from(JSON.stringify({ ...p, expiresAt: iso(NOW + 1e12) })).toString('base64url');
  assert.equal(verifyToken(`${v}.${kid}.${forged}.${sig}`, { publicKeys: KEYS }), null, '변조된 payload');
  // 서명은 맞지만 형식 버전이 다른 토큰 — 나중 형식(v2)을 지금 앱이 v1처럼 읽으면 안 된다
  const body2 = Buffer.from(JSON.stringify(p)).toString('base64url');
  const msg2 = `v2.t1.${body2}`;
  const v2 = `${msg2}.${crypto.sign(null, Buffer.from(msg2), priv).toString('base64url')}`;
  assert.equal(verifyToken(v2, { publicKeys: KEYS }), null, '모르는 형식 버전');
  for (const junk of [null, '', 'abc', 'v1.t1.x', 'v2.t1.a.b', 'v1.__proto__.a.b', 'v1.t1.@@.@@'])
    assert.equal(verifyToken(junk, { publicKeys: KEYS }), null, String(junk));
});

test('토큰은 이 기기(instance)에 묶이고, 종류(kind)를 모르는 토큰은 믿지 않는다', () => {
  const tok = sign({ kind: 'pro', instance: 'pc-A', expiresAt: iso(NOW) });
  assert.ok(verifyToken(tok, { publicKeys: KEYS, instance: 'pc-A' }));
  assert.equal(verifyToken(tok, { publicKeys: KEYS, instance: 'pc-B' }), null);
  assert.equal(verifyToken(sign({ kind: 'admin', instance: 'pc-A' }), { publicKeys: KEYS }), null);
});

test('instance id는 한 번 만들면 그대로다 — 무작위 UUID', () => {
  const dir = tmpDir();
  const a = make(dir, store()).instanceId();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(make(dir, store()).instanceId(), a, '다시 열어도 같은 id');
  assert.notEqual(make(tmpDir(), store()).instanceId(), a);
});

test('광고 제거 키를 활성화하면 광고가 꺼지고, 다시 열어도 유지된다', async () => {
  const dir = tmpDir();
  const lic = make(dir, store());
  const r = await lic.activate('  ADFREE-KEY-0001 \n');
  assert.deepEqual(r, { ok: true, kind: 'adfree' });
  assert.equal(entitlements(make(dir, store()).state(), NOW).ads, false);
  assert.deepEqual(make(dir, store()).summary(), { adfree: { key: 'ADFR••••0001', valid: true }, pro: null });
});

test('광고 제거와 Pro는 각자 칸에 들어간다 — 둘 다 가질 수 있다', async () => {
  const dir = tmpDir();
  const lic = make(dir, store());
  await lic.activate('ADFREE-KEY-0001');
  await lic.activate('PRO-KEY-00000001');
  const st = lic.state();
  assert.equal(st.adfree.kind, 'adfree');
  assert.equal(st.pro.kind, 'pro');
  assert.equal(entitlements(st, NOW).plan, 'pro');
});

test('활성화 실패는 사람 말로 — 서버 오류 코드·네트워크', async () => {
  const lic = make(tmpDir(), store());
  assert.match((await lic.activate('WRONG')).error, /확인되지 않는 키/);
  assert.match((await lic.activate('')).error, /입력/);
  const limit = make(tmpDir(), store({ activate: () => ({ status: 409, json: { error: 'activation_limit' } }) }));
  assert.match((await limit.activate('PRO-KEY-00000001')).error, /기기 수/);
  const down = make(tmpDir(), store({ activate: () => 'network' }));
  assert.match((await down.activate('PRO-KEY-00000001')).error, /인터넷 연결/);
  const weird = make(tmpDir(), store({ activate: () => ({ status: 500, json: { error: 'stack trace at /srv/x.js' } }) }));
  const msg = (await weird.activate('PRO-KEY-00000001')).error;
  assert.ok(!msg.includes('/srv'), '서버 내부 문자열을 그대로 보이지 않는다');
});

test('서버가 서명 없이 준 토큰·다른 기기 토큰으로는 활성화되지 않는다', async () => {
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  const forged = make(tmpDir(), store({
    activate: ({ instance }) => ({ status: 200, json: { token: sign({ kind: 'pro', instance, expiresAt: iso(NOW + 1e10) }, { key: other }) } }),
  }));
  assert.equal((await forged.activate('PRO-KEY-00000001')).ok, false);
  assert.ok(!fs.existsSync(forged.file));
  const elsewhere = make(tmpDir(), store({
    activate: () => ({ status: 200, json: { token: sign({ kind: 'pro', instance: 'someone-else', expiresAt: iso(NOW + 1e10) }) } }),
  }));
  assert.equal((await elsewhere.activate('PRO-KEY-00000001')).ok, false);
});

test('환불된 키는 활성화되지 않는다 — 서버가 revoked 토큰을 줄 때', async () => {
  const lic = make(tmpDir(), store({
    activate: ({ instance }) => ({ status: 200, json: { token: sign({ kind: 'adfree', instance, activatedAt: iso(NOW), revoked: true }) } }),
  }));
  const r = await lic.activate('ADFREE-KEY-0001');
  assert.equal(r.ok, false);
  assert.match(r.error, /환불/);
  assert.ok(!fs.existsSync(lic.file));
});

test('license.json을 다른 PC로 복사하면 그 PC에서는 무료다', async () => {
  const a = tmpDir();
  await make(a, store()).activate('PRO-KEY-00000001');
  const b = tmpDir();
  fs.copyFileSync(path.join(a, 'license.json'), path.join(b, 'license.json')); // instance-id는 복사하지 않는다
  assert.deepEqual(make(b, store()).state(), { adfree: null, pro: null });
  assert.deepEqual(make(b, store()).summary().pro, { key: 'PRO-••••0001', valid: false });
});

test('칸과 내용이 어긋난 토큰은 믿지 않는다 — pro 칸에 adfree 토큰', async () => {
  const dir = tmpDir();
  const lic = make(dir, store());
  await lic.activate('ADFREE-KEY-0001');
  const data = JSON.parse(fs.readFileSync(lic.file, 'utf8'));
  fs.writeFileSync(lic.file, JSON.stringify({ pro: data.adfree }));
  assert.equal(lic.state().pro, null);
});

test('깨진 license.json은 던지지 않고 무료다', () => {
  const dir = tmpDir();
  const lic = make(dir, store());
  for (const junk of ['{', '[]', 'null', '"x"', '{"pro":{"token":5}}']) {
    fs.writeFileSync(lic.file, junk);
    assert.deepEqual(lic.state(), { adfree: null, pro: null }, junk);
    assert.doesNotThrow(() => lic.summary());
  }
});

test('재검증: 네트워크 실패·서명 없는 오류 응답은 지금 토큰을 그대로 둔다', async () => {
  const dir = tmpDir();
  await make(dir, store()).activate('PRO-KEY-00000001');
  const before = fs.readFileSync(path.join(dir, 'license.json'), 'utf8');
  const later = NOW + 2 * 86400_000;
  for (const bad of [() => 'network', () => ({ status: 500, json: null }), () => ({ status: 404, json: { error: 'invalid_key' } })]) {
    const lic = make(dir, store({ validate: bad }));
    assert.deepEqual(await lic.revalidate(later), { changed: [] });
    assert.equal(fs.readFileSync(lic.file, 'utf8'), before, '서버에 닿지 못한 것과 구독이 끝난 것은 다른 일이다');
    assert.equal(entitlements(lic.state(), later).plan, 'pro');
  }
});

test('재검증: 서명된 revoked 토큰이 오면 그때 회수된다 (환불)', async () => {
  const dir = tmpDir();
  await make(dir, store()).activate('ADFREE-KEY-0001');
  const lic = make(dir, store({
    validate: ({ instance }) => ({ status: 200, json: { token: sign({ kind: 'adfree', instance, activatedAt: iso(NOW), revoked: true, issuedAt: iso(NOW + 8 * 86400_000) }) } }),
  }));
  const r = await lic.revalidate(NOW + 8 * 86400_000);
  assert.deepEqual(r.changed, ['adfree']);
  assert.equal(entitlements(lic.state(), NOW + 8 * 86400_000).ads, true);
});

test('재검증: 갱신된 구독은 새 만료일로 바뀐다', async () => {
  const dir = tmpDir();
  await make(dir, store()).activate('PRO-KEY-00000001');
  const renewed = iso(NOW + 730 * 86400_000);
  const lic = make(dir, store({
    validate: ({ instance }) => ({ status: 200, json: { token: sign({ kind: 'pro', instance, expiresAt: renewed, issuedAt: iso(NOW + 2 * 86400_000) }) } }),
  }));
  await lic.revalidate(NOW + 2 * 86400_000);
  assert.equal(lic.state().pro.expiresAt, renewed);
});

test('재검증 주기: Pro 하루, 광고 제거 일주일 — 때가 안 됐으면 서버를 부르지 않는다', async () => {
  assert.equal(REVALIDATE_MS.pro, 86400_000);
  assert.equal(REVALIDATE_MS.adfree, 7 * 86400_000);
  const p = { kind: 'pro', issuedAt: iso(NOW) };
  assert.equal(dueForRevalidation(p, NOW + 86400_000 - 1), false);
  assert.equal(dueForRevalidation(p, NOW + 86400_000), true);
  assert.equal(dueForRevalidation({ kind: 'adfree', issuedAt: iso(NOW) }, NOW + 6 * 86400_000), false);
  assert.equal(dueForRevalidation({ kind: 'pro' }, NOW), true, 'issuedAt이 없으면 확인한다');
  assert.equal(dueForRevalidation(null, NOW), false);

  const dir = tmpDir();
  await make(dir, store()).activate('PRO-KEY-00000001');
  const handler = store();
  const f = fakeFetch(handler);
  const lic = createLicense({ dir, publicKeys: KEYS, apiBase: 'https://lic.test', fetchImpl: f });
  await lic.revalidate(NOW + 3600_000);
  assert.equal(f.calls.length, 0, '한 시간 만에 다시 묻지 않는다');
  await lic.revalidate(NOW + 3600_000, { force: true });
  assert.equal(f.calls.length, 1, 'force면 바로 묻는다');
  assert.deepEqual(f.calls[0], { route: 'validate', body: { key: 'PRO-KEY-00000001', instance: lic.instanceId() } });
});

test('해제는 서버에 닿지 못해도 로컬에서는 지운다', async () => {
  const dir = tmpDir();
  await make(dir, store()).activate('PRO-KEY-00000001');
  const lic = make(dir, store({ deactivate: () => 'network' }));
  const r = await lic.deactivate('pro');
  assert.deepEqual(r, { ok: true, server: false });
  assert.equal(lic.state().pro, null);
  assert.equal(lic.summary().pro, null);
  assert.equal((await lic.deactivate('admin')).ok, false);
});

test('서버로 보내는 것은 키와 instance뿐이다', async () => {
  const f = fakeFetch(store());
  const lic = createLicense({ dir: tmpDir(), publicKeys: KEYS, apiBase: 'https://lic.test', fetchImpl: f });
  await lic.activate('PRO-KEY-00000001');
  assert.deepEqual(Object.keys(f.calls[0].body).sort(), ['instance', 'key']);
});

test('키 표시는 앞뒤 4자만', () => {
  assert.equal(maskKey('ABCD-1234-EFGH-5678'), 'ABCD••••5678');
  assert.equal(maskKey('short'), '••••');
  assert.equal(maskKey(''), '');
});

test('키 생성 도구는 개인키를 리포 안에 쓰지 않는다', () => {
  const root = path.resolve('repo-root-for-test');
  assert.equal(insideRepo(path.join(root, 'secret.json'), root), true);
  assert.equal(insideRepo(path.join(root, 'tools', 'k.json'), root), true);
  assert.equal(insideRepo(root, root), true);
  assert.equal(insideRepo(path.join(root, '..', 'outside', 'k.json'), root), false);
  assert.equal(insideRepo(path.join(os.tmpdir(), 'k.json'), root), false);
});
