// 牌・数式の HTML 表示（画面専用。ゲームロジックは持たない）

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// '√3' → √ と被開平数（上線付き）
function term(s) {
  if (s.startsWith('√')) return `<span class="rad">√<span class="radicand">${esc(s.slice(1))}</span></span>`;
  return `<span class="int">${esc(s)}</span>`;
}

// 結果牌の値（display: {neg, num, den}）を分数として描画
export function valueHTML(d) {
  const sign = d.neg ? '<span class="neg">−</span>' : '';
  const body = d.den
    ? `<span class="frac"><span class="num">${term(d.num)}</span><span class="den">${term(d.den)}</span></span>`
    : term(d.num);
  return `<span class="val">${sign}${body}</span>`;
}

export function tileFaceHTML(t) {
  if (t.kind === 'func') return `<span class="fn">${t.fn}</span>`;
  if (t.kind === 'angle') return `<span class="ang">${t.deg}<span class="deg">°</span></span>`;
  return `<span class="eq">=</span>${valueHTML(t.display)}`;
}

// 牌（type: rules.types の要素）
export function tileHTML(t, { size = 'm', id, cls = '', attrs = '' } = {}) {
  const kindCls = t.kind === 'func' ? `t-func t-${t.fn}` : t.kind === 'angle' ? 't-angle' : 't-value';
  const idAttr = id !== undefined ? ` data-id="${id}"` : '';
  const label = tileLabel(t);
  return `<span class="tile ${kindCls} sz-${size} ${cls}"${idAttr} ${attrs} role="img" aria-label="${esc(label)}">${tileFaceHTML(t)}</span>`;
}

export function tileLabel(t) {
  if (t.kind === 'func') return t.fn;
  if (t.kind === 'angle') return `${t.deg}°`;
  return `=${t.value.replace('-', '−')}`;
}

// 面子を数式として表示: sin 30° = 1/2
export function formulaHTML(rules, meldIdx) {
  const m = rules.melds[meldIdx];
  const v = rules.types[m.tiles[2]];
  return `<span class="formula"><span class="fn f-${m.fn}">${m.fn}</span>&thinsp;${m.deg}°<span class="op">=</span>${valueHTML(v.display)}</span>`;
}

export function backHTML(n) {
  return `<span class="backs" aria-label="手牌${n}枚">${'<span class="back"></span>'.repeat(n)}</span>`;
}
