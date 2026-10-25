// Ver.0.3-A：役候補ヒント（刻子・ポン・新役）とチーのオートパス（ポン対応）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yakuCandidates, claimForSeat, unseenFromView } from '../src/engine/yakuhint.js';
import { shouldAutoPassChi, visibleClaimActions, claimPendingForHint } from '../src/ui/autopass.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { rulesFor, makeGame, findTile, k } from './helpers.js';

const M1 = rulesFor('math1');
const M2 = rulesFor('math2');
const t = (r, s) => r.typeByKey.get(k(s)).idx;
function view(r, hand, { exposed = [], rivers = [[], [], [], []] } = {}) {
  const melds = [exposed.map((mi) => ({ meld: mi, tiles: r.melds[mi].tiles.slice(), from: 3 })), [], [], []];
  return { seat: 0, hand: hand.map((s, i) => ({ id: i, type: t(r, s) })), melds, rivers: rivers.map((rv) => rv.map((s) => t(r, s))) };
}
const find = (cs, id) => cs.find((c) => c.id === id);

// ---------------- オートパス（ポン対応） ----------------
const CHI = [{ meld: 1, use: [1, 2] }];
const PON = { meld: 60, use: [3, 4] };
const claim = (o) => ({ seat: 0, type: 'claim', tile: 9, from: 3, ron: false, chi: [], pon: null, ...o });

test('オートパス：ポンが可能なら自動パスしない（チーのみのときだけ自動パス）', () => {
  assert.equal(shouldAutoPassChi(claim({ chi: CHI }), 0, true), true, 'チーのみ');
  assert.equal(shouldAutoPassChi(claim({ pon: PON }), 0, true), false, 'ポンのみ');
  assert.equal(shouldAutoPassChi(claim({ chi: CHI, pon: PON }), 0, true), false, 'ポン＋チー');
  assert.equal(shouldAutoPassChi(claim({ chi: CHI, pon: PON, ron: true }), 0, true), false, 'ロン＋ポン＋チー');
  assert.equal(shouldAutoPassChi(claim({ ron: true, pon: PON }), 0, true), false);
  assert.equal(shouldAutoPassChi(claim({ chi: CHI }), 0, false), false, 'OFF');
});

test('オートパスの表示：ON でポン＋チーはポンを残してチーを見送り対象、ロンは必ず残す。OFF は全部', () => {
  assert.deepEqual(visibleClaimActions(claim({ chi: CHI, pon: PON }), true),
    { ron: false, pon: { meld: 60 }, chi: [], passLabel: '見送る', passNote: 'チーも見送ります' });
  assert.deepEqual(visibleClaimActions(claim({ chi: CHI, pon: PON, ron: true }), true),
    { ron: true, pon: { meld: 60 }, chi: [], passLabel: 'ロンしない', passNote: 'チーも見送ります' });
  assert.deepEqual(visibleClaimActions(claim({ pon: PON }), true),
    { ron: false, pon: { meld: 60 }, chi: [], passLabel: '見送る', passNote: null });
  assert.deepEqual(visibleClaimActions(claim({ chi: CHI, pon: PON, ron: true }), false),
    { ron: true, pon: { meld: 60 }, chi: [{ index: 0, meld: 1 }], passLabel: 'ロンしない', passNote: null });
  // ヒントに渡す経路も表示と一致
  const typeOf = () => 5;
  for (const p of [claim({ chi: CHI, pon: PON }), claim({ chi: CHI, pon: PON, ron: true }), claim({ chi: CHI }), claim({ pon: PON })]) {
    for (const on of [false, true]) {
      const v = visibleClaimActions(p, on);
      const c = claimForSeat(claimPendingForHint(p, on), 0, typeOf);
      assert.deepEqual(c.chiMelds, v.chi.map((o) => o.meld));
      assert.equal(c.ponMeld, v.pon ? v.pon.meld : null);
      assert.equal(c.ron, v.ron);
    }
  }
});

// ---------------- 役候補ヒント ----------------

