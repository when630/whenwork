// 캘린더 가져오기 — Apps Script 웹앱이 내주는 JSON을 읽는다.
//
// 회사 Workspace가 iCal 비공개 주소를 막아(오픈이슈 #6) 남은 창구가 이것뿐이다.
// 웹앱은 본인 권한으로 캘린더를 읽으므로 캘린더를 공개하지 않아도 되고, 반복 일정도
// Google이 이미 펼쳐서 주므로 우리가 RRULE을 해석할 필요가 없다.
//
// URL에 토큰이 들어 있다 — 로그·화면에 그대로 흘리지 않도록 maskUrl을 거쳐 보여준다.

export const CAL_BACK_DAYS = 7; // 주간 리뷰가 지난주를 돌아보므로 과거도 받아둔다
export const CAL_AHEAD_DAYS = 14;

// 응답이 우리가 아는 모양인지 확인하고 Date로 바꾼다. 한 건이 깨져도 나머지는 살린다.
export function normalizeEvents(payload) {
  const raw = Array.isArray(payload?.events) ? payload.events : [];
  const out = [];
  for (const e of raw) {
    const start = new Date(e?.start);
    const end = new Date(e?.end ?? e?.start);
    if (Number.isNaN(start.getTime())) continue;
    out.push({
      uid: String(e?.id ?? `${e?.title ?? ''}@${start.toISOString()}`).slice(0, 400),
      title: String(e?.title ?? '(제목 없음)').slice(0, 300),
      location: e?.location ? String(e.location).slice(0, 300) : null,
      start,
      end: Number.isNaN(end.getTime()) ? start : end,
      allDay: !!e?.allDay,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

// 화면·로그용. 토큰은 앞 4글자만 남긴다.
export function maskUrl(url) {
  const s = String(url ?? '');
  if (!s) return '';
  return s.replace(/([?&]token=)([^&]+)/i, (_m, p, v) => `${p}${v.slice(0, 4)}…`);
}

export function calendarRange(now = new Date(), { back = CAL_BACK_DAYS, ahead = CAL_AHEAD_DAYS } = {}) {
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  return {
    from: new Date(base.getTime() - back * 86400000),
    to: new Date(base.getTime() + ahead * 86400000),
    back,
    ahead,
  };
}

// Apps Script는 script.google.com → script.googleusercontent.com으로 넘긴다 — 리다이렉트를 따라간다.
// 로그인 페이지(HTML)가 돌아오면 배포의 액세스 권한이 "모든 사용자"가 아니라는 뜻이라 그렇게 알려준다.
export async function fetchCalendar(url, { now = new Date(), timeoutMs = 20_000, fetchImpl = fetch } = {}) {
  const range = calendarRange(now);
  const target = new URL(url);
  target.searchParams.set('back', String(range.back));
  target.searchParams.set('ahead', String(range.ahead));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(target, { redirect: 'follow', signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        res.status === 401 || res.status === 403
          ? '웹앱이 로그인을 요구합니다 — 배포의 액세스 권한을 "모든 사용자"로 바꾸세요'
          : `웹앱이 HTTP ${res.status}를 돌려줬습니다`
      );
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(
        /액세스|로그인|sign in|<html/i.test(text)
          ? '일정 대신 로그인 페이지가 왔습니다 — 배포의 액세스 권한을 "모든 사용자"로 바꾸세요'
          : '웹앱 응답이 JSON이 아닙니다'
      );
    }
    if (payload?.error) throw new Error(String(payload.error).slice(0, 160));
    return { ...range, events: normalizeEvents(payload) };
  } finally {
    clearTimeout(timer);
  }
}

// 가져와서 캐시를 갈아끼운다. 실패하면 던지고, 캐시는 그대로 둔다(마지막 상태를 계속 보여준다).
export async function syncCalendar(db, url, { now = new Date() } = {}) {
  if (!url) return { ok: false, skipped: true };
  const { from, to, events } = await fetchCalendar(url, { now });
  await db.replaceCalendar(from, to, events);
  return { ok: true, count: events.length, from, to };
}
