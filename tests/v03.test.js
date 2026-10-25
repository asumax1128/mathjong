// Ver.0.3-A：9枚制・数学Ⅰ／Ⅱモード・刻子・ポン・新役（src/engine/*）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRules } from '../src/engine/rules.js';
import { makeConfig, modeConfig, DEFAULT_CONFIG, DEFAULT_MODE } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction, chooseCall, PERSONALITIES } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { rulesFor, makeGame, findTile, k } from './helpers.js';

const M1 = rulesFor('math1');
const M2 = rulesFor('math2');
const ids = (r, list) => list.map((s) => r.typeByKey.get(k(s)).idx);
const cnt = (r, list) => r.countsOf(ids(r, list));
const yakuIds = (a) => (a ? a.yaku.map((y) => y.id).sort() : null);
const koutsu = (r, s) => r.koutsuOf(r.typeByKey.get(k(s)).idx);
const formula = (r, key) => r.melds.find((m) => m.key === key);

// ---------------- モード・牌構成 ----------------

test('数学Ⅰ：度数法・0°〜180°の9角度・関数各12枚・計124枚・数式面子26・刻子25', () => {
  assert.equal(M1.config.mode, 'math1');
  assert.equal(M1.config.angleUnit, 'deg');
  assert.equal(M1.deckSize, 124);
  const by = (kind) => M1.types.filter((t) => t.kind === kind);
  assert.deepEqual(by('func').map((t) => t.copies), [12, 12, 12]);
  assert.deepEqual(by('angle').map((t) => t.deg), [0, 30, 45, 60, 90, 120, 135, 150, 180]);
  assert.ok(by('angle').every((t) => t.copies === 4));
  assert.equal(by('value').length, 13);
  assert.ok(by('value').every((t) => t.copies === 4));
  assert.equal(M1.melds.filter((m) => m.kind === 'formula').length, 26);
  assert.equal(M1.melds.filter((m) => m.kind === 'koutsu').length, 25);
  assert.equal(M1.formulaCount, 26);
  assert.ok(!M1.melds.some((m) => m.kind === 'formula' && m.fn === 'tan' && m.deg === 90), 'tan90° は定義されない');
  assert.ok(!M1.types.some((t) => t.kind === 'angle' && t.deg > 180), '180°を超える角度牌はない');
  // 13種類の結果牌はすべて数学Ⅰの面子で使われる
  const used = new Set(M1.melds.filter((m) => m.kind === 'formula').map((m) => m.value));
  assert.equal(used.size, 13);
});

test('数学Ⅱ：弧度法・0〜2πの17角度・関数各16枚・計168枚・数式面子49（従来と同じ）・刻子33', () => {
  assert.equal(DEFAULT_MODE, 'math2', '既定は数学Ⅱ（暫定）');
  assert.equal(DEFAULT_CONFIG.mode, 'math2');
  assert.equal(M2.config.angleUnit, 'rad');
  assert.equal(M2.deckSize, 168);
  assert.equal(M2.types.filter((t) => t.kind === 'angle').length, 17);
  assert.equal(M2.melds.filter((m) => m.kind === 'formula').length, 49);
  assert.equal(M2.melds.filter((m) => m.kind === 'koutsu').length, 33);
  assert.ok(!M2.melds.some((m) => m.kind === 'formula' && m.fn === 'tan' && (m.deg === 90 || m.deg === 270)));
  // 0 と 2π は値が等しくても別種類の牌
  const a0 = M2.typeByKey.get('a:0');
  const a360 = M2.typeByKey.get('a:360');
  assert.ok(a0 && a360 && a0.idx !== a360.idx);
  // 数式面子の index・内容は旧規則と同じ（刻子は後ろに追加）
  const legacy = createRules(makeConfig({ legacy: true }));
  assert.deepEqual(M2.melds.slice(0, 49).map((m) => m.key), legacy.melds.map((m) => m.key));
  assert.ok(legacy.melds.every((m) => m.kind === 'formula'), '旧規則には刻子がない');
  assert.equal(legacy.config.rules.pon, undefined);
});

