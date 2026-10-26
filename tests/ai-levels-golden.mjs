// 中級 AI の固定 seed 回帰（Ver.0.4-B）：Ver.0.4-A（main 6be58ac）の AI で記録した対局ログの要約と照合する。
// tests/ai-levels.test.js から使う。node tests/ai-levels-golden.mjs で現在のコードの値を表示する。
import { createHash } from 'node:crypto';
import { createRules } from '../src/engine/rules.js';
import { makeConfig, LEGACY_V02_CONFIG } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { createMatch, applyRoundResult, dealerOf } from '../src/engine/match.js';

const LINEUP = ['speed', 'value', 'closed', 'speed'];

// 1局をすべて AI で進め、全行動の記録を返す。level を省略した呼び出し（従来の4引数）と明示した呼び出しを選べる。
export function playRound(rules, seed, dealer, pers, { level } = {}) {
  const g = new Game({ rules, seed, dealer, players: pers.map((p) => ({ kind: 'ai', personality: p })) });
  const rng = createRng(seed ^ 0x5bd1e995);
  const log = [];
  while (g.pending()) {
    const p = g.pending();
    const a = level === undefined ? decide(g, p.seat, pers[p.seat], rng) : decide(g, p.seat, pers[p.seat], rng, level);
    log.push([p.seat, a.type, a.tile ?? a.option ?? null]);
    applyAction(g, p.seat, a);
  }
  return { g, log };
}

// 4局戦を1試合、AI だけで進めた全記録
export function playMatch(rules, seedBase, { level, length = 4 } = {}) {
  let m = createMatch({ length });
  const out = [];
  let n = 0;
  while (!m.over) {
    n++;
    const { g, log } = playRound(rules, seedBase + n * 7919, dealerOf(m), LINEUP, { level });
    out.push(log);
    m = applyRoundResult(m, g.result);
  }
  out.push(m.scores);
  return out;
}

export function goldenDigest({ level } = {}) {
  const res = {};
  const sets = { legacy: createRules(LEGACY_V02_CONFIG), math1: createRules(makeConfig({ mode: 'math1' })), math2: createRules(makeConfig({ mode: 'math2' })) };
  for (const [name, rules] of Object.entries(sets)) {
    const all = [];
    for (let i = 0; i < 6; i++) all.push(playRound(rules, 4242 + i, i % 4, LINEUP.map((_, k) => LINEUP[(k + i) % 4]), { level }).log);
    if (name !== 'legacy') all.push(playMatch(rules, 90001, { level }));
    res[name] = createHash('sha256').update(JSON.stringify(all)).digest('hex').slice(0, 24);
  }
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(goldenDigest());
