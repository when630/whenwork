// 인라인 SVG 아이콘. 이모지는 폰트에 따라 색·크기가 제각각이라 currentColor를 따르는 선 아이콘을 쓴다.
// CSP(default-src 'self')에서 data: URI 이미지는 막히므로 SVG 노드를 직접 만든다.
const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(paths, size = 12) {
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('viewBox', '0 0 16 16');
  node.setAttribute('width', String(size));
  node.setAttribute('height', String(size));
  node.setAttribute('fill', 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', '1.4');
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');
  node.setAttribute('aria-hidden', 'true');
  node.classList.add('ico');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    node.append(p);
  }
  return node;
}

window.ICONS = {
  // 캡처 컨텍스트 = 그때 앞에 있던 창
  context: (size) => svg(['M2.5 4.2a1.7 1.7 0 0 1 1.7-1.7h7.6a1.7 1.7 0 0 1 1.7 1.7v7.6a1.7 1.7 0 0 1-1.7 1.7H4.2a1.7 1.7 0 0 1-1.7-1.7Z', 'M2.5 6.1h11'], size),
};
