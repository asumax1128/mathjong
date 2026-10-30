// 四家立直（ruleset 2）と1局戦（docs/64）：4人全員のリーチが成立したら途中流局。4人目の宣言牌へのロンの判断が終わってから判定し、
// ロンが成立すればロンを優先する。点数の移動なし。旧ルール（ruleset 0・1）は従来どおり続行する。
// 1局戦：親の和了でも連荘せず、和了・流局（山切れ・24回・四家立直）のどれでもその1局で終わる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { decideCharacter, CHARACTER_ROSTER, newPublicHistory, recordPublicRound } from '../src/engine/characters.js';
import { createMatch, applyRoundResult, dealerOf, ranks, settle, MATCH_LENGTHS } from '../src/engine/match.js';
import { createRng } from '../src/engine/rng.js';
import { rulesFor, k } from './helpers.js';

const players = [0, 1, 2, 3].map((s) => ({ name: 'P' + s, kind: 'ai', personality: 'speed' }));
// 席ごとの聴牌（8枚）：席0 30°・150° 待ち、席1 60°、席2 60°、席3 60°・120°
const H = [
  ['cos', '180', '=-1', 'tan', '45', '=1', 'sin', '=1/2'],
  ['sin', '90', '=1', 'cos', '0', '=1', 'cos', '=1/2'],
  ['tan', '135', '=-1', 'sin', '0', '=0', 'tan', '=√3'],
  ['cos', '120', '=-1/2', 'sin', '180', '=0', 'sin', '=√3/2'],
];
const X = '=-1/√3'; // 誰の待ち・チー・ポンにもならない牌（4枚）
const Y = '=1/√3'; // 同上（4枚）
function scene({ dealer = 0, draws, ruleset = 2, mode = 'math1' }) {
  const keys = [];
  for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) keys.push(k(H[(dealer + j) % 4][i]));
  return new Game({ rules: rulesFor(mode), seed: 1, dealer, players, presetWall: [...keys, ...draws.map(k)], ruleset });
}
// 手番の席がツモ牌をリーチ宣言で捨てる（riichi=false ならツモ切り）
const turn = (g, riichi = true) => { const p = g.pending(); assert.equal(p.type, 'turn'); g.discard(p.seat, g.drawn, { riichi }); g.checkInvariants(); };
const lastEvent = (g) => g.events.at(-1);
const total = (m) => m.scores.reduce((a, b) => a + b, 0);

