import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createStore } from '../main/store.mjs';
import { verify } from '../tools/migrate-pg.mjs';

// 이전 스크립트의 **검사**를 테스트한다. PostgreSQL 자체는 여기서 띄우지 않는다 —
// 드라이버가 준 행을 흉내 낸 payload로 verify를 돌리면, 실제 이전에서 조용히 잃는 네 가지가
// 그대로 재현된다(행 수·UTC·context·soft-delete). DB가 있어야만 도는 테스트는
// CI에서 건너뛰어지고, 건너뛴 테스트는 지키지 못한다.

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-m-'));
  return path.join(dir, 'store.sqlite');
}

// pg 드라이버가 돌려준 행을 migrate-pg.mjs가 payload로 바꾼 뒤의 모양
function payload() {
  return {
    project: [
      { id: 1, name: '가나', status: 'active', sort: 0 },
      { id: 2, name: '다라', status: 'archived', sort: 1 },
    ],
    item: [
      {
        id: 'a1', project_id: 1, kind: 'todo', title: '할 일', due: '2026-09-30',
        waiting_for: null, captured_at: '2026-09-01T00:10:00.000Z', done_at: null,
        source: 'manual', context: { fg: '창 제목' }, note: '메모',
        nudged_at: null, nudge_count: 0, deleted_at: null,
      },
      {
        id: 'a2', project_id: null, kind: 'inbox', title: '인박스', due: null,
        waiting_for: null, captured_at: '2026-09-02T15:00:00.000Z', done_at: null,
        source: 'manual', context: null, note: null,
        nudged_at: null, nudge_count: 0, deleted_at: null,
      },
      {
        id: 'a3', project_id: 1, kind: 'waiting', title: '대기', due: null,
        waiting_for: '상대방', captured_at: '2026-09-03T01:00:00.000Z', done_at: null,
        source: 'manual', context: null, note: null,
        nudged_at: '2026-09-04T02:00:00.000Z', nudge_count: 2, deleted_at: null,
      },
      {
        id: 'a4', project_id: 1, kind: 'todo', title: '지운 것', due: null,
        waiting_for: null, captured_at: '2026-09-01T00:00:00.000Z', done_at: null,
        source: 'manual', context: null, note: null,
        nudged_at: null, nudge_count: 0, deleted_at: '2026-09-05T00:00:00.000Z',
      },
    ],
    event: [{ id: 1, at: '2026-09-01T00:00:00.000Z', kind: 'migrate', detail: null }],
  };
}

function migrated(p = payload()) {
  const store = createStore(tmpFile());
  store.open();
  store.importAll({ app: 'whenwork', schema_version: store.schemaVersion(), ...p });
  return store;
}

test('정상 이전은 네 가지 검사를 모두 통과한다', () => {
  const p = payload();
  const store = migrated(p);
  assert.deepEqual(verify(store, p), []);
  store.close();
});

test('UTC가 로컬 시각으로 밀리면 검사가 잡는다', () => {
  const p = payload();
  const store = migrated(p);
  // 원본이 9시간 앞선 값이었다고 치면(로컬로 찍힌 상황) 저장소 값과 어긋나야 한다
  const broken = structuredClone(p);
  broken.item[0].captured_at = '2026-09-01T09:10:00.000Z';
  const problems = verify(store, broken);
  assert.ok(problems.some((m) => m.includes('captured_at')), problems.join(' / '));
  store.close();
});

test('날짜(due)가 하루 당겨지면 검사가 잡는다', () => {
  const p = payload();
  const store = migrated(p);
  const broken = structuredClone(p);
  broken.item[0].due = '2026-09-29';
  assert.ok(verify(store, broken).some((m) => m.includes('due')));
  store.close();
});

test('context가 왕복하지 않으면 검사가 잡는다', () => {
  const p = payload();
  const store = migrated(p);
  const broken = structuredClone(p);
  broken.item[0].context = { fg: '다른 창' };
  assert.ok(verify(store, broken).some((m) => m.includes('context')));
  store.close();
});

test('행이 빠지면 검사가 잡는다', () => {
  const p = payload();
  const store = migrated(p);
  const more = structuredClone(p);
  more.item.push({
    id: 'a5', project_id: null, kind: 'inbox', title: '안 옮겨진 것',
    due: null, waiting_for: null, captured_at: '2026-09-06T00:00:00.000Z',
    done_at: null, source: 'manual', context: null, note: null,
    nudged_at: null, nudge_count: 0, deleted_at: null,
  });
  const problems = verify(store, more);
  assert.ok(problems.some((m) => m.includes('행 수가 다릅니다')), problems.join(' / '));
  assert.ok(problems.some((m) => m.includes('a5')));
  store.close();
});

test('지운 항목은 옮긴 뒤에도 화면에 서지 않는다', () => {
  const p = payload();
  const store = migrated(p);
  const view = store.getViewState();
  const visible = [...view.today, ...view.inbox, ...view.waiting].map((r) => r.id);
  assert.ok(!visible.includes('a4'), '삭제된 항목이 화면에 남았다');
  assert.ok(visible.includes('a1') && visible.includes('a2') && visible.includes('a3'));
  store.close();
});

test('살아 있던 항목이 삭제된 것으로 들어가면 검사가 잡는다', () => {
  const p = payload();
  const store = migrated(p);
  // 원본에서는 안 지워진 것인데 저장소에는 지워진 채로 들어간 상황
  const broken = structuredClone(p);
  broken.item[3].deleted_at = null;
  const problems = verify(store, broken);
  assert.ok(problems.some((m) => m.includes('삭제된 것으로 들어갔습니다')), problems.join(' / '));
  store.close();
});

test('이전은 가져오기와 같은 길을 쓴다 — 직전 상태가 백업으로 남는다', () => {
  const file = tmpFile();
  const store = createStore(file);
  store.open();
  store.insertCaptures([{ id: 'before', title: '이전 전에 있던 것', captured_at: '2026-08-01T00:00:00.000Z' }]);
  const out = store.importAll({ app: 'whenwork', schema_version: store.schemaVersion(), ...payload() });
  assert.ok(out.backup && fs.existsSync(out.backup));
  store.close();
});