test('数学Ⅰ：第3・第4象限を使う役は全組合せで成立しないため無効（ガイド・ヒントに出ない）', () => {
  const cfg = modeConfig('math1');
  const off = cfg.yaku.filter((y) => !y.enabled).map((y) => y.id).sort();
  assert.deepEqual(off, ['sanshougen', 'shougen3', 'shougen4']);
  // 無効化を外した設定で全組合せ（重複あり）を評価して、本当に成立しないことを確認
  for (const y of cfg.yaku) y.enabled = true;
  const r = createRules(cfg);
  const F = r.melds.filter((m) => m.kind === 'formula').map((m) => m.idx);
  const seen = new Set();
  for (let a = 0; a < F.length; a++) for (let b = a; b < F.length; b++) for (let c = b; c < F.length; c++) {
    for (const y of r.evaluateMelds([F[a], F[b], F[c]], true).yaku) seen.add(y.id);
  }
  for (const id of off) assert.ok(!seen.has(id), `${id} は数学Ⅰで成立しない`);
  assert.ok(seen.has('shougen1') && seen.has('shougen2') && seen.has('doukaku'));
});

// ---------------- 9枚の和了形 ----------------

test('和了形：数式3組・刻子3組・数式2＋刻子1・数式1＋刻子2（両モード）', () => {
  for (const r of [M1, M2]) {
    const f3 = r.analyzeWin(cnt(r, ['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45', '=1']));
    assert.ok(f3 && f3.melds.every((mi) => r.melds[mi].kind === 'formula'));
    assert.ok(yakuIds(f3).includes('sankan'));
    const k3 = r.analyzeWin(cnt(r, ['30', '30', '30', '=1/2', '=1/2', '=1/2', 'cos', 'cos', 'cos']));
    assert.ok(k3 && k3.melds.every((mi) => r.melds[mi].kind === 'koutsu'));
    const f2k1 = r.analyzeWin(cnt(r, ['sin', '30', '=1/2', 'cos', '180', '=-1', '45', '45', '45']));
    assert.ok(f2k1);
    assert.deepEqual(f2k1.melds.map((mi) => r.melds[mi].kind).sort(), ['formula', 'formula', 'koutsu']);
    const f1k2 = r.analyzeWin(cnt(r, ['sin', '30', '=1/2', '45', '45', '45', '=0', '=0', '=0']));
    assert.ok(f1k2);
    assert.deepEqual(f1k2.melds.map((mi) => r.melds[mi].kind).sort(), ['formula', 'koutsu', 'koutsu']);
  }
});

test('門前の混合形は役なしでも和了（通常和了1点）。数式系の役は混合形に付かない', () => {
  const r = M2;
  // sin30=1/2 ×2 に 30°刻子を混ぜても、同関一色・三重同式などの数式系の役は付かない
  const a = r.analyzeWin(cnt(r, ['sin', '30', '=1/2', 'sin', '120', '=√3/2', '135', '135', '135']));
  assert.ok(a);
  assert.deepEqual(a.yaku, []);
  assert.equal(a.points, 1);
  // 数式3組なら同関一色が付く（比較）
  const b = r.analyzeWin(cnt(r, ['sin', '30', '=1/2', 'sin', '120', '=√3/2', 'sin', '90', '=1']));
  assert.ok(yakuIds(b).includes('doukan'));
});

test('鳴いた手：役がなければ和了不可（ポン＋数式2組、チー＋刻子の混合）', () => {
  const r = M2;
  const ponK = koutsu(r, '=0').idx;
  // ポン（0の刻子）＋ 手の内で数式2組 → 混合形・役なし → 和了不可
  assert.equal(r.analyzeWin(cnt(r, ['sin', '30', '=1/2', 'cos', '180', '=-1']), [ponK]), null);
  // チー（数式）＋ 手の内で刻子2組 → 役なし → 和了不可
  const chi = formula(r, 'sin30=1/2').idx;
  assert.equal(r.analyzeWin(cnt(r, ['45', '45', '45', '=0', '=0', '=0']), [chi]), null);
  // ポン＋刻子2組 → 対々和で和了可（3点＋通常1点＝4点）
  const t = r.analyzeWin(cnt(r, ['45', '45', '45', 'cos', 'cos', 'cos']), [ponK]);
  assert.deepEqual(yakuIds(t), ['toitoi']);
  assert.equal(t.points, 4);
  // 門前の刻子3組：対々和＋三暗刻（1+3+5=9点）
  const c = r.analyzeWin(cnt(r, ['=0', '=0', '=0', '45', '45', '45', 'cos', 'cos', 'cos']));
  assert.deepEqual(yakuIds(c), ['sanankou', 'toitoi']);
  assert.equal(c.points, 9);
});

