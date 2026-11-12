// 광고 한 줄·커피 사주기 링크(docs/07 D-P08~D-P10·D-P22) — 서버(api.whendesk.app/v1/ads)가 내려준다.
//
// Electron 없이 테스트할 수 있게 파일 위치·fetch·서버 주소를 주입받는다.
//
// 지키는 것:
//   - 받는 데 실패해도 아무것도 깨지지 않는다. 마지막으로 받은 목록(ads-cache.json)을 쓰고, 그것도 없으면
//     앱에 들어 있는 하우스 광고(Lite 안내)만 띄운다
//   - 보내는 것은 앱 이름·버전·OS뿐(원칙 5 — 추적하지 않는다). 기기 번호·라이선스는 보내지 않는다
//   - 광고 주소를 받지 않는다. 누르면 서버의 /go/<id>를 연다 — 주소는 서버만 안다
//   - 하루 한 번만 묻는다(서버가 ttl로 정하고, 6시간보다 자주는 묻지 않는다)
import fs from 'node:fs';
import path from 'node:path';

export const HOUSE_AD = Object.freeze({ id: 'house-lite', strong: 'WHENWORK Lite', text: '광고 없이, 프로젝트 제한 없이 · 9,900원 한 번', weight: 1, house: true });

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MIN_TTL_S = 6 * 3600;
const MAX_TTL_S = 7 * 86400;
const TIMEOUT_MS = 5000;

// 서버가 준 것을 그대로 믿지 않는다 — 모양이 맞는 것만, 길이를 잘라서
export function sanitize(json) {
  const ads = (Array.isArray(json?.ads) ? json.ads : [])
    .filter((a) => a && ID.test(a.id) && typeof a.text === 'string' && a.text.trim())
    .slice(0, 20)
    .map((a) => ({
      id: a.id,
      strong: typeof a.strong === 'string' && a.strong.trim() ? a.strong.trim().slice(0, 30) : null,
      text: a.text.trim().slice(0, 80),
      weight: Math.min(Math.max(1, Number(a.weight) | 0), 10),
    }));
  const label = json?.support && typeof json.support.label === 'string' ? json.support.label.trim().slice(0, 30) : '';
  const ttl = Math.min(Math.max(Number(json?.ttl) || 0, MIN_TTL_S), MAX_TTL_S);
  return { ads, support: label ? { label } : null, ttl };
}

// 오늘 띄울 광고 하나 — 하우스 광고와 서버 광고를 무게대로 섞어 날짜마다 돌린다.
// 같은 날에는 창을 다시 열어도 같은 광고다(깜박이며 바뀌면 그게 더 거슬린다).
export function pickAd(ads, day = new Date()) {
  const pool = [HOUSE_AD, ...(ads ?? [])];
  const slots = pool.flatMap((a) => Array(a.weight ?? 1).fill(a));
  const n = Math.floor(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) / 86400_000);
  return slots[((n % slots.length) + slots.length) % slots.length];
}

export function createAds({ dir, apiBase, app = 'whenwork', version = '0', os = 'unknown', fetchImpl = globalThis.fetch } = {}) {
  const file = path.join(dir, 'ads-cache.json');

  function read() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { fetchedAt: Number(j.fetchedAt) || 0, ...sanitize(j) };
    } catch {
      return { fetchedAt: 0, ads: [], support: null, ttl: MIN_TTL_S };
    }
  }

  // 때가 됐을 때만 서버에 묻는다. 실패는 조용히 — 지난 목록을 그대로 쓴다.
  async function refresh(now = Date.now(), { force = false } = {}) {
    const cur = read();
    if (!apiBase || typeof fetchImpl !== 'function') return { changed: false };
    if (!force && now - cur.fetchedAt < cur.ttl * 1000) return { changed: false };
    try {
      const q = new URLSearchParams({ app, v: version, os });
      const r = await fetchImpl(`${apiBase}/v1/ads?${q}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!r.ok) return { changed: false };
      const next = sanitize(await r.json());
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ fetchedAt: now, ...next }) + '\n', 'utf8');
      fs.renameSync(`${file}.tmp`, file);
      return { changed: JSON.stringify([cur.ads, cur.support]) !== JSON.stringify([next.ads, next.support]) };
    } catch {
      return { changed: false };
    }
  }

  // 오늘 뷰에 실을 것 — 광고는 결제 상태가 허용할 때만 호출부가 쓴다
  function today(day = new Date()) {
    const c = read();
    const ad = pickAd(c.ads, day);
    return { ad: { id: ad.id, strong: ad.strong, text: ad.text, house: !!ad.house }, support: c.support };
  }

  // 누를 때 열 주소 — 서버의 /go/<id>. 하우스 광고는 주소가 아니라 앱 안 구매다(호출부가 안다)
  function clickUrl(id) {
    if (!apiBase || !ID.test(String(id ?? '')) || id === HOUSE_AD.id) return null;
    return `${apiBase}/go/${id}`;
  }
  function supportUrl() {
    if (!apiBase || !read().support) return null;
    return `${apiBase}/go/support?app=${encodeURIComponent(app)}`;
  }

  return { refresh, today, clickUrl, supportUrl, file };
}
