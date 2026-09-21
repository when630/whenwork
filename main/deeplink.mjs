// main/deeplink.mjs — 형제 앱 연동의 순수 부분. 규약은 when630/when-protocol, 첫 구현은 WHENNOTE(main/deeplink.mjs)에서 복사했다.
//
//   parseDeepLink   whenwork://add?text=회의 준비 → { command: 'add', args: { text: '회의 준비' } }. 모르는 스킴·명령은 null
//   fromArgv        Windows/Linux는 URL이 argv로 온다(첫 실행이면 process.argv, 떠 있으면 second-instance)
//   buildManifest   ~/.when/apps/whenwork.json에 쓸 명령 목록 — WHENCOMMAND가 읽어 입력줄에 합친다

export const SCHEME = 'whenwork';
export const APP_ID = 'whenwork';

// 이 앱이 받는 명령. title은 WHENCOMMAND 입력줄에 보이는 이름이고, 그 뒤에 띄어 쓴 것이 첫 인자로 온다.
export const COMMANDS = [
  { id: 'add', title: '할 일 추가', description: '적은 글이 그대로 인박스에 들어간다 — 창을 띄우지 않는다', args: [{ name: 'text', type: 'string' }] },
  { id: 'capture', title: '퀵캡처', description: '한 줄 입력창을 띄운다 — 연달아 던질 때', args: [{ name: 'text', type: 'string', optional: true }] },
  { id: 'today', title: '오늘 할 일', description: '오늘 뷰를 연다' },
  { id: 'inbox', title: '인박스', description: '분류 안 한 것들을 연다' },
];

const KNOWN = new Set(COMMANDS.map((c) => c.id));

export function parseDeepLink(raw) {
  let u;
  try { u = new URL(String(raw ?? '')); } catch { return null; }
  if (u.protocol !== `${SCHEME}:`) return null;
  const command = (u.host || u.pathname.replace(/^\/+/, '')).replace(/\/+$/, '').toLowerCase();
  if (!KNOWN.has(command)) return null;
  const args = {};
  for (const [k, v] of u.searchParams) if (v) args[k] = v;
  return { command, args };
}

export function fromArgv(argv) {
  return (argv ?? []).find((a) => typeof a === 'string' && a.toLowerCase().startsWith(`${SCHEME}://`)) ?? null;
}

// verify는 실제로 설치돼 있는지 WHENCOMMAND가 확인하는 경로다. 패키징본이면 지금 실행 파일(macOS는 .app 번들),
// 개발 실행이면 설치본의 관례 경로 — 개발용 electron.exe를 적으면 설치본이 없는 PC에서도 "있다"고 읽힌다.
export function buildManifest({ platformName, exePath, packaged }) {
  const verify = {
    darwin: '/Applications/WHENWORK.app',
    win32: '%LOCALAPPDATA%\\Programs\\WHENWORK\\WHENWORK.exe',
  };
  if (packaged && exePath) {
    if (platformName === 'darwin') {
      const m = String(exePath).match(/^(.*?\.app)\//);
      if (m) verify.darwin = m[1];
    } else if (platformName === 'win32') {
      verify.win32 = exePath;
    }
  }
  return {
    protocol: 1,
    id: APP_ID,
    name: 'WHENWORK',
    scheme: SCHEME,
    verify,
    commands: COMMANDS.map((c) => ({ ...c, args: c.args ? c.args.map((a) => ({ ...a })) : undefined })),
  };
}
