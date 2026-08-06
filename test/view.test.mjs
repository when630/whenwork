import test from 'node:test';
import assert from 'node:assert/strict';

// view.js는 렌더러에서 <script>로 읽히며 globalThis.VIEW를 채운다 — 여기서도 같은 경로로 확인한다
await import('../renderer/view.js');
const VIEW = globalThis.VIEW;

const NOW = new Date(2026, 7, 5, 14, 0); // 2026-08-05 (수)
const todo = (o) => ({ project_id: 1, project_name: '가', kind: 'todo', title: '일', ...o });

// ── 마감 배지
test('마감 배지는 지연·오늘·남음을 가른다', () => {
  assert.deepEqual(VIEW.dueBadge('2026-08-03', NOW), { text: 'D+2', cls: 'over' });
  assert.deepEqual(VIEW.dueBadge('2026-08-05', NOW), { text: '오늘', cls: 'today' });
  assert.deepEqual(VIEW.dueBadge('2026-08-08', NOW), { text: 'D-3', cls: '' });
  assert.equal(VIEW.dueBadge(null, NOW), null);
});

test('마감 판정은 시각이 아니라 날짜로 한다', () => {
  // 자정 직전이어도 "오늘 마감"은 오늘이다
  const late = new Date(2026, 7, 5, 23, 59);
  assert.equal(VIEW.dueBadge('2026-08-05', late).cls, 'today');
  const early = new Date(2026, 7, 5, 0, 1);
  assert.equal(VIEW.dueBadge('2026-08-05', early).cls, 'today');
});

test('경과일은 음수로 가지 않는다', () => {
  const now = new Date(2026, 7, 5).getTime();
  assert.equal(VIEW.elapsedDays(new Date(2026, 7, 1), now), 4);
  assert.equal(VIEW.elapsedDays(new Date(2026, 7, 9), now), 0);
});

// ── 검색
test('검색은 제목뿐 아니라 메모·프로젝트·대기 상대까지 훑는다', () => {
  const row = { title: '견적서 보내기', note: '금요일까지', project_name: '서식갤러리', waiting_for: '김대리' };
  for (const q of ['견적', '금요일', '갤러리', '김대리']) {
    assert.ok(VIEW.matches(row, q), q);
  }
  assert.ok(!VIEW.matches(row, '없는말'));
});

test('낱말이 여럿이면 모두 들어 있어야 한다 (AND)', () => {
  const row = { title: '견적서 보내기', project_name: '서식갤러리' };
  assert.ok(VIEW.matches(row, '견적 갤러리'));
  assert.ok(!VIEW.matches(row, '견적 계약'));
});

test('대소문자를 가리지 않고, 빈 검색어는 모두 통과', () => {
  assert.ok(VIEW.matches({ title: 'GoWrite 배포' }, 'gowrite'));
  assert.ok(VIEW.matches({ title: '아무거나' }, ''));
});

// ── 오늘 탭 배치 (선택 인덱스와 그리는 순서가 어긋나면 엉뚱한 항목이 지워진다)
test('프로젝트별로만 묶는다 — 급한 것은 배지가 알린다', () => {
  const list = [
    todo({ id: 'a', project_id: 1, due: null }),
    todo({ id: 'b', project_id: 2, project_name: '나', due: '2026-08-05' }),
    todo({ id: 'c', project_id: 1, due: '2026-08-03' }),
  ];
  const groups = VIEW.todayGroups(list);
  assert.deepEqual(groups.map((g) => g.label), ['가', '나']);
  assert.deepEqual(groups[0].items.map((i) => i.id), ['a', 'c']); // 들어온 순서 그대로
});

test('flat 순서가 그리는 순서와 같다 — 선택 인덱스의 근거', () => {
  const list = [
    todo({ id: 'a', project_id: 2, project_name: '나' }),
    todo({ id: 'b', project_id: 1, due: '2026-08-01' }),
    todo({ id: 'c', project_id: 2, project_name: '나' }),
    todo({ id: 'd', project_id: 1 }),
  ];
  const flat = VIEW.todayGroups(list).flatMap((g) => g.items).map((i) => i.id);
  assert.deepEqual(flat, ['a', 'c', 'b', 'd']); // 나(먼저 등장) → 가
});

test('프로젝트 없는 항목은 미지정 그룹으로 모인다', () => {
  const list = [{ id: 'a', title: '무소속', project_id: null }, { id: 'b', title: '또', project_id: null }];
  const groups = VIEW.todayGroups(list);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, '미지정');
  assert.equal(groups[0].items.length, 2);
});

test('빈 목록이면 그룹도 없다', () => {
  assert.deepEqual(VIEW.todayGroups([]), []);
});

// ── 타임라인
const ev = (h1, h2, extra = {}) => ({
  title: `${h1}시`,
  start_at: new Date(2026, 7, 6, h1, 0),
  end_at: new Date(2026, 7, 6, h2, 0),
  ...extra,
});

