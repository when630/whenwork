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

// 서버처럼 app을 담는다 — 일부러 빼거나 바꾸려면 payload에 app을 직접 넣는다
function sign(payload, { kid = 't1', key = priv } = {}) {
  if (!('app' in payload)) payload = { app: 'whenwork', ...payload };
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
    if (key === 'LITE00-KEY-0001')
      return { status: 200, json: { token: sign({ kind: 'lite', instance, activatedAt: iso(NOW), issuedAt: iso(NOW) }) } };
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

test('배포된 앱은 라이선스 서버의 키 하나만 믿는다 — 다른 키로 서명한 토큰은 통과하지 못한다', () => {
  assert.deepEqual(Object.keys(PUBLIC_KEYS), ['k202611']);
  assert.match(PUBLIC_KEYS.k202611, /^[A-Za-z0-9_-]{43}$/, 'Ed25519 공개키(raw 32바이트 base64url)');
  assert.equal(API_BASE, 'https://api.whendesk.app');
  // 테스트 키(t1)로 서명한 토큰은 배포 공개키 목록으로 검증되지 않는다
  const tok = sign({ kind: 'pro', instance: 'x', expiresAt: iso(NOW + 1e10) });
  assert.equal(verifyToken(tok), null);
  // 같은 kid를 사칭해도 서명이 맞지 않으면 거절
  assert.equal(verifyToken(sign({ kind: 'lite', instance: 'x' }, { kid: 'k202611' })), null);
});

test('서버 주소가 없으면 활성화는 "아직 판매 전"이라고 말하고 아무것도 쓰지 않는다', async () => {
  const dir = tmpDir();
  // apiBase를 명시해 끈다 — 생략하면 배포 서버 주소(API_BASE)를 쓰게 돼 테스트가 실제 서버를 부른다
  const lic = createLicense({ dir, publicKeys: KEYS, apiBase: null });
  const r = await lic.activate('PRO-KEY-00000001');
  assert.equal(r.ok, false);
  assert.match(r.error, /판매/);
  assert.ok(!fs.existsSync(lic.file));
});

test('서명 검증: 맞는 키로 서명한 토큰만, 다른 키·변조·모르는 kid는 거절', () => {
  const p = { app: 'whenwork', kind: 'pro', instance: 'i1', expiresAt: iso(NOW) };
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

test('다른 시리즈 앱의 토큰, 앱 이름이 없는 토큰은 믿지 않는다 (D-P18 — 서버는 시리즈 공통)', () => {
  const base = { kind: 'pro', instance: 'pc-A', expiresAt: iso(NOW) };
  assert.ok(verifyToken(sign(base), { publicKeys: KEYS }));
  assert.equal(verifyToken(sign({ ...base, app: 'whencommand' }), { publicKeys: KEYS }), null);
  assert.equal(verifyToken(sign({ ...base, app: undefined }), { publicKeys: KEYS }), null);
});

test('instance id는 한 번 만들면 그대로다 — 무작위 UUID', () => {
  const dir = tmpDir();
  const a = make(dir, store()).instanceId();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(make(dir, store()).instanceId(), a, '다시 열어도 같은 id');
  assert.notEqual(make(tmpDir(), store()).instanceId(), a);
});

test('Lite 키를 활성화하면 광고가 꺼지고, 다시 열어도 유지된다', async () => {
  const dir = tmpDir();
  const lic = make(dir, store());
  const r = await lic.activate('  LITE00-KEY-0001 \n');
  assert.deepEqual(r, { ok: true, kind: 'lite' });
  assert.equal(entitlements(make(dir, store()).state(), NOW).ads, false);
  assert.deepEqual(make(dir, store()).summary(), { lite: { key: 'LITE••••0001', valid: true }, pro: null });
});

test('Lite와 Pro는 각자 칸에 들어간다 — 둘 다 가질 수 있다', async () => {
  const dir = tmpDir();
  const lic = make(dir, store());
  await lic.activate('LITE00-KEY-0001');
  await lic.activate('PRO-KEY-00000001');
  const st = lic.state();
  assert.equal(st.lite.kind, 'lite');
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
    activate: ({ instance }) => ({ status: 200, json: { token: sign({ kind: 'lite', instance, activatedAt: iso(NOW), revoked: true }) } }),
  }));
  const r = await lic.activate('LITE00-KEY-0001');
  assert.equal(r.ok, false);
  assert.match(r.error, /환불/);
  assert.ok(!fs.existsSync(lic.file));
});

