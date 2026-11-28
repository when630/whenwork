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

  // Windows(Ctrl+Alt+Space)와 같은 조합을 쓰지 않는다. macOS에서 ⌃⌥Space는 시스템 기본
  // "입력 메뉴에서 다음 소스 선택"이고 ⌃Space는 "이전 입력 소스 선택"이다 — 한글·영문을 오가는
  // 한국어 사용자는 거의 다 켜 두고 있다. 시스템 단축키가 먼저 가져가서 register()는 true인데
  // 눌러도 입력 소스만 바뀐다(맥 실기기 symbolichotkeys 61번 enabled 확인). 등록 실패로도
  // 드러나지 않으니 기본값에서 피해야 한다.
  // ⌘Space(Spotlight)·⌘⌥Space(Finder 검색)·⌃⌘Space(이모지)도 시스템 것이고, ⌥Space는
  // Raycast·Alfred·ChatGPT 기본값과 겹친다. 그래서 ⌃⇧Space. 설정에서 바꿀 수 있다(PLAT-02).
  defaultHotkey: 'Control+Shift+Space',

  // 인박스를 바로 여는 조합 — 퀵캡처 조합에 키 하나(⌥)만 더한다. 새 조합을 외우게 하지 않으려는
  // 것이고, 시스템 입력 소스 단축키(⌃Space·⌃⌥Space)와도 겹치지 않는다. 설정에서 바꿀 수 있다.
  defaultInboxHotkey: 'Control+Alt+Shift+Space',

  // macOS 자동 업데이트는 **코드 서명이 필수**다(electron-builder 공식 문서 명시).
  // Squirrel.Mac이 새 버전의 서명을 확인하고 다르면 거부한다. 0.4.4부터 릴리스는 Developer ID로
  // 서명·공증된다(D-P30, CI가 Secrets로 서명하고 Gatekeeper까지 확인 — 실패하면 올리지 않는다).
  // 그래서 받아서 종료할 때 설치한다. 0.4.3 이하(미서명)는 이 값이 false라 알림 → 받는 곳으로
  // 가서 서명판을 한 번 직접 받아야 하고, 그 뒤로는 자동이다.
  // 서명 없이 직접 빌드한 앱이면 업데이트가 서명 확인에서 실패해 설정에 오류로 남는다(앱은 그대로 쓴다).
  canAutoUpdate: true,

  // Mac App Store 배포는 아직 없다(Apple Developer 보류 — docs/07_Pro_설계.md)
  store: false,

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

  // 창을 보이고 숨기는 순서(D8). macOS는 `hide()`로 직전 앱에 포커스가 돌아간다 — 최소화를 거치지 않는다.
  // `app.hide()`(WHENCOMMAND 방식)는 쓰지 않는다 — 캡처를 닫을 때 열려 있던 오늘 뷰까지 함께 사라진다.
  activate(win, place) {
    if (win.isMinimized()) win.restore();
    place?.();
    win.show();
    win.focus();
  },
  deactivate(win) {
    win.hide();
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
  loginItemBySystem: false,
  loginItemSettingsUrl: null,

  setLoginItem(app, openAtLogin) {
    app.setLoginItemSettings({ openAtLogin, args: [] });
    return app.getLoginItemSettings().openAtLogin === openAtLogin;
  },

  getLoginItem(app) {
    return app.getLoginItemSettings().openAtLogin;
  },
};