test('"지금"은 아직 시작하지 않은 첫 일정 앞에 선다', () => {
  const now = new Date(2026, 7, 6, 12, 0).getTime();
  const { rows } = VIEW.timeline([ev(10, 11), ev(14, 15), ev(16, 17)], now);
  assert.deepEqual(rows.map((r) => (r.type === 'now' ? '지금' : r.ev.title)), [
    '10시',
    '지금',
    '14시',
    '16시',
  ]);
});

test('일정이 다 지났으면 "지금"이 축의 끝', () => {
  const now = new Date(2026, 7, 6, 20, 0).getTime();
  const { rows } = VIEW.timeline([ev(10, 11), ev(14, 15)], now);
  assert.equal(rows[rows.length - 1].type, 'now');
});

test('아직 아무것도 시작 안 했으면 "지금"이 맨 위', () => {
  const now = new Date(2026, 7, 6, 8, 0).getTime();
  const { rows } = VIEW.timeline([ev(10, 11)], now);
  assert.equal(rows[0].type, 'now');
});

test('진행 중인 일정 다음에 "지금"이 온다', () => {
  const now = new Date(2026, 7, 6, 10, 30).getTime();
  const { rows } = VIEW.timeline([ev(10, 11), ev(14, 15)], now);
  assert.deepEqual(rows.map((r) => (r.type === 'now' ? '지금' : r.ev.title)), ['10시', '지금', '14시']);
});

test('종일 일정은 축에서 빼내 따로 준다', () => {
  const allDayEv = { title: '휴가', all_day: true, start_at: new Date(2026, 7, 6) };
  const { allDay, rows } = VIEW.timeline([allDayEv, ev(14, 15)], new Date(2026, 7, 6, 9).getTime());
  assert.deepEqual(allDay.map((e) => e.title), ['휴가']);
  assert.ok(!rows.some((r) => r.ev?.all_day));
});

test('종일 일정만 있으면 축을 그리지 않는다 — "지금"만 덜렁 남지 않게', () => {
  const { allDay, rows } = VIEW.timeline([{ title: '휴가', all_day: true }], Date.now());
  assert.equal(allDay.length, 1);
  assert.deepEqual(rows, []);
});

test('시각 순서가 뒤섞여 들어와도 축은 시간순', () => {
  const now = new Date(2026, 7, 6, 9, 0).getTime();
  const { rows } = VIEW.timeline([ev(16, 17), ev(10, 11), ev(14, 15)], now);
  assert.deepEqual(rows.filter((r) => r.type === 'event').map((r) => r.ev.title), ['10시', '14시', '16시']);
});

test('빈 입력에도 버틴다', () => {
  assert.deepEqual(VIEW.timeline([], Date.now()), { allDay: [], rows: [] });
  assert.deepEqual(VIEW.timeline(undefined, Date.now()), { allDay: [], rows: [] });
});

// ── 완료 기록
test('완료 항목과 커밋을 하루 단위로 묶어 최근 날짜부터', () => {
  const data = {
    items: [
      { title: '가', done_at: new Date(2026, 7, 5, 9, 0) },
      { title: '나', done_at: new Date(2026, 7, 3, 18, 0) },
    ],
    commits: [
      { summary: 'c1', occurred_at: new Date(2026, 7, 5, 11, 0) },
      { summary: 'c2', occurred_at: new Date(2026, 7, 4, 11, 0) },
    ],
  };
  const days = VIEW.historyDays(data);
  assert.deepEqual(days.map((d) => d.key), ['2026-08-05', '2026-08-04', '2026-08-03']);
  assert.equal(days[0].items.length, 1);
  assert.equal(days[0].commits.length, 1);
  assert.equal(days[1].items.length, 0); // 커밋만 있는 날
});

test('빈 자료·없는 키에도 버티고 빈 배열', () => {
  assert.deepEqual(VIEW.historyDays(null), []);
  assert.deepEqual(VIEW.historyDays({}), []);
  assert.deepEqual(VIEW.historyDays({ items: [], commits: [] }), []);
});

test('오늘·어제는 이름을 붙여 보여준다', () => {
  assert.match(VIEW.dayLabel('2026-08-05', NOW), /^8\/5 \(수\) \(오늘\)$/);
  assert.match(VIEW.dayLabel('2026-08-04', NOW), /\(어제\)$/);
  assert.equal(VIEW.dayLabel('2026-08-01', NOW), '8/1 (토)');
});

test('달을 넘는 어제도 어제로 본다', () => {
  const firstOfMonth = new Date(2026, 8, 1, 10, 0); // 9/1
  assert.match(VIEW.dayLabel('2026-08-31', firstOfMonth), /\(어제\)$/);
});

// ── 일정
test('일정은 지난 것·진행 중·앞으로를 가른다', () => {
  const now = new Date(2026, 7, 6, 14, 30).getTime();
  const ev = (h1, h2) => ({
    start_at: new Date(2026, 7, 6, h1, 0),
    end_at: new Date(2026, 7, 6, h2, 0),
  });
  assert.equal(VIEW.eventState(ev(10, 11), now), 'past');
  assert.equal(VIEW.eventState(ev(14, 15), now), 'live');
  assert.equal(VIEW.eventState(ev(16, 17), now), 'next');
  assert.equal(VIEW.eventState({ all_day: true }, now), 'allday');
});

