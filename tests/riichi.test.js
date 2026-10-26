// リーチ（エンジン）：宣言の条件・待ち・ツモ切りの強制・鳴きの禁止・加点・役満・精算
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulesFor, rules as LEGACY, makeGame, findTile, idx } from './helpers.js';
import { settle } from '../src/engine/match.js';

const MODES = ['math1', 'math2'];
// 自分（親・席0）：sin30=1/2・cos180=−1 が完成、tan・45 は =1 待ち。最初のツモは 0（不要牌）
const TENPAI = ['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'];
// 他家：互いに面子にならない牌（数学Ⅰにもある牌だけ）
const O1 = ['sin', 'sin', '0', '90', '90', '=-√3', '=√3', '150'];
const O2 = ['cos', '135', '=√3', '=-1/√2', '120', '120', 'tan', '=0'];
const O3 = ['=-1', 'tan', 'tan', '120', '=1/√3', '90', '=-1/√2', '=-√3'];

function scene(r, { hand = TENPAI, draws = ['0'], others = [O1, O2, O3] } = {}) {
  return makeGame({ r, hands: [hand, ...others], draws });
}
// 宣言待ちをすべて見送る
function passAll(g) {
  while (g.pending() && g.pending().type === 'claim') g.respond(g.pending().seat, { type: 'pass' });
}
// 他家3人がツモ切りして、自分の手番に戻す
function aroundToSelf(g) {
  for (let k = 0; k < 3; k++) {
    const p = g.pending();
    g.discard(p.seat, g.drawn);
    passAll(g);
  }
}
const key = (r, t) => r.types[t].key;

