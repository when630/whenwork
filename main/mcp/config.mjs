// AI 앱에 붙여 넣을 설정 — 이 PC의 실제 경로로 만든다(D-P29). Electron을 모르는 순수 함수.
//   설치 파일판: execPath = WHENWORK.exe(개발 실행에서는 electron.exe), args = [server.mjs 경로]
//                — 설치 위치가 업데이트해도 그대로라 경로를 적어도 된다
//   Store판:     패키지 안 실행 파일은 다른 프로그램이 경로로 띄울 수 없고, 설치 폴더 이름에 버전이 들어가
//                업데이트마다 바뀐다 → 실행 별칭(whenwork.exe, 매니페스트 4번)으로 띄우고, 서버 스크립트는
//                실행 파일이 자기 위치(resources/app.asar)에서 찾게 한다(-e). 둘 다 실측(2026-11-23, 개발자 모드 등록)
export const SERVER_NAME = 'whenwork';
export const STORE_ALIAS = 'whenwork.exe';
export const SELF_LOADER =
  "import(require('url').pathToFileURL(require('path').join(process.resourcesPath||require('path').join(require('path').dirname(process.execPath),'resources'),'app.asar','main','mcp','server.mjs')).href).then(m=>m.runStdio())";

export function storeAliasPath(localAppData) {
  return `${String(localAppData).replace(/[\\/]+$/, '')}\\Microsoft\\WindowsApps\\${STORE_ALIAS}`;
}

export function buildConfig({ execPath, script, store = false, localAppData = '' }) {
  const command = store ? storeAliasPath(localAppData) : execPath;
  const args = store ? ['-e', SELF_LOADER] : [script];
  const entry = { command, args, env: { ELECTRON_RUN_AS_NODE: '1' } };
  const desktop = JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2);
  // Claude Code 명령 — 인자를 큰따옴표로 감싼다(-e 코드 안에는 큰따옴표가 없다)
  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  const code = `claude mcp add ${SERVER_NAME} --scope user -e ELECTRON_RUN_AS_NODE=1 -- ${[command, ...args].map(q).join(' ')}`;
  // VS Code(Copilot) mcp.json — 최상위가 servers, stdio는 type을 적어야 한다(2026-11 공식 문서)
  const vscode = JSON.stringify({ servers: { [SERVER_NAME]: { type: 'stdio', ...entry } } }, null, 2);
  // Codex CLI ~/.codex/config.toml — JSON 문자열은 TOML 기본 문자열로도 맞다(\\·\"·\uXXXX 이스케이프가 같다)
  const t = (s) => JSON.stringify(String(s));
  const codex = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${t(command)}`,
    `args = [${args.map(t).join(', ')}]`,
    '',
    `[mcp_servers.${SERVER_NAME}.env]`,
    `ELECTRON_RUN_AS_NODE = "1"`,
    '',
  ].join('\n');
  return { entry, desktop, code, vscode, codex };
}

// 복사 단추가 고르는 형식 — 모르는 값은 일반 설정(desktop)
export const COPY_KINDS = ['desktop', 'code', 'vscode', 'codex'];
export function pickCopy(config, which) {
  return config[COPY_KINDS.includes(which) ? which : 'desktop'];
}
