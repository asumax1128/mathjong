// 新ルール①〜④（newRules: true のときだけ）：王牌14枚・ドラ表示の再抽選・嶺上牌・暗カン・カンドラ・
// 数学Ⅱの通常ツモ24回・ドラの加点・AIの合法手と公開情報。旧ルール（既定）の形が変わらないことも確認する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/engine/config.js';
import { createRules } from '../src/engine/rules.js';
import { Game } from '../src/engine/game.js';
import { createDeadWall } from '../src/engine/dead-wall.js';
import { decide, applyAction, ankanDecision } from '../src/engine/ai.js';
import { decideCharacter, CHARACTER_ROSTER, newPublicHistory, recordPublicRound } from '../src/engine/characters.js';
import { createMatch, applyRoundResult, dealerOf } from '../src/engine/match.js';
import { createRng } from '../src/engine/rng.js';
import { k } from './helpers.js';

const R = { math1: createRules(makeConfig({ mode: 'math1' })), math2: createRules(makeConfig({ mode: 'math2' })) };
const players = [0, 1, 2, 3].map((s) => ({ name: 'P' + s, kind: 'ai', personality: 'speed' }));
const typeIdx = (rules, s) => rules.typeByKey.get(k(s)).idx;
const keyOf = (g, id) => g.rules.types[g.typeOf(id)].key;
const ALL_IDS = (g) => g.tileType.map((_, i) => i);

// ---- 物理牌の入れ替え（保存則を保つ：2つの場所の牌IDを交換するだけ）----
function containers(g) {
  const list = [...g.hands, g.wall];
  if (g.deadWall) list.push(g.deadWall.rinshan, ...g.deadWall.pairs, g.deadWall.replenished);
  return list;
}
function where(g, id) {
  for (const c of containers(g)) { const i = c.indexOf(id); if (i >= 0) return [c, i]; }
  throw new Error('tile not movable: ' + id);
}
function swap(g, a, b) {
  if (a === b) return;
  const [ca, ia] = where(g, a), [cb, ib] = where(g, b);
  ca[ia] = b; cb[ib] = a;
}
const revealedIds = (g) => new Set(g.deadWall ? g.deadWall.indicators.map((d) => d.id) : []);
// 席 seat の手牌を keys（短縮表記）にする。ツモ牌（g.drawn）は手牌の最後に置く
function setHand(g, seat, keys) {
  const hand = g.hands[seat];
  assert.equal(hand.length, keys.length);
  const used = new Set(revealedIds(g));
  const chosen = keys.map((s) => {
    const t = typeIdx(g.rules, s);
    const id = ALL_IDS(g).find((x) => g.typeOf(x) === t && !used.has(x) && !g.rivers.flat().some((r) => r.id === x) && !g.melds.flat().some((m) => m.tiles.includes(x)));
    if (id === undefined) throw new Error('no tile ' + s);
    used.add(id);
    return id;
  });
  chosen.forEach((id, i) => swap(g, hand[i], id));
  if (g.current === seat && g.phase === 'turn' && g.drawn !== null && g.drawn !== undefined) g.drawn = hand.at(-1);
}
// 嶺上牌を keys の順に引かれるよう並べる（rinshan.pop() で末尾から引く）
function setRinshan(g, keys) {
  const used = new Set([...revealedIds(g), ...g.hands.flat()]);
  keys.forEach((s, n) => {
    const t = typeIdx(g.rules, s);
    const id = g.wall.find((x) => g.typeOf(x) === t && !used.has(x));
    if (id === undefined) throw new Error('no live tile ' + s);
    used.add(id);
    swap(g, g.deadWall.rinshan[g.deadWall.rinshan.length - 1 - n], id);
  });
}
const total = (g) => g.wall.length + g.hands.flat().length + g.rivers.flat().length + g.melds.flat().reduce((n, m) => n + m.tiles.length, 0) + (g.deadWall ? g.deadWall.allPhysical().length : 0);
function conserved(g) {
  assert.equal(g.checkInvariants(), true);
  assert.equal(total(g), g.tileType.length);
  if (g.deadWall) assert.equal(g.deadWall.allPhysical().length, 14, '王牌は常に14枚');
}
const passAll = (g) => { while (g.pending() && g.pending().type === 'claim') g.respond(g.pending().seat, { type: 'pass' }); };
const newGame = (mode, seed = 1, dealer = 0) => new Game({ rules: R[mode], seed, dealer, players, newRules: true });

