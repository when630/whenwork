// AI 연결(MCP) 서버 — Claude Desktop·Claude Code 같은 AI 앱이 실행한다(D-P29).
//
//   "command": "<WHENWORK.exe>",  "args": ["<이 파일>"],  "env": { "ELECTRON_RUN_AS_NODE": "1" }
//
// WHENWORK.exe를 Node 모드로 띄워 이 파일을 돌린다 — 따로 설치할 것이 없다. Electron 화면 앱 모드는
// Windows에서 표준 출력이 나오지 않아 쓸 수 없다(실측). 표준 입출력으로 줄 단위 JSON-RPC 2.0을 주고받는다.
//
// 앱과 같은 store.sqlite를 연다 — 앱이 꺼져 있어도 된다. 손상 복구는 앱만 한다(recover: false).
// 바꾼 뒤에는 mcp-signal 파일을 건드려 켜져 있는 앱이 화면을 새로 그리게 한다.
// 설정 → AI 연결(MCP)을 켠 경우에만 도구를 실행한다(settings.json mcpEnabled === true, 부를 때마다 확인).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../store.mjs';
import { createTools } from './tools.mjs';

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const SIGNAL_FILE = 'mcp-signal';
export const MSG_DISABLED = 'WHENWORK의 AI 연결이 꺼져 있습니다 — WHENWORK 설정 → "AI 연결 (MCP)"을 켜 주세요';

// 앱의 userData와 같은 곳(app.setName('whenwork')) — WHENWORK_DATA_DIR로 바꿀 수 있다(시험용)
export function dataDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.WHENWORK_DATA_DIR) return env.WHENWORK_DATA_DIR;
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'whenwork');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'whenwork');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'whenwork');
}

function appVersion() {
  try {
    const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version ?? '0';
  } catch {
    return '0';
  }
}

export function createServer({ dir = dataDir(), now } = {}) {
  let store = null;
  let tools = null;

  const enabled = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))?.mcpEnabled === true;
    } catch {
      return false;
    }
  };
  function open() {
    if (store?.status().ok) return true;
    store?.close?.();
    store = createStore(path.join(dir, 'store.sqlite'), { recover: false });
    tools = createTools(store, now ? { now } : {});
    return store.status().ok;
  }
  function signal() {
    try {
      fs.writeFileSync(path.join(dir, SIGNAL_FILE), String(Date.now()));
    } catch {}
  }

  const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
  const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  // 요청 하나 → 응답(알림이면 null)
  function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return msg && msg.id != null ? error(msg.id, -32600, 'Invalid Request') : null;
    }
    const { id, method, params = {} } = msg;
    const isNotification = id === undefined || id === null;
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return result(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'whenwork', title: 'WHENWORK', version: appVersion() },
          instructions:
            'WHENWORK는 사용자의 할 일 앱이다. 할 일을 추가하거나(add_task) 읽고(list_tasks·list_projects), 완료(complete_task)·마감(set_due)·프로젝트 지정(assign_project)을 할 수 있다. 할 일을 고칠 때는 list_tasks로 받은 id를 쓴다. 지우기·이름 바꾸기·프로젝트 만들기는 할 수 없다 — 사용자에게 WHENWORK에서 하도록 안내한다.',
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return isNotification ? null : result(id, {});
      case 'tools/list':
        return result(id, { tools: createTools(null).list() });
      case 'tools/call': {
        const name = params?.name;
        if (!enabled()) return result(id, { content: [{ type: 'text', text: MSG_DISABLED }], isError: true });
        if (!open()) return result(id, { content: [{ type: 'text', text: 'WHENWORK 저장소를 열지 못했습니다 — WHENWORK를 한 번 실행해 주세요' }], isError: true });
        const out = tools.call(name, params?.arguments ?? {});
        if (!out.isError && tools.isWrite(name)) signal();
        return result(id, out);
      }
      default:
        return isNotification ? null : error(id, -32601, `Method not found: ${method}`);
    }
  }

  function close() {
    store?.close?.();
    store = null;
  }

  return { handle, close };
}

// 표준 입출력 — 한 줄에 메시지 하나(MCP stdio). 표준 출력에는 JSON-RPC만 쓴다(로그는 표준 오류로)
export function runStdio({ input = process.stdin, output = process.stdout, server = createServer() } = {}) {
  let buf = '';
  input.setEncoding('utf8');
  const reply = (obj) => obj && output.write(JSON.stringify(obj) + '\n');
  input.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      try {
        if (Array.isArray(msg)) msg.map((m) => server.handle(m)).filter(Boolean).forEach(reply);
        else reply(server.handle(msg));
      } catch (e) {
        if (msg?.id != null) reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } });
        process.stderr.write(`whenwork mcp: ${e?.message ?? e}\n`);
      }
    }
  });
  input.on('end', () => {
    server.close();
    process.exit(0);
  });
}

// 직접 실행했을 때만(시험에서 import할 때는 돌지 않는다)
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(self)) runStdio();
