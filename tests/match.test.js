// Ver.0.4-A：対局の進行（src/engine/match.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, applyRoundResult, settle, ranks, dealerOf, handLabel, matchAt, START_POINTS } from '../src/engine/match.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { rulesFor } from './helpers.js';

const sum = (a) => a.reduce((s, x) => s + x, 0);
const ron = (winner, from, points) => ({ type: 'win', winner, how: 'ron', from, points });
const tsumo = (winner, points) => ({ type: 'win', winner, how: 'tsumo', from: null, points });
const draw = { type: 'draw' };

test('精算：子ロン ±4B、親ロン ±6B', () => {
  assert.deepEqual(settle(ron(1, 2, 3), 0), [0, 12, -12, 0]);
  assert.deepEqual(settle(ron(0, 3, 2), 0), [12, 0, 0, -12]);
  assert.deepEqual(settle(ron(2, 0, 1), 0), [-4, 0, 4, 0], '親が放銃しても −4B（子の和了）');
});

test('精算：子ツモ 和了者 +4B・親 −2B・ほかの子 −B、親ツモ +6B・子 各 −2B、流局 0', () => {
  assert.deepEqual(settle(tsumo(1, 3), 0), [-6, 12, -3, -3]);
  assert.deepEqual(settle(tsumo(3, 2), 1), [-2, -4, -2, 8]);
  assert.deepEqual(settle(tsumo(2, 16), 2), [-32, -32, 96, -32], '親の役満ツモ');
  assert.deepEqual(settle(draw, 0), [0, 0, 0, 0]);
  for (const r of [ron(1, 2, 7), ron(0, 1, 5), tsumo(1, 9), tsumo(0, 4), draw]) for (let d = 0; d < 4; d++) assert.equal(sum(settle(r, d)), 0);
});

test('親が和了すると連荘（同じ親番）、子の和了・流局は親交代', () => {
  let m = createMatch({ length: 4 });
  assert.deepEqual([handLabel(m), dealerOf(m), m.renchan], ['東1局', 0, 0]);
  m = applyRoundResult(m, tsumo(0, 2));
  assert.deepEqual([handLabel(m), dealerOf(m), m.renchan, m.played, m.renchanTotal], ['東1局', 0, 1, 1, 1], '親ツモで連荘');
  m = applyRoundResult(m, ron(0, 2, 1));
  assert.deepEqual([handLabel(m), m.renchan, m.renchanTotal], ['東1局', 2, 2], '親ロンでも連荘');
  m = applyRoundResult(m, ron(3, 0, 1));
  assert.deepEqual([handLabel(m), dealerOf(m), m.renchan], ['東2局', 1, 0], '子の和了で親交代、連荘回数は0へ');
  m = applyRoundResult(m, draw);
  assert.deepEqual([handLabel(m), dealerOf(m)], ['東3局', 2], '流局で親交代');
  assert.equal(m.played, 4);
  assert.equal(sum(m.scores), 400);
});

test('4局戦は東4局の親番、8局戦は南4局の親番が終わると試合終了。最終の親の連荘で延長', () => {
  let m = createMatch({ length: 4 });
  for (let i = 0; i < 3; i++) m = applyRoundResult(m, draw);
  assert.equal(handLabel(m), '東4局');
  m = applyRoundResult(m, tsumo(3, 1)); // 東4局の親（席3）がツモ → 連荘で延長
  assert.equal(m.over, false);
  m = applyRoundResult(m, ron(3, 1, 1));
  assert.equal(m.over, false, '連荘が続く限り終わらない');
  m = applyRoundResult(m, ron(2, 3, 1)); // 子の和了 → 終了
  assert.equal(m.over, true);
  assert.equal(m.played, 6, '実際の局数は4を超える');
  assert.equal(m.renchanTotal, 2);
  assert.throws(() => applyRoundResult(m, draw), /over/);
  let e = createMatch({ length: 8 });
  const labels = [];
  while (!e.over) { labels.push(handLabel(e)); e = applyRoundResult(e, draw); }
  assert.deepEqual(labels, ['東1局', '東2局', '東3局', '東4局', '南1局', '南2局', '南3局', '南4局']);
  assert.equal(e.played, 8);
  assert.deepEqual(e.scores, [100, 100, 100, 100]);
});

