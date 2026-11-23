import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore } from '../main/store.mjs';
import { createTools, TOOLS } from '../main/mcp/tools.mjs';
import { createServer, dataDir, MSG_DISABLED, SIGNAL_FILE } from '../main/mcp/server.mjs';

// AI 연결(MCP, D-P29) — 여기가 틀리면 AI가 넣은 할 일이 사라지거나, 엉뚱한 프로젝트·날짜로 들어가거나,
// 꺼 둔 연결로 AI가 데이터를 만지거나, 지우기처럼 열지 않은 일을 하거나, 화면이 새로 그려지지 않는다.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-11-22T10:00:00+09:00');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-mcp-'));
const json = (r) => JSON.parse(r.content[0].text);

function setup() {
  const dir = tmp();
  const store = createStore(path.join(dir, 'store.sqlite'));
  store.createProject('영업');
  store.createProject('발표');
  let n = 0;
  const tools = createTools(store, { now: () => NOW, newId: () => `id-${++n}` });
  return { dir, store, tools };
}

test('도구는 일곱 개뿐 — 지우기·이름 바꾸기·프로젝트 만들기는 없다', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), ['add_task', 'assign_project', 'complete_task', 'list_projects', 'list_tasks', 'set_due', 'uncomplete_task']);
  for (const t of TOOLS) assert.equal(t.inputSchema.type, 'object', t.name);
});

test('할 일 추가 — 프로젝트 없으면 인박스, 있으면 그 프로젝트(이름·번호), 마감은 말로', () => {
  const { store, tools } = setup();
  const a = json(tools.call('add_task', { title: '  견적서   회신 받기 ' }));
  assert.deepEqual(a.added, { id: 'id-1', title: '견적서 회신 받기', view: 'inbox', project: null, due: null });
  const b = json(tools.call('add_task', { title: '슬라이드 다듬기', project: '2', due: '내일' }));
  assert.deepEqual([b.added.view, b.added.project, b.added.due], ['today', '발표', '2026-11-23']);
  const c = json(tools.call('add_task', { title: '미팅 장소', project: '영업' }));
  assert.equal(c.added.project, '영업');
  const st = store.getViewState();
  assert.deepEqual(st.inbox.map((r) => r.title), ['견적서 회신 받기']);
  assert.deepEqual(st.today.map((r) => [r.title, r.project_name, r.due]).sort(), [['미팅 장소', '영업', null], ['슬라이드 다듬기', '발표', '2026-11-23']]);
});

test('추가는 확인을 다 통과해야 저장한다 — 없는 프로젝트·이상한 날짜·빈 글·긴 글은 아무것도 남기지 않는다', () => {
  const { store, tools } = setup();
  const bad = [
    tools.call('add_task', { title: '할 일', project: '없는프로젝트' }),
    tools.call('add_task', { title: '할 일', due: '언젠가' }),
    tools.call('add_task', { title: '   ' }),
    tools.call('add_task', { title: 'x'.repeat(301) }),
  ];
  for (const r of bad) assert.equal(r.isError, true);
  assert.match(bad[0].content[0].text, /있는 프로젝트: 1 (영업|발표)/);
  const st = store.getViewState();
  assert.equal(st.inbox.length + st.today.length, 0);
  assert.equal(store.getProjects().length, 2, '모르는 프로젝트를 만들지 않는다');
});

test('목록 — 탭별·프로젝트별, 완료한 것은 기본으로 뺀다', () => {
  const { tools } = setup();
  tools.call('add_task', { title: 'A', project: '영업' });
  tools.call('add_task', { title: 'B' });
  const { added } = json(tools.call('add_task', { title: 'C', project: '영업' }));
  tools.call('complete_task', { id: added.id });
  assert.deepEqual(json(tools.call('list_tasks', {})).tasks.map((t) => t.title).sort(), ['A', 'B']);
  assert.deepEqual(json(tools.call('list_tasks', { view: 'inbox' })).tasks.map((t) => t.title), ['B']);
  assert.deepEqual(json(tools.call('list_tasks', { project: '1' })).tasks.map((t) => t.title), ['A']);
  const all = json(tools.call('list_tasks', { include_done: true }));
  assert.equal(all.tasks.find((t) => t.title === 'C').done, true);
  assert.equal(tools.call('list_tasks', { view: 'trash' }).isError, true);
  const ps = json(tools.call('list_projects', {})).projects;
  assert.deepEqual(ps.map((p) => p.number), [1, 2]);
  assert.deepEqual(ps.map((p) => p.name).sort(), ['발표', '영업']);
});

