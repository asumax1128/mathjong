import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN, tuningJobs, evaluationJobs, selectPolicy } from '../tools/experiments/trio-complete-plan.mjs';
import { tripletMissing, tripletSupply, publicGame, decideNewCharacter } from '../tools/experiments/new-character-trio.mjs';
import { rulesFor, makeGame } from './helpers.js';
import { createRng } from '../src/engine/rng.js';
import { applyAction } from '../src/engine/ai.js';

test('完了計画：調整128・本評価1600・対照384、同一seedと席の対応、未使用評価seedを固定', () => {
  const tuning = tuningJobs(), evaluation = evaluationJobs({ selected: 'supply' });
  assert.equal(tuning.length, 128); assert.equal(evaluation.filter(j => j.variant === 'final').length, 1600);
  assert.equal(evaluation.filter(j => j.variant !== 'final').length, 384);
  assert.equal(new Set([...tuning, ...evaluation].map(j => j.sample)).size, 2112);
  assert.notEqual(PLAN.tuningSeed, PLAN.evaluationSeed);
  const final = new Map(evaluation.filter(j => j.variant === 'final').map(j => [j.pair, j]));
  for (const a of evaluation.filter(j => j.variant !== 'final')) {
    const b = final.get(a.pair); assert.ok(b);
    assert.deepEqual([a.seedBase, a.seats, a.group, a.rot], [b.seedBase, b.seats, b.group, b.rot]);
  }
  const ts = new Set(tuning.map(j => j.seedBase)); assert.ok(evaluation.every(j => !ts.has(j.seedBase)));
});
test('選択規則：刻子率だけで採用せず、順位悪化0.25の境界を調整試験で判定', () => {
  const row = (variant, rank, sanankou) => ({ variant, seats: ['yujin'], ranks: [rank], stats: [{ rounds: 1000, wins: 100, sanankou }] });
  assert.equal(selectPolicy([row('initial', 2.5, 10), row('supply', 2.75, 15)]).selected, 'supply');
  assert.equal(selectPolicy([row('initial', 2.5, 10), row('supply', 2.76, 40)]).selected, 'initial');
  assert.equal(selectPolicy([row('initial', 2.5, 10), row('supply', 2.3, 14)]).selected, 'initial');
});
for (const mode of ['math1', 'math2']) {
  test(`集めやすさ ${mode}：最小不足枚数を維持し、公開残数で同点を評価`, () => {
    const r = rulesFor(mode), rng = createRng(8204);
    for (let n = 0; n < 32; n++) {
      const counts = new Uint8Array(r.types.length), unseen = r.types.map(t => t.copies);
      for (let k = 0; k < 8; k++) { const t = rng.int(counts.length); if (counts[t] < r.types[t].copies) { counts[t]++; unseen[t]--; } }
      for (let t = 0; t < unseen.length; t++) unseen[t] = rng.int(unseen[t] + 1);
      const x = tripletSupply(r, counts, unseen, n * 4);
      assert.equal(x.miss, tripletMissing(r, counts, unseen));
      assert.ok(x.supply === -Infinity || Number.isFinite(x.supply));
    }
    // 唯一可能な形：sin6枚＋30°刻子。残り4枚中30°が2枚、1回ツモなら不足1枚の補充確率1/2。
    const held = new Uint8Array(r.types.length), left = new Uint8Array(r.types.length);
    const t = key => r.typeByKey.get(key).idx;
    held[t('f:sin')] = 6; held[t('a:30')] = 2; left[t('a:30')] = 2; left[t('v:0')] = 2;
    const x = tripletSupply(r, held, left, 4);
    assert.equal(x.miss, 1); assert.ok(Math.abs(x.supply - Math.log(0.5)) < 1e-12);
  });
  test(`調整候補 ${mode}：他家の手牌/未来を変えても同じ合法判断、対照設定も含めて検査`, () => {
    const create = () => makeGame({ r: rulesFor(mode), hands: [
      ['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'],
      ['sin', 'sin', '0', '90', '90', '=-√3', '=√3', '150'],
      ['cos', '135', '=√3', '=-1/√2', '120', '120', 'tan', '=0'],
      ['=-1', 'tan', 'tan', '120', '=1/√3', '90', '=-1/√2', '=-√3'],
    ], draws: ['0'] });
    for (const [id, experimental] of [['yujin', { yujin: { policy: 'supply' } }], ['tara', { tara: { maxDelay: 0 } }], ['nocchi', { nocchi: { adaptive: false } }]]) {
      const a = create(), b = create(); [b.hands[1][0], b.hands[2][0]] = [b.hands[2][0], b.hands[1][0]]; b.wall.reverse();
      const x = decideNewCharacter(publicGame(a, 0), 0, id, createRng(832), { experimental });
      const y = decideNewCharacter(publicGame(b, 0), 0, id, createRng(832), { experimental });
      assert.deepEqual(x, y); if (id === 'tara') assert.equal(x.riichi, true, '保留なしでは初回に宣言する');
      applyAction(a, 0, x); a.checkInvariants(); b.checkInvariants();
    }
  });
}
