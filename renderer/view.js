// 화면 계산 — DOM을 만들지 않는 부분만 모았다.
//
// 여기 있는 것들은 전부 순수 함수라 node --test로 검증한다. 이 파일을 따로 뺀 이유는
// 선택 인덱스와 그리는 순서가 어긋나 엉뚱한 항목이 지워진 적이 있었고(오늘 탭 그룹핑),
// 그런 종류의 버그는 앱을 띄워 눈으로 보는 방법 말고는 잡을 길이 없었기 때문이다.
//
// 렌더러에서는 <script>로, 테스트에서는 import로 읽고 둘 다 globalThis.VIEW를 본다.
(function (root) {
  const DAY_MS = 86400000;
  const WEEKDAYS = '일월화수목금토';

  function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // 마감 배지. 오늘을 기준으로 지연(over)·오늘(today)·남음을 가른다.
  function dueBadge(due, now = new Date()) {
    if (!due) return null;
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const d = new Date(due);
    d.setHours(0, 0, 0, 0);
    const diff = Math.round((today - d) / DAY_MS);
    if (diff > 0) return { text: `D+${diff}`, cls: 'over' };
    if (diff === 0) return { text: '오늘', cls: 'today' };
    return { text: `D-${-diff}`, cls: '' };
  }

  function elapsedDays(ts, now = Date.now()) {
    return Math.max(0, Math.floor((now - new Date(ts).getTime()) / DAY_MS));
  }

  // 검색은 눈에 보이는 글자 전부를 훑는다 — 제목만 보면 "누구를 기다리는 것"을 찾을 수 없다.
  // 낱말이 여럿이면 모두 포함해야 한다(AND).
  function matches(row, q) {
    if (!q) return true;
    const hay = [row.title, row.note, row.project_name, row.waiting_for, row.name, row.abbr]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((term) => hay.includes(term));
  }

  // 지연·오늘 마감은 "지금 해야 하는 것"이다. 완료한 것은 급할 게 없다.
  function isUrgent(it, now = new Date()) {
    if (!it.due || it.done_at) return false;
    const cls = dueBadge(it.due, now)?.cls;
    return cls === 'over' || cls === 'today';
  }

  // 오늘 탭 배치 — [{ key, label, pid, items }].
  // 그리는 쪽과 선택 인덱스가 이 순서를 함께 쓰므로, 여기가 유일한 정렬 기준이어야 한다.
  function todayGroups(list, { now = new Date() } = {}) {
    const urgent = [];
    const rest = [];
    for (const it of list) (isUrgent(it, now) ? urgent : rest).push(it);

    const groups = [];
    if (urgent.length) {
      urgent.sort((a, b) => String(a.due).localeCompare(String(b.due))); // 가장 오래 지난 것부터
      groups.push({ key: 'urgent', label: '지금 — 지연 · 오늘 마감', items: urgent });
    }
    const byProject = new Map(); // 첫 등장 순서 = 그룹 순서
    for (const it of rest) {
      const pid = it.project_id ?? 0;
      if (!byProject.has(pid)) byProject.set(pid, []);
      byProject.get(pid).push(it);
    }
    for (const [pid, items] of byProject) {
      groups.push({ key: `p${pid}`, pid, label: items[0].project_name ?? '미지정', items });
    }
    return groups;
  }

  function dayOf(ts) {
    return ymd(new Date(ts));
  }

  function hhmm(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // 일정의 지금 상태 — 지난 것은 흐리게, 진행 중인 것은 강조한다
  function eventState(ev, now = Date.now()) {
    if (ev.all_day) return 'allday';
    const start = new Date(ev.start_at ?? ev.start).getTime();
    const end = new Date(ev.end_at ?? ev.end ?? start).getTime();
    if (end <= now) return 'past';
    if (start <= now) return 'live';
    return 'next';
  }

  // 완료 항목과 커밋을 하루 단위로 묶는다 (최근 날짜부터)
  function historyDays(data) {
    const byDay = new Map();
    const bucket = (ts) => {
      const k = dayOf(ts);
      if (!byDay.has(k)) byDay.set(k, { key: k, items: [], commits: [] });
      return byDay.get(k);
    };
    for (const it of data?.items ?? []) bucket(it.done_at).items.push(it);
    for (const c of data?.commits ?? []) bucket(c.occurred_at).commits.push(c);
    return [...byDay.values()].sort((a, b) => b.key.localeCompare(a.key));
  }

  function dayLabel(key, now = new Date()) {
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const today = ymd(now);
    const yesterday = ymd(new Date(now.getTime() - DAY_MS));
    const suffix = key === today ? ' (오늘)' : key === yesterday ? ' (어제)' : '';
    return `${m}/${d} (${WEEKDAYS[date.getDay()]})${suffix}`;
  }

  // 설정 값 표시. 비어 있으면 무엇이 대신 쓰이는지를 그 자리에 적는다 —
  // "미설정"만 띄우면 볼트에 왜 안 써졌는지 알 수 없다.
  function settingDisplay(field, values = {}, defaults = {}) {
    const v = values[field.key];
    if (field.kind === 'bool') return v === false ? '꺼짐' : '켜짐';
    if (field.kind === 'time') return v || `${defaults.notifyAt ?? '09:00'} (기본)`;
    // 토큰이 박힌 값은 main에서 이미 가려서 내려온다 — 없으면 안 쓰는 상태다
    if (field.kind === 'secret') return v || '미설정 — Enter로 붙여넣기';
    if (v) return v;
    if (field.key === 'backupDir') return `${defaults.backupDir ?? ''} (기본)`;
    return '미설정 — Enter로 폴더 선택';
  }

  root.VIEW = {
    dueBadge,
    elapsedDays,
    matches,
    isUrgent,
    todayGroups,
    dayOf,
    hhmm,
    eventState,
    historyDays,
    dayLabel,
    settingDisplay,
  };
})(globalThis);
