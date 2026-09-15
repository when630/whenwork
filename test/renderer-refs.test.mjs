import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 렌더러는 <script>로 읽히는 평범한 스크립트라 import가 없다 — 없는 함수를 불러도
// 그 키를 누르기 전까지 아무도 모른다. 실제로 Phase 2에서 재개 카드를 걷어낸 뒤
// openResume 호출 두 개가 남았고, 프로젝트 목록에서 Enter를 누르면 터졌다.
// 화면이 멀쩡히 그려지므로 스모크도 그 자리를 지나가지 않는 한 잡지 못한다.
//
// 그래서 "부르는 이름이 전부 정의돼 있는가"를 기계로 확인한다. 완벽한 파서가 아니라
// 이름 수집이므로, 새 전역을 쓰기 시작하면 GLOBALS에 더해 주면 된다.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// 브라우저·프로젝트가 제공하는 전역
const GLOBALS = new Set([
  'window', 'document', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'Map', 'Set',
  'RegExp', 'Error', 'KeyboardEvent', 'Event', 'CustomEvent', 'parseInt', 'parseFloat', 'isNaN',
  'requestAnimationFrame', 'structuredClone', 'alert', 'confirm', 'fetch', 'Intl',
]);

// `async (e) => {}` 처럼 호출처럼 보이지만 호출이 아닌 자리를 걸러낸다
const KEYWORDS =
  /^(if|for|while|switch|catch|return|typeof|new|await|else|do|case|of|in|delete|void|throw|yield|function|async)$/;

function stripLiterals(src) {
  return src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\[\s\S])*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\[\s\S])*"/g, '""');
}

function definedNames(code) {
  const defined = new Set(GLOBALS);
  for (const m of code.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
  // 구조분해로 받아오는 것 (window.VIEW 등)
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const n = part.split(':').pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) defined.add(n);
    }
  }
  return defined;
}

function calledNames(code) {
  const called = new Set();
  // 앞에 . 이나 식별자 문자가 없는 호출만 — 메서드 호출(a.b())은 제외한다
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!KEYWORDS.test(m[1])) called.add(m[1]);
  }
  return called;
}

for (const file of ['today.js', 'capture.js', 'view.js', 'md.js', 'icons.js']) {
  test(`renderer/${file}가 부르는 함수는 전부 정의돼 있다`, () => {
    const full = path.join(ROOT, 'renderer', file);
    if (!fs.existsSync(full)) return; // 파일이 사라졌으면 검사할 것도 없다
    const code = stripLiterals(fs.readFileSync(full, 'utf8'));
    const defined = definedNames(code);
    const missing = [...calledNames(code)].filter((n) => !defined.has(n)).sort();
    assert.deepEqual(missing, [], `정의되지 않은 함수를 부른다: ${missing.join(', ')}`);
  });
}
