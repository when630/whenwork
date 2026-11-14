// 기기 간 동기화 — Pro(docs/07 D-P26). 행(프로젝트·항목)을 이 기기에서 암호화해 서버와 주고받는다.
//
// 키: 사용자가 정한 동기화 암호 + 구매 키에서 계산한 소금 → scrypt. 같은 구매의 모든 기기가 같은 키를
//     만든다(소금을 서버에 둘 필요가 없다). 서버는 구매 키를 알지만 암호를 모르므로 내용을 읽지 못한다.
//     자동으로 주고받으려고 키는 OS 보안 저장소(safeStorage)로 감싸 sync.json에 둔다 — 백업과 같다.
// 암호 확인: 서버에 meta/check 행 하나를 둔다. 다른 기기에서 틀린 암호로 켜면 그 행이 풀리지 않아 거절한다.
// 행 암호문: base64(iv 12 | AES-256-GCM 암호문 | 태그 16). AAD = 종류·uid·updated_at·deleted —
//     서버가 행끼리 암호문을 바꿔 끼우거나 시각을 고치면 풀리지 않는다.
//
// 한 번 돌기(run): ① 기준 시각 T0 ② 마지막 올린 뒤 바뀐 행을 올림 ③ 내 커서 이후를 모두 받아 반영
//     ④ 다음 올리기 기준을 T0 - 1초로. 받은 행이 다시 올라가는 일이 생겨도 서버가 같은 결론을 내므로 해가 없다.
// 어떤 실패도 던지지 않는다 — 동기화가 캡처를 막지 않는다(원칙 1).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deriveKey, MIN_PASSWORD } from './backup.mjs';

const PUSH_CHUNK = 500;
const PULL_LIMIT = 1000;
const MAX_PAGES = 200; // 한 번에 최대 20만 행 — 그 이상은 다음 번에 이어 받는다
const TIMEOUT_MS = 30_000;
const CHECK = { kind: 'meta', uid: 'check', updated_at: '2000-01-01T00:00:00.000Z' };
const CHECK_TEXT = 'whenwork-sync-v1';

const ERRORS = {
  not_pro: 'Pro 구독에서 쓸 수 있습니다',
  expired: 'Pro 구독이 끝났습니다',
  refunded: '환불된 구독입니다',
  not_activated: '이 PC에서 Pro를 다시 확인해 주세요 — 설정 → 라이선스 → 구매 복원',
  quota: '동기화할 수 있는 항목 수를 넘었습니다',
};
const MSG_NETWORK = '동기화 서버에 닿지 못했습니다 — 인터넷 연결을 확인해 주세요';
export const MSG_WRONG = '다른 PC에서 정한 동기화 암호와 다릅니다';

export function syncSalt(licenseKey) {
  return crypto.createHash('sha256').update(`whenwork-sync-salt:${licenseKey}`).digest().subarray(0, 16);
}

const aad = (kind, uid, updatedAt, deleted) => Buffer.from(`${kind}\n${uid}\n${updatedAt}\n${deleted ? 1 : 0}`, 'utf8');

export function encryptRow(key, { kind, uid, updated_at, deleted = false }, data) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(kind, uid, updated_at, deleted));
  const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(data), 'utf8')), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]).toString('base64');
}

