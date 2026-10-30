// リーチ宣言料（供託）・オーラスのアガリやめ（docs/65）：src/engine/match.js の試合の精算。
// 持ち点＋供託の合計は常に400、試合終了時は供託0。過去の版（宣言料なし）の試合は従来の精算のまま。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine/game.js';
import { applyAction } from '../src/engine/ai.js';
import { decideCharacter, CHARACTER_ROSTER, newPublicHistory, recordPublicRound } from '../src/engine/characters.js';
import { createMatch, applyRoundResult, dealerOf, matchAt, potTotal, ranks, RIICHI_DEPOSIT } from '../src/engine/match.js';
import { createRng } from '../src/engine/rng.js';
import { rulesFor } from './helpers.js';

const CUR = { riichiDeposit: RIICHI_DEPOSIT, agariYame: true };
const R = (...seats) => [0, 1, 2, 3].map((s) => (seats.includes(s) ? { tile: 900 + s, turn: 1 } : null)); // Game.riichi の形
const total = (m) => m.scores.reduce((a, b) => a + b, 0) + potTotal(m);
const ron = (winner, from, points, tile = 1) => ({ type: 'win', winner, how: 'ron', from, points, tile });
const tsumo = (winner, points) => ({ type: 'win', winner, how: 'tsumo', from: null, points, tile: 1 });

test('宣言料5点：リーチ成立で供託へ、和了者が供託をすべて得る（自分の宣言料も戻る）。合計400', () => {
  let m = createMatch({ length: 4, ...CUR });
  m = applyRoundResult(m, { type: 'draw' }, { riichi: R(1, 2) }); // 2人リーチで流局 → 10点持ち越し
  assert.deepEqual(m.scores, [100, 95, 95, 100]);
  assert.equal(potTotal(m), 10);
  assert.deepEqual(m.pot.map((e) => [e.seat, e.label, e.points]), [[1, '東1局', 5], [2, '東1局', 5]]);
  assert.equal(total(m), 400);
  const e0 = m.log[0];
  assert.deepEqual([e0.riichi, e0.potBefore, e0.potWon, e0.potAfter, e0.deltas], [[1, 2], 0, 0, 10, [0, -5, -5, 0]]);
  // 東2局：席3がリーチ、席1のツモ（子・B=2）→ 供託15点を得る
  m = applyRoundResult(m, tsumo(1, 2), { riichi: R(3) });
  assert.equal(potTotal(m), 0);
  // 子ツモ B=2：親(席1)…席1は東2局の親。親ツモ：子3人 各 −4。席1 +12 ＋供託15
  assert.deepEqual(m.log[1].payments, [-4, 12, -4, -4]);
  assert.deepEqual(m.log[1].deltas, [-4, 12 + 15, -4, -4 - 5]);
  assert.deepEqual(m.scores, [96, 95 + 27, 91, 91]);
  assert.equal(m.log[1].potWon, 15);
  assert.equal(total(m), 400);
  assert.deepEqual([m.best[1], m.bestBase[1]], [12, 2], '最高和了は精算の点（供託は含めない）');
});

test('宣言牌でロンされたリーチは不成立：宣言料を出さない（他のリーチは成立）', () => {
  const m = applyRoundResult(createMatch({ length: 4, ...CUR }), ron(0, 2, 2, 902), { riichi: R(1, 2) });
  // 席2の宣言牌（tile 902）でロン → 席2は不成立。席1の5点は和了者へ
  assert.deepEqual(m.log[0].riichi, [1]);
  assert.deepEqual(m.log[0].deltas, [12 + 5, -5, -12, 0]);
  assert.equal(total(m), 400);
  // 宣言牌ではない牌でのロンなら成立
  const m2 = applyRoundResult(createMatch({ length: 4, ...CUR }), ron(0, 2, 2, 555), { riichi: R(1, 2) });
  assert.deepEqual(m2.log[0].riichi, [1, 2]);
  assert.deepEqual(m2.log[0].deltas, [12 + 10, -5, -12 - 5, 0]);
});

test('四家立直：その局の宣言料を返還し、前の局からの持ち越しは残す', () => {
  let m = createMatch({ length: 8, ...CUR });
  m = applyRoundResult(m, { type: 'draw' }, { riichi: R(0) }); // 5点持ち越し
  m = applyRoundResult(m, { type: 'draw', reason: 'four-riichi' }, { riichi: R(0, 1, 2, 3) });
  const e = m.log[1];
  assert.deepEqual(e.refunded, [5, 5, 5, 5]);
  assert.deepEqual(e.deltas, [0, 0, 0, 0]);
  assert.equal(potTotal(m), 5, '持ち越し分は残る');
  assert.deepEqual(m.pot.map((x) => [x.seat, x.label]), [[0, '東1局']]);
  assert.deepEqual(m.scores, [95, 100, 100, 100]);
  assert.equal(total(m), 400);
  assert.deepEqual([m.hand, dealerOf(m)], [2, 2], '四家立直は親交代');
  // 次の和了者が持ち越しを得る
  m = applyRoundResult(m, ron(3, 1, 1), { riichi: R() });
  assert.equal(m.log[2].potWon, 5);
  assert.equal(potTotal(m), 0);
});

