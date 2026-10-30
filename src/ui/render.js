// 牌・数式の HTML 表示（画面専用。ゲームロジックは持たない）

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// '√3' → √ と被開平数（上線付き）
function term(s) {
  if (s.startsWith('√')) return `<span class="rad"><span class="rs"><span class="glyph">√</span></span><span class="radicand">${esc(s.slice(1))}</span></span>`;
  return `<span class="int">${esc(s)}</span>`;
}

// 牌の枠に収めるための幅の見積もり（em。styles.css の .tile .val / .ang の --vw・--aw）。
// 負号と根号は CSS で描く固定幅（フォントに依存しない）。数字は太字の数字の幅（どのフォントでも約0.55em）に余裕を見る。
const W_DIGIT = 0.6;
const W_NEG = 0.46; // 負号 0.38em ＋ 間 0.08em
const W_ROOT = 0.44; // 根号の記号（被開平数の上線は radicand の幅）
const termWidth = (s) => (s.startsWith('√') ? W_ROOT + (s.length - 1) * W_DIGIT + 0.1 : s.length * W_DIGIT);
export function valueWidth(d) {
  const body = d.den ? 0.86 * (Math.max(termWidth(d.num), termWidth(d.den)) + 0.2) : termWidth(d.num);
  return +((d.neg ? W_NEG : 0) + body + 0.12).toFixed(2);
}
// 高さの見積もり（em）：1行は約1.05em、根号は上線の分だけ高い。分数は分子・分母と分数線（0.86倍の大きさ）
const termHeight = (s) => (s.startsWith('√') ? 1.2 : 1.05);
export function valueHeight(d) {
  return +((d.den ? 0.86 * (termHeight(d.num) + termHeight(d.den) + 0.2) : termHeight(d.num)) + 0.1).toFixed(2);
}
export function angleWidth(t) {
  if (t.unit === 'rad') {
    const r = t.rad;
    const w = (x) => [...x].length * W_DIGIT;
    return +((r.den ? 0.78 * (Math.max(w(r.num), w(r.den)) + 0.2) : w(r.num)) + 0.12).toFixed(2);
  }
  // 数字は中央、度数記号は数字の右に添える（左右対称に余白を取る）
  return +(String(t.deg).length * W_DIGIT + 2 * 0.3).toFixed(2);
}
const angleHeight = (t) => (t.unit === 'rad' && t.rad.den ? 0.78 * (1.05 * 2 + 0.2) + 0.1 : 1.15);

// 結果牌の値（display: {neg, num, den}）を分数として描画。負号の文字は読み上げ・検索用に残し、表示は CSS の線
export function valueHTML(d) {
  const sign = d.neg ? '<span class="neg"><span class="glyph">−</span></span>' : '';
  const body = d.den
    ? `<span class="frac"><span class="num">${term(d.num)}</span><span class="den">${term(d.den)}</span></span>`
    : term(d.num);
  return `<span class="val" style="--vw:${valueWidth(d)};--vh:${valueHeight(d)}">${sign}${body}</span>`;
}

// 角度：度数法（30°）または弧度法（π/6 を縦組みの分数で）。数学Ⅱ（unit 'rad'）は弧度法。
export function angleHTML(t) {
  if (t.unit === 'rad') {
    const r = t.rad;
    return r.den
      ? `<span class="frac afrac"><span class="num"><span class="int">${esc(r.num)}</span></span><span class="den"><span class="int">${esc(r.den)}</span></span></span>`
      : `<span class="int">${esc(r.num)}</span>`;
  }
  return `${t.deg}<span class="deg">°</span>`;
}

export function tileFaceHTML(t) {
  if (t.kind === 'func') return `<span class="fn">${t.fn}</span>`;
  if (t.kind === 'angle') return `<span class="ang${t.unit === 'rad' ? ' rad' : ''}" style="--aw:${angleWidth(t)};--ah:${+angleHeight(t).toFixed(2)}">${angleHTML(t)}</span>`;
  return `<span class="eq">=</span>${valueHTML(t.display)}`;
}

// 角度の文字表記（読み上げ・title 用）：30° / π/6
export function angleText(t) {
  if (t.unit === 'rad') return t.rad.den ? `${t.rad.num}/${t.rad.den}` : t.rad.num;
  return `${t.deg}°`;
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
  if (t.kind === 'angle') return angleText(t);
  return `=${t.value.replace('-', '−')}`;
}

// 牌1枚を数式の中に置く表記（関数名・角度・= 値）
function inlineFace(t) {
  if (t.kind === 'func') return `<span class="fn f-${t.fn}">${t.fn}</span>`;
  if (t.kind === 'angle') return `<span class="ang-in">${angleHTML(t)}</span>`;
  return `<span class="op">=</span>${valueHTML(t.display)}`;
}

// 面子を数式として表示: sin 30° = 1/2（数学Ⅱは sin π/6 = 1/2）。刻子は「sin ×3 刻子」。
export function formulaHTML(rules, meldIdx) {
  const m = rules.melds[meldIdx];
  if (m.kind === 'koutsu') {
    return `<span class="formula koutsu">${inlineFace(rules.types[m.type])}<span class="op">×3</span><span class="kt">刻子</span></span>`;
  }
  const a = rules.types[m.tiles[1]];
  const v = rules.types[m.tiles[2]];
  return `<span class="formula"><span class="fn f-${m.fn}">${m.fn}</span>&thinsp;<span class="ang-in">${angleHTML(a)}</span><span class="op">=</span>${valueHTML(v.display)}</span>`;
}

export function backHTML(n) {
  return `<span class="backs" aria-label="手牌${n}枚">${'<span class="back"></span>'.repeat(n)}</span>`;
}