export function decryptRow(key, { kind, uid, updated_at, deleted = false, blob }) {
  try {
    const b = Buffer.from(String(blob ?? ''), 'base64');
    if (b.length < 12 + 16) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAAD(aad(kind, uid, updated_at, deleted));
    d.setAuthTag(b.subarray(b.length - 16));
    return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

export function createSync({
  dir,
  apiBase,
  app = 'whenwork',
  fetchImpl = globalThis.fetch,
  protect = null,
  unprotect = null,
  store, // syncChanges(since) · applyRemote({project, item})
  credentials, // () => { key, instance } | null — 이 기기의 Pro
  clock = () => Date.now(),
} = {}) {
  const file = path.join(dir, 'sync.json');
  let running = false;

  function read() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  }
  function write(j) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(j, null, 2) + '\n', 'utf8');
      fs.renameSync(`${file}.tmp`, file);
      return true;
    } catch {
      return false;
    }
  }
  function who() {
    const c = typeof credentials === 'function' ? credentials() : null;
    return c?.key && c?.instance ? c : null;
  }
  function storedKey(c = read()) {
    if (!c.enabled || !c.key || typeof unprotect !== 'function') return null;
    try {
      return unprotect(Buffer.from(c.key, 'base64'));
    } catch {
      return null;
    }
  }

  async function call(route, body) {
    if (!apiBase || typeof fetchImpl !== 'function') return { ok: false, error: '아직 판매를 시작하지 않았습니다' };
    let r;
    try {
      r = await fetchImpl(`${apiBase}/v1/sync/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, app }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false, network: true, error: MSG_NETWORK };
    }
    let j = null;
    try {
      j = await r.json();
    } catch {}
    if (!r.ok) return { ok: false, code: j?.error ?? null, error: ERRORS[j?.error] ?? '동기화 서버의 응답을 확인하지 못했습니다' };
    return { ok: true, json: j };
  }

  async function pullAll(id, since) {
    const rows = [];
    let cursor = since;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await call('pull', { key: id.key, instance: id.instance, since: cursor, limit: PULL_LIMIT });
      if (!r.ok) return r;
      rows.push(...(r.json?.rows ?? []));
      cursor = Number(r.json?.cursor ?? cursor);
      if (!r.json?.more) break;
    }
    return { ok: true, rows, cursor };
  }

  async function pushRows(id, rows) {
    let pushed = 0;
    let rejected = 0;
    for (let i = 0; i < rows.length; i += PUSH_CHUNK) {
      const r = await call('push', { key: id.key, instance: id.instance, rows: rows.slice(i, i + PUSH_CHUNK) });
      if (!r.ok) return r;
      pushed += r.json?.applied ?? 0;
      rejected += r.json?.rejected?.length ?? 0;
    }
    return { ok: true, pushed, rejected };
  }

  // 받은 행을 풀어 store 모양으로. 내 기기가 올린 것은 건너뛴다(이미 갖고 있다)
  function decode(key, rows, instance) {
    const out = { project: [], item: [] };
    let bad = 0;
    for (const r of rows) {
      if (r.kind === 'meta' || r.device === instance) continue;
      if (r.kind !== 'project' && r.kind !== 'item') continue;
      if (r.blob == null) continue; // 묘비 — 앱은 행을 지우지 않고 deleted_at으로 남기므로 지금은 쓸 일이 없다
      const data = decryptRow(key, r);
      if (!data) {
        bad++;
        continue;
      }
      // 암호문 안의 id와 바깥 uid가 다르면 버린다(바꿔 끼우기)
      if (r.kind === 'project' && data.uid !== r.uid) { bad++; continue; }
      if (r.kind === 'item' && data.id !== r.uid) { bad++; continue; }
      out[r.kind].push({ ...data, updated_at: r.updated_at });
    }
    return { out, bad };
  }

  function encode(key, changes) {
    const rows = [];
    for (const p of changes.project) {
      const head = { kind: 'project', uid: p.uid, updated_at: p.updated_at };
      rows.push({ ...head, deleted: false, blob: encryptRow(key, head, p) });
    }
    for (const it of changes.item) {
      const head = { kind: 'item', uid: it.id, updated_at: it.updated_at };
      rows.push({ ...head, deleted: false, blob: encryptRow(key, head, it) });
    }
    return rows;
  }

  function status() {
    const c = read();
    return { enabled: !!c.enabled, lastAt: c.lastAt ?? null, lastError: c.lastError ?? null, canProtect: typeof protect === 'function' };
  }

  // 켜기 — 암호를 확인(서버에 확인 행이 있으면 풀려야 한다)하고, 받은 것을 반영한 뒤 이 기기의 것을 모두 올린다.
  // reset이면 서버의 이 구매 동기화 기록을 지우고 이 암호로 새로 시작한다(암호를 바꾸거나 잊었을 때).
  async function enable(password, { reset = false } = {}) {
    if (String(password ?? '').length < MIN_PASSWORD) return { ok: false, error: `동기화 암호는 ${MIN_PASSWORD}자 이상으로 정해 주세요` };
    if (typeof protect !== 'function') return { ok: false, error: '이 PC에서는 키를 안전하게 보관할 수 없어 동기화를 켤 수 없습니다' };
    const id = who();
    if (!id) return { ok: false, error: ERRORS.not_pro };
    if (running) return { ok: false, error: '동기화하는 중입니다' };
    running = true;
    try {
      const key = deriveKey(password, syncSalt(id.key));
      if (reset) {
        const r = await call('reset', { key: id.key, instance: id.instance });
        if (!r.ok) return r;
      }
      const pulled = await pullAll(id, 0);
      if (!pulled.ok) return pulled;
      const check = pulled.rows.find((r) => r.kind === 'meta' && r.uid === CHECK.uid);
      if (check) {
        const v = decryptRow(key, check);
        if (v?.check !== CHECK_TEXT) return { ok: false, wrongPassword: true, error: MSG_WRONG };
      } else {
        const p = await pushRows(id, [{ ...CHECK, deleted: false, blob: encryptRow(key, CHECK, { check: CHECK_TEXT }) }]);
        if (!p.ok) return p;
      }
      let wrapped;
      try {
        wrapped = Buffer.from(protect(key)).toString('base64');
      } catch {
        return { ok: false, error: '이 PC에서는 키를 안전하게 보관할 수 없어 동기화를 켤 수 없습니다' };
      }
      // 받은 것부터 반영 — 그다음 이 기기의 모든 행을 올린다(서버가 나중 것을 남긴다)
      const { out, bad } = decode(key, pulled.rows, id.instance);
      const applied = store.applyRemote(out).applied;
      const t0 = clock();
      const pushed = await pushRows(id, encode(key, store.syncChanges('')));
      if (!pushed.ok) return pushed;
      if (!write({ enabled: true, key: wrapped, cursor: pulled.cursor, watermark: new Date(t0 - 1000).toISOString(), lastAt: new Date(clock()).toISOString(), lastError: bad ? MSG_WRONG : null })) {
        return { ok: false, error: '동기화 설정을 저장하지 못했습니다' };
      }
      return { ok: true, pulled: applied, pushed: pushed.pushed };
    } catch {
      return { ok: false, error: '동기화를 켜지 못했습니다' };
    } finally {
      running = false;
    }
  }

  function disable() {
    const c = read();
    write({ enabled: false, lastAt: c.lastAt ?? null });
    return { ok: true };
  }

  // 이 기기에서 마지막 올린 뒤 바뀐 것이 있나 — 서버를 부르지 않는다(1분마다 물어도 싸다)
  function hasLocalChanges() {
    const c = read();
    if (!c.enabled) return false;
    try {
      const ch = store.syncChanges(c.watermark ?? '');
      return ch.project.length + ch.item.length > 0;
    } catch {
      return false;
    }
  }

  async function run() {
    const c = read();
    if (!c.enabled) return { ok: false, skipped: 'off' };
    const id = who();
    if (!id) return { ok: false, skipped: 'not_pro' };
    if (running) return { ok: false, skipped: 'running' };
    const key = storedKey(c);
    if (!key) return note(c, { ok: false, error: '동기화 키를 읽지 못했습니다 — 동기화를 다시 켜 주세요' });
    running = true;
    try {
      const t0 = clock();
      const changes = store.syncChanges(c.watermark ?? '');
      const pushed = await pushRows(id, encode(key, changes));
      if (!pushed.ok) return note(c, pushed);
      const pulled = await pullAll(id, Number(c.cursor ?? 0));
      if (!pulled.ok) return note(c, pulled);
      const { out, bad } = decode(key, pulled.rows, id.instance);
      const applied = store.applyRemote(out).applied;
      write({ ...read(), cursor: pulled.cursor, watermark: new Date(t0 - 1000).toISOString(), lastAt: new Date(clock()).toISOString(), lastError: bad ? MSG_WRONG : null });
      return { ok: true, pushed: pushed.pushed, pulled: applied, bad };
    } catch {
      return note(c, { ok: false, error: '동기화하지 못했습니다' });
    } finally {
      running = false;
    }
  }

  function note(c, r) {
    if (!r.network) write({ ...read(), lastError: r.error ?? null });
    return r;
  }

  // 가져오기·백업 복원으로 행을 통째로 갈아끼웠다 — 옛 시각을 가진 행도 다음에 모두 올린다(서버가 나중 것을 남긴다)
  function markAllDirty() {
    const c = read();
    if (c.enabled) write({ ...c, watermark: '' });
  }

  return { status, enable, disable, run, hasLocalChanges, markAllDirty, file };
}
