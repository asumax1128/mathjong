// 上級 AI の係数（DANGER_COEF・WIN_COEF）の当てはめ（Ver.0.4-B）。中級どうしの対局を記録し、ロジスティック回帰で求める。
// 使い方: node tools/calibrate-advanced.mjs --mode math1 [--games 300] [--seed 9000]
// 正解（その他家がロンできたか・その局で和了したか）を作るときだけ他家の実際の手牌を使う。特徴量はすべて公開情報。
// 出力の係数を src/engine/ai-levels.js に転記する（ゲーム中の判断は他家の手牌を一切見ない）。
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction, unseenCounts, handValue, viewCounts } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const MODE = opt('--mode', 'math1');
const GAMES = Number(opt('--games', MODE === 'math1' ? 300 : 200));
const SEED = Number(opt('--seed', 9000));
const rules = createRules(makeConfig({ mode: MODE }));
const lineup = ['speed', 'value', 'closed', 'speed'];

// 鳴いた他家が最後に完成させる面子（役が必要）
const cache = new Map();
function valid(ex) {
  if (!ex.length) return null;
  const key = ex.slice().sort((a, b) => a - b).join(',');
  if (cache.has(key)) return cache.get(key);
  const set = new Set();
  const M = rules.melds.length;
  for (let m = 0; m < M; m++) {
    if (ex.length >= 2) { if (rules.evaluateMelds([...ex, m], false).hasYaku) set.add(m); } else for (let x = 0; x < M; x++) if (rules.evaluateMelds([...ex, m, x], false).hasYaku) { set.add(m); break; }
  }
  cache.set(key, set);
  return set;
}

const danger = []; // [特徴量…, 正解]
const win = [];
for (let i = 0; i < GAMES; i++) {
  const pers = lineup.map((_, k) => lineup[(k + i) % 4]);
  const g = new Game({ rules, seed: SEED + i, dealer: i % 4, players: pers.map((p) => ({ kind: 'ai', personality: p })) });
  const rng = createRng(i);
  const pend = [];
  while (g.pending()) {
    const p = g.pending();
    if (p.type !== 'turn' || p.canTsumo) { applyAction(g, p.seat, decide(g, p.seat, pers[p.seat], rng)); continue; }
    const s = p.seat;
    const view = g.viewFor(s);
    const unseen = unseenCounts(rules, view);
    const U = unseen.reduce((a, b) => a + b, 0);
    const types = [...new Set(view.hand.map((h) => h.type))];
    for (let k = 1; k < 4; k++) {
      const o = (s + k) % 4;
      const ex = view.melds[o].map((m) => m.meld);
      const V = valid(ex);
      const hs = view.handCounts[o];
      const turns = view.rivers[o].length + view.melds[o].length;
      for (const t of types) {
        const id = view.hand.find((h) => h.type === t).id;
        let w = 0;
        for (const mi of rules.meldsByTile[t]) {
          if (V && !V.has(mi)) continue;
          const need = new Map();
          let sk = false;
          for (const x of rules.melds[mi].tiles) { if (x === t && !sk) { sk = true; continue; } need.set(x, (need.get(x) || 0) + 1); }
          let q = 1;
          for (const [x, n] of need) for (let j = 0; j < n; j++) q *= (Math.max(0, unseen[x] - j) * hs) / U / (j + 1);
          w += q;
        }
        danger.push([1, Math.log(w + 1e-3), turns, ex.length === 1 ? 1 : 0, ex.length >= 2 ? 1 : 0, view.rivers[o].includes(t) ? 1 : 0, Math.min(turns, 12) ** 2 / 10, w > 0 ? 1 : 0, g.ronAnalysis(o, id) ? 1 : 0]);
      }
    }
    const a = decide(g, s, pers[s], rng);
    const counts = viewCounts(rules, view);
    counts[g.typeOf(a.tile)]--;
    const ex = view.melds[s].map((m) => m.meld);
    pend.push([s, Math.max(-12, Math.log(handValue(rules, counts, ex, unseen, 'speed') + 1e-9)), view.wallCount, ex.length]);
    applyAction(g, s, a);
  }
  const r = g.result;
  for (const [s, lv, wall, ex] of pend) win.push([1, lv, wall, ex, r.type === 'win' && r.winner === s ? 1 : 0]);
}

// 標準化したロジスティック回帰（勾配降下）。係数は元の尺度に戻して返す。
function fit(rows, iters = 3000, lr = 0.5) {
  const d = rows[0].length - 1;
  const n = rows.length;
  const mu = new Array(d).fill(0);
  const sd = new Array(d).fill(0);
  for (const r of rows) for (let j = 1; j < d; j++) mu[j] += r[j] / n;
  for (const r of rows) for (let j = 1; j < d; j++) sd[j] += (r[j] - mu[j]) ** 2 / n;
  for (let j = 1; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  sd[0] = 1;
  const b = new Array(d).fill(0);
  const z = rows.map((r) => r.slice(0, d).map((x, j) => (j === 0 ? 1 : (x - mu[j]) / sd[j])));
  for (let it = 0; it < iters; it++) {
    const gr = new Array(d).fill(0);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < d; j++) s += z[i][j] * b[j];
      const e = 1 / (1 + Math.exp(-s)) - rows[i][d];
      for (let j = 0; j < d; j++) gr[j] += (e * z[i][j]) / n;
    }
    for (let j = 0; j < d; j++) b[j] -= lr * gr[j];
  }
  const raw = b.map((x, j) => x / sd[j]);
  raw[0] = b[0] - b.slice(1).reduce((s, x, j) => s + (x / sd[j + 1]) * mu[j + 1], 0);
  return raw.map((x) => +x.toFixed(3));
}
function auc(rows, coef) {
  const d = coef.length;
  const sc = rows.map((r) => [r.slice(0, d).reduce((s, x, j) => s + x * coef[j], 0), r[d]]).sort((a, b) => a[0] - b[0]);
  let pos = 0;
  let rankSum = 0;
  sc.forEach(([, y], i) => { if (y) { pos++; rankSum += i; } });
  const neg = sc.length - pos;
  return +((rankSum - (pos * (pos - 1)) / 2) / (pos * neg)).toFixed(3);
}
const dc = fit(danger);
const wc = fit(win);
console.log(JSON.stringify({
  mode: MODE, games: GAMES, seed: SEED,
  danger: { rows: danger.length, ronRate: +(danger.filter((r) => r[8]).length / danger.length).toFixed(4), coef: dc, auc: auc(danger, dc), features: '[定数, log(w+0.001), turns, melds=1, melds=2, inRiver, min(turns,12)^2/10, w>0]' },
  win: { rows: win.length, winRate: +(win.filter((r) => r[4]).length / win.length).toFixed(3), coef: wc, auc: auc(win, wc), features: '[定数, log(手の価値), 山の残り, 鳴いた回数]' },
}, null, 1));