test('試合終了時に残った供託は元の宣言者へ返す（1局戦・4局戦・8局戦・通し局数の上限）', () => {
  // 1局戦：流局（2人リーチ）→ 終了で返還
  let m = applyRoundResult(createMatch({ length: 1, ...CUR }), { type: 'draw' }, { riichi: R(0, 3) });
  assert.deepEqual([m.over, m.scores, potTotal(m), m.log[0].potReturned], [true, [100, 100, 100, 100], 0, [5, 0, 0, 5]]);
  // 4局戦：東3局の流局の持ち越し＋東4局の流局 → 終了で、宣言した局によらず元の宣言者へ
  m = createMatch({ length: 4, ...CUR });
  m = applyRoundResult(m, { type: 'draw' }, { riichi: R() });
  m = applyRoundResult(m, ron(2, 0, 2), { riichi: R(0) }); // 東2局（親は席1）：子の席2が席0の5点を得る
  m = applyRoundResult(m, { type: 'draw' }, { riichi: R(2) });
  m = applyRoundResult(m, { type: 'draw' }, { riichi: R(2, 1) });
  assert.equal(m.over, true);
  assert.deepEqual(m.log[3].potReturned, [0, 5, 10, 0]);
  assert.equal(potTotal(m), 0);
  assert.equal(m.scores.reduce((a, b) => a + b, 0), 400);
  // 8局戦の南4局
  m = matchAt({ length: 8, hand: 7, ...CUR });
  m = applyRoundResult(m, { type: 'draw' }, { riichi: R(3) });
  assert.deepEqual([m.over, m.scores], [true, [100, 100, 100, 100]]);
  // 通し局数の上限で打ち切り
  m = applyRoundResult(createMatch({ length: 4, ...CUR }), { type: 'draw' }, { riichi: R(1), round: 5, maxRound: 5 });
  assert.deepEqual([m.over, m.endReason, m.scores, potTotal(m)], [true, 'round-limit', [100, 100, 100, 100], 0]);
});

test('アガリやめ：最終の親番（4局戦の東4局・8局戦の南4局）で親が和了し、精算後に単独1位なら終了', () => {
  for (const length of [4, 8]) {
    // 親（席3）の和了で単独1位
    let m = matchAt({ length, hand: length - 1, ...CUR }); // 起家 0 → 最終の親は席 (length-1)%4 = 3
    assert.equal(dealerOf(m), 3);
    m = applyRoundResult(m, tsumo(3, 2), { riichi: R() });
    assert.deepEqual([m.over, m.endReason, m.renchan, m.log[0].agariYame, m.log[0].dealerKeeps], [true, 'agari-yame', 0, true, false], `${length}局戦`);
    assert.equal(ranks(m.scores)[3], 1);
    // 親の和了でも2位以下 → 連荘
    m = matchAt({ length, hand: length - 1, ...CUR });
    m.scores = [140, 90, 90, 80];
    m = applyRoundResult(m, ron(3, 2, 1), { riichi: R() }); // 親ロン +6 → 86
    assert.deepEqual([m.over, m.renchan, m.log[0].dealerKeeps, !!m.log[0].agariYame], [false, 1, true, false]);
    // 同点の1位 → 連荘（単独ではない）
    m = matchAt({ length, hand: length - 1, ...CUR });
    m.scores = [112, 100, 88, 100];
    m = applyRoundResult(m, ron(3, 2, 2), { riichi: R() }); // 席3：100+12=112、席0も112 → 同点1位
    assert.deepEqual([m.scores[0], m.scores[3]], [112, 112]);
    assert.deepEqual([m.over, m.renchan], [false, 1], '同点の1位は連荘');
    // 供託を含めて単独1位になる
    m = matchAt({ length, hand: length - 1, ...CUR });
    m.scores = [110, 100, 85, 100]; m.pot = [{ seat: 2, label: '東3局', hand: length - 2, renchan: 0, played: 0, points: 5 }];
    m = applyRoundResult(m, ron(3, 1, 1), { riichi: R() }); // 席3：100+6+5=111 > 110
    assert.deepEqual([m.scores[3], m.over, m.endReason], [111, true, 'agari-yame']);
    assert.equal(m.scores.reduce((a, b) => a + b, 0), 400);
    // 連荘中の再度の和了でも判定する（renchan 1 → 単独1位で終了）
    m = matchAt({ length, hand: length - 1, renchan: 1, ...CUR });
    m = applyRoundResult(m, tsumo(3, 1), { riichi: R() });
    assert.deepEqual([m.over, m.endReason], [true, 'agari-yame']);
  }
});

