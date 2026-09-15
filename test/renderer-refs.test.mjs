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

// 문자열·주석을 앞에서부터 한 번에 걷어낸다. 정규식을 종류별로 차례로 돌리면 큰따옴표 안의
// 작은따옴표("'")나 작은따옴표 안의 백틱('\u0060')이 다른 리터럴의 시작으로 읽혀 그 뒤
// 코드가 통째로 지워진다 — 실제로 그래서 captureHotkey가 미정의로 잡혔다. 스캐너는
// 지금 어떤 리터럴 안에 있는지를 알고 있으므로 그 안의 다른 따옴표를 시작으로 보지 않는다.
function stripLiterals(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // 정규식 리터럴 판정용 — 직전의 의미 있는 글자. 이 글자들 뒤의 /는 나눗셈이 아니라 정규식이다.
  // /^F([1-9]|…)$/ 같은 것이 남아 있으면 F( 가 호출로 읽힌다(실제로 그랬다).
  let last = '';
  const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '\n', '']);
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '/' && (REGEX_AFTER.has(last) || /\breturn$/.test(out.slice(-8)))) {
      // 정규식: 이스케이프와 [문자 클래스] 안의 /는 끝이 아니다. 플래그는 그냥 지나간다.
      i++;
      let inClass = false;
      while (i < n) {
        const r = src[i];
        if (r === '\\') { i += 2; continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
        else if (r === '\n') break; // 줄이 바뀌면 정규식이 아니었다 — 여기서 멈춘다
        i++;
      }
      i++;
      while (i < n && /[a-z]/.test(src[i])) i++;
      out += '//'; // 자리는 남긴다
      last = '/';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '\u0060') {
      const q = ch;
      out += q + q; // 자리는 남긴다 — 빈 문자열로 두어 토큰 경계가 유지되게
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') i++; // 이스케이프된 다음 문자는 건너뛴다
        i++;
      }
      i++; // 닫는 따옴표
      last = q;
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) last = ch;
    else if (ch === '\n') last = '\n';
    i++;
  }
  return out;
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