test('三暗刻：ポン・チー後は不成立。ロンで最後の刻子を完成させても成立（暫定・設定で変更可）', () => {
  const r = M1;
  const hand = ['=0', '=0', '=0', '45', '45', '45', 'cos', 'cos', 'cos'];
  assert.ok(yakuIds(r.analyzeWin(cnt(r, hand), [], { ron: true })).includes('sanankou'), 'ロン完成も成立（暫定）');
  const strict = createRules(makeConfig({ mode: 'math1', rules: { sanankouRonCounts: false } }));
  assert.deepEqual(yakuIds(strict.analyzeWin(cnt(strict, hand), [], { ron: true })), ['toitoi'], '設定でロン完成を除外できる');
  assert.ok(yakuIds(strict.analyzeWin(cnt(strict, hand))).includes('sanankou'), 'ツモでは成立');
  const pon = koutsu(r, '=0').idx;
  assert.deepEqual(yakuIds(r.analyzeWin(cnt(r, ['45', '45', '45', 'cos', 'cos', 'cos']), [pon])), ['toitoi'], 'ポン後は三暗刻なし');
});

test('正弦・余弦・正接一色：9枚すべて同じ関数牌で役満16点（対々和などは加算しない）。ポン後も成立', () => {
  for (const r of [M1, M2]) {
    for (const [fn, id] of [['sin', 'sinIsshoku'], ['cos', 'cosIsshoku'], ['tan', 'tanIsshoku']]) {
      const a = r.analyzeWin(cnt(r, Array(9).fill(fn)));
      assert.deepEqual(yakuIds(a), [id]);
      assert.equal(a.points, 16);
      assert.equal(a.yakuman, true);
      const p = r.analyzeWin(cnt(r, Array(6).fill(fn)), [koutsu(r, fn).idx]);
      assert.deepEqual(yakuIds(p), [id], 'ポン後も成立');
      assert.equal(p.points, 16);
    }
    // 8枚 sin ＋ 他1枚は一色ではない（和了形でもない）
    assert.equal(r.analyzeWin(cnt(r, [...Array(8).fill('sin'), 'cos'])), null);
  }
});

test('九角無双：両モードで従来の9枚形（門前限定）', () => {
  for (const r of [M1, M2]) {
    const a = r.analyzeWin(cnt(r, ['0', '30', '45', '60', '90', '120', '135', '150', '180']));
    assert.equal(a.kind, 'special');
    assert.equal(a.yaku[0].id, 'kyukaku');
    assert.equal(a.points, 16);
  }
});

test('牌の枚数制限：刻子は同じ牌3枚、角度・結果牌（各4枚）は2組作れない', () => {
  const r = M1;
  // 30°×6 は牌が足りない（4枚）ので配れないが、counts だけで与えても刻子2組には分解しない枚数でのみ判定
  const c = r.countsOf(ids(r, ['30', '30', '30', '30', '30', '30', 'sin', 'sin', 'sin']));
  // 判定関数自体は counts を信じるが、ゲームでは配牌で枚数を超えない（Game の不変条件で確認）
  assert.ok(r.analyzeWin(c));
  const g = new Game({ rules: r, seed: 3, players: [0, 1, 2, 3].map(() => ({ kind: 'ai', personality: 'speed' })) });
  const per = new Map();
  for (const t of g.tileType) per.set(t, (per.get(t) || 0) + 1);
  for (const [t, n] of per) assert.equal(n, r.types[t].copies);
  assert.equal(g.tileType.length, 124);
});

// ---------------- ポンと宣言の優先順位 ----------------

// 自分（親・seat0）が 1/2 を捨てる局面。下家=チー可能、対面=1/2 の対子（ポン可能）、上家=1/2 でロン可能。
const PAIR_RON = {
  hands: [
    ['=1/2', '0', '0', '270', '270', '=-√3', 'tan', '360'],
    ['sin', '30', 'cos', 'tan', '225', '315', '=√3', '=-1/√3'],
    ['=1/2', '=1/2', '90', '90', '=-√3/2', '=-1/√2', 'tan', '210'],
    ['cos', '180', '=-1', 'tan', '45', '=1', 'sin', '150'],
  ],
  draws: ['=-√3/2'],
};
function priorityGame() {
  const g = makeGame({ ...PAIR_RON, r: M2 });
  g.discard(0, findTile(g, 0, '=1/2'));
  return g;
}

