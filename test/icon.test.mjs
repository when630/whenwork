import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON, COLORS, render, appIcon, templateGlyph, glyphBox, iconSvg, buildIcons, encodePng } from '../tools/make-icon.mjs';

// 아이콘 파이프라인이 조용히 망가지는 자리를 지킨다. 예전에 아이콘을 바꿨을 때 트레이는
// 파란 덩어리가, macOS Template은 까만 사각형이 됐다 — 앱은 멀쩡히 돌아서 눈으로 보기 전까지
// 아무도 몰랐다. 지금 아이콘은 도형 정의(ICON)에서 바로 그리므로, 그 정의와 결과를 함께 본다.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const at = (px, size, gx, gy) => {
  const x = Math.floor((gx / ICON.grid) * size), y = Math.floor((gy / ICON.grid) * size);
  return [...px.slice((y * size + x) * 4, (y * size + x) * 4 + 4)];
};

test('아이콘 색은 브랜드 팔레트(tokens.css)에서 온다', () => {
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'tokens.css'), 'utf8').toLowerCase();
  assert.ok(css.includes(COLORS.lime.toLowerCase()), '라임이 tokens.css에 없다');
  assert.ok(css.includes(COLORS.fog.toLowerCase()), '안개색이 tokens.css에 없다');
  assert.ok(css.includes(COLORS.ink.toLowerCase()), '먹색(본문 글자)이 tokens.css에 없다');
});

test('앱 아이콘은 먹색 틀 위에 글 한 줄(안개)과 커서(라임)가 있다', () => {
  const s = 256, px = appIcon(s);
  assert.deepEqual(at(px, s, 8, 8).slice(0, 3), hex(COLORS.ink), '틀 안쪽');
  assert.deepEqual(at(px, s, 25, 32).slice(0, 3), hex(COLORS.fog), '글 한 줄');
  assert.deepEqual(at(px, s, 46.5, 32).slice(0, 3), hex(COLORS.lime), '커서');
  assert.equal(at(px, s, 0.5, 0.5)[3], 0, '틀 바깥 모서리는 투명');
  assert.equal(at(px, s, 32, 32)[3], 255);
});

test('가장자리는 반투명으로 이어진다 — 이진화하면 16px에서 획이 끊긴다', () => {
  const px = render([{ x: 0, y: 0, w: 32, h: 64, r: 0, color: '#000000' }], 7);
  // 경계(32)는 7px 격자에서 3.5번 픽셀 한가운데를 지난다 — 그 픽셀은 반쯤 덮인다
  const a = px[(3 * 7 + 3) * 4 + 3];
  assert.ok(a > 100 && a < 160, `경계 픽셀 알파 ${a}`);
  assert.equal(px[(3 * 7 + 1) * 4 + 3], 255);
  assert.equal(px[(3 * 7 + 5) * 4 + 3], 0);
});

test('16px에서도 두 요소가 서로 떨어져 보인다', () => {
  const s = 16, px = appIcon(s);
  // 글 한 줄과 커서 사이(격자 38~43)의 한 열은 틀 색이어야 한다 — 붙으면 한 덩어리로 읽힌다
  const gap = at(px, s, 40.5, 32);
  const [ir, ig, ib] = hex(COLORS.ink);
  assert.ok(Math.abs(gap[0] - ir) + Math.abs(gap[1] - ig) + Math.abs(gap[2] - ib) < 60, `틈이 메워졌다: ${gap}`);
});

test('macOS Template은 틀 없는 기호뿐이다 — 까만 사각형이 되지 않는다', () => {
  const s = 32, px = templateGlyph(s);
  let opaque = 0;
  for (let i = 0; i < s * s; i++) {
    assert.deepEqual([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]].filter((v, k) => px[i * 4 + 3] && v !== 0), []);
    if (px[i * 4 + 3] > 128) opaque++;
  }
  const ratio = opaque / (s * s);
  assert.ok(ratio > 0.1, 'Template이 비었다');
  assert.ok(ratio < 0.5, `Template의 ${Math.round(ratio * 100)}%가 불투명 — 틀까지 칠해진 것이다`);
  const b = glyphBox();
  assert.ok(b.side < ICON.frame.w, '기호 영역이 틀만큼 크다');
});

test('SVG 미리보기는 같은 도형을 담는다', () => {
  const svg = iconSvg();
  assert.equal((svg.match(/<rect /g) ?? []).length, 1 + ICON.glyph.length);
  assert.ok(svg.includes(COLORS.lime));
});

test('실제로 구운 아이콘이 기대한 크기와 형태다', () => {
  buildIcons();
  const read = (f) => {
    const b = fs.readFileSync(path.join(ROOT, f));
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), size: b.length };
  };
  assert.deepEqual([read('build/icon.png').w, read('build/icon.png').h], [512, 512]);
  assert.deepEqual([read('build/tray.png').w, read('build/tray.png').h], [16, 16]);
  assert.deepEqual([read('build/tray@2x.png').w, read('build/tray@2x.png').h], [32, 32]);
  assert.deepEqual([read('build/appx/Wide310x150Logo.png').w, read('build/appx/Wide310x150Logo.png').h], [310, 150]);
  assert.deepEqual([read('assets/icon/whenwork.png').w], [1024]);
  // 구운 파일이 정의에서 그린 그림 그대로다(모양 자체는 위 Template 테스트가 본다)
  assert.ok(fs.readFileSync(path.join(ROOT, 'build', 'tray-Template.png')).equals(encodePng(16, 16, templateGlyph(16))));
  assert.ok(fs.readFileSync(path.join(ROOT, 'build', 'tray.png')).equals(encodePng(16, 16, appIcon(16))));
});
