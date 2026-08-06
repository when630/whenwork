// 입력 문자열 해석 — Electron 없이 검증할 수 있게 순수 함수로 둔다.

// 캡처의 #약어를 떼어낸다. 프로젝트 목록을 몰라도 되게 토큰만 뽑고,
// 실제 프로젝트로 푸는 일은 DB가 살아난 뒤(플러시 시점)에 한다 — 캡처 경로는 DB를 모른다(D1).
//
// **앞뒤 어디든 받는다.** 끝만 받던 동안 "#gw 오늘 할일"처럼 앞에 치면 조용히 인박스로 갔다 —
// 손이 먼저 가는 자리가 앞이라면 그쪽이 맞다. 앞을 열면 "#201 이슈 확인"처럼 번호를 앞에 쓰는
// 습관과 부딪히지만, 어느 프로젝트도 가리키지 않는 토큰은 플러시 때 **원문 그대로** 되살아나므로
// 잃는 것이 없다(insertCaptures).
const TOKEN_END = /\s#([A-Za-z0-9_-]{1,16})$/;
const TOKEN_HEAD = /^#([A-Za-z0-9_-]{1,16})\s/;

export function parseCaptureToken(raw) {
  const text = String(raw ?? '').trim();
  const end = text.match(TOKEN_END);
  if (end) {
    const title = text.slice(0, end.index).trim();
    // 본문이 통째로 날아가면(예: "#gw"만 입력) 토큰으로 보지 않는다
    return title ? { title, abbr: end[1] } : { title: text, abbr: null };
  }
  const head = text.match(TOKEN_HEAD);
  if (head) {
    const title = text.slice(head[0].length).trim();
    return title ? { title, abbr: head[1] } : { title: text, abbr: null };
  }
  return { title: text, abbr: null };
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(base, n) {
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
}

// 마감일 입력 해석. 빈 값은 "해제"(null), 못 알아들으면 ok:false로 알려 되묻게 한다.
//   오늘 / 내일 / 모레 / +3 / 3일 / 8/12 / 2026-08-12
export function parseDue(raw, now = new Date()) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: true, value: null };

  const words = { 오늘: 0, today: 0, 내일: 1, tomorrow: 1, 모레: 2 };
  const key = s.toLowerCase();
  if (key in words) return { ok: true, value: ymd(addDays(now, words[key])) };

  const rel = s.match(/^\+?(\d{1,3})\s*(일|d|days?)?$/i);
  if (rel && (s.startsWith('+') || /일|d/i.test(s))) {
    return { ok: true, value: ymd(addDays(now, Number(rel[1]))) };
  }

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const [, y, m, d] = iso.map(Number);
    return valid(y, m, d) ? { ok: true, value: ymd(new Date(y, m - 1, d)) } : { ok: false };
  }

  const md = s.match(/^(\d{1,2})[./-](\d{1,2})$/);
  if (md) {
    const m = Number(md[1]);
    const d = Number(md[2]);
    if (!valid(now.getFullYear(), m, d)) return { ok: false };
    // 이미 지난 날짜면 내년으로 본다 (12월에 "1/5"를 넣는 경우)
    let year = now.getFullYear();
    const today = addDays(now, 0);
    if (new Date(year, m - 1, d) < today) year += 1;
    return { ok: true, value: ymd(new Date(year, m - 1, d)) };
  }

  return { ok: false };
}

function valid(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

// ISO 주차 — 주간 리뷰 파일 이름(2026-W32)에 쓴다
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

// 그 주(월~일)의 시작·끝. 끝은 다음 주 월요일(미포함 상한).
export function weekRange(date) {
  const start = addDays(date, -(((date.getDay() || 7) - 1)));
  return { from: start, to: addDays(start, 7) };
}
