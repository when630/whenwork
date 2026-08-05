// 주간 리뷰를 Obsidian 볼트에 쓴다 (D5: DB가 원본, 볼트는 생성된 뷰).
//
// 오픈이슈 #1 결론: 일일 업무일지·월간요약(AUTO:ROLLUP)은 "무엇을 했나"를 커밋에서 뽑아 적는다.
// 주간 리뷰는 성격이 다른 글(흐름·판단·다음 초점)이므로 같은 월 폴더에 **별도 파일**로 둔다.
// 파일 안에서도 AUTO 마커 안쪽만 갈아끼워 사람이 덧붙인 메모는 건드리지 않는다.
import fs from 'node:fs';
import path from 'node:path';

const START = '<!-- AUTO:WEEKLY:START -->';
const END = '<!-- AUTO:WEEKLY:END -->';

export function weeklyPath(vaultRoot, date, week) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return path.join(
    vaultRoot,
    '00_업무일지',
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
