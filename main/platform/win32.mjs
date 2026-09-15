// main/platform/win32.mjs — Windows(및 그 외 OS의 기본값).
import fs from 'node:fs';
import path from 'node:path';
import { nativeImage } from 'electron';

export default {
  name: 'win32',

  // 설계 11절의 조합. macOS와 다른 값을 쓰지 않는 이유는 platform/darwin.mjs에 적었다.
  defaultHotkey: 'Control+Alt+Space',

  // Windows NSIS는 서명 없이도 electron-updater가 내려받아 설치한다.
  // (설치 시 SmartScreen이 한 번 더 물을 수 있지만 업데이트 경로 자체는 막히지 않는다)
  canAutoUpdate: true,

  // 사람에게 보여줄 조합 표기 — Electron 표기(Control+Alt+Space)를 그대로 읽히게 둔다
  hotkeyLabel: (accel) => String(accel).replace(/\bControl\b/g, 'Ctrl'),

  // 첫 실행 안내(PLAT-05). 트레이 아이콘이 **어디에 있는지**가 핵심이다 —
  // Windows 11은 새 트레이 아이콘을 기본으로 숨김 영역(^)에 넣어, 안내 없이는
  // 앱이 떴는데도 사라진 것처럼 보인다.
  firstRunHint: (hotkeyLabel) => ({
    title: 'WHENWORK가 트레이에 있습니다',
    body: `작업 표시줄 오른쪽 ^ 를 눌러 아이콘을 찾고, 끌어다 고정하면 계속 보입니다. ${hotkeyLabel} 로 언제든 캡처하세요. 인박스에서는 1~9로 프로젝트를 정합니다.`,
  }),

  // Windows는 알림에 AppUserModelId가 있어야 앱 이름·아이콘이 제대로 붙는다.
  prepareApp(app, { appId }) {
    app.setAppUserModelId(appId);
  },

  // 트레이/메뉴바 아이콘. Windows는 컬러 그대로 쓴다.
  trayImage(root) {
    const p = path.join(root, 'build', 'tray.png');
    return fs.existsSync(p) ? nativeImage.createFromBuffer(fs.readFileSync(p)) : nativeImage.createEmpty();
  },

  // 로그인 시 자동 실행. Windows는 실행 파일 경로가 그대로 등록된다.
  setLoginItem(app, openAtLogin) {
    app.setLoginItemSettings({ openAtLogin, args: [] });
    return app.getLoginItemSettings().openAtLogin === openAtLogin;
  },

  getLoginItem(app) {
    return app.getLoginItemSettings().openAtLogin;
  },
};
