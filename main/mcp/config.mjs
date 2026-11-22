// AI 앱에 붙여 넣을 설정 — 이 PC의 실제 경로로 만든다(D-P29). Electron을 모르는 순수 함수.
//   execPath: WHENWORK.exe(개발 실행에서는 electron.exe), script: main/mcp/server.mjs(배포판은 app.asar 안)
export const SERVER_NAME = 'whenwork';

export function buildConfig({ execPath, script }) {
  const entry = { command: execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } };
  const desktop = JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2);
  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  const code = `claude mcp add ${SERVER_NAME} --scope user -e ELECTRON_RUN_AS_NODE=1 -- ${q(execPath)} ${q(script)}`;
  return { entry, desktop, code };
}