const MODE_LABEL = { math1: '数学Ⅰ', math2: '数学Ⅱ' };
for (const mode of ['math1', 'math2']) {
  test(`${MODE_LABEL[mode]}：四家立直：4人目のリーチ宣言牌に誰もロンできなければ、その場で途中流局（山は残る・点数の移動なし・記録は abortive-draw）`, () => {
    {
      const g = scene({ mode, draws: [X, X, X, X] });
      for (let i = 0; i < 3; i++) turn(g);
      assert.equal(g.riichi.filter(Boolean).length, 3);
      assert.deepEqual([g.pending().seat, g.pending().type], [3, 'turn'], '3人のリーチでは続く');
      const wallBefore = g.wall.length;
      turn(g);
      assert.equal(g.pending(), null);
      assert.deepEqual(g.result, { type: 'draw', reason: 'four-riichi' });
      assert.deepEqual(lastEvent(g), { type: 'abortive-draw', reason: 'four-riichi' });
      assert.ok(!g.events.some((e) => e.type === 'exhaustive-draw'), '山切れの流局とは別の記録');
      assert.equal(g.wall.length, wallBefore, '次のツモをしない');
      assert.ok(g.wall.length > 0);
      assert.ok(g.riichi.every(Boolean));
      assert.deepEqual(settle(g.result, 0), [0, 0, 0, 0], '点数の移動なし（リーチの宣言料もなし）');
      g.checkInvariants();
    }
  });

  test(`${MODE_LABEL[mode]}：四家立直：4人目の宣言牌がロンできる牌ならロンの判断を先に聞く。ロンすれば和了（四家立直にしない）`, () => {
    const g = scene({ mode, draws: [X, X, X, '30'] }); // 席3 の宣言牌 30° は席0 の待ち
    for (let i = 0; i < 3; i++) turn(g);
    turn(g);
    const p = g.pending();
    assert.deepEqual([p.seat, p.type, p.ron], [0, 'claim', true], 'ロンの判断が先');
    assert.equal(g.result, null, '判断の前に流局にしない');
    g.respond(0, { type: 'ron' });
    assert.equal(g.result.type, 'win');
    assert.deepEqual([g.result.winner, g.result.how, g.result.from], [0, 'ron', 3]);
    assert.ok(g.result.analysis.riichi, 'リーチの和了（基本点のボーナス）は従来どおり');
    assert.ok(!g.events.some((e) => e.type === 'abortive-draw'));
    g.checkInvariants();
  });

  test(`${MODE_LABEL[mode]}：四家立直：ロンを見送れば途中流局（見送った人はリーチ後のフリテン）`, () => {
    const g = scene({ mode, draws: [X, X, X, '30'] });
    for (let i = 0; i < 4; i++) turn(g);
    g.respond(0, { type: 'pass' });
    assert.deepEqual(g.result, { type: 'draw', reason: 'four-riichi' });
    assert.ok(g.riichiFuriten[0]);
    g.checkInvariants();
  });

  test(`${MODE_LABEL[mode]}：四家立直：フリテン（捨て牌に待ち）の人はロンの選択肢がなく、そのまま途中流局`, () => {
    // 席0 は 150° をツモ（ツモ和了できる）が、150° をリーチ宣言で捨てる → 30°・150° 待ちの捨て牌のフリテン
    const g = scene({ mode, draws: ['150', X, X, '30'] });
    assert.equal(g.pending().canTsumo, true);
    turn(g);
    // 150° は下家（席1）が sin 150° = 1/2 でチーできる → 見送る（ロンではないのでフリテンは関係しない）
    const c = g.pending();
    assert.deepEqual([c.seat, c.type, c.ron], [1, 'claim', false]);
    g.respond(1, { type: 'pass' });
    for (let i = 0; i < 2; i++) turn(g);
    turn(g); // 席3 の宣言牌 30°
    assert.deepEqual(g.result, { type: 'draw', reason: 'four-riichi' });
    assert.equal(g.ronBlocked[0] && g.typeOf(g.ronBlocked[0].tile), rulesFor(mode).typeByKey.get(k('30')).idx, 'フリテンでロンできなかった牌');
    assert.ok(g.ronBlocked[0].reasons.includes('discard'));
  });

  test(`${MODE_LABEL[mode]}：四家立直：複数人がロンできるときは打牌者に近い順（アタマハネ）。全員見送れば途中流局`, () => {
    // 親は席1：リーチの順は 1→2→3→0。席0 の宣言牌 60° は席1・2・3 の待ち
    const run = (choices) => {
      const g = scene({ mode, dealer: 1, draws: [X, X, X, '60'] });
      for (let i = 0; i < 4; i++) turn(g);
      const asked = [];
      for (const c of choices) {
        const p = g.pending();
        if (!p) break;
        assert.equal(p.type, 'claim'); assert.ok(p.ron);
        asked.push(p.seat);
        g.respond(p.seat, { type: c });
      }
      return { g, asked };
    };
    const a = run(['ron']);
    assert.deepEqual(a.asked, [1]); assert.deepEqual([a.g.result.winner, a.g.result.from], [1, 0]);
    const b = run(['pass', 'pass', 'ron']);
    assert.deepEqual(b.asked, [1, 2, 3]); assert.deepEqual([b.g.result.type, b.g.result.winner], ['win', 3]);
    const c = run(['pass', 'pass', 'pass']);
    assert.deepEqual(c.asked, [1, 2, 3]);
    assert.deepEqual(c.g.result, { type: 'draw', reason: 'four-riichi' });
  });

  test(`${MODE_LABEL[mode]}：四家立直：宣言の順番によらず4人目の宣言で成立（途中にリーチしない打牌があっても、4人そろうまでは続く）`, () => {
    // 親は席0。席1 は1巡目はリーチせず、2巡目にリーチ（4人目）
    const g = scene({ mode, draws: [X, Y, X, X, Y, X] });
    turn(g); turn(g, false); turn(g); turn(g); // 0 リーチ・1 ツモ切り・2 リーチ・3 リーチ
    assert.equal(g.riichi.filter(Boolean).length, 3);
    turn(g, false); // 席0（リーチ中）のツモ切り
    assert.deepEqual([g.pending().seat, g.pending().type], [1, 'turn']);
    turn(g); // 席1 のリーチ（4人目）
    assert.deepEqual(g.result, { type: 'draw', reason: 'four-riichi' });
    const order = g.events.filter((e) => e.type === 'riichi').map((e) => e.seat);
    assert.deepEqual(order, [0, 2, 3, 1]);
  });

  test(`${MODE_LABEL[mode]}：四家立直：AI と人の区別なし（席0 の宣言を人の操作とし、3人の AI がリーチすれば成立）`, () => {
    const ids = Object.values(CHARACTER_ROSTER).flat().map((c) => c.id);
    let fourRiichi = 0;
    for (const id of ids) {
      const g = scene({ mode, draws: [X, X, X, X, Y, Y, Y, Y] });
      const rng = createRng(3);
      g.discard(0, g.drawn, { riichi: true }); // 人（席0）
      for (let i = 0; i < 40 && g.pending(); i++) {
        const p = g.pending();
        if (p.seat === 0) { if (p.type === 'turn') g.discard(0, g.drawn); else g.respond(0, { type: 'pass' }); continue; }
        applyAction(g, p.seat, decideCharacter(g, p.seat, id, rng, { scores: [100, 100, 100, 100], hand: 0, length: 4, dealer: 0, renchan: 0 }, []));
        g.checkInvariants();
      }
      if (g.riichi.every(Boolean)) { fourRiichi++; assert.deepEqual(g.result, { type: 'draw', reason: 'four-riichi' }, id); }
      else assert.notEqual(g.result && g.result.reason, 'four-riichi', id);
    }
    assert.ok(fourRiichi >= 6, `四家立直 ${fourRiichi}件`);
    // 逆に人が4人目：AI 3人（中級）が先にリーチ
    const g = scene({ mode, dealer: 1, draws: [X, X, X, X] });
    const rng = createRng(5);
    for (let i = 0; i < 3; i++) { const p = g.pending(); applyAction(g, p.seat, decide(g, p.seat, 'speed', rng, 'intermediate')); }
    assert.equal(g.riichi.filter(Boolean).length, 3, 'AI 3人がリーチ');
    turn(g); // 人（席0）
    assert.deepEqual(g.result, { type: 'draw', reason: 'four-riichi' });
  });

  test(`${MODE_LABEL[mode]}：旧ルール（ruleset 0・1）では四家立直にならない：4人リーチ後も続行し、流局は山切れ（従来の記録）`, () => {
    for (const ruleset of [0, 1]) {
      const g = scene({ mode, draws: [X, X, X, X], ruleset });
      for (let i = 0; i < 4; i++) turn(g);
      assert.equal(g.fourRiichiRule, false);
      assert.deepEqual([g.pending().seat, g.pending().type], [0, 'turn'], `ruleset ${ruleset}：次のツモへ`);
      while (g.pending()) { const p = g.pending(); if (p.type === 'turn') g.discard(p.seat, g.drawn); else g.respond(p.seat, { type: 'pass' }); }
      assert.equal(g.result.type, 'draw');
      assert.equal(g.result.reason, undefined);
      assert.deepEqual(lastEvent(g), { type: 'exhaustive-draw' });
    }
  });
}

