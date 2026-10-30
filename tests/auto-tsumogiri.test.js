// リーチ後のオートツモ切り（src/ui/auto-tsumogiri.js）：止まる条件（ツモ和了・宣言・リーチ前・他家の番・OFF）と、
// 多数の対局で自分（席0）がオートツモ切りを使っても、ロン・ツモの機会を飛ばさず、フリテン・24回・保存則・400点が保たれること。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { createMatch, applyRoundResult, dealerOf } from '../src/engine/match.js';
import { createRng } from '../src/engine/rng.js';
import { autoTsumogiriDue, autoTsumogiriTile } from '../src/ui/auto-tsumogiri.js';
import { rulesFor, k } from './helpers.js';

const R1 = rulesFor('math1');
const players = [0, 1, 2, 3].map((s) => ({ name: 'P' + s, kind: 'ai', personality: 'speed' }));
const TENPAI = ['cos', '180', '=-1', 'tan', '45', '=1', 'sin', '=1/2']; // 30°・150° 待ち
const OTHERS = [
  ['90', '90', '0', '0', '=√3', '=√3', '=-1/√3', '=-1/√3'],
  ['90', '90', '0', '0', '=√3', '=√3', '=-1/√3', '=-1/√3'],
  ['=-√3/2', '=-√3/2', '=1/√3', '=1/√3', '=-1/√2', '=-1/√2', '=1/√2', '=1/√2'],
];
function game(draws, ruleset = 2) {
  const hands = [TENPAI, ...OTHERS];
  const keys = [];
  for (let i = 0; i < 8; i++) for (let s = 0; s < 4; s++) keys.push(k(hands[s][i]));
  return new Game({ rules: R1, seed: 1, dealer: 0, players, presetWall: [...keys, ...draws.map(k)], ruleset });
}

test('止まる条件：OFF・リーチ前・ツモ和了できる・宣言（ロン）・他家の番では自動で捨てない。リーチ中の通常ツモの後だけ', () => {
  for (const ruleset of [2, 1, 0]) {
    const g = game(['=-1/2', '=-1/2', '=-1/2', '=-1/2', '=√3/2', '30', '=-√3', '=-√3', '150'], ruleset);
    assert.equal(autoTsumogiriDue(g, 0, true), false, 'リーチ前');
    g.discard(0, g.drawn, { riichi: true });
    assert.equal(autoTsumogiriDue(g, 0, true), false, '他家の番');
    for (let s = 1; s <= 3; s++) g.discard(s, g.drawn);
    assert.deepEqual([g.pending().seat, g.pending().type, g.pending().canTsumo], [0, 'turn', false]);
    assert.equal(autoTsumogiriDue(g, 0, false), false, 'OFF');
    assert.equal(autoTsumogiriDue(g, 0, true), true, 'リーチ中・通常ツモ・和了できない');
    g.discard(0, autoTsumogiriTile(g)); // √3/2 を自動でツモ切り
    g.discard(1, g.drawn); // 下家 30°
    const p = g.pending();
    assert.deepEqual([p.seat, p.type, p.ron], [0, 'claim', true], `ruleset ${ruleset}：ロンの宣言`);
    assert.equal(autoTsumogiriDue(g, 0, true), false, '宣言（ロン）には応答しない');
    g.respond(0, { type: 'pass' });
    if (ruleset === 2) assert.ok(g.furitenOf(0).reasons.includes('riichi'), '見送り：リーチ後のフリテン');
    for (let i = 0; i < 10 && g.pending() && g.pending().seat !== 0; i++) { const q = g.pending(); if (q.type === 'claim') g.respond(q.seat, { type: 'pass' }); else g.discard(q.seat, g.drawn); }
    assert.equal(g.pending().canTsumo, true, '150° でツモ和了できる');
    assert.equal(autoTsumogiriDue(g, 0, true), false, 'ツモ和了できるときは止まる');
  }
});