test('ヒント：刻子系の新役（対々和・三暗刻・一色）を「あと何枚」付きで出す', () => {
  const r = M1;
  const cs = yakuCandidates(r, view(r, ['=0', '=0', '=0', '45', '45', '45', 'cos', 'cos']), { limit: 99 });
  assert.equal(find(cs, 'toitoi').missing, 1);
  assert.equal(find(cs, 'sanankou').missing, 1);
  assert.equal(find(cs, 'toitoi').category, 'koutsu');
  const sin = yakuCandidates(r, view(r, ['sin', 'sin', 'sin', 'sin', 'sin', 'sin', 'sin', 'cos']), { limit: 99 });
  assert.equal(find(sin, 'sinIsshoku').missing, 2);
  assert.equal(find(sin, 'sinIsshoku').yakuman, true);
});

test('ヒント：同程度の近さなら数式系を優先、明らかに近い刻子系は隠さない、完成は最優先', () => {
  const r = M2;
  // 三関制覇 あと1枚（数式2組＋tan 45°）：数式系が最上位
  const v1 = view(r, ['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45']);
  const top = yakuCandidates(r, v1);
  assert.equal(top[0].category, 'formula');
  // 刻子2組＋対子：対々和・三暗刻 あと1枚、数式系はあと3枚以上 → 刻子系を上位に出す
  const v2 = view(r, ['=0', '=0', '=0', '45', '45', '45', 'cos', 'cos']);
  const c2 = yakuCandidates(r, v2);
  assert.ok(c2.slice(0, 2).every((c) => c.category === 'koutsu'), c2.map((c) => `${c.name}${c.missing}`).join());
  // 同じ「あと何枚」なら数式系が先
  const v3 = view(r, ['sin', '30', '=1/2', 'cos', '180', '=-1', '45', '45']);
  const c3 = yakuCandidates(r, v3, { limit: 99 });
  const ff = find(c3, 'doukaku');
  const kk = find(c3, 'toitoi');
  assert.equal(ff.missing, kk.missing, '同角三関・対々和ともにあと5枚');
  assert.ok(c3.indexOf(ff) < c3.indexOf(kk), '同じ枚数なら数式系が先');
  // 完成（あと0枚）は系統によらず最上位
  const v4 = view(r, ['=0', '=0', '=0', '45', '45', '45', 'cos', 'cos', 'cos']);
  assert.equal(yakuCandidates(r, v4)[0].missing, 0);
});

test('ヒント：数学Ⅰでは 180°を超える角度を使う役（第3・4象限・三象限巡り）を出さない', () => {
  const r = M1;
  for (let seed = 1; seed <= 15; seed++) {
    const g = new Game({ rules: r, seed, players: [0, 1, 2, 3].map(() => ({ kind: 'ai', personality: 'speed' })) });
    for (let s = 0; s < 4; s++) {
      const cs = yakuCandidates(r, g.viewFor(s), { limit: 99 });
      for (const c of cs) assert.ok(!['shougen3', 'shougen4', 'sanshougen'].includes(c.id), c.name);
      for (const c of cs) if (c.example) for (const mi of c.example) {
        const m = r.melds[mi];
        if (m.kind === 'formula') assert.ok(m.deg <= 180);
      }
    }
  }
});

// 総当たりの別実装：各役について、その役が付く和了形（全組合せ）の最小「あと何枚」
function bruteMissing(r, v) {
  const counts = r.countsOf(v.hand.map((h) => h.type));
  const exposed = v.melds[0].map((m) => m.meld);
  const closed = exposed.length === 0;
  const unseen = unseenFromView(r, v);
  const M = r.melds.length;
  const k = 3 - exposed.length;
  const best = new Map();
  const rec = (start, acc) => {
    if (acc.length === k) {
      const req = new Array(r.T).fill(0);
      for (const mi of acc) for (const tt of r.melds[mi].tiles) req[tt]++;
      let miss = 0;
      for (let tt = 0; tt < r.T; tt++) {
        const m = req[tt] - counts[tt];
        if (m <= 0) continue;
        if (unseen[tt] < m) return;
        miss += m;
      }
      for (const y of r.evaluateMelds([...exposed, ...acc], closed).yaku) {
        if (!best.has(y.id) || miss < best.get(y.id)) best.set(y.id, miss);
      }
      return;
    }
    for (let m = start; m < M; m++) { acc.push(m); rec(m, acc); acc.pop(); }
  };
  rec(0, []);
  return best;
}

