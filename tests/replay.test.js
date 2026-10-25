// 再現 URL の検証・出力（src/ui/replay.js）と、通し局数の上限による試合終了（src/engine/match.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReplay, replayQuery } from '../src/ui/replay.js';
import { MAX_SEED, MAX_ROUND, MAX_RENCHAN } from '../src/ui/params.js';
import { createMatch, applyRoundResult, matchAt, dealerOf, handLabel } from '../src/engine/match.js';
import { createRng } from '../src/engine/rng.js';

const P = (q) => new URLSearchParams(q);
const v = (q, o) => validateReplay(P(q), o);
const base = 'seed=9&mode=math2&dealer=0';
const url = (round, hand, renchan, len = 4, dealer = hand % 4) => `seed=9&round=${round}&dealer=${dealer}&hand=${hand}&renchan=${renchan}&len=${len}&mode=math2`;

test('必須ケース：連荘・親番・通し局数の組み合わせ（round ≥ hand + renchan + 1）', () => {
  assert.equal(v(`${base}&round=1&hand=0&renchan=999999&len=4`).ok, false, '1: round=1・renchan=999999');
  assert.equal(v(`${base}&round=1&hand=0&renchan=0&len=4`).ok, true, '2');
  assert.equal(v(url(100, 0, 99)).ok, true, '3: round=100・renchan=99');
  assert.equal(v(url(100, 0, 100)).ok, false, '4: round=100・renchan=100');
  assert.equal(v(url(100, 2, 97)).ok, true, '5: round=100・hand=2・renchan=97');
  assert.equal(v(url(100, 2, 98)).ok, false, '6: round=100・hand=2・renchan=98');
  assert.equal(v(url(MAX_ROUND, 0, 999999)).ok, true, '7: round=1000000・renchan=999999');
  assert.equal(v(url(10, 4, 0, 4)).ok, false, '8: 4局戦で hand=4');
  assert.equal(v(url(10, 7, 0, 8)).ok, true, '9: 8局戦で hand=7');
  // 拒否の理由が分かる
  const r = v(`${base}&round=1&hand=0&renchan=999999&len=4`);
  assert.equal(r.kind, 'replay');
  assert.ok(r.errors.some((e) => e.key === 'round' && /不可能な局状態/.test(e.message)));
  assert.ok(v(url(10, 4, 0, 4)).errors.some((e) => e.key === 'hand'));
});

test('10：従来の ?seed=S&round=n 形式は従来どおり（同じ山・親。新形式の組み合わせ条件は適用しない）', () => {
  for (const [q, round, hand, dealer] of [
    ['seed=321&round=3', 3, 2, 2], ['seed=321', 1, 0, 0], ['seed=5&round=1', 1, 0, 0], ['seed=5&round=4', 4, 3, 3],
    ['seed=5&round=5', 5, 3, 0], ['seed=5&round=999', 999, 3, 2], ['seed=5&round=1000', 1000, 3, 3], [`seed=5&round=${MAX_ROUND}`, MAX_ROUND, 3, (MAX_ROUND - 1) % 4],
  ]) {
    const r = v(q, { defaultLen: 4 });
    assert.equal(r.kind, 'legacy', q);
    assert.equal(r.ok, true, q);
    assert.deepEqual([r.values.round, r.values.hand, r.values.dealer, r.values.renchan], [round, hand, dealer, 0], q);
  }
  assert.equal(v('seed=5&round=20', { defaultLen: 8 }).values.hand, 8 - 1, '8局戦では親番は 7 まで');
  assert.equal(v('seed=5&mode=math1&speed=slow').kind, 'legacy', '再現と無関係なパラメータは無視');
});

test('seed がない・不正な URL は再現ではない（none）。有効な seed でほかの値が不正なら ok=false', () => {
  for (const q of ['', 'speed=slow', 'seed=abc', 'seed=-1', 'seed=1000000000', 'seed=1.5', 'seed=']) assert.equal(v(q).kind, 'none', q);
  assert.equal(v('seed=5&round=0').ok, false, 'round=0');
  for (const bad of ['round=-3', 'round=2.5', 'round=1000001', 'round=99999999999999999999', 'round=1e3', 'round=', 'hand=8', 'hand=-1', 'dealer=4', 'dealer=-1',
    'renchan=1000000', 'renchan=-1', 'renchan=1.5', 'renchan=abc', 'len=5', 'len=0', 'len=', 'mode=math3', 'mode=']) {
    const r = v(`seed=5&${bad}`);
    assert.equal(r.ok, false, bad);
    assert.ok(r.errors.length >= 1);
  }
});

