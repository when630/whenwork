import test from 'node:test';
import assert from 'node:assert/strict';
import { pickPosition, visibleOnAnyDisplay } from '../main/place.mjs';

const MAIN = { x: 0, y: 0, width: 1920, height: 1040 };
const SECOND = { x: 1920, y: 0, width: 1920, height: 1040 };
const size = { width: 560, height: 88 };

test('저장된 자리가 화면 안이면 그대로 쓴다', () => {
  const pos = pickPosition({ saved: { x: 300, y: 200 }, size, workAreas: [MAIN], cursorArea: MAIN });
  assert.deepEqual(pos, { x: 300, y: 200 });
});

test('저장된 자리가 없으면 커서 화면 중앙', () => {
  const pos = pickPosition({ saved: null, size, workAreas: [MAIN], cursorArea: MAIN });
  assert.deepEqual(pos, { x: 680, y: 476 });
});

test('centerY=false면 위쪽 28% 지점', () => {
  const pos = pickPosition({ saved: null, size, workAreas: [MAIN], cursorArea: MAIN, centerY: false });
  assert.deepEqual(pos, { x: 680, y: 291 });
});

test('보조 모니터가 사라지면 저장값을 버리고 가운데로', () => {
  const saved = { x: 2400, y: 300 }; // 두 번째 모니터 자리
  assert.equal(visibleOnAnyDisplay({ ...saved, ...size }, [MAIN, SECOND]), true);
  const pos = pickPosition({ saved, size, workAreas: [MAIN], cursorArea: MAIN });
  assert.deepEqual(pos, { x: 680, y: 476 });
});

test('화면 밖으로 거의 빠진 자리도 버린다', () => {
  // 오른쪽 끝에 30px만 걸친 상태 — 잡아서 옮기기 어렵다
  const pos = pickPosition({ saved: { x: 1890, y: 200 }, size, workAreas: [MAIN], cursorArea: MAIN });
  assert.deepEqual(pos, { x: 680, y: 476 });
});

test('세로로 화면 아래에 잠긴 자리도 버린다', () => {
  const pos = pickPosition({ saved: { x: 300, y: 1030 }, size, workAreas: [MAIN], cursorArea: MAIN });
  assert.deepEqual(pos, { x: 680, y: 476 });
});

test('보조 모니터가 있으면 그쪽 자리도 유효', () => {
  const pos = pickPosition({ saved: { x: 2400, y: 300 }, size, workAreas: [MAIN, SECOND], cursorArea: MAIN });
  assert.deepEqual(pos, { x: 2400, y: 300 });
});