test('東1局の親の席を指定でき、親は1局ごとに下家へ移る', () => {
  const m = createMatch({ length: 8, startDealer: 2 });
  assert.deepEqual([0, 1, 2, 3, 4, 7].map((h) => dealerOf(m, h)), [2, 3, 0, 1, 2, 1]);
});

test('順位：同点は同順位（1,2,2,4）', () => {
  assert.deepEqual(ranks([120, 100, 100, 80]), [1, 2, 2, 4]);
  assert.deepEqual(ranks([100, 100, 100, 100]), [1, 1, 1, 1]);
  assert.deepEqual(ranks([-20, 300, 60, 60]), [4, 1, 2, 2]);
});

test('和了回数・最高和了（精算後の獲得点と基本点）・記録・負点でも続行・合計400', () => {
  let m = createMatch({ length: 4 });
  m = applyRoundResult(m, ron(1, 0, 16)); // 子の役満ロン：+64、親 −64
  m = applyRoundResult(m, tsumo(1, 2)); // 東2局の親（席1）のツモ：+6B=12、子 各 −2B=−4 → 連荘
  m = applyRoundResult(m, ron(1, 0, 16)); // 親（席1）の役満ロン：+96、席0 −96
  assert.equal(m.scores[0], 100 - 64 - 2 * 2 - 96, '負点でも続行');
  assert.ok(m.scores[0] < 0);
  assert.equal(m.over, false);
  assert.equal(sum(m.scores), 4 * START_POINTS);
  assert.deepEqual(m.wins, [0, 3, 0, 0]);
  assert.equal(m.best[1], 96);
  assert.equal(m.bestBase[1], 16);
  assert.equal(m.log.length, 3);
  assert.deepEqual(m.log[1], { label: '東2局', hand: 1, dealer: 1, renchan: 0, result: { winner: 1, how: 'tsumo', from: null, points: 2 }, deltas: [-4, 12, -4, -4], dealerKeeps: true });
  const before = structuredClone(m);
  applyRoundResult(m, draw);
  assert.deepEqual(m, before, '入力の状態は変更しない');
});

test('再現用の途中状態（matchAt）：親番・連荘回数を指定、範囲外は丸める', () => {
  const m = matchAt({ length: 4, hand: 3, renchan: 2 });
  assert.deepEqual([handLabel(m), dealerOf(m), m.renchan], ['東4局', 3, 2]);
  assert.equal(handLabel(matchAt({ length: 4, hand: 9 })), '東4局');
  assert.equal(handLabel(matchAt({ length: 8, hand: 5 })), '南2局');
});

test('AI 4人の試合（数学Ⅰ、4局戦・8局戦 各5試合）：合計400を維持し、規定の親番で終わる', () => {
  const r = rulesFor('math1');
  const lineup = ['speed', 'value', 'closed', 'speed'];
  for (const length of [4, 8]) {
    for (let k = 0; k < 5; k++) {
      let m = createMatch({ length });
      let n = 0;
      while (!m.over) {
        n++;
        const seed = 1000 * k + n * 7919;
        const g = new Game({ rules: r, seed, dealer: dealerOf(m), players: lineup.map((p) => ({ kind: 'ai', personality: p })) });
        const rng = createRng(seed ^ 0x5bd1e995);
        while (g.pending()) { const p = g.pending(); applyAction(g, p.seat, decide(g, p.seat, lineup[p.seat], rng)); }
        m = applyRoundResult(m, g.result);
        assert.equal(sum(m.scores), 400);
      }
      assert.ok(m.played >= length);
      assert.equal(m.played, length + m.renchanTotal, '局数 = 親番の数 + 連荘回数');
      assert.equal(m.hand, length);
    }
  }
});
