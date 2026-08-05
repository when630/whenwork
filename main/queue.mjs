// 캡처 로컬 큐 (D1) — append-only JSONL.
// 캡처 경로에는 어떤 의존성도 두지 않는다: DB·네트워크가 죽어도 append는 성공해야 한다.
// Electron에 기대지 않는 순수 모듈로 두어 node --test로 검증한다.
import fs from 'node:fs';
import path from 'node:path';

export function createQueue(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let draining = false;

  function append(entry) {
    // 동기 기록 — 캡처 직후 앱이 죽어도 줄은 남는다
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  }

  function readAll() {
    if (!fs.existsSync(file)) return [];
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // 깨진 줄(중간 크래시 등)은 버리지 않으면 큐 전체가 막힌다 — 건너뛴다
      }
    }
    return out;
  }

  function count() {
    return readAll().length;
  }

  // 큐 내용을 consume(entries)에 넘기고, 성공하면 그 시점까지의 바이트를 잘라낸다.
  // drain 중(await 사이)에 append가 끼어들 수 있으므로 길이를 기억해 꼬리만 남긴다.
  async function drain(consume) {
    if (draining) return 0;
    if (!fs.existsSync(file)) return 0;
    draining = true;
    try {
      const data = fs.readFileSync(file, 'utf8');
      if (!data.trim()) return 0;
      const entries = [];
      for (const line of data.split('\n')) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {}
      }
      if (entries.length === 0) return 0;
      await consume(entries); // 실패(throw)하면 파일은 그대로 — 다음 drain에서 재시도
      const after = fs.readFileSync(file, 'utf8');
      const tail = after.slice(data.length);
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, tail, 'utf8');
      fs.renameSync(tmp, file);
      return entries.length;
    } finally {
      draining = false;
    }
  }

  return { append, readAll, count, drain, file };
}
