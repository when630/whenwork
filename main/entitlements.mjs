// 엔타이틀먼트 — 앱이 "무엇을 허용하나"를 묻는 단 하나의 길(docs/07_Pro_설계.md D-P02).
//
// Electron·저장소·네트워크 없이 검증할 수 있게 순수 함수로 둔다. 앱의 다른 어디도 라이선스
// 원문을 직접 해석하지 않는다 — 광고를 띄울지, 프로젝트를 더 만들게 할지는 전부 이 결과만 본다.
//
// 입력은 서명을 이미 확인한 라이선스 내용(main/license.mjs가 맡는다)이다. 여기서는 위조를
// 의심하지 않는다. 대신 **모양이 깨진 입력은 무료로 본다** — 던지지 않는다. 라이선스 파일 하나가
// 깨졌다고 앱이 뜨지 않으면, 그건 결제가 캡처를 막는 것이다(설계의 원칙 1).
//
// 요금제(docs/07_Pro_설계.md "상품"):
//   무료 — 광고 한 줄 + 프로젝트 FREE_PROJECT_LIMIT개
//   Lite — 일회성. 광고 없음 + 프로젝트 무제한 (서버 비용이 없는 기능만)
//   Pro  — 연 구독. Lite 전부 + 클라우드 백업 + 동기화 (서버에 데이터를 두는 기능)
//
// 두 라이선스는 따로 들어온다. Lite를 먼저 사고 나중에 Pro를 구독할 수 있고, Pro가 끝나도
// 따로 산 Lite는 남아야 한다:
//   lite   — { activatedAt, revoked? }         일회성. 한 번 활성화되면 영구
//   pro    — { expiresAt, revoked?, checkedAt? } 연 구독. 만료 뒤 PRO_GRACE_DAYS 동안 유예

export const FREE_PROJECT_LIMIT = 3;

// Pro 만료 뒤에도 기능을 유지하는 날 수(D-P05). 구독 갱신이 결제사에서 하루 이틀 늦게 반영되거나,
// 그 사이 서버에 닿지 못한 사람이 하루아침에 프로젝트를 못 만들게 되지 않도록.
export const PRO_GRACE_DAYS = 14;

const DAY_MS = 86400_000;

// ISO 문자열·Date·밀리초를 밀리초로. 읽을 수 없으면 null — 호출부가 "모른다"를 "무료"로 다룬다.
function toMs(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function isObj(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Lite가 유효한가. 회수는 서버가 revoked를 **명시적으로** 돌려줄 때만이다(환불) —
// 재검증 실패·오프라인은 회수 사유가 아니다(D-P05). 그 구분은 license.mjs가 하고, 여기에는
// 결과로 revoked: true만 들어온다.
function liteActive(lite) {
  return isObj(lite) && lite.revoked !== true && toMs(lite.activatedAt) != null;
}

// Pro 상태: 'active' | 'grace' | null
function proState(pro, nowMs) {
  if (!isObj(pro) || pro.revoked === true) return null;
  const exp = toMs(pro.expiresAt);
  if (exp == null) return null;
  if (nowMs <= exp) return 'active';
  if (nowMs <= exp + PRO_GRACE_DAYS * DAY_MS) return 'grace';
  return null;
}

/**
 * @returns {{
 *   plan: 'free'|'lite'|'pro',
 *   ads: boolean,
 *   projectLimit: number|null,  // null = 제한 없음 (IPC·JSON에 Infinity를 싣지 않으려고)
 *   backup: boolean,
 *   sync: boolean,
 *   proExpiresAt: string|null,  // Pro일 때만 — 설정 화면이 "언제까지"를 말한다
 *   proGraceUntil: string|null, // 유예 중일 때만 — "갱신이 확인되지 않았어요"를 띄울 근거
 * }}
 */
export function entitlements({ lite = null, pro = null } = {}, now = new Date()) {
  const nowMs = toMs(now) ?? Date.now();
  const ps = proState(pro, nowMs);
  const af = liteActive(lite);

  if (ps) {
    const exp = toMs(pro.expiresAt);
    return {
      plan: 'pro',
      ads: false,
      projectLimit: null,
      backup: true,
      sync: true,
      proExpiresAt: new Date(exp).toISOString(),
      proGraceUntil: ps === 'grace' ? new Date(exp + PRO_GRACE_DAYS * DAY_MS).toISOString() : null,
    };
  }
  // Lite는 로컬 제한(광고·프로젝트 수)만 푼다 — 서버 기능(백업·동기화)은 Pro만
  return {
    plan: af ? 'lite' : 'free',
    ads: !af,
    projectLimit: af ? null : FREE_PROJECT_LIMIT,
    backup: false,
    sync: false,
    proExpiresAt: null,
    proGraceUntil: null,
  };
}

// 프로젝트를 하나 더 만들 수 있나(D-P11~13). activeCount는 status='active'만 센 수다 —
// 지운 프로젝트는 세지 않는다. 이미 제한을 넘게 쓰는 사람(그랜드파더)도 이 함수로는 아무것도
// 잃지 않는다: 새로 만들기·되살리기만 이 답을 묻고, 있는 프로젝트는 그대로 쓴다.
export function canAddProject(ent, activeCount) {
  const limit = ent?.projectLimit;
  if (limit == null) return true;
  const n = Number(activeCount);
  // 개수를 모르면 막지 않는다 — 저장소가 잠깐 못 읽은 걸로 사용자를 막을 이유가 없다
  if (!Number.isFinite(n)) return true;
  return n < limit;
}