test('試合：四家立直は流局と同じく点数の移動なし・親交代（4局戦・8局戦）。1局戦はそこで終了。記録に理由が残る', () => {
  const r = { type: 'draw', reason: 'four-riichi' };
  for (const length of [4, 8]) {
    const m = applyRoundResult(createMatch({ length }), r);
    assert.deepEqual(m.scores, [100, 100, 100, 100]);
    assert.deepEqual([m.hand, m.renchan, m.over, dealerOf(m)], [1, 0, false, 1]);
    assert.deepEqual(m.log[0].result, { type: 'draw', reason: 'four-riichi' });
  }
  const one = applyRoundResult(createMatch({ length: 1 }), r);
  assert.deepEqual([one.over, one.endReason, one.played], [true, 'normal', 1]);
  // 山切れの流局の記録は従来の形
  assert.deepEqual(applyRoundResult(createMatch({ length: 4 }), { type: 'draw' }).log[0].result, { type: 'draw' });
});

test('1局戦：親の和了（ロン・ツモ）・子の和了・流局のどれでも1局で終了。連荘しない。順位は同点同順位', () => {
  assert.deepEqual(MATCH_LENGTHS, [1, 4, 8]);
  const cases = [
    { type: 'win', winner: 0, how: 'ron', from: 2, points: 3 }, // 親ロン
    { type: 'win', winner: 0, how: 'tsumo', from: null, points: 2 }, // 親ツモ
    { type: 'win', winner: 1, how: 'ron', from: 0, points: 4 }, // 子ロン
    { type: 'win', winner: 3, how: 'tsumo', from: null, points: 1 }, // 子ツモ
    { type: 'draw' }, { type: 'draw', reason: 'four-riichi' },
  ];
  for (const startDealer of [0, 2]) {
    for (const base of cases) {
      const r = base.type === 'win' ? { ...base, winner: (base.winner + startDealer) % 4, from: base.from === null ? null : (base.from + startDealer) % 4 } : base;
      const m0 = createMatch({ length: 1, startDealer });
      const m = applyRoundResult(m0, r, { round: 1, maxRound: 1000 });
      assert.equal(m.over, true, JSON.stringify(r));
      assert.equal(m.endReason, 'normal');
      assert.deepEqual([m.played, m.renchan, m.renchanTotal], [1, 0, 0]);
      assert.equal(m.log[0].dealerKeeps, false);
      assert.equal(m.log[0].label, '東1局');
      assert.equal(total(m), 400);
      assert.deepEqual(m.scores.map((x, s) => x - 100), settle(r, startDealer), '精算は4局戦と同じ');
      assert.throws(() => applyRoundResult(m, r), /over/);
      const rk = ranks(m.scores);
      for (let s = 0; s < 4; s++) assert.equal(rk[s], 1 + m.scores.filter((y) => y > m.scores[s]).length);
    }
  }
  // 同点：子ロン（放銃者以外の2人は100点で同順位）・流局（全員1位）
  const m = applyRoundResult(createMatch({ length: 1 }), { type: 'win', winner: 1, how: 'ron', from: 0, points: 4 });
  assert.deepEqual(m.scores, [84, 116, 100, 100]);
  assert.deepEqual(ranks(m.scores), [4, 1, 2, 2]);
  assert.deepEqual(ranks(applyRoundResult(createMatch({ length: 1 }), { type: 'draw' }).scores), [1, 1, 1, 1]);
});

