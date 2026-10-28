// 新3人は実験専用。正式な9人やゲーム規則には登録しない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { NEW_CHARACTERS, publicGame, decideNewCharacter, tripletMissing, opponentWeights } from '../tools/experiments/new-character-trio.mjs';
import { jobsFor, simulate } from '../tools/experiments/sim-new-trio.mjs';
import { playMatch } from '../tools/sim-v06.mjs';
import { createRng } from '../src/engine/rng.js';
import { rulesFor, makeGame, findTile } from './helpers.js';
import { applyAction } from '../src/engine/ai.js';

const IDS = Object.keys(NEW_CHARACTERS);
const HAND = ['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'];
const OTHERS = [
  ['sin', 'sin', '0', '90', '90', '=-√3', '=√3', '150'],
  ['cos', '135', '=√3', '=-1/√2', '120', '120', 'tan', '=0'],
  ['=-1', 'tan', 'tan', '120', '=1/√3', '90', '=-1/√2', '=-√3'],
];
const scene = (mode, draws = ['0', '=1']) => makeGame({ r: rulesFor(mode), hands: [HAND, ...OTHERS], draws });
const pass = g => { while (g.pending()?.type === 'claim') g.respond(g.pending().seat, { type: 'pass' }); };

for (const mode of ['math1', 'math2']) {
  test(`新3人 ${mode}：本物のロン・ツモを必ず宣言し、牌・得点ロジックは既存エンジンに委譲`, () => {
    for (const id of IDS) {
      const g = scene(mode); g.discard(0, findTile(g, 0, '0')); pass(g); g.discard(1, g.drawn);
      assert.equal(g.pending().ron, true);
      assert.equal(decideNewCharacter(publicGame(g, 0), 0, id, createRng(9)).type, 'ron');
      applyAction(g, 0, { type: 'ron' }); g.checkInvariants();
      const h = scene(mode, ['=1']); assert.ok(h.pending().canTsumo);
      assert.equal(decideNewCharacter(publicGame(h, 0), 0, id, createRng(9)).type, 'tsumo');
    }
  });
  test(`新3人 ${mode}：リーチ後はツモ切り、未知の非公開アクセスを拒否`, () => {
    const g = scene(mode, ['0', '=-1/√3', '=-√3/2', '=-1/√2', '=0']);
    g.discard(0, findTile(g, 0, '0'), { riichi: true }); pass(g);
    for (let s = 1; s < 4; s++) { g.discard(s, g.drawn); pass(g); }
    const v = publicGame(g, 0);
    assert.throws(() => v.hands, /non-public/); assert.throws(() => v.wall, /non-public/);
    assert.throws(() => v.viewFor(1), /private/); assert.throws(() => v.riichiOptions(2), /private/);
    for (const id of IDS) assert.deepEqual(decideNewCharacter(v, 0, id, createRng(1)), { type: 'discard', tile: g.drawn });
  });
  test(`新3人 ${mode}：山順・他家の手牌だけを変えても同じ判断、入力状態を変更しない`, () => {
    for (const id of IDS) {
      const a = scene(mode), b = scene(mode);
      [b.hands[1][0], b.hands[2][0]] = [b.hands[2][0], b.hands[1][0]];
      b.wall.reverse(); // 枚数と自分からの公開情報は同じ。未来だけを変更する。
      const before = JSON.stringify([a.hands, a.wall, a.events, a.riichi]);
      const info = { publicHistory: [0, 1, 2, 3].map(() => ({ rounds: 3, calls: 1, earlyRiichi: 0 })) };
      const x = decideNewCharacter(publicGame(a, 0), 0, id, createRng(987), info);
      const y = decideNewCharacter(publicGame(b, 0), 0, id, createRng(987), info);
      assert.deepEqual(x, y); assert.equal(JSON.stringify([a.hands, a.wall, a.events, a.riichi]), before);
      applyAction(a, 0, x); a.checkInvariants(); b.checkInvariants();
    }
  });
  test(`ゆうじん ${mode}：3刻子の不足枚数を独立総当たりと比較（同種6/9枚、公開枯れを含む）`, () => {
    const r = rulesFor(mode), rng = createRng(810);
    const sin = r.typeByKey.get('f:sin').idx, angle = r.typeByKey.get('a:30').idx;
    const held = new Uint8Array(r.types.length), left = new Uint8Array(r.types.length);
    held[sin] = 8; left[sin] = 1;
    assert.equal(tripletMissing(r, held, left), 1, '同じ関数牌を9枚必要とする');
    held[sin] = 6; held[angle] = 2; left[sin] = 0; left[angle] = 1;
    assert.equal(tripletMissing(r, held, left), 1, '同種6枚＋別の刻子');
    left[angle] = 0;
    assert.equal(tripletMissing(r, held, left), Infinity, '最後の1枚が公開情報上枯れている');
    for (let n = 0; n < 16; n++) {
      const counts = new Uint8Array(r.types.length), unseen = r.types.map(t => t.copies);
      for (let k = 0; k < 8; k++) { const t = rng.int(r.types.length); if (counts[t] < r.types[t].copies) { counts[t]++; unseen[t]--; } }
      for (let t = 0; t < unseen.length; t++) unseen[t] = rng.int(unseen[t] + 1);
      let best = Infinity;
      for (let a = 0; a < unseen.length; a++) for (let b = a; b < unseen.length; b++) for (let c = b; c < unseen.length; c++) {
        const need = new Map(); for (const t of [a, b, c]) need.set(t, (need.get(t) || 0) + 3);
        let miss = 0, valid = true;
        for (const [t, k] of need) { const m = Math.max(0, k - counts[t]); if (k > r.types[t].copies || m > unseen[t]) valid = false; miss += m; }
        if (valid) best = Math.min(best, miss);
      }
      assert.equal(tripletMissing(r, counts, unseen), best);
    }
  });
}
test('ゆうじん：実際のポン機会も見送る', () => {
  const g = scene('math1', ['0', 'sin']);
  // 元の手のsin30を残しつつsinをもう1枚。配牌の物理牌を交換する。
  const a = findTile(g, 0, '30'), b = findTile(g, 1, 'sin');
  g.hands[0][g.hands[0].indexOf(a)] = b; g.hands[1][g.hands[1].indexOf(b)] = a;
  g.discard(0, findTile(g, 0, '0')); pass(g); g.discard(1, g.drawn);
  assert.ok(g.pending().pon); assert.equal(g.pending().seat, 0);
  assert.deepEqual(decideNewCharacter(publicGame(g, 0), 0, 'yujin', createRng(1)), { type: 'pass' });
  g.checkInvariants();
});
test('たら：弱い待ちでリーチを保留し、2巡後には保留を打ち切る', () => {
  const g = scene('math2', ['0', '=-1/√3', '=-√3/2', '=-1/√2', '0', '=-1/√3', '=-√3/2', '=-1/√2', '0']);
  const v = publicGame(g, 0), flags = [];
  for (let i = 0; i < 3; i++) {
    assert.equal(g.pending().seat, 0); assert.equal(g.pending().canTsumo, false);
    const a = decideNewCharacter(v, 0, 'tara', createRng(1)); flags.push(a.riichi); applyAction(g, 0, a); pass(g);
    if (i < 2) for (let s = 1; s < 4; s++) { g.discard(s, g.drawn); pass(g); }
  }
  assert.deepEqual(flags, [false, false, true]); g.checkInvariants();
});
test('のっち：公開された鳴き・早いリーチの履歴で守備比重が変わり、有限範囲に収まる', () => {
  assert.deepEqual(opponentWeights(), [1, 1, 1, 1]);
  const w = opponentWeights([{ rounds: 8, calls: 12, earlyRiichi: 4 }, { rounds: 8, calls: 0, earlyRiichi: 0 }]);
  assert.ok(w[0] > 1); assert.ok(w[1] < 1); assert.ok(w.every(x => x >= 0.8 && x <= 1.35));
});
test('シミュレーター：--onlyや配列順に依存しないseed、4席を一巡、標本IDは一意', () => {
  const all = jobsFor({ groups: 2 }); const some = jobsFor({ groups: 2, only: 'tara-mid' });
  assert.deepEqual(all.filter(j => j.caseId === 'tara-mid'), some);
  assert.equal(new Set(all.map(j => j.sample)).size, all.length);
  assert.deepEqual(some.slice(0, 4).map(j => j.seats.indexOf('tara')), [0, 3, 2, 1]);
  assert.equal(new Set(some.slice(0, 4).map(j => j.seedBase)).size, 1);
});
test('シミュレーター：既存9人のみの対局は既存sim-v06と同じ結果・行動集計', () => {
  for (const mode of ['math1', 'math2']) {
    const j = jobsFor({ groups: 1, only: 'control-high', modes: [mode], lengths: [4] })[0];
    const a = simulate(j), b = playMatch(j);
    assert.deepEqual(a.scores, b.scores); assert.deepEqual(a.ranks, b.ranks);
    for (let s = 0; s < 4; s++) for (const k of ['rounds', 'wins', 'ron', 'tsumo', 'dealIn', 'chi', 'pon', 'riichi', 'discards']) assert.equal(a.stats[s][k], b.stats[s][k], `${mode} ${s} ${k}`);
  }
});
