// 자동 클라우드 백업 — Pro(docs/07 "자동 클라우드 백업", D-P23).
//
// 내보내기와 같은 JSON(store.exportAll)을 **이 기기에서** 압축·암호화해 서버(api.whendesk.app)에 올린다.
// 키는 사용자가 정한 백업 암호에서 scrypt로 만든다 — 서버는 암호도 키도 받지 않아 내용을 읽을 수 없다.
// 암호를 잊으면 아무도 복구할 수 없다(설정 화면이 켤 때 한 번 확인받는다).
//
// 매일 자동으로 올리려면 키를 기기에 둬야 한다 — OS 보안 저장소(Electron safeStorage: Windows DPAPI,
// macOS 키체인)로 감싼 것만 backup.json에 둔다. 감싸기를 쓸 수 없는 기기에서는 켜지 않는다.
//
// 형식(WWB1): "WWB1" | 헤더 길이(u32 BE) | 헤더 JSON | 암호문 | GCM 태그(16)
//   헤더: { v, kdf: { alg: 'scrypt', N, r, p, salt }, iv, app, createdAt, appVersion }
//   헤더 바이트 전체를 AAD로 묶는다 — 헤더를 바꿔 끼우면 복호화가 실패한다
//   본문: gzip(내보내기 JSON)
//
// 어떤 실패도 던지지 않는다 — 백업이 캡처를 막지 않는다(원칙 1). 결과는 { ok, error } 로.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const MAGIC = Buffer.from('WWB1', 'ascii');
const KDF = { alg: 'scrypt', N: 1 << 15, r: 8, p: 1 };
const MIN_GAP_MS = 20 * 3600_000; // 하루 한 번 꼴 — 앱을 켤 때마다 올리지 않게
const TIMEOUT_MS = 30_000;
export const MIN_PASSWORD = 8;

const ERRORS = {
  not_pro: 'Pro 구독에서 쓸 수 있습니다',
  expired: 'Pro 구독이 끝났습니다 — 백업은 끝난 뒤 90일까지 내려받을 수 있습니다',
  refunded: '환불된 구독입니다',
  not_activated: '이 PC에서 Pro를 다시 확인해 주세요 — 설정 → 라이선스 → 구매 복원',
  too_large: '백업이 너무 큽니다(20MB)',
  not_found: '그 백업을 찾지 못했습니다',
};
const MSG_NETWORK = '백업 서버에 닿지 못했습니다 — 인터넷 연결을 확인해 주세요';
const MSG_PASSWORD = '백업 암호가 맞지 않습니다';

export function deriveKey(password, salt) {
  return crypto.scryptSync(String(password).normalize('NFC'), salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 128 * 1024 * 1024 });
}

export function seal(json, key, salt, meta = {}) {
  const iv = crypto.randomBytes(12);
  const header = Buffer.from(JSON.stringify({ v: 1, kdf: { ...KDF, salt: salt.toString('base64') }, iv: iv.toString('base64'), ...meta }), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  const head = Buffer.concat([MAGIC, len, header]);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(head);
  const body = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(JSON.stringify(json), 'utf8'))), c.final()]);
  return Buffer.concat([head, body, c.getAuthTag()]);
}

export function readHeader(buf) {
  const b = Buffer.from(buf);
  if (b.length < 8 + 16 || !b.subarray(0, 4).equals(MAGIC)) return null;
  const n = b.readUInt32BE(4);
  if (n > 4096 || b.length < 8 + n + 16) return null;
  try {
    const header = JSON.parse(b.subarray(8, 8 + n).toString('utf8'));
    return header?.v === 1 && header.kdf?.alg === 'scrypt' ? { header, headLen: 8 + n } : null;
  } catch {
    return null;
  }
}

// 키로 연다. 틀린 키·손상된 덩어리면 null
export function open(buf, key) {
  const b = Buffer.from(buf);
  const h = readHeader(b);
  if (!h) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(h.header.iv, 'base64'));
    d.setAAD(b.subarray(0, h.headLen));
    d.setAuthTag(b.subarray(b.length - 16));
    const plain = Buffer.concat([d.update(b.subarray(h.headLen, b.length - 16)), d.final()]);
    return JSON.parse(zlib.gunzipSync(plain).toString('utf8'));
  } catch {
    return null;
  }
}

