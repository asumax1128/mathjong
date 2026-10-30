// ルールの版ごとの AI 対局（12人のキャラクター、4局戦の試合を最後まで）。現行の新ルール（ruleset 2）の健全性と統計。
// 使い方: node tools/simulate-ruleset.mjs [--matches 60] [--mode math1|math2] [--ruleset 2] [--seed 1]
// 確認：合法手だけで進む（エンジンが拒否すれば例外）、毎手の保存則（王牌14枚を含む）、合計400点、フリテン中にロンの選択肢がない、
// 関数牌のポンの選択肢がない、数学Ⅱの通常ツモ24回。統計：和了（ロン・ツモ）、流局（山・24回）、フリテンでロンできなかった回数など。
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { applyAction } from '../src/engine/ai.js';
import { decideCharacter, CHARACTER_ROSTER, newPublicHistory, recordPublicRound } from '../src/engine/characters.js';
import { createMatch, applyRoundResult, dealerOf } from '../src/engine/match.js';
import { matchInfo } from '../src/engine/ai-levels.js';
import { createRng } from '../src/engine/rng.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const MATCHES = Number(opt('--matches', 60));
const MODE = opt('--mode', 'math2');
const RULESET = Number(opt('--ruleset', 2));
const SEED = Number(opt('--seed', 1));
const rules = createRules(makeConfig({ mode: MODE }));
const ids = Object.values(CHARACTER_ROSTER).flat().map((c) => c.id);
const players = [0, 1, 2, 3].map((s) => ({ name: 'P' + s, kind: 'ai', personality: 'speed' }));
const st = { matches: 0, rounds: 0, win: 0, ron: 0, tsumo: 0, drawWall: 0, drawCap: 0, furitenBlocked: 0, ronOffered: 0, ronPassed: 0, riichi: 0,
  pon: 0, funcPonOffered: 0, chi: 0, ankan: 0, doraBonus: 0, winsBy: {}, roundsBy: {}, maxDraws: 0 };
const t0 = Date.now();
for (let mi = 0; mi < MATCHES; mi++) {
  const seats = [0, 1, 2].map((k) => ids[(mi * 5 + k * 4 + (mi >> 2)) % 12]);
  if (new Set(seats).size < 3) seats[2] = ids[(ids.indexOf(seats[2]) + 1) % 12];
  const lineup = [ids[(mi * 7 + 3) % 12], ...seats].map((id, s, a) => (a.indexOf(id) !== s ? ids[(ids.indexOf(id) + 6) % 12] : id));
  let match = createMatch({ length: 4 });
  let history = newPublicHistory();
  const rng = createRng(SEED * 1000 + mi);
  for (let r = 1; !match.over && r <= 12; r++) {
    const g = new Game({ rules, seed: SEED * 7919 + mi * 31 + r, dealer: dealerOf(match), players, ruleset: RULESET });
    const info = { ...matchInfo(match), publicHistory: history };
    for (let i = 0; g.pending(); i++) {
      if (i > 3000) throw new Error('no progress');
      const p = g.pending();
      if (p.type === 'claim') {
        if (p.ron) { st.ronOffered++; if (g.furitenOf(p.seat).furiten) throw new Error('ron offered in furiten'); }
        if (p.pon && rules.types[g.typeOf(g.claim.tile)].kind === 'func' && g.funcPonBan) throw new Error('function pon offered');
        if (p.pon && rules.types[g.typeOf(g.claim.tile)].kind === 'func') st.funcPonOffered++;
      }
      const before = g.ronBlocked ? g.ronBlocked.map((b) => b && b.at) : null;
      const a = decideCharacter(g, p.seat, lineup[p.seat], rng, info, lineup.slice(1));
      if (p.type === 'claim' && p.ron && a.type !== 'ron') st.ronPassed++;
      applyAction(g, p.seat, a);
      if (before) st.furitenBlocked += g.ronBlocked.filter((b, s) => b && b.at !== before[s]).length;
      g.checkInvariants();
    }
    const ev = g.events;
    st.pon += ev.filter((e) => e.type === 'pon').length; st.chi += ev.filter((e) => e.type === 'chi').length;
    st.ankan += ev.filter((e) => e.type === 'ankan').length; st.riichi += ev.filter((e) => e.type === 'riichi').length;
    st.maxDraws = Math.max(st.maxDraws, ...g.normalDraws);
    if (MODE === 'math2' && RULESET >= 1 && Math.max(...g.normalDraws) > 24) throw new Error('draw cap');
    if (g.result.type === 'win') {
      st.win++; st[g.result.how]++;
      st.doraBonus += g.result.analysis.doraBonus || 0;
      const id = lineup[g.result.winner]; st.winsBy[id] = (st.winsBy[id] || 0) + 1;
    } else if (g.wall.length > 0) st.drawCap++; else st.drawWall++;
    for (const id of lineup) st.roundsBy[id] = (st.roundsBy[id] || 0) + 1;
    history = recordPublicRound(history, g.events, g.riichi);
    match = applyRoundResult(match, g.result);
    if (match.scores.reduce((a, b) => a + b, 0) !== 400) throw new Error('total points');
    st.rounds++;
  }
  st.matches++;
}
const pct = (x) => `${((100 * x) / st.rounds).toFixed(1)}%`;
console.log(JSON.stringify({
  mode: MODE, ruleset: RULESET, matches: st.matches, rounds: st.rounds, seconds: (Date.now() - t0) / 1000,
  win: pct(st.win), ron: st.ron, tsumo: st.tsumo, drawWall: st.drawWall, drawCap: st.drawCap,
  ronOffered: st.ronOffered, ronPassed: st.ronPassed, furitenBlocked: st.furitenBlocked, riichi: st.riichi,
  pon: st.pon, funcPonOffered: st.funcPonOffered, chi: st.chi, ankan: st.ankan, avgDoraBonus: +(st.doraBonus / Math.max(1, st.win)).toFixed(2), maxNormalDraws: st.maxDraws,
  winRateBy: Object.fromEntries(ids.map((id) => [id, st.roundsBy[id] ? +(st.winsBy[id] || 0) / st.roundsBy[id] : null]).map(([k, v]) => [k, v === null ? null : +v.toFixed(3)])),
}));
