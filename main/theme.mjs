// main/theme.mjs — 창이 그려지기 전 바탕색. 렌더러 CSS가 칠하기 전 한 프레임 동안 보이는 색이라,
// renderer/tokens.css의 값과 같아야 창이 뜰 때 번쩍이지 않는다(test/theme.test.mjs가 둘을 맞춰 본다).
// 테마는 기본으로 OS를 따르고, 설정(theme)으로 앱만 밝게·어둡게 고정할 수 있다 — nativeTheme.themeSource 하나로
// 렌더러의 prefers-color-scheme과 shouldUseDarkColors가 함께 바뀐다. 트레이 아이콘은 테마와 상관없는 고정 그림이다.
export const WIN_BG = {
  capture: { light: '#f7f9fa', dark: '#1a1f27' }, // --bg-raised
  today: { light: '#e8ecf0', dark: '#12161c' }, // --bg-app
};

export function winBackground(kind, dark) {
  return (WIN_BG[kind] ?? WIN_BG.today)[dark ? 'dark' : 'light'];
}

// 설정의 화면 테마 — 모르는 값·빈 값은 시스템을 따른다
export const THEMES = ['system', 'light', 'dark'];
export function themeSource(value) {
  return THEMES.includes(value) ? value : 'system';
}
