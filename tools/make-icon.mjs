// 트레이/앱 아이콘 PNG를 굽는다. 외부 의존성을 두지 않으려고 PNG 인코더를 직접 넣었다
// (claude-office tools/make-icons.mjs와 같은 방식 — RGBA, 필터 0, zlib).
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'build');

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
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 16×16 픽셀 아트: 악센트 블루 라운드 사각 + 흰 W(더블 U 형태)
const BLUE = [0x7a, 0xa2, 0xf7, 0xff];
const WHITE = [0xff, 0xff, 0xff, 0xff];
const NONE = [0, 0, 0, 0];

function base16() {
  const px = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => NONE));
  const r = 3; // 모서리 반경
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const cx = x < r ? r - 1 - x : x > 15 - r ? x - (16 - r) : -1;
      const cy = y < r ? r - 1 - y : y > 15 - r ? y - (16 - r) : -1;
      if (cx >= 0 && cy >= 0 && cx * cx + cy * cy > r * r - 2) continue;
      px[y][x] = BLUE;
    }
  }
  // W: 세로획 4개(y4~9) + 바닥 연결(y10)
  for (let y = 4; y <= 9; y++) for (const x of [3, 7, 8, 12]) px[y][x] = WHITE;
  for (const x of [4, 5, 6, 9, 10, 11]) px[10][x] = WHITE;
  return px;
}

function toBuffer(px, scale) {
  const size = 16 * scale;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = px[Math.floor(y / scale)][Math.floor(x / scale)];
      const i = (y * size + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
    }
  }
  return buf;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const px = base16();
fs.writeFileSync(path.join(OUT_DIR, 'tray.png'), encodePng(16, 16, toBuffer(px, 1)));
fs.writeFileSync(path.join(OUT_DIR, 'tray@2x.png'), encodePng(32, 32, toBuffer(px, 2)));
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), encodePng(256, 256, toBuffer(px, 16)));
console.log('icons written to build/');
