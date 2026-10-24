// 手牌の表示順（src/ui/handorder.js）と、ドラッグ由来 click の抑止（src/ui/handdrag.js の createClickGuard）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultOrder, reconcileOrder, moveTo, insertionIndex, sameIdSet } from '../src/ui/handorder.js';
import { createClickGuard } from '../src/ui/handdrag.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { rules, makeGame, idx, junk, junk3 } from './helpers.js';

// 牌 ID → 種類（テスト用）：ID 10〜12 は同じ種類（同じ表示の牌）
const TYPES = { 1: 5, 2: 3, 3: 9, 10: 7, 11: 7, 12: 7, 20: 1, 21: 30 };
const typeOf = (id) => TYPES[id];

test('初期表示は従来の種類順。ツモ牌は右端', () => {
  assert.deepEqual(defaultOrder([1, 2, 3, 20], typeOf), [20, 2, 1, 3]);
  assert.deepEqual(defaultOrder([1, 2, 3, 20, 21], typeOf, 21), [20, 2, 1, 3, 21]);
  assert.deepEqual(reconcileOrder(null, [1, 2, 3, 20, 21], typeOf, 21), [20, 2, 1, 3, 21]);
  // 同じ種類は ID 順
  assert.deepEqual(defaultOrder([12, 10, 11], typeOf), [10, 11, 12]);
});

test('先頭・中央・末尾への移動。同じ表示の牌も ID で別々に動かせる', () => {
  const o = [20, 2, 10, 11, 12, 1, 3];
  assert.deepEqual(moveTo(o, 3, 0), [3, 20, 2, 10, 11, 12, 1]);
  assert.deepEqual(moveTo(o, 20, 3), [2, 10, 11, 20, 12, 1, 3]);
  assert.deepEqual(moveTo(o, 20, 6), [2, 10, 11, 12, 1, 3, 20]);
  assert.deepEqual(moveTo(o, 20, 99), [2, 10, 11, 12, 1, 3, 20], '範囲外は端に丸める');
  // 同じ表示（種類7）の 10・11・12 を別々に移動
  assert.deepEqual(moveTo(o, 11, 0), [11, 20, 2, 10, 12, 1, 3]);
  assert.deepEqual(moveTo(moveTo(o, 11, 0), 12, 6), [11, 20, 2, 10, 1, 3, 12]);
  assert.throws(() => moveTo(o, 99, 0));
  assert.deepEqual(o, [20, 2, 10, 11, 12, 1, 3], '入力は変更しない');
});

test('打牌・チーで抜けた牌だけを削除し、残りの順番を保つ。新しいツモ牌は右端', () => {
  const custom = [3, 10, 1, 12, 2, 11, 20];
  // 打牌（12 を捨てた）
  assert.deepEqual(reconcileOrder(custom, [3, 10, 1, 2, 11, 20], typeOf), [3, 10, 1, 2, 11, 20]);
  // チー（1 と 2 が面子へ）
  assert.deepEqual(reconcileOrder(custom, [3, 10, 12, 11, 20], typeOf), [3, 10, 12, 11, 20]);
  // ツモ（21 が増えた）→ 右端
  assert.deepEqual(reconcileOrder(custom, [3, 10, 1, 12, 2, 11, 20, 21], typeOf, 21), [3, 10, 1, 12, 2, 11, 20, 21]);
  // ロン和了などで複数増えた場合も右端（従来の並びの順）
  assert.deepEqual(reconcileOrder([3], [3, 21, 20], typeOf), [3, 20, 21]);
  // 不正な order（重複・手牌にない ID）でも集合は一致
  const r = reconcileOrder([3, 3, 99, 1], [1, 3, 20], typeOf);
  assert.deepEqual(r, [3, 1, 20]);
  assert.ok(sameIdSet(r, [1, 3, 20]));
});

test('挿入位置の計算', () => {
  const centers = [10, 40, 70, 100];
  assert.equal(insertionIndex(centers, 0), 0);
  assert.equal(insertionIndex(centers, 25), 1);
  assert.equal(insertionIndex(centers, 70), 2, '中心ちょうどは左側に入れる');
  assert.equal(insertionIndex(centers, 999), 4);
  assert.equal(insertionIndex([], 5), 0);
});

test('sameIdSet：重複・欠落・余分を検出', () => {
  assert.ok(sameIdSet([1, 2, 3], [3, 1, 2]));
  assert.ok(!sameIdSet([1, 2, 2], [1, 2, 3]));
  assert.ok(!sameIdSet([1, 2], [1, 2, 3]));
  assert.ok(!sameIdSet([1, 2, 4], [1, 2, 3]));
});

