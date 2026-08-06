// AI 가공 (D3·D4) — 유일한 claude -p 접점. Claude는 텍스트(JSON)만 반환하고 DB 쓰기는 앱이 한다.
// 프롬프트는 stdin으로 넘긴다 — Windows 인자 길이·따옴표 문제를 피한다.
import { spawn } from 'node:child_process';

// CLI는 API 오류를 만나면 **stdout에 찍고 종료 코드 1**로 끝난다 — stderr만 보면 이유를 놓친다.
// 게다가 529 같은 일시 오류는 CLI가 내부적으로 4분 가까이 재시도하므로, 우리 타임아웃이 그보다
// 짧으면 진짜 원인을 못 보고 "응답 없음"으로만 잘린다. 그래서 기본 타임아웃을 넉넉히 잡는다.
const DEFAULT_TIMEOUT_MS = 300_000;

function friendlyError(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (/529|overloaded/i.test(s)) return 'Claude 서버가 혼잡합니다 (529) — 잠시 뒤 다시 시도하세요';
  if (/rate limit|usage limit|quota/i.test(s)) return '구독 사용량 한도에 걸렸습니다 — 잠시 뒤 다시 시도하세요';
  if (/not logged in|authentication|unauthorized/i.test(s)) return 'Claude 로그인이 필요합니다 — 터미널에서 `claude` 실행 후 로그인';
  return s.split('\n')[0].slice(0, 160);
}

function claudeP(prompt, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude.exe', ['-p'], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude -p 응답이 없어 ${Math.round(timeoutMs / 1000)}초에서 중단했습니다`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? 'claude 실행 파일을 찾을 수 없습니다' : String(e.message ?? e)));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      reject(new Error(friendlyError(err || out) ?? `claude가 종료 코드 ${code}로 끝났습니다`));
    });
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  });
}

export { friendlyError };

// 모델이 JSON 앞뒤에 말을 붙여도 살려낸다
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON in response');
  return JSON.parse(text.slice(start, end + 1));
}