test('ロン＞ポン＞チー：チー・ポンを選んでも、後続のロン判断が終わるまで確定しない（ロンが優先）', () => {
  const g = priorityGame();
  let p = g.pending();
  assert.deepEqual([p.seat, p.ron, p.chi.length, !!p.pon], [1, false, 1, false], '下家：チーのみ');
  g.respond(1, { type: 'chi', option: 0 });
  assert.equal(g.melds[1].length, 0, 'チーはまだ確定しない');
  p = g.pending();
  assert.deepEqual([p.seat, p.ron, p.chi.length, !!p.pon], [2, false, 0, true], '対面：ポン');
  g.respond(2, { type: 'pon' });
  assert.equal(g.melds[2].length, 0, 'ポンもまだ確定しない');
  p = g.pending();
  assert.deepEqual([p.seat, p.ron, p.chi.length, p.pon], [3, true, 0, null], '上家：ロンだけ（ポン・チーは出ない）');
  g.respond(3, { type: 'ron' });
  assert.equal(g.result.winner, 3);
  assert.equal(g.result.how, 'ron');
  assert.equal(g.melds[1].length + g.melds[2].length, 0, 'ポン・チーは取り消し');
  assert.equal(g.hands[2].length, 8, 'ポンを選んだ人の手牌は変わらない');
  g.checkInvariants();
});

test('ロンを見送ればポンが確定（チーより優先）。ポンした人の打牌番、間の席は飛ばす', () => {
  const g = priorityGame();
  g.respond(1, { type: 'chi', option: 0 });
  g.respond(2, { type: 'pon' });
  g.respond(3, { type: 'pass' });
  assert.equal(g.melds[1].length, 0, 'チーは成立しない');
  assert.equal(g.melds[2].length, 1);
  const m = g.melds[2][0];
  assert.equal(m.kind, 'koutsu');
  assert.equal(m.call, 'pon');
  assert.equal(m.from, 0);
  assert.equal(M2.melds[m.meld].kind, 'koutsu');
  assert.ok(m.tiles.every((id) => g.typeOf(id) === g.typeOf(m.claimed)));
  assert.equal(g.rivers[0].length, 0, '鳴かれた牌は河から公開面子へ');
  assert.equal(g.hands[2].length, 6);
  const p = g.pending();
  assert.deepEqual([p.seat, p.type, p.canTsumo], [2, 'turn', false], 'ポン直後は打牌のみ');
  const wall = g.wall.length;
  g.discard(2, g.hands[2][0]);
  while (g.pending() && g.pending().type === 'claim') g.respond(g.pending().seat, { type: 'pass' });
  assert.equal(g.pending().seat, 3, 'ポンした人の次（上家）の手番');
  assert.equal(g.wall.length, wall - 1, 'ポンした人はツモしない。次の人がツモ');
  assert.equal(g.events.filter((e) => e.type === 'pon').length, 1);
  g.checkInvariants();
});

test('ポン・ロンを見送ればチーが確定', () => {
  const g = priorityGame();
  g.respond(1, { type: 'chi', option: 0 });
  g.respond(2, { type: 'pass' });
  g.respond(3, { type: 'pass' });
  assert.equal(g.melds[1].length, 1);
  assert.equal(g.melds[1][0].call, 'chi');
  assert.equal(g.melds[1][0].kind, 'formula');
  assert.equal(g.pending().seat, 1);
  g.checkInvariants();
});

// 複数ポン：sin（数学Ⅱは16枚）を下家と対面が2枚ずつ持つ
function multiPonGame() {
  const g = makeGame({
    r: M2,
    hands: [
      ['sin', '0', '0', '270', '270', '=-√3', 'tan', '360'],
      ['sin', 'sin', '90', '90', '=-√3', '=-1/√3', 'tan', 'tan'],
      ['sin', 'sin', '180', '180', '=√3', '=-1/√2', 'cos', 'cos'],
      ['tan', '360', '=-1/√2', '=1/√3', 'cos', '210', '225', '315'],
    ],
    draws: ['=-√3/2'],
  });
  g.discard(0, findTile(g, 0, 'sin'));
  return g;
}

