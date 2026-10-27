// 数雀 Ver.0.6 / 初級キャラ試作の比較実験。公開版のAIは変更しない。
// 同一seedで従来初級（baseline）とキャラ仮AI（candidate）を試合ごとに比較。
// 席を4方向にローテーション。先に捨て牌が変われば以降の局面も変わるので同じseedは完全な同局面ではない。
// Usage: node tools/simulate-characters.mjs --mode math1 --groups 10 --seed 1 --length 4
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { decideBeginnerCharacter } from '../src/engine/character-ai-prototype.js';
import { createRng } from '../src/engine/rng.js';
import { createMatch, applyRoundResult, dealerOf, ranks, START_POINTS } from '../src/engine/match.js';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : argv[i + 1]; };
const mode = opt('--mode', 'math1');
const groups = Number(opt('--groups', 10));
const seed = Number(opt('--seed', 1));
const length = Number(opt('--length', 4));
if (!['math1', 'math2'].includes(mode) || !Number.isInteger(groups) || groups < 1 ||
    groups > 10000 || !Number.isInteger(seed) || ![4, 8].includes(length)) {
  throw new Error('invalid --mode math1|math2 --groups 1..10000 --seed integer --length 4|8');
}
const rules = createRules(makeConfig({ mode }));
const ids = ['kanata', 'mitsuki', 'aoto', 'baseline'];
const pers = { kanata: 'speed', mitsuki: 'value', aoto: 'closed', baseline: 'speed' };
const empty = () => ({
  matches: 0, rankSum: 0, first: 0, fourth: 0, pointSum: 0,
  wins: 0, ron: 0, tsumo: 0, dealIn: 0,
  chi: 0, pon: 0, callsAttempted: 0, turns: 0, discards: 0,
  sinDiscards: 0, sinCallMelds: 0, riichi: 0,
});
const all = { baseline: Object.fromEntries(ids.map((id) => [id, empty()])),
  candidate: Object.fromEntries(ids.map((id) => [id, empty()])) };
const paired = [];
const runMatch = (scenario, seats, wallSeed) => {
  let m = createMatch({ length });
  let round = 0;
  const stats = all[scenario];
  const local = Object.fromEntries(ids.map((id) => [id, { rank: 0, score: 0 }]));
  while (!m.over) {
    round++;
    if (round > 100) throw new Error('round limit exceeded: ' + wallSeed);
    const gameSeed = wallSeed + round * 7919;
    const game = new Game({
      rules, seed: gameSeed, dealer: dealerOf(m),
      players: seats.map((id) => ({ name: id, kind: 'ai', personality: pers[id] })),
    });
    const rng = createRng(gameSeed ^ 0x5bd1e995);
    let steps = 0;
    while (game.pending()) {
      const p = game.pending();
      const id = seats[p.seat];
      const action = scenario === 'candidate' && id !== 'baseline'
        ? decideBeginnerCharacter(game, p.seat, id, rng, { seatIds: seats })
        : decide(game, p.seat, pers[id], rng, 'beginner');
      const st = stats[id];
      if (action.type === 'discard') {
        st.discards++;
        if (rules.types[game.typeOf(action.tile)].key === 'f:sin') st.sinDiscards++;
      }
      if (action.type === 'chi' || action.type === 'pon') st.callsAttempted++;
      if (action.riichi) st.riichi++;
      if (p.type === 'turn') st.turns++;
      applyAction(game, p.seat, action);
      if (++steps > 3000) throw new Error('no progress: ' + gameSeed);
    }
    game.checkInvariants();
    for (const e of game.events) {
      if (e.type !== 'chi' && e.type !== 'pon') continue;
      const st = stats[seats[e.seat]];
      st[e.type]++;
      if (rules.melds[e.meld]?.fn === 'sin') st.sinCallMelds++;
    }
    if (game.result.type === 'win') {
      const r = game.result;
      const st = stats[seats[r.winner]];
      st.wins++;
      st[r.how]++;
      if (r.how === 'ron') stats[seats[r.from]].dealIn++;
    }
    m = applyRoundResult(m, game.result);
    if (m.scores.reduce((a, b) => a + b, 0) !== 4 * START_POINTS) {
      throw new Error('score sum changed');
    }
  }
  const r = ranks(m.scores);
  seats.forEach((id, s) => {
    const st = stats[id];
    st.matches++;
    st.rankSum += r[s];
    st.pointSum += m.scores[s];
    if (r[s] === 1) st.first++;
    if (r[s] === 4) st.fourth++;
    local[id].rank = r[s];
    local[id].score = m.scores[s];
  });
  return local;
};
const started = Date.now();
for (let g = 0; g < groups; g++) {
  const group = Object.fromEntries(ids.map((id) => [id, { rank: 0, point: 0 }]));
  for (let rot = 0; rot < 4; rot++) {
    const seats = ids.map((_, s) => ids[(s + rot) % 4]);
    const wallSeed = seed * 1000003 + g * 7777 + rot * 97;
    const oldResult = runMatch('baseline', seats, wallSeed);
    const newResult = runMatch('candidate', seats, wallSeed);
    for (const id of ids) {
      group[id].rank += (newResult[id].rank - oldResult[id].rank) / 4;
      group[id].point += (newResult[id].score - oldResult[id].score) / 4;
    }
  }
  paired.push(group);
}
const rnd = (n) => Number(n.toFixed(3));
const summarize = (st) => ({
  matches: st.matches,
  meanRank: rnd(st.rankSum / st.matches),
  firstRate: rnd(st.first / st.matches),
  fourthRate: rnd(st.fourth / st.matches),
  meanPoints: rnd(st.pointSum / st.matches),
  winsPerMatch: rnd(st.wins / st.matches),
  dealInPerMatch: rnd(st.dealIn / st.matches),
  chiPerMatch: rnd(st.chi / st.matches),
  ponPerMatch: rnd(st.pon / st.matches),
  sinDiscardRate: st.discards ? rnd(st.sinDiscards / st.discards) : null,
  sinCallMeldsPerMatch: rnd(st.sinCallMelds / st.matches),
  riichiPerMatch: rnd(st.riichi / st.matches),
});
const diff = (values) => {
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const se = values.length < 2 ? null : Math.sqrt(
    values.reduce((sum, x) => sum + (x - avg) ** 2, 0) /
      ((values.length - 1) * values.length));
  return { mean: rnd(avg), se: se === null ? null : rnd(se),
    ci95: se === null ? null : [rnd(avg - 1.96 * se), rnd(avg + 1.96 * se)] };
};
const out = {
  note: '初級の実験プロトタイプ。main・Web版には未接続。seedは固定、4席ローテーション。差分はcandidate-baseline。',
  mode, groups, gamesPerScenario: groups * 4, seed, length, seconds: rnd((Date.now() - started) / 1000),
  baseline: Object.fromEntries(ids.map((id) => [id, summarize(all.baseline[id])])),
  candidate: Object.fromEntries(ids.map((id) => [id, summarize(all.candidate[id])])),
  pairedDiff: Object.fromEntries(ids.map((id) => [id, {
    rank: diff(paired.map((g) => g[id].rank)),
    points: diff(paired.map((g) => g[id].point)),
  }])),
};
console.log(JSON.stringify(out, null, 2));
