// 初心者の部屋（版2・docs/67）：牌を選ぶ問題（数式・3つの面子・ツモと打牌）と待ち牌クイズ
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/engine/config.js';
import { createRules } from '../src/engine/rules.js';
import { createRoomState, roomTiles, ROOM_BANK_COUNT, pickRoomTile, checkRoom, nextRoom, roomHTML, enterStage, quizAnswer, quizHand } from '../src/ui/beginner-room.js';

const rules = createRules(makeConfig({ mode: 'math1' }));
function pick(s, numbers) { for (const i of numbers) pickRoomTile(s, rules, i); }

test('初心者の部屋は数学Ⅰに実在する牌のみを使い、9枚は和了可能', () => {
  assert.equal(ROOM_BANK_COUNT, 3);
  for (let n = 0; n < 3; n++) {
    const tiles = roomTiles(rules, n);
    for (const t of new Set(tiles)) assert.ok(tiles.filter((x) => x === t).length <= rules.types[t].copies);
  }
  assert.equal(roomTiles(rules, 0).length, 6);
  assert.equal(roomTiles(rules, 1).length, 9);
  assert.ok(rules.analyzeWin(rules.countsOf(roomTiles(rules, 1)), []));
});

test('第1段階：3枚以外は提出不可、誤答からの再挑戦でsin30=1/2を作れる → 3つの面子へ', () => {
  const s = createRoomState();
  enterStage(s, rules, 0);
  pick(s, [0, 2, 5]);
  assert.equal(checkRoom(s, rules), false);
  pick(s, [3, 4, 1]);
  assert.equal(checkRoom(s, rules), true);
  assert.match(roomHTML(s, rules), /次の課題へ/);
  assert.equal(nextRoom(s, rules), true);
  assert.deepEqual([s.stage, s.part, s.step.bank], [0, 1, 1]);
  pick(s, [3, 5, 2]); assert.equal(checkRoom(s, rules), true);
  pickRoomTile(s, rules, 3); assert.equal(s.selected.length, 0, '完成面子の牌は再選択できない');
  pick(s, [0, 8, 7]); checkRoom(s, rules);
  pick(s, [6, 1, 4]); checkRoom(s, rules);
  assert.equal(s.done, true);
  assert.equal(s.progress.cleared[0], true);
  assert.match(roomHTML(s, rules), /第2段階へ進む/);
});

test('第2段階の1つ目：9枚から-1牌を捨てると=1待ちになる → 実戦形式の「捨てる牌を選ぶ」へ', () => {
  const s = createRoomState();
  enterStage(s, rules, 1, 0);
  pickRoomTile(s, rules, 1); assert.equal(checkRoom(s, rules), false);
  pickRoomTile(s, rules, 5); assert.equal(checkRoom(s, rules), true);
  assert.equal(nextRoom(s, rules), true);
  assert.equal(s.practice.lessonId, 'D1');
});

test('待ち牌クイズ：正解はエンジンの和了判定（30°・150°）。不足・誤りを区別して知らせる', () => {
  assert.deepEqual(quizAnswer(rules, 0).map((t) => rules.types[t].key), ['a:30', 'a:150']);
  assert.equal(quizHand(rules, 0).length, 8);
  const s = createRoomState();
  enterStage(s, rules, 2, 1);
  assert.match(roomHTML(s, rules), /待ち牌を当てよう/);
  assert.equal(checkRoom(s, rules), false);
  assert.match(s.message, /選んでから/);
  pick(s, [1, 2]); // 30°・45°
  assert.equal(checkRoom(s, rules), false);
  assert.match(s.message, /和了にならない牌/);
  pick(s, [2]); // 45° を外す
  assert.equal(checkRoom(s, rules), false);
  assert.match(s.message, /あと1種類/);
  pick(s, [7]); // 150°
  assert.equal(checkRoom(s, rules), true);
  assert.equal(s.progress.cleared[2], true);
});

test('選択上限と初心者画面の導線', () => {
  const s = createRoomState();
  enterStage(s, rules, 0);
  assert.match(roomHTML(s, rules), /初心者の部屋/);
  pick(s, [0, 1, 2]);
  pickRoomTile(s, rules, 3);
  assert.equal(s.selected.length, 3);
  assert.match(roomHTML(s, rules), /data-action="br-check"/);
});
