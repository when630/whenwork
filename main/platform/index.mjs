// main/platform/index.mjs — OS 분기는 이 폴더 안에만 있다(PLAT-06).
//
// lifecycle.mjs가 `process.platform === 'darwin'`을 직접 보기 시작하면 분기가 파일 전체로
// 번지고, 한쪽 OS에서만 도는 코드가 어디에 있는지 아무도 모르게 된다. 두 구현이 같은
// 모양을 지키는지는 platform.test.mjs가 계약으로 검사한다.
import win32 from './win32.mjs';
import darwin from './darwin.mjs';

export const platform = process.platform === 'darwin' ? darwin : win32;

// 테스트가 양쪽 구현을 다 집어 계약을 확인할 수 있게 열어 둔다
export const implementations = { win32, darwin };
