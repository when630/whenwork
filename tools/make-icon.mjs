// tools/make-icon.mjs — 배포용 아이콘을 굽는다 (NAME-03 / REL 5-3).
//
// 원본은 assets/icon/whenwork.png 하나뿐이다. 여기서 두 가지를 만든다:
//
//   build/icon.png        — 설치 파일·실행 파일·창·macOS Dock/dmg가 쓰는 앱 아이콘.
//                           원본 비율 그대로 512px로 줄인다(여백도 함께 남긴다 —
//                           설치 관리자와 Dock은 자기 여백을 따로 두지 않는다).
//
//   build/tray*.png       — 트레이/메뉴바 글리프. 원본을 **여백을 잘라내고** 줄인 것이다.
//                           처음에는 16px 격자에 손으로 다시 그렸는데, 원·바늘·체크 셋이
//                           서로 뭉개져 무엇인지 알 수 없었다. 알파를 곱해 평균하는 박스
//                           축소는 원본의 얇은 획을 반투명 픽셀로 남겨 형태를 지켜 준다 —
//                           16px에서도 시계와 체크가 갈린다. 여백을 먼저 자르는 것이
//                           핵심이다: 원본은 사방이 비어 있어 그대로 줄이면 알맹이가
//                           그만큼 작아져 트레이에서 점처럼 보인다.
//
//   build/tray-Template*.png — macOS 메뉴바용. 알파만 남긴 검정 — OS가 다크/라이트에
//                           맞춰 칠한다(main/platform/darwin.mjs가 이 파일을 먼저 찾는다).
//
// 외부 의존성을 두지 않으려고 PNG 디코더·인코더를 직접 넣었다(zlib만 쓴다).
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build');
const SRC = path.join(ROOT, 'assets', 'icon', 'whenwork.png');

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

function encodePng(width, height, rgba) {
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

// ── PNG 디코더 (8비트 RGBA/RGB, 비인터레이스만 — 원본이 그 형식이다)
function decodePng(buf) {
  let o = 8;
  let ihdr = null;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    const data = buf.slice(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (!ihdr) throw new Error('IHDR 없음');
  if (ihdr.depth !== 8 || ihdr.interlace !== 0 || (ihdr.color !== 6 && ihdr.color !== 2)) {
    throw new Error(`지원하지 않는 PNG 형식: depth=${ihdr.depth} color=${ihdr.color} interlace=${ihdr.interlace}`);
  }
  const ch = ihdr.color === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.w * ch;
  const out = Buffer.alloc(ihdr.w * ihdr.h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < ihdr.h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    // PNG 필터 되돌리기 — 여기를 틀리면 그림이 사선으로 흐른다
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = (line[i] + add) & 0xff;
    }
    prev = line;
    for (let x = 0; x < ihdr.w; x++) {
      const s = x * ch;
      const d = (y * ihdr.w + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = ch === 4 ? line[s + 3] : 0xff;
    }
  }
  return { w: ihdr.w, h: ihdr.h, rgba: out };
}

// 보이는 부분의 경계 상자. 정사각으로 맞춘다 — 가로세로 비가 틀어지면 원이 타원이 된다.
export function bbox(rgba, w, h) {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
  const side = Math.max(x1 - x0, y1 - y0) + 1;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return {
    x0: Math.max(0, Math.round(cx - side / 2)),
    y0: Math.max(0, Math.round(cy - side / 2)),
    x1: Math.min(w - 1, Math.round(cx + side / 2)),
    y1: Math.min(h - 1, Math.round(cy + side / 2)),
  };
}

// 박스 평균 축소. **알파를 곱해 평균한 뒤 되나눈다** — 안 그러면 투명한 가장자리의
// 색(보통 0,0,0)이 섞여 들어와 테두리가 거뭇해진다. 16px에서는 그 반투명 가장자리가
// 곧 형태라, 여기를 대충 하면 글리프가 뭉개진다.
export function resize(src, w, h, size, bb = null) {
  const box = bb ?? { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
  const bw = box.x1 - box.x0 + 1;
  const bh = box.y1 - box.y0 + 1;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const X0 = box.x0 + Math.floor((x * bw) / size);
      const X1 = box.x0 + Math.max(Math.floor(((x + 1) * bw) / size), Math.floor((x * bw) / size) + 1);
      const Y0 = box.y0 + Math.floor((y * bh) / size);
      const Y1 = box.y0 + Math.max(Math.floor(((y + 1) * bh) / size), Math.floor((y * bh) / size) + 1);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = Y0; yy < Y1 && yy < h; yy++) {
        for (let xx = X0; xx < X1 && xx < w; xx++) {
          const i = (yy * w + xx) * 4;
          const al = src[i + 3] / 255;
          r += src[i] * al;
          g += src[i + 1] * al;
          b += src[i + 2] * al;
          a += src[i + 3];
          n++;
        }
      }
      const d = (y * size + x) * 4;
      const am = n ? a / n : 0;
      const aw = am / 255;
      out[d] = aw > 0 ? Math.min(255, Math.round(r / n / aw)) : 0;
      out[d + 1] = aw > 0 ? Math.min(255, Math.round(g / n / aw)) : 0;
      out[d + 2] = aw > 0 ? Math.min(255, Math.round(b / n / aw)) : 0;
      out[d + 3] = Math.round(am);
    }
  }
  return out;
}

// macOS Template: 색은 버리고 알파만 남긴다(검정) — OS가 다크/라이트에 맞춰 칠한다.
export function toTemplate(rgba) {
  const out = Buffer.from(rgba);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = 0;
    out[i + 1] = 0;
    out[i + 2] = 0;
  }
  return out;
}

export function buildIcons() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const src = decodePng(fs.readFileSync(SRC));
  const bb = bbox(src.rgba, src.w, src.h);

  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), encodePng(512, 512, resize(src.rgba, src.w, src.h, 512)));

  for (const size of [16, 32]) {
    const px = resize(src.rgba, src.w, src.h, size, bb);
    const suffix = size === 16 ? '' : '@2x';
    fs.writeFileSync(path.join(OUT_DIR, `tray${suffix}.png`), encodePng(size, size, px));
    fs.writeFileSync(path.join(OUT_DIR, `tray-Template${suffix}.png`), encodePng(size, size, toTemplate(px)));
  }
  return { src: `${src.w}x${src.h}`, crop: bb.x1 - bb.x0 + 1 };
}

if (process.argv[1] && process.argv[1].endsWith('make-icon.mjs')) {
  const info = buildIcons();
  console.log(`icons written to build/ (source ${info.src}, crop ${info.crop}px → icon.png 512, tray 16/32 + Template)`);
}