// ======================= ① 王牌・ドラ表示・再抽選 =======================
test('① 王牌：14枚（嶺上4＋表示候補5組×2）を通常の山の底から分ける。牌の種類・枚数・物理IDは変えない', () => {
  for (const mode of ['math1', 'math2']) {
    const legacy = new Game({ rules: R[mode], seed: 33, dealer: 2, players });
    const g = newGame(mode, 33, 2);
    // 配牌と親の最初のツモは旧ルールと同じ。通常の山＝旧ルールの山から底の14枚を除いたもの
    assert.deepEqual(g.hands, legacy.hands);
    assert.deepEqual(g.wall, legacy.wall.slice(14));
    assert.deepEqual(g.deadWall.allPhysical().slice().sort((a, b) => a - b), legacy.wall.slice(0, 14).sort((a, b) => a - b));
    assert.equal(g.deadWall.rinshan.length, 4);
    assert.equal(g.deadWall.pairs.length, 5);
    assert.equal(g.doraIndicators.length, 1);
    conserved(g);
    assert.deepEqual([...g.tileType], [...legacy.tileType], '牌の種類・枚数・物理IDは同じ');
  }
});

test('① ドラ表示：1枚目の候補が関数牌なら1回だけ2枚目へ。2枚目も関数牌ならそのまま確定。採用しなかった牌は王牌に残る', () => {
  const rules = R.math1;
  const tileType = [];
  for (const t of rules.types) for (let c = 0; c < t.copies; c++) tileType.push(t.idx);
  const idOf = (s, n = 0) => tileType.map((t, i) => [t, i]).filter(([t]) => t === typeIdx(rules, s))[n][1];
  const filler = (excl) => tileType.map((_, i) => i).filter((i) => !excl.includes(i));
  const make = (first, second) => {
    const head = [idOf('0', 0), idOf('0', 1), idOf('0', 2), idOf('0', 3), first, second];
    const rest = filler(head);
    const wall = [...head, ...rest.slice(0, 8), ...rest.slice(8, 40)];
    const before = wall.slice();
    const dw = createDeadWall(wall, tileType, rules.types);
    return { dw, wall, before };
  };
  const a = make(idOf('30'), idOf('sin'));
  assert.equal(a.dw.indicators[0].id, idOf('30'), '関数牌でなければ1枚目');
  const b = make(idOf('sin'), idOf('45'));
  assert.equal(b.dw.indicators[0].id, idOf('45'), '関数牌なら2枚目へ（1回だけ）');
  assert.ok(b.dw.allPhysical().includes(idOf('sin')), '採用しなかった候補は王牌に残る');
  const c = make(idOf('sin'), idOf('cos'));
  assert.equal(c.dw.indicators[0].id, idOf('cos'), '2枚目も関数牌ならそのまま確定（関数牌ドラも可）');
  for (const x of [a, b, c]) {
    assert.equal(x.dw.allPhysical().length, 14);
    assert.deepEqual([...x.dw.allPhysical(), ...x.wall].sort((p, q) => p - q), x.before.slice().sort((p, q) => p - q));
  }
});

test('① ドラは表示牌の次の種類（同じ種類の中で循環）', () => {
  const rules = R.math1;
  const tileType = [];
  for (const t of rules.types) for (let c = 0; c < t.copies; c++) tileType.push(t.idx);
  const firstId = (s) => tileType.indexOf(typeIdx(rules, s));
  const doraOf = (s) => {
    const ind = firstId(s);
    const wall = [0, 1, 2, 3, ind, ind, ...tileType.map((_, i) => i).filter((i) => i > 3 && i !== ind).slice(0, 40)];
    return rules.types[createDeadWall(wall, tileType, rules.types).indicators[0].type].key;
  };
  assert.equal(doraOf('30'), 'a:45');
  assert.equal(doraOf('180'), 'a:0', '数学Ⅰの最大角180°の次は0°');
  assert.equal(doraOf('=-√3'), 'v:-1', '値は小さい順：−√3 の次は −1');
  assert.equal(doraOf('=√3'), 'v:-√3', '最大の値の次は最小の値');
  assert.equal(doraOf('=1/2'), 'v:1/√3', '1/2（0.5）の次は 1/√3（約0.577）');
});

