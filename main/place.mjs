// 창을 어디에 놓을지 정하는 순수 계산 — Electron 없이 검증할 수 있게 분리했다.
// 잘못되면 창이 화면 밖에 떠서 못 잡으므로 여기가 제일 조심스러운 부분이다.

const KEEP = 60; // 이만큼은 화면 안에 걸쳐 있어야 잡아서 옮길 수 있다

export function visibleOnAnyDisplay(bounds, workAreas) {
  return workAreas.some(
    (a) =>
      bounds.x + bounds.width > a.x + KEEP &&
      bounds.x < a.x + a.width - KEEP &&
      bounds.y >= a.y - 4 &&
      bounds.y < a.y + a.height - KEEP
  );
}

// saved가 지금 화면 배치에서 쓸 만하면 그대로, 아니면 cursorArea 기준으로 가운데.
// centerY=false면 세로는 위쪽 28% 지점에 둔다 (퀵캡처는 화면 한가운데보다 살짝 위가 편하다).
export function pickPosition({ saved, size, workAreas, cursorArea, centerY = true }) {
  if (saved && visibleOnAnyDisplay({ ...saved, ...size }, workAreas)) {
    return { x: saved.x, y: saved.y };
  }
  return {
    x: Math.round(cursorArea.x + (cursorArea.width - size.width) / 2),
    y: Math.round(
      centerY
        ? cursorArea.y + (cursorArea.height - size.height) / 2
        : cursorArea.y + cursorArea.height * 0.28
    ),
  };
}
