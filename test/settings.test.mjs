import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSettings } from '../main/settings.mjs';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-s-')), 'settings.json');
}

test('set → flush 후 파일에서 다시 읽힌다', () => {
  const file = tmpFile();
  const s = createSettings(file);
  s.set('captureBounds', { x: 100, y: 200 });
  s.flush();
  assert.deepEqual(createSettings(file).get('captureBounds'), { x: 100, y: 200 });
});

test('remove하면 값이 사라진다', () => {
  const file = tmpFile();
  const s = createSettings(file);
  s.set('todayBounds', { x: 1, y: 2 });
  s.remove('todayBounds');
  s.flush();
  assert.equal(createSettings(file).get('todayBounds'), null);
});

test('없는 키는 fallback', () => {
  const s = createSettings(tmpFile());
  assert.equal(s.get('없음', 'fallback'), 'fallback');
});

test('깨진 파일이어도 기본값으로 시작한다', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{깨짐!!', 'utf8');
  const s = createSettings(file);
  assert.equal(s.get('captureBounds'), null);
  s.set('captureBounds', { x: 5, y: 5 });
  s.flush();
  assert.deepEqual(createSettings(file).get('captureBounds'), { x: 5, y: 5 });
});

test('연달아 set해도 디바운스로 마지막 값이 남는다', async () => {
  const file = tmpFile();
  const s = createSettings(file, 20);
  for (let i = 0; i < 20; i++) s.set('captureBounds', { x: i, y: i });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(createSettings(file).get('captureBounds'), { x: 19, y: 19 });
});
