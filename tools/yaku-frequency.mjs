// エンジン 0.8.0 の役（正負対称・補角対・等差三連）の頻度測定（docs/86）。ruleset 2・キャラクター AI 4人の1局を多数。
// 同じ局（同じ席の並び・同じ乱数の種）を「新しい役なし（round2Yaku: false＝main と同じ採点）」と「あり」で1回ずつ打ち、比べる。
//   ・新しい役の出現：和了100回あたりの回数（あり側）
//   ・和了1回あたりの平均点（なし側＝main、あり側）とその差
//   ・あり側で「新しい役だけが役の和了」（なし側の規則なら役なしで和了できない形）の回数
//   ・同じ和了形の採点の差：なし側の和了を round2 ありで採点し直したときの平均の上げ幅（打ち方の変化を除いた純粋な点の上積み）
// AI の方針は変えていない（AI の評価は rules.evaluateMelds の既定＝新しい役を数えない）。差は「役が増えて和了できる形」と採点だけから出る。
// 使い方: node tools/yaku-frequency.mjs [--rounds 2000] [--mode math1|math2|both] [--seed 1] [--points seifu=2,hokaku=2,tousa=3]
//   --points：暫定の点数を config の値だけ差し替えて測る（コードは変えない）
import { createRules } from '../src/engine/rules.js';
import { makeConfig, ENGINE_VERSION } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { applyAction } from '../src/engine/ai.js';
import { decideCharacter, CHARACTER_ROSTER, newPublicHistory } from '../src/engine/characters.js';
import { createMatch } from '../src/engine/match.js';
import { matchInfo } from '../src/engine/ai-levels.js';
import { createRng } from '../src/engine/rng.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ROUNDS = Number(opt('--rounds', 2000));
const SEED = Number(opt('--seed', 1));
const MODES = opt('--mode', 'both') === 'both' ? ['math1', 'math2'] : [opt('--mode')];
const POINTS = Object.fromEntries((opt('--points', '') || '').split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split('='); return [k, Number(v)]; }));
const NEW = ['seifu', 'hokaku', 'tousa'];
const ids = Object.values(CHARACTER_ROSTER).flat().map((c) => c.id);
const players = [0, 1, 2, 3].map((s) => ({ name: 'P' + s, kind: 'ai', personality: 'speed' }));

function rulesFor(mode) {
  const config = makeConfig({ mode });
  for (const y of config.yaku) if (y.id in POINTS) y.points = POINTS[y.id];
  return createRules(config);
}

function playRound(rules, i, round2Yaku) {
  const lineup = [0, 1, 2, 3].map((k) => ids[(i * 5 + k * 7 + (i >> 3)) % 12]);
  for (let s = 1; s < 4; s++) while (lineup.indexOf(lineup[s]) !== s) lineup[s] = ids[(ids.indexOf(lineup[s]) + 1) % 12];
  const g = new Game({ rules, seed: SEED * 104729 + i, dealer: i % 4, players, ruleset: 2, round2Yaku });
  const info = { ...matchInfo(createMatch({ length: 1 })), publicHistory: newPublicHistory() };
  const rng = createRng(SEED * 1000003 + i);
  for (let n = 0; g.pending(); n++) {
    if (n > 3000) throw new Error('no progress');
    const p = g.pending();
    applyAction(g, p.seat, decideCharacter(g, p.seat, lineup[p.seat], rng, info, lineup.slice(1)));
    g.checkInvariants();
  }
  return g;
}

// 和了した手を round2 ありで採点し直す（同じ和了形・同じ和了の仕方。ドラ・リーチ・門前ツモ・一発の加点は差に影響しないので役の点だけ比べる）
function rescore(rules, g) {
  const r = g.result;
  const seat = r.winner;
  const hand = g.hands[seat].includes(r.tile) ? g.hands[seat] : [...g.hands[seat], r.tile]; // ロンの牌は手牌に入らない
  const counts = g.countsOf(hand);
  const opts = { ron: r.how === 'ron', closed: g.isClosed(seat) };
  const a0 = rules.analyzeWin(counts, g.exposedMelds(seat), { ...opts, round2: false });
  const a1 = rules.analyzeWin(counts, g.exposedMelds(seat), { ...opts, round2: true });
  return a0 && a1 ? a1.points - a0.points : null;
}

