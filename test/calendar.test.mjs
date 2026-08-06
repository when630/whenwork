import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvents, maskUrl, calendarRange, fetchCalendar } from '../main/calendar.mjs';

const WEBAPP = 'https://script.google.com/macros/s/AKfyc.../exec?token=secret-value';

// ── 응답 정규화
test('웹앱 응답을 Date로 바꾸고 시작순으로 정렬한다', () => {
  const got = normalizeEvents({
    events: [
      { id: 'b', title: '늦은 것', start: '2026-08-06T09:00:00Z', end: '2026-08-06T10:00:00Z' },
      { id: 'a', title: '이른 것', start: '2026-08-06T01:00:00Z', end: '2026-08-06T02:00:00Z' },
    ],
  });
  assert.deepEqual(got.map((e) => e.title), ['이른 것', '늦은 것']);
  assert.ok(got[0].start instanceof Date);
});

test('깨진 한 건 때문에 나머지를 잃지 않는다', () => {
  const got = normalizeEvents({
    events: [
      { id: 'a', title: '멀쩡', start: '2026-08-06T01:00:00Z' },
      { id: 'b', title: '깨짐', start: '어제' },
      null,
    ],
  });
  assert.equal(got.length, 1);
  assert.equal(got[0].title, '멀쩡');
});

test('events가 없거나 이상한 응답에도 버틴다', () => {
  assert.deepEqual(normalizeEvents(null), []);
  assert.deepEqual(normalizeEvents({}), []);
  assert.deepEqual(normalizeEvents({ events: '아님' }), []);
});

test('id가 없으면 제목·시작으로 키를 만든다 — 캐시가 매번 중복되지 않게', () => {
  const [e] = normalizeEvents({ events: [{ title: '회의', start: '2026-08-06T01:00:00Z' }] });
  assert.equal(e.uid, '회의@2026-08-06T01:00:00.000Z');
});

test('DTEND가 없으면 시작과 같은 시각으로 둔다', () => {
  const [e] = normalizeEvents({ events: [{ id: 'a', title: '순간', start: '2026-08-06T01:00:00Z' }] });
  assert.equal(e.end.getTime(), e.start.getTime());
});

// ── 토큰 가리기
test('URL의 토큰은 앞 네 글자만 남긴다', () => {
  assert.equal(maskUrl(WEBAPP), 'https://script.google.com/macros/s/AKfyc.../exec?token=secr…');
  assert.equal(maskUrl(''), '');
  assert.equal(maskUrl(null), '');
});

test('토큰이 없는 URL은 그대로', () => {
  assert.equal(maskUrl('https://script.google.com/x/exec'), 'https://script.google.com/x/exec');
});

// ── 조회 구간
test('구간은 오늘 자정 기준 과거·미래로 잡는다', () => {
  const { from, to } = calendarRange(new Date(2026, 7, 6, 15, 30), { back: 7, ahead: 14 });
  assert.equal(from.getDate(), 30); // 7/30
  assert.equal(from.getHours(), 0);
  assert.equal(to.getDate(), 20); // 8/20
});

// ── 가져오기 (fetch 주입)
function fakeFetch(response) {
  return async (url) => {
    fakeFetch.lastUrl = String(url);
    return response;
  };
}
const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

test('back·ahead를 쿼리에 붙여 부른다', async () => {
  const f = fakeFetch(ok({ events: [] }));
  await fetchCalendar(WEBAPP, { fetchImpl: f });
  assert.match(fakeFetch.lastUrl, /back=7/);
  assert.match(fakeFetch.lastUrl, /ahead=14/);
  assert.match(fakeFetch.lastUrl, /token=secret-value/); // 토큰은 그대로 전달돼야 한다
});

test('로그인 페이지가 오면 액세스 권한 문제라고 알려준다', async () => {
  const html = { ok: true, status: 200, text: async () => '<html><title>액세스 거부됨</title></html>' };
  await assert.rejects(() => fetchCalendar(WEBAPP, { fetchImpl: fakeFetch(html) }), /액세스 권한/);
});

test('403도 같은 안내로 바꿔준다', async () => {
  const denied = { ok: false, status: 403, text: async () => 'nope' };
  await assert.rejects(() => fetchCalendar(WEBAPP, { fetchImpl: fakeFetch(denied) }), /액세스 권한/);
});

test('토큰이 틀려 본문만 오면 JSON이 아니라고 알려준다', async () => {
  const plain = { ok: true, status: 200, text: async () => 'no' };
  await assert.rejects(() => fetchCalendar(WEBAPP, { fetchImpl: fakeFetch(plain) }), /JSON/);
});

test('정상 응답은 구간과 함께 돌려준다', async () => {
  const body = { events: [{ id: 'a', title: '회의', start: '2026-08-06T01:00:00Z', end: '2026-08-06T02:00:00Z' }] };
  const res = await fetchCalendar(WEBAPP, { fetchImpl: fakeFetch(ok(body)), now: new Date(2026, 7, 6) });
  assert.equal(res.events.length, 1);
  assert.ok(res.from < res.to);
});
