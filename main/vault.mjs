// 주간 리뷰를 Obsidian 볼트에 쓴다 (D5: DB가 원본, 볼트는 생성된 뷰).
//
// 오픈이슈 #1 결론: 일일 업무일지·월간요약(AUTO:ROLLUP)은 "무엇을 했나"를 커밋에서 뽑아 적는다.
// 주간 리뷰는 성격이 다른 글(흐름·판단·다음 초점)이므로 같은 월 폴더에 **별도 파일**로 둔다.
// 파일 안에서도 AUTO 마커 안쪽만 갈아끼워 사람이 덧붙인 메모는 건드리지 않는다.
import fs from 'node:fs';
import path from 'node:path';

const START = '<!-- AUTO:WEEKLY:START -->';
const END = '<!-- AUTO:WEEKLY:END -->';
export const WORKLOG_DIR = '00_업무일지'; // 볼트를 알아보는 표식이자 주간 리뷰가 들어가는 폴더

// 볼트 경로를 코드에 박지 않는다 — 홈 아래에서 `00_업무일지`를 가진 폴더를 찾아 후보로 쓴다.
// 못 찾으면 null이고, 그때는 설정 화면에서 사용자가 직접 고른다.
export function guessVaultRoot(home, { depth = 2, readdir = defaultReaddir } = {}) {
  const seen = new Set();
  let level = [home];
  for (let d = 0; d <= depth; d++) {
    const next = [];
    for (const dir of level) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      const names = readdir(dir);
      if (names.includes(WORKLOG_DIR)) return dir;
      for (const name of names) {
        if (name.startsWith('.') || name.startsWith('$')) continue; // 숨김·시스템 폴더는 건너뛴다
        next.push(path.join(dir, name));
      }
    }
    level = next;
  }
  return null;
}

function defaultReaddir(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return []; // 권한 없는 폴더는 조용히 건너뛴다
  }
}

export function weeklyPath(vaultRoot, date, week) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return path.join(
    vaultRoot,
    WORKLOG_DIR,
    `${y}년`,
    `${m}월`,
    `00_주간리뷰_${week.year}-W${String(week.week).padStart(2, '0')}.md`
  );
}

function frontmatter(week, range) {
  const title = `주간 리뷰 ${week.year}-W${String(week.week).padStart(2, '0')}`;
  return [
    '---',
    `title: ${title}`,
    'aliases:',
    `  - ${title}`,
    'tags:',
    '  - type/worklog',
    '  - type/review',
    'status: current',
    `period: ${range.label}`,
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n');
}

// 마커 블록을 갈아끼운다. 파일이 없으면 프론트매터와 함께 새로 만든다.
export function writeWeekly(file, body, { week, range, generatedAt = new Date() }) {
  const stamp = `> 자동 생성: ${generatedAt.toISOString().slice(0, 16).replace('T', ' ')} · 기간 ${range.label}`;
  const block = `${START}\n${stamp}\n\n${body}\n${END}`;

  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // 새 파일
  }

  if (text.includes(START) && text.includes(END)) {
    const head = text.slice(0, text.indexOf(START));
    const tail = text.slice(text.indexOf(END) + END.length);
    text = head + block + tail;
  } else if (text.trim()) {
    text = `${text.trimEnd()}\n\n${block}\n`;
  } else {
    text = `${frontmatter(week, range)}${block}\n`;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}