test('実際の対局（AI 4人 20局）で毎手、表示順の集合がエンジンの手牌と一致し、残った牌の相対順序が保たれる', () => {
  for (let n = 0; n < 20; n++) {
    const g = new Game({ rules, seed: 3000 + n, dealer: n % 4, players: [0, 1, 2, 3].map(() => ({ kind: 'ai', personality: 'speed' })) });
    const rng = createRng(n);
    const t = (id) => g.typeOf(id);
    let order = null;
    let steps = 0;
    while (g.pending() && steps++ < 600) {
      const p = g.pending();
      const drawn = p.seat === 0 && p.type === 'turn' ? g.drawn : null;
      const next = reconcileOrder(order, g.hands[0], t, drawn);
      assert.ok(sameIdSet(next, g.hands[0]), '集合が一致');
      if (order) {
        // 残った牌の相対順序は変わらない
        const kept = order.filter((id) => next.includes(id));
        assert.deepEqual(next.slice(0, kept.length), kept);
      }
      // ときどきプレイヤーが並び替える
      order = rng.int(3) === 0 ? moveTo(next, next[rng.int(next.length)], rng.int(next.length)) : next;
      applyAction(g, p.seat, decide(g, p.seat, 'speed', rng));
    }
  }
});

test('チー後も残りの手牌の並び順を保つ（実際の Game）', () => {
  const g = makeGame({
    hands: [['=1/2', ...junk.slice(1)], ['sin', '30', 'cos', 'cos', '180', '180', '=√3', '=√3'], junk3, ['cos', 'tan', '270', '270', '=-√3/2', '=-√3/2', '=1/√3', '=1/√3']],
    draws: ['=-1/√3'],
  });
  const t = (id) => g.typeOf(id);
  // seat1 の手牌を表示順として扱い、自由に並べておく
  let order = reconcileOrder(null, g.hands[1], t);
  order = moveTo(order, order[0], order.length - 1);
  order = moveTo(order, order[3], 0);
  const before = order.slice();
  g.discard(0, g.hands[0].find((id) => g.typeOf(id) === idx('=1/2')));
  g.respond(1, { type: 'chi', option: 0 });
  const after = reconcileOrder(order, g.hands[1], t);
  assert.ok(sameIdSet(after, g.hands[1]));
  assert.equal(after.length, 6);
  assert.deepEqual(after, before.filter((id) => g.hands[1].includes(id)), 'チーで抜けた2枚以外は同じ順番');
});

// ---- ドラッグ由来 click の抑止 ----
function clock() { let t = 0; return { now: () => t, tick: (ms) => { t += ms; } }; }

test('ドラッグしたポインターの click だけを1回抑止（Chrome：click に pointerId がある）', () => {
  const c = clock();
  const g = createClickGuard({ now: c.now });
  g.pointerDown(); // ドラッグ開始の押下
  g.arm(7); // 指を離した
  assert.equal(g.shouldSuppress({ detail: 1, pointerId: 7 }), true);
  assert.equal(g.shouldSuppress({ detail: 1, pointerId: 7 }), false, '2回目は抑止しない');
});

test('iOS Safari：合成 click に pointerId がなくても、ドラッグ直後の click は抑止', () => {
  const c = clock();
  const g = createClickGuard({ now: c.now });
  g.arm(3);
  c.tick(5);
  assert.equal(g.shouldSuppress({ detail: 1 }), true);
  g.arm(3);
  assert.equal(g.shouldSuppress({ detail: 1, pointerId: -1 }), true);
});

test('新しい押下から始まる通常タップは抑止しない（時間の窓に依存しない）', () => {
  const c = clock();
  const g = createClickGuard({ now: c.now });
  g.arm(3); // ドラッグ終了（click が来なかった）
  c.tick(50);
  g.pointerDown(); // すぐに次のタップ
  assert.equal(g.shouldSuppress({ detail: 1 }), false, 'ドラッグ直後の通常タップは有効');
  assert.equal(g.shouldSuppress({ detail: 1, pointerId: 4 }), false);
});

test('別のポインター・キーボードの click は抑止しない。期限切れも解除', () => {
  const c = clock();
  const g = createClickGuard({ now: c.now, ttlMs: 1000 });
  g.arm(3);
  assert.equal(g.shouldSuppress({ detail: 1, pointerId: 9 }), false, '別のポインター');
  assert.equal(g.shouldSuppress({ detail: 0 }), false, 'キーボード由来');
  assert.equal(g.isArmed(), true);
  c.tick(1001);
  assert.equal(g.shouldSuppress({ detail: 1 }), false, '期限切れ');
});
