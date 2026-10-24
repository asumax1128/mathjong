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

// ---- タップとして無効になった操作の click の抑止（createClickGuard：操作ごとの記録） ----
function clock() { let t = 0; return { now: () => t, tick: (ms) => { t += ms; } }; }
const down = (g, pointerId, isPrimary = true) => g.pointerDown({ pointerId, isPrimary });
const click = (g, init) => g.shouldSuppress({ detail: 1, ...init });

test('通常のタップの click は抑止しない。2回タップ（打牌）も両方有効', () => {
  const c = clock();
  const g = createClickGuard({ now: c.now });
  down(g, 1); g.release(1);
  assert.equal(click(g, { pointerId: 1 }), false);
  c.tick(150);
  down(g, 2); g.release(2);
  assert.equal(click(g, {}), false, 'iOS の合成 click（pointerId なし）も通常タップなら有効');
});

test('無効になった操作の click を抑止（pointerId あり・なし・-1）。同じ操作の2回目の click はない', () => {
  const c = clock();
  const g = createClickGuard({ now: c.now });
  down(g, 7); g.invalidate(7); g.release(7);
  assert.equal(click(g, { pointerId: 7 }), true);
  assert.equal(click(g, { pointerId: 7 }), false, '割り当てる操作がない click は抑止しない');
  down(g, 8); g.invalidate(8); g.release(8);
  assert.equal(click(g, {}), true, 'pointerId なし');
  down(g, 9); g.invalidate(9); g.release(9);
  assert.equal(click(g, { pointerId: -1 }), true, 'pointerId -1');
});

test('新P2：無効操作 A の古い click が、新しい主ポインター B の押下の後に届いても抑止。B の click は受理', () => {
  for (const oldClick of [{ pointerId: 3 }, {}]) {
    const c = clock();
    const g = createClickGuard({ now: c.now });
    down(g, 3); g.invalidate(3); g.release(3); // 操作 A（無効）終了。A の click はまだ届いていない
    c.tick(20);
    down(g, 4); // 新しい主ポインター B（押している最中）
    assert.equal(click(g, oldClick), true, `B を離す前の A 由来の click（${JSON.stringify(oldClick)}）は抑止`);
    c.tick(60);
    g.release(4);
    assert.equal(click(g, { pointerId: 4 }), false, 'B 由来の click は受理');
  }
  // B の click が pointerId なしでも受理
  const c = clock();
  const g = createClickGuard({ now: c.now });
  down(g, 3); g.invalidate(3); g.release(3);
  down(g, 4);
  assert.equal(click(g, {}), true);
  g.release(4);
  assert.equal(click(g, {}), false, 'B 由来の合成 click は受理');
});

test('A の古い click が B の click より後に届いても抑止（pointerId なし）', () => {
  const c = clock();
  const g = createClickGuard({ now: c.now });
  down(g, 3); g.invalidate(3); g.release(3);
  down(g, 4); g.release(4);
  assert.equal(click(g, {}), false, '最後に離された B の click');
  assert.equal(click(g, {}), true, '残っている A の click');
});

test('同じ pointerId の再利用（マウス）：押している最中の新しい操作に古い click を割り当てない', () => {
  const c = clock();
  const g = createClickGuard({ now: c.now });
  down(g, 1); g.invalidate(1); g.release(1); // マウスのドラッグ（無効）
  down(g, 1); // 次のクリック（押している最中）
  assert.equal(click(g, { pointerId: 1 }), true, '古いドラッグの click は抑止');
  g.release(1);
  assert.equal(click(g, { pointerId: 1 }), false, '新しいクリックの click は受理');
});

test('2本指：記録はポインターごとに分かれ、混同しない。2本目の押下で1本目の記録は終わらない', () => {
  const c = clock();
  const g = createClickGuard({ now: c.now });
  down(g, 3); // 1本目
  down(g, 5, false); // 2本目
  g.invalidate(3);
  g.release(5);
  assert.equal(click(g, { pointerId: 5 }), false, '2本目のタップは有効');
  assert.equal(g.isArmed(), true, '1本目はまだ押している');
  g.release(3);
  assert.equal(click(g, { pointerId: 3 }), true, '1本目の click は抑止');
});

