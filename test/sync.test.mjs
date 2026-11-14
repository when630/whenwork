import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStore } from '../main/store.mjs';
import { createSync, encryptRow, decryptRow, syncSalt, MSG_WRONG } from '../main/sync.mjs';
import { deriveKey } from '../main/backup.mjs';

// 기기 간 동기화(D-P26) — 두 PC(저장소 두 개)와 서버 규칙을 흉내 낸 가짜 서버로 끝까지 돌린다.
// 여기가 틀리면 한 PC의 일이 다른 PC로 가지 않거나, 옛 변경이 새 변경을 덮거나, 틀린 암호로 섞이거나,
// 서버가 내용을 읽거나, 같은 이름 프로젝트 때문에 동기화가 멈추거나, 실패가 앱을 깨뜨린다.

const KEY = 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE';
const PASS = 'sync-pass-123';
const wrap = (b) => Buffer.from(b).map((x) => x ^ 0x5a);

// 서버(whendesk-api src/sync.js)와 같은 규칙: 나중 것 우선(같으면 device 큰 쪽), 순번, 묶음 = 키
function fakeServer() {
  const rows = new Map(); // `${kind}:${uid}` → row
  let seq = 0;
  const calls = [];
  const f = async (url, init) => {
    const route = url.split('/v1/sync/')[1];
    const body = JSON.parse(init.body);
    calls.push({ route, body });
    const res = (j, ok = true, status = 200) => ({ ok, status, json: async () => j });
    if (body.key !== KEY) return res({ error: 'not_pro' }, false, 403);
    if (route === 'push') {
      let applied = 0;
      const stale = [];
      for (const r of body.rows) {
        const k = `${r.kind}:${r.uid}`;
        const cur = rows.get(k);
        const wins = !cur || r.updated_at > cur.updated_at || (r.updated_at === cur.updated_at && body.instance > cur.device);
        if (!wins) { stale.push(r.uid); continue; }
        rows.set(k, { kind: r.kind, uid: r.uid, updated_at: r.updated_at, deleted: !!r.deleted, blob: r.blob ?? null, device: body.instance, seq: ++seq });
        applied++;
      }
      return res({ applied, stale, rejected: [], cursor: seq });
    }
    if (route === 'pull') {
      const list = [...rows.values()].filter((r) => r.seq > body.since).sort((a, b) => a.seq - b.seq);
      const page = list.slice(0, body.limit ?? 1000);
      return res({ rows: page, cursor: page.length ? page[page.length - 1].seq : body.since, more: page.length < list.length });
    }
    if (route === 'reset') {
      const n = rows.size;
      rows.clear();
      return res({ deleted: n });
    }
    return res({}, false, 404);
  };
  f.rows = rows;
  f.calls = calls;
  return f;
}

