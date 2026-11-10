// tools/make-icon.mjs — 배포용 아이콘을 굽는다 (NAME-03 / REL 5-3, 브랜드 D-B02).
//
// 원본은 그림 파일이 아니라 아래 ICON — 64 단위 격자 위의 둥근 사각형 세 개다(docs/08_브랜드.md
// "한 줄"). 도형을 크기마다 직접 그리므로(가장자리 안티에일리어싱은 거리로 계산한다) 큰 그림을
// 줄일 때처럼 16px에서 획이 흐려지지 않는다. 여기서 굽는 것:
//
//   build/icon.png          — 설치 파일·실행 파일·창·macOS Dock/dmg가 쓰는 앱 아이콘(512).
//   build/tray*.png         — Windows 트레이. 앱 아이콘 그대로(틀 포함) 16/32px로 그린다.
//                             예전 아이콘은 시계·바늘·체크가 16px에서 뭉개져 흰 도형만 떼어
//                             파랗게 칠해 썼지만, 지금 기호는 막대 두 개라 틀째로 읽힌다 —
//                             먹색 틀이 밝은·어두운 작업 표시줄 양쪽에서 기호를 받쳐 준다.
//   build/tray-Template*.png — macOS 메뉴바. 틀을 빼고 기호만 검정으로 — OS가 다크/라이트에
//                             맞춰 칠한다(main/platform/darwin.mjs가 이 파일을 먼저 찾는다).
//                             틀째로 넣으면 까만 사각형이 된다(실제로 그랬다).
//   build/appx/*.png        — Microsoft Store(MSIX) 타일·로고. 없으면 Electron 로고가 들어간다.
//   assets/icon/whenwork.png / .svg — README·랜딩용 미리보기(1024). 손으로 고치지 않는다.
//
// 외부 의존성을 두지 않으려고 PNG 인코더를 직접 넣었다(zlib만 쓴다).
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build');
const PREVIEW_DIR = path.join(ROOT, 'assets', 'icon');

// ── 아이콘 정의 — 안개 + 라임 팔레트(renderer/tokens.css)
//   틀: 먹색 둥근 사각형 / 기호: 적어 둔 글 한 줄(안개색) + 깜박이는 커서(라임)
export const COLORS = { ink: '#151A21', fog: '#E8ECF0', lime: '#C6EE3A' };
export const ICON = {
  grid: 64,
  frame: { x: 3, y: 3, w: 58, h: 58, r: 14, color: COLORS.ink },
  glyph: [
    { x: 13, y: 29, w: 25, h: 6, r: 3, color: COLORS.fog }, // 글 한 줄
    { x: 43, y: 18, w: 7, h: 28, r: 3.5, color: COLORS.lime }, // 커서
  ],
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// 점(px,py)에서 둥근 사각형 가장자리까지의 거리(안쪽은 음수). 단위는 격자 단위.
function rrectDistance(px, py, { x, y, w, h, r }) {
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// 도형들을 size×size로 그린다. box는 격자에서 그릴 영역(정사각). 가장자리 덮임은 픽셀 중심에서
// 가장자리까지의 거리로 정한다 — 거리 0이면 반쯤 덮인 픽셀. 색 지정(color)이 있으면 모든 도형을
// 그 한 색으로 칠한다(트레이 Template).
export function render(shapes, size, { box = { x: 0, y: 0, side: ICON.grid }, color = null } = {}) {
  const out = Buffer.alloc(size * size * 4);
  const scale = box.side / size; // 격자 단위 / 픽셀
  const fills = shapes.map((s) => hex(color ?? s.color));
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const gx = box.x + (px + 0.5) * scale;
      const gy = box.y + (py + 0.5) * scale;
      let r = 0, g = 0, b = 0, a = 0; // 미리 곱한 알파로 겹친다
      shapes.forEach((s, i) => {
        const cov = Math.min(1, Math.max(0, 0.5 - rrectDistance(gx, gy, s) / scale));
        if (!cov) return;
        const [cr, cg, cb] = fills[i];
        r = cr * cov + r * (1 - cov);
        g = cg * cov + g * (1 - cov);
        b = cb * cov + b * (1 - cov);
        a = cov + a * (1 - cov);
      });
      const d = (py * size + px) * 4;
      out[d] = a ? Math.round(r / a) : 0;
      out[d + 1] = a ? Math.round(g / a) : 0;
      out[d + 2] = a ? Math.round(b / a) : 0;
      out[d + 3] = Math.round(a * 255);
    }
  }
  return out;
}

// 작은 크기에서는 도형 가장자리를 픽셀 격자에 맞춘다. 16px에서 격자 1칸은 0.25px라, 맞추지 않으면
// 글 한 줄과 커서 사이 틈(5칸 = 1.25px)이 두 픽셀에 걸쳐 반투명으로 번져 두 막대가 한 덩어리로
// 붙어 보인다(테스트가 잡았다). 큰 크기는 그대로 둔다 — 반 픽셀 차이가 보이지 않는다.
export function snapToPixels(shapes, size, box = { x: 0, y: 0, side: ICON.grid }) {
  const k = size / box.side;
  const snapX = (v) => box.x + Math.round((v - box.x) * k) / k;
  const snapY = (v) => box.y + Math.round((v - box.y) * k) / k;
  return shapes.map((s) => {
    const x = snapX(s.x), y = snapY(s.y);
    const w = Math.max(1 / k, snapX(s.x + s.w) - x), h = Math.max(1 / k, snapY(s.y + s.h) - y);
    return { ...s, x, y, w, h, r: Math.min(s.r, w / 2, h / 2) };
  });
}

