// 試合（4局戦・8局戦）の AI 自動対戦（Ver.0.4-A）。親の連荘・親子の精算・最終順位の統計。
// 使い方: node tools/simulate-match.mjs --matches 200 --length 4|8 [--mode math1|math2] [--seed 1]
// 1局の進行は tools/simulate.mjs と同じ Game・AI（4人とも AI、性格は試合ごとに席を回す）。
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { createMatch, applyRoundResult, dealerOf, ranks, START_POINTS } from '../src/engine/match.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const MATCHES = Number(opt('--matches', 200));
const LENGTH = Number(opt('--length', 4));
const MODE = opt('--mode', 'math1');
const SEED = Number(opt('--seed', 1));
const rules = createRules(makeConfig({ mode: MODE }));
const lineup = ['speed', 'value', 'closed', 'speed'];

const t0 = Date.now();
const finals = [];
const played = [];
const renchan = [];
const st = { rounds: 0, dealerWins: 0, childWins: 0, draws: 0, ron: 0, tsumo: 0, negativeEnd: 0, negativeAny: 0, maxRenchanRun: 0, extended: 0 };
const byPers = {};
for (let k = 0; k < MATCHES; k++) {
  const pers = lineup.map((_, s) => lineup[(s + k) % 4]);
  let m = createMatch({ length: LENGTH });
  let n = 0;
  let neg = false;
  const seedBase = SEED * 1000003 + k * 7777;
  while (!m.over) {
    n++;
    const seed = seedBase + n * 7919;
    const dealer = dealerOf(m);
    const g = new Game({ rules, seed, dealer, players: pers.map((p) => ({ kind: 'ai', personality: p })) });
    const rng = createRng(seed ^ 0x5bd1e995);
    while (g.pending()) { const p = g.pending(); applyAction(g, p.seat, decide(g, p.seat, pers[p.seat], rng)); }
    const r = g.result;
    st.rounds++;
    if (r.type === 'draw') st.draws++;
    else { st[r.how]++; if (r.winner === dealer) st.dealerWins++; else st.childWins++; }
    const wasLast = m.hand === LENGTH - 1;
    m = applyRoundResult(m, r);
    if (wasLast && !m.over) st.extended++;
    st.maxRenchanRun = Math.max(st.maxRenchanRun, m.renchan);
    if (m.scores.some((x) => x < 0)) neg = true;
    if (m.scores.reduce((a, b) => a + b, 0) !== 4 * START_POINTS) throw new Error('total changed');
  }
  played.push(m.played);
  renchan.push(m.renchanTotal);
  if (m.scores.some((x) => x < 0)) st.negativeEnd++;
  if (neg) st.negativeAny++;
  const rk = ranks(m.scores);
  for (let s = 0; s < 4; s++) {
    finals.push(m.scores[s]);
    const b = (byPers[pers[s]] = byPers[pers[s]] || { seats: 0, rankSum: 0, top: 0, scoreSum: 0 });
    b.seats++; b.rankSum += rk[s]; b.scoreSum += m.scores[s]; if (rk[s] === 1) b.top++;
  }
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const mu = mean(a); return Math.sqrt(mean(a.map((x) => (x - mu) ** 2))); };
const pct = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
const hist = (a) => a.reduce((h, x) => { h[x] = (h[x] || 0) + 1; return h; }, {});
console.log(JSON.stringify({
  mode: MODE, length: LENGTH, matches: MATCHES, seconds: (Date.now() - t0) / 1000,
  meanRounds: +mean(played).toFixed(2), roundsHist: hist(played),
  meanRenchan: +mean(renchan).toFixed(2), renchanRate: +(mean(renchan) / mean(played)).toFixed(3),
  extendedFinal: st.extended, maxRenchanInOneDealerTurn: st.maxRenchanRun,
  rounds: st.rounds, dealerWinRate: +(st.dealerWins / st.rounds).toFixed(3), childWinRate: +(st.childWins / st.rounds).toFixed(3), drawRate: +(st.draws / st.rounds).toFixed(3),
  ronRate: +(st.ron / st.rounds).toFixed(3), tsumoRate: +(st.tsumo / st.rounds).toFixed(3),
  finalScore: { mean: +mean(finals).toFixed(1), sd: +sd(finals).toFixed(1), min: Math.min(...finals), p10: pct(finals, 0.1), p50: pct(finals, 0.5), p90: pct(finals, 0.9), max: Math.max(...finals) },
  matchesEndingWithNegative: st.negativeEnd, matchesWithNegativeAtSomePoint: st.negativeAny,
  byPersonality: Object.fromEntries(Object.entries(byPers).map(([p, b]) => [p, { meanRank: +(b.rankSum / b.seats).toFixed(2), topRate: +(b.top / b.seats).toFixed(3), meanScore: +(b.scoreSum / b.seats).toFixed(1) }])),
}, null, 1));
