// 保存した局を再生して行動列を照合。のっちの履歴あり/なしも同一乱数位置で比較する。
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { Game } from '../../src/engine/game.js';
import { createRules } from '../../src/engine/rules.js';
import { makeConfig } from '../../src/engine/config.js';
import { createRng } from '../../src/engine/rng.js';
import { applyAction } from '../../src/engine/ai.js';
import { decideCharacter } from '../../src/engine/character-ai.js';
import { NEW_CHARACTERS, publicGame, decideNewCharacter } from './new-character-trio.mjs';
import { createMatch, dealerOf, applyRoundResult } from '../../src/engine/match.js';

const src = process.argv[2], bytes = readFileSync(src);
const rows = (src.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8').trim().split('\n').map(x => JSON.parse(x));
const selected = rows.filter(x => ['mixed', 'nocchi-high'].includes(x.caseId) && x.group === 0 && x.rot === 0);
let games = 0, decisions = 0, comparisons = 0, changed = 0, riichiComparison = 0;
for (const row of selected) {
  const rules = createRules(makeConfig({ mode: row.mode }));
  let m = createMatch({ length: row.length });
  const history = row.seats.map(() => ({ rounds: 0, calls: 0, earlyRiichi: 0 }));
  for (const log of row.logs) {
    const g = new Game({ rules, seed: log.gameSeed, dealer: dealerOf(m), players: row.seats.map(name => ({ name, kind: 'ai', personality: 'speed' })) });
    const views = row.seats.map((_, s) => publicGame(g, s));
    const seed = (log.gameSeed ^ 0x5bd1e995) >>> 0, root = createRng(seed); let cursor = 0;
    const next = () => { cursor++; return root.next(); };
    const rng = { next, int: n => Math.floor(next() * n), pick: xs => xs[Math.floor(next() * xs.length)] };
    const clone = () => { const r = createRng(seed); for (let i = 0; i < cursor; i++) r.next(); return r; };
    const info = { scores: m.scores.slice(), hand: m.hand, length: m.length, dealer: dealerOf(m), renchan: m.renchan, publicHistory: history.map(h => ({ ...h })) };
    while (g.pending()) {
      const p = g.pending(), s = p.seat, id = row.seats[s];
      if (id === 'nocchi' && p.type === 'turn' && !p.canTsumo && !g.riichi[s] && m.played > 0) {
        const adaptive = decideNewCharacter(views[s], s, id, clone(), info);
        const neutral = decideNewCharacter(views[s], s, id, clone(), { ...info, publicHistory: [] });
        comparisons++; if (adaptive.tile !== neutral.tile) changed++;
        if (adaptive.riichi !== neutral.riichi) riichiComparison++;
      }
      const a = NEW_CHARACTERS[id] ? decideNewCharacter(views[s], s, id, rng, info) : decideCharacter(g, s, id, rng, info, row.seats);
      applyAction(g, s, a); decisions++;
    }
    g.checkInvariants(); assert.deepEqual(g.events, log.events); assert.deepEqual(g.result, log.result);
    for (const [s, h] of history.entries()) {
      h.rounds++;
      for (const ev of g.events.filter(e => e.seat === s)) {
        if (ev.type === 'chi' || ev.type === 'pon') h.calls++;
        if (ev.type === 'riichi' && g.riichi[s].turn <= 6) h.earlyRiichi++;
      }
    }
    m = applyRoundResult(m, g.result); assert.deepEqual(m.scores, log.scores); games++;
  }
  assert.deepEqual(m.scores, row.scores);
}
const report = { matches: selected.length, games, decisions, nocchiHistoryComparisons: comparisons, differentDiscard: changed, differentRiichi: riichiComparison,
  meaning: '同一状態・同一乱数位置で公開履歴の重みだけを中立化。強さへの寄与の検定ではない。' };
writeFileSync(process.argv[3] || '/tmp/new-trio-verification.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
