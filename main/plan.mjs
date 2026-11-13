// main/plan.mjs — 지금 이 앱이 무엇을 허용하나. IPC·렌더러·제한 검사가 묻는 단 하나의 답(D-P02·D-P03).
//
// 판매가 열리기 전(서버 주소·공개키가 비어 있는 빌드)에는 **제한을 걸지 않는다.** 결제할 길이 없는데
// 광고를 띄우고 프로젝트를 3개로 묶으면 그건 그냥 기능을 빼앗는 것이다(docs/07 D-P02 메모).
// 판매가 열린 빌드에서만 라이선스 상태로 entitlements를 계산한다.
import { entitlements, canAddProject, FREE_PROJECT_LIMIT } from './entitlements.mjs';
import { API_BASE, PUBLIC_KEYS } from './license.mjs';

export const SALES_OPEN = !!API_BASE && Object.keys(PUBLIC_KEYS).length > 0;

// 구매 안내 페이지 — 렌더러가 임의 주소를 열지 못하게 여기서만 정한다
export const SHOP_URL = 'https://whendesk.app/work';
const BUY_URL = 'https://whendesk.app/buy';
// Lite(한 번)와 Pro(연 구독). Pro는 자동 클라우드 백업이 생기며 열었다(docs/07 D-P19·D-P24)
export const BUY_KINDS = ['lite', 'pro'];

// 앱 안 구매 — 결제 페이지에 이 기기 번호를 실어 보낸다. 서버가 결제 알림을 받으면 그 기기에
// 키를 켜 두고, 앱은 claim으로 받아 간다(키를 입력하지 않는다). 기기 번호는 무작위 UUID라 무엇을
// 드러내지 않는다(D-P06).
// 지켜보던 구매가 들어왔나 — claim 결과에 그 종류가 있어야 한다
export function purchaseArrived(claimResult, kind) {
  return !!claimResult?.ok && Array.isArray(claimResult.kinds) && claimResult.kinds.includes(kind);
}

export function buyUrl(kind, instance) {
  if (!BUY_KINDS.includes(kind)) return null;
  const q = new URLSearchParams({ plan: kind, app: 'whenwork', i: String(instance ?? '') });
  return `${BUY_URL}?${q}`;
}

const OPEN = Object.freeze({ plan: 'open', ads: false, projectLimit: null, backup: false, sync: false, proExpiresAt: null, proGraceUntil: null });

export function currentPlan({ selling = SALES_OPEN, licenseState = {}, now = new Date() } = {}) {
  if (!selling) return { ...OPEN };
  return entitlements(licenseState ?? {}, now);
}

// 프로젝트를 하나 더 만들(되살릴) 수 있나. 막을 때 화면이 말할 근거(limit)를 함께 준다.
export function projectGate(plan, activeCount) {
  if (canAddProject(plan, activeCount)) return { ok: true };
  return { ok: false, reason: 'limit', limit: plan?.projectLimit ?? FREE_PROJECT_LIMIT };
}
