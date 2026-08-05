// 앱 설정 (userData/settings.json) — 지금은 창 위치·크기만 담는다.
// 쓰기는 묶어서(디바운스) 한다: 창을 끄는 동안 move 이벤트가 수십 번 오기 때문이다.
import fs from 'node:fs';
import path from 'node:path';

export function createSettings(file, delayMs = 400) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // 없거나 깨졌으면 기본값으로 시작한다 — 설정이 캡처를 막아서는 안 된다
  }
  let timer = null;

  function flush() {
    clearTimeout(timer);
    timer = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    } catch {}
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  }

  return {
    get: (key, fallback = null) => data[key] ?? fallback,
    set(key, value) {
      data[key] = value;
      schedule();
    },
    remove(key) {
      delete data[key];
      schedule();
    },
    flush,
    file,
  };
}
