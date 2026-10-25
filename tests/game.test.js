import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine/game.js';
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { decide, applyAction, handValue, chooseDiscard } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { rules, makeGame, findTile, junk, junk2, junk3, idx, meld, counts } from './helpers.js';

const harmless3 = ['cos', 'tan', '270', '270', '=-√3/2', '=-√3/2', '=1/√3', '=1/√3'];

test('配牌：親9枚（ツモ済み）・子8枚、168枚が重複・消滅なく配置される', () => {
  const g = new Game({ rules, seed: 7, dealer: 2, players: [0, 1, 2, 3].map(() => ({ kind: 'ai', personality: 'speed' })) });
  assert.deepEqual(g.hands.map((h) => h.length), [8, 8, 9, 8]);
  assert.equal(g.wall.length, 168 - 33);
  assert.equal(g.pending().seat, 2);
  g.checkInvariants();
});

test('シャッフルはシードで再現可能', () => {
  const p = [0, 1, 2, 3].map(() => ({ kind: 'ai', personality: 'speed' }));
  const a = new Game({ rules, seed: 99, players: p });
  const b = new Game({ rules, seed: 99, players: p });
  const c = new Game({ rules, seed: 100, players: p });
  assert.deepEqual(a.wall, b.wall);
  assert.notDeepEqual(a.wall, c.wall);
});

function chiSetup() {
  return makeGame({
    hands: [
      ['=1/2', 'sin', 'sin', '0', '0', '90', '=-√3', '=-√3'],
      ['sin', '30', 'cos', 'cos', '180', '180', '=√3', '=√3'],
      junk3,
      harmless3,
    ],
    draws: ['=-1/√3', '150', '225', '240', '315'],
  });
}

test('チー：上家の打牌で数学的に正しい面子のみ。手牌6枚→打牌で5枚、手番はチーした人の次へ', () => {
  const g = chiSetup();
  g.checkInvariants();
  g.discard(0, findTile(g, 0, '=1/2'));
  const p = g.pending();
  assert.equal(p.type, 'claim');
  assert.equal(p.seat, 1);
  assert.equal(p.ron, false);
  assert.equal(p.chi.length, 1);
  assert.equal(rules.melds[p.chi[0].meld].key, 'sin30=1/2');
  g.respond(1, { type: 'chi', option: 0 });
  g.checkInvariants();
  assert.equal(g.hands[1].length, 6);
  assert.equal(g.melds[1].length, 1);
  assert.equal(g.rivers[0].length, 0, '鳴かれた牌は河から公開面子へ移動');
  const p2 = g.pending();
  assert.equal(p2.type, 'turn');
  assert.equal(p2.seat, 1);
  assert.equal(p2.canTsumo, false, 'チー直後はツモ和了できない');
  assert.equal(g.wall.length, 168 - 33, 'チーした人はツモしない');
  g.discard(1, findTile(g, 1, '=√3'));
  g.checkInvariants();
  assert.equal(g.hands[1].length, 5);
  assert.equal(g.pending().seat, 2, '手番はチーした人の下家へ');
  assert.equal(g.hands[2].length, 9);
});

test('チーは上家（直前の打牌者）からのみ。対面・下家の打牌ではチーできない', () => {
  const g = makeGame({
    hands: [junk, junk2, ['=1/2', 'sin', 'sin', '0', '0', '90', '=-√3', '=-√3'], ['sin', '30', 'cos', 'cos', '180', '180', '=√3', '=√3']],
    draws: ['=-1/√3', '=-1/√3', '225'],
  });
  // seat0 → seat1 → seat2 と進め、seat2 が =1/2 を捨てると、上家が seat2 である seat3 だけがチー可能
  g.discard(0, g.drawn);
  g.discard(1, g.drawn);
  assert.equal(g.pending().seat, 2);
  g.discard(2, findTile(g, 2, '=1/2'));
  const p = g.pending();
  assert.equal(p.seat, 3);
  assert.equal(p.chi.length, 1);
  // seat0 の打牌で seat3 はチー不可（seat3 の下家への打牌は対象外）
  const g2 = makeGame({ hands: [['=1/2', ...junk.slice(1)], junk2, junk3, ['sin', '30', ...junk2.slice(2)]], draws: ['=-1/√3'] });
  g2.discard(0, findTile(g2, 0, '=1/2'));
  assert.equal(g2.pending().type, 'turn', 'seat3 にはチーの機会がない');
  assert.equal(g2.pending().seat, 1);
});

