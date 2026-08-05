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

test('drain 성공 시 소비한 항목이 파일에서 사라진다', async () => {
  const q = createQueue(tmpFile());
  q.append({ id: 'a' });
  q.append({ id: 'b' });
  const seen = [];
  const n = await q.drain(async (entries) => seen.push(...entries));
  assert.equal(n, 2);
  assert.deepEqual(seen.map((e) => e.id), ['a', 'b']);
  assert.equal(q.count(), 0);
});

test('drain 실패(throw) 시 큐는 그대로 남는다', async () => {
  const q = createQueue(tmpFile());
  q.append({ id: 'a' });
  await assert.rejects(q.drain(async () => { throw new Error('db down'); }));
  assert.equal(q.count(), 1);
});

test('drain 도중 append된 항목은 꼬리에 살아남는다', async () => {
  const q = createQueue(tmpFile());
  q.append({ id: 'a' });
  await q.drain(async () => {
    q.append({ id: 'late' }); // consume이 도는 사이에 끼어드는 캡처
  });
  assert.deepEqual(q.readAll().map((e) => e.id), ['late']);
});

test('깨진 줄은 건너뛰고 나머지는 살린다', () => {
  const file = tmpFile();
  const q = createQueue(file);
  q.append({ id: 'a' });
  fs.appendFileSync(file, '{corrupt!!\n', 'utf8');
  q.append({ id: 'b' });
  assert.deepEqual(q.readAll().map((e) => e.id), ['a', 'b']);
});

test('빈 파일 drain은 0을 돌려준다', async () => {
  const q = createQueue(tmpFile());
  assert.equal(await q.drain(async () => {}), 0);
});