// 席0（人の代わり）：リーチできれば宣言し、リーチ中はオートツモ切り。ツモ和了・ロンは交互に「する」「見送る」。
// 見送りは本人の操作として扱う（オートツモ切りは宣言・和了の判断には一切応答しない）。
function playRound(rules, seed, dealer, ruleset, round, log) {
  const g = new Game({ rules, seed, dealer, players, ruleset });
  const rng = createRng(seed * 13 + 1);
  let n = 0;
  for (; g.pending(); n++) {
    if (n > 3000) throw new Error('no progress');
    const p = g.pending();
    if (p.seat === 0) {
      if (p.type === 'claim' && p.ron) {
        log.ronChances++;
        if (ruleset === 2) assert.equal(g.furitenOf(0).furiten, false, 'フリテン中にロンの宣言');
        if ((round + log.ronChances) % 2) { g.respond(0, { type: 'ron' }); log.ron++; continue; }
        g.respond(0, { type: 'pass' }); log.ronPassed++;
        if (ruleset === 2 && g.riichi[0]) assert.ok(g.riichiFuriten[0], 'リーチ後の見送りはこの局の終わりまでフリテン');
        continue;
      }
      if (p.type === 'turn' && g.riichi[0]) {
        if (p.canTsumo) {
          log.tsumoChances++;
          assert.equal(autoTsumogiriDue(g, 0, true), false, 'ツモ和了できるのに自動で捨てようとした');
          if ((round + log.tsumoChances) % 2) { g.tsumo(0); log.tsumo++; continue; }
          g.discard(0, g.drawn); log.tsumoPassed++; continue; // 本人がツモ切りで見送る
        }
        assert.equal(autoTsumogiriDue(g, 0, true), true, 'リーチ中の通常ツモの後なのに自動で進まない');
        g.discard(0, autoTsumogiriTile(g)); log.auto++;
        g.checkInvariants();
        continue;
      }
    }
    applyAction(g, p.seat, decide(g, p.seat, 'speed', rng, 'intermediate'));
    g.checkInvariants();
  }
  if (rules.config.mode === 'math2' && ruleset >= 1) assert.ok(g.normalDraws.every((x) => x <= 24));
  if (g.result.type === 'draw') log.draws++;
  return g;
}
test('オートツモ切りで対局（数学Ⅰ・Ⅱ、ruleset 2・1・0）：ロン・ツモの機会を飛ばさない・見送りでフリテン・24回・保存則・合計400点・終局', () => {
  const total = { auto: 0, tsumoChances: 0, ronChances: 0, draws: 0 };
  for (const mode of ['math1', 'math2']) {
    const rules = rulesFor(mode);
    for (const ruleset of [2, 1, 0]) {
      const log = { auto: 0, tsumoChances: 0, tsumo: 0, tsumoPassed: 0, ronChances: 0, ron: 0, ronPassed: 0, draws: 0 };
      for (let m = 0; m < 6; m++) {
        let match = createMatch({ length: 4 });
        for (let r = 1; !match.over && r <= 12; r++) {
          const g = playRound(rules, 7000 + m * 37 + r, dealerOf(match), ruleset, r, log);
          match = applyRoundResult(match, g.result);
          assert.equal(match.scores.reduce((a, b) => a + b, 0), 400);
        }
      }
      for (const key of Object.keys(total)) total[key] += log[key];
    }
  }
  assert.ok(total.auto > 50, `自動ツモ切り ${total.auto}回`);
  assert.ok(total.tsumoChances > 0 && total.ronChances > 0, `ツモ ${total.tsumoChances}・ロン ${total.ronChances} の機会`);
});

test('OFF（手動のツモ切り）と ON（自動）は同じ打牌：同じ seed で同じ記録になる', () => {
  for (const mode of ['math1', 'math2']) {
    const rules = rulesFor(mode);
    for (let seed = 1; seed <= 20; seed++) {
      const run = (auto) => {
        const g = new Game({ rules, seed, dealer: seed % 4, players, ruleset: 2 });
        const rng = createRng(seed);
        while (g.pending()) {
          const p = g.pending();
          if (p.seat === 0 && p.type === 'turn' && g.riichi[0] && !p.canTsumo) {
            if (auto) { assert.ok(autoTsumogiriDue(g, 0, true)); g.discard(0, autoTsumogiriTile(g)); } else g.discard(0, g.drawn);
            continue;
          }
          applyAction(g, p.seat, decide(g, p.seat, 'speed', rng, 'intermediate'));
        }
        return JSON.stringify([g.events, g.result]);
      };
      assert.equal(run(true), run(false), `seed ${seed}`);
    }
  }
});