function ronSetup() {
  return makeGame({
    hands: [
      ['=1', ...junk.slice(1)],
      ['sin', '90', ...junk2.slice(2)], // =1 でチー可能（sin90=1）
      ['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], // =1 でロン（tan45=1）
      ['sin', '150', '=1/2', 'sin', '180', '=0', 'cos', '0'], // =1 でロン（cos0=1）
    ],
    draws: ['=-1/√3'],
  });
}

test('ロン：アタマハネ（打牌者から近い順）。ロンはチーより優先', () => {
  const g = ronSetup();
  g.discard(0, findTile(g, 0, '=1'));
  let p = g.pending();
  assert.equal(p.seat, 1);
  assert.equal(p.ron, false);
  assert.equal(p.chi.length, 1);
  g.respond(1, { type: 'chi', option: 0 }); // チーを選んでも、後続のロンが優先される
  p = g.pending();
  assert.equal(p.seat, 2);
  assert.equal(p.ron, true);
  g.respond(2, { type: 'ron' });
  assert.equal(g.result.winner, 2);
  assert.equal(g.result.how, 'ron');
  assert.equal(g.result.from, 0);
  assert.deepEqual(g.result.analysis.yaku.map((y) => y.name), ['三関制覇']);
  assert.equal(g.melds[1].length, 0, 'チーは取り消し');
  g.checkInvariants();
});

test('ロン見送り：次のロン候補へ。全員見送ればチーが成立', () => {
  const g = ronSetup();
  g.discard(0, findTile(g, 0, '=1'));
  g.respond(1, { type: 'chi', option: 0 });
  g.respond(2, { type: 'pass' });
  assert.equal(g.pending().seat, 3);
  g.respond(3, { type: 'pass' });
  assert.equal(g.melds[1].length, 1);
  assert.equal(g.pending().seat, 1);
  assert.equal(g.pending().type, 'turn');
  g.checkInvariants();
});

test('ロン見送りでも進行不能にならない（全員パス→次の人がツモ）', () => {
  const g = ronSetup();
  g.discard(0, findTile(g, 0, '=1'));
  g.respond(1, { type: 'pass' });
  g.respond(2, { type: 'pass' });
  g.respond(3, { type: 'pass' });
  assert.equal(g.pending().type, 'turn');
  assert.equal(g.pending().seat, 1);
  assert.equal(g.hands[1].length, 9);
  g.checkInvariants();
});

test('ツモ和了と、不正な操作の拒否', () => {
  const g = makeGame({
    hands: [['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], junk, junk2, junk3],
    draws: ['=1'],
  });
  assert.equal(g.pending().canTsumo, true);
  assert.throws(() => g.discard(1, g.hands[1][0]), /not 1's turn/);
  assert.throws(() => g.respond(0, { type: 'pass' }));
  g.tsumo(0);
  assert.equal(g.result.how, 'tsumo');
  assert.equal(g.result.points, 2);
  assert.equal(g.pending(), null);
  g.checkInvariants();
});

test('チー済みの手は、役のない完成形ではツモ和了できない', () => {
  // seat1: sin30 をチー → 手の内 cos,180,=-1(cos180=-1), sin,120 + ツモ =√3/2 → sin30, cos180, sin120: 役なし
  const g = makeGame({
    hands: [
      ['=1/2', ...junk.slice(1)],
      ['sin', '30', 'cos', '180', '=-1', 'sin', '120', '=√3'],
      junk3, harmless3,
    ],
    draws: ['=-1/√3', '=-1/√3', '=1/√2', '=1/√2', '=√3/2'],
  });
  g.discard(0, findTile(g, 0, '=1/2'));
  g.respond(1, { type: 'chi', option: 0 });
  g.discard(1, findTile(g, 1, '=√3'));
  for (const s of [2, 3, 0]) g.discard(s, g.drawn);
  assert.equal(g.pending().seat, 1);
  assert.equal(g.pending().type, 'turn');
  assert.equal(g.typeOf(g.drawn), idx('=√3/2'));
  assert.equal(g.pending().canTsumo, false, '役なし');
  // 門前なら同じ形で和了できる
  assert.ok(rules.analyzeWin(counts(['sin', '30', '=1/2', 'cos', '180', '=-1', 'sin', '120', '=√3/2'])));
});

test('流局：全員ツモ切り・宣言なしなら山が尽きて流局。牌は保存される', () => {
  const players = [0, 1, 2, 3].map(() => ({ kind: 'ai', personality: 'speed' }));
  const g = new Game({ rules, seed: 5, players });
  let n = 0;
  while (g.pending()) {
    const p = g.pending();
    if (p.type === 'turn') g.discard(p.seat, g.drawn);
    else g.respond(p.seat, { type: 'pass' });
    if (++n % 10 === 0) g.checkInvariants();
  }
  assert.equal(g.result.type, 'draw');
  assert.equal(g.wall.length, 0);
  assert.equal(g.rivers.reduce((s, r) => s + r.length, 0), 168 - 32);
  g.checkInvariants();
});

test('AIへ渡す情報には他家の手牌・山の並びが含まれない', () => {
  const g = chiSetup();
  const v = g.viewFor(1);
  assert.equal(v.hand.length, 8);
  assert.deepEqual(v.hand.map((h) => h.id).sort(), g.hands[1].slice().sort());
  assert.ok(!('wall' in v) && !('hands' in v));
  assert.equal(typeof v.wallCount, 'number');
  assert.equal(v.drawn, null, '他人の手番のツモ牌は見えない');
  const json = JSON.stringify(v);
  for (const id of g.hands[0]) assert.ok(!json.includes(`"id":${id},`) || g.hands[1].includes(id));
});

test('AI：和了できればツモ・ロンする', () => {
  const g = makeGame({ hands: [['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], junk, junk2, junk3], draws: ['=1'] });
  assert.deepEqual(decide(g, 0, 'value', createRng(1)), { type: 'tsumo' });
  const r = ronSetup();
  r.discard(0, findTile(r, 0, '=1'));
  r.respond(1, { type: 'pass' });
  assert.deepEqual(decide(r, 2, 'closed', createRng(1)), { type: 'ron' });
});

test('AI：完成面子を崩さずに不要牌を捨てる', () => {
  const g = makeGame({
    hands: [['sin', '30', '=1/2', 'cos', '180', '=-1', '=-√3', '=-√3'], junk, junk2, junk3],
    draws: ['tan'],
  });
  for (const pers of ['speed', 'value', 'closed']) {
    const d = chooseDiscard(rules, g.viewFor(0), pers, createRng(3));
    assert.equal(rules.types[g.typeOf(d.id)].value, '-√3', pers);
  }
});

test('AI：門前重視型はチーしない／チー後の手は役のない完成形を評価しない', () => {
  const g = chiSetup();
  g.discard(0, findTile(g, 0, '=1/2'));
  assert.deepEqual(decide(g, 1, 'closed', createRng(1)), { type: 'pass' });
  // 公開 sin30, cos180 のとき、残り1面子 cos0=1 は役なし（0評価）、tan45=1 は三関制覇
  const ex = [meld('sin', 30, '=1/2').idx, meld('cos', 180, '=-1').idx];
  const unseen = rules.types.map((t) => t.copies);
  const noYaku = handValue(rules, counts(['cos', '0', '=1']), ex, unseen, 'speed');
  const closedSame = handValue(rules, counts(['cos', '0', '=1', 'sin', '30', '=1/2', 'cos', '180', '=-1']).map((x) => x), [], unseen, 'speed');
  assert.ok(closedSame > 0);
  const withYaku = handValue(rules, counts(['tan', '45', '=1']), ex, unseen, 'speed');
  assert.ok(withYaku > noYaku * 3, `${withYaku} vs ${noYaku}`);
});

function runAIGame(r, seed, pers) {
  const players = pers.map((p) => ({ kind: 'ai', personality: p }));
  const g = new Game({ rules: r, seed, dealer: seed % 4, players });
  const rng = createRng(seed);
  let steps = 0;
  while (g.pending()) {
    const p = g.pending();
    applyAction(g, p.seat, decide(g, p.seat, pers[p.seat], rng));
    g.checkInvariants();
    assert.ok(++steps < 1000, 'progress');
  }
  return g;
}

test('AI 4人の自動対局 60局：毎手の不変条件（牌の保存・手牌枚数・公開面子の正しさ）を満たし必ず終局', () => {
  const lineups = [['speed', 'value', 'closed', 'speed'], ['value', 'value', 'speed', 'closed']];
  let wins = 0;
  let chis = 0;
  for (let i = 0; i < 60; i++) {
    const g = runAIGame(rules, 1000 + i, lineups[i % 2]);
    chis += g.melds.reduce((s, m) => s + m.length, 0);
    if (g.result.type === 'win') {
      wins++;
      const w = g.result.winner;
      const a = g.result.analysis;
      if (g.melds[w].length) assert.ok(a.hasYaku, 'チーした和了者は役あり');
      // 和了形の再検証
      const re = rules.analyzeWin(g.countsOf(g.hands[w]), g.exposedMelds(w));
      assert.equal(re.points, a.points);
    }
  }
  assert.ok(wins > 0);
  assert.ok(chis > 0, 'チーが発生している');
});

test('360°なし設定（164枚）でも自動対局が成立する', () => {
  const r = createRules(makeConfig({ legacy: true, disableAngles: [360] }));
  for (let i = 0; i < 10; i++) runAIGame(r, 50 + i, ['speed', 'value', 'closed', 'value']);
});