// 바뀌었는지 — 내보낸 시각은 매번 달라지니 빼고 잰다
export function contentHash(data) {
  const { exported_at, ...rest } = data ?? {};
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

export function createBackup({
  dir,
  apiBase,
  app = 'whenwork',
  appVersion = '0',
  fetchImpl = globalThis.fetch,
  protect = null, // (Buffer) => Buffer — OS 보안 저장소로 감싸기
  unprotect = null, // (Buffer) => Buffer
  exportData, // () => 내보내기 JSON
  importData, // (json) => { project, item, ... } — 직전 상태를 백업하고 갈아끼운다
  validate = () => null, // (json) => 오류 문구 | null
  credentials, // () => { key, instance } | null — 이 기기의 Pro 키
} = {}) {
  const file = path.join(dir, 'backup.json');

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

  function storedKey(cfg = read()) {
    if (!cfg.enabled || !cfg.key || typeof unprotect !== 'function') return null;
    try {
      return unprotect(Buffer.from(cfg.key, 'base64'));
    } catch {
      return null;
    }
  }

  async function call(route, { method = 'POST', body, headers = {}, binary = false } = {}) {
    if (!apiBase || typeof fetchImpl !== 'function') return { ok: false, error: '아직 판매를 시작하지 않았습니다' };
    let r;
    try {
      r = await fetchImpl(`${apiBase}/v1/backup/${route}`, { method, body, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      return { ok: false, network: true, error: MSG_NETWORK };
    }
    if (r.ok && binary) return { ok: true, bytes: Buffer.from(await r.arrayBuffer()) };
    let j = null;
    try {
      j = await r.json();
    } catch {}
    if (!r.ok) return { ok: false, code: j?.error ?? null, error: ERRORS[j?.error] ?? '백업 서버의 응답을 확인하지 못했습니다' };
    return { ok: true, json: j };
  }

  function who() {
    const c = typeof credentials === 'function' ? credentials() : null;
    return c?.key && c?.instance ? { key: c.key, instance: c.instance, app } : null;
  }

  // 화면용 — 키·암호는 내보내지 않는다
  function status() {
    const c = read();
    return { enabled: !!c.enabled, lastAt: c.lastAt ?? null, lastError: c.lastError ?? null, canProtect: typeof protect === 'function' };
  }

  // 켜기 — 암호로 키를 만들고, OS 보안 저장소로 감싸 두고, 바로 한 번 올린다
  async function enable(password, now = Date.now()) {
    if (String(password ?? '').length < MIN_PASSWORD) return { ok: false, error: `백업 암호는 ${MIN_PASSWORD}자 이상으로 정해 주세요` };
    if (typeof protect !== 'function') return { ok: false, error: '이 PC에서는 키를 안전하게 보관할 수 없어 자동 백업을 켤 수 없습니다' };
    if (!who()) return { ok: false, error: ERRORS.not_pro };
    const salt = crypto.randomBytes(16);
    const key = deriveKey(password, salt);
    let wrapped;
    try {
      wrapped = protect(key);
    } catch {
      return { ok: false, error: '이 PC에서는 키를 안전하게 보관할 수 없어 자동 백업을 켤 수 없습니다' };
    }
    if (!write({ enabled: true, salt: salt.toString('base64'), key: Buffer.from(wrapped).toString('base64'), lastAt: null, lastHash: null, lastError: null })) {
      return { ok: false, error: '백업 설정을 저장하지 못했습니다' };
    }
    return run({ force: true, now });
  }

  // 끄기 — 이 기기의 키만 지운다. 서버의 백업은 보관 규칙대로 남았다가 사라진다
  function disable() {
    const c = read();
    write({ enabled: false, lastAt: c.lastAt ?? null });
    return { ok: true };
  }

  // 때가 됐고 바뀐 게 있으면 올린다. force면 바로(바뀐 게 없어도)
  async function run({ force = false, now = Date.now() } = {}) {
    const c = read();
    if (!c.enabled) return { ok: false, skipped: 'off' };
    if (!force && c.lastAt && now - Date.parse(c.lastAt) < MIN_GAP_MS) return { ok: true, skipped: 'recent' };
    const id = who();
    if (!id) return { ok: false, skipped: 'not_pro' };
    const key = storedKey(c);
    if (!key) return note(c, { ok: false, error: '백업 키를 읽지 못했습니다 — 백업을 다시 켜 주세요' });
    let data;
    try {
      data = exportData();
    } catch {
      return note(c, { ok: false, error: '백업할 데이터를 읽지 못했습니다' });
    }
    const hash = contentHash(data);
    if (!force && hash === c.lastHash) return { ok: true, skipped: 'unchanged' };
    const blob = seal(data, key, Buffer.from(c.salt, 'base64'), { app, createdAt: new Date(now).toISOString(), appVersion });
    const r = await call('upload', {
      method: 'PUT',
      body: blob,
      headers: { 'content-type': 'application/octet-stream', 'x-license-key': id.key, 'x-instance': id.instance, 'x-app': app },
    });
    if (!r.ok) return note(c, r);
    write({ ...c, lastAt: new Date(now).toISOString(), lastHash: hash, lastError: null });
    return { ok: true, id: r.json?.id, size: blob.length };
  }

  function note(c, r) {
    // 네트워크 실패는 화면에 남기지 않는다 — 다음 시도에서 풀린다
    if (!r.network) write({ ...c, lastError: r.error ?? null });
    return r;
  }

  async function list() {
    const id = who();
    if (!id) return { ok: false, error: ERRORS.not_pro };
    const r = await call('list', { body: JSON.stringify(id), headers: { 'content-type': 'application/json' } });
    return r.ok ? { ok: true, backups: Array.isArray(r.json?.backups) ? r.json.backups : [] } : r;
  }

  // 복원 — 그 백업을 내려받아 연다. 이 기기에 키가 있고 같은 소금으로 만든 백업이면 암호 없이,
  // 아니면(다른 PC·다시 설치·암호를 바꾼 뒤) 암호로. 가져오기는 직전 상태를 백업하고 갈아끼운다.
  async function restore(backupId, password = null) {
    const id = who();
    if (!id) return { ok: false, error: ERRORS.not_pro };
    const r = await call('download', { body: JSON.stringify({ ...id, id: backupId }), headers: { 'content-type': 'application/json' }, binary: true });
    if (!r.ok) return r;
    const h = readHeader(r.bytes);
    if (!h) return { ok: false, error: '백업 파일이 손상되었습니다' };
    const c = read();
    let data = null;
    if (password) data = open(r.bytes, deriveKey(password, Buffer.from(h.header.kdf.salt, 'base64')));
    else if (c.salt === h.header.kdf.salt) data = open(r.bytes, storedKey(c) ?? Buffer.alloc(32));
    if (!data) return { ok: false, needPassword: !password, error: password ? MSG_PASSWORD : '이 백업은 백업 암호가 필요합니다' };
    const bad = validate(data);
    if (bad) return { ok: false, error: bad };
    try {
      return { ok: true, ...importData(data) };
    } catch {
      return { ok: false, error: '복원하지 못했습니다' };
    }
  }

  return { status, enable, disable, run, list, restore, file };
}