for (const mode of MODES) {
  const r = rulesFor(mode);

  test(`${mode}：聴牌なら宣言できる牌と待ちを返す（宣言できる牌が複数の場合）`, () => {
    const g = scene(r);
    const opts = g.riichiOptions(0);
    // 0 を捨てれば tan・45 の =1 待ち、45 を捨てれば tan・0 の =0 待ち（宣言できる牌が複数）。sin などは聴牌が崩れる
    const by = Object.fromEntries(opts.map((o) => [key(r, o.type), o]));
    assert.deepEqual(Object.keys(by).sort(), ['a:0', 'a:45']);
    assert.deepEqual(by['a:0'].waits.map((t) => key(r, t)), ['v:1']);
    assert.deepEqual(by['a:45'].waits.map((t) => key(r, t)), ['v:0']);
    assert.deepEqual(by['a:0'].ids, [findTile(g, 0, '0')]);
    assert.deepEqual(g.riichiOptions(1), [], '自分の手番以外はなし');
    assert.equal(g.riichi[0], null);
  });

  test(`${mode}：聴牌でない手はリーチできない。宣言できない牌でのリーチは拒否`, () => {
    const g = scene(r, { hand: ['sin', '30', 'cos', '180', '=-1', 'tan', '135', '=√3'], draws: ['0'] });
    assert.deepEqual(g.riichiOptions(0), []);
    assert.throws(() => g.discard(0, findTile(g, 0, '0'), { riichi: true }), /riichi not possible/);
    const h = scene(r);
    assert.throws(() => h.discard(0, findTile(h, 0, 'sin'), { riichi: true }), /riichi not possible/, '聴牌が崩れる牌');
    assert.equal(h.riichi[0], null);
    assert.equal(h.hands[0].length, 9, '拒否された打牌は手牌を変えない');
  });

  test(`${mode}：リーチ後はツモ切りだけ（エンジンが拒否）。宣言牌は河に印、記録に riichi`, () => {
    const g = scene(r, { draws: ['0', '=-1/√3', '=-√3/2', '=-1/√2', '=0'] });
    const t0 = findTile(g, 0, '0');
    g.discard(0, t0, { riichi: true });
    assert.deepEqual(g.riichi[0], { tile: t0, turn: 1 });
    assert.equal(g.rivers[0][0].riichi, true);
    assert.ok(g.events.some((e) => e.type === 'riichi' && e.seat === 0));
    assert.deepEqual(g.viewFor(2).riichi, [true, false, false, false], 'リーチは公開情報');
    passAll(g);
    aroundToSelf(g);
    assert.deepEqual([g.pending().seat, g.pending().type], [0, 'turn']);
    const other = g.hands[0].find((id) => id !== g.drawn);
    assert.throws(() => g.discard(0, other), /tsumogiri only/);
    assert.throws(() => g.discard(0, g.drawn, { riichi: true }), /already in riichi/);
    assert.deepEqual(g.riichiOptions(0), [], 'リーチ中は再宣言なし');
    const drawn = g.drawn;
    g.discard(0, drawn);
    assert.equal(g.rivers[0].at(-1).id, drawn);
    g.checkInvariants();
  });

  test(`${mode}：リーチ後はチー・ポンできない（宣言待ちにも出ない）。ロンはできる`, () => {
    // 上家（席3）が sin を捨てる：自分は 30・1/2 でチー、sin×2 があればポンもできる形
    const hand = ['sin', 'sin', '30', '=1/2', 'cos', '180', '=-1', '45'];
    const g = scene(r, { hand, draws: ['0', '=-1/√3', '=-√3/2', 'sin'], others: [O1.map((x) => (x === 'sin' ? '135' : x)), O2, O3] });
    // 0 を捨てると sin・sin・30・1/2・cos・180・−1・45：sin30=1/2・cos180=−1 が完成、sin・45 は待ち（sin45 の値）
    const opt = g.riichiOptions(0).find((o) => key(r, o.type) === 'a:0');
    assert.ok(opt, 'リーチできる');
    g.discard(0, findTile(g, 0, '0'), { riichi: true });
    passAll(g);
    // 下家・対面はツモ切り、上家は sin を捨てる
    for (const s of [1, 2]) { g.discard(s, g.drawn); passAll(g); }
    assert.equal(g.pending().seat, 3);
    assert.deepEqual(g.chiOptions(0, findTile(g, 3, 'sin')), [], 'チー不可');
    assert.equal(g.ponOption(0, findTile(g, 3, 'sin')), null, 'ポン不可');
    g.discard(3, findTile(g, 3, 'sin'));
    const p = g.pending();
    if (p && p.type === 'claim' && p.seat === 0) {
      assert.deepEqual([p.chi, p.pon], [[], null]);
      assert.throws(() => g.respond(0, { type: 'chi', option: 0 }), /invalid chi option/);
      assert.throws(() => g.respond(0, { type: 'pon' }), /pon not possible/);
    }
    g.checkInvariants();
  });

  test(`${mode}：リーチ後のロンは基本点＋1（役一覧にリーチ）。親子精算は従来の倍率`, () => {
    // 席0（親）がリーチ → 席1 が =1 を捨てて席0 がロン
    const g = scene(r, { draws: ['0', '=1'], others: [O1, O2, O3] });
    g.discard(0, findTile(g, 0, '0'), { riichi: true });
    passAll(g);
    g.discard(1, g.drawn);
    const p = g.pending();
    assert.deepEqual([p.seat, p.type, p.ron], [0, 'claim', true]);
    g.respond(0, { type: 'ron' });
    const res = g.result;
    const plain = r.analyzeWin(r.countsOf(g.hands[0].map((id) => g.typeOf(id))), [], { ron: true });
    assert.equal(res.points, plain.points + 1);
    assert.equal(res.analysis.riichi, true);
    assert.equal(res.analysis.riichiBonus, 1);
    assert.deepEqual(res.analysis.yaku.at(-1), { id: 'riichi', name: 'リーチ', points: 1, yakuman: false, riichi: true });
    // 親ロン：放銃者が 6B（B はリーチ込み）
    assert.deepEqual(settle(res, 0), [6 * res.points, -6 * res.points, 0, 0]);
    // 子がリーチ和了なら 4B
    assert.deepEqual(settle({ ...res, winner: 0 }, 2), [4 * res.points, -4 * res.points, 0, 0]);
  });

  test(`${mode}：リーチ後のツモは基本点＋1。リーチしない同じ和了は加点なし`, () => {
    const draws = ['0', '=-1/√3', '=-√3/2', '=-1/√2', '=1'];
    const g = scene(r, { draws });
    g.discard(0, findTile(g, 0, '0'), { riichi: true });
    passAll(g);
    aroundToSelf(g);
    assert.equal(g.pending().canTsumo, true);
    g.tsumo(0);
    const h = scene(r, { draws });
    h.discard(0, findTile(h, 0, '0'));
    passAll(h);
    aroundToSelf(h);
    h.tsumo(0);
    assert.equal(g.result.points, h.result.points + 1);
    assert.equal(h.result.analysis.riichi, undefined);
    // 子ツモ／親ツモの精算：倍率は従来どおり（親 6B・子は親 2B・ほか B）
    assert.deepEqual(settle(g.result, 0), [6 * g.result.points, -2 * g.result.points, -2 * g.result.points, -2 * g.result.points]);
  });

  test(`${mode}：鳴いた手はリーチできない`, () => {
    // 下家（席1）が sin を捨てた後、自分が手番で… ではなく、上家の打牌を自分がチーした後の手番で確認する
    const hand = ['30', '=1/2', 'cos', '180', '=-1', 'tan', '45', '0'];
    const g = scene(r, { hand, draws: ['=-1/√3', '=-1/√3', '=-√3/2', 'sin'], others: [O1.map((x) => (x === 'sin' ? '135' : x)), O2, ['=-1', 'tan', 'tan', '120', '=1/√3', '90', '=-1/√2', 'sin']] });
    g.discard(0, g.drawn); passAll(g);
    g.discard(1, g.drawn); passAll(g);
    g.discard(2, g.drawn); passAll(g);
    g.discard(3, findTile(g, 3, 'sin'));
    const p = g.pending();
    assert.equal(p.seat, 0);
    const ci = p.chi.findIndex((o) => r.melds[o.meld].tiles.includes(idx('30', r)));
    g.respond(0, { type: 'chi', option: ci });
    while (g.pending() && g.pending().type === 'claim') g.respond(g.pending().seat, { type: 'pass' });
    assert.equal(g.melds[0].length, 1);
    assert.deepEqual([g.pending().seat, g.pending().type], [0, 'turn']);
    assert.deepEqual(g.riichiOptions(0), [], '鳴いた手は不可');
    assert.throws(() => g.discard(0, findTile(g, 0, '0'), { riichi: true }), /riichi not possible/);
  });

  test(`${mode}：特殊和了（九角無双）の聴牌でもリーチでき、役満にはリーチの加点をしない`, () => {
    const hand = ['0', '30', '45', '60', '90', '120', '135', '150'];
    const draws = ['=0', '=-1/√3', '=-√3/2', '=-1/√2', '180'];
    const g = scene(r, { hand, draws });
    const opt = g.riichiOptions(0).find((o) => key(r, o.type) === 'v:0');
    assert.ok(opt, '9種の角度の特殊和了も聴牌');
    assert.ok(opt.waits.some((t) => key(r, t) === 'a:180'));
    g.discard(0, findTile(g, 0, '=0'), { riichi: true });
    passAll(g);
    aroundToSelf(g);
    g.tsumo(0);
    const a = g.result.analysis;
    assert.equal(a.kind, 'special');
    assert.equal(a.yakuman, true);
    assert.equal(g.result.points, 16, '役満は 16 点のまま（リーチの加点なし）');
    assert.equal(a.riichi, true);
    assert.equal(a.riichiBonus, 0);
    assert.ok(!a.yaku.some((y) => y.id === 'riichi'), '役の一覧にリーチを加えない');
  });
}