test('끝나는 순간은 이미 지난 것으로 본다', () => {
  const now = new Date(2026, 7, 6, 15, 0).getTime();
  const ev = { start_at: new Date(2026, 7, 6, 14, 0), end_at: new Date(2026, 7, 6, 15, 0) };
  assert.equal(VIEW.eventState(ev, now), 'past');
});

test('시각은 두 자리로 채운다', () => {
  assert.equal(VIEW.hhmm(new Date(2026, 7, 6, 9, 5)), '09:05');
  assert.equal(VIEW.hhmm('깨진값'), '');
});

test('일정은 시작만이 아니라 끝나는 시각까지 보여준다', () => {
  const ev = { start_at: new Date(2026, 7, 6, 14, 10), end_at: new Date(2026, 7, 6, 15, 10) };
  assert.equal(VIEW.eventTime(ev), '14:10–15:10');
  assert.equal(VIEW.eventTime({ all_day: true }), '종일');
  // 길이가 0이면 굳이 같은 시각을 두 번 쓰지 않는다
  assert.equal(VIEW.eventTime({ start_at: ev.start_at, end_at: ev.start_at }), '14:10');
  assert.equal(VIEW.eventTime({ start_at: ev.start_at }), '14:10');
});

test('길이는 사람이 읽는 말로', () => {
  assert.equal(VIEW.humanSpan(45), '45분');
  assert.equal(VIEW.humanSpan(60), '1시간');
  assert.equal(VIEW.humanSpan(130), '2시간 10분');
  assert.equal(VIEW.humanSpan(0), null);
  assert.equal(VIEW.humanSpan(-5), null);
});

test('앞으로의 일정은 시작까지, 진행 중이면 남은 시간을 말한다', () => {
  const ev = { start_at: new Date(2026, 7, 6, 14, 0), end_at: new Date(2026, 7, 6, 15, 0) };
  assert.equal(VIEW.eventRelative(ev, new Date(2026, 7, 6, 13, 30).getTime()), '30분 뒤');
  assert.equal(VIEW.eventRelative(ev, new Date(2026, 7, 6, 14, 40).getTime()), '20분 남음');
  assert.equal(VIEW.eventRelative(ev, new Date(2026, 7, 6, 11, 0).getTime()), '3시간 뒤');
});

test('지난 일정과 종일 일정에는 상대시간을 붙이지 않는다', () => {
  const past = { start_at: new Date(2026, 7, 6, 10, 0), end_at: new Date(2026, 7, 6, 11, 0) };
  assert.equal(VIEW.eventRelative(past, new Date(2026, 7, 6, 14, 0).getTime()), null);
  assert.equal(VIEW.eventRelative({ all_day: true }, Date.now()), null);
});

test('막 시작하거나 막 끝나는 순간에도 말이 된다', () => {
  const ev = { start_at: new Date(2026, 7, 6, 14, 0), end_at: new Date(2026, 7, 6, 15, 0) };
  assert.equal(VIEW.eventRelative(ev, new Date(2026, 7, 6, 14, 0).getTime()), '1시간 남음');
  assert.equal(VIEW.eventRelative(ev, new Date(2026, 7, 6, 14, 59, 45).getTime()), '곧 끝남');
  assert.equal(VIEW.eventRelative(ev, new Date(2026, 7, 6, 13, 59, 45).getTime()), '곧 시작');
});

// ── 설정 표시
test('빈 설정은 대신 쓰이는 값을 밝힌다', () => {
  const defaults = { notifyAt: '09:00', backupDir: 'C:/data/backups' };
  assert.match(VIEW.settingDisplay({ key: 'backupDir', kind: 'folder' }, {}, defaults), /기본/);
  assert.match(VIEW.settingDisplay({ key: 'vaultRoot', kind: 'folder' }, {}, defaults), /미설정/);
  assert.equal(VIEW.settingDisplay({ key: 'notifyAt', kind: 'time' }, {}, defaults), '09:00 (기본)');
});

test('설정한 값이 있으면 그대로 보여준다', () => {
  const values = { vaultRoot: 'D:/vault', notifyAt: '07:30', notifyEnabled: false };
  assert.equal(VIEW.settingDisplay({ key: 'vaultRoot', kind: 'folder' }, values), 'D:/vault');
  assert.equal(VIEW.settingDisplay({ key: 'notifyAt', kind: 'time' }, values), '07:30');
  assert.equal(VIEW.settingDisplay({ key: 'notifyEnabled', kind: 'bool' }, values), '꺼짐');
  assert.equal(VIEW.settingDisplay({ key: 'notifyEnabled', kind: 'bool' }, {}), '켜짐'); // 기본은 켜짐
});
