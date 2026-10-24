// AI 4人（または3人+AI代打ち）で多数局を自動対戦し、進行の健全性と統計を出す。
// 使い方: node tools/simulate.mjs --games 200 --seed 1 [--no360] [--check]
import { createRules } from '../src/engine/rules.js';
import { makeConfig, ENGINE_VERSION } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction, PERSONALITIES } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const games = Number(opt('--games', 200));
const seed0 = Number(opt('--seed', 1));
const check = args.includes('--check');
const config = makeConfig({ disableAngles: args.includes('--no360') ? [360] : [] });
const rules = createRules(config);
const lineup = ['speed', 'value', 'closed', 'speed'];

export function playOne(seed, personalities, { checkInvariants = false } = {}) {
  const players = personalities.map((p) => ({ name: p, kind: 'ai', personality: p }));
  const g = new Game({ rules, seed, dealer: seed % 4, players });
  const rng = createRng(seed * 7 + 3);
  let steps = 0;
  while (g.pending()) {
    const p = g.pending();
    applyAction(g, p.seat, decide(g, p.seat, players[p.seat].personality, rng));
    if (checkInvariants) g.checkInvariants();
    if (++steps > 2000) throw new Error('no progress');
  }
  return g;
}

const t0 = Date.now();
const stat = { chis: 0, win: 0, draw: 0, ron: 0, tsumo: 0, byPers: {}, yaku: {}, chiWins: 0, discards: 0, points: {} };
for (let i = 0; i < games; i++) {
  const seed = seed0 + i;
  // 席順ローテーション
  const pers = lineup.map((_, k) => lineup[(k + i) % 4]);
  const g = playOne(seed, pers, { checkInvariants: check });
  stat.chis += g.melds.reduce((s, m) => s + m.length, 0);
  stat.discards += g.rivers.reduce((s, r) => s + r.length, 0) + g.melds.reduce((s, m) => s + m.length, 0);
  if (g.result.type === 'draw') { stat.draw++; continue; }
  const r = g.result;
  stat.win++;
  stat[r.how]++;
  const who = pers[r.winner];
  stat.byPers[who] = (stat.byPers[who] || 0) + 1;
  stat.points[who] = (stat.points[who] || 0) + r.points;
  if (g.melds[r.winner].length) stat.chiWins++;
  for (const y of r.analysis.yaku) stat.yaku[y.name] = (stat.yaku[y.name] || 0) + 1;
}
console.log(JSON.stringify({
  engine: ENGINE_VERSION, games, seed0, deck: rules.deckSize, melds: rules.melds.length,
  lineup, seconds: (Date.now() - t0) / 1000, ...stat,
  meanDiscards: +(stat.discards / games).toFixed(2),
  personalitySeats: Object.fromEntries(Object.keys(PERSONALITIES).map((p) => [p, lineup.filter((x) => x === p).length])),
}, null, 1));
