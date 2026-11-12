// 라이선스 — 키 활성화·서명 토큰 보관·재검증(docs/07_Pro_설계.md D-P04~D-P07).
//
// 앱은 결제사를 직접 부르지 않는다. 내 서버(Worker)의 /v1/license/*만 부르고, 서버는 결제사에
// 확인한 결과를 **Ed25519로 서명한 토큰**으로 돌려준다. 앱은 내장 공개키로 서명을 확인한 토큰만
// 믿고, 그 내용을 entitlements.mjs에 넘긴다. 결제사를 바꿔도 앱은 그대로다.
//
// Electron을 import하지 않는다 — 파일 위치·공개키·fetch를 주입받아 node --test에서 돈다.
//
// 지키는 것:
//   - 어떤 실패도 던지지 않는다. 파일이 깨졌거나 서버가 죽었으면 "무료"일 뿐, 앱은 뜬다
//   - **네트워크 실패는 회수 사유가 아니다.** 서명된 토큰만 상태를 바꾼다 — 서버에 닿지 못한 것과
//     "구독이 끝났다"는 다른 일이다. 서버가 서명 없이 돌려준 말(오류 응답)은 화면 문구로만 쓴다
//   - 토큰은 이 기기의 instance id에 묶인다 — license.json을 다른 PC로 복사해도 그 PC에서는 무료다.
//     막으려는 건 실수로 퍼지는 것이지 작정한 우회가 아니다(D-P07: 클라이언트는 MIT 공개)
//
// 토큰 형식: v1.<kid>.<payload base64url JSON>.<signature base64url>
//   서명 대상은 "v1.<kid>.<payload>" 문자열의 UTF-8 바이트. kid로 공개키를 고른다 — 키를 바꿔야 할
//   때 새 kid를 앱에 먼저 실어 두고 서버를 옮긴다.
//   payload: { app, kind: 'lite'|'pro', instance, activatedAt, expiresAt?, revoked?, issuedAt }
//   app — 서버는 WHENDESK 시리즈 공통이다(D-P18). 다른 시리즈 앱의 토큰으로 이 앱이 열리면 안 되므로
//   app이 APP과 같은 토큰만 믿고, 요청에도 이름을 실어 보낸다(서버가 다른 앱의 키를 거절한다).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 배포된 앱이 믿는 공개키(Ed25519 raw 32바이트의 base64url). 서버를 세우는 날
// tools/license-keygen.mjs로 만들어 여기에 넣는다. **비어 있으면 어떤 토큰도 통과하지 못한다** —
// 키 없이 내보낸 빌드가 아무 토큰이나 믿는 일은 없다.
export const PUBLIC_KEYS = {};

// 라이선스 서버 주소. 도메인을 정하기 전(설계 Q5)에는 null — 활성화는 "아직 판매 전"이라고 말한다.
export const API_BASE = null;

export const APP = 'whenwork';

const TIMEOUT_MS = 5000;
const KINDS = ['lite', 'pro'];
const DAY_MS = 86400_000;

// 재검증 주기. Pro는 만료·해지를 알아야 하므로 하루, Lite는 환불만 보면 되므로 일주일.
export const REVALIDATE_MS = { pro: DAY_MS, lite: 7 * DAY_MS };

// 서버가 돌려주는 오류 코드 → 사람 말. 모르는 코드는 일반 문구로 — 내부 문자열을 그대로 보이지 않는다.
const ERRORS = {
  invalid_key: '확인되지 않는 키입니다 — 구매 메일의 키를 그대로 붙여 넣어 주세요',
  activation_limit: '이 키로 쓸 수 있는 기기 수를 넘었습니다 — 다른 기기에서 해제한 뒤 다시 시도해 주세요',
  refunded: '환불된 구매의 키입니다',
  expired: '구독이 끝난 키입니다 — 구독을 갱신하면 다시 쓸 수 있습니다',
};
const MSG_NETWORK = '라이선스 서버에 닿지 못했습니다 — 인터넷 연결을 확인하고 다시 시도해 주세요';
const MSG_NOT_SELLING = '아직 판매를 시작하지 않았습니다';
const MSG_BAD_RESPONSE = '라이선스 서버의 응답을 확인하지 못했습니다 — 잠시 뒤 다시 시도해 주세요';

