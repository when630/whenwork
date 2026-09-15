import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { glyphMask, bbox, accentColor, toTemplate } from '../tools/make-icon.mjs';

// 아이콘 파이프라인이 조용히 망가지는 자리를 지킨다. 새 아이콘(배경 있는 앱 아이콘)으로
// 바꿨을 때 트레이는 파란 덩어리가, macOS Template은 까만 사각형이 됐다 —
// 둘 다 앱은 멀쩡히 돌아서 눈으로 보기 전까지 아무도 몰랐다.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// 배경 위에 흰 도형이 얹힌 아이콘을 흉내 낸다 (실제 아이콘과 같은 구조)
function fakeIcon(w = 40) {
  const rgba = Buffer.alloc(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) * 4;
      // 배경: 왼쪽 위 하늘색 → 오른쪽 아래 진파랑 (원본과 같은 그라디언트 방향)
      const t = (x + y) / (2 * w);
      rgba[d] = Math.round(125 * (1 - t) + 30 * t);
      rgba[d + 1] = Math.round(211 * (1 - t) + 64 * t);
      rgba[d + 2] = Math.round(252 * (1 - t) + 175 * t);
      rgba[d + 3] = 255;
      // 가운데 흰 도형
      if (x > w * 0.35 && x < w * 0.65 && y > w * 0.35 && y < w * 0.65) {
        rgba[d] = 255; rgba[d + 1] = 255; rgba[d + 2] = 255;
      }
    }
  }
  return { w, rgba };
}

test('마스크는 밝은 배경이 아니라 흰 도형만 잡는다', () => {
  const { w, rgba } = fakeIcon();
  const mask = glyphMask(rgba, w, w);
  const at = (x, y) => mask[(y * w + x) * 4 + 3];
  assert.ok(at(w >> 1, w >> 1) > 200, '흰 도형이 불투명해야 한다');
  assert.equal(at(1, 1), 0, '하늘색 배경이 글리프로 잡혔다 — 밝기로 가르면 이렇게 된다');
  assert.equal(at(w - 2, w - 2), 0, '진파랑 배경이 글리프로 잡혔다');
});

test('글리프 경계는 아이콘 전체가 아니라 도형만큼이다', () => {
  const { w, rgba } = fakeIcon();
  const gb = bbox(glyphMask(rgba, w, w), w, w);
  const side = gb.x1 - gb.x0 + 1;
  assert.ok(side < w * 0.6, `글리프 경계가 ${side}/${w} — 배경까지 잡혔다`);
});

test('macOS Template이 까만 사각형이 되지 않는다', () => {
  const { w, rgba } = fakeIcon();
  const tpl = toTemplate(glyphMask(rgba, w, w));
  let opaque = 0;
  for (let i = 0; i < w * w; i++) if (tpl[i * 4 + 3] > 128) opaque++;
  const ratio = opaque / (w * w);
  assert.ok(ratio > 0.02, 'Template이 비었다');
  assert.ok(ratio < 0.5, `Template의 ${Math.round(ratio * 100)}%가 불투명 — 배경까지 칠해진 것이다`);
});

test('악센트는 배경 평균이지 그라디언트 끝의 극단값이 아니다', () => {
  const { w, rgba } = fakeIcon();
  const mask = glyphMask(rgba, w, w);
  const [r, g, b] = accentColor(rgba, mask, w, w);
  // 양 끝(125,211,252)와 (30,64,175) 사이에 있어야 한다
  assert.ok(r > 30 && r < 125, `R=${r}`);
  assert.ok(b > 175 && b < 252, `B=${b}`);
});

test('실제로 구운 아이콘이 기대한 크기와 형태다', () => {
  const read = (f) => {
    const b = fs.readFileSync(path.join(ROOT, 'build', f));
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), size: b.length };
  };
  assert.deepEqual([read('icon.png').w, read('icon.png').h], [512, 512]);
  assert.deepEqual([read('tray.png').w, read('tray.png').h], [16, 16]);
  assert.deepEqual([read('tray@2x.png').w, read('tray@2x.png').h], [32, 32]);
  // Template이 까만 사각형이면 압축이 잘 돼 파일이 아주 작아진다 — 형태가 있으면 그렇지 않다
  assert.ok(read('tray-Template.png').size > 200, 'Template이 단색 덩어리로 보인다');
});