test('複数ポン：打牌者から手番順に近い席が優先。近い席がポンすれば遠い席には聞かない', () => {
  const g = multiPonGame();
  let p = g.pending();
  assert.deepEqual([p.seat, !!p.pon, p.chi.length], [1, true, 0]);
  g.respond(1, { type: 'pon' });
  p = g.pending();
  assert.deepEqual([p.seat, p.type], [1, 'turn'], '対面には聞かず、下家のポンが確定');
  assert.equal(g.melds[1][0].call, 'pon');
  assert.equal(g.melds[2].length, 0);
  g.checkInvariants();
});

test('複数ポン：近い席が見送れば、次の席がポンできる', () => {
  const g = multiPonGame();
  g.respond(1, { type: 'pass' });
  const p = g.pending();
  assert.deepEqual([p.seat, !!p.pon], [2, true]);
  g.respond(2, { type: 'pon' });
  assert.equal(g.melds[2][0].call, 'pon');
  assert.equal(g.pending().seat, 2);
  g.discard(2, g.hands[2].find((id) => g.typeOf(id) !== M2.typeByKey.get('f:sin').idx));
  while (g.pending() && g.pending().type === 'claim') g.respond(g.pending().seat, { type: 'pass' });
  assert.equal(g.pending().seat, 3);
  g.checkInvariants();
});

test('不正な宣言は拒否（ポンできない席のポン、ポン確定後のポン）。鳴きは合計2回まで', () => {
  const g = priorityGame();
  assert.throws(() => g.respond(1, { type: 'pon' }), /pon not possible/);
  const h = multiPonGame();
  // 2回鳴いた手はポン・チーの選択肢が出ない
  h.melds[2].push({}, {});
  assert.equal(h.ponOption(2, h.claim.tile), null);
  assert.deepEqual(h.chiOptions(2, h.claim.tile), []);
  h.melds[2].length = 0;
  // 旧規則（ポンなし）では ponOption は常に null
  const legacy = createRules(makeConfig({ legacy: true }));
  const lg = makeGame({ ...PAIR_RON, r: legacy });
  lg.discard(0, findTile(lg, 0, '=1/2'));
  assert.equal(lg.ponOption(2, lg.claim.tile), null);
  assert.equal(lg.pending().pon, null);
});

test('同じ打牌の二重取得なし：ポン後に同じ牌を誰も取れず、全牌がちょうど1か所にある', () => {
  const g = priorityGame();
  const tile = g.claim.tile;
  g.respond(1, { type: 'pass' });
  g.respond(2, { type: 'pon' });
  g.respond(3, { type: 'pass' });
  const where = [];
  g.hands.forEach((h, s) => { if (h.includes(tile)) where.push(`hand${s}`); });
  g.rivers.forEach((r, s) => { if (r.some((x) => x.id === tile)) where.push(`river${s}`); });
  g.melds.forEach((ms, s) => ms.forEach((m) => { if (m.tiles.includes(tile)) where.push(`meld${s}`); }));
  assert.deepEqual(where, ['meld2']);
  assert.throws(() => g.respond(3, { type: 'ron' }));
  g.checkInvariants();
});

// ---------------- AI ----------------

test('AI のポン：対々和の見込み（他に対子2組）ならポン、見込みがなければ見送る。門前重視型は鳴かない', () => {
  const r = M1;
  const mk = (hand) => {
    const g = makeGame({
      r,
      hands: [
        ['=0', '120', '120', '135', '=-1', '=-1/√2', 'cos', '150'],
        hand,
        ['tan', 'tan', '60', '90', '=√3', '=-√3', 'sin', '=1/√2'],
        ['cos', '0', '=√3/2', '=-1/2', '30', '45', 'tan', '=1/√3'],
      ],
      draws: ['=-√3/2'],
    });
    g.discard(0, findTile(g, 0, '=0'));
    return g;
  };
  // 下家：0 の対子＋対子2組（45°・1）、数式面子の見込みなし → ポンすれば対々和まであと2枚
  const ready = mk(['=0', '=0', '45', '45', '=1', '=1', '120', '150']);
  assert.ok(ready.pending().pon);
  assert.equal(decide(ready, 1, 'speed', createRng(1)).type, 'pon');
  assert.equal(decide(ready, 1, 'value', createRng(1)).type, 'pon');
  // 同じ対子でも、数式面子の見込み（sin 180° = 0 など）が大きい手はポンせず数式を狙う
  const formulaHand = mk(['=0', '=0', '45', '45', 'sin', 'sin', '=1', '180']);
  assert.equal(decide(formulaHand, 1, 'speed', createRng(1)).type, 'pass');
  assert.equal(decide(ready, 1, 'closed', createRng(1)).type, 'pass', '門前重視型は鳴かない');
  // 下家：0 の対子だけ（他に対子なし）→ ポンしない
  const lone = mk(['=0', '=0', '45', '60', 'sin', 'cos', '=1', '180']);
  assert.ok(lone.pending().pon);
  assert.equal(decide(lone, 1, 'speed', createRng(1)).type, 'pass');
  assert.equal(decide(lone, 1, 'value', createRng(1)).type, 'pass');
});