const out = { engine: ENGINE_VERSION, ruleset: 2, rounds: ROUNDS, seed: SEED, points: Object.fromEntries(NEW.map((id) => [id, rulesFor('math1').config.yaku.find((y) => y.id === id).points])), modes: {} };
const t0 = Date.now();
for (const mode of MODES) {
  const rules = rulesFor(mode);
  const s = { off: { win: 0, pts: 0, yakuPts: 0 }, on: { win: 0, pts: 0, yakuPts: 0, only: 0, any: 0, count: Object.fromEntries(NEW.map((k) => [k, 0])), combos: {} }, rescored: 0, rescoreUp: 0, rescoreSum: 0, sameResult: 0 };
  for (let i = 0; i < ROUNDS; i++) {
    const gOff = playRound(rules, i, false);
    const gOn = playRound(rules, i, true);
    for (const [k, g] of [['off', gOff], ['on', gOn]]) {
      if (g.result.type !== 'win') continue;
      const x = s[k];
      x.win++; x.pts += g.result.points;
      x.yakuPts += g.result.analysis.yaku.filter((y) => !y.riichi && !y.menzenTsumo && !y.ippatsu).reduce((a, y) => a + y.points, 0);
    }
    if (gOff.result.type === gOn.result.type && JSON.stringify(gOff.events) === JSON.stringify(gOn.events)) s.sameResult++;
    if (gOn.result.type === 'win') {
      const ys = gOn.result.analysis.yaku.map((y) => y.id);
      const hit = NEW.filter((k) => ys.includes(k));
      for (const k of hit) s.on.count[k]++;
      if (hit.length) {
        s.on.any++;
        const others = gOn.result.analysis.yaku.filter((y) => !NEW.includes(y.id) && !y.riichi && !y.menzenTsumo && !y.ippatsu);
        if (!others.length) s.on.only++;
        const key = ys.filter((y) => y !== 'riichi' && y !== 'menzen-tsumo' && y !== 'ippatsu').sort().join('+');
        s.on.combos[key] = (s.on.combos[key] || 0) + 1;
      }
    }
    if (gOff.result.type === 'win') {
      const d = rescore(rules, gOff);
      if (d !== null) { s.rescored++; s.rescoreSum += d; if (d > 0) s.rescoreUp++; }
    }
  }
  const per100 = (n, w) => +((100 * n) / Math.max(1, w)).toFixed(2);
  const avg = (n, w) => +(n / Math.max(1, w)).toFixed(3);
  out.modes[mode] = {
    off_main: { wins: s.off.win, winRate: avg(s.off.win, ROUNDS), avgWinPoints: avg(s.off.pts, s.off.win), avgYakuPoints: avg(s.off.yakuPts, s.off.win) },
    on_round2: { wins: s.on.win, winRate: avg(s.on.win, ROUNDS), avgWinPoints: avg(s.on.pts, s.on.win), avgYakuPoints: avg(s.on.yakuPts, s.on.win) },
    per100Wins: Object.fromEntries([...NEW.map((k) => [k, per100(s.on.count[k], s.on.win)]), ['anyNew', per100(s.on.any, s.on.win)], ['newOnly', per100(s.on.only, s.on.win)]]),
    counts: { ...s.on.count, anyNew: s.on.any, newOnly: s.on.only },
    avgWinPointsDelta: +(avg(s.on.pts, s.on.win) - avg(s.off.pts, s.off.win)).toFixed(3),
    sameHandRescore: { wins: s.rescored, raised: s.rescoreUp, raisedPer100: per100(s.rescoreUp, s.rescored), avgDelta: avg(s.rescoreSum, s.rescored) },
    identicalRounds: s.sameResult,
    topCombos: Object.entries(s.on.combos).sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
}
out.seconds = (Date.now() - t0) / 1000;
console.log(JSON.stringify(out, null, 1));
