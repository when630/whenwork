// 주간 리뷰 초안을 보여주기 위한 최소 마크다운 — 우리가 만든 글만 들어오므로 필요한 문법만 다룬다.
// parse는 순수 함수(블록 배열)라 검증하기 쉽고, DOM은 render가 만든다(innerHTML 쓰지 않음).
(function () {
  // "**굵게**" 를 [{bold, text}] 조각으로
  function inline(text) {
    const parts = [];
    const re = /\*\*(.+?)\*\*/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push({ text: text.slice(last, m.index) });
      parts.push({ text: m[1], bold: true });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ text: text.slice(last) });
    return parts.length ? parts : [{ text: '' }];
  }

  function parse(src) {
    const blocks = [];
    let list = null;
    const flush = () => {
      if (list) blocks.push(list);
      list = null;
    };

    for (const raw of String(src ?? '').split('\n')) {
      const line = raw.trimEnd();
      if (!line.trim()) {
        flush();
        continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        flush();
        blocks.push({ type: 'heading', level: heading[1].length, parts: inline(heading[2]) });
        continue;
      }
      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        flush();
        blocks.push({ type: 'quote', parts: inline(quote[1]) });
        continue;
      }
      const item = line.match(/^\s*[-*]\s+(.*)$/);
      if (item) {
        if (!list) list = { type: 'list', items: [] };
        list.items.push(inline(item[1]));
        continue;
      }
      flush();
      const prev = blocks[blocks.length - 1];
      // 이어지는 줄은 같은 문단으로 붙인다
      if (prev?.type === 'para') prev.parts.push({ text: ' ' }, ...inline(line));
      else blocks.push({ type: 'para', parts: inline(line) });
    }
    flush();
    return blocks;
  }

  function fill(node, parts) {
    for (const p of parts) {
      if (p.bold) {
        const b = document.createElement('strong');
        b.textContent = p.text;
        node.append(b);
      } else {
        node.append(document.createTextNode(p.text));
      }
    }
    return node;
  }

  function render(src) {
    const frag = document.createDocumentFragment();
    for (const block of parse(src)) {
      if (block.type === 'heading') {
        frag.append(fill(document.createElement(`h${Math.min(block.level + 1, 6)}`), block.parts));
      } else if (block.type === 'list') {
        const ul = document.createElement('ul');
        for (const item of block.items) ul.append(fill(document.createElement('li'), item));
        frag.append(ul);
      } else if (block.type === 'quote') {
        frag.append(fill(document.createElement('blockquote'), block.parts));
      } else {
        frag.append(fill(document.createElement('p'), block.parts));
      }
    }
    return frag;
  }

  window.MD = { parse, render };
})();
