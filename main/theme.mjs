// main/theme.mjs — 창이 그려지기 전 바탕색. 렌더러 CSS가 칠하기 전 한 프레임 동안 보이는 색이라,
// renderer/tokens.css의 값과 같아야 창이 뜰 때 번쩍이지 않는다(test/theme.test.mjs가 둘을 맞춰 본다).
// 테마는 OS를 따른다 — nativeTheme.shouldUseDarkColors를 그대로 받는다.
export const WIN_BG = {
  capture: { light: '#f7f9fa', dark: '#1a1f27' }, // --bg-raised
  today: { light: '#e8ecf0', dark: '#12161c' }, // --bg-app
};

export function winBackground(kind, dark) {
  return (WIN_BG[kind] ?? WIN_BG.today)[dark ? 'dark' : 'light'];
}
