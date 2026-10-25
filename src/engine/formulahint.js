// 数式ヒント（Ver.0.3-B）：手牌の中で完成している数式の整理。画面から独立した純粋関数。
// 数学的な整理だけを行い、役の点数・AI の評価・戦略は使わない（表示順・初期選択は角度と関数の順だけで決める）。
//
// ・完成数式：手牌の関数牌1枚＋角度牌1枚＋結果牌1枚で、rules.melds の数式面子（kind === 'formula'）になるもの。
//   刻子は含めない。三角関数の正誤は rules.melds（厳密値で生成）だけに頼り、ここでは判定しない。
// ・通り数：異なる数式の種類の数。同じ等式を複数組作れても1通り（copies に組数）。
// ・同時最大組数：物理牌を重複利用せずに同時に作れる数式面子の最大数（全探索で厳密に求める）。
// ・色：表示する数式（最大2種類）を物理牌 id に割り当てる。並び替え（表示位置）には依存しない。
// tests/formulahint.test.js で、小さな手牌の総当たり・ランダム手牌と照合している。

const FN_ORDER = { sin: 0, cos: 1, tan: 2 };

// 数式の並び順：角度の小さい順 → sin・cos・tan の順（rules ごとに1回だけ作る）
const orderCache = new WeakMap();
function formulaOrder(rules) {
  let list = orderCache.get(rules);
  if (!list) {
    list = rules.melds.filter((m) => m.kind === 'formula')
      .sort((a, b) => a.deg - b.deg || FN_ORDER[a.fn] - FN_ORDER[b.fn])
      .map((m) => m.idx);
    orderCache.set(rules, list);
  }
  return list;
}

// hand: [{ id, type }]（自分の手牌だけ。公開面子は含めない）
// 戻り値: { formulas: [{ meld, copies }]（並び順どおり）, max, optimal: [[meld...]...]（最大組数を実現する組合せ、重複なし） }
export function analyzeFormulas(rules, hand) {
  const counts = new Array(rules.T).fill(0);
  for (const h of hand) counts[h.type]++;
  const formulas = [];
  for (const mi of formulaOrder(rules)) {
    const tiles = rules.melds[mi].tiles; // 数式面子の3枚は種類がすべて異なる
    const copies = Math.min(counts[tiles[0]], counts[tiles[1]], counts[tiles[2]]);
    if (copies > 0) formulas.push({ meld: mi, copies });
  }
  // 同時最大組数：完成数式だけを対象に、組合せ（重複あり、並び順の昇順）を全探索
  let max = 0;
  let optimal = [];
  const acc = [];
  (function rec(start) {
    if (acc.length > max) { max = acc.length; optimal = []; }
    if (acc.length === max && acc.length > 0) optimal.push(acc.slice());
    for (let i = start; i < formulas.length; i++) {
      const tiles = rules.melds[formulas[i].meld].tiles;
      if (!tiles.every((t) => counts[t] > 0)) continue;
      for (const t of tiles) counts[t]--;
      acc.push(formulas[i].meld);
      rec(i);
      acc.pop();
      for (const t of tiles) counts[t]++;
    }
  })(0);
  return { formulas, max, optimal, counts };
}

// 数式 a・b（meld index、同じでもよい）を x 組・y 組、物理牌を重複せずに同時に作れるか
function fits(rules, counts, a, x, b, y) {
  const need = new Map();
  for (const t of rules.melds[a].tiles) need.set(t, (need.get(t) || 0) + x);
  if (b !== null && b !== undefined) for (const t of rules.melds[b].tiles) need.set(t, (need.get(t) || 0) + y);
  for (const [t, n] of need) if (counts[t] < n) return false;
  return true;
}

// 初期表示の選択（例外C）。{ a, b }（b は null のこともある）。完成数式がなければ null。
// 1) 1通りなら a だけ。
// 2) 2通り以上なら異なる2種類の組 (A, B) を次の順で選ぶ：
//    第1：同時最大組数を実現する組合せに A・B がともに含まれる
//    第2：A・B を物理牌の重複なしに同時に作れる
//    第3：牌を共有する（同時には使えない）
//    同じ段階なら並び順（角度の小さい順 → sin・cos・tan）で最初の組。点数・AI の評価は使わない。
export function initialSelection(rules, analysis) {
  const { formulas, optimal, counts } = analysis;
  if (!formulas.length) return null;
  if (formulas.length === 1) return { a: formulas[0].meld, b: null };
  let best = null;
  for (let i = 0; i < formulas.length; i++) {
    for (let j = i + 1; j < formulas.length; j++) {
      const A = formulas[i].meld;
      const B = formulas[j].meld;
      const tier = optimal.some((s) => s.includes(A) && s.includes(B)) ? 0 : fits(rules, counts, A, 1, B, 1) ? 1 : 2;
      if (!best || tier < best.tier) best = { tier, a: A, b: B };
      if (tier === 0) return { a: best.a, b: best.b }; // 並び順で最初の第1段階の組
    }
  }
  return { a: best.a, b: best.b };
}

