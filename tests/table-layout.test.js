// Ver.0.7 麻雀卓の配置（河の折り返し・卓の大きさ・席の向き）
import test from 'node:test';
import assert from 'node:assert/strict';
import { SEAT_AREA, SEAT_ROT, RIVER_ROW, riverRows, boardShape } from '../src/ui/table-layout.js';

const sizes = (rows) => rows.map(([a, b]) => b - a);

test('席の位置と向き：自分は下、下家は右（−90°）、対面は上（180°）、上家は左（90°）', () => {
  assert.deepEqual([...SEAT_AREA], ['me', 'right', 'top', 'left']);
  assert.deepEqual([...SEAT_ROT], [0, -90, 180, 90]);
  assert.equal(RIVER_ROW, 6);
});

test('自分・対面の河は6枚ごとに折り返す（7・13・19枚目で次の行）', () => {
  for (const seat of [0, 2]) {
    assert.deepEqual(riverRows(seat, 0), []);
    assert.deepEqual(sizes(riverRows(seat, 6)), [6]);
    assert.deepEqual(sizes(riverRows(seat, 7)), [6, 1]);
    assert.deepEqual(sizes(riverRows(seat, 12)), [6, 6]);
    assert.deepEqual(sizes(riverRows(seat, 13)), [6, 6, 1]);
    assert.deepEqual(sizes(riverRows(seat, 18)), [6, 6, 6]);
    assert.deepEqual(sizes(riverRows(seat, 19)), [6, 6, 6, 1]);
    assert.deepEqual(sizes(riverRows(seat, 34)), [6, 6, 6, 6, 6, 4]);
  }
});

test('左右の河：1〜6・7〜12枚目で行、13枚目以降は3行目を延長（全ての牌を順に1回ずつ）', () => {
  for (const seat of [1, 3]) {
    assert.deepEqual(sizes(riverRows(seat, 5)), [5]);
    assert.deepEqual(sizes(riverRows(seat, 12)), [6, 6]);
    assert.deepEqual(sizes(riverRows(seat, 18)), [6, 6, 6]);
    assert.deepEqual(sizes(riverRows(seat, 23)), [6, 6, 11]);
    for (const n of [0, 1, 6, 13, 25, 40]) {
      const idx = riverRows(seat, n).flatMap(([a, b]) => Array.from({ length: b - a }, (_, i) => a + i));
      assert.deepEqual(idx, Array.from({ length: n }, (_, i) => i));
    }
  }
});

test('卓の大きさ：3行が基本、対面・自分は行数分だけ伸びる。左右の延長はまず角に入る', () => {
  assert.deepEqual(boardShape([0, 0, 0, 0]), { top: 3, bottom: 3, lenLeft: 6, lenRight: 6, side: 6 });
  assert.deepEqual(boardShape([18, 18, 18, 18]), { top: 3, bottom: 3, lenLeft: 6, lenRight: 6, side: 6 });
  const s19 = boardShape([19, 19, 19, 19]);
  assert.deepEqual([s19.top, s19.bottom, s19.lenLeft, s19.lenRight, s19.side], [4, 4, 7, 7, 6]);
  // 3行の角には4枚まで入る（高さ 3×30/22 枚分）。22枚（3行目10枚）までは中央を伸ばさない
  assert.equal(boardShape([18, 22, 18, 22]).side, 6);
  assert.equal(boardShape([18, 23, 18, 23]).side, 7);
  // 数学Ⅱの長い局：中央は角に入りきらない分だけ伸びる
  const m2 = boardShape([30, 30, 30, 30]);
  assert.deepEqual([m2.top, m2.bottom, m2.lenLeft, m2.lenRight], [5, 5, 18, 18]);
  assert.equal(m2.side, 18 - Math.floor(5 * 30 / 22));
});