const b64urlDecode = (s) => Buffer.from(String(s), 'base64url');

// 토큰 하나를 검증해 payload를 돌려준다. 어떤 이유로든 믿을 수 없으면 null.
export function verifyToken(token, { publicKeys = PUBLIC_KEYS, instance = null, app = APP } = {}) {
  try {
    const parts = String(token ?? '').split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const [ver, kid, body, sig] = parts;
    const x = Object.hasOwn(publicKeys, kid) ? publicKeys[kid] : null;
    if (!x) return null;
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
    const ok = crypto.verify(null, Buffer.from(`${ver}.${kid}.${body}`, 'utf8'), key, b64urlDecode(sig));
    if (!ok) return null;
    const payload = JSON.parse(b64urlDecode(body).toString('utf8'));
    if (!payload || typeof payload !== 'object' || !KINDS.includes(payload.kind)) return null;
    // 다른 앱의 토큰, 앱 이름이 없는 토큰은 믿지 않는다
    if (payload.app !== app) return null;
    // 다른 기기의 토큰은 믿지 않는다
    if (instance != null && payload.instance !== instance) return null;
    return payload;
  } catch {
    return null;
  }
}

// 화면에 보여줄 키 — 앞 4자와 끝 4자만
export function maskKey(key) {
  const s = String(key ?? '');
  if (s.length <= 8) return s ? '••••' : '';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

// 다시 확인할 때가 됐는가 — 마지막으로 서버가 서명해 준 시각(issuedAt) 기준
export function dueForRevalidation(payload, now = Date.now()) {
  if (!payload) return false;
  const at = Date.parse(payload.issuedAt ?? '');
  if (!Number.isFinite(at)) return true;
  return now - at >= (REVALIDATE_MS[payload.kind] ?? DAY_MS);
}

export function createLicense({
  dir,
  publicKeys = PUBLIC_KEYS,
  apiBase = API_BASE,
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const file = path.join(dir, 'license.json');
  const instanceFile = path.join(dir, 'instance-id');

  // 기기 식별자(D-P06) — 첫 실행 때 만드는 무작위 UUID. 하드웨어 정보·사용자명은 쓰지 않는다.
  let instance = null;
  function instanceId() {
    if (instance) return instance;
    try {
      const v = fs.readFileSync(instanceFile, 'utf8').trim();
      if (/^[0-9a-f-]{36}$/i.test(v)) return (instance = v);
    } catch {}
    instance = crypto.randomUUID();
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(instanceFile, instance + '\n', 'utf8');
    } catch {
      // 못 쓰면 이번 실행 동안만 쓴다 — 다음 실행에서 새 id가 나와 토큰이 무효가 되지만,
      // 그건 재활성화로 풀리는 일이고 앱을 멈출 일은 아니다
    }
    return instance;
  }

  // license.json: { lite: { key, token }, pro: { key, token } }
  function readFile() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  }

  // 쓰다 끊겨도 반쯤 쓴 파일이 남지 않게 — 임시 파일에 쓰고 바꿔 끼운다
  function writeFile(data) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }

  // 검증을 통과한 내용만. entitlements()에 그대로 넘긴다.
  function state() {
    const data = readFile();
    const out = { lite: null, pro: null };
    for (const kind of KINDS) {
      const p = verifyToken(data[kind]?.token, { publicKeys, instance: instanceId() });
      // 칸과 내용이 어긋난 토큰(pro 칸의 lite 토큰)은 믿지 않는다
      if (p && p.kind === kind) out[kind] = p;
    }
    return out;
  }

  // 설정 화면용 요약 — 키 원문은 내보내지 않는다
  function summary() {
    const data = readFile();
    const st = state();
    const out = {};
    for (const kind of KINDS) {
      out[kind] = data[kind]?.key ? { key: maskKey(data[kind].key), valid: !!st[kind] } : null;
    }
    return out;
  }

  async function call(route, body) {
    if (!apiBase || typeof fetchImpl !== 'function') return { ok: false, error: MSG_NOT_SELLING };
    let res;
    try {
      res = await fetchImpl(`${apiBase}/v1/license/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, app: APP }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, network: true, error: MSG_NETWORK };
    }
    let json = null;
    try {
      json = await res.json();
    } catch {}
    if (!res.ok || !json || typeof json !== 'object') {
      const code = json?.error;
      return { ok: false, code: code ?? null, error: ERRORS[code] ?? MSG_BAD_RESPONSE };
    }
    return { ok: true, json };
  }

  // 키를 이 기기에 활성화한다. 성공하면 { ok, kind, plan... }, 실패하면 { ok:false, error(사람 말) }.
  async function activate(rawKey) {
    const key = String(rawKey ?? '').trim();
    if (!key) return { ok: false, error: '키를 입력해 주세요' };
    const r = await call('activate', { key, instance: instanceId() });
    if (!r.ok) return { ok: false, error: r.error };
    const p = verifyToken(r.json.token, { publicKeys, instance: instanceId() });
    if (!p) return { ok: false, error: MSG_BAD_RESPONSE };
    if (p.revoked === true) return { ok: false, error: ERRORS.refunded };
    const data = readFile();
    data[p.kind] = { key, token: r.json.token };
    if (!writeFile(data)) return { ok: false, error: '라이선스를 저장하지 못했습니다' };
    return { ok: true, kind: p.kind };
  }

  // 때가 된 것만 다시 확인한다. **서명된 새 토큰이 올 때만** 바꾼다 — 네트워크 실패·서명 없는
  // 오류 응답은 지금 토큰을 그대로 둔다(유예·만료는 entitlements가 시각으로 판단한다).
  async function revalidate(now = Date.now(), { force = false } = {}) {
    const data = readFile();
    const st = state();
    const changed = [];
    for (const kind of KINDS) {
      const entry = data[kind];
      if (!entry?.key) continue;
      // 검증이 깨진 토큰(다른 기기에서 복사 등)도 키가 있으면 다시 받아 본다
      if (!force && st[kind] && !dueForRevalidation(st[kind], now)) continue;
      const r = await call('validate', { key: entry.key, instance: instanceId() });
      if (!r.ok) continue;
      const p = verifyToken(r.json.token, { publicKeys, instance: instanceId() });
      if (!p || p.kind !== kind) continue;
      data[kind] = { key: entry.key, token: r.json.token };
      changed.push(kind);
    }
    if (changed.length) writeFile(data);
    return { changed };
  }

  // 앱 안에서 결제한 직후 — 키를 입력하지 않고 받아 온다. 결제 알림이 서버에서 이 기기에 이미 켜 두었다.
  // 아직 알림이 안 왔으면 { ok:false, pending:true } — 호출부가 잠시 뒤 다시 묻는다.
  async function claim() {
    const r = await call('claim', { instance: instanceId() });
    if (!r.ok) return { ok: false, pending: r.code === 'pending', error: r.error };
    const data = readFile();
    const kinds = [];
    for (const lic of Array.isArray(r.json.licenses) ? r.json.licenses : []) {
      const p = verifyToken(lic?.token, { publicKeys, instance: instanceId() });
      if (!p || p.kind !== lic.kind || p.revoked === true || typeof lic.key !== 'string') continue;
      data[p.kind] = { key: lic.key, token: lic.token };
      kinds.push(p.kind);
    }
    if (!kinds.length) return { ok: false, pending: false, error: MSG_BAD_RESPONSE };
    if (!writeFile(data)) return { ok: false, error: '라이선스를 저장하지 못했습니다' };
    return { ok: true, kinds };
  }

  // 이 기기에서 해제한다. 로컬에서는 **항상** 지운다 — 서버에 닿지 못해도 사용자가 "지웠다"고
  // 본 것이 남아 있으면 안 된다. 서버 쪽 기기 칸은 다음에 닿을 때 풀리도록 결과만 알린다.
  async function deactivate(kind) {
    if (!KINDS.includes(kind)) return { ok: false, error: '알 수 없는 라이선스입니다' };
    const data = readFile();
    const entry = data[kind];
    if (!entry) return { ok: true, server: true };
    const r = entry.key ? await call('deactivate', { key: entry.key, instance: instanceId() }) : { ok: true };
    delete data[kind];
    const saved = writeFile(data);
    if (!saved) return { ok: false, error: '라이선스를 지우지 못했습니다' };
    return { ok: true, server: r.ok };
  }

  return { instanceId, state, summary, activate, claim, revalidate, deactivate, file };
}
