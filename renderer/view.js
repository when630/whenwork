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

  // 오래 기다린 것으로 치는 경계. main/brief.mjs의 STALE_WAITING_DAYS와 같은 값이어야
  // 화면의 빨간 글씨와 아침 브리핑이 같은 항목을 가리킨다.
  const STALE_WAITING_DAYS = 5;

  // 대기 항목의 상태 한 줄. **재촉한 뒤로는 경과를 재촉 시점부터 다시 센다** —
  // 처음 부탁한 날로만 세면 어제 재촉한 건과 열흘째 방치한 건이 같은 숫자로 보인다.
  function waitMeta(it, now = Date.now()) {
    const nudged = it.nudged_at ?? null;
    const days = elapsedDays(nudged ?? it.captured_at, now);
    return {
      days,
      nudges: Number(it.nudge_count ?? 0),
      hot: days >= STALE_WAITING_DAYS,
      label: nudged ? `재촉 후 ${days}일` : `경과 ${days}일`,
    };
  }

  // 이슈에서 세운 할 일에 붙는 표식. 원본이 닫혔으면 그 사실이 가장 중요하다 —
  // 다만 알리기만 하고 완료 처리는 사람이 한다. 앱이 대신 체크하기 시작하면
  // item이 더 이상 "사람 입력이 원본"(6절)이 아니게 된다.
  function issueBadge(it) {
    if (!it?.issue_url) return null;
    const kind = it.issue_kind === 'pr' ? (it.issue_provider === 'gitlab' ? 'MR' : 'PR') : '이슈';
    const head = [kind, it.issue_number ? `#${it.issue_number}` : ''].filter(Boolean).join(' ');
    if (it.issue_state === 'merged') return { text: `${head} 머지됨`, cls: 'closed' };
    if (it.issue_state && it.issue_state !== 'open') return { text: `${head} 닫힘`, cls: 'closed' };
    return { text: head, cls: '' };
  }

  // 검색은 눈에 보이는 글자 전부를 훑는다 — 제목만 보면 "누구를 기다리는 것"을 찾을 수 없다.
  // 낱말이 여럿이면 모두 포함해야 한다(AND).
  function matches(row, q) {
    if (!q) return true;
    // 이슈는 번호로 부른다 — "#210"도 "210"도 걸리게 넣는다
    const hay = [row.title, row.note, row.project_name, row.waiting_for, row.name, row.abbr,
      row.number != null ? `#${row.number}` : null]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((term) => hay.includes(term));
  }

  // 오늘 탭 배치 — [{ key, label, pid, items }]. 프로젝트별로만 묶는다.
  //
  // 급한 것(지연·오늘 마감)을 맨 위 별도 그룹으로 뽑아봤지만, 같은 화면에 그룹 기준이
  // 둘(급함/프로젝트)이 되면서 오히려 어수선했다. 급한 건 마감 배지(D+2·오늘)가 알려주고
  // 그룹 안에서는 마감 빠른 순으로 서므로(getViewState의 ORDER BY) 위치로 또 표시할 필요가 없다.
  //
  // 그룹 순서는 **프로젝트 탭 순서**(= 1~9 번호)를 따른다. 항목이 마감 순으로 오므로
  // 첫 등장 순서대로 묶으면 그룹 자리가 마감에 따라 매일 바뀌어, 위치로 기억할 수가 없다.
  // projects가 없으면(테스트 등) 들어온 순서를 그대로 쓴다.
  //
  // 그리는 쪽과 선택 인덱스가 이 순서를 함께 쓰므로, 여기가 유일한 정렬 기준이어야 한다.
  function todayGroups(list, projects = []) {
    const byProject = new Map();
    for (const it of list) {
      const pid = it.project_id ?? 0;
      if (!byProject.has(pid)) byProject.set(pid, []);
      byProject.get(pid).push(it);
    }
    const order = new Map(projects.map((p, i) => [p.id, i]));
    // 목록에 없는 프로젝트·미지정은 뒤로. 같은 값이면 Array.sort가 안정적이라 등장 순서가 남는다
    const rank = (pid) => (order.has(pid) ? order.get(pid) : Number.MAX_SAFE_INTEGER);
    return [...byProject]
      .sort((a, b) => rank(a[0]) - rank(b[0]))
      .map(([pid, items]) => ({
        key: `p${pid}`,
        pid,
        label: items[0].project_name ?? '미지정',
        items,
      }));
  }

  // 일정을 시간 축에 늘어놓고 "지금"이 어디쯤인지 끼워 넣는다.
  // 종일 일정은 놓일 시각이 없으므로 축에서 빼내 위에 따로 세운다.
  // 반환 순서가 곧 그리는 순서다 — 축 선이 이 순서를 따라 이어진다.
  function timeline(events = [], now = Date.now()) {
    const allDay = events.filter((e) => e.all_day);
    const timed = events
      .filter((e) => !e.all_day)
      .slice()
      .sort((a, b) => new Date(a.start_at ?? a.start) - new Date(b.start_at ?? b.start));
    if (!timed.length) return { allDay, rows: [] };

    const rows = [];
    let placed = false;
    for (const ev of timed) {
      const start = new Date(ev.start_at ?? ev.start).getTime();
      // 아직 시작하지 않은 첫 일정 앞이 "지금"의 자리다
      if (!placed && start > now) {
        rows.push({ type: 'now' });
        placed = true;
      }
      rows.push({ type: 'event', ev });
    }
    if (!placed) rows.push({ type: 'now' }); // 남은 일정이 없으면 축의 끝
    return { allDay, rows };
  }

  // "방금 그 회의" — 후속 할 일을 붙일 일정을 고른다.
  // 진행 중인 것이 우선이고, 없으면 가장 최근에 끝난 것. 끝난 지 오래됐으면(cutoffMin)
  // 후속을 적을 시점이 지난 것이라 고르지 않는다. 종일 일정은 후속을 낳는 자리가 아니다.
  function focusEvent(events = [], now = Date.now(), cutoffMin = 180) {
    const at = (e, key) => new Date(e[`${key}_at`] ?? e[key] ?? e.start_at ?? e.start).getTime();
    const timed = events.filter((e) => !e.all_day);
    const live = timed.find((e) => at(e, 'start') <= now && at(e, 'end') > now);
    if (live) return live;
    let best = null;
    for (const e of timed) {
      const end = at(e, 'end');
      if (end > now || now - end > cutoffMin * 60000) continue;
      if (!best || end > at(best, 'end')) best = e;
    }
    return best;
  }

  // 캡처 당시의 맥락 한 줄. 회의 후속으로 담은 것은 그 회의를 밝힌다 —
  // 인박스를 정리할 때 "이게 왜 여기 있지"를 푸는 유일한 단서다.
  function captureContext(it) {
    if (it?.context?.meeting) return `회의 후속: ${it.context.meeting}`;
    if (it?.context?.fg) return `캡처 당시: ${it.context.fg}`;
    return null;
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

  // "14:10–15:10". 시작만 보여주면 회의가 언제 끝나는지 몰라 그 뒤에 뭘 넣을지 판단할 수 없다.
  function eventTime(ev) {
    if (ev.all_day) return '종일';
    const start = ev.start_at ?? ev.start;
    const end = ev.end_at ?? ev.end;
    const a = hhmm(start);
    const b = end ? hhmm(end) : '';
    return b && b !== a ? `${a}–${b}` : a;
  }

  // 분 단위를 사람이 읽는 길이로. 0분이면 null (붙일 말이 없다)
  function humanSpan(minutes) {
    const m = Math.round(minutes);
    if (m <= 0) return null;
    if (m < 60) return `${m}분`;
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h}시간 ${rest}분` : `${h}시간`;
  }

  // 지금 기준의 한마디 — 진행 중이면 남은 시간, 앞으로면 시작까지. 지난 것은 말이 없다.
  // 이 값은 시간이 지나면 틀어지므로 화면 쪽에서 주기적으로 다시 그린다.
  function eventRelative(ev, now = Date.now()) {
    if (ev.all_day) return null;
    const start = new Date(ev.start_at ?? ev.start).getTime();
    const end = new Date(ev.end_at ?? ev.end ?? start).getTime();
    if (end <= now) return null;
    if (start <= now) {
      const left = humanSpan((end - now) / 60000);
      return left ? `${left} 남음` : '곧 끝남';
    }
    const until = humanSpan((start - now) / 60000);
    return until ? `${until} 뒤` : '곧 시작';
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
  // 이슈 탭의 서브탭 — [{ key, label, pid, items }]. ←→로 오간다.
  //
  // 첫 자리는 **「지금」**(최근 커밋이 난 프로젝트의 열린 이슈). 열린 것을 통째로 늘어놓으면
  // 백로그가 쏟아진다 — 실측 17건 중 10건이 엿새째 그대로였고 그 사이 손대고 있던 건 3건이었다.
  // active 판정은 화면이 하지 않는다(SQL이 내려준다) — 아침 브리핑과 같은 기준을 써야 해서다.
  //
  // 「지금」이 비면 그 자리를 만들지 않는다. 빈 탭으로 열리면 탭이 있으나 마나이고,
  // 그날 아무 리포에도 커밋이 없었다는 뜻이라 프로젝트별로 보는 게 맞다.
  function issueTabs(list = [], projects = []) {
    const tabs = [];
    const active = list.filter((i) => i.active);
    if (active.length) tabs.push({ key: 'now', label: '지금', pid: null, items: active });

    const byProject = new Map();
    for (const i of list) {
      const pid = i.project_id ?? 0;
      if (!byProject.has(pid)) byProject.set(pid, []);
      byProject.get(pid).push(i);
    }
    // 프로젝트 탭 순서(= 1~9 번호)를 따른다 — 갱신 순으로 세우면 자리가 매일 바뀐다
    const order = new Map(projects.map((p, idx) => [p.id, idx]));
    const rank = (pid) => (order.has(pid) ? order.get(pid) : Number.MAX_SAFE_INTEGER);
    for (const [pid, items] of [...byProject].sort((a, b) => rank(a[0]) - rank(b[0]))) {
      tabs.push({
        key: `p${pid}`,
        pid,
        label: items[0].project_name ?? '미지정',
        hot: items.some((i) => i.active),
        items,
      });
    }
    return tabs;
  }

  // 지금 고른 서브탭. 목록이 바뀌어 그 탭이 사라지면 첫 자리로 되돌린다 —
  // 없어진 탭에 머물면 빈 화면이 뜨고 선택 인덱스가 목록과 어긋난다.
  function pickTab(tabs, key) {
    if (!tabs.length) return null;
    return tabs.find((t) => t.key === key) ?? tabs[0];
  }

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
    waitMeta,
    issueBadge,
    focusEvent,
    captureContext,
    STALE_WAITING_DAYS,
    matches,
    todayGroups,
    issueTabs,
    pickTab,
    dayOf,
    hhmm,
    eventState,
    eventTime,
    eventRelative,
    humanSpan,
    timeline,
    historyDays,
    dayLabel,
    settingDisplay,
  };
})(globalThis);