function fmtWhen(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 이슈와 PR을 한 줄로. 관계(리뷰 대기·할당)까지 적어야 모델이 급한 것을 고를 수 있다.
function issueLine(i) {
  const tag = i.kind === 'pr' ? (i.provider === 'gitlab' ? 'MR' : 'PR') : '이슈';
  const rel =
    i.relation === 'reviewer' ? '·내 리뷰 대기' : i.relation === 'author' ? '' : '·나에게 할당';
  return `- [${tag}${i.draft ? '·초안' : ''}${rel}] #${i.number} ${i.title}`;
}

export function buildResumePrompt(project, { activities, doneItems, issues, todos }) {
  const lines = [];
  lines.push(`프로젝트 "${project.name}"의 작업 재개 카드를 만든다.`);
  lines.push('아래 자료(최근 커밋·완료한 일·열린 이슈·PR·남은 todo)를 근거로만 판단하고, 자료에 없는 내용을 지어내지 않는다.');
  lines.push('내 리뷰를 기다리는 PR이 있으면 남을 막고 있는 일이므로 다음 액션 후보로 먼저 고려한다.');
  lines.push('');
  lines.push('## 최근 커밋 (최신순)');
  lines.push(activities.length
    ? activities.map((a) => `- ${fmtWhen(a.occurred_at)} ${a.summary}`).join('\n')
    : '- (없음)');
  lines.push('');
  lines.push('## 최근 완료한 일');
  lines.push(doneItems.length ? doneItems.map((d) => `- ${d.title}`).join('\n') : '- (없음)');
  lines.push('');
  lines.push('## 열린 이슈·PR');
  const open = issues.filter((i) => i.state === 'open');
  lines.push(open.length ? open.map(issueLine).join('\n') : '- (없음)');
  lines.push('');
  lines.push('## 남은 todo');
  lines.push(todos.length ? todos.map((t) => `- ${t.title}`).join('\n') : '- (없음)');
  lines.push('');
  lines.push('다음 JSON만 출력한다. 설명·코드펜스 금지:');
  lines.push('{"last_work": "마지막으로 하던 작업 1~2문장", "stuck_point": "멈춘 지점 1문장 (모르면 \\"불명확\\")", "next_action": "다음 액션 딱 1개, 구체적으로 1문장"}');
  return lines.join('\n');
}

// ── 인박스 분류 (설계 5절) — 제안만 만든다. 확정은 사람이 한다(D4).
export function buildClassifyPrompt(items, projects) {
  const lines = [];
  lines.push('아래 "할 일"들을 프로젝트에 배정하는 제안을 만든다.');
  lines.push('근거는 제목의 키워드와 캡처 당시 창 제목뿐이다. 애매하면 배정하지 말고 빼라 — 틀린 제안이 빈 제안보다 나쁘다.');
  lines.push('');
  lines.push('## 프로젝트');
  lines.push(projects.map((p) => `- id=${p.id} ${p.name}${p.abbr ? ` (#${p.abbr})` : ''}`).join('\n'));
  lines.push('');
  lines.push('## 항목');
  for (const it of items) {
    const ctx = it.context?.fg ? ` [캡처 당시 창: ${it.context.fg}]` : '';
    lines.push(`- id=${it.id} ${it.title}${ctx}`);
  }
  lines.push('');
  lines.push('다음 JSON만 출력한다. 설명·코드펜스 금지. 확신 없는 항목은 배열에 넣지 않는다:');
  lines.push('{"assign": [{"id": "항목 id", "project_id": 숫자}]}');
  return lines.join('\n');
}

export async function classifyInbox(items, projects) {
  if (!items.length || !projects.length) return [];
  const json = extractJson(await claudeP(buildClassifyPrompt(items, projects)));
  const validIds = new Set(items.map((i) => String(i.id)));
  const validProjects = new Set(projects.map((p) => p.id));
  return (Array.isArray(json.assign) ? json.assign : [])
    .map((a) => ({ id: String(a.id), project_id: Number(a.project_id) }))
    // 모델이 없는 id·프로젝트를 지어내도 DB에 닿지 않게 여기서 거른다
    .filter((a) => validIds.has(a.id) && validProjects.has(a.project_id));
}

// ── 주간 리뷰 초안 (설계 5절)
export function buildWeeklyPrompt(range, material) {
  const byProject = (rows, fmt) => {
    if (!rows.length) return '- (없음)';
    const groups = new Map();
    for (const r of rows) {
      const key = r.project ?? '미지정';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(fmt(r));
    }
    return [...groups]
      .map(([name, lines]) => `### ${name}\n${lines.map((l) => `- ${l}`).join('\n')}`)
      .join('\n');
  };

  const lines = [];
  lines.push(`${range.label} 주간 회고 초안을 쓴다. 아래 자료에 있는 사실만 쓰고 지어내지 않는다.`);
  lines.push('일일 업무일지가 "무엇을 했는지"를 이미 적고 있으므로, **같은 내용을 다시 나열하지 말고** 한 주를 관통하는 흐름·판단·막힌 지점을 쓴다.');
  lines.push('');
  lines.push('## 완료한 항목');
  lines.push(byProject(material.done, (r) => r.title));
  lines.push('');
  lines.push('## 커밋');
  lines.push(byProject(material.commits, (r) => r.summary));
  lines.push('');
  lines.push('## 아직 기다리는 것');
  lines.push(material.waiting.length
    ? material.waiting.map((w) => `- ${w.title} → ${w.waiting_for ?? '(미지정)'}`).join('\n')
    : '- (없음)');
  lines.push('');
  lines.push('## 남은 할 일');
  lines.push(material.openTodos.length
    ? material.openTodos.slice(0, 20).map((t) => `- [${t.project ?? '미지정'}] ${t.title}`).join('\n')
    : '- (없음)');
  lines.push('');
  lines.push('아래 마크다운 형식으로만 출력한다(제목 줄 없이 본문부터, 코드펜스 금지):');
  lines.push('## 이번 주 흐름\n(3~5문장. 프로젝트별 나열이 아니라 한 주 전체의 줄거리)\n\n## 판단·배운 것\n- (2~4개. 무엇을 왜 그렇게 정했는지)\n\n## 막힌 것·기다리는 것\n- (없으면 "없음")\n\n## 다음 주 초점\n- (3개 이내, 구체적으로)');
  return lines.join('\n');
}

export async function generateWeeklyReview(range, material) {
  const raw = await claudeP(buildWeeklyPrompt(range, material));
  return raw.replace(/^```[a-z]*\n?|```$/gm, '').trim();
}

export async function generateResumeCard(project, material) {
  const raw = await claudeP(buildResumePrompt(project, material));
  const json = extractJson(raw);
  return {
    last_work: String(json.last_work ?? '').slice(0, 500),
    stuck_point: String(json.stuck_point ?? '').slice(0, 500),
    next_action: String(json.next_action ?? '').slice(0, 500),
  };
}
