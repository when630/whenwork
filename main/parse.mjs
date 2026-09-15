// 입력 문자열 해석 — Electron 없이 검증할 수 있게 순수 함수로 둔다.

// 캡처 제목을 다듬는다. 던진 글을 **그대로** 받는 것이 전부다.
//
// 예전에는 여기서 `#약어`를 떼어내 프로젝트로 풀었다. 그 기능을 걷어내면서 이 함수도
// 단순해졌다 — 이제 `#`는 그냥 글자다. "#201 이슈 확인"처럼 번호를 앞에 쓰는 습관이
// 제목을 잃지 않는다. 분류는 던진 다음에 인박스에서 1~9로 한다.
export function parseCapture(raw) {
  return String(raw ?? '').trim();
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
