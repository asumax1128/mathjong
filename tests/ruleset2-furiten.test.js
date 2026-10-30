// ruleset 2（次回更新の新ルール）：フリテン3種類（捨て牌・同巡の見逃し・リーチ後の見逃し）、関数牌のポン禁止、リーチの待ち。
// ruleset 0（従来）・1（新ルール初版）は従来どおり（フリテンなし・関数牌もポンできる）であることも確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { decideCharacter, CHARACTER_ROSTER, newPublicHistory } from '../src/engine/characters.js';
import { createMatch, applyRoundResult, dealerOf } from '../src/engine/match.js';
import { createRng } from '../src/engine/rng.js';
import { rulesFor, k } from './helpers.js';

const R1 = rulesFor('math1');
const players = [0, 1, 2, 3].map((s) => ({ name: 'P' + s, kind: 'ai', personality: 'speed' }));
const T = (r, s) => r.typeByKey.get(k(s)).idx;
// 自分（席0・親）は sin・=1/2 の待ち（30° か 150°）＋ cos180°=−1・tan45°=1 の完成形
const TENPAI = ['cos', '180', '=-1', 'tan', '45', '=1', 'sin', '=1/2'];
const OTHERS = [
  ['90', '90', '0', '0', '=√3', '=√3', '=-1/√3', '=-1/√3'],
  ['90', '90', '0', '0', '=√3', '=√3', '=-1/√3', '=-1/√3'],
  ['=-√3/2', '=-√3/2', '=1/√3', '=1/√3', '=-1/√2', '=-1/√2', '=1/√2', '=1/√2'],
];
// hands：席0〜3の8枚、draws：配牌の後に引かれる順（席0から手番順）
function game({ hands = [TENPAI, ...OTHERS], draws, ruleset = 2, r = R1 }) {
  const keys = [];
  for (let i = 0; i < 8; i++) for (let s = 0; s < 4; s++) keys.push(k(hands[s][i]));
  return new Game({ rules: r, seed: 1, dealer: 0, players, presetWall: [...keys, ...draws.map(k)], ruleset });
}
const idOf = (g, seat, s) => { const t = T(g.rules, s); const id = g.hands[seat].find((x) => g.typeOf(x) === t); assert.ok(id !== undefined, `${seat} に ${s}`); return id; };
// 他家：自分の手番はツモ切り、宣言はすべて見送る。席0の判断番（宣言・手番）で止まる
function othersUntilMe(g) {
  for (let i = 0; i < 200; i++) {
    const p = g.pending();
    if (!p || p.seat === 0) return p;
    if (p.type === 'claim') g.respond(p.seat, { type: 'pass' }); else g.discard(p.seat, g.drawn);
  }
  throw new Error('loop');
}

test('捨て牌のフリテン：待ち（30°・150°）の一方を自分で捨てていれば、もう一方の待ちでもロンできない。ツモ和了はできる', () => {
  // 席0：最初のツモ 150°（和了できるが捨てる）→ 下家が 30° を捨てる → ロンできない → 次のツモ 30° でツモ和了
  const g = game({ draws: ['150', '30', '=-1/2', '=-1/2', '30'] });
  assert.ok(g.pending().canTsumo, '150° でツモ和了できる局面');
  g.discard(0, g.drawn);
  const f = g.furitenOf(0);
  assert.deepEqual(f.waits.slice().sort((a, b) => a - b), [T(R1, '30'), T(R1, '150')].sort((a, b) => a - b), '待ちは2種類');
  assert.deepEqual([f.furiten, f.reasons, f.inRiver], [true, ['discard'], [T(R1, '150')]]);
  // 下家の 30°：和了の形になるが、フリテンなので席0には宣言がない
  assert.ok(g.ronAnalysis(0, idOf(g, 1, '30')), '形としては和了できる牌');
  const p = othersUntilMe(g);
  assert.deepEqual([p.seat, p.type], [0, 'turn']);
  assert.ok(g.events.some((e) => e.type === 'discard' && e.seat === 1 && g.typeOf(e.tile) === T(R1, '30')), '下家が 30° を捨てた');
  assert.ok(p.canTsumo, 'フリテンでもツモ和了はできる');
  g.tsumo(0);
  assert.equal(g.result.winner, 0);
  g.checkInvariants();
});