test('新P3：pointercancel（release）の後に invalidate されても、期限は離した時点から始まる', () => {
  for (const order of ['release-first', 'invalidate-first']) {
    const c = clock();
    const g = createClickGuard({ now: c.now, ttlMs: 1000 });
    down(g, 3);
    if (order === 'release-first') { g.release(3); g.invalidate(3); } else { g.invalidate(3); g.release(3); }
    c.tick(999);
    assert.equal(g.isArmed(), true, `${order}：期限直前は有効`);
    c.tick(2);
    assert.equal(g.isArmed(), false, `${order}：期限経過後は解除`);
    assert.equal(g.size(), 0, '記録も削除');
  }
});

test('同じ操作の二重の release・別のポインターの release で期限が壊れない', () => {
  const c = clock();
  const g = createClickGuard({ now: c.now, ttlMs: 1000 });
  down(g, 3); g.invalidate(3); g.release(3);
  c.tick(600);
  g.release(3); // 二重
  g.release(9); // 別のポインター
  c.tick(401);
  assert.equal(g.isArmed(), false, '最初の release から 1000ms で期限切れ');
  down(g, 4); g.invalidate(4);
  g.release(9);
  c.tick(5000);
  assert.equal(g.isArmed(), true, '別のポインターの release では期限を始めない（まだ押している）');
});

test('pointerup が届かない操作：次の主ポインターの押下で終了扱い、押下から maxAgeMs で削除', () => {
  const c = clock();
  const g = createClickGuard({ now: c.now, ttlMs: 1000, maxAgeMs: 10000 });
  down(g, 3); g.invalidate(3); // pointerup が届かない
  c.tick(200);
  down(g, 4); // 次の主ポインター → 3 は終了扱い
  assert.equal(click(g, {}), true, '3 の遅れた click は抑止');
  const g2 = createClickGuard({ now: c.now, ttlMs: 1000, maxAgeMs: 10000 });
  down(g2, 7); g2.invalidate(7);
  c.tick(10001);
  assert.equal(g2.size(), 0, '押したまま maxAgeMs を過ぎた記録は削除');
});

test('記録は上限件数まで（無制限に増えない）', () => {
  const c = clock();
  const g = createClickGuard({ now: c.now, maxRecords: 8 });
  for (let i = 0; i < 50; i++) { down(g, i); g.release(i); }
  assert.ok(g.size() <= 8);
});

test('キーボード由来（detail 0）の click は抑止せず、記録も消費しない。期限切れ後の遅れた click は抑止できない（残余リスク）', () => {
  const c = clock();
  const g = createClickGuard({ now: c.now, ttlMs: 1000 });
  down(g, 3); g.invalidate(3); g.release(3);
  assert.equal(g.shouldSuppress({ detail: 0 }), false);
  assert.equal(g.isArmed(), true, 'キーボードの click では消費しない');
  c.tick(1001);
  assert.equal(click(g, { pointerId: 3 }), false, '期限切れ後に届いた click は記録がないため抑止できない');
});

test('P2-2：同じ pointerId（マウス）の pointerup が届かなかった操作は、次の主ポインターの押下で終了扱い。新しい操作の click は受理', () => {
  const c = clock();
  const g = createClickGuard({ now: c.now, ttlMs: 1000 });
  down(g, 1); g.invalidate(1); // マウスのドラッグ（pointerup が届かない）
  c.tick(300);
  down(g, 1); // 同じ pointerId の新しい押下 → 前の記録は終了扱い（期限が始まる）
  g.release(1);
  assert.equal(click(g, { pointerId: 1 }), false, '新しい操作の click は受理');
  c.tick(1001);
  assert.equal(g.size(), 0, '前の記録も期限で削除（未終了のまま残らない）');
});