test('AI のポン：対々和に必要な牌がすべて見えていて取得不可能ならポンしない（公開情報だけで判断）', () => {
  const r = M1;
  const t = (s) => r.typeByKey.get(k(s)).idx;
  const hand = ['=0', '=0', '45', '45', '=1', '=1', '120', '150'].map((s, i) => ({ id: i, type: t(s) }));
  const view = (rivers) => ({ seat: 1, hand, melds: [[], [], [], []], rivers: rivers.map((rv) => rv.map(t)) });
  const ponOpt = { meld: r.koutsuOf(t('=0')).idx, use: [0, 1] };
  // 45°・1 の残りが見えていない → 対々和まであと2枚 → ポン
  const open = view([['=0'], [], [], []]);
  assert.deepEqual(chooseCall(r, open, t('=0'), [], ponOpt, 'speed'), { type: 'pon' });
  assert.deepEqual(chooseCall(r, open, t('=0'), [], ponOpt, 'value'), { type: 'pon' });
  // 45°・1 の残り2枚ずつが河に見えている（その刻子は取得不可能）→ 役重視型はポンしない
  const dead = view([['=0', '45', '=1'], ['45'], ['=1'], []]);
  assert.equal(chooseCall(r, dead, t('=0'), [], ponOpt, 'value'), null);
  // ポン後に成立し得る役がまったくない設定（対々和・一色を無効）では、対子がそろっていても決してポンしない
  const cfg = makeConfig({ mode: 'math1' });
  for (const y of cfg.yaku) if (['toitoi', 'sinIsshoku', 'cosIsshoku', 'tanIsshoku'].includes(y.id)) y.enabled = false;
  const noYaku = createRules(cfg);
  const opt2 = { meld: noYaku.koutsuOf(t('=0')).idx, use: [0, 1] };
  for (const pers of ['speed', 'value']) assert.equal(chooseCall(noYaku, open, t('=0'), [], opt2, pers), null, pers);
});

test('AI：性格ごとの鳴き設定（門前重視型はチー・ポンなし）と一色の扱い（対々和と同じ重み）', () => {
  assert.equal(PERSONALITIES.closed.pon, false);
  assert.equal(PERSONALITIES.closed.chi, false);
  assert.ok(PERSONALITIES.speed.pon && PERSONALITIES.value.pon);
  for (const p of Object.values(PERSONALITIES)) assert.ok(p.koutsuBias > 0 && p.koutsuBias < 1);
});

function runAIGame(r, seed, lineup) {
  const players = lineup.map((p) => ({ kind: 'ai', personality: p }));
  const g = new Game({ rules: r, seed, dealer: seed % 4, players });
  const rng = createRng(seed * 7 + 3);
  let steps = 0;
  while (g.pending()) {
    const p = g.pending();
    applyAction(g, p.seat, decide(g, p.seat, lineup[p.seat], rng));
    g.checkInvariants();
    if (++steps > 3000) throw new Error('no progress');
  }
  return g;
}

test('AI 4人の自動対局（数学Ⅰ・Ⅱ 各12局）：毎手の不変条件を満たして終局。鳴いた和了者は役あり', () => {
  const lineups = [['speed', 'value', 'closed', 'speed'], ['value', 'speed', 'value', 'closed']];
  for (const r of [M1, M2]) {
    let wins = 0;
    for (let i = 0; i < 12; i++) {
      const g = runAIGame(r, 300 + i, lineups[i % 2]);
      if (g.result.type !== 'win') continue;
      wins++;
      const w = g.result.winner;
      const a = g.result.analysis;
      if (g.melds[w].length) assert.ok(a.hasYaku, '鳴いた和了者は役あり');
      const re = r.analyzeWin(g.countsOf(g.hands[w]), g.exposedMelds(w), { ron: g.result.how === 'ron' });
      assert.equal(re.points, a.points);
      // 数学Ⅰでは 180° を超える角度の牌は存在しない
      if (r === M1) assert.ok(g.tileType.every((t) => r.types[t].kind !== 'angle' || r.types[t].deg <= 180));
    }
    assert.ok(wins > 0);
  }
});