test('license.json을 다른 PC로 복사하면 그 PC에서는 무료다', async () => {
  const a = tmpDir();
  await make(a, store()).activate('PRO-KEY-00000001');
  const b = tmpDir();
  fs.copyFileSync(path.join(a, 'license.json'), path.join(b, 'license.json')); // instance-id는 복사하지 않는다
  assert.deepEqual(make(b, store()).state(), { lite: null, pro: null });
  assert.deepEqual(make(b, store()).summary().pro, { key: 'PRO-••••0001', valid: false });
});

test('칸과 내용이 어긋난 토큰은 믿지 않는다 — pro 칸에 lite 토큰', async () => {
  const dir = tmpDir();
  const lic = make(dir, store());
  await lic.activate('LITE00-KEY-0001');
  const data = JSON.parse(fs.readFileSync(lic.file, 'utf8'));
  fs.writeFileSync(lic.file, JSON.stringify({ pro: data.lite }));
  assert.equal(lic.state().pro, null);
});

test('깨진 license.json은 던지지 않고 무료다', () => {
  const dir = tmpDir();
  const lic = make(dir, store());
  for (const junk of ['{', '[]', 'null', '"x"', '{"pro":{"token":5}}']) {
    fs.writeFileSync(lic.file, junk);
    assert.deepEqual(lic.state(), { lite: null, pro: null }, junk);
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
  await make(dir, store()).activate('LITE00-KEY-0001');
  const lic = make(dir, store({
    validate: ({ instance }) => ({ status: 200, json: { token: sign({ kind: 'lite', instance, activatedAt: iso(NOW), revoked: true, issuedAt: iso(NOW + 8 * 86400_000) }) } }),
  }));
  const r = await lic.revalidate(NOW + 8 * 86400_000);
  assert.deepEqual(r.changed, ['lite']);
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

test('재검증 주기: Pro 하루, Lite 일주일 — 때가 안 됐으면 서버를 부르지 않는다', async () => {
  assert.equal(REVALIDATE_MS.pro, 86400_000);
  assert.equal(REVALIDATE_MS.lite, 7 * 86400_000);
  const p = { kind: 'pro', issuedAt: iso(NOW) };
  assert.equal(dueForRevalidation(p, NOW + 86400_000 - 1), false);
  assert.equal(dueForRevalidation(p, NOW + 86400_000), true);
  assert.equal(dueForRevalidation({ kind: 'lite', issuedAt: iso(NOW) }, NOW + 6 * 86400_000), false);
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
  assert.deepEqual(f.calls[0], { route: 'validate', body: { key: 'PRO-KEY-00000001', instance: lic.instanceId(), app: 'whenwork' } });
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

test('서버로 보내는 것은 키·instance·앱 이름뿐이다 — 앱 이름은 서버가 다른 앱의 키를 거절하는 근거(D-P18)', async () => {
  const f = fakeFetch(store());
  const lic = createLicense({ dir: tmpDir(), publicKeys: KEYS, apiBase: 'https://lic.test', fetchImpl: f });
  await lic.activate('PRO-KEY-00000001');
  assert.deepEqual(Object.keys(f.calls[0].body).sort(), ['app', 'instance', 'key']);
  assert.equal(f.calls[0].body.app, 'whenwork');
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

test('앱 안 구매: claim으로 받아 온 토큰을 저장한다 — 키를 입력하지 않아도 Lite', async () => {
  const dir = tmpDir();
  let inst = null;
  const f = fakeFetch((route, body) => {
    inst = body.instance;
    if (route !== 'claim') return { status: 404, json: { error: 'not_found' } };
    return { status: 200, json: { licenses: [{ kind: 'lite', key: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', token: sign({ kind: 'lite', instance: body.instance, activatedAt: iso(NOW), issuedAt: iso(NOW) }) }] } };
  });
  const lic = createLicense({ dir, publicKeys: KEYS, apiBase: 'https://lic.test', fetchImpl: f });
  assert.deepEqual(await lic.claim(), { ok: true, kinds: ['lite'] });
  assert.equal(f.calls[0].body.instance, lic.instanceId());
  assert.equal(f.calls[0].body.app, 'whenwork');
  assert.equal(entitlements(lic.state(), NOW).plan, 'lite');
  assert.equal(lic.summary().lite.key, 'AAAA••••EEEE', '받아 온 키는 해제·다른 PC용으로 남는다');
});

test('앱 안 구매: 결제 확인 전이면 pending — 다른 기기의 토큰·환불된 토큰은 저장하지 않는다', async () => {
  const pending = createLicense({ dir: tmpDir(), publicKeys: KEYS, apiBase: 'https://lic.test', fetchImpl: fakeFetch(() => ({ status: 404, json: { error: 'pending' } })) });
  const r = await pending.claim();
  assert.equal(r.ok, false);
  assert.equal(r.pending, true);

  for (const bad of [{ instance: '00000000-0000-4000-8000-000000000000' }, { revoked: true }]) {
    const dir = tmpDir();
    const f = fakeFetch((route, body) => ({ status: 200, json: { licenses: [{ kind: 'lite', key: 'K', token: sign({ kind: 'lite', instance: body.instance, activatedAt: iso(NOW), issuedAt: iso(NOW), ...bad }) }] } }));
    const lic = createLicense({ dir, publicKeys: KEYS, apiBase: 'https://lic.test', fetchImpl: f });
    assert.equal((await lic.claim()).ok, false, JSON.stringify(bad));
    assert.equal(lic.state().lite, null);
  }
});

test('구매 복원: 이메일 → 코드 → 이 기기에 저장. 사용자는 키를 보지 않는다(D-P21)', async () => {
  const dir = tmpDir();
  const f = fakeFetch((route, body) => {
    if (route === 'restore-start') return { status: 200, json: { ok: true } };
    if (route === 'restore-verify') {
      if (body.code !== '123456') return { status: 400, json: { error: 'code_invalid' } };
      return { status: 200, json: { licenses: [{ kind: 'lite', key: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', token: sign({ kind: 'lite', instance: body.instance, activatedAt: iso(NOW), issuedAt: iso(NOW) }) }] } };
    }
    return { status: 404, json: { error: 'not_found' } };
  });
  const lic = createLicense({ dir, publicKeys: KEYS, apiBase: 'https://lic.test', fetchImpl: f });
  assert.deepEqual(await lic.restoreStart(' buyer@example.com '), { ok: true });
  assert.deepEqual(f.calls[0].body, { email: 'buyer@example.com', instance: lic.instanceId(), app: 'whenwork' });
  const wrong = await lic.restoreVerify('buyer@example.com', '000000');
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /코드가 맞지 않습니다/);
  assert.deepEqual(await lic.restoreVerify('buyer@example.com', '123 456'), { ok: true, kinds: ['lite'] });
  assert.equal(f.calls.at(-1).body.code, '123456', '공백 섞인 코드도 숫자만 보낸다');
  assert.equal(entitlements(lic.state(), NOW).plan, 'lite');
});

test('구매 복원: 이메일·코드 형식이 틀리면 서버에 묻지 않는다 · 서버 오류는 사람 말로', async () => {
  const f = fakeFetch(() => ({ status: 503, json: { error: 'mail_unavailable' } }));
  const lic = createLicense({ dir: tmpDir(), publicKeys: KEYS, apiBase: 'https://lic.test', fetchImpl: f });
  assert.equal((await lic.restoreStart('not-an-email')).ok, false);
  assert.equal((await lic.restoreVerify('a@b.co', '12')).ok, false);
  assert.equal(f.calls.length, 0);
  const r = await lic.restoreStart('a@b.co');
  assert.match(r.error, /메일을 보낼 수 없습니다/);
});

test('활성화하면 서버가 정리해 준 키로 저장한다 — 붙여 넣은 소문자·공백이 화면에 남지 않게', async () => {
  const dir = tmpDir();
  const f = fakeFetch((route, body) => ({ status: 200, json: { key: 'ABCDE-FGHJK-MNPQR-STVWX-YZ012', token: sign({ kind: 'lite', instance: body.instance, activatedAt: iso(NOW), issuedAt: iso(NOW) }) } }));
  const lic = createLicense({ dir, publicKeys: KEYS, apiBase: 'https://lic.test', fetchImpl: f });
  await lic.activate('  abcde fghjk mnpqr stvwx yz012 ');
  assert.equal(lic.summary().lite.key, 'ABCD••••Z012');
  // 옛 서버(key를 안 주는)와도 그대로 된다
  const old = createLicense({ dir: tmpDir(), publicKeys: KEYS, apiBase: 'https://lic.test', fetchImpl: fakeFetch(store()) });
  assert.equal((await old.activate('LITE00-KEY-0001')).ok, true);
  assert.equal(old.summary().lite.key, 'LITE••••0001');
});