test('境界値：round・hand・renchan・len・dealer・seed', () => {
  const ok = (q) => assert.equal(v(q).ok, true, q);
  const ng = (q) => assert.equal(v(q).ok, false, q);
  ok(`seed=${MAX_SEED}&round=${MAX_ROUND}&dealer=3&hand=3&renchan=${MAX_ROUND - 4}&len=4`);
  ng(`seed=${MAX_SEED}&round=${MAX_ROUND}&dealer=3&hand=3&renchan=${MAX_ROUND - 3}&len=4`);
  ok(`seed=0&round=1&dealer=0&hand=0&renchan=0&len=8`);
  ng(`seed=0&round=1&dealer=0&hand=1&renchan=0&len=8`);
  ok(`seed=0&round=2&dealer=1&hand=1&renchan=0&len=8`);
  ok(`seed=0&round=2&dealer=0&hand=0&renchan=1&len=8`);
  ng(`seed=0&round=2&dealer=0&hand=1&renchan=1&len=8`);
  ok(`seed=0&round=8&dealer=3&hand=7&renchan=0&len=8`);
  ng(`seed=0&round=7&dealer=3&hand=7&renchan=0&len=8`);
  ng(`seed=0&round=${MAX_ROUND + 1}&dealer=0&hand=0&renchan=0&len=4`);
  ng(`seed=0&round=5&dealer=0&hand=0&renchan=${MAX_RENCHAN + 1}&len=4`);
  // 親の席は起家を逆算して任意（0〜3）を許す
  for (let d = 0; d < 4; d++) ok(`seed=1&round=9&dealer=${d}&hand=2&renchan=3&len=8`);
  // 足りない項目は従来形式と同じ既定値：renchan だけ、hand だけ
  assert.equal(v('seed=1&round=5&renchan=1').ok, true);
  assert.deepEqual([v('seed=1&round=5&renchan=1').values.hand, v('seed=1&round=5&renchan=1').values.renchan], [3, 1]);
  assert.equal(v('seed=1&round=4&renchan=1').ok, false, '既定の親番 3 + 連荘 1 には 5 局必要');
  assert.equal(v('seed=1&renchan=2').ok, false, 'round が省略（=1）なら連荘は 0 のはず');
});

// 独立の判定（別実装）：整数の範囲と組み合わせ条件を素直に書いた真理値
function oracle({ seed, round, hand, renchan, dealer, len }) {
  const int = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
  return int(seed, 0, MAX_SEED) && int(round, 1, MAX_ROUND) && int(len, 4, 8) && (len === 4 || len === 8) && int(hand, 0, len - 1)
    && int(renchan, 0, MAX_RENCHAN) && int(dealer, 0, 3) && round >= hand + renchan + 1;
}

test('ランダムな組み合わせ（20万件）：検証結果が独立した判定と一致し、受理した値は URL の往復で変わらない', () => {
  const rng = createRng(2024);
  const pick = (a) => a[Math.floor(rng.next() * a.length)];
  const big = [0, 1, 2, 3, 4, 5, 7, 8, 9, 98, 99, 100, 101, 998, 999, 1000, 1001, 99999, 100000, MAX_ROUND - 1, MAX_ROUND, MAX_ROUND + 1];
  let accepted = 0;
  for (let i = 0; i < 200000; i++) {
    const t = {
      seed: pick([0, 1, 12345, MAX_SEED]), round: rng.next() < 0.5 ? 1 + Math.floor(rng.next() * 12) : pick(big),
      hand: Math.floor(rng.next() * 10), renchan: rng.next() < 0.5 ? Math.floor(rng.next() * 12) : pick(big), dealer: Math.floor(rng.next() * 5), len: pick([4, 8, 4, 8, 5, 0]),
    };
    const q = replayQuery(t);
    const r = validateReplay(P(q.slice(1)));
    assert.equal(r.ok, oracle(t), q);
    if (r.ok) {
      accepted++;
      assert.deepEqual([r.values.round, r.values.hand, r.values.renchan, r.values.dealer, r.values.len, r.values.seed], [t.round, t.hand, t.renchan, t.dealer, t.len, t.seed]);
      // 往復：受理した値から作った URL を、もう一度検証しても同じ
      assert.equal(replayQuery(r.values), q);
    }
  }
  assert.ok(accepted > 5000, `受理 ${accepted}`);
});

