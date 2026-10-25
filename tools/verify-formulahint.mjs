// 数式ヒント（src/engine/formulahint.js）の大量ランダム検証（Ver.0.3-B）。
// 使い方: node tools/verify-formulahint.mjs [--hands 20000] [--seed 1]
// 各モードでランダムな手牌（3〜9枚、物理牌の枚数を超えない）を作り、物理牌 id の総当たりと照合する：
//   候補の重複・漏れ、同時最大組数、最大組数を実現する組合せ、色の割り当て（二重利用・共有の最小性・2色まで）。
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { analyzeFormulas, initialSelection, assignColors } from '../src/engine/formulahint.js';
import { createRng } from '../src/engine/rng.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const HANDS = opt('--hands', 20000);
const SEED = opt('--seed', 1);

function brute(r, h) {
  const distinct = new Set();
  let max = 0;
  const optimal = new Set();
  (function rec(pool, acc) {
    if (acc.length > max) { max = acc.length; optimal.clear(); }
    if (acc.length === max && max > 0) optimal.add(acc.slice().sort((a, b) => a - b).join(','));
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) for (let l = j + 1; l < pool.length; l++) {
      const m = r.meldOf(pool[i].type, pool[j].type, pool[l].type);
      if (!m || m.kind !== 'formula') continue;
      distinct.add(m.idx);
      rec(pool.filter((_, x) => x !== i && x !== j && x !== l), [...acc, m.idx]);
    }
  })(h, []);
  return { distinct, max, optimal };
}

let failures = 0;
const fail = (msg) => { failures++; if (failures <= 10) console.error(msg); };
for (const mode of ['math1', 'math2']) {
  const r = createRules(makeConfig({ mode }));
  const rng = createRng(SEED + (mode === 'math2' ? 1000 : 0));
  const pool = [];
  r.types.forEach((t) => { for (let c = 0; c < t.copies; c++) pool.push(t.idx); });
  const stat = { hands: 0, withFormula: 0, maxDist: {}, distinctMax: 0, shared: 0, single: 0 };
  const t0 = Date.now();
  for (let n = 0; n < HANDS; n++) {
    const size = 3 + (n % 7);
    // 関数・角度・値をほぼ同数ずつ（数式ができやすい）
    const left = pool.slice();
    const h = [];
    for (let i = 0; i < size; i++) {
      const kind = ['func', 'angle', 'value'][Math.floor(rng.next() * 3)];
      const cand = [];
      left.forEach((t, x) => { if (r.types[t].kind === kind) cand.push(x); });
      const x = cand[Math.floor(rng.next() * cand.length)];
      h.push({ id: 11 * i + 5, type: left[x] });
      left.splice(x, 1);
    }
    const a = analyzeFormulas(r, h);
    const b = brute(r, h);
    const got = a.formulas.map((f) => f.meld);
    if (new Set(got).size !== got.length) fail(`${mode}: 候補の重複`);
    if (got.slice().sort((x, y) => x - y).join() !== [...b.distinct].sort((x, y) => x - y).join()) fail(`${mode}: 候補の不一致`);
    if (a.max !== b.max) fail(`${mode}: 最大組数 ${a.max} vs ${b.max}`);
    const opt2 = new Set(a.optimal.map((s) => s.slice().sort((x, y) => x - y).join(',')));
    if (opt2.size !== b.optimal.size || [...opt2].some((x) => !b.optimal.has(x))) fail(`${mode}: 最大組数の組合せの不一致`);
    stat.hands++;
    stat.maxDist[a.max] = (stat.maxDist[a.max] || 0) + 1;
    stat.distinctMax = Math.max(stat.distinctMax, got.length);
    const sel = initialSelection(r, a);
    if (!sel) continue;
    stat.withFormula++;
    const single = got.length === 1;
    if (single) stat.single++;
    for (const mode2 of ['both', 'a', 'b']) {
      const res = assignColors(r, h, a, sel, { mode: mode2, single });
      const typeOf = new Map(h.map((x) => [x.id, x.type]));
      for (const [id, c] of res.colors) {
        if (!typeOf.has(id)) fail(`${mode}: 手牌にない牌`);
        if (c.length < 1 || c.length > 2) fail(`${mode}: 色の数`);
      }
      if (mode2 === 'both' && res.shared) {
        stat.shared++;
        const need = new Map();
        for (const t of [...r.melds[sel.a].tiles, ...r.melds[sel.b].tiles]) need.set(t, (need.get(t) || 0) + 1);
        const minShared = [...need].reduce((s, [t, x]) => s + Math.max(0, x - a.counts[t]), 0);
        if ([...res.colors.values()].filter((c) => c.length === 2).length !== minShared) fail(`${mode}: 共有が最小でない`);
      } else {
        // 各色の牌が、その数式 sets 組ぶんの牌と一致（重複利用なし）
        for (const [slot, color] of [['a', single ? 'yellow' : 'red'], ['b', 'blue']]) {
          if (!res.sets[slot]) continue;
          const types = [...res.colors].filter(([, c]) => c.includes(color)).map(([id]) => typeOf.get(id)).sort((x, y) => x - y);
          const want = [];
          for (let k = 0; k < res.sets[slot]; k++) want.push(...r.melds[sel[slot]].tiles);
          if (types.join() !== want.sort((x, y) => x - y).join()) fail(`${mode}: ${slot} の割り当て`);
        }
        if ([...res.colors.values()].some((c) => c.length !== 1)) fail(`${mode}: 共有でないのに2色`);
      }
    }
  }
  console.log(JSON.stringify({ mode, ...stat, seconds: (Date.now() - t0) / 1000 }));
}
console.log(failures ? `NG: ${failures}件の不一致` : 'OK: 不一致なし');
process.exitCode = failures ? 1 : 0;
