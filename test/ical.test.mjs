import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, expandEvents, parseDateValue } from '../main/ical.mjs';

// 실제 Google 피드는 CRLF로 오고 긴 줄은 접혀서 온다 — 그 형태로 만들어 넣는다
function ics(...lines) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n');
}
function vevent(...lines) {
  return ics('BEGIN:VEVENT', ...lines, 'END:VEVENT');
}
const at = (s) => new Date(s).getTime();

// ── 시각 해석
test('UTC 시각은 그대로 읽는다', () => {
  const { date, allDay } = parseDateValue('20260806T051000Z');
  assert.equal(date.toISOString(), '2026-08-06T05:10:00.000Z');
  assert.equal(allDay, false);
});

test('TZID가 붙으면 그 지역의 벽시계 시각으로 읽는다', () => {
  const { date } = parseDateValue('20260806T141000', { TZID: 'Asia/Seoul' });
  assert.equal(date.toISOString(), '2026-08-06T05:10:00.000Z'); // KST는 UTC+9
});

test('서머타임이 있는 지역도 그 시점 오프셋으로 환산한다', () => {
  const summer = parseDateValue('20260701T120000', { TZID: 'America/New_York' }); // EDT(-4)
  const winter = parseDateValue('20261201T120000', { TZID: 'America/New_York' }); // EST(-5)
  assert.equal(summer.date.toISOString(), '2026-07-01T16:00:00.000Z');
  assert.equal(winter.date.toISOString(), '2026-12-01T17:00:00.000Z');
});

test('종일 일정은 로컬 자정 — 시간대 때문에 날짜가 밀리면 안 된다', () => {
  const { date, allDay } = parseDateValue('20260806');
  assert.equal(allDay, true);
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 7);
  assert.equal(date.getDate(), 6);
});

test('깨진 값은 null — 한 줄 때문에 캘린더 전체가 막히지 않는다', () => {
  assert.equal(parseDateValue('어제'), null);
  assert.equal(parseDateValue(''), null);
});

// ── 파싱
test('제목·시간·장소를 읽는다', () => {
  const [e] = parseIcs(
    vevent(
      'UID:abc@google.com',
      'DTSTART:20260806T051000Z',
      'DTEND:20260806T061000Z',
      'SUMMARY:주간 회의',
      'LOCATION:회의실 A'
    )
  );
  assert.equal(e.uid, 'abc@google.com');
  assert.equal(e.title, '주간 회의');
  assert.equal(e.location, '회의실 A');
  assert.equal(e.start.toISOString(), '2026-08-06T05:10:00.000Z');
});

test('접힌 줄을 펼쳐 긴 제목을 살린다', () => {
  const [e] = parseIcs(
    vevent('UID:a', 'DTSTART:20260806T051000Z', 'SUMMARY:아주 긴 제목이라서 여기서', ' 접혔습니다')
  );
  assert.equal(e.title, '아주 긴 제목이라서 여기서접혔습니다');
});

test('이스케이프된 쉼표·줄바꿈을 되돌린다', () => {
  const [e] = parseIcs(vevent('UID:a', 'DTSTART:20260806T051000Z', 'SUMMARY:A\\, B\\nC'));
  assert.equal(e.title, 'A, B\nC');
});

test('X-WR-TIMEZONE이 TZID 없는 값의 기준이 된다', () => {
  const [e] = parseIcs(ics('X-WR-TIMEZONE:Asia/Seoul', 'BEGIN:VEVENT', 'UID:a', 'DTSTART:20260806T141000', 'END:VEVENT'));
  assert.equal(e.start.toISOString(), '2026-08-06T05:10:00.000Z');
});

test('VEVENT가 아닌 블록과 빈 입력에 버틴다', () => {
  assert.deepEqual(parseIcs(''), []);
  assert.deepEqual(parseIcs(ics('BEGIN:VTIMEZONE', 'TZID:Asia/Seoul', 'END:VTIMEZONE')), []);
});

// ── 전개: 단발
test('구간 밖의 일정은 빠진다', () => {
  const events = parseIcs(vevent('UID:a', 'DTSTART:20260806T051000Z', 'DTEND:20260806T061000Z', 'SUMMARY:회의'));
  assert.equal(expandEvents(events, at('2026-08-06T00:00:00Z'), at('2026-08-07T00:00:00Z')).length, 1);
  assert.equal(expandEvents(events, at('2026-08-07T00:00:00Z'), at('2026-08-08T00:00:00Z')).length, 0);
});

test('구간에 걸치기만 해도 포함한다', () => {
  const events = parseIcs(vevent('UID:a', 'DTSTART:20260806T230000Z', 'DTEND:20260807T010000Z', 'SUMMARY:야간'));
  const got = expandEvents(events, at('2026-08-07T00:00:00Z'), at('2026-08-08T00:00:00Z'));
  assert.equal(got.length, 1);
});

test('DTEND가 없어도 구간 시작에 딱 걸린 일정이 사라지지 않는다', () => {
  const events = parseIcs(vevent('UID:a', 'DTSTART:20260806T000000Z', 'SUMMARY:정각'));
  const got = expandEvents(events, at('2026-08-06T00:00:00Z'), at('2026-08-07T00:00:00Z'));
  assert.equal(got.length, 1);
  // 구간이 끝나는 순간은 다음 구간의 몫이다
  assert.equal(expandEvents(events, at('2026-08-05T00:00:00Z'), at('2026-08-06T00:00:00Z')).length, 0);
});

test('취소된 일정은 내보내지 않는다', () => {
  const events = parseIcs(vevent('UID:a', 'DTSTART:20260806T051000Z', 'SUMMARY:취소됨', 'STATUS:CANCELLED'));
  assert.deepEqual(expandEvents(events, at('2026-08-01T00:00:00Z'), at('2026-08-31T00:00:00Z')), []);
});