// ---------------- 監査 P2-1：不足枚数の減衰は f の miss 乗（4〜9枚も） ----------------
import { handValue, missFactor, unseenCounts, AI_TUNING, chooseDiscard } from '../src/engine/ai.js';

test('P2-1：missFactor は f^miss（1〜3枚は従来と同じ式、4・6・9枚も正しい累乗）', () => {
  const f = 0.137;
  assert.equal(missFactor(f, 1), f);
  assert.equal(missFactor(f, 2), f * f);
  assert.equal(missFactor(f, 3), f * f * f, '3枚は従来の式（演算順序も同じ）');
  for (const m of [4, 5, 6, 7, 8, 9]) {
    assert.ok(Math.abs(missFactor(f, m) / Math.pow(f, m) - 1) < 1e-12, `${m}枚`);
    assert.ok(missFactor(f, m) < missFactor(f, m - 1), `${m}枚は${m - 1}枚より小さい`);
  }
});

// 別実装：全組合せ（重複あり）を総当たりし、f^miss（Math.pow）で減衰した重みの総和
function bruteHandValue(r, counts, exposed, unseen, pers) {
  const { missDecay, availabilitySoftness: s } = AI_TUNING;
  const closed = exposed.length === 0;
  const p = PERSONALITIES[pers];
  const k = 3 - exposed.length;
  const M = r.melds.length;
  let total = 0;
  const rec = (start, acc) => {
    if (acc.length === k) {
      const ev = r.evaluateMelds([...exposed, ...acc], closed);
      if (!closed && !ev.hasYaku) return;
      const isshoku = ev.yaku.some((y) => /Isshoku$/.test(y.id));
      let w = p.valueWeight(isshoku ? r.config.scoring.base + 3 : ev.points);
      if (closed) for (const mi of acc) if (r.melds[mi].kind === 'koutsu') w *= p.koutsuBias;
      const req = new Array(r.T).fill(0);
      for (const mi of acc) for (const t of r.melds[mi].tiles) req[t]++;
      for (let t = 0; t < r.T; t++) {
        const miss = req[t] - counts[t];
        if (miss <= 0) continue;
        if (unseen[t] < miss) return; // 取得不可能
        w *= Math.pow(missDecay * (unseen[t] / (unseen[t] + s)), miss);
      }
      total += w;
      return;
    }
    for (let m = start; m < M; m++) { acc.push(m); rec(m, acc); acc.pop(); }
  };
  rec(0, []);
  return total;
}

test('P2-1：handValue は総当たりの別実装（f^miss）と一致（門前・ポン後、数学Ⅰ・Ⅱ、不足4〜9枚の形を含む）', () => {
  for (const r of [M1, M2]) {
    const sin = r.typeByKey.get('f:sin').idx;
    const cases = [
      { hand: ['sin', 'cos', '30', '=1/2', '60', 'tan', '=0', '45'], exposed: [] },
      { hand: ['sin', 'sin', 'sin', 'cos', 'cos', 'tan', '=0', '45'], exposed: [] }, // sin 刻子2〜3組（不足3〜6枚）を含む
      { hand: ['cos', 'cos', '30', '=1/2', '=0', '45'], exposed: [koutsu(r, 'sin').idx] }, // ポン後（sin 刻子）
      { hand: ['tan', 'tan', 'tan', '0'], exposed: [koutsu(r, 'sin').idx, koutsu(r, '=0').idx] },
    ];
    for (const c of cases) {
      const view = { seat: 0, hand: ids(r, c.hand).map((t, i) => ({ id: i, type: t })), melds: [c.exposed.map((mi) => ({ meld: mi, tiles: r.melds[mi].tiles })), [], [], []], rivers: [[], [], [], []] };
      const counts = r.countsOf(view.hand.map((h) => h.type));
      const unseen = unseenCounts(r, view);
      for (const pers of ['speed', 'value']) {
        const a = handValue(r, counts, c.exposed, unseen, pers);
        const b = bruteHandValue(r, counts, c.exposed, unseen, pers);
        assert.ok(Math.abs(a - b) <= 1e-12 * Math.max(1, b), `${r.config.mode} ${c.hand.join(' ')} ${pers}: ${a} vs ${b}`);
      }
      // 見えていない sin を減らして取得不可能にすると、その形の価値は 0（総当たりと一致したまま値が下がる）
      const un2 = unseen.slice();
      un2[sin] = 0;
      const a2 = handValue(r, counts, c.exposed, un2, 'speed');
      assert.ok(Math.abs(a2 - bruteHandValue(r, counts, c.exposed, un2, 'speed')) <= 1e-12 * Math.max(1, a2));
      assert.ok(a2 <= handValue(r, counts, c.exposed, unseen, 'speed'));
    }
  }
});

