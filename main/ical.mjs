// iCalendar(ics) 읽기 — 캘린더 일정을 오늘 뷰·브리핑·주간 리뷰에 쓰기 위한 최소 구현.
//
// ※ 아직 앱에 연결돼 있지 않다(오픈이슈 #6). 회사 Workspace가 iCal 비공개 주소를 막아
//   쓸 수 있는 피드가 free/busy(제목 없음)뿐이라 연동을 보류했다. 비공개 주소가 열리거나
//   OAuth를 붙이면 이 모듈은 그대로 쓸 수 있다.
//
// 라이브러리를 쓰지 않는 이유는 이 앱의 의존성이 pg 하나뿐이고(마크다운 렌더러도 직접 만들었다)
// 우리가 쓰는 문법이 좁기 때문이다. 대신 다루는 범위를 아래에 못 박고 테스트로 방어한다.
//
// 다루는 것: VEVENT · 접힌 줄 · TZID/UTC/종일 · STATUS:CANCELLED ·
//            RRULE(FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL, WEEKLY의 BYDAY) ·
//            EXDATE · RECURRENCE-ID로 덮어쓴 개별 회차
// 다루지 않는 것: BYSETPOS·BYMONTHDAY 같은 세부 규칙, VTODO/VJOURNAL, VALARM.
//            모르는 반복 규칙은 **첫 회차만** 내보낸다 — 조용히 틀린 날짜를 만드느니 덜 보여주는 게 낫다.

const WEEKDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DAY_MS = 86400000;
const MAX_OCCURRENCES = 500; // 무한 반복이 조회 구간을 넘어 폭주하지 않게 거는 상한

// ── 줄 단위 파싱
//
// ics는 75옥텟마다 줄을 접고 이어지는 줄을 공백/탭으로 시작한다. 먼저 펼치지 않으면
// 긴 제목이 중간에서 잘린다.
function unfold(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '');
}

function unescape(v) {
  return String(v ?? '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// "DTSTART;TZID=Asia/Seoul:20260721T150000" → { name, params, value }
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...rawParams] = head.split(';');
  const params = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

// ── 시각 해석
//
// 같은 "20260721T150000"이라도 TZID가 무엇이냐에 따라 가리키는 순간이 다르다.
// Node에 IANA 데이터가 들어 있으므로 Intl로 그 지역의 오프셋을 구해 UTC로 환산한다.
function zoneOffset(ts, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(ts)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return asUtc - ts;
}

function zonedToUtc(parts, tz) {
  const [y, mo, d, h, mi, s] = parts;
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  // 오프셋은 시점에 따라 달라지므로(서머타임) 한 번 보정한 뒤 다시 재어 수렴시킨다
  let ts = naive;
  for (let i = 0; i < 2; i++) ts = naive - zoneOffset(ts, tz);
  return new Date(ts);
}

// { date, allDay } — 실패하면 null (깨진 줄 하나가 캘린더 전체를 막지 않는다)
export function parseDateValue(value, params = {}, { fallbackTz = 'UTC' } = {}) {
  const v = String(value ?? '').trim();
  const dateOnly = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    const [, y, m, d] = dateOnly.map(Number);
    // 종일 일정은 "그 날짜"이지 특정 순간이 아니다 — 로컬 자정으로 둬야 화면에서 날짜가 밀리지 않는다
    return { date: new Date(y, m - 1, d), allDay: true };
  }
  const dt = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!dt) return null;
  const parts = dt.slice(1, 7).map(Number);
  const isUtc = dt[7] === 'Z';
  if (isUtc) {
    return { date: new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5])), allDay: false };
  }
  const tz = params.TZID || fallbackTz;
  try {
    return { date: zonedToUtc(parts, tz), allDay: false };
  } catch {
    // 모르는 TZID — 로컬 시간으로 본다 (대개 맞고, 틀려도 몇 시간 차이다)
    return { date: new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]), allDay: false };
  }
}

function parseRRule(value) {
  const rule = {};
  for (const chunk of String(value ?? '').split(';')) {
    const eq = chunk.indexOf('=');
    if (eq > 0) rule[chunk.slice(0, eq).toUpperCase()] = chunk.slice(eq + 1);
  }
  return rule;
}

// ── VEVENT 추출
export function parseIcs(text, { fallbackTz = 'UTC' } = {}) {
  const lines = unfold(text).split('\n');
  const events = [];
  let cur = null;
  let calTz = fallbackTz;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === 'BEGIN:VEVENT') {
      cur = { exdates: [] };
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur?.start) events.push(cur);
      cur = null;
      continue;
    }
    const p = parseLine(line);
    if (!p) continue;

    if (!cur) {
      // 캘린더 전체 기본 타임존 — TZID 없는 값의 해석 기준이 된다
      if (p.name === 'X-WR-TIMEZONE' && p.value) calTz = p.value;
      continue;
    }

    switch (p.name) {
      case 'UID':
        cur.uid = p.value;
        break;
      case 'SUMMARY':
        cur.title = unescape(p.value);
        break;
      case 'LOCATION':
        cur.location = unescape(p.value);
        break;
      case 'STATUS':
        cur.status = p.value.toUpperCase();
        break;
      case 'DTSTART': {
        const parsed = parseDateValue(p.value, p.params, { fallbackTz: calTz });
        if (parsed) {
          cur.start = parsed.date;
          cur.allDay = parsed.allDay;
        }
        break;
      }
      case 'DTEND': {
        const parsed = parseDateValue(p.value, p.params, { fallbackTz: calTz });
        if (parsed) cur.end = parsed.date;
        break;
      }
      case 'RRULE':
        cur.rrule = parseRRule(p.value);
        break;
      case 'EXDATE':
        for (const v of p.value.split(',')) {
          const parsed = parseDateValue(v, p.params, { fallbackTz: calTz });
          if (parsed) cur.exdates.push(parsed.date.getTime());
        }
        break;
      case 'RECURRENCE-ID': {
        const parsed = parseDateValue(p.value, p.params, { fallbackTz: calTz });
        if (parsed) cur.recurrenceId = parsed.date.getTime();
        break;
      }
    }
  }
  return events;
}