test('アガリやめは最終の親番だけ・1局戦は順位によらず1局で終了・子の和了や流局は従来どおり・宣言料なしの試合では無効', () => {
  // 最終でない親番の親の和了は連荘
  let m = applyRoundResult(createMatch({ length: 4, ...CUR }), tsumo(0, 3), { riichi: R() });
  assert.deepEqual([m.over, m.renchan], [false, 1]);
  // 1局戦：親が2位以下でも終了（連荘しない）
  m = createMatch({ length: 1, ...CUR }); m.scores = [80, 120, 100, 100];
  m = applyRoundResult(m, ron(0, 2, 1), { riichi: R() });
  assert.deepEqual([m.over, m.endReason, m.renchan], [true, 'normal', 0]);
  // 最終の親番で子の和了・流局 → 通常の終了
  m = applyRoundResult(matchAt({ length: 4, hand: 3, ...CUR }), ron(0, 3, 1), { riichi: R() });
  assert.deepEqual([m.over, m.endReason], [true, 'normal']);
  // 過去の版（宣言料・アガリやめなし）は従来どおり：単独1位でも連荘し、リーチの情報があっても宣言料を取らない
  m = applyRoundResult(matchAt({ length: 4, hand: 3 }), tsumo(3, 2), { riichi: R(3) });
  assert.deepEqual([m.over, m.renchan, m.scores], [false, 1, [96, 96, 96, 112]]);
  assert.equal('potWon' in m.log[0], false, '記録の形も従来どおり');
});

// AI の対局（12人・数学Ⅰ/Ⅱ × 1/4/8局戦・ruleset 2・宣言料とアガリやめ）：合計400・終了時の供託0・アガリやめの条件・AI のリーチ
test('AI 対局：持ち点＋供託＝400、終了時の供託0、アガリやめは単独1位のときだけ、AI はリーチする（宣言料の導入でも判断は不変）', () => {
  const ids = Object.values(CHARACTER_ROSTER).flat().map((c) => c.id);
  const players = [0, 1, 2, 3].map((s) => ({ name: 'P' + s, kind: 'ai', personality: 'speed' }));
  const st = { rounds: 0, riichi: 0, potWon: 0, agariYame: 0, returned: 0, byChar: {} };
  for (const mode of ['math1', 'math2']) {
    const rules = rulesFor(mode);
    for (const [length, n] of [[1, 12], [4, 4], [8, 2]]) {
      for (let k = 0; k < n; k++) {
        const seed = 500 + k * 7 + length;
        const lineup = [0, 1, 2, 3].map((s) => ids[(seed + s * 5) % 12]);
        let match = createMatch({ length, startDealer: seed % 4, ...CUR });
        let history = newPublicHistory();
        const rng = createRng(seed);
        for (let r = 1; !match.over && r <= 40; r++) {
          const g = new Game({ rules, seed: seed * 31 + r, dealer: dealerOf(match), players, ruleset: 2 });
          while (g.pending()) {
            const p = g.pending();
            applyAction(g, p.seat, decideCharacter(g, p.seat, lineup[p.seat], rng, { scores: match.scores, hand: match.hand, length, dealer: dealerOf(match), renchan: match.renchan, publicHistory: history }, lineup.slice(1)));
          }
          g.checkInvariants();
          for (let s = 0; s < 4; s++) if (g.riichi[s]) st.byChar[lineup[s]] = (st.byChar[lineup[s]] || 0) + 1;
          st.riichi += g.riichi.filter(Boolean).length;
          history = recordPublicRound(history, g.events, g.riichi);
          match = applyRoundResult(match, g.result, { riichi: g.riichi });
          assert.equal(total(match), 400);
          const e = match.log.at(-1);
          st.potWon += e.potWon; st.rounds++;
          if (e.agariYame) { st.agariYame++; assert.ok(match.scores.every((x, s) => s === e.dealer || match.scores[e.dealer] > x)); }
          if (e.potReturned) st.returned++;
        }
        assert.ok(match.over);
        assert.equal(potTotal(match), 0);
        assert.equal(match.scores.reduce((a, b) => a + b, 0), 400);
      }
    }
  }
  assert.ok(st.riichi > 50 && st.potWon > 0, JSON.stringify(st));
  assert.ok(Object.keys(st.byChar).length >= 8, `リーチしたキャラクター ${Object.keys(st.byChar).length}人`);
});