test('待ちの数え方：手の内でその種類を全部使っている牌は待ちにしない（総枚数は牌ごとの copies）', () => {
  const r = rulesFor('math2');
  const g = scene(r);
  // 1/2 を copies 枚持つ手：さらに 1/2 で和了する形は物理的にあり得ない
  const half = idx('=1/2', r);
  const c = new Array(r.T).fill(0);
  c[half] = r.types[half].copies;
  assert.ok(!g.waitsOf(c).includes(half));
  // 関数牌は数学Ⅱで16枚（4枚とは限らない）：copies 未満なら数える
  const sin = idx('sin', r);
  assert.equal(r.types[sin].copies, 16);
  const d = r.countsOf(['sin', 'sin', '30', '45', '90', '=1/2'].map((x) => idx(x, r)));
  // sin30=1/2 完成＋sin45・sin90 の片割れ…（待ちの有無は analyzeWin に従う）。waitsOf は入力を変更しない
  const before = d.slice();
  g.waitsOf(d);
  assert.deepEqual(d, before);
});

test('旧規則（Ver.0.2.1 互換）ではリーチなし', () => {
  const g = makeGame({ hands: [TENPAI, O1, O2, O3], draws: ['0'] });
  assert.equal(g.riichiEnabled, false);
  assert.deepEqual(g.riichiOptions(0), []);
  assert.throws(() => g.discard(0, findTile(g, 0, '0'), { riichi: true }), /riichi not possible/);
  void LEGACY;
});

