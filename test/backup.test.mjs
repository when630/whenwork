import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBackup, seal, open, readHeader, deriveKey, contentHash } from '../main/backup.mjs';

// Pro 클라우드 백업(D-P23). 여기가 틀리면 서버가 내용을 읽을 수 있거나, 암호 없이 남의 백업이 열리거나,
// 다른 PC에서 복원이 안 되거나, 매번 같은 걸 올려 비용이 새거나, 백업 실패가 앱을 깨뜨린다.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-backup-'));
const NOW = Date.parse('2026-11-13T03:00:00.000Z');
const DATA = { app: 'whenwork', schema_version: 4, exported_at: '2026-11-13T03:00:00Z', project: [{ id: 1, name: '영업' }], item: [{ id: 'a', title: '견적서 회신 받기' }], event: [] };

// 가짜 OS 보안 저장소 — 실제처럼 바이트를 바꾼다(원문이 파일에 그대로 남지 않는지 보려고)
const XOR = 0x5a;
const protect = (b) => Buffer.from(b).map((x) => x ^ XOR);
const unprotect = protect;

// 가짜 백업 서버 — 받은 덩어리를 날짜별로 둔다
function server() {
  const store = new Map();
  const calls = [];
  const f = async (url, init) => {
    const route = url.split('/v1/backup/')[1];
    calls.push({ route, headers: init.headers, body: init.body });
    if (route === 'upload') {
      store.set('2026-11-13', Buffer.from(init.body));
      return { ok: true, json: async () => ({ id: '2026-11-13', size: init.body.length }) };
    }
    if (route === 'list') return { ok: true, json: async () => ({ backups: [...store.keys()].map((id) => ({ id, size: store.get(id).length })) }) };
    if (route === 'download') {
      const id = JSON.parse(init.body).id;
      if (!store.has(id)) return { ok: false, json: async () => ({ error: 'not_found' }) };
      return { ok: true, arrayBuffer: async () => store.get(id) };
    }
    return { ok: false, json: async () => ({}) };
  };
  f.store = store;
  f.calls = calls;
  return f;
}