test('同巡のフリテン：ロンを見送ると次の自分の通常ツモまでロンできない（他家の打牌・自分の鳴きでは解除しない）', () => {
  const g = game({ draws: ['=-1/2', '30', '150', '=-1/2', '=√3/2', '30'] });
  g.discard(0, g.drawn); // =−1/2
  let p = g.pending(); // 下家のツモ・打牌（30°）
  g.discard(1, g.drawn);
  p = g.pending();
  assert.deepEqual([p.seat, p.type, p.ron], [0, 'claim', true], '30° でロンできる');
  g.respond(0, { type: 'pass' });
  assert.deepEqual(g.furitenOf(0).reasons, ['temporary']);
  // 対面の 150°（もう一方の待ち）：見送った後なのでロンできない
  p = g.pending();
  assert.equal(p.seat, 2);
  g.discard(2, g.drawn);
  p = g.pending();
  assert.ok(!(p && p.seat === 0 && p.type === 'claim'), '同巡のフリテン中はロンの宣言がない');
  assert.ok(g.tempFuriten[0]);
  // 上家の打牌の後、自分の通常ツモで解除
  p = othersUntilMe(g);
  assert.deepEqual([p.seat, p.type], [0, 'turn']);
  assert.equal(g.tempFuriten[0], false, '自分の通常ツモで解除');
  g.discard(0, g.drawn); // √3/2
  p = g.pending();
  g.discard(1, g.drawn); // 30°
  p = g.pending();
  assert.deepEqual([p.seat, p.type, p.ron], [0, 'claim', true], '解除後はロンできる');
  g.respond(0, { type: 'ron' });
  assert.equal(g.result.how, 'ron');
});

test('同巡のフリテン：見送った後にチーしても解除されない（解除は自分の次の通常ツモ）', () => {
  // 下家 30° を見送る → 対面・上家 → 上家の −1 で cos180°=−1 をチー → まだフリテン → 次の通常ツモで解除
  const g = game({ draws: ['=-1/2', '30', '=-1/2', '=-1', '=√3/2'] });
  g.discard(0, g.drawn);
  g.discard(1, g.drawn);
  g.respond(0, { type: 'pass' });
  for (let i = 0; i < 20; i++) {
    const p = g.pending();
    if (p.seat === 0 && p.type === 'claim' && p.chi.length) break;
    if (p.type === 'claim') g.respond(p.seat, { type: 'pass' }); else g.discard(p.seat, g.drawn);
  }
  const p = g.pending();
  assert.equal(g.events.at(-1).seat, 3, '上家の打牌');
  const opt = p.chi.findIndex((o) => g.rules.melds[o.meld].fn === 'cos');
  g.respond(0, { type: 'chi', option: opt });
  assert.equal(g.melds[0].length, 1);
  assert.ok(g.tempFuriten[0], 'チーでは解除しない');
  g.discard(0, idOf(g, 0, '=-1'));
  assert.ok(g.tempFuriten[0], '鳴いた後の打牌でも解除しない');
  const q = othersUntilMe(g);
  assert.deepEqual([q.seat, q.type], [0, 'turn']);
  assert.equal(g.tempFuriten[0], false);
  g.checkInvariants();
});

test('リーチ後の見逃し：局の終わりまでロンできない。ツモ和了はできる。リーチの待ちは確定時に記録（他家に渡る riichi には入れない）', () => {
  const g = game({ draws: ['=-1/2', '30', '=-1/2', '=-1/2', '=√3/2', '150', '=-1/2', '=√3/2', '30'] });
  g.discard(0, g.drawn, { riichi: true });
  assert.deepEqual(g.riichiWaits[0].slice().sort(), [T(R1, '30'), T(R1, '150')].sort());
  assert.deepEqual(Object.keys(g.riichi[0]).sort(), ['tile', 'turn'], 'riichi[] は従来の形（待ちは入れない）');
  g.discard(1, g.drawn);
  let p = g.pending();
  assert.deepEqual([p.seat, p.ron], [0, true]);
  g.respond(0, { type: 'pass' });
  assert.deepEqual(g.furitenOf(0).reasons.sort(), ['riichi', 'temporary']);
  p = othersUntilMe(g);
  assert.equal(p.type, 'turn');
  assert.deepEqual(g.furitenOf(0).reasons, ['riichi'], '通常ツモで同巡は解除、リーチ後の見逃しは残る');
  g.discard(0, g.drawn); // √3/2（ツモ切り）
  g.discard(1, g.drawn); // 150°
  p = g.pending();
  assert.ok(!(p.seat === 0 && p.type === 'claim'), 'リーチ後の見逃しの後はロンできない');
  p = othersUntilMe(g);
  assert.ok(p.canTsumo, 'ツモ和了はできる');
  g.tsumo(0);
  assert.ok(g.result.analysis.riichi);
});

