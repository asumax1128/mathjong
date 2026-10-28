import test from 'node:test';
import assert from 'node:assert/strict';
import { interval, paired, stratifiedRankCI, winningShapes } from '../tools/experiments/analyze-trio-complete.mjs';
import { rulesFor, counts } from './helpers.js';

test('順位区間：一定の組平均は幅0、2組の標準誤差は席試合数で割らない', () => {
  assert.deepEqual(interval([2.5, 2.5, 2.5, 2.5]), { mean: 2.5, n: 4, low: 2.5, high: 2.5, half: 0 });
  assert.equal(interval([1, 3]).half, 12.706); assert.equal(interval([2]).half, null);
});
test('層別再標本化：行順や席回転の到着順で結果が変わらない', () => {
  const xs = [];
  for (const caseId of ['tara-low', 'tara-high']) for (let group = 0; group < 8; group++) for (let rot = 0; rot < 4; rot++) xs.push({ caseId, mode: 'math1', length: 4, group, rot, rank: 1 + (group + rot) % 4 });
  const a = stratifiedRankCI(xs, 42, 1000), b = stratifiedRankCI(xs.slice().reverse(), 42, 1000);
  assert.deepEqual(a, b); assert.equal(a.groups, 16); assert.equal(a.strata, 2); assert.equal(a.mean, 2.5); assert.equal(a.low, 2.5); assert.equal(a.high, 2.5);
});
test('対比較：自己比較は厳密な0、異なるseed・席・重複対を拒否', () => {
  const st = Object.fromEntries(['rounds','wins','dealIn','chi','pon','riichi','basePoints','sanankou','toitoi','readyDiscards','heldRiichi','declaredCount','declaredLive','decisions','ms','maxMs'].map(k => [k, k === 'rounds' || k === 'decisions' ? 1 : 0]));
  const rows = [];
  for (let group = 0; group < 2; group++) for (let rot = 0; rot < 4; rot++) for (const variant of ['final', 'ablate-yujin']) rows.push({
    sample: `${variant}-${group}-${rot}`, pair: `${group}-${rot}`, variant, group, rot, seedBase: group + 99, mode: 'math1', length: 4,
    seats: ['yujin', 'kanata', 'mitsuki', 'aoto'], ranks: [1, 2, 3.5, 3.5], scores: [120, 100, 90, 90], shares: [[1,0,0,0],[0,1,0,0],[0,0,.5,.5],[0,0,.5,.5]], stats: [st,st,st,st],
  });
  const a = paired(rows, 'yujin'); assert.equal(a.pairs, 8); assert.equal(a.rankDelta.mean, 0); assert.equal(a.rankDelta.half, 0); assert.equal(a.pointDelta.mean, 0); assert.equal(a.rankDelta.n, 2);
  assert.deepEqual(a, paired(rows.slice().reverse(), 'yujin'));
  const broken = structuredClone(rows); broken.find(x => x.variant === 'ablate-yujin').seedBase++; assert.throws(() => paired(broken, 'yujin'), /pair mismatch/);
  assert.throws(() => paired([...rows, rows.find(x => x.variant === 'ablate-yujin')], 'yujin'), /duplicate/);
});
test('個性の指標：役名だけでなく実エンジンの最高得点分解から刻子1組・2組・3組を数える', () => {
  for (const mode of ['math1', 'math2']) {
    const r = rulesFor(mode), logs = [];
    for (const hand of [
      ['sin','30','=1/2','cos','180','=-1','45','45','45'],
      ['sin','30','=1/2','cos','cos','cos','45','45','45'],
      ['sin','sin','sin','cos','cos','cos','tan','tan','tan'],
    ]) { const analysis = r.analyzeWin(counts(hand,r)); assert.ok(analysis); logs.push({ result: { type: 'win', winner: 0, analysis } }); }
    const result = winningShapes([{ mode, seats: ['yujin','a','b','c'], logs }], 'yujin');
    assert.equal(result.wins, 3); assert.equal(result.closed, 3); assert.deepEqual(result.concealedTriplets, [0,1,1,1]); assert.equal(result.atLeastOne, 1);
  }
});