test('① 嶺上牌は最大4枚。カンのたびに通常の山の最後の牌を王牌へ補充し、王牌は14枚のまま。表示は最大5枚', () => {
  const g = newGame('math2', 5);
  const dw = g.deadWall, live = g.wall.length;
  const rin = dw.rinshan.slice();
  for (let n = 1; n <= 4; n++) {
    const last = g.wall[0];
    const id = dw.replacement();
    assert.equal(id, rin[4 - n], '嶺上牌は末尾から');
    assert.equal(dw.replenished.at(-1), last, '通常の山の最後に引かれる牌を補充');
    assert.equal(g.wall.length, live - n);
    dw.reveal();
    assert.equal(dw.indicators.length, 1 + n);
    g.hands[0].push(id); // テストだけ：手牌へ（保存則の計算のため）
    assert.equal(dw.allPhysical().length, 14);
    assert.equal(total(g), g.tileType.length);
  }
  assert.throws(() => dw.replacement(), /no rinshan/);
  assert.throws(() => dw.reveal(), /no more dora/);
});

test('① seed 固定で王牌・ドラ表示・対局全体を完全に再現する', () => {
  for (const mode of ['math1', 'math2']) for (const seed of [3, 41, 777]) {
    const run = () => {
      const g = newGame(mode, seed, seed % 4);
      const rng = createRng(seed * 13 + 1);
      while (g.pending()) { const p = g.pending(); applyAction(g, p.seat, decide(g, p.seat, 'speed', rng)); }
      return JSON.stringify({ dw: [g.deadWall.rinshan, g.deadWall.pairs, g.deadWall.replenished, g.deadWall.indicators], ev: g.events, res: g.result });
    };
    assert.equal(run(), run());
  }
});

// ======================= 旧ルールとの分離 =======================
test('旧ルール（既定）：王牌なし、pending()・viewFor() は従来と同じ形。同じ rules を新旧で使っても混ざらない', () => {
  for (const mode of ['math1', 'math2']) {
    const a = new Game({ rules: R[mode], seed: 9, dealer: 0, players });
    const b = newGame(mode, 9, 0);
    const c = new Game({ rules: R[mode], seed: 9, dealer: 0, players });
    assert.equal(a.deadWall, null);
    assert.equal(a.newRules, false);
    assert.deepEqual(Object.keys(a.pending()).sort(), ['canTsumo', 'seat', 'type']);
    assert.deepEqual(Object.keys(a.viewFor(0)).sort(), ['dealer', 'drawn', 'hand', 'handCounts', 'melds', 'riichi', 'rivers', 'seat', 'wallCount']);
    assert.deepEqual(a.doraIndicators, []);
    assert.deepEqual(a.ankanOptions(0), []);
    assert.throws(() => a.ankan(0, a.typeOf(a.hands[0][0])), /ankan not possible/);
    assert.ok('ankan' in b.pending() && 'doraIndicators' in b.viewFor(0) && 'normalDraws' in b.viewFor(0));
    // 新ルールの局を作っても、その後の旧ルールの局は同じ
    assert.deepEqual(c.wall, a.wall);
    assert.deepEqual(c.hands, a.hands);
    // 旧ルールは数学Ⅱでも24回で止めない
    const L = new Game({ rules: R.math2, seed: 4, dealer: 0, players });
    while (L.pending()) { const p = L.pending(); if (p.type === 'claim') L.respond(p.seat, { type: 'pass' }); else L.discard(p.seat, L.drawn); }
    assert.equal(L.wall.length, 0, '旧ルールは山が尽きるまで');
    assert.ok(Math.max(...L.rivers.map((r) => r.length)) > 24);
  }
});

// ======================= ② 数学Ⅱの通常ツモ24回 =======================
test('② 数学Ⅱ：各自の通常ツモは24回まで（親の最初のツモを含む）。25回目が必要になったら流局。数学Ⅰは山が尽きるまで', () => {
  for (const seed of [1, 2, 3]) {
    const g = newGame('math2', seed, seed % 4);
    assert.equal(g.normalDraws[g.dealer], 1, '親の最初のツモを1回と数える');
    while (g.pending()) { const p = g.pending(); if (p.type === 'claim') g.respond(p.seat, { type: 'pass' }); else g.discard(p.seat, g.drawn); }
    assert.equal(g.result.type, 'draw');
    assert.ok(g.wall.length > 0, '山が残っていても24回で流局');
    assert.deepEqual(g.normalDraws, [24, 24, 24, 24]);
    assert.deepEqual(g.rivers.map((r) => r.length), [24, 24, 24, 24]);
    conserved(g);
  }
  const m1 = newGame('math1', 1);
  while (m1.pending()) { const p = m1.pending(); if (p.type === 'claim') m1.respond(p.seat, { type: 'pass' }); else m1.discard(m1.current, m1.drawn); }
  assert.equal(m1.result.type, 'draw');
  assert.equal(m1.wall.length, 0, '数学Ⅰは山が尽きて流局（回数の上限なし）');
});