test('4局戦・8局戦は従来どおり：親の和了で連荘、四家立直・流局で親交代', () => {
  for (const length of [4, 8]) {
    let m = createMatch({ length });
    m = applyRoundResult(m, { type: 'win', winner: 0, how: 'tsumo', from: null, points: 2 });
    assert.deepEqual([m.hand, m.renchan, m.over, m.log[0].dealerKeeps], [0, 1, false, true]);
    m = applyRoundResult(m, { type: 'draw', reason: 'four-riichi' });
    assert.deepEqual([m.hand, m.renchan, dealerOf(m)], [1, 0, 1]);
    for (let i = 1; i < length; i++) m = applyRoundResult(m, { type: 'draw' });
    assert.deepEqual([m.over, m.played, m.endReason], [true, length + 1, 'normal']);
  }
});

// 12人の AI の対局（数学Ⅰ・Ⅱ × 1局戦・4局戦・8局戦、ruleset 2）：四家立直の判定・保存則・400点・1局戦の終了
function playMatch({ mode, length, seed, ruleset = 2 }) {
  const rules = rulesFor(mode);
  const ids = Object.values(CHARACTER_ROSTER).flat().map((c) => c.id);
  const lineup = [0, 1, 2, 3].map((s) => ids[(seed * 5 + s * 3) % 12]);
  let match = createMatch({ length, startDealer: seed % 4 });
  let history = newPublicHistory();
  const rng = createRng(seed);
  const out = { rounds: 0, fourRiichi: 0, allRiichiWin: 0, tileCount: rules.deckSize };
  for (let r = 1; !match.over && r <= 40; r++) {
    const g = new Game({ rules, seed: seed * 101 + r, dealer: dealerOf(match), players, ruleset });
    for (let i = 0; g.pending(); i++) {
      if (i > 3000) throw new Error('no progress');
      const p = g.pending();
      applyAction(g, p.seat, decideCharacter(g, p.seat, lineup[p.seat], rng, { scores: match.scores, hand: match.hand, length, dealer: dealerOf(match), renchan: match.renchan, publicHistory: history }, lineup.slice(1)));
      g.checkInvariants(); // 牌の保存則（王牌を含む）
      // 四家立直：4人のリーチがそろったまま次のツモに進まない（ruleset 2）
      if (ruleset === 2 && g.riichi.every(Boolean) && g.pending()) assert.equal(g.pending().type, 'claim', '4人リーチで打牌に進んだ');
    }
    if (g.result.reason === 'four-riichi') { out.fourRiichi++; assert.ok(g.riichi.every(Boolean)); assert.equal(ruleset, 2); }
    if (g.result.type === 'win' && g.riichi.every(Boolean)) out.allRiichiWin++;
    if (mode === 'math2') assert.ok(g.normalDraws.every((x) => x <= 24));
    history = recordPublicRound(history, g.events, g.riichi);
    const before = match;
    match = applyRoundResult(match, g.result);
    assert.equal(total(match), 400);
    if (length === 1) assert.ok(match.over && match.played === 1, '1局戦は1局で終了');
    if (length > 1 && g.result.type === 'win' && g.result.winner === dealerOf(before)) assert.equal(match.renchan, before.renchan + 1);
    out.rounds++;
  }
  assert.ok(match.over);
  return out;
}