test('프로젝트 번호는 화면과 같은 순서다', () => {
  const { store, tools } = setup();
  const screen = store.getViewState().projects.map((p) => p.name);
  assert.deepEqual(json(tools.call('list_projects', {})).projects.map((p) => p.name), screen);
  const { added } = json(tools.call('add_task', { title: 'x', project: '1' }));
  assert.equal(added.project, screen[0]);
});

test('완료·되돌리기·마감·프로젝트 지정 — id로, 없는 id는 거절', () => {
  const { store, tools } = setup();
  const { added } = json(tools.call('add_task', { title: '보고서' }));
  assert.equal(json(tools.call('complete_task', { id: added.id })).completed.title, '보고서');
  assert.ok(store.findItem(added.id).done_at);
  json(tools.call('uncomplete_task', { id: added.id }));
  assert.equal(store.findItem(added.id).done_at, null);
  assert.equal(json(tools.call('set_due', { id: added.id, due: '2026-12-01' })).due_set.due, '2026-12-01');
  assert.equal(json(tools.call('set_due', { id: added.id, due: '' })).due_set.due, null, '빈 값은 마감을 없앤다');
  assert.equal(json(tools.call('assign_project', { id: added.id, project: '영업' })).assigned.project, '영업');
  assert.equal(store.findItem(added.id).kind, 'todo', '인박스에서 오늘 탭으로');
  for (const name of ['complete_task', 'uncomplete_task', 'set_due', 'assign_project']) {
    const r = tools.call(name, { id: 'nope', due: '내일', project: '영업' });
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, /찾지 못했습니다/);
  }
  // 지운 할 일은 없는 것으로 본다
  store.removeItem(added.id);
  assert.equal(tools.call('complete_task', { id: added.id }).isError, true);
  assert.equal(tools.call('delete_task', { id: added.id }).isError, true, '지우기 도구는 없다');
});

test('서버: 꺼져 있으면 도구를 실행하지 않는다 — 켜면 실행하고, 바꾼 뒤 앱에 알린다', () => {
  const dir = tmp();
  createStore(path.join(dir, 'store.sqlite')).close();
  const server = createServer({ dir, now: () => NOW });
  const call = (id, name, args) => server.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const off = call(1, 'add_task', { title: '몰래' });
  assert.equal(off.result.isError, true);
  assert.equal(off.result.content[0].text, MSG_DISABLED);
  assert.equal(fs.existsSync(path.join(dir, SIGNAL_FILE)), false);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ mcpEnabled: true }));
  const on = call(2, 'add_task', { title: '켜고 넣기' });
  assert.equal(on.result.isError, undefined);
  assert.ok(fs.existsSync(path.join(dir, SIGNAL_FILE)), '켜져 있는 앱이 화면을 새로 그리게');
  fs.rmSync(path.join(dir, SIGNAL_FILE));
  call(3, 'list_tasks', {});
  assert.equal(fs.existsSync(path.join(dir, SIGNAL_FILE)), false, '읽기만 했으면 알리지 않는다');
  // 다시 끄면 바로 막힌다(부를 때마다 확인)
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ mcpEnabled: false }));
  assert.equal(call(4, 'list_tasks', {}).result.isError, true);
  server.close();
});

