// Ver.0.6 全9キャラクター vs 同難易度の旧AI：実験専用。main/UIに未接続。
// node tools/simulate-characters-all.mjs --mode math1 --groups 3 --seed 1 --length 4
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { CHARACTER_ROSTER, decideCharacter } from '../src/engine/character-ai.js';
import { createRng } from '../src/engine/rng.js';
import { createMatch, applyRoundResult, dealerOf, ranks, START_POINTS } from '../src/engine/match.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const mode = opt('--mode', 'math1');
const groups = Number(opt('--groups', 2));
const seed0 = Number(opt('--seed', 1));
const length = Number(opt('--length', 4));
if (!['math1', 'math2'].includes(mode) || !Number.isInteger(groups) || groups < 1 ||
  groups > 1000 || !Number.isInteger(seed0) || ![4, 8].includes(length)) throw new Error('bad CLI options');
const rules = createRules(makeConfig({ mode }));
const start = Date.now();
const empty = () => ({
  matches: 0, rank: 0, first: 0, fourth: 0, score: 0, wins: 0, ron: 0, tsumo: 0,
  dealIn: 0, chi: 0, pon: 0, riichi: 0, discard: 0, sinDiscard: 0,
  opponentRon: {}, min: Infinity, max: -Infinity,
});
const rnd = (x) => +x.toFixed(3);
const records = {};
for (const [level, roster] of Object.entries(CHARACTER_ROSTER)) {
  const ids = roster.map((x) => x.id);
  const personalities = Object.fromEntries(roster.map((x) => [x.id, x.personality]));
  const chars = [...ids, 'control'];
  personalities.control = 'speed';
  const perScenario = Object.fromEntries(['baseline', 'candidate'].map((a) =>
    [a, Object.fromEntries(chars.map((id) => [id, empty()]))]));
  const diffs = Object.fromEntries(ids.map((id) => [id, []]));
  const play = (scenario, seats, seedBase) => {
    let match = createMatch({ length });
    const local = {};
    let round = 0;
    while (!match.over) {
      round++;
      if (round > 100) throw new Error('round cap exceeded');
      const gameSeed = seedBase + round * 7919;
      const g = new Game({ rules, seed: gameSeed, dealer: dealerOf(match),
        players: seats.map((id) => ({ name: id, kind: 'ai', personality: personalities[id] })) });
      const rng = createRng(gameSeed ^ 0x5bd1e995);
      let n = 0;
      while (g.pending()) {
        const p = g.pending(), id = seats[p.seat];
        const action = scenario === 'candidate' && id !== 'control'
          ? decideCharacter(g, p.seat, id, rng,
            { scores: match.scores, dealer: dealerOf(match), hand: match.hand,
              length: match.length, renchan: match.renchan }, seats)
          : decide(g, p.seat, personalities[id], rng, level);
        if (action.type === 'discard') {
          perScenario[scenario][id].discard++;
          if (rules.types[g.typeOf(action.tile)].key === 'f:sin') perScenario[scenario][id].sinDiscard++;
        }
        if (action.riichi) perScenario[scenario][id].riichi++;
        applyAction(g, p.seat, action);
        if (++n > 3000) throw new Error('decision cap exceeded');
      }
      g.checkInvariants();
      for (const ev of g.events) {
        if (ev.type === 'chi' || ev.type === 'pon') perScenario[scenario][seats[ev.seat]][ev.type]++;
      }
      const result = g.result;
      if (result.type === 'win') {
        const w = perScenario[scenario][seats[result.winner]];
        w.wins++;
        w[result.how]++;
        if (result.how === 'ron') {
          const fromId = seats[result.from];
          perScenario[scenario][fromId].dealIn++;
          if (w.opponentRon[fromId] === undefined) w.opponentRon[fromId] = 0;
          w.opponentRon[fromId]++;
        }
      }
      match = applyRoundResult(match, result);
      if (match.scores.reduce((a,b) => a+b, 0) !== 4*START_POINTS) throw new Error('points not conserved');
    }
    const finalRanks = ranks(match.scores);
    seats.forEach((id, seat) => {
      const st = perScenario[scenario][id];
      st.matches++;
      st.rank += finalRanks[seat];
      st.score += match.scores[seat];
      st.min = Math.min(st.min, match.scores[seat]);
      st.max = Math.max(st.max, match.scores[seat]);
      if (finalRanks[seat] === 1) st.first++;
      if (finalRanks[seat] === 4) st.fourth++;
      local[id] = { rank: finalRanks[seat], score: match.scores[seat] };
    });
    return local;
  };
  for (let k = 0; k < groups; k++) {
    const acc = Object.fromEntries(ids.map((id) => [id, { rank: 0, score: 0 }]));
    for (let rotation = 0; rotation < 4; rotation++) {
      const seats = chars.map((_, s) => chars[(s + rotation) % 4]);
      const seedBase = seed0*1000003 + k*7777 + rotation*97 + Object.keys(CHARACTER_ROSTER).indexOf(level)*131;
      const base = play('baseline', seats, seedBase);
      const cand = play('candidate', seats, seedBase);
      for (const id of ids) {
        acc[id].rank += (cand[id].rank - base[id].rank) / 4;
        acc[id].score += (cand[id].score - base[id].score) / 4;
      }
    }
    for (const id of ids) diffs[id].push(acc[id]);
  }
  const report = (s) => ({
    n: s.matches, meanRank: rnd(s.rank / s.matches),
    firstRate: rnd(s.first / s.matches), fourthRate: rnd(s.fourth / s.matches),
    meanPoints: rnd(s.score / s.matches),
    winsPerMatch: rnd(s.wins / s.matches), dealInPerMatch: rnd(s.dealIn / s.matches),
    chiPerMatch: rnd(s.chi / s.matches), ponPerMatch: rnd(s.pon / s.matches),
    sinDiscardRate: s.discard ? rnd(s.sinDiscard / s.discard) : null,
    riichiPerMatch: rnd(s.riichi / s.matches),
    minPoints: s.min, maxPoints: s.max,
    opponentRon: s.opponentRon,
  });
  records[level] = {
    baseline: Object.fromEntries(chars.map((id) => [id, report(perScenario.baseline[id])])),
    candidate: Object.fromEntries(chars.map((id) => [id, report(perScenario.candidate[id])])),
    pairedDelta: Object.fromEntries(ids.map((id) => {
      const avg = (type) => diffs[id].reduce((sum, r) => sum + r[type], 0) / groups;
      return [id, { rank: rnd(avg('rank')), points: rnd(avg('score')) }];
    })),
  };
}
console.log(JSON.stringify({
  disclaimer: '実験結果。小標本では優劣を断定できない。main未接続、同seed・4席ローテーション。',
  mode, groups, length, seed: seed0,
  matchesPerLevelPerScenario: 4*groups,
  seconds: rnd((Date.now()-start)/1000), records,
}, null, 2));