// ── 전개: 반복
test('매일 반복을 구간 안에서만 펼친다', () => {
  const events = parseIcs(
    vevent('UID:a', 'DTSTART:20260801T000000Z', 'DTEND:20260801T010000Z', 'SUMMARY:데일리', 'RRULE:FREQ=DAILY')
  );
  const got = expandEvents(events, at('2026-08-03T00:00:00Z'), at('2026-08-06T00:00:00Z'));
  assert.deepEqual(got.map((e) => e.start.toISOString().slice(0, 10)), ['2026-08-03', '2026-08-04', '2026-08-05']);
});

test('INTERVAL과 COUNT를 지킨다', () => {
  const events = parseIcs(
    vevent('UID:a', 'DTSTART:20260801T000000Z', 'SUMMARY:격일 3회', 'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3')
  );
  const got = expandEvents(events, at('2026-07-01T00:00:00Z'), at('2026-09-01T00:00:00Z'));
  assert.deepEqual(got.map((e) => e.start.toISOString().slice(0, 10)), ['2026-08-01', '2026-08-03', '2026-08-05']);
});

test('UNTIL 이후로는 발생하지 않는다', () => {
  const events = parseIcs(
    vevent('UID:a', 'DTSTART:20260801T000000Z', 'SUMMARY:주간', 'RRULE:FREQ=WEEKLY;UNTIL=20260815T000000Z')
  );
  const got = expandEvents(events, at('2026-07-01T00:00:00Z'), at('2026-09-01T00:00:00Z'));
  assert.deepEqual(got.map((e) => e.start.toISOString().slice(0, 10)), ['2026-08-01', '2026-08-08', '2026-08-15']);
});

test('EXDATE로 뺀 회차는 건너뛴다', () => {
  const events = parseIcs(
    vevent(
      'UID:a',
      'DTSTART:20260803T000000Z',
      'SUMMARY:데일리',
      'RRULE:FREQ=DAILY;COUNT=4',
      'EXDATE:20260804T000000Z'
    )
  );
  const got = expandEvents(events, at('2026-08-01T00:00:00Z'), at('2026-09-01T00:00:00Z'));
  assert.deepEqual(got.map((e) => e.start.toISOString().slice(0, 10)), ['2026-08-03', '2026-08-05', '2026-08-06']);
});

test('RECURRENCE-ID로 옮긴 회차는 원래 자리 대신 옮긴 자리에 한 번만 선다', () => {
  const text = ics(
    'BEGIN:VEVENT',
    'UID:a',
    'DTSTART:20260803T000000Z',
    'DTEND:20260803T010000Z',
    'SUMMARY:주간 회의',
    'RRULE:FREQ=DAILY;COUNT=3',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:a',
    'RECURRENCE-ID:20260804T000000Z',
    'DTSTART:20260804T090000Z',
    'DTEND:20260804T100000Z',
    'SUMMARY:주간 회의 (시간 변경)',
    'END:VEVENT'
  );
  const got = expandEvents(parseIcs(text), at('2026-08-01T00:00:00Z'), at('2026-09-01T00:00:00Z'));
  assert.deepEqual(got.map((e) => e.start.toISOString()), [
    '2026-08-03T00:00:00.000Z',
    '2026-08-04T09:00:00.000Z',
    '2026-08-05T00:00:00.000Z',
  ]);
  assert.equal(got[1].title, '주간 회의 (시간 변경)');
});

test('매주 여러 요일(BYDAY)을 펼친다', () => {
  // 2026-08-03은 월요일
  const events = parseIcs(
    vevent('UID:a', 'DTSTART:20260803T000000Z', 'SUMMARY:월수', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE')
  );
  const got = expandEvents(events, at('2026-08-03T00:00:00Z'), at('2026-08-17T00:00:00Z'));
  assert.deepEqual(got.map((e) => e.start.toISOString().slice(0, 10)), [
    '2026-08-03',
    '2026-08-05',
    '2026-08-10',
    '2026-08-12',
  ]);
});

test('못 펼치는 규칙은 첫 회차만 — 틀린 날짜를 지어내지 않는다', () => {
  const events = parseIcs(
    vevent('UID:a', 'DTSTART:20260803T000000Z', 'SUMMARY:둘째 화요일', 'RRULE:FREQ=MONTHLY;BYDAY=2TU')
  );
  const got = expandEvents(events, at('2026-08-01T00:00:00Z'), at('2026-12-01T00:00:00Z'));
  assert.equal(got.length, 1);
  assert.equal(got[0].start.toISOString(), '2026-08-03T00:00:00.000Z');
});

test('끝없는 반복도 구간 상한 안에서 멈춘다', () => {
  const events = parseIcs(vevent('UID:a', 'DTSTART:20200101T000000Z', 'SUMMARY:영원', 'RRULE:FREQ=DAILY'));
  const got = expandEvents(events, at('2026-08-06T00:00:00Z'), at('2026-08-08T00:00:00Z'));
  assert.ok(got.length <= 2, `구간 밖까지 펼쳤다: ${got.length}건`);
});

test('결과는 시작 시각 순', () => {
  const text = ics(
    'BEGIN:VEVENT',
    'UID:b',
    'DTSTART:20260806T090000Z',
    'SUMMARY:늦은 것',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:a',
    'DTSTART:20260806T010000Z',
    'SUMMARY:이른 것',
    'END:VEVENT'
  );
  const got = expandEvents(parseIcs(text), at('2026-08-06T00:00:00Z'), at('2026-08-07T00:00:00Z'));
  assert.deepEqual(got.map((e) => e.title), ['이른 것', '늦은 것']);
});
