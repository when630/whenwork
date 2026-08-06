import test from 'node:test';
import assert from 'node:assert/strict';
import { briefDecision, briefingLines, dayKey } from '../main/brief.mjs';

const at = (h, m = 0) => new Date(2026, 7, 5, h, m);

test('설정 시각 전에는 아무것도 하지 않는다', () => {
  assert.equal(briefDecision({ now: at(8, 59), at: '09:00' }), 'wait');
});

test('설정 시각을 지나면 알린다', () => {
  assert.equal(briefDecision({ now: at(9, 0), at: '09:00' }), 'brief');
  assert.equal(briefDecision({ now: at(11, 30), at: '09:00' }), 'brief');
});

test('창(3시간)을 놓친 날은 알리지 않고 오늘로 표시만 한다', () => {
  assert.equal(briefDecision({ now: at(19, 0), at: '09:00' }), 'skip');
});

test('오늘 이미 알렸으면 다시 알리지 않는다', () => {
  const now = at(10, 0);
  assert.equal(briefDecision({ now, at: '09:00', lastBriefing: dayKey(now) }), 'wait');
});

test('어제 알린 기록은 오늘을 막지 않는다', () => {
  assert.equal(briefDecision({ now: at(10, 0), at: '09:00', lastBriefing: '2026-08-04' }), 'brief');
});

test('꺼져 있으면 알리지 않는다', () => {
  assert.equal(briefDecision({ now: at(10, 0), at: '09:00', enabled: false }), 'wait');
});

test('시각 설정이 깨졌으면 알리지 않는다', () => {
  for (const bad of ['', '9시', '25:00', '09:75', null]) {
    assert.equal(briefDecision({ now: at(23, 0), at: bad }), 'wait', String(bad));
  }
});

test('시각을 안 넘기면 기본값(09:00)을 쓴다', () => {
  assert.equal(briefDecision({ now: at(9, 30) }), 'brief');
  assert.equal(briefDecision({ now: at(8, 0) }), 'wait');
});

test('자정 직후 설정이면 그날 안에서만 유효하다', () => {
  assert.equal(briefDecision({ now: at(0, 5), at: '00:00' }), 'brief');
  assert.equal(briefDecision({ now: at(4, 0), at: '00:00' }), 'skip');
});

test('브리핑 문구는 급한 순서대로, 0인 항목은 빠진다', () => {
  const parts = briefingLines({ overdue: 2, due_today: 0, stale_waiting: 1, inbox: 3 });
  assert.deepEqual(parts, ['지연 2건', '5일 넘게 기다림 1건', '인박스 3건']);
});

test('챙길 게 없으면 빈 배열 — 호출부가 알림을 생략한다', () => {
  assert.deepEqual(briefingLines({ overdue: 0, due_today: 0, stale_waiting: 0, inbox: 0 }), []);
  assert.deepEqual(briefingLines({}), []);
});