test('関数牌のポン禁止（ruleset 2）：候補を作らず、エンジンも拒否。角度牌・値牌のポンと関数牌の暗カンは従来どおり', () => {
  const S2 = ['=-1/2', '=-1/2', '0', '0', '=√3', '=√3', '=-1/√3', '=-1/√3']; // 対面：90° を持たない
  const hands = [['sin', 'cos', 'tan', '30', '=1/2', '=-√3', '=-1', '45'], ['sin', 'sin', '90', '90', '=-√3', '=-√3', '0', '0'], S2, OTHERS[2]];
  for (const ruleset of [2, 1, 0]) {
    const g = game({ hands, draws: ['=-1/2'], ruleset });
    g.discard(0, idOf(g, 0, 'sin'));
    const p = g.pending();
    if (ruleset === 2) {
      assert.ok(!(p.type === 'claim' && p.seat === 1 && p.pon), '関数牌のポンの候補がない');
      assert.equal(g.ponOption(1, g.rivers[0][0].id), null);
    } else {
      assert.deepEqual([p.seat, p.type, !!p.pon], [1, 'claim', true], `ruleset ${ruleset} は従来どおりポンできる`);
    }
  }
  // 角度牌のポンは ruleset 2 でもできる
  const g = game({ hands, draws: ['=-1/2'], ruleset: 2 });
  assert.equal(g.ponOption(1, idOf(g, 1, '90')) && g.rules.melds[g.ponOption(1, idOf(g, 1, '90')).meld].kind, 'koutsu');
  const h2 = [['30', '=1/2', '=-√3', '=-1', '45', 'cos', 'tan', '60'], ['=-1/√2', '=-1/√2', '90', '90', 'sin', 'sin', '0', '0'], S2, ['=-√3/2', '=-√3/2', '=1/√3', '=1/√3', '=1', '=1', '=1/√2', '=1/√2']];
  const g2 = game({ hands: h2, draws: ['90'], ruleset: 2 });
  g2.discard(0, g2.drawn);
  const p2 = g2.pending();
  assert.deepEqual([p2.seat, p2.type, !!p2.pon], [1, 'claim', true], '角度牌はポンできる');
  g2.respond(1, { type: 'pon' });
  assert.equal(g2.melds[1][0].call, 'pon');
  // エンジンが拒否：関数牌の打牌に対して pon を送る
  // （下家は sin でチーもできるので宣言番になる。ポンの候補はなく、送っても拒否）
  const g3 = game({ hands: [h2[0], ['sin', 'sin', '30', '=1/2', '=-1/√2', '=-1/√2', '0', '0'], S2, h2[3]], draws: ['sin'], ruleset: 2 });
  g3.discard(0, g3.drawn);
  const p3 = g3.pending();
  assert.deepEqual([p3.seat, p3.type, p3.pon, p3.chi.length > 0], [1, 'claim', null, true]);
  assert.throws(() => g3.respond(1, { type: 'pon' }), /pon not possible/);
  assert.equal(g3.melds[1].length, 0, '拒否された局面は変わらない');
  // 関数牌の暗カンはできる
  const g4 = game({ hands: [['sin', 'sin', 'sin', '30', '=1/2', '=-√3', '=-1', '45'], ...OTHERS], draws: ['sin'], ruleset: 2 });
  assert.deepEqual(g4.pending().ankan.map((o) => o.type), [T(R1, 'sin')]);
  g4.ankan(0, T(R1, 'sin'));
  assert.equal(g4.melds[0][0].call, 'ankan');
  g4.checkInvariants();
});