function pc(server, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-sync-'));
  const store = createStore(path.join(dir, 'store.sqlite'));
  const instance = crypto.randomUUID();
  const sync = createSync({
    dir,
    apiBase: 'https://api.test',
    fetchImpl: server,
    protect: wrap,
    unprotect: wrap,
    store,
    credentials: () => ({ key: KEY, instance }),
    ...over,
  });
  return { store, sync, instance, dir };
}
const capture = (store, id, title) => store.insertCaptures([{ id, title, captured_at: new Date().toISOString(), context: null }]);
const item = (store, id) => store.exportAll().item.find((i) => i.id === id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('한 PC의 프로젝트·항목이 다른 PC로 간다 — 항목은 그 PC의 프로젝트 번호로 이어진다', async () => {
  const srv = fakeServer();
  const a = pc(srv);
  a.store.createProject('먼저 만든 것');
  const pid = a.store.createProject('영업');
  capture(a.store, 'i1', '견적서 회신 받기');
  a.store.assignProject('i1', pid);
  assert.equal((await a.sync.enable(PASS)).ok, true);

  const b = pc(srv);
  b.store.createProject('B에만 있는 것'); // B의 번호는 A와 다르다
  const r = await b.sync.enable(PASS);
  assert.equal(r.ok, true);
  const got = item(b.store, 'i1');
  assert.equal(got.title, '견적서 회신 받기');
  const bProject = b.store.exportAll().project.find((p) => p.id === got.project_id);
  assert.equal(bProject.name, '영업');
  // B에만 있던 것도 A로 간다
  await a.sync.run();
  assert.ok(a.store.exportAll().project.some((p) => p.name === 'B에만 있는 것'));
});

test('나중에 고친 쪽이 두 PC 모두에 남는다', async () => {
  const srv = fakeServer();
  const a = pc(srv);
  capture(a.store, 'i1', '처음');
  await a.sync.enable(PASS);
  const b = pc(srv);
  await b.sync.enable(PASS);
  a.store.renameItem('i1', 'A가 고침');
  await wait(15);
  b.store.renameItem('i1', 'B가 나중에 고침');
  await a.sync.run(); // A가 먼저 올린다
  await b.sync.run(); // B의 것이 더 나중 — 서버가 받는다
  await a.sync.run(); // A가 받아 간다
  assert.equal(item(a.store, 'i1').title, 'B가 나중에 고침');
  assert.equal(item(b.store, 'i1').title, 'B가 나중에 고침');
  // 옛 변경이 다시 올라와도 덮지 않는다
  await b.sync.run();
  assert.equal(item(b.store, 'i1').title, 'B가 나중에 고침');
});

test('지우기·완료도 간다(소프트 삭제가 그대로 옮겨진다)', async () => {
  const srv = fakeServer();
  const a = pc(srv);
  capture(a.store, 'i1', '지울 것');
  capture(a.store, 'i2', '끝낼 것');
  await a.sync.enable(PASS);
  const b = pc(srv);
  await b.sync.enable(PASS);
  a.store.removeItem('i1');
  a.store.completeItem('i2');
  await a.sync.run();
  await b.sync.run();
  assert.ok(item(b.store, 'i1').deleted_at);
  assert.ok(item(b.store, 'i2').done_at);
});

test('다른 PC에서 틀린 암호로는 켜지지 않는다 — 초기화하고 새 암호로 시작할 수 있다', async () => {
  const srv = fakeServer();
  const a = pc(srv);
  capture(a.store, 'i1', '비밀');
  await a.sync.enable(PASS);
  const b = pc(srv);
  const r = await b.sync.enable('wrong-pass-999');
  assert.deepEqual([r.ok, r.wrongPassword, r.error], [false, true, MSG_WRONG]);
  assert.equal(b.sync.status().enabled, false);
  assert.equal(item(b.store, 'i1'), undefined, '틀린 암호로는 아무것도 받지 않는다');
  // 초기화하고 새 암호로 — 이제 A가 서버의 행을 풀지 못한다는 것을 알린다
  assert.equal((await b.sync.enable('new-pass-456', { reset: true })).ok, true);
  // (초기화는 서버만 비운다 — B에는 처음부터 i1이 없다)
  capture(b.store, 'b1', 'B의 일');
  await b.sync.run();
  await a.sync.run();
  assert.equal(item(a.store, 'b1'), undefined);
  assert.equal(a.sync.status().lastError, MSG_WRONG);
});

test('서버는 내용을 읽지 못한다 — 암호문을 다른 행과 바꿔 끼우면 풀리지 않는다', async () => {
  const srv = fakeServer();
  const a = pc(srv);
  capture(a.store, 'i1', '견적서 회신 받기');
  capture(a.store, 'i2', '두 번째');
  await a.sync.enable(PASS);
  for (const r of srv.rows.values()) {
    if (r.blob) assert.equal(Buffer.from(r.blob, 'base64').includes(Buffer.from('견적서')), false);
  }
  // 서버가 i1 자리에 i2의 암호문을 넣는다
  const i1 = srv.rows.get('item:i1');
  const i2 = srv.rows.get('item:i2');
  srv.rows.set('item:i1', { ...i1, blob: i2.blob });
  const b = pc(srv);
  await b.sync.enable(PASS);
  assert.equal(item(b.store, 'i1'), undefined);
  assert.equal(item(b.store, 'i2').title, '두 번째');
  assert.equal(b.sync.status().lastError, MSG_WRONG);
});

test('같은 이름의 프로젝트를 두 PC에서 따로 만들면 받은 쪽에 (2)를 붙인다 — 동기화는 멈추지 않는다', async () => {
  const srv = fakeServer();
  const a = pc(srv);
  a.store.createProject('영업');
  await a.sync.enable(PASS);
  const b = pc(srv);
  b.store.createProject('영업');
  assert.equal((await b.sync.enable(PASS)).ok, true);
  const names = b.store.exportAll().project.map((p) => p.name).sort();
  assert.deepEqual(names, ['영업', '영업 (2)']);
});

test('바뀐 것이 없으면 다시 올리지 않는다 — 바뀌면 로컬 확인만으로 안다', async () => {
  const srv = fakeServer();
  const a = pc(srv);
  capture(a.store, 'i1', '하나');
  await a.sync.enable(PASS);
  // 켜기 직전 1초 안에 바뀐 행은 한 번 더 올라간다(올리기 기준이 T0 - 1초) — 서버가 같은 것으로 보고 받지 않는다
  await wait(1100);
  const r = await a.sync.run();
  assert.equal(r.pushed, 0, '같은 행을 다시 올려도 서버는 바꾸지 않는다');
  assert.equal(a.sync.hasLocalChanges(), false);
  const before = srv.calls.length;
  assert.equal((await a.sync.run()).pushed, 0);
  assert.deepEqual(srv.calls.slice(before).map((c) => c.route), ['pull'], '바뀐 게 없으면 올리기 요청을 보내지 않는다');
  a.store.renameItem('i1', '바뀜');
  assert.equal(a.sync.hasLocalChanges(), true);
  assert.equal((await a.sync.run()).pushed, 1);
});

test('실패는 던지지 않는다 — 네트워크 실패는 화면에 남기지 않는다', async () => {
  const srv = fakeServer();
  const a = pc(srv);
  await a.sync.enable(PASS);
  const dead = pc(async () => { throw new TypeError('fetch failed'); });
  assert.equal((await dead.sync.enable(PASS)).network, true);
  // 켜진 PC에서 서버가 죽어도
  const b = pc(srv);
  await b.sync.enable(PASS);
  const broken = createSync({ dir: b.dir, apiBase: 'https://api.test', fetchImpl: async () => { throw new TypeError('x'); }, protect: wrap, unprotect: wrap, store: b.store, credentials: () => ({ key: KEY, instance: b.instance }) });
  const r = await broken.run();
  assert.equal(r.ok, false);
  assert.equal(broken.status().lastError, null);
});

test('켤 수 없는 경우 — 짧은 암호, 보안 저장소 없음, Pro 아님', async () => {
  const srv = fakeServer();
  assert.match((await pc(srv).sync.enable('short')).error, /8자 이상/);
  assert.match((await pc(srv, { protect: null }).sync.enable(PASS)).error, /안전하게 보관할 수 없어/);
  assert.match((await pc(srv, { credentials: () => null }).sync.enable(PASS)).error, /Pro/);
});

test('끄면 키를 지우고 더 주고받지 않는다', async () => {
  const srv = fakeServer();
  const a = pc(srv);
  await a.sync.enable(PASS);
  a.sync.disable();
  assert.equal(JSON.parse(fs.readFileSync(a.sync.file, 'utf8')).key, undefined);
  const before = srv.calls.length;
  assert.equal((await a.sync.run()).skipped, 'off');
  assert.equal(srv.calls.length, before);
});

test('행 암호: 종류·uid·시각을 묶는다 — 하나라도 바꾸면 풀리지 않는다', () => {
  const key = deriveKey(PASS, syncSalt(KEY));
  const head = { kind: 'item', uid: 'i1', updated_at: '2026-11-14T00:00:00.000Z' };
  const blob = encryptRow(key, head, { id: 'i1', title: 't' });
  assert.equal(decryptRow(key, { ...head, blob }).title, 't');
  assert.equal(decryptRow(key, { ...head, uid: 'i2', blob }), null);
  assert.equal(decryptRow(key, { ...head, updated_at: '2027-01-01T00:00:00.000Z', blob }), null);
  assert.equal(decryptRow(key, { ...head, kind: 'project', blob }), null);
  assert.equal(decryptRow(deriveKey('other-pass-1', syncSalt(KEY)), { ...head, blob }), null);
  assert.notDeepEqual(syncSalt(KEY), syncSalt('ZZZZZ-BBBBB-CCCCC-DDDDD-EEEEE'), '구매마다 소금이 다르다');
});

test('받은 행이 이 PC의 것보다 옛것이면 반영하지 않는다 — 같은 시각도 그대로 둔다', () => {
  const { store } = pc(fakeServer());
  const pid = store.createProject('영업');
  capture(store, 'i1', '지금 것');
  const mine = item(store, 'i1');
  const uid = store.exportAll().project.find((p) => p.id === pid).uid;
  const older = new Date(Date.parse(mine.updated_at) - 60_000).toISOString();
  const r = store.applyRemote({
    project: [{ uid, name: '옛 이름', status: 'active', sort: 0, updated_at: '2000-01-01T00:00:00.000Z' }],
    item: [{ ...mine, title: '옛것', updated_at: older }, { ...mine, title: '같은 시각', updated_at: mine.updated_at }],
  });
  assert.deepEqual(r, { applied: 0, skipped: 3 });
  assert.equal(item(store, 'i1').title, '지금 것');
  assert.ok(store.getProjects().some((p) => p.name === '영업'));
  // 새것은 반영하고, 그 시각을 그대로 적는다(이 PC에서 바뀐 것으로 다시 찍지 않는다)
  const newer = new Date(Date.parse(mine.updated_at) + 60_000).toISOString();
  assert.equal(store.applyRemote({ item: [{ ...mine, title: '새것', updated_at: newer }] }).applied, 1);
  assert.deepEqual([item(store, 'i1').title, item(store, 'i1').updated_at], ['새것', newer]);
});

test('가져오기로 갈아끼운 뒤에는 옛 시각의 행도 다시 올린다', async () => {
  const srv = fakeServer();
  const a = pc(srv);
  await a.sync.enable(PASS);
  await wait(1100);
  await a.sync.run();
  a.store.importAll({ app: 'whenwork', schema_version: 3, project: [], item: [{ id: 'old1', title: '옛 파일의 항목', captured_at: '2020-01-01T00:00:00.000Z', updated_at: '2020-01-01T00:00:00.000Z' }], event: [] });
  // 파일에 적힌 옛 수정 시각 그대로 들어온다 — 올리기 기준보다 이르니 표시하지 않으면 올라가지 않는다
  a.sync.markAllDirty();
  await a.sync.run();
  assert.ok(srv.rows.has('item:old1'));
});
