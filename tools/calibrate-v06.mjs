// Ver.0.6 上級キャラの放銃の見込み（危険度）の当てはめ。キャラAI（中級・上級の混合）の対局を記録し、ロジスティック回帰で係数を求める。
//   node tools/calibrate-v06.mjs --mode math1 --matches 120 --seed 50001
// 正解（その他家がその牌でロンできたか）を作るときだけ他家の実際の手牌を使う。特徴量はすべて公開情報（手牌・河・公開面子・
// リーチ・公開された打牌の順序）。出力の係数を src/engine/character-ai.js の DANGER_COEF_V06 に転記する。
// 「通った牌」（passedTiles）はロンの可能性がない（AI は宣言できるロンを必ずする）ので回帰には含めず、危険度 0 として扱う。
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { applyAction, unseenCounts } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { createMatch, applyRoundResult, dealerOf } from '../src/engine/match.js';
import { decideCharacter, dangerFeaturesV06, passedTiles, riichiDiscardCounts } from '../src/engine/character-ai.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const MODE = opt('--mode', 'math1');
const MATCHES = Number(opt('--matches', 120));
const SEED = Number(opt('--seed', 50001));
const rules = createRules(makeConfig({ mode: MODE }));
const LINEUPS = [
  ['fukuyama', 'kaoru', 'asuma', 'ousuke'], ['ousuke', 'natsuki', 'yuki', 'fukuyama'],
  ['kaoru', 'natsuki', 'asuma', 'yuki'], ['ousuke', 'natsuki', 'yuki', 'kaoru'],
];
const rows = [];
let passedRows = 0, passedRons = 0;
for (let i = 0; i < MATCHES; i++) {
  const base = LINEUPS[i % LINEUPS.length];
  const seats = base.map((_, s) => base[(s + i) % 4]);
  let m = createMatch({ length: 4 });
  let round = 0;
  while (!m.over) {
    round++;
    const gs = (SEED * 7907 + i * 104729 + round * 7919) >>> 0;
    const g = new Game({ rules, seed: gs, dealer: dealerOf(m), players: seats.map((id) => ({ name: id, kind: 'ai', personality: 'speed' })) });
    const rng = createRng((gs ^ 0x5bd1e995) >>> 0);
    const info = { scores: m.scores.slice(), hand: m.hand, length: m.length, dealer: dealerOf(m), renchan: m.renchan };
    while (g.pending()) {
      const p = g.pending();
      if (p.type === 'turn' && !p.canTsumo && !g.riichi[p.seat]) {
        const s = p.seat;
        const view = g.viewFor(s);
        const unseen = unseenCounts(rules, view);
        const passed = passedTiles(g, s);
        const rdc = riichiDiscardCounts(g);
        const types = [...new Set(view.hand.map((h) => h.type))];
        for (let k = 1; k < 4; k++) {
          const o = (s + k) % 4;
          const feats = dangerFeaturesV06(rules, view, unseen, o, rdc);
          for (const t of types) {
            const id = view.hand.find((h) => h.type === t).id;
            const y = g.ronAnalysis(o, id) ? 1 : 0;
            if (passed[o].has(t)) { passedRows++; passedRons += y; continue; }
            rows.push([...feats[t], y]);
          }
        }
      }
      applyAction(g, p.seat, decideCharacter(g, p.seat, seats[p.seat], rng, info, seats));
    }
    m = applyRoundResult(m, g.result);
  }
}

function fit(data, iters = 4000, lr = 0.5) {
  const d = data[0].length - 1, n = data.length;
  const mu = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const r of data) for (let j = 1; j < d; j++) mu[j] += r[j] / n;
  for (const r of data) for (let j = 1; j < d; j++) sd[j] += (r[j] - mu[j]) ** 2 / n;
  for (let j = 1; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  sd[0] = 1;
  const b = new Array(d).fill(0);
  const z = data.map((r) => r.slice(0, d).map((x, j) => (j === 0 ? 1 : (x - mu[j]) / sd[j])));
  for (let it = 0; it < iters; it++) {
    const gr = new Array(d).fill(0);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < d; j++) s += z[i][j] * b[j];
      const e = 1 / (1 + Math.exp(-s)) - data[i][d];
      for (let j = 0; j < d; j++) gr[j] += (e * z[i][j]) / n;
    }
    for (let j = 0; j < d; j++) b[j] -= lr * gr[j];
  }
  const raw = b.map((x, j) => x / sd[j]);
  raw[0] = b[0] - b.slice(1).reduce((s, x, j) => s + (x / sd[j + 1]) * mu[j + 1], 0);
  return raw.map((x) => +x.toFixed(3));
}
function auc(data, coef) {
  const d = coef.length;
  const sc = data.map((r) => [r.slice(0, d).reduce((s, x, j) => s + x * coef[j], 0), r[d]]).sort((a, b) => a[0] - b[0]);
  let pos = 0, rankSum = 0;
  sc.forEach(([, y], i) => { if (y) { pos++; rankSum += i; } });
  const neg = sc.length - pos;
  return +((rankSum - (pos * (pos - 1)) / 2) / (pos * neg)).toFixed(4);
}
const coef = fit(rows);
console.log(JSON.stringify({ mode: MODE, matches: MATCHES, seed: SEED, rows: rows.length, ronRate: +(rows.filter((r) => r.at(-1)).length / rows.length).toFixed(4),
  passedRows, passedRons, coef, auc: auc(rows, coef) }));
