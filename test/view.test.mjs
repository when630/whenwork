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

// 항목은 마감 순으로 오므로 첫 등장 순서로 묶으면 그룹 자리가 매일 바뀐다 —
// 그룹 순서는 프로젝트 탭 순서(= 1~9 번호)를 따라야 위치로 기억할 수 있다.
test('그룹 순서는 프로젝트 탭 순서를 따른다', () => {
  const projects = [{ id: 3, name: '셋' }, { id: 1, name: '가' }, { id: 2, name: '나' }];
  const list = [
    todo({ id: 'a', project_id: 2, project_name: '나', due: '2026-08-01' }), // 마감이 가장 이르다
    todo({ id: 'b', project_id: 3, project_name: '셋', due: '2026-08-02' }),
    todo({ id: 'c', project_id: 1, due: '2026-08-03' }),
  ];
  assert.deepEqual(VIEW.todayGroups(list, projects).map((g) => g.label), ['셋', '가', '나']);
  // flat 순서도 같이 따라와야 한다 (선택 인덱스의 근거)
  assert.deepEqual(VIEW.todayGroups(list, projects).flatMap((g) => g.items).map((i) => i.id), ['b', 'c', 'a']);
});

test('목록에 없는 프로젝트와 미지정은 뒤로 밀린다', () => {
  const projects = [{ id: 1, name: '가' }];
  const list = [
    { id: 'x', title: '무소속', project_id: null },
    todo({ id: 'y', project_id: 9, project_name: '보관됨' }),
    todo({ id: 'z', project_id: 1 }),
  ];
  assert.deepEqual(VIEW.todayGroups(list, projects).map((g) => g.label), ['가', '미지정', '보관됨']);
});

// ── 타임라인
const ev = (h1, h2, extra = {}) => ({
  title: `${h1}시`,
  start_at: new Date(2026, 7, 6, h1, 0),
  end_at: new Date(2026, 7, 6, h2, 0),
  ...extra,
});

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
test('빈 설정은 기본값을 밝힌다', () => {
  assert.equal(VIEW.settingDisplay({ key: 'notifyAt', kind: 'time' }, {}, { notifyAt: '09:00' }), '09:00 (기본)');
  assert.match(VIEW.settingDisplay({ key: 'notifyAt', kind: 'time' }, {}, {}), /기본/);
});

test('설정한 값이 있으면 그대로 보여준다', () => {
  const values = { notifyAt: '07:30', notifyEnabled: false };
  assert.equal(VIEW.settingDisplay({ key: 'notifyAt', kind: 'time' }, values), '07:30');
  assert.equal(VIEW.settingDisplay({ key: 'notifyEnabled', kind: 'bool' }, values), '꺼짐');
  assert.equal(VIEW.settingDisplay({ key: 'notifyEnabled', kind: 'bool' }, {}), '켜짐'); // 기본은 켜짐
});

// ── 대기 재촉 (재촉하면 경과 시계가 그때부터 다시 돈다)
test('재촉 전에는 부탁한 날부터, 재촉 후에는 재촉한 날부터 센다', () => {
  const now = new Date(2026, 7, 10).getTime();
  const plain = VIEW.waitMeta({ captured_at: new Date(2026, 7, 3) }, now);
  assert.equal(plain.label, '경과 7일');
  assert.equal(plain.hot, true); // 5일 넘음
  const nudged = VIEW.waitMeta(
    { captured_at: new Date(2026, 7, 3), nudged_at: new Date(2026, 7, 9), nudge_count: 2 },
    now
  );
  assert.equal(nudged.label, '재촉 후 1일');
  assert.equal(nudged.hot, false); // 방금 찔렀으니 아직 급하지 않다
  assert.equal(nudged.nudges, 2);
});

test('재촉 경계는 브리핑과 같은 5일이다', () => {
  const now = new Date(2026, 7, 10).getTime();
  assert.equal(VIEW.waitMeta({ captured_at: new Date(2026, 7, 5) }, now).hot, true); // 5일
  assert.equal(VIEW.waitMeta({ captured_at: new Date(2026, 7, 6) }, now).hot, false); // 4일
  assert.equal(VIEW.STALE_WAITING_DAYS, 5);
});

// ── 이슈에서 세운 할 일