test('ruleset 0・1 はフリテンなし（過去の局を同じ進行で再現）', () => {
  for (const ruleset of [0, 1]) {
    const g = game({ draws: ['150', '30', '=-1/2', '=-1/2', '30'], ruleset });
    g.discard(0, g.drawn);
    assert.equal(g.furitenOf(0).furiten, false);
    g.discard(1, g.drawn);
    const p = g.pending();
    assert.deepEqual([p.seat, p.type, p.ron], [0, 'claim', true], `ruleset ${ruleset}：捨てた牌の待ちでもロンできる（従来）`);
  }
  // newRules: true は ruleset 1（従来の呼び出し）
  const g = new Game({ rules: R1, seed: 3, dealer: 0, players, newRules: true });
  assert.deepEqual([g.ruleset, g.newRules, g.furitenRule, g.funcPonBan], [1, true, false, false]);
  const g0 = new Game({ rules: R1, seed: 3, dealer: 0, players });
  assert.deepEqual([g0.ruleset, g0.newRules, g0.furitenRule], [0, false, false]);
});

// AI の対局（ruleset 2）：12人＋3難易度。フリテン中にロンの選択肢が出ない・合法手・保存則・王牌・24回・合計400点・決定論
function playMatch(mode, seed, seats) {
  const rules = rulesFor(mode);
  let match = createMatch({ length: 4 });
  const rng = createRng(seed);
  const log = [];
  let rnd = 0;
  let furitenBlocks = 0, ronPassed = 0, funcPonOffered = 0;
  while (!match.over && rnd < 12) {
    rnd++;
    const g = new Game({ rules, seed: seed * 101 + rnd, dealer: dealerOf(match), players, ruleset: 2 });
    const info = { scores: match.scores.slice(), hand: match.hand, length: 4, dealer: dealerOf(match), renchan: match.renchan, publicHistory: newPublicHistory() };
    for (let i = 0; i < 2000 && g.pending(); i++) {
      const p = g.pending();
      if (p.type === 'claim') {
        if (p.ron) assert.equal(g.furitenOf(p.seat).furiten, false, 'フリテン中にロンの選択肢');
        if (p.pon) { const t = g.typeOf(g.claim.tile); if (g.rules.types[t].kind === 'func') funcPonOffered++; }
      }
      const id = seats[p.seat];
      const a = id.startsWith('L:') ? decide(g, p.seat, id.split(':')[2], rng, id.split(':')[1], info) : decideCharacter(g, p.seat, id, rng, info, seats.slice(1));
      if (p.type === 'claim' && p.ron && a.type !== 'ron') ronPassed++;
      applyAction(g, p.seat, a);
      g.checkInvariants();
    }
    assert.equal(g.pending(), null);
    furitenBlocks += g.events.filter((e) => e.type === 'discard').length && [0, 1, 2, 3].filter((s) => g.furitenOf(s).furiten).length;
    if (mode === 'math2') assert.ok(g.normalDraws.every((n) => n <= 24));
    assert.equal(g.deadWall.allPhysical().length, 14);
    match = applyRoundResult(match, g.result);
    assert.equal(match.scores.reduce((a, b) => a + b, 0), 400);
    log.push(JSON.stringify(g.events));
  }
  return { log, furitenBlocks, ronPassed, funcPonOffered };
}
test('AI の対局（ruleset 2・数学Ⅰ/Ⅱ・12人と3難易度）：フリテン中のロンなし・関数牌のポンなし・合法手・保存則・王牌14枚・24回・合計400点・seed で再現', () => {
  const ids = Object.values(CHARACTER_ROSTER).flat().map((c) => c.id);
  let total = { furitenBlocks: 0, funcPonOffered: 0 };
  for (const mode of ['math1', 'math2']) {
    for (let m = 0; m < 4; m++) {
      const seats = [0, 1, 2, 3].map((s) => (m % 2 ? ids[(m * 3 + s * 4) % 12] : `L:${['beginner', 'intermediate', 'advanced'][(m + s) % 3]}:${['speed', 'value', 'closed'][(m + 2 * s) % 3]}`));
      const a = playMatch(mode, 500 + m, seats);
      const b = playMatch(mode, 500 + m, seats);
      assert.deepEqual(a.log, b.log, '同じ seed で同じ進行');
      total.furitenBlocks += a.furitenBlocks; total.funcPonOffered += a.funcPonOffered;
    }
  }
  assert.equal(total.funcPonOffered, 0, '関数牌のポンの候補は出ない');
});