// ---------------- AI のリーチ判断 ----------------
import { decide, riichiDecision, applyAction } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';

test('AI：聴牌になる打牌ならリーチ（初級・中級・上級、数学Ⅰ・Ⅱ）。宣言は合法', () => {
  for (const mode of MODES) {
    const r = rulesFor(mode);
    for (const lv of ['beginner', 'intermediate', 'advanced']) {
      const g = scene(r);
      const a = decide(g, 0, 'speed', createRng(5), lv);
      assert.equal(a.type, 'discard');
      const opt = g.riichiOptions(0).some((o) => o.type === g.typeOf(a.tile));
      // 初級は打牌を単純に選ぶので、聴牌が崩れる牌を捨てることもある（そのときはリーチしない）
      assert.equal(!!a.riichi, opt, `${mode} ${lv}`);
      if (lv !== 'beginner') assert.equal(a.riichi, true, `${mode} ${lv}：最善の打牌は聴牌`);
      applyAction(g, 0, a);
      assert.equal(!!g.riichi[0], !!a.riichi);
      g.checkInvariants();
    }
  }
});

test('AI：待ちの牌が自分から見て残っていなければ、中級・上級はリーチしない（初級はする）', () => {
  const r = rulesFor('math1');
  const g = scene(r);
  // =1 を全部（copies 枚）山から下家の河へ移す（公開情報で残り0枚。牌の総数・位置の不変条件は保つ）
  const one = idx('=1', r);
  const ids = g.wall.filter((id) => g.typeOf(id) === one);
  assert.equal(ids.length, r.types[one].copies);
  g.wall = g.wall.filter((id) => g.typeOf(id) !== one);
  for (const id of ids) g.rivers[1].push({ id, tsumogiri: true });
  const zero = findTile(g, 0, '0');
  assert.equal(riichiDecision(g, 0, zero, 'beginner'), true, '初級：聴牌ならリーチ');
  assert.equal(riichiDecision(g, 0, zero, 'intermediate'), false, '中級：待ちが残っていない');
  assert.equal(riichiDecision(g, 0, zero, 'advanced'), false, '上級：待ちが残っていない');
  // 45 を捨てる形（=0 待ち）は残っているのでリーチする
  assert.equal(riichiDecision(g, 0, findTile(g, 0, '45'), 'intermediate'), true);
  // 聴牌にならない打牌・旧規則ではリーチしない
  assert.equal(riichiDecision(g, 0, findTile(g, 0, 'sin'), 'beginner'), false);
  const legacy = makeGame({ hands: [TENPAI, O1, O2, O3], draws: ['0'] });
  assert.equal(riichiDecision(legacy, 0, findTile(legacy, 0, '0'), 'beginner'), false);
});

test('AI：リーチ中はツモ切り、和了できればツモ（全難易度）。リーチ後に鳴かない', () => {
  const r = rulesFor('math1');
  for (const lv of ['beginner', 'intermediate', 'advanced']) {
    const g = scene(r, { draws: ['0', '=-1/√3', '=-√3/2', '=-1/√2', '=0', '=-1/√3', '=-√3/2', '=-1/√2', '=1'] });
    g.discard(0, findTile(g, 0, '0'), { riichi: true });
    passAll(g);
    aroundToSelf(g);
    let a = decide(g, 0, 'value', createRng(1), lv);
    assert.deepEqual(a, { type: 'discard', tile: g.drawn }, `${lv}：ツモ切り`);
    applyAction(g, 0, a);
    passAll(g);
    aroundToSelf(g);
    a = decide(g, 0, 'value', createRng(1), lv);
    assert.deepEqual(a, { type: 'tsumo' }, `${lv}：ツモ和了`);
    applyAction(g, 0, a);
    assert.equal(g.result.analysis.riichi, true);
  }
});