test('② チー・ポン直後の打牌は通常ツモに数えない。鳴きで河が24枚を超えてもよい。24回の判定は次にツモる人ごと', () => {
  let maxRiver = 0, capped = 0, calls = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const g = newGame('math2', seed, seed % 4);
    const rng = createRng(seed);
    let lastDiscarder = null;
    while (g.pending()) {
      const p = g.pending();
      const before = g.normalDraws.slice();
      const a = p.type === 'claim' ? (p.pon ? { type: 'pon' } : p.chi.length ? { type: 'chi', option: 0 } : { type: 'pass' }) : decide(g, p.seat, 'speed', rng);
      if (a.type === 'discard') lastDiscarder = p.seat;
      const melds = g.melds.flat().length;
      applyAction(g, p.seat, a);
      if (g.melds.flat().length > melds && (a.type === 'chi' || a.type === 'pon')) {
        calls++;
        assert.deepEqual(g.normalDraws, before, '鳴いた人は通常ツモをしない');
        assert.equal(g.drawn, null);
      }
      assert.ok(g.normalDraws.every((n) => n <= 24));
    }
    conserved(g);
    maxRiver = Math.max(maxRiver, ...g.rivers.map((r) => r.length));
    if (g.result.type === 'draw' && g.wall.length > 0) {
      capped++;
      assert.equal(g.normalDraws[(lastDiscarder + 1) % 4], 24, '25回目が必要になった人は24回ツモ済み');
    }
  }
  assert.ok(calls > 0 && capped > 0, `鳴き ${calls}・24回の流局 ${capped}`);
  assert.ok(maxRiver >= 24, `鳴きを含む局の最大の河 ${maxRiver}枚（硬い上限なし）`);
});

// ======================= ③ 暗カン・嶺上ツモ・カンドラ =======================
test('③ 暗カン：同じ種類の物理牌4枚で成立、1面子・門前のまま、嶺上ツモ、カンドラを公開、手牌枚数を保存', () => {
  for (const mode of ['math1', 'math2']) {
    const g = newGame(mode, 7);
    setHand(g, 0, ['cos', '0', '=1', 'tan', '45', 'sin', 'sin', 'sin', 'sin']);
    setRinshan(g, ['90']);
    conserved(g);
    const sin = typeIdx(g.rules, 'sin');
    const p = g.pending();
    assert.deepEqual(p.ankan.map((o) => o.type), [sin]);
    const live = g.wall.length, events = g.events.length;
    const quad = p.ankan[0].ids.slice();
    g.ankan(0, sin);
    assert.equal(g.hands[0].length, 6, '9−4＋嶺上1');
    assert.deepEqual(g.melds[0].map((m) => [m.call, m.kind, m.tiles.length]), [['ankan', 'koutsu', 4]]);
    assert.deepEqual(g.melds[0][0].tiles, quad, '4枚目の物理牌も槓子に保持');
    assert.equal(g.isClosed(0), true, '暗カンは門前');
    assert.equal(keyOf(g, g.drawn), 'a:90', '嶺上牌をツモ');
    assert.equal(g.justDrew, true);
    assert.equal(g.doraIndicators.length, 2, 'カンドラ');
    assert.equal(g.wall.length, live - 1, '通常の山から王牌へ1枚補充');
    assert.deepEqual(g.events.slice(events).map((e) => e.type), ['ankan', 'rinshan', 'dora']);
    assert.equal(g.normalDraws[0], 1, '嶺上ツモは通常ツモと別枠');
    assert.equal(g.viewFor(1).doraIndicators.length, 2, '他家にも公開');
    conserved(g);
    // 嶺上ツモの後は打牌・リーチができる（門前の聴牌）
    assert.ok(g.riichiOptions(0).length > 0, '暗カンの後もリーチできる');
    g.discard(0, g.drawn, { riichi: true });
    assert.ok(g.riichi[0]);
    conserved(g);
  }
});

