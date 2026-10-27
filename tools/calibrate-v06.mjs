// Ver.0.6 上級キャラの放銃の見込み（危険度）の当てはめと評価。キャラAI（中級・上級の混合）の対局を記録し、ロジスティック回帰で係数を求める。
//   当てはめ（学習データ内の評価つき）：
//     node tools/calibrate-v06.mjs --mode math1 --matches 160 --seed 50001
//   当てはめ＋独立した seed での評価：
//     node tools/calibrate-v06.mjs --mode math1 --matches 160 --seed 50001 --eval-seed 60001 --eval-matches 80
//   実行時の係数（DANGER_COEF_V06）を当てはめずに、独立した seed だけで評価：
//     node tools/calibrate-v06.mjs --mode math1 --evaluate-current --eval-seed 60001 --eval-matches 80
//   --tune '{...}'：対局を作るキャラの判断係数を、この実行だけ上書きする（tools/sim-v06.mjs と同じ）。
//     DANGER_COEF_V06 は、上級3人の最終係数を入れる前の既定値（docs/28 の BEFORE）で作った対局から当てはめた。
// 正解（その他家がその牌でロンできたか）を作るときだけ他家の実際の手牌を使う。特徴量はすべて公開情報（手牌・河・公開面子・
// リーチ・公開された打牌の順序）。出力の係数を src/engine/character-ai.js の DANGER_COEF_V06 に転記する。
// 「通った牌」（passedTiles）はロンの可能性がない（AI は宣言できるロンを必ずする。対局は全員 AI）ので回帰にも評価にも含めず、
// 件数とロン数を別に数える。
// AUC は同点の予測値を 0.5 として数える（平均順位）。入力の行の順序には依存しない。
// 学習データ内の AUC（train）と、当てはめに使っていない seed での AUC（eval）を分けて出力する。Brier score と確率帯ごとの
// 予測・実測も出す。
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { applyAction, unseenCounts } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { createMatch, applyRoundResult, dealerOf } from '../src/engine/match.js';
import { decideCharacter, dangerFeaturesV06, passedTiles, riichiDiscardCounts, DANGER_COEF_V06 } from '../src/engine/character-ai.js';
import { applyTune } from './sim-v06.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINEUPS = [
  ['fukuyama', 'kaoru', 'asuma', 'ousuke'], ['ousuke', 'natsuki', 'yuki', 'fukuyama'],
  ['kaoru', 'natsuki', 'asuma', 'yuki'], ['ousuke', 'natsuki', 'yuki', 'kaoru'],
];

// 対局を回し、[特徴量..., 正解] の行を集める
export function collectRows({ mode, matches, seed }) {
  const rules = createRules(makeConfig({ mode }));
  const rows = [];
  let passedRows = 0, passedRons = 0;
  for (let i = 0; i < matches; i++) {
    const base = LINEUPS[i % LINEUPS.length];
    const seats = base.map((_, s) => base[(s + i) % 4]);
    let m = createMatch({ length: 4 });
    let round = 0;
    while (!m.over) {
      round++;
      const gs = (seed * 7907 + i * 104729 + round * 7919) >>> 0;
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
  return { rows, passedRows, passedRons };
}

export function fit(data, iters = 4000, lr = 0.5) {
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

const sigmoid = (x) => 1 / (1 + Math.exp(-x));
export const predict = (row, coef) => sigmoid(coef.reduce((s, c, j) => s + c * row[j], 0));

// AUC（Mann–Whitney）。scores[i] と labels[i]（0/1）。同点の予測値は平均順位を使う（正例と負例の同点は 0.5 として数える）。
export function aucOf(scores, labels) {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  const rank = new Float64Array(scores.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const avg = (i + j) / 2 + 1; // 1 始まりの平均順位
    for (let k = i; k <= j; k++) rank[idx[k]] = avg;
    i = j + 1;
  }
  let pos = 0, rankSum = 0;
  labels.forEach((y, i) => { if (y) { pos++; rankSum += rank[i]; } });
  const neg = labels.length - pos;
  if (!pos || !neg) return null;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

// 確率帯ごとの予測の平均・実測の割合
const BINS = [0, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1.0000001];
export function evaluate(rows, coef) {
  const d = coef.length;
  const p = rows.map((r) => predict(r, coef));
  const y = rows.map((r) => r[d]);
  const brier = p.reduce((s, x, i) => s + (x - y[i]) ** 2, 0) / rows.length;
  const base = y.reduce((a, b) => a + b, 0) / rows.length;
  const brierRef = y.reduce((s, v) => s + (base - v) ** 2, 0) / rows.length; // 一定の確率（基準率）だけの Brier
  const bins = [];
  for (let k = 0; k < BINS.length - 1; k++) {
    const sel = p.map((x, i) => i).filter((i) => p[i] >= BINS[k] && p[i] < BINS[k + 1]);
    if (!sel.length) continue;
    bins.push({ range: `${BINS[k]}–${Math.min(1, BINS[k + 1])}`, n: sel.length, predicted: +(sel.reduce((s, i) => s + p[i], 0) / sel.length).toFixed(4), observed: +(sel.reduce((s, i) => s + y[i], 0) / sel.length).toFixed(4) });
  }
  return { rows: rows.length, ronRate: +base.toFixed(4), auc: +aucOf(p, y).toFixed(4), brier: +brier.toFixed(5), brierBaseline: +brierRef.toFixed(5), bins };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const MODE = opt('--mode', 'math1');
  const MATCHES = Number(opt('--matches', 120));
  const SEED = Number(opt('--seed', 50001));
  const EVAL_SEED = opt('--eval-seed', null);
  const EVAL_MATCHES = Number(opt('--eval-matches', 60));
  const current = args.includes('--evaluate-current');
  const tune = JSON.parse(opt('--tune', '{}'));
  applyTune(tune);
  const out = { mode: MODE, tune };
  let coef;
  if (current) {
    coef = DANGER_COEF_V06[MODE];
    out.coef = coef;
    out.coefSource = 'DANGER_COEF_V06（実行時の係数。当てはめはしない）';
  } else {
    const tr = collectRows({ mode: MODE, matches: MATCHES, seed: SEED });
    coef = fit(tr.rows);
    out.coef = coef;
    out.train = { seed: SEED, matches: MATCHES, passedRows: tr.passedRows, passedRons: tr.passedRons, ...evaluate(tr.rows, coef), note: '学習データ内（当てはめに使った行）での評価。独立評価ではない' };
  }
  if (EVAL_SEED !== null) {
    if (!current && Number(EVAL_SEED) === SEED) throw new Error('--eval-seed は当てはめの --seed と別の値にする');
    const ev = collectRows({ mode: MODE, matches: EVAL_MATCHES, seed: Number(EVAL_SEED) });
    out.eval = { seed: Number(EVAL_SEED), matches: EVAL_MATCHES, passedRows: ev.passedRows, passedRons: ev.passedRons, ...evaluate(ev.rows, coef), note: '当てはめに使っていない seed での独立評価' };
  }
  console.log(JSON.stringify(out, null, 1));
}