test('서버: 프로토콜 — initialize·tools/list·ping·모르는 메서드·알림', () => {
  const server = createServer({ dir: tmp() });
  const init = server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'whenwork');
  assert.equal(server.handle({ jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: '1999-01-01' } }).result.protocolVersion, '2025-06-18', '모르는 버전이면 최신으로');
  assert.equal(server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).result.tools.length, 7);
  assert.deepEqual(server.handle({ jsonrpc: '2.0', id: 3, method: 'ping' }).result, {});
  assert.equal(server.handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' }).error.code, -32601);
  server.close();
});

test('데이터 폴더는 앱과 같은 곳(whenwork)', () => {
  assert.equal(dataDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u'), path.join('C:\\Users\\u\\AppData\\Roaming', 'whenwork'));
  assert.equal(dataDir({}, 'darwin', '/Users/u'), path.join('/Users/u', 'Library', 'Application Support', 'whenwork'));
  assert.equal(dataDir({ WHENWORK_DATA_DIR: '/tmp/x' }, 'win32', 'C:\\'), '/tmp/x');
});

test('서버: 실제 표준 입출력으로 — 한 줄에 하나씩, 한글 그대로, 표준 출력에는 JSON-RPC만', async () => {
  const dir = tmp();
  createStore(path.join(dir, 'store.sqlite')).close();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ mcpEnabled: true }));
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'main', 'mcp', 'server.mjs')], { env: { ...process.env, WHENWORK_DATA_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let buf = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add_task', arguments: { title: '표준 입출력으로 넣은 할 일' } } });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } });
  p.stdin.write('이건 JSON이 아님\n');
  await new Promise((r) => { const t = setInterval(() => { if (lines.length >= 4) { clearInterval(t); r(); } }, 50); setTimeout(() => { clearInterval(t); r(); }, 8000); });
  p.stdin.end();
  await new Promise((r) => p.on('exit', r));
  const msgs = lines.map((l) => JSON.parse(l));
  assert.deepEqual(msgs.map((m) => m.id), [1, 2, 3, null]);
  assert.equal(msgs[3].error.code, -32700);
  assert.match(msgs[2].result.content[0].text, /표준 입출력으로 넣은 할 일/);
  // 앱이 같은 파일을 열면 보인다
  const store = createStore(path.join(dir, 'store.sqlite'));
  assert.deepEqual(store.getViewState().inbox.map((r) => r.title), ['표준 입출력으로 넣은 할 일']);
  store.close();
});

test('붙여 넣을 설정 — 이 PC의 실행 파일을 Node 모드로, 서버 스크립트를 인자로', async () => {
  const { buildConfig } = await import('../main/mcp/config.mjs');
  const exe = String.raw`C:\Users\u\AppData\Local\Programs\WHENWORK\WHENWORK.exe`;
  const script = String.raw`C:\Users\u\AppData\Local\Programs\WHENWORK\resources\app.asar\main\mcp\server.mjs`;
  const c = buildConfig({ execPath: exe, script });
  const d = JSON.parse(c.desktop);
  assert.deepEqual(d.mcpServers.whenwork, { command: exe, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(c.code, `claude mcp add whenwork --scope user -e ELECTRON_RUN_AS_NODE=1 -- "${exe}" "${script}"`);
});

test('앱 쪽 — 켜기는 true나 지우기만, Store판은 별칭 설정으로, AI가 바꾸면 화면을 새로 그린다', () => {
  const ipc = fs.readFileSync(path.join(ROOT, 'main', 'ipc.mjs'), 'utf8');
  const keys = ipc.slice(ipc.indexOf('const SETTING_KEYS'), ipc.indexOf(';', ipc.indexOf('const SETTING_KEYS')));
  assert.ok(keys.includes("'mcpEnabled'"));
  assert.ok(ipc.includes("if (key === 'mcpEnabled' && value != null && value !== true) return { ok: false };"));
  assert.ok(ipc.includes('store: !!process.windowsStore'), 'Store판이면 별칭 설정을 만든다');
  const life = fs.readFileSync(path.join(ROOT, 'main', 'lifecycle.mjs'), 'utf8');
  assert.ok(life.includes('if (name !== MCP_SIGNAL) return;'));
  assert.ok(life.includes("tw.webContents.send('today:refresh')"));
});

test('설정 파일에 AI 연결 항목이 없으면 꺼진 것이다', () => {
  const dir = tmp();
  createStore(path.join(dir, 'store.sqlite')).close();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', notifyAt: '08:00' }));
  const server = createServer({ dir });
  const r = server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } });
  assert.equal(r.result.isError, true);
  server.close();
});