test('ヒント：「あと何枚」は総当たりの別実装と一致（数学Ⅰ・刻子を含む全組合せ、門前・ポン後）', () => {
  const r = M1;
  const hands = [
    ['=0', '=0', '45', '45', 'sin', 'cos', '30', '=1/2'],
    ['sin', 'sin', 'sin', 'sin', 'sin', 'tan', '60', '=√3'],
    ['30', '60', '=1/2', '=√3/2', 'cos', 'sin', 'tan', '120'],
  ];
  for (const h of hands) {
    const v = view(r, h);
    const brute = bruteMissing(r, v);
    for (const c of yakuCandidates(r, v, { limit: 99 })) {
      if (c.special) continue;
      assert.equal(c.missing, brute.get(c.id), `${h.join(' ')}: ${c.name}`);
    }
  }
  // ポン後（=0 の刻子を公開）：門前限定（三暗刻）・数式系は出ない
  const pon = r.koutsuOf(t(r, '=0')).idx;
  const v = view(r, ['45', '45', 'cos', 'cos', 'sin', '30'], { exposed: [pon] });
  const cs = yakuCandidates(r, v, { limit: 99 });
  assert.ok(!cs.some((c) => c.closedOnly), '鳴いた手に門前限定役を出さない');
  assert.ok(cs.every((c) => c.category === 'koutsu'), cs.map((c) => c.name).join());
  const brute = bruteMissing(r, v);
  for (const c of cs) assert.equal(c.missing, brute.get(c.id));
});

test('ヒント：いまポンできる打牌は、ポンした後の局面（鳴いた手）として評価。宣言できなければ取得不能扱い', () => {
  const r = M1;
  const g = makeGame({
    r,
    hands: [
      ['=0', '120', '120', '135', '=-1', '=-1/√2', 'cos', '150'],
      ['=0', '=0', '45', '45', '=1', '=1', '120', '150'],
      ['tan', 'tan', '60', '90', '=√3', '=-√3', 'sin', '=1/√2'],
      ['cos', '0', '=√3/2', '=-1/2', '30', '45', 'tan', '=1/√3'],
    ],
    draws: ['=-√3/2'],
  });
  g.discard(0, findTile(g, 0, '=0'));
  const p = g.pending();
  assert.equal(p.seat, 1);
  assert.ok(p.pon);
  const c = claimForSeat(p, 1, (id) => g.typeOf(id));
  assert.equal(c.ponMeld, p.pon.meld);
  const cs = yakuCandidates(r, g.viewFor(1), { claim: c, limit: 99 });
  const toitoi = find(cs, 'toitoi');
  assert.equal(toitoi.missing, 2, '0 をポンすれば対々和まであと2枚');
  assert.equal(toitoi.via, 'pon');
  // 宣言しない場合の評価：河の 0 は取得不能（0 の刻子は残り1枚では作れない）
  const base = find(yakuCandidates(r, g.viewFor(1), { limit: 99 }), 'toitoi');
  assert.ok(!base || base.missing >= 2);
  // 他の席には宣言権がない
  assert.equal(claimForSeat(p, 2, (id) => g.typeOf(id)), null);
});

test('ヒントの計算時間：数学Ⅱ（刻子を含む95,284通り）でも1回あたり数百 ms 以内', () => {
  const r = M2;
  const g = new Game({ rules: r, seed: 11, players: [0, 1, 2, 3].map(() => ({ kind: 'ai', personality: 'speed' })) });
  const t0 = performance.now();
  for (let s = 0; s < 4; s++) yakuCandidates(r, g.viewFor(s));
  const ms = (performance.now() - t0) / 4;
  assert.ok(ms < 400, `${ms.toFixed(0)} ms`);
});

test('ヒント：AI 対局の各局面で、候補の代表完成形が和了判定と一致（両モード・短い通し）', () => {
  for (const r of [M1, M2]) {
    const lineup = ['speed', 'value', 'closed', 'speed'];
    const g = new Game({ rules: r, seed: 77, dealer: 1, players: lineup.map((p) => ({ kind: 'ai', personality: p })) });
    const rng = createRng(9);
    let checks = 0;
    while (g.pending() && checks < 40) {
      const p = g.pending();
      if (p.seat === 0 && p.type === 'turn') {
        const v = g.viewFor(0);
        const exposed = v.melds[0].map((m) => m.meld);
        for (const c of yakuCandidates(r, v)) {
          if (c.special) continue;
          const ev = r.evaluateMelds(c.example, exposed.length === 0);
          assert.ok(ev.yaku.some((y) => y.id === c.id), c.name);
          checks++;
        }
      }
      applyAction(g, p.seat, decide(g, p.seat, lineup[p.seat], rng));
    }
  }
});