test('③ 嶺上ツモで和了：既存の9枚・3面子（槓子＝1面子）。門前なので役なしでも和了でき、ドラは加点だけ', () => {
  const g = newGame('math1', 11);
  setHand(g, 0, ['cos', '0', '=1', 'tan', '45', 'sin', 'sin', 'sin', 'sin']);
  setRinshan(g, ['=1']);
  g.ankan(0, typeIdx(g.rules, 'sin'));
  const p = g.pending();
  assert.equal(p.canTsumo, true, '嶺上牌で和了できる');
  g.tsumo(0);
  const r = g.result, a = r.analysis;
  assert.equal(r.how, 'tsumo');
  assert.equal(a.closed, true);
  assert.equal(a.melds.length, 3);
  const dora = g.doraIndicators.reduce((n, d) => n + [...g.hands[0], ...g.melds[0].flatMap((m) => m.tiles)].filter((id) => g.typeOf(id) === d.type).length, 0);
  assert.equal(a.doraBonus, dora);
  const base = g.rules.analyzeWin(g.countsOf(g.hands[0]), g.exposedMelds(0), { closed: true });
  assert.equal(r.points, base.points + dora, 'ドラ1枚につき+1点（基本点・役は変えない）');
  conserved(g);
});

test('③④ 暗カンの三暗刻・対々和、役満（関数一色）にはドラを加えない', () => {
  const g = newGame('math1', 13);
  setHand(g, 0, ['sin', 'sin', 'sin', 'sin', 'cos', 'cos', 'cos', 'tan', 'tan']);
  setRinshan(g, ['tan']);
  g.ankan(0, typeIdx(g.rules, 'sin'));
  g.tsumo(0);
  const ids = g.result.analysis.yaku.map((y) => y.id);
  assert.ok(ids.includes('sanankou') && ids.includes('toitoi'), ids.join());
  conserved(g);
  const y = newGame('math1', 13);
  setHand(y, 0, ['sin', 'sin', 'sin', 'sin', 'sin', 'sin', 'sin', 'sin', 'sin']);
  setRinshan(y, ['sin']);
  y.ankan(0, typeIdx(y.rules, 'sin'));
  // 2組目の4枚（sin×6のうち4枚）でも暗カンできるが、ここではツモ和了
  assert.equal(y.pending().canTsumo, true);
  y.tsumo(0);
  assert.equal(y.result.analysis.yakuman, true);
  assert.equal(y.result.points, 16, '役満の点は変えない');
  assert.equal(y.result.analysis.doraBonus, undefined);
});

test('③ ドラは単独では役にならない：鳴いた手で役がない形は、ドラがあっても和了にならない', () => {
  const g = newGame('math1', 15);
  const rules = g.rules;
  const exposed = [rules.meldOf(typeIdx(rules, 'sin'), typeIdx(rules, '30'), typeIdx(rules, '=1/2')).idx];
  // sin30°=1/2（チー）＋ sin150°=1/2 ＋ cos180°=−1：関数がそろわず、象限・値・角度もそろわない（役なし）
  const counts = rules.countsOf(['sin', '150', '=1/2', 'cos', '180', '=-1'].map((s) => typeIdx(rules, s)));
  assert.equal(rules.analyzeWin(counts, exposed), null, '鳴いた手（役なし）は和了不可');
  assert.ok(rules.analyzeWin(counts, exposed, { closed: true }), '同じ形でも門前なら和了（形は正しい）');
});