test('正規に始めた試合が生成するすべての再現 URL は、再び正常に読み取れる（開始位置・連荘・起家をランダムに）', () => {
  const rng = createRng(77);
  let urls = 0;
  for (let k = 0; k < 400; k++) {
    const len = rng.next() < 0.5 ? 4 : 8;
    // 開始：通常の開始、従来形式（?round）、新形式の途中（hand・renchan・dealer）
    const kind = Math.floor(rng.next() * 3);
    let round = 1;
    let m = createMatch({ length: len });
    if (kind === 1) {
      round = 1 + Math.floor(rng.next() * 30);
      const r = validateReplay(P(`seed=3&round=${round}`), { defaultLen: len });
      assert.equal(r.ok, true);
      m = matchAt({ length: len, hand: r.values.hand, renchan: 0, startDealer: (((r.values.dealer - r.values.hand) % 4) + 4) % 4 });
    } else if (kind === 2) {
      const hand = Math.floor(rng.next() * len);
      const renchan = Math.floor(rng.next() * 6);
      round = hand + renchan + 1 + Math.floor(rng.next() * 5);
      const dealer = Math.floor(rng.next() * 4);
      const r = validateReplay(P(replayQuery({ seed: 3, round, dealer, hand, renchan, len }).slice(1)));
      assert.equal(r.ok, true);
      m = matchAt({ length: len, hand, renchan, startDealer: (((dealer - hand) % 4) + 4) % 4 });
    }
    let guard = 0;
    while (!m.over && guard++ < 60) {
      // 現在の局の再現 URL（設定画面・局結果画面が出すもの）
      const q = replayQuery({ seed: 3, round, dealer: dealerOf(m), hand: m.hand, renchan: m.renchan, len: m.length, mode: 'math1' });
      const r = validateReplay(P(q.slice(1)));
      assert.equal(r.ok, true, `${q}: ${JSON.stringify(r.errors)}`);
      assert.deepEqual([r.values.round, r.values.hand, r.values.renchan, r.values.dealer], [round, m.hand, m.renchan, dealerOf(m)]);
      urls++;
      // ランダムな結果（親の和了が多めになるよう偏らせて、長い連荘も作る）
      const d = dealerOf(m);
      const x = rng.next();
      const res = x < 0.55 ? { type: 'win', winner: d, how: x < 0.3 ? 'tsumo' : 'ron', from: (d + 1) % 4, points: 2 } : x < 0.9 ? { type: 'win', winner: (d + 1) % 4, how: 'tsumo', from: null, points: 3 } : { type: 'draw' };
      m = applyRoundResult(m, res, { round, maxRound: MAX_ROUND });
      round++;
    }
  }
  assert.ok(urls > 2000, `URL ${urls}`);
});

test('上限付近まで連荘を続けても、出力する URL は上限で必ず読み取れ、上限の局で試合が終わる', () => {
  // round = MAX_ROUND − 3 から、親が和了し続ける（連荘）
  let m = matchAt({ length: 4, hand: 0, renchan: MAX_ROUND - 4 });
  let round = MAX_ROUND - 3;
  const seen = [];
  while (!m.over) {
    const q = replayQuery({ seed: MAX_SEED, round, dealer: dealerOf(m), hand: m.hand, renchan: m.renchan, len: 4 });
    assert.equal(validateReplay(P(q.slice(1))).ok, true, q);
    seen.push(round);
    m = applyRoundResult(m, { type: 'win', winner: 0, how: 'tsumo', from: null, points: 2 }, { round, maxRound: MAX_ROUND });
    round++;
  }
  assert.deepEqual(seen, [MAX_ROUND - 3, MAX_ROUND - 2, MAX_ROUND - 1, MAX_ROUND]);
  assert.equal(m.endReason, 'round-limit');
});

