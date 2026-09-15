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

  function dayOf(ts) {
    return ymd(new Date(ts));
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
  function settingDisplay(field, values = {}, defaults = {}, extra = {}) {
    const v = values[field.key];
    if (field.kind === 'bool') return v === false ? '꺼짐' : '켜짐';
    // PLAT-02: 조합만 보여주면 "적혀 있으니 되겠지"가 된다 — 실제로 안 잡혔으면 그 자리에서 말한다
    if (field.kind === 'hotkey') {
      const shown = v || defaults.hotkey || '';
      return extra.hotkeyOk === false ? `${shown} — 등록 실패! 다른 조합으로 바꾸세요` : shown;
    }
    if (field.kind === 'time') return v || `${defaults.notifyAt ?? '09:00'} (기본)`;
    if (v) return v;
    return '미설정';
  }

  root.VIEW = {
    dueBadge,
    elapsedDays,
    waitMeta,
    STALE_WAITING_DAYS,
    matches,
    todayGroups,
    dayOf,
    historyDays,
    dayLabel,
    settingDisplay,
  };
})(globalThis);