test('③ 不正な暗カンは拒否：手番以外・違う種類・チー直後・リーチ中・旧ルール', () => {
  const g = newGame('math1', 21);
  setHand(g, 0, ['cos', '0', '=1', 'tan', '45', 'sin', 'sin', 'sin', 'sin']);
  assert.throws(() => g.ankan(1, typeIdx(g.rules, 'sin')), /not 1's turn/);
  assert.throws(() => g.ankan(0, typeIdx(g.rules, 'cos')), /ankan not possible/);
  // チー直後：手牌に同じ種類が4枚あっても、ツモをしていないので暗カンできない
  const c = new Game({ rules: R.math1, seed: 1, dealer: 3, players, newRules: true,
    presetWall: (() => {
      const hands = [['sin', '30', 'cos', 'cos', 'cos', 'cos', 'tan', '45'], ['=-√3', '=-√3', '90', '90', '135', '135', '=√3', '=√3'], ['=-1/√2', '=-1/√2', '120', '120', '150', '150', '=1/√3', '=1/√3'], ['=-√3/2', '=-√3/2', '=0', '=0', '0', '0', '60', '60']];
      const keys = [];
      for (let r = 0; r < 8; r++) for (let j = 0; j < 4; j++) keys.push(k(hands[(3 + j) % 4][r]));
      keys.push(k('=1/2'));
      return keys;
    })() });
  c.discard(3, c.drawn);
  const p = c.pending();
  assert.equal(p.seat, 0); assert.ok(p.chi.length);
  const draws = c.normalDraws.slice();
  c.respond(0, { type: 'chi', option: 0 });
  assert.deepEqual(c.normalDraws, draws, 'チーは通常ツモに数えない');
  assert.equal(c.hands[0].filter((id) => keyOf(c, id) === 'f:cos').length, 4);
  assert.deepEqual(c.pending().ankan, [], 'チー直後は暗カン不可');
  assert.throws(() => c.ankan(0, typeIdx(c.rules, 'cos')), /ankan not possible/);
  conserved(c);
  // リーチ中：4枚目を引いても暗カンできない
  const r = newGame('math1', 23);
  setHand(r, 0, ['sin', 'sin', 'sin', 'cos', '0', '=1', 'tan', '45', '90']);
  r.discard(0, r.hands[0].find((id) => keyOf(r, id) === 'a:90'), { riichi: true });
  passAll(r);
  for (let s = 1; s <= 3; s++) { r.discard(s, r.drawn); passAll(r); }
  if (r.pending() && r.pending().seat === 0 && r.pending().type === 'turn') {
    const sinId = r.wall.find((id) => keyOf(r, id) === 'f:sin' && !r.hands[0].includes(id));
    swap(r, r.drawn, sinId); r.drawn = sinId;
    assert.equal(r.hands[0].filter((id) => keyOf(r, id) === 'f:sin').length, 4);
    assert.deepEqual(r.pending().ankan, [], 'リーチ中は暗カン不可');
    assert.throws(() => r.ankan(0, typeIdx(r.rules, 'sin')), /ankan not possible/);
  } else assert.fail('リーチ後に自分の手番に戻らない');
});

test('③ 暗カン0〜4回：毎回の物理牌の保存、王牌14枚、表示1〜5枚。4回でカン不可（嶺上牌0）', () => {
  const g = newGame('math2', 31);
  conserved(g);
  const kan = (seat, key) => { g.ankan(seat, typeIdx(g.rules, key)); conserved(g); };
  // 席0：2回（1回目の嶺上牌で2回目の4枚目がそろう）
  setHand(g, 0, ['sin', 'sin', 'sin', 'sin', 'cos', 'cos', 'cos', '0', '=1']);
  setRinshan(g, ['cos', '90']);
  const live = g.wall.length;
  kan(0, 'sin'); assert.equal(g.doraIndicators.length, 2);
  kan(0, 'cos'); assert.equal(g.doraIndicators.length, 3);
  assert.equal(g.hands[0].length, 3);
  assert.deepEqual(g.pending().ankan, [], '2回カンした手（3枚）にはもう4枚はない');
  g.discard(0, g.drawn); passAll(g);
  // 席1：2回
  assert.equal(g.pending().seat, 1);
  setHand(g, 1, ['tan', 'tan', 'tan', 'tan', '=1/2', '=1/2', '=1/2', '0', '=1']);
  setRinshan(g, ['=1/2', '90']);
  kan(1, 'tan'); kan(1, '=1/2');
  assert.equal(g.doraIndicators.length, 5);
  assert.equal(g.deadWall.rinshan.length, 0);
  assert.equal(g.wall.length, live - 4 - 1, 'カン4回の補充で4枚＋席1の通常ツモ1枚');
  assert.equal(g.deadWall.replenished.length, 4);
  g.discard(1, g.drawn); passAll(g);
  // 席2：4枚そろっても嶺上牌がないのでカンできない
  if (g.pending() && g.pending().seat === 2 && g.pending().type === 'turn') {
    setHand(g, 2, ['=0', '=0', '=0', '=0', '30', '45', '60', '90', '120']);
    assert.deepEqual(g.pending().ankan, []);
    assert.throws(() => g.ankan(2, typeIdx(g.rules, '=0')), /ankan not possible/);
  }
  conserved(g);
});

test('③ 山切れ直前：通常の山が1枚でも暗カンでき、補充でその1枚を王牌へ。直後の打牌で流局', () => {
  const g = newGame('math1', 41);
  setHand(g, 0, ['cos', '0', '=1', 'tan', '45', 'sin', 'sin', 'sin', 'sin']);
  setRinshan(g, ['90']);
  // 通常の山を1枚だけ残す（テスト用：残りを対面の河へ移す。牌の総数は変えない）
  while (g.wall.length > 1) g.rivers[2].push({ id: g.wall.shift(), tsumogiri: true });
  assert.ok(g.ankanOptions(0).length, '山1枚なら暗カンできる');
  g.ankan(0, typeIdx(g.rules, 'sin'));
  assert.equal(g.wall.length, 0);
  assert.equal(g.deadWall.allPhysical().length, 14);
  g.discard(0, g.drawn); passAll(g);
  assert.equal(g.result && g.result.type, 'draw', '補充で山が尽き、次のツモはない');
  // 山が0枚なら暗カンできない
  const h = newGame('math1', 41);
  setHand(h, 0, ['cos', '0', '=1', 'tan', '45', 'sin', 'sin', 'sin', 'sin']);
  while (h.wall.length) h.rivers[2].push({ id: h.wall.shift(), tsumogiri: true });
  assert.deepEqual(h.ankanOptions(0), []);
});

// ======================= ④ AI：合法手・公開情報・対局完走 =======================
const ALL_IDS12 = Object.values(CHARACTER_ROSTER).flat().map((c) => c.id);
test('④ AI の暗カンの基準戦略：乱数を使わず、ツモ和了を優先、遊んでいる4枚目はカン、待ちを減らすカンはしない', () => {
  const g = newGame('math1', 51);
  setHand(g, 0, ['cos', '0', '=1', 'tan', '45', 'sin', 'sin', 'sin', 'sin']);
  // 聴牌（sin を1枚捨てて tan45=1 待ち）：カン後も =1 待ちのまま → カンする
  assert.deepEqual(ankanDecision(g, 0), { type: 'ankan', tileType: typeIdx(g.rules, 'sin') });
  const h = newGame('math1', 51);
  // sin の4枚目が sin30=1/2 の部分（30・=1/2）と組める：聴牌でない手ではカンしない
  setHand(h, 0, ['30', '=1/2', 'cos', 'tan', '90', 'sin', 'sin', 'sin', 'sin']);
  assert.equal(ankanDecision(h, 0), null);
  const rng = createRng(5), before = rng.next();
  const rng2 = createRng(5);
  for (const id of ALL_IDS12) {
    const x = newGame('math1', 51);
    setHand(x, 0, ['cos', '0', '=1', 'tan', '45', 'sin', 'sin', 'sin', 'sin']);
    const a = decideCharacter(x, 0, id, rng2, { scores: [100, 100, 100, 100], hand: 0, length: 4, dealer: 0, renchan: 0, publicHistory: newPublicHistory() }, ['a', 'b', 'c']);
    assert.deepEqual(a, { type: 'ankan', tileType: typeIdx(x.rules, 'sin') }, id);
  }
  assert.equal(rng2.next(), before, '暗カンの判断で乱数を消費しない');
});

test('④ AI は王牌の非公開の牌・他家の手牌・山順を使わない（入れ替えても12人＋3難易度の行動は同じ）', () => {
  for (const mode of ['math1', 'math2']) {
    const base = () => {
      const g = newGame(mode, 61);
      setHand(g, 0, ['cos', '0', '=1', 'tan', '45', 'sin', 'sin', 'sin', 'sin']);
      g.ankan(0, typeIdx(g.rules, 'sin'));
      return g;
    };
    const a = base(), b = base();
    // b：まだ公開されていない王牌の牌（嶺上牌・表示候補・補充牌）と通常の山・他家の手牌を入れ替える
    const hidden = [...b.deadWall.rinshan, ...b.deadWall.pairs.flat(), ...b.deadWall.replenished].filter((id) => !revealedIds(b).has(id));
    hidden.forEach((id, i) => swap(b, id, b.wall[(i * 7) % b.wall.length]));
    swap(b, b.hands[1][0], b.hands[2][1]);
    b.wall.reverse();
    conserved(b);
    assert.deepEqual(a.viewFor(0), b.viewFor(0), '自分の公開ビューは同じ');
    const info = { scores: [100, 100, 100, 100], hand: 0, length: 4, dealer: 0, renchan: 0, publicHistory: newPublicHistory() };
    for (const id of ALL_IDS12) assert.deepEqual(decideCharacter(a, 0, id, createRng(3), info, ['x', 'y', 'z']), decideCharacter(b, 0, id, createRng(3), info, ['x', 'y', 'z']), `${mode} ${id}`);
    for (const level of ['beginner', 'intermediate', 'advanced']) assert.deepEqual(decide(a, 0, 'speed', createRng(3), level, info), decide(b, 0, 'speed', createRng(3), level, info), `${mode} ${level}`);
  }
});

// 12人を混ぜた試合（4局・8局）を新ルールで完走。各行動の後に保存則、精算後に合計400点、同じ seed で同じ結果
function playNewRulesMatch(mode, length, seats, seedBase) {
  const rules = R[mode];
  let m = createMatch({ length });
  let history = newPublicHistory();
  const stats = { ankan: 0, rinshanWin: 0, doraWins: 0, doraPoints: 0, cap: 0, wins: 0, draws: 0, maxRiver: 0, rounds: 0 };
  for (let round = 1; !m.over; round++) {
    assert.ok(round < 120);
    const seed = (seedBase + round * 7919) >>> 0;
    const g = new Game({ rules, seed, dealer: dealerOf(m), players: seats.map((id) => ({ name: id, kind: 'ai', personality: 'speed' })), newRules: true });
    const rng = createRng((seed ^ 0x5bd1e995) >>> 0);
    const info = { scores: m.scores.slice(), hand: m.hand, length: m.length, dealer: dealerOf(m), renchan: m.renchan, publicHistory: history };
    let steps = 0;
    while (g.pending()) {
      const p = g.pending();
      const a = decideCharacter(g, p.seat, seats[p.seat], rng, info, seats);
      if (a.type === 'ankan') { assert.ok(p.ankan.some((o) => o.type === a.tileType), '合法な暗カンだけ'); stats.ankan++; }
      applyAction(g, p.seat, a);
      assert.equal(g.checkInvariants(), true);
      assert.equal(g.deadWall.allPhysical().length, 14);
      assert.ok(++steps < 5000);
    }
    const r = g.result;
    if (r.type === 'win') {
      stats.wins++;
      const last = g.events.filter((e) => e.type !== 'win').at(-1);
      if (r.how === 'tsumo' && last.type === 'dora') stats.rinshanWin++;
      if (r.analysis.doraBonus) { stats.doraWins++; stats.doraPoints += r.analysis.doraBonus; }
      if (!r.analysis.yakuman) {
        const tiles = [...g.hands[r.winner], ...g.melds[r.winner].flatMap((x) => x.tiles)];
        const want = g.doraIndicators.reduce((n, d) => n + tiles.filter((id) => g.typeOf(id) === d.type).length, 0);
        assert.equal(r.analysis.doraBonus, want, 'ドラの数');
      } else assert.equal(r.analysis.doraBonus, undefined);
    } else {
      stats.draws++;
      if (g.wall.length > 0) { stats.cap++; assert.equal(mode, 'math2', '24回の流局は数学Ⅱだけ'); }
    }
    stats.maxRiver = Math.max(stats.maxRiver, ...g.rivers.map((x) => x.length));
    assert.ok(g.normalDraws.every((n) => mode === 'math1' || n <= 24));
    history = recordPublicRound(history, g.events, g.riichi);
    m = applyRoundResult(m, r);
    assert.equal(m.scores.reduce((a, b) => a + b, 0), 400, '合計400点');
    stats.rounds++;
  }
  return { scores: m.scores, played: m.played, stats };
}

test('④ 新ルールで12人の試合を完走：数学Ⅰ・Ⅱ×4局・8局、合法手だけ、保存則、合計400点、決定論', () => {
  const sum = { math1: null, math2: null };
  for (const mode of ['math1', 'math2']) {
    const agg = { ankan: 0, rinshanWin: 0, doraWins: 0, doraPoints: 0, cap: 0, wins: 0, draws: 0, maxRiver: 0, rounds: 0 };
    for (let i = 0; i < 6; i++) {
      const seats = [10, 0, 3, 7].map((d) => ALL_IDS12[(i * 5 + d) % 12]);
      const length = i % 2 ? 8 : 4;
      const a = playNewRulesMatch(mode, length, seats, 900000 + i * 101);
      if (i < 2) assert.deepEqual(playNewRulesMatch(mode, length, seats, 900000 + i * 101), a, '同じ seed で同じ試合');
      for (const key of Object.keys(agg)) agg[key] = key === 'maxRiver' ? Math.max(agg[key], a.stats[key]) : agg[key] + a.stats[key];
    }
    sum[mode] = agg;
  }
  console.log('# 新ルール12人の試合の集計 ' + JSON.stringify(sum));
  // 完走・和了・暗カン（AIの基準戦略）が実際に起きたこと。24回の流局は ② の検査で確認する（AIの試合では和了が多い）
  for (const mode of ['math1', 'math2']) assert.ok(sum[mode].wins > 0 && sum[mode].doraWins > 0, mode);
  assert.ok(sum.math1.ankan + sum.math2.ankan > 0, 'AIが暗カンを選ぶ局面がある');
});