test('AI 対局（12人・数学Ⅰ/Ⅱ × 1局戦・4局戦・8局戦、ruleset 2）：保存則・400点・24回・1局戦は1局で終了・4人リーチで続行しない', () => {
  const sum = { rounds: 0, fourRiichi: 0, allRiichiWin: 0 };
  for (const mode of ['math1', 'math2']) {
    for (const [length, n] of [[1, 24], [4, 4], [8, 2]]) {
      for (let seed = 1; seed <= n; seed++) {
        const o = playMatch({ mode, length, seed: seed + length * 100 });
        for (const key of Object.keys(sum)) sum[key] += o[key];
      }
    }
  }
  assert.ok(sum.rounds > 100, `${sum.rounds}局`);
});

test('再現URL：len=1（1局戦）を受け付け、出力と読み直しが一致。1局戦にない親番・連荘・通し局数はエラー。len=4・8 と従来形式は従来どおり', async () => {
  const { validateReplay, replayQuery, REPLAY_LENGTHS } = await import('../src/ui/replay.js');
  const P = (q) => new URLSearchParams(q);
  assert.deepEqual(REPLAY_LENGTHS, [1, 4, 8]);
  const v = { seed: 77, round: 1, dealer: 2, hand: 0, renchan: 0, len: 1, mode: 'math2', chars: ['kanata', 'mitsuki', 'aoto'], ruleset: 2 };
  const q = replayQuery(v);
  assert.equal(q, '?seed=77&round=1&dealer=2&hand=0&renchan=0&len=1&mode=math2&chars=kanata,mitsuki,aoto&newrules=2');
  const r = validateReplay(P(q.slice(1)));
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual([r.values.len, r.values.lenGiven, r.values.dealer, r.values.ruleset], [1, true, 2, 2]);
  assert.equal(replayQuery(r.values), q);
  const err = (s) => validateReplay(P(s)).errors.map((e) => e.key);
  // 親番 1・連荘 1 は通し局数 2 以上が必要（1局戦は 1 だけ）なので round も同時にエラー
  assert.deepEqual(err('seed=5&round=2&dealer=1&hand=1&renchan=0&len=1'), ['hand', 'round']);
  assert.deepEqual(err('seed=5&round=2&dealer=0&hand=0&renchan=1&len=1'), ['renchan', 'round']);
  assert.deepEqual(err('seed=5&round=3&dealer=0&hand=0&renchan=0&len=1'), ['round']);
  for (const bad of ['0', '2', '3', '5', '16']) assert.deepEqual(err(`seed=5&round=1&dealer=0&hand=0&renchan=0&len=${bad}`), ['len'], bad);
  // 4局戦・8局戦の連荘・親番は従来どおり有効
  assert.ok(validateReplay(P('seed=5&round=4&dealer=1&hand=1&renchan=2&len=4')).ok);
  assert.ok(validateReplay(P('seed=5&round=9&dealer=3&hand=7&renchan=0&len=8&newrules=1')).ok);
  // 従来形式（hand なし）は保存された局数を既定に使う（1局戦なら親番 0）
  const legacy = validateReplay(P('seed=5&round=3'), { defaultLen: 1 });
  assert.ok(legacy.ok); assert.deepEqual([legacy.kind, legacy.values.hand, legacy.values.len, legacy.values.lenGiven], ['legacy', 0, 1, false]);
});