test('P2-1：不足が4・6・9枚の完成形の重みが f^4・f^6・f^9（単独の形で確認）', () => {
  // 数学Ⅱ、sin の刻子3組だけが和了形になる設定：手の内 sin 0枚＋他の牌、見えていない sin を十分に
  const r = M2;
  const sin = r.typeByKey.get('f:sin').idx;
  const kSin = koutsu(r, 'sin').idx;
  const f = (u) => AI_TUNING.missDecay * (u / (u + AI_TUNING.availabilitySoftness));
  // ポン後（sin 刻子を公開済み）の手：sin 3枚 → 残り sin 刻子1組は不足0、手の内 sin 0枚なら不足3、
  // 2組公開済みで手の内 sin 0枚なら不足3。不足 n 枚の単一形の重みを、別の牌の影響がない counts で比べる。
  const unseen = r.types.map(() => 0);
  unseen[sin] = 9;
  for (const [exposed, missing] of [[[kSin, kSin], 3], [[kSin], 6], [[], 9]]) {
    const counts = new Array(r.T).fill(0);
    const v = handValue(r, counts, exposed, unseen, 'speed');
    const isshokuWeight = PERSONALITIES.speed.valueWeight(r.config.scoring.base + 3) * (exposed.length ? 1 : PERSONALITIES.speed.koutsuBias ** 3);
    const expect = isshokuWeight * Math.pow(f(9), missing);
    assert.ok(Math.abs(v / expect - 1) < 1e-12, `不足${missing}枚：${v} vs ${expect}`);
  }
  // 不足4枚：sin 刻子を1組公開、手の内 sin 2枚 → 残り2組に不足4枚
  const counts4 = new Array(r.T).fill(0);
  counts4[sin] = 2;
  const v4 = handValue(r, counts4, [kSin], unseen, 'speed');
  const e4 = PERSONALITIES.speed.valueWeight(r.config.scoring.base + 3) * Math.pow(f(9), 4);
  assert.ok(Math.abs(v4 / e4 - 1) < 1e-12, `不足4枚：${v4} vs ${e4}`);
  // 残り枚数が足りない（見えていない sin が不足より少ない）→ 0
  unseen[sin] = 5;
  assert.equal(handValue(r, new Array(r.T).fill(0), [kSin], unseen, 'speed'), 0, '不足6枚・残り5枚 → 0');
});

test('P2-1：監査の再現局面（数学Ⅱ・seed 1・親0・乱数51・23行動後の席3）は 60° を捨てる（修正前は cos）', () => {
  const r = M2;
  const pers = ['speed', 'value', 'closed', 'speed'];
  const g = new Game({ rules: r, seed: 1, dealer: 0, players: pers.map((p) => ({ kind: 'ai', personality: p })) });
  const rng = createRng(51);
  for (let i = 0; i < 23; i++) { const p = g.pending(); applyAction(g, p.seat, decide(g, p.seat, pers[p.seat], rng)); }
  const p = g.pending();
  assert.deepEqual([p.seat, p.type], [3, 'turn']);
  const view = g.viewFor(3);
  assert.deepEqual(view.hand.map((h) => r.types[h.type].key).sort(), ['a:225', 'a:360', 'a:60', 'f:cos', 'f:cos', 'f:sin', 'v:-1/√2', 'v:0', 'v:√3/2'].sort());
  assert.equal(r.types[g.typeOf(chooseDiscard(r, view, 'speed', null).id)].key, 'a:60');
});
