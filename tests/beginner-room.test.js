import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/engine/config.js';
import { createRules } from '../src/engine/rules.js';
import { createRoomState, roomTiles, ROOM_STEP_COUNT, pickRoomTile, checkRoom, nextRoom, roomHTML } from '../src/ui/beginner-room.js';

const rules = createRules(makeConfig({ mode: 'math1' }));
function pick(s, numbers) { for (const i of numbers) pickRoomTile(s, rules, i); }

test('初心者の部屋は数学Ⅰに実在する牌のみを使い、9枚は和了可能', () => {
  assert.equal(ROOM_STEP_COUNT, 3);
  for (let n = 0; n < 3; n++) {
    const tiles = roomTiles(rules, n);
    for (const t of new Set(tiles)) {
      assert.ok(tiles.filter((x) => x === t).length <= rules.types[t].copies);
    }
  }
  assert.equal(roomTiles(rules, 0).length, 6);
  assert.equal(roomTiles(rules, 1).length, 9);
  assert.ok(rules.analyzeWin(rules.countsOf(roomTiles(rules, 1)), []));
});

test('第1段階：3枚以外は提出不可、誤答からの再挑戦でsin30=1/2を作れる', () => {
  const s = createRoomState();
  pick(s, [0, 2, 5]);
  assert.equal(checkRoom(s, rules), false);
  assert.equal(s.done, false);
  pick(s, [3, 4, 1]);
  assert.equal(checkRoom(s, rules), true);
  assert.equal(s.done, true);
  assert.equal(nextRoom(s), true);
  assert.equal(s.stage, 1);
});

test('第2段階：物理牌の重複選択を防ぎ、9枚を3面子にまとめる', () => {
  const s = createRoomState();
  s.stage = 1;
  pick(s, [3, 5, 2]); assert.equal(checkRoom(s, rules), true);
  pickRoomTile(s, rules, 3); assert.equal(s.selected.length, 0, '完成面子の牌は再選択できない');
  pick(s, [0, 8, 7]); assert.equal(checkRoom(s, rules), true);
  pick(s, [6, 1, 4]); assert.equal(checkRoom(s, rules), true);
  assert.equal(s.groups.length, 3);
  assert.equal(s.done, true);
  assert.equal(nextRoom(s), true);
  assert.equal(s.stage, 2);
});

test('第3段階：9枚から-1牌を捨てると=1待ちになる', () => {
  const s = createRoomState();
  s.stage = 2;
  pickRoomTile(s, rules, 1); assert.equal(checkRoom(s, rules), false);
  pickRoomTile(s, rules, 5); assert.equal(checkRoom(s, rules), true);
  assert.equal(s.done, true);
  assert.match(roomHTML(s, rules), /第4段階へ進む/);
  assert.equal(nextRoom(s, rules), true, '第3段階の後は第4段階へ進む');
  assert.equal(s.stage, 3);
  assert.equal(s.practice.lessonId, '4A');
});

test('選択上限と初心者画面の導線', () => {
  const s = createRoomState();
  assert.match(roomHTML(s, rules), /初心者の部屋/);
  pick(s, [0, 1, 2]);
  pickRoomTile(s, rules, 3);
  assert.equal(s.selected.length, 3);
  assert.match(roomHTML(s, rules), /data-action="br-check"/);
});
