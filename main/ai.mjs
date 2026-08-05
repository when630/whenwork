// AI 가공 (D3·D4) — 유일한 claude -p 접점. Claude는 텍스트(JSON)만 반환하고 DB 쓰기는 앱이 한다.
// 프롬프트는 stdin으로 넘긴다 — Windows 인자 길이·따옴표 문제를 피한다.
import { spawn } from 'node:child_process';

function claudeP(prompt, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude.exe', ['-p'], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('claude -p timeout'));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err || `claude exited ${code}`));
    });
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  });
}

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

export function buildResumePrompt(project, { activities, doneItems, issues, todos }) {
  const lines = [];
  lines.push(`프로젝트 "${project.name}"의 작업 재개 카드를 만든다.`);
  lines.push('아래 자료(최근 커밋·완료한 일·열린 이슈·남은 todo)를 근거로만 판단하고, 자료에 없는 내용을 지어내지 않는다.');
  lines.push('');
  lines.push('## 최근 커밋 (최신순)');
  lines.push(activities.length
    ? activities.map((a) => `- ${fmtWhen(a.occurred_at)} ${a.summary}`).join('\n')
    : '- (없음)');
  lines.push('');
  lines.push('## 최근 완료한 일');
  lines.push(doneItems.length ? doneItems.map((d) => `- ${d.title}`).join('\n') : '- (없음)');
  lines.push('');
  lines.push('## 열린 이슈');
  lines.push(issues.length
    ? issues.filter((i) => i.state === 'open').map((i) => `- #${i.number} ${i.title}`).join('\n')
    : '- (없음)');
  lines.push('');
  lines.push('## 남은 todo');
  lines.push(todos.length ? todos.map((t) => `- ${t.title}`).join('\n') : '- (없음)');
  lines.push('');
  lines.push('다음 JSON만 출력한다. 설명·코드펜스 금지:');
  lines.push('{"last_work": "마지막으로 하던 작업 1~2문장", "stuck_point": "멈춘 지점 1문장 (모르면 \\"불명확\\")", "next_action": "다음 액션 딱 1개, 구체적으로 1문장"}');
  return lines.join('\n');
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