// ── 반복 전개
function addByFreq(date, freq, n) {
  const d = new Date(date);
  if (freq === 'DAILY') d.setDate(d.getDate() + n);
  else if (freq === 'WEEKLY') d.setDate(d.getDate() + n * 7);
  else if (freq === 'MONTHLY') d.setMonth(d.getMonth() + n);
  else if (freq === 'YEARLY') d.setFullYear(d.getFullYear() + n);
  return d;
}

// 주 단위 BYDAY — "매주 월·수" 같은 흔한 형태만 다룬다("둘째 화요일"은 지원하지 않는다)
function weeklyDays(rule) {
  if (!rule.BYDAY) return null;
  const days = rule.BYDAY.split(',')
    .map((d) => WEEKDAY[d.trim().toUpperCase().slice(-2)])
    .filter((d) => d !== undefined);
  return days.length ? days : null;
}

function supported(rule) {
  if (!rule?.FREQ) return false;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.FREQ)) return false;
  // 서수 BYDAY(2TU)나 BYSETPOS가 끼면 우리가 전개할 수 없다
  if (rule.BYSETPOS || rule.BYMONTHDAY || rule.BYMONTH) return false;
  if (rule.BYDAY && (rule.FREQ !== 'WEEKLY' || /\d/.test(rule.BYDAY))) return false;
  return true;
}

// [from, to) 구간에 실제로 놓이는 일정들. 반복은 여기서만 펼치므로 무한 반복도 안전하다.
export function expandEvents(events, from, to) {
  const fromTs = from instanceof Date ? from.getTime() : Number(from);
  const toTs = to instanceof Date ? to.getTime() : Number(to);

  // RECURRENCE-ID가 붙은 것은 특정 회차를 덮어쓴 판이다 — 원본 전개에서 그 회차를 빼고 이걸 쓴다
  const overrides = new Map();
  for (const e of events) {
    if (e.recurrenceId != null && e.uid) overrides.set(`${e.uid}@${e.recurrenceId}`, e);
  }

  const out = [];
  const push = (e, start) => {
    const span = e.end && e.start ? e.end.getTime() - e.start.getTime() : 0;
    const end = new Date(start.getTime() + span);
    // 길이가 있는 일정은 구간에 걸치기만 해도 포함한다(오전에 시작해 오후까지 가는 회의).
    // DTEND가 없어 길이가 0인 일정은 겹침으로 따지면 구간 시작에 딱 걸릴 때 사라지므로
    // 시작 시각이 구간 안인지로 본다.
    const inRange =
      span > 0
        ? end.getTime() > fromTs && start.getTime() < toTs
        : start.getTime() >= fromTs && start.getTime() < toTs;
    if (!inRange) return;
    out.push({
      uid: e.uid ?? null,
      title: e.title ?? '(제목 없음)',
      location: e.location ?? null,
      start,
      end,
      allDay: !!e.allDay,
    });
  };

  for (const e of events) {
    if (e.status === 'CANCELLED' || !e.start) continue;
    if (e.recurrenceId != null) {
      push(e, e.start); // 덮어쓴 회차는 그 자체로 한 건
      continue;
    }
    if (!e.rrule) {
      push(e, e.start);
      continue;
    }
    if (!supported(e.rrule)) {
      push(e, e.start); // 못 펼치는 규칙은 첫 회차만
      continue;
    }

    const rule = e.rrule;
    const freq = rule.FREQ;
    const interval = Math.max(1, Number(rule.INTERVAL ?? 1));
    const count = rule.COUNT ? Number(rule.COUNT) : null;
    const until = rule.UNTIL ? parseDateValue(rule.UNTIL)?.date?.getTime() ?? null : null;
    const byDays = freq === 'WEEKLY' ? weeklyDays(rule) : null;
    const exdates = new Set(e.exdates ?? []);

    let emitted = 0;
    let cursor = new Date(e.start);
    for (let step = 0; step < MAX_OCCURRENCES; step++) {
      // 주 단위 BYDAY는 한 주기 안에서 여러 요일에 발생한다
      const candidates = [];
      if (byDays) {
        const weekStart = new Date(cursor);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // 그 주 일요일
        for (const wd of byDays) {
          const d = new Date(weekStart);
          d.setDate(d.getDate() + wd);
          d.setHours(cursor.getHours(), cursor.getMinutes(), cursor.getSeconds(), 0);
          if (d.getTime() >= e.start.getTime()) candidates.push(d);
        }
        candidates.sort((a, b) => a - b);
      } else {
        candidates.push(new Date(cursor));
      }

      for (const c of candidates) {
        if (count != null && emitted >= count) break;
        if (until != null && c.getTime() > until) break;
        if (exdates.has(c.getTime())) {
          emitted++; // 제외된 회차도 COUNT를 소모한다
          continue;
        }
        const override = e.uid ? overrides.get(`${e.uid}@${c.getTime()}`) : null;
        if (override) {
          emitted++; // 덮어쓴 판은 위에서 따로 넣었다
          continue;
        }
        emitted++;
        push(e, c);
      }

      if (count != null && emitted >= count) break;
      cursor = addByFreq(cursor, freq, interval);
      if (cursor.getTime() >= toTs) break; // 구간을 지나면 더 볼 것 없다
      if (until != null && cursor.getTime() > until) break;
    }
  }

  return out.sort((a, b) => a.start - b.start);
}
