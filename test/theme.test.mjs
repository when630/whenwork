import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIN_BG, winBackground } from '../main/theme.mjs';

// 브랜드 색(안개 + 라임)은 renderer/tokens.css 한 곳에 있다. 화면을 켜 봐서는 놓치기 쉬운 것 —
// 대비가 기준 아래로 떨어진 글자, 토큰을 거치지 않고 박힌 색, 창 바탕색과 CSS의 어긋남 — 을 여기서 잡는다.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(ROOT, 'renderer', 'tokens.css'), 'utf8');

function block(src, startRe) {
  const m = startRe.exec(src);
  assert.ok(m, `블록을 못 찾음: ${startRe}`);
  let depth = 0;
  for (let i = src.indexOf('{', m.index); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
  }
  throw new Error('닫히지 않은 블록');
}
function vars(src) {
  const out = {};
  for (const [, k, v] of src.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[k] = v.trim();
  return out;
}
const light = vars(block(css, /^:root \{/m));
const dark = { ...light, ...vars(block(css, /@media \(prefers-color-scheme: dark\)/)) };

function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255]
    .map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
}
function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
// color-mix(in srgb, var(--x) N%, transparent)를 바탕 위에 올린 실제 색
function over(t, expr, bg) {
  const m = /color-mix\(in srgb, var\(--([a-z-]+)\) (\d+)%, transparent\)/.exec(expr);
  assert.ok(m, `해석할 수 없는 색: ${expr}`);
  const fg = t[m[1]], a = Number(m[2]) / 100;
  return '#' + [1, 3, 5].map((i) => Math.round(parseInt(fg.slice(i, i + 2), 16) * a + parseInt(bg.slice(i, i + 2), 16) * (1 - a))
    .toString(16).padStart(2, '0')).join('');
}

const TEXT = ['text-primary', 'text-secondary', 'text-muted', 'accent', 'success', 'warning', 'danger', 'ai'];

for (const [name, t] of [['라이트', light], ['다크', dark]]) {
  test(`${name}: 글자색은 모든 바탕 위에서 4.5:1 이상 (WCAG AA)`, () => {
    const bgs = {
      'bg-app': t['bg-app'], 'bg-raised': t['bg-raised'], 'bg-inset': t['bg-inset'], 'bg-hover': t['bg-hover'],
      'accent-dim': over(t, t['accent-dim'], t['bg-app']),
    };
    for (const k of TEXT) for (const [b, v] of Object.entries(bgs)) {
      const r = ratio(t[k], v);
      assert.ok(r >= 4.5, `${name} --${k} on --${b}: ${r.toFixed(2)}`);
    }
  });

  test(`${name}: 면 위 글자와 포커스 테두리`, () => {
    assert.ok(ratio(t['accent-fill'], t['on-accent']) >= 4.5, '라임 면 위 글자');
    assert.ok(ratio(t.success, t['on-success']) >= 4.5, '완료 체크 위 ✓');
    assert.ok(ratio(t['border-focus'], t['bg-app']) >= 3, '포커스 테두리는 그래픽 기준 3:1');
    for (let n = 1; n <= 7; n++) assert.ok(ratio(t[`proj-${n}`], t['bg-app']) >= 3, `프로젝트 색점 ${n}`);
  });
}

test('창 바탕색은 tokens.css와 같다 — 다르면 창이 뜰 때 한 프레임 다른 색이 번쩍인다', () => {
  assert.equal(WIN_BG.capture.light, light['bg-raised']);
  assert.equal(WIN_BG.capture.dark, dark['bg-raised']);
  assert.equal(WIN_BG.today.light, light['bg-app']);
  assert.equal(WIN_BG.today.dark, dark['bg-app']);
  assert.equal(winBackground('today', true), dark['bg-app']);
  assert.equal(winBackground('capture', false), light['bg-raised']);
  assert.equal(winBackground('없는창', false), light['bg-app'], '모르는 창은 오늘 뷰 바탕');
});

test('렌더러는 색을 직접 쓰지 않는다 — 전부 tokens.css를 거친다 (테마가 바뀌어도 남는 색이 없게)', () => {
  const dir = path.join(ROOT, 'renderer');
  for (const f of fs.readdirSync(dir).filter((x) => /\.(html|js)$/.test(x))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const hits = [...src.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])|rgba?\(/g)]
      // view.js의 '#210' 같은 이슈 번호 표기는 색이 아니다
      .filter((m) => !(f === 'view.js' && /^#\d+$/.test(m[0])));
    assert.deepEqual(hits.map((m) => m[0]), [], `${f}에 직접 쓴 색`);
  }
});

test('lifecycle.mjs는 창 바탕색을 theme.mjs에서만 받는다', () => {
  const life = fs.readFileSync(path.join(ROOT, 'main', 'lifecycle.mjs'), 'utf8');
  assert.equal((life.match(/backgroundColor:\s*'#/g) ?? []).length, 0);
  assert.match(life, /nativeTheme\.on\('updated'/);
});
