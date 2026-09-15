// 캡처 로컬 큐 (D1) — append-only JSONL.
// 캡처 경로에는 어떤 의존성도 두지 않는다: DB·네트워크가 죽어도 append는 성공해야 한다.
// Electron에 기대지 않는 순수 모듈로 두어 node --test로 검증한다.
import fs from 'node:fs';
import path from 'node:path';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createQueue(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const dir = path.dirname(file);
  const base = path.basename(file, '.jsonl');
  const pendingRe = new RegExp(`^${escapeRegExp(base)}\\.pending-\\d+\\.jsonl$`);

  function append(entry) {
    // 동기 기록 — 캡처 직후 앱이 죽어도 줄은 남는다
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  }

  function parseLines(content) {
    const out = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // 깨진 줄(중간 크래시 등)은 버리지 않으면 큐 전체가 막힌다 — 건너뛴다
      }
    }
    return out;
  }

  function readAll() {
    if (!fs.existsSync(file)) return [];
    return parseLines(fs.readFileSync(file, 'utf8'));
  }

  function count() {
    return readAll().length;
  }

  // 실행 중에는 큐 줄을 지우지 않는다(D-02, append-only). 시작 시 딱 한 번:
  // 1) queue.jsonl을 rename으로 옆에 치운다 — 이 순간부터 새 append는 새로 생기는
  //    queue.jsonl에 쌓인다. rename은 원자적이라 여기서 읽기-쓰기 경합 창이 사라진다.
  // 2) 같은 폴더의 <base>.pending-*.jsonl(이번에 치운 것 + 이전 실행이 반영 도중
  //    죽어 남긴 것)을 이름(=시각) 오름차순으로 모아 하나씩 consume에 동기로 넘긴다.
  // 3) consume이 예외 없이 끝난 파일만 지운다. 예외가 나면 그 파일을 남긴 채 멈춘다 —
  //    다음 기동에서 다시 이 함수가 그 파일을 집어 재시도한다.
  // 던지지 않는다 — 실패는 "대기 파일이 남았다"는 사실로만 드러난다.
  function replayPending(consume) {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8');
      if (content.trim()) {
        const pendingFile = path.join(dir, `${base}.pending-${Date.now()}.jsonl`);
        fs.renameSync(file, pendingFile);
      }
    }

    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => pendingRe.test(f)).sort();
    } catch {
      files = [];
    }

    let replayed = 0;
    for (const f of files) {
      const full = path.join(dir, f);
      let entries;
      try {
        entries = parseLines(fs.readFileSync(full, 'utf8'));
      } catch {
        continue; // 읽지도 못하면 이 파일은 건너뛴다 — 다음 파일은 계속 시도한다
      }
      if (entries.length === 0) {
        try {
          fs.unlinkSync(full);
        } catch {
          // 정리 실패는 무시 — 다음 기동이 다시 본다
        }
        continue;
      }
      try {
        consume(entries); // 실패(throw)하면 이 파일은 그대로 — 다음 기동에서 재시도
        fs.unlinkSync(full);
        replayed += entries.length;
      } catch {
        break; // 이 파일부터는 순서를 지켜야 하므로 뒤 파일은 건드리지 않고 멈춘다
      }
    }
    return replayed;
  }

  return { append, readAll, count, replayPending, file };
}
