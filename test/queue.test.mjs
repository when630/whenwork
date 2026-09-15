import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createQueue } from '../main/queue.mjs';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-q-'));
  return path.join(dir, 'queue.jsonl');
}

test('append 후 readAll로 그대로 읽힌다', () => {
  const q = createQueue(tmpFile());
  q.append({ id: 'a', title: '하나' });
  q.append({ id: 'b', title: '둘' });
  assert.deepEqual(q.readAll().map((e) => e.id), ['a', 'b']);
  assert.equal(q.count(), 2);
});

test('replayPending은 큐 두 항목을 반영하고 큐 파일과 대기 파일을 모두 지운다', () => {
  const file = tmpFile();
  const q = createQueue(file);
  q.append({ id: 'a' });
  q.append({ id: 'b' });
  const seen = [];
  const n = q.replayPending((entries) => seen.push(...entries));
  assert.equal(n, 2);
  assert.deepEqual(seen.map((e) => e.id), ['a', 'b']);
  assert.equal(q.count(), 0);
  assert.equal(fs.existsSync(file), false);
  const leftoverPending = fs
    .readdirSync(path.dirname(file))
    .filter((f) => f.includes('.pending-'));
  assert.deepEqual(leftoverPending, []);
});

test('replayPending 중 consume이 throw하면 대기 파일이 남고 반환은 0이며, 다시 부르면 반영된다', () => {
  const file = tmpFile();
  const q = createQueue(file);
  q.append({ id: 'a' });
  const first = q.replayPending(() => {
    throw new Error('store down');
  });
  assert.equal(first, 0);
  // queue.jsonl은 이미 대기 파일로 옮겨졌다 — 항목은 그 대기 파일에 그대로 남는다(삭제되지 않는다)
  const leftoverPending = fs
    .readdirSync(path.dirname(file))
    .filter((f) => f.includes('.pending-'));
  assert.equal(leftoverPending.length, 1);

  const seen = [];
  const second = q.replayPending((entries) => seen.push(...entries));
  assert.equal(second, 1);
  assert.deepEqual(seen.map((e) => e.id), ['a']);
  assert.equal(q.count(), 0);
});

test('반영 중 들어온 캡처는 새 큐 파일에 남고 이번 반영 대상에 섞이지 않는다', () => {
  const q = createQueue(tmpFile());
  q.append({ id: 'a' });
  const seen = [];
  const n = q.replayPending((entries) => {
    seen.push(...entries);
    q.append({ id: 'late' }); // consume이 도는 사이에 끼어드는 캡처
  });
  assert.equal(n, 1);
  assert.deepEqual(seen.map((e) => e.id), ['a']);
  assert.deepEqual(q.readAll().map((e) => e.id), ['late']);
});

test('이전 실행이 남긴 대기 파일도 오래된 것부터 함께 반영된다', () => {
  const file = tmpFile();
  const dir = path.dirname(file);
  const base = path.basename(file, '.jsonl');
  // 이전 실행이 반영 도중 죽어 남긴 대기 파일을 흉내낸다 — 이름의 시각이 오래된 것부터.
  // 둘 다 지금 이 순간(Date.now())보다 작아야 한다 — 실제 rename이 만드는 파일이
  // 언제나 가장 최근(가장 큰 시각)이어야 정렬 검증이 뜻대로 된다.
  const olderPending = path.join(dir, `${base}.pending-1000000000000.jsonl`);
  const newerPending = path.join(dir, `${base}.pending-1500000000000.jsonl`);
  fs.writeFileSync(olderPending, JSON.stringify({ id: 'old' }) + '\n', 'utf8');
  fs.writeFileSync(newerPending, JSON.stringify({ id: 'stale' }) + '\n', 'utf8');

  const q = createQueue(file);
  q.append({ id: 'fresh' });
  const seen = [];
  const n = q.replayPending((entries) => seen.push(...entries));
  assert.equal(n, 3);
  assert.deepEqual(seen.map((e) => e.id), ['old', 'stale', 'fresh']);
  assert.equal(q.count(), 0);
  assert.equal(fs.existsSync(olderPending), false);
  assert.equal(fs.existsSync(newerPending), false);
});

test('깨진 줄은 건너뛰고 나머지는 살린다', () => {
  const file = tmpFile();
  const q = createQueue(file);
  q.append({ id: 'a' });
  fs.appendFileSync(file, '{corrupt!!\n', 'utf8');
  q.append({ id: 'b' });
  assert.deepEqual(q.readAll().map((e) => e.id), ['a', 'b']);
});

test('큐 파일이 없거나 비어 있으면 replayPending은 0을 돌려주고 아무 파일도 만들지 않는다', () => {
  const file = tmpFile();
  const dir = path.dirname(file);
  const before = fs.readdirSync(dir);
  const q = createQueue(file);
  assert.equal(q.replayPending(() => {}), 0);
  assert.deepEqual(fs.readdirSync(dir).sort(), before.sort());
});
