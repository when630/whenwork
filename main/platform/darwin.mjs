// main/platform/darwin.mjs — macOS.
//
// ⚠ 이 파일의 동작은 **실기기에서 검증되지 않았다**(Phase 4 리서치 플래그, 01-UAT.md 3번).
// 검증되지 않은 것은 아래 셋이다. 실기기를 잡으면 이 주석부터 지운다:
//   1) globalShortcut.register()가 true를 돌려주고도 실제로는 눌리지 않는 경우
//      (Accessibility 권한과 무관하게 조용히 실패한다는 보고가 있다)
//   2) 미서명 앱의 setLoginItemSettings가 실제로 로그인 항목에 들어가는지
//   3) 메뉴바 상주에서 Dock 아이콘이 완전히 빠지는지
import fs from 'node:fs';
import path from 'node:path';
import { nativeImage } from 'electron';

export default {
  name: 'darwin',

  // Windows와 같은 조합을 기본으로 쓴다. macOS 관례는 Command+…지만
  // Command+Alt+Space는 Spotlight 계열과 부딪히는 자리가 많고, 무엇보다
  // 두 OS를 오가는 사람이 손가락을 다시 배우지 않아도 된다. 어차피 PLAT-02로
  // 바꿀 수 있고, 등록 실패는 화면에 드러난다.
  defaultHotkey: 'Control+Alt+Space',

  // macOS 자동 업데이트는 **코드 서명이 필수**다(electron-builder 공식 문서 명시).
  // Squirrel.Mac이 서명을 확인하고 거부하므로, 미서명 배포에서는 내려받아 설치하는
  // 경로 자체가 없다. 새 버전을 알려 주고 받는 곳으로 보내는 것까지가 할 수 있는 전부다.
  canAutoUpdate: false,

  hotkeyLabel: (accel) =>
    String(accel)
      .replace(/\bControl\b/g, '⌃')
      .replace(/\bAlt\b/g, '⌥')
      .replace(/\bCommand\b|\bCmd\b/g, '⌘')
      .replace(/\bShift\b/g, '⇧')
      .replace(/\+/g, ''),

  firstRunHint: (hotkeyLabel) => ({
    title: 'WHENWORK가 메뉴바에 있습니다',
    body: `화면 위쪽 메뉴바 오른쪽에서 아이콘을 찾으세요. Dock에는 뜨지 않습니다. ${hotkeyLabel} 로 언제든 캡처하고, 인박스에서는 1~9로 프로젝트를 정합니다.`,
  }),

  // 메뉴바 상주 — Dock 아이콘을 뺀다(PLAT-06). app.dock은 macOS에만 있고,
  // 패키징 여부와 무관하게 whenReady 전에 불러도 된다.
  prepareApp(app) {
    app.dock?.hide();
  },

  // macOS 메뉴바는 다크/라이트에 따라 아이콘 색이 뒤집혀야 한다. Template 이미지로
  // 넘기면 OS가 알아서 칠한다 — 컬러 아이콘을 그대로 주면 다크 모드에서 뭉개진다.
  // tray-Template.png가 있으면 그것을, 없으면 tray.png를 Template으로 표시한다.
  trayImage(root) {
    const tpl = path.join(root, 'build', 'tray-Template.png');
    const p = fs.existsSync(tpl) ? tpl : path.join(root, 'build', 'tray.png');
    if (!fs.existsSync(p)) return nativeImage.createEmpty();
    const img = nativeImage.createFromBuffer(fs.readFileSync(p));
    img.setTemplateImage(true);
    return img;
  },

  // 미서명 앱에서도 로그인 항목이 실제로 켜졌는지 **돌려받은 값으로 확인한다** —
  // setLoginItemSettings는 실패해도 던지지 않는다. 호출부는 이 false를 보고
  // 사용자에게 알린다(조용히 안 켜진 채로 두지 않는다).
  setLoginItem(app, openAtLogin) {
    app.setLoginItemSettings({ openAtLogin, args: [] });
    return app.getLoginItemSettings().openAtLogin === openAtLogin;
  },

  getLoginItem(app) {
    return app.getLoginItemSettings().openAtLogin;
  },
};