const SNAP_MAX = 48;

// 앱 아이콘 전체(틀 + 기호)
export function appIcon(size) {
  const shapes = [ICON.frame, ...ICON.glyph];
  return render(size <= SNAP_MAX ? snapToPixels(shapes, size) : shapes, size);
}

// 기호만 감싸는 정사각 영역 — 메뉴바 Template은 틀 없이 기호가 칸을 채워야 한다
export function glyphBox(pad = 1) {
  const x0 = Math.min(...ICON.glyph.map((s) => s.x));
  const y0 = Math.min(...ICON.glyph.map((s) => s.y));
  const x1 = Math.max(...ICON.glyph.map((s) => s.x + s.w));
  const y1 = Math.max(...ICON.glyph.map((s) => s.y + s.h));
  const side = Math.max(x1 - x0, y1 - y0) + pad * 2;
  return { x: (x0 + x1) / 2 - side / 2, y: (y0 + y1) / 2 - side / 2, side };
}

// macOS Template: 기호만, 검정 — OS가 다크/라이트에 맞춰 칠한다
export function templateGlyph(size) {
  const box = glyphBox();
  const shapes = size <= SNAP_MAX ? snapToPixels(ICON.glyph, size, box) : ICON.glyph;
  return render(shapes, size, { box, color: '#000000' });
}

export function iconSvg() {
  const rect = (s) => `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.r}" fill="${s.color}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ICON.grid} ${ICON.grid}">` +
    `${[ICON.frame, ...ICON.glyph].map(rect).join('')}</svg>\n`;
}

// 스토어 패키지가 쓰는 정사각 이미지들. targetsize-N은 작업 표시줄·시작 메뉴·탐색기가 크기별로
// 골라 쓰는 것이라, 없으면 44px 하나를 늘리고 줄여 흐려진다. altform-unplated는 타일 배경
// 판 없이 그릴 때(작업 표시줄) 쓰인다 — 아이콘에 자체 배경이 있어 같은 그림을 쓴다.
export function appxSquares() {
  const list = [
    ['StoreLogo.png', 50],
    ['Square44x44Logo.png', 44],
    ['Square150x150Logo.png', 150],
  ];
  for (const t of [16, 24, 32, 48, 256]) {
    list.push([`Square44x44Logo.targetsize-${t}.png`, t]);
    list.push([`Square44x44Logo.targetsize-${t}_altform-unplated.png`, t]);
  }
  return list;
}

// 넓은 타일 310x150 — 아이콘을 120px로 가운데 둔다(위아래 15px 여백)
const APPX_WIDE = [310, 150, 120];

// size×size 그림을 w×h 투명 캔버스 한가운데 놓는다
export function place(px, size, w, h) {
  const out = Buffer.alloc(w * h * 4);
  const ox = (w - size) >> 1;
  const oy = (h - size) >> 1;
  for (let y = 0; y < size; y++) px.copy(out, ((oy + y) * w + ox) * 4, y * size * 4, (y + 1) * size * 4);
  return out;
}

export function buildIcons() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const write = (dir, name, size, px, h = size) => fs.writeFileSync(path.join(dir, name), encodePng(size, h, px));

  write(OUT_DIR, 'icon.png', 512, appIcon(512));
  for (const size of [16, 32]) {
    const suffix = size === 16 ? '' : '@2x';
    write(OUT_DIR, `tray${suffix}.png`, size, appIcon(size));
    write(OUT_DIR, `tray-Template${suffix}.png`, size, templateGlyph(size));
  }

  // 스토어(MSIX) 타일·로고 — electron-builder가 build/appx/를 패키지의 assets\로 싣는다.
  const appxDir = path.join(OUT_DIR, 'appx');
  fs.mkdirSync(appxDir, { recursive: true });
  for (const [name, size] of appxSquares()) write(appxDir, name, size, appIcon(size));
  const [ww, wh, wi] = APPX_WIDE;
  write(appxDir, 'Wide310x150Logo.png', ww, place(appIcon(wi), wi, ww, wh), wh);

  // README·랜딩 미리보기
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  write(PREVIEW_DIR, 'whenwork.png', 1024, appIcon(1024));
  fs.writeFileSync(path.join(PREVIEW_DIR, 'whenwork.svg'), iconSvg());
  return { sizes: [512, 32, 16, ...appxSquares().map(([, s]) => s)].length };
}

if (process.argv[1] && process.argv[1].endsWith('make-icon.mjs')) {
  const info = buildIcons();
  console.log(`icons written to build/ and assets/icon/ (${info.sizes} images)`);
}