function make(dir, srv, over = {}) {
  let data = structuredClone(DATA);
  const imported = [];
  const b = createBackup({
    dir,
    apiBase: 'https://api.test',
    fetchImpl: srv,
    protect,
    unprotect,
    exportData: () => data,
    importData: (j) => { imported.push(j); return { project: j.project.length, item: j.item.length }; },
    credentials: () => ({ key: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', instance: '11111111-1111-4111-8111-111111111111' }),
    ...over,
  });
  return { b, imported, setData: (d) => { data = d; } };
}

test('봉인: 맞는 키로만 열리고, 헤더나 본문을 한 바이트만 바꿔도 열리지 않는다', () => {
  const salt = crypto.randomBytes(16);
  const key = deriveKey('correct horse', salt);
  const blob = seal(DATA, key, salt, { app: 'whenwork' });
  assert.deepEqual(open(blob, key), DATA);
  assert.equal(open(blob, deriveKey('wrong horse', salt)), null);
  for (const at of [10, blob.length - 30, blob.length - 1]) {
    const bad = Buffer.from(blob);
    bad[at] ^= 1;
    assert.equal(open(bad, key), null, `바이트 ${at}`);
  }
  // 서버가 받는 덩어리에 원문이 보이지 않는다
  assert.equal(blob.includes(Buffer.from('견적서')), false);
  assert.equal(readHeader(blob).header.kdf.alg, 'scrypt');
});

test('켜면 바로 한 번 올리고 — 서버에는 Pro 키·기기·암호화된 덩어리만 간다', async () => {
  const dir = tmp();
  const srv = server();
  const { b } = make(dir, srv);
  const r = await b.enable('my-backup-pass', NOW);
  assert.equal(r.ok, true);
  assert.equal(srv.calls[0].route, 'upload');
  assert.equal(srv.calls[0].headers['x-license-key'], 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE');
  assert.equal(Buffer.from(srv.calls[0].body).includes(Buffer.from('my-backup-pass')), false, '암호가 서버로 가지 않는다');
  assert.equal(b.status().enabled, true);
  assert.equal(b.status().lastAt, new Date(NOW).toISOString());
  // 기기에 둔 설정에도 암호·키 원문이 없다
  const saved = fs.readFileSync(b.file, 'utf8');
  assert.equal(saved.includes('my-backup-pass'), false);
  const raw = deriveKey('my-backup-pass', Buffer.from(JSON.parse(saved).salt, 'base64'));
  assert.equal(saved.includes(raw.toString('base64')), false, '키는 OS 보안 저장소로 감싼 것만');
});

test('하루 한 번, 바뀐 게 있을 때만 올린다', async () => {
  const dir = tmp();
  const srv = server();
  const { b, setData } = make(dir, srv);
  await b.enable('my-backup-pass', NOW);
  assert.equal((await b.run({ now: NOW + 3600_000 })).skipped, 'recent');
  assert.equal((await b.run({ now: NOW + 21 * 3600_000 })).skipped, 'unchanged', '내보낸 시각만 다르면 바뀐 게 아니다');
  setData({ ...DATA, exported_at: 'x', item: [...DATA.item, { id: 'b', title: '새 할 일' }] });
  assert.equal((await b.run({ now: NOW + 22 * 3600_000 })).ok, true);
  assert.equal(srv.calls.filter((c) => c.route === 'upload').length, 2);
});

test('이 PC에서는 암호 없이, 다른 PC에서는 암호로 복원한다 — 틀린 암호는 거절', async () => {
  const srv = server();
  const { b } = make(tmp(), srv);
  await b.enable('my-backup-pass', NOW);
  const same = await b.restore('2026-11-13');
  assert.equal(same.ok, true);
  assert.equal(same.item, 1);

  const other = make(tmp(), srv); // 새 PC: 백업을 켠 적 없음
  const need = await other.b.restore('2026-11-13');
  assert.equal(need.ok, false);
  assert.equal(need.needPassword, true);
  assert.match((await other.b.restore('2026-11-13', 'wrong-pass-123')).error, /맞지 않습니다/);
  const ok = await other.b.restore('2026-11-13', 'my-backup-pass');
  assert.equal(ok.ok, true);
  assert.deepEqual(other.imported[0], DATA);
});

test('복원할 내용이 내보내기 형식이 아니면 가져오지 않는다', async () => {
  const srv = server();
  const { b, imported } = make(tmp(), srv, { validate: () => '내보내기 파일의 형식이 올바르지 않습니다' });
  await b.enable('my-backup-pass', NOW);
  const r = await b.restore('2026-11-13');
  assert.equal(r.ok, false);
  assert.equal(imported.length, 0);
});

test('켤 수 없는 경우 — 짧은 암호, 보안 저장소 없음, Pro 아님', async () => {
  assert.match((await make(tmp(), server()).b.enable('short', NOW)).error, /8자 이상/);
  assert.match((await make(tmp(), server(), { protect: null }).b.enable('long-enough-pass', NOW)).error, /안전하게 보관할 수 없어/);
  assert.match((await make(tmp(), server(), { credentials: () => null }).b.enable('long-enough-pass', NOW)).error, /Pro/);
});

test('실패는 던지지 않는다 — 서버가 죽어도·저장소가 깨져도', async () => {
  const dead = async () => { throw new TypeError('fetch failed'); };
  const { b } = make(tmp(), dead);
  const r = await b.enable('my-backup-pass', NOW);
  assert.equal(r.ok, false);
  assert.equal(r.network, true);
  assert.equal(b.status().lastError, null, '네트워크 실패는 화면에 남기지 않는다');
  const broken = make(tmp(), server(), { exportData: () => { throw new Error('db locked'); } });
  const r2 = await broken.b.enable('my-backup-pass', NOW);
  assert.equal(r2.ok, false);
  assert.match(broken.b.status().lastError, /데이터를 읽지 못했습니다/);
});

test('끄면 이 기기의 키를 지운다 — 다시 올리지 않는다', async () => {
  const srv = server();
  const { b } = make(tmp(), srv);
  await b.enable('my-backup-pass', NOW);
  b.disable();
  assert.equal(b.status().enabled, false);
  assert.equal(JSON.parse(fs.readFileSync(b.file, 'utf8')).key, undefined);
  assert.equal((await b.run({ force: true, now: NOW + 86400_000 })).skipped, 'off');
});

test('내용 해시는 내보낸 시각을 무시한다', () => {
  assert.equal(contentHash({ ...DATA, exported_at: 'a' }), contentHash({ ...DATA, exported_at: 'b' }));
  assert.notEqual(contentHash(DATA), contentHash({ ...DATA, item: [] }));
});