// ---------------- P3：終了の理由 ----------------
const tsumo = (winner, points = 2) => ({ type: 'win', winner, how: 'tsumo', from: null, points });
const ron = (winner, from, points = 2) => ({ type: 'win', winner, how: 'ron', from, points });
const draw = { type: 'draw' };
const LIM = { round: MAX_ROUND, maxRound: MAX_ROUND };

test('終了理由：通常の東4局終了・南4局終了は normal、続行中は null', () => {
  let m = createMatch({ length: 4 });
  assert.equal(m.endReason, null);
  for (let i = 0; i < 4; i++) { assert.equal(m.endReason, null); m = applyRoundResult(m, draw, { round: i + 1, maxRound: MAX_ROUND }); }
  assert.deepEqual([m.over, m.endReason], [true, 'normal']);
  let e = createMatch({ length: 8 });
  for (let i = 0; i < 8; i++) e = applyRoundResult(e, draw, { round: i + 1, maxRound: MAX_ROUND });
  assert.deepEqual([e.over, e.endReason, e.played], [true, 'normal', 8]);
  // 最終の親の連荘中は続行（終了理由なし）
  let f = matchAt({ length: 4, hand: 3 });
  f = applyRoundResult(f, tsumo(3), { round: 4, maxRound: MAX_ROUND });
  assert.deepEqual([f.over, f.endReason, f.renchan], [false, null, 1]);
});

test('上限の局（round=1,000,000）：親の和了・子の和了・流局のどれでも round-limit で終了し、精算は1回だけ・合計400', () => {
  for (const [name, res, expectDeltas] of [
    ['親が和了', tsumo(0, 2), [12, -4, -4, -4]],
    ['子が和了', tsumo(1, 2), [-4, 8, -2, -2]],
    ['親ロン', ron(0, 2, 2), [12, 0, -12, 0]],
    ['流局', draw, [0, 0, 0, 0]],
  ]) {
    const m0 = matchAt({ length: 8, hand: 0, renchan: 0 });
    const m = applyRoundResult(m0, res, LIM);
    assert.deepEqual([m.over, m.endReason], [true, 'round-limit'], name);
    assert.deepEqual(m.scores.map((x, i) => x - 100), expectDeltas, `${name}: 精算は1回だけ`);
    assert.equal(m.scores.reduce((a, b) => a + b, 0), 400);
    assert.equal(m.log.length, 1);
    assert.throws(() => applyRoundResult(m, draw, LIM), /over/, `${name}: 上限終了後は次局へ進めない`);
  }
  // 連荘の規則は、上限の直前まで通常どおり
  let m = matchAt({ length: 4, hand: 0, renchan: 0 });
  m = applyRoundResult(m, tsumo(0), { round: MAX_ROUND - 1, maxRound: MAX_ROUND });
  assert.deepEqual([m.over, m.endReason, m.renchan], [false, null, 1]);
});

test('優先順位：同じ局で通常の終了条件も満たすなら normal（上限がなくても終わる試合）', () => {
  // 東4局（最終の親番）で子が和了／流局 → 通常終了
  for (const res of [draw, tsumo(1), ron(2, 0)]) {
    const m = applyRoundResult(matchAt({ length: 4, hand: 3 }), res, LIM);
    assert.deepEqual([m.over, m.endReason], [true, 'normal']);
  }
  // 東4局で親が和了（通常なら連荘で続く）→ 上限で打ち切り
  const m = applyRoundResult(matchAt({ length: 4, hand: 3 }), tsumo(3), LIM);
  assert.deepEqual([m.over, m.endReason, m.renchan], [true, 'round-limit', 1]);
  // 8局戦の南4局も同様
  assert.equal(applyRoundResult(matchAt({ length: 8, hand: 7 }), draw, LIM).endReason, 'normal');
  assert.equal(applyRoundResult(matchAt({ length: 8, hand: 7 }), tsumo(3), LIM).endReason, 'round-limit');
  // 上限の指定がなければ従来どおり（opts は省略可能）
  assert.deepEqual([applyRoundResult(createMatch({ length: 4 }), draw).over, applyRoundResult(matchAt({ length: 4, hand: 3 }), draw).endReason], [false, 'normal']);
  assert.equal(handLabel(matchAt({ length: 4, hand: 3 })), '東4局');
});