// 表示する数式の色を物理牌 id に割り当てる。
// sel: { a, b }、mode: 'both' | 'a' | 'b'、single: 完成数式が1通りか（黄色）。
// 戻り値: { colors: Map(id → ['yellow'] | ['red'] | ['blue'] | ['red','blue']), sets: { a, b }, shared }
//   ・1種類だけ表示：その数式を作れるだけの組数ぶん、同じ色で。
//   ・2種類：両方を1組以上ずつ重複なしに作れるなら、合計組数が最大（同数なら a を多く）になるように別々の牌へ。
//     作れないなら1組ずつ、できるだけ別の牌を使い、どうしても共有する牌だけ2色（共有）。
//   ・同じ種類の牌が複数あるときは id の小さい順に使う（手牌の並び替えでは変わらない）。
export function assignColors(rules, hand, analysis, sel, { mode = 'both', single = false } = {}) {
  const colors = new Map();
  const sets = { a: 0, b: 0 };
  if (!sel) return { colors, sets, shared: false };
  const byType = new Map();
  for (const h of [...hand].sort((p, q) => p.id - q.id)) {
    if (!byType.has(h.type)) byType.set(h.type, []);
    byType.get(h.type).push(h.id);
  }
  const counts = analysis.counts;
  const add = (id, c) => { const cur = colors.get(id); if (!cur) colors.set(id, [c]); else if (!cur.includes(c)) cur.push(c); };
  const copiesOf = (mi) => (mi === null || mi === undefined ? 0 : Math.min(...rules.melds[mi].tiles.map((t) => counts[t])));
  const showA = mode !== 'b' && sel.a !== null && sel.a !== undefined;
  const showB = mode !== 'a' && sel.b !== null && sel.b !== undefined;
  const colorA = single ? 'yellow' : 'red';
  if (showA && !showB) {
    sets.a = copiesOf(sel.a);
    for (const t of rules.melds[sel.a].tiles) for (const id of byType.get(t).slice(0, sets.a)) add(id, colorA);
    return { colors, sets, shared: false };
  }
  if (showB && !showA) {
    sets.b = copiesOf(sel.b);
    for (const t of rules.melds[sel.b].tiles) for (const id of byType.get(t).slice(0, sets.b)) add(id, 'blue');
    return { colors, sets, shared: false };
  }
  if (!showA && !showB) return { colors, sets, shared: false };
  // 2種類：重複なしで両方を作れる最大の組数
  let pick = null;
  for (let x = copiesOf(sel.a); x >= 1; x--) {
    for (let y = copiesOf(sel.b); y >= 1; y--) {
      if (!fits(rules, counts, sel.a, x, sel.b, y)) continue;
      if (!pick || x + y > pick.x + pick.y) pick = { x, y };
    }
  }
  if (pick) {
    sets.a = pick.x;
    sets.b = pick.y;
    const used = new Map(); // 種類ごとに使った枚数
    const take = (t, n, c) => {
      const from = used.get(t) || 0;
      for (const id of byType.get(t).slice(from, from + n)) add(id, c);
      used.set(t, from + n);
    };
    for (const t of rules.melds[sel.a].tiles) take(t, pick.x, 'red');
    for (const t of rules.melds[sel.b].tiles) take(t, pick.y, 'blue');
    return { colors, sets, shared: false };
  }
  // 共有：1組ずつ。b はできるだけ a と別の牌を使い、足りない種類だけ同じ牌を共有する
  sets.a = 1;
  sets.b = 1;
  const usedByA = new Set();
  for (const t of rules.melds[sel.a].tiles) { const id = byType.get(t)[0]; add(id, 'red'); usedByA.add(id); }
  for (const t of rules.melds[sel.b].tiles) {
    const ids = byType.get(t);
    const free = ids.find((id) => !usedByA.has(id));
    add(free !== undefined ? free : ids[0], 'blue');
  }
  return { colors, sets, shared: true };
}

// 公開済み面子の内訳（数式面子・刻子の組数）。melds は Game.melds[seat] または view.melds[seat]
export function exposedSummary(rules, melds) {
  let formula = 0;
  let koutsu = 0;
  for (const m of melds) {
    if (rules.melds[m.meld].kind === 'koutsu') koutsu++;
    else formula++;
  }
  return { formula, koutsu };
}