test('프로젝트 정렬값이 같아도(가져오기·동기화) 번호는 화면 순서(이름순)를 따른다', () => {
  const dir = tmp();
  const store = createStore(path.join(dir, 'store.sqlite'));
  store.applyRemote({ project: [
    { uid: 'u1', name: '하나', status: 'active', sort: 0, updated_at: '2026-11-01T00:00:00.000Z' },
    { uid: 'u2', name: '가나', status: 'active', sort: 0, updated_at: '2026-11-01T00:00:00.000Z' },
  ] });
  const tools = createTools(store, { now: () => NOW });
  assert.deepEqual(store.getViewState().projects.map((p) => p.name), ['가나', '하나']);
  assert.deepEqual(json(tools.call('list_projects', {})).projects.map((p) => p.name), ['가나', '하나']);
  assert.equal(json(tools.call('add_task', { title: 'x', project: '1' })).added.project, '가나');
  store.close();
});

test('손상된 저장소를 만나면 MCP 쪽은 격리·새로 만들기를 하지 않는다 — 복구는 앱만', () => {
  const dir = tmp();
  const file = path.join(dir, 'store.sqlite');
  fs.writeFileSync(file, Buffer.from('this is not a sqlite database'.repeat(200)));
  const before = fs.readFileSync(file);
  const s = createStore(file, { recover: false });
  assert.equal(s.status().ok, false);
  assert.deepEqual(fs.readFileSync(file), before, '원본을 건드리지 않는다');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== 'store.sqlite' && !f.startsWith('store.sqlite-')), [], '격리 파일을 만들지 않는다');
  s.close?.();
});

test('Store판 설정 — 실행 별칭으로 띄우고, 서버는 실행 파일 자기 위치에서 찾는다(버전 든 경로를 적지 않는다)', async () => {
  const { buildConfig, SELF_LOADER } = await import('../main/mcp/config.mjs');
  const local = ['C:', 'Users', 'u', 'AppData', 'Local'].join(path.win32.sep);
  const c = buildConfig({ execPath: 'C:/Program Files/WindowsApps/WHENDESK.WHENWORK_0.4.1.0_x64__v6wmc55x8ryje/app/WHENWORK.exe', script: 'unused', store: true, localAppData: local });
  const e = JSON.parse(c.desktop).mcpServers.whenwork;
  assert.equal(e.command, [local, 'Microsoft', 'WindowsApps', 'whenwork.exe'].join(path.win32.sep));
  assert.deepEqual(e.args, ['-e', SELF_LOADER]);
  assert.deepEqual(e.env, { ELECTRON_RUN_AS_NODE: '1' });
  assert.ok(!c.desktop.includes('0.4.1.0'), '버전이 든 설치 경로를 적지 않는다');
  assert.ok(!SELF_LOADER.includes('"'), 'Claude Code 명령의 큰따옴표와 부딪히지 않는다');
  assert.ok(SELF_LOADER.includes("'app.asar','main','mcp','server.mjs'"), 'resources/app.asar/main/mcp/server.mjs를 찾는다');
  assert.ok(SELF_LOADER.includes('m.runStdio()'), '-e로는 직접 실행 판정이 없으니 runStdio를 부른다');
});

test('Store 매니페스트에 실행 별칭 whenwork.exe가 있다', () => {
  const m = fs.readFileSync(path.join(ROOT, 'assets', 'appx', 'AppxManifest.xml'), 'utf8');
  assert.ok(m.includes('Category="windows.appExecutionAlias"'));
  assert.ok(m.includes('<desktop:ExecutionAlias Alias="whenwork.exe" />'));
  assert.ok(m.includes('xmlns:uap3="http://schemas.microsoft.com/appx/manifest/uap/windows10/3"'));
});
