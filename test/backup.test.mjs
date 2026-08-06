import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { backupName, staleBackups, writeBackup, backupDue } from '../main/backup.mjs';
import { schemaTables, EXPORT_TABLES } from '../main/db.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-b-'));
}

test('파일 이름은 시간순으로 정렬되는 형식', () => {
  assert.equal(backupName(new Date(2026, 7, 5, 9, 7)), 'whenwork-20260805-0907.json');
  const a = backupName(new Date(2026, 7, 5, 9, 7));
  const b = backupName(new Date(2026, 7, 5, 14, 30));
  assert.ok(a < b); // 이름 정렬 = 시간 정렬이라 오래된 것을 이름만으로 고를 수 있다
});

test('keep개를 넘는 오래된 것만 지울 목록에 오른다', () => {
  const names = [1, 2, 3, 4, 5].map((i) => `whenwork-2026080${i}-0900.json`);
  assert.deepEqual(staleBackups(names, 3), [
    'whenwork-20260801-0900.json',
    'whenwork-20260802-0900.json',
  ]);
  assert.deepEqual(staleBackups(names, 5), []);
  assert.deepEqual(staleBackups(names, 9), []);
});

test('우리 이름 규칙이 아닌 파일은 건드리지 않는다', () => {
  const names = ['메모.txt', 'dump.sql', 'whenwork-old.json', 'whenwork-20260801-0900.json'];
  assert.deepEqual(staleBackups(names, 0), ['whenwork-20260801-0900.json']);
});

test('백업을 쓰고 되읽을 수 있다', () => {
  const dir = tmpDir();
  const file = writeBackup(dir, { project: [{ id: 1, name: '가' }], item: [] }, { now: new Date(2026, 7, 5, 10, 0) });
  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(back.app, 'whenwork');
  assert.equal(back.tables.project[0].name, '가');
  assert.ok(back.at);
});

test('keep을 넘으면 오래된 백업이 실제로 지워진다', () => {
  const dir = tmpDir();
  for (let d = 1; d <= 4; d++) {
    writeBackup(dir, { item: [] }, { now: new Date(2026, 7, d, 10, 0), keep: 2 });
  }
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, ['whenwork-20260803-1000.json', 'whenwork-20260804-1000.json']);
});

test('없는 폴더도 만들어서 쓴다', () => {
  const dir = path.join(tmpDir(), 'nested', 'backups');
  const file = writeBackup(dir, { item: [] });
  assert.ok(fs.existsSync(file));
});

// ── 하루 한 번 판단
const NOW = new Date(2026, 7, 6, 14, 0);

test('이력이 없으면 남긴다', () => {
  assert.equal(backupDue({ now: NOW }), true);
});

test('오늘 이미 남겼으면 다시 남기지 않는다', () => {
  assert.equal(backupDue({ lastBackup: new Date(2026, 7, 6, 9, 0).toISOString(), now: NOW }), false);
});

test('어제 남긴 것은 오늘 몫이 아니다', () => {
  assert.equal(backupDue({ lastBackup: new Date(2026, 7, 5, 23, 59).toISOString(), now: NOW }), true);
});

test('24시간이 아니라 날짜가 기준이다', () => {
  // 어젯밤 11시에 남겼어도 오늘 아침이면 새로 남긴다 — "하루 한 번"이 사람이 세는 방식이다
  assert.equal(
    backupDue({ lastBackup: new Date(2026, 7, 5, 23, 0).toISOString(), now: new Date(2026, 7, 6, 1, 0) }),
    true
  );
});

test('오늘 실패한 뒤에는 그날 다시 두드리지 않는다', () => {
  assert.equal(backupDue({ lastTry: '2026-08-06', now: NOW }), false);
  assert.equal(backupDue({ lastTry: '2026-08-05', now: NOW }), true); // 어제 실패는 오늘을 막지 않는다
});

test('시각 값이 깨졌으면 남기는 쪽으로 기운다', () => {
  assert.equal(backupDue({ lastBackup: '어제쯤', now: NOW }), true);
});

// ── 백업 범위
test('스키마의 모든 테이블이 백업에 담긴다', () => {
  // cal_event가 실제로 빠져 있었다. 새 테이블을 만들고 EXPORT_TABLES를 잊으면 여기서 걸린다
  assert.deepEqual([...EXPORT_TABLES].sort(), [...schemaTables()].sort());
});

test('백업 순서는 부모 테이블이 먼저다', () => {
  // 되살릴 때 참조가 걸린다 — item은 project 뒤여야 한다
  assert.ok(EXPORT_TABLES.indexOf('project') < EXPORT_TABLES.indexOf('item'));
  assert.ok(EXPORT_TABLES.indexOf('project') < EXPORT_TABLES.indexOf('resume_card'));
});
