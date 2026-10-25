// 役候補ヒント（src/engine/yakuhint.js）の検証
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRules } from '../src/engine/rules.js';
import { LEGACY_V02_CONFIG as DEFAULT_CONFIG } from '../src/engine/config.js'; // 互換テスト（Ver.0.2.1 の規則）
import { Game } from '../src/engine/game.js';
import { createRng } from '../src/engine/rng.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { yakuCandidates, unseenFromView, warmUp } from '../src/engine/yakuhint.js';
import { rules, idx, meld, makeGame, junk, junk2, junk3 } from './helpers.js';

// 公開情報（view と同じ形）を手で作る
function view({ hand, exposed = [], rivers = [[], [], [], []], otherMelds = [[], [], []], r = rules }) {
  const melds = [exposed.map((m) => ({ meld: m.idx, tiles: m.tiles, from: 3 })), ...otherMelds];
  return {
    seat: 0,
    hand: hand.map((s, i) => ({ id: i, type: idx(s, r) })),
    melds,
    rivers: rivers.map((rv) => rv.map((s) => idx(s, r))),
  };
}
const names = (cs) => cs.map((c) => c.name);
const find = (cs, name) => cs.find((c) => c.name === name);

// 候補の代表完成形が「既存の和了判定で本当に和了でき、その役が成立する」ことを確認
function assertConsistent(r, v, c) {
  const exposed = v.melds[v.seat].map((m) => m.meld);
  const closed = exposed.length === 0;
  if (c.special) {
    assert.ok(closed || !c.closedOnly, `${c.name}: 鳴いた手で門前限定の特殊和了`);
    return;
  }
  const ev = r.evaluateMelds(c.example, closed);
  assert.ok(ev.yaku.some((y) => y.id === c.id), `${c.name}: 代表形で役が成立しない`);
  assert.equal(ev.points, c.points, `${c.name}: 点数が既存の得点処理と一致しない`);
  if (!closed) assert.ok(!c.closedOnly, `${c.name}: 鳴いた手で門前限定役`);
  // 完成形の手の内の牌で、既存の analyzeWin が和了と判定する
  const concealed = c.example.slice(exposed.length).flatMap((mi) => r.melds[mi].tiles);
  const win = r.analyzeWin(r.countsOf(concealed), exposed);
  assert.ok(win, `${c.name}: analyzeWin で和了にならない`);
  assert.ok(win.points >= c.points);
  // あと何枚 = 必要牌（重複込み）− 手牌
  const have = r.countsOf(v.hand.map((h) => h.type));
  const need = r.countsOf(concealed);
  const missing = need.reduce((s, n, t) => s + Math.max(0, n - have[t]), 0);
  assert.equal(missing, c.missing, `${c.name}: あと何枚の計算`);
  // 足りない牌が見えていない残り枚数を超えない
  const unseen = unseenFromView(r, v);
  need.forEach((n, t) => assert.ok(n - have[t] <= unseen[t], `${c.name}: 残り枚数を超える`));
}

test('三重同式：必要牌の重複枚数（各3枚）を数える。見えている牌で不可能になれば除外', () => {
  const v = view({ hand: ['sin', 'sin', 'sin', '30', '30', '30', '=1/2', '=1/2'] });
  const cs = yakuCandidates(rules, v);
  assert.equal(cs[0].name, '三重同式');
  assert.equal(cs[0].missing, 1);
  assert.equal(cs[0].points, 16);
  assert.ok(cs[0].yakuman);
  for (const c of cs) assertConsistent(rules, v, c);
  // =1/2 の残り2枚が河に見えている → sin30=1/2 ×3 は作れない（3枚目の =1/2 がない）。
  // 三重同式そのものは別の面子（例 tan30=1/√3 ×3）でまだ可能なので、あと1枚では作れなくなることを確認する。
  const v2 = view({ hand: ['sin', 'sin', 'sin', '30', '30', '30', '=1/2', '=1/2'], rivers: [[], ['=1/2'], ['=1/2'], []] });
  const c2 = find(yakuCandidates(rules, v2, { limit: 99 }), '三重同式');
  assert.ok(!c2 || c2.missing > 1, 'sin30=1/2 ×3 を候補にしない');
  if (c2) {
    assert.ok(!c2.example.every((mi) => mi === meld('sin', 30, '=1/2').idx));
    assertConsistent(rules, v2, c2);
  }
});

test('同角三関（役満）：役満の得点処理（通常役を加算しない）と一致', () => {
  const v = view({ hand: ['sin', 'cos', 'tan', '225', '225', '225', '=-1/√2', '=-1/√2'] });
  const cs = yakuCandidates(rules, v);
  const c = find(cs, '同角三関');
  assert.ok(c);
  assert.equal(c.missing, 1);
  assert.equal(c.points, 16);
  const ev = rules.evaluateMelds(c.example, true);
  assert.deepEqual(ev.yaku.map((y) => y.name), ['同角三関'], '役満の完成形には通常役が含まれない');
  for (const x of cs) assertConsistent(rules, v, x);
});

test('九角無双：門前のみ別判定。鳴いた手・残りがない角度では候補にしない', () => {
  const eight = ['0', '30', '45', '60', '90', '120', '135', '150'];
  const v = view({ hand: eight });
  const cs = yakuCandidates(rules, v);
  assert.equal(cs[0].name, '九角無双');
  assert.equal(cs[0].missing, 1);
  assert.equal(cs[0].points, 16);
  assert.ok(cs[0].special && cs[0].closedOnly);
  // 180° が4枚とも見えている → 候補にしない
  const v2 = view({ hand: eight, rivers: [['180'], ['180'], ['180'], ['180']] });
  assert.ok(!names(yakuCandidates(rules, v2, { limit: 99 })).includes('九角無双'));
  // チー済み（公開面子あり）→ 候補にしない
  const v3 = view({ hand: eight.slice(0, 5), exposed: [meld('sin', 30, '=1/2')] });
  assert.ok(!names(yakuCandidates(rules, v3, { limit: 99 })).includes('九角無双'));
  // 裏九角無双（無効設定）は候補にしない
  const ura = view({ hand: ['180', '210', '225', '240', '270', '300', '315', '330'] });
  assert.ok(!names(yakuCandidates(rules, ura, { limit: 99 })).includes('裏九角無双'));
});

test('チー後：公開面子を含む完成形だけを評価し、役のない形・門前限定役は候補にしない', () => {
  // 門前限定を試すため、三関制覇を門前限定にした設定を用意（ゲームの設定は変更しない）
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.yaku.find((y) => y.id === 'sankan').closedOnly = true;
  const r = createRules(cfg);
  const hand = ['cos', '180', '=-1', 'tan', '45'];
  const ex = r.meldOf(r.typeByKey.get('f:sin').idx, r.typeByKey.get('a:30').idx, r.typeByKey.get('v:1/2').idx);
  const vCalled = view({ hand, exposed: [ex], r });
  const called = yakuCandidates(r, vCalled, { limit: 99 });
  assert.ok(!names(called).includes('三関制覇'), '門前限定役は鳴いた手で出ない');
  for (const c of called) {
    assert.ok(c.example.includes(ex.idx), '公開面子を含む');
    assertConsistent(r, vCalled, c);
  }
  // 門前なら同じ牌構成で三関制覇が出る
  const vClosed = view({ hand: ['sin', '30', '=1/2', ...hand], r });
  assert.ok(names(yakuCandidates(r, vClosed, { limit: 99 })).includes('三関制覇'));
  // 既定設定（三関制覇は鳴いても可）では鳴いた手でも出る
  const vDefault = view({ hand, exposed: [meld('sin', 30, '=1/2')] });
  assert.ok(names(yakuCandidates(rules, vDefault, { limit: 99 })).includes('三関制覇'));
});

test('チー後に役のない完成形しか残らない場合は、その完成形を候補にしない', () => {
  // 公開 sin30=1/2, cos180=-1。手の内 cos,0,=1（cos0=1 で完成すると役なし → 和了不可）
  const v = view({ hand: ['cos', '0', '=1'], exposed: [meld('sin', 30, '=1/2'), meld('cos', 180, '=-1')] });
  const cs = yakuCandidates(rules, v, { limit: 99 });
  for (const c of cs) {
    assert.ok(c.missing >= 1, '役なしの完成形（あと0枚）を候補にしない');
    assertConsistent(rules, v, c);
  }
  assert.ok(rules.analyzeWin(rules.countsOf(['f:cos', 'a:0', 'v:1'].map((k) => rules.typeByKey.get(k).idx)), [meld('sin', 30, '=1/2').idx, meld('cos', 180, '=-1').idx]) === null);
});

test('複数の和了形：役のない分割が先に見つかっても、役のある分割を候補にする（あと0枚）', () => {
  const v = view({ hand: ['sin', 'sin', 'cos', '0', '90', '360', '=0', '=1', '=1'] });
  const cs = yakuCandidates(rules, v);
  const c = find(cs, '余角対');
  assert.ok(c);
  assert.equal(c.missing, 0);
  assertConsistent(rules, v, c);
  assert.equal(rules.analyzeWin(rules.countsOf(v.hand.map((h) => h.type))).points, 3);
});

test('並び順：あと何枚の少ない順 → 同数なら得点の高い順。最大3件', () => {
  const rng = createRng(7);
  for (let n = 0; n < 80; n++) {
    const hand = Array.from({ length: 8 + (n % 2) }, () => rules.types[rng.int(rules.T)].key);
    const c = rules.countsOf(hand.map((k) => rules.typeByKey.get(k).idx));
    if (c.some((x, i) => x > rules.types[i].copies)) continue;
    const v = { seat: 0, hand: hand.map((k, i) => ({ id: i, type: rules.typeByKey.get(k).idx })), melds: [[], [], [], []], rivers: [[], [], [], []] };
    const cs = yakuCandidates(rules, v);
    assert.ok(cs.length <= 3);
    for (let i = 1; i < cs.length; i++) {
      assert.ok(cs[i - 1].missing < cs[i].missing || (cs[i - 1].missing === cs[i].missing && cs[i - 1].points >= cs[i].points));
    }
    for (const x of cs) assertConsistent(rules, v, x);
  }
});

test('打切り最適化の検証：上位3件は、全組合せを評価した結果の上位3件と一致', () => {
  const rng = createRng(2026);
  for (let n = 0; n < 40; n++) {
    const g = new Game({ rules, seed: 500 + n, players: [0, 1, 2, 3].map(() => ({ kind: 'ai', personality: 'speed' })) });
    // 数手進めて河・公開面子のある局面を作る
    const steps = rng.int(25);
    for (let s = 0; s < steps && g.pending(); s++) {
      const p = g.pending();
      applyAction(g, p.seat, decide(g, p.seat, 'speed', rng));
    }
    if (!g.pending()) continue;
    for (let seat = 0; seat < 4; seat++) {
      const v = g.viewFor(seat);
      const top = yakuCandidates(rules, v);
      const all = yakuCandidates(rules, v, { limit: Infinity });
      assert.deepEqual(top.map((c) => [c.id, c.missing, c.points]), all.slice(0, 3).map((c) => [c.id, c.missing, c.points]));
      for (const c of all) assertConsistent(rules, v, c);
    }
  }
});

test('公開情報だけを使う：他家の非公開手牌が違っても結果は同じ', () => {
  const me = ['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'];
  const a = makeGame({ hands: [me, junk, junk2, junk3] });
  const b = makeGame({ hands: [me, junk3, junk, junk2] });
  const va = a.viewFor(0);
  const vb = b.viewFor(0);
  assert.deepEqual(va.hand.map((h) => h.type).sort(), vb.hand.map((h) => h.type).sort());
  assert.deepEqual(yakuCandidates(rules, va, { limit: 99 }), yakuCandidates(rules, vb, { limit: 99 }));
  assert.ok(!('hands' in va) && !('wall' in va));
});

test('役のない完成形（門前の通常和了のみ）は役候補に含めない', () => {
  // 手牌が役なしで完成している：sin30, sin120, cos180
  const v = view({ hand: ['sin', '30', '=1/2', 'sin', '120', '=√3/2', 'cos', '180', '=-1'] });
  const cs = yakuCandidates(rules, v, { limit: 99 });
  assert.ok(cs.every((c) => c.missing >= 1));
  assert.ok(cs.every((c) => c.name !== '通常和了'));
});

test('warmUp 後も結果は同じ（キャッシュの整合）', () => {
  const v = view({ hand: ['sin', 'cos', 'tan', '30', '45', '60', '=1/2', '=1'] });
  const before = yakuCandidates(rules, v, { limit: 99 });
  const r2 = createRules(DEFAULT_CONFIG);
  const queue = [];
  warmUp(r2, [], { chunk: 5000, schedule: (f) => queue.push(f) });
  while (queue.length) queue.shift()();
  assert.deepEqual(yakuCandidates(r2, v, { limit: 99 }), before);
});

// ======== Codex 監査（PR #2）指摘への対応：宣言対象牌・公開情報の変化・warmUp ========
import { claimForSeat, warmUpState } from '../src/engine/yakuhint.js';
import { hintKey } from '../src/ui/hintstate.js';

const harmless3 = ['cos', 'tan', '270', '270', '=-√3/2', '=-√3/2', '=1/√3', '=1/√3'];
const EIGHT = ['0', '30', '45', '60', '90', '120', '135', '150'];
const claimOf = (g, seat) => claimForSeat(g.pending(), seat, (id) => g.typeOf(id));
const ids = (g, seat, key) => g.hands[seat].find((id) => g.typeOf(id) === idx(key));

// 九角無双：最後の180°がロンできる状態で捨てられる → 見送る、を実際の Game で再現
function kyukakuGame() {
  // 親=自分(0)。他家は 180° と面子を作らない手。180° を 1→2→3→(0)→1 の順に引いて捨てる。
  return makeGame({
    hands: [EIGHT, junk, junk3, harmless3],
    draws: ['=-√3', '180', '180', '180', '=1/√3', '180'],
  });
}

test('九角無双：最後の180°をロンできる局面で候補に残り、見送った直後に消える', () => {
  const g = kyukakuGame();
  g.discard(0, g.drawn);
  let passes = 0;
  // 1〜3枚目の180°：毎回ロン可能。見送る。
  for (const seat of [1, 2, 3]) {
    g.discard(seat, g.drawn);
    const p = g.pending();
    assert.equal(p.type, 'claim');
    assert.equal(p.seat, 0);
    assert.ok(p.ron, `${seat}の180°でロン可能`);
    const c = find(yakuCandidates(rules, g.viewFor(0), { claim: claimOf(g, 0) }), '九角無双');
    assert.ok(c && c.missing === 0 && c.via === 'ron');
    g.respond(0, { type: 'pass' });
    passes++;
    // 見送った後：まだ見えていない180°が残っているので「あと1枚」
    const after = find(yakuCandidates(rules, g.viewFor(0), { claim: claimOf(g, 0) }), '九角無双');
    assert.ok(after && after.missing === 1 && after.via === null, `${passes}枚目見送り後`);
  }
  // 自分の手番：ツモ切り
  assert.equal(g.pending().seat, 0);
  g.discard(0, g.drawn);
  // 4枚目（最後）の180°
  g.discard(1, g.drawn);
  const p = g.pending();
  assert.ok(p.type === 'claim' && p.seat === 0 && p.ron);
  const claim = claimOf(g, 0);
  assert.deepEqual(claim, { type: idx('180'), from: 1, ron: true, chiMelds: [], ponMeld: null });
  // 宣言を考慮しない基本評価では、180°が4枚とも見えているので不可能
  assert.ok(!names(yakuCandidates(rules, g.viewFor(0), { limit: 99 })).includes('九角無双'));
  // 宣言対象牌を考慮すると「完成」（ロンで実現できる）
  const now = find(yakuCandidates(rules, g.viewFor(0), { claim }), '九角無双');
  assert.ok(now, '最後の180°をロンできる局面で九角無双が候補に残る');
  assert.equal(now.missing, 0);
  assert.equal(now.via, 'ron');
  assert.equal(now.points, 16);
  // 和了判定と一致（エンジンのロン判定）
  assert.equal(g.ronAnalysis(0, g.claim.tile).yaku[0].id, 'kyukaku');
  // 見送る → 宣言状態が終わり、180°は取得不能 → 候補から消える
  g.respond(0, { type: 'pass' });
  assert.equal(claimOf(g, 0), null);
  assert.ok(!names(yakuCandidates(rules, g.viewFor(0), { limit: 99, claim: claimOf(g, 0) })).includes('九角無双'));
  g.checkInvariants();
});

test('通常役：最後の1枚の打牌をロンできる局面で候補に残り、見送ると消える', () => {
  // 自分: sin30=1/2, cos180=-1, tan, 45 → =1 でロン（三関制覇）。=1 の他3枚は河で見えている。
  const g = makeGame({
    hands: [['sin', '30', '=1/2', 'cos', '180', '=-1', 'tan', '45'], junk, junk3, harmless3],
    draws: ['=-√3', '=1', '=1', '=1', '=1/√3', '=1'],
  });
  g.discard(0, g.drawn);
  for (const seat of [1, 2, 3]) {
    g.discard(seat, g.drawn);
    if (g.pending() && g.pending().type === 'claim') g.respond(g.pending().seat, { type: 'pass' });
  }
  g.discard(0, g.drawn);
  g.discard(1, g.drawn); // 最後の =1
  const claim = claimOf(g, 0);
  assert.ok(claim && claim.ron);
  // 基本評価：=1 は残っていない → tan45=1 を使う三関制覇は「あと1枚」では作れない
  const base = find(yakuCandidates(rules, g.viewFor(0), { limit: 99 }), '三関制覇');
  assert.ok(!base || base.missing >= 2);
  const c = find(yakuCandidates(rules, g.viewFor(0), { claim }), '三関制覇');
  assert.ok(c && c.missing === 0 && c.via === 'ron');
  // ロン後の局面（対象牌を河から手へ移した view）で、既存の和了判定・点数と一致
  const v0 = g.viewFor(0);
  const rivers = v0.rivers.map((r) => r.slice());
  rivers[1].splice(rivers[1].lastIndexOf(idx('=1')), 1);
  assertConsistent(rules, { seat: 0, melds: v0.melds, rivers, hand: [...v0.hand, { id: -1, type: idx('=1') }] }, c);
  g.respond(0, { type: 'pass' });
  const gone = find(yakuCandidates(rules, g.viewFor(0), { limit: 99, claim: claimOf(g, 0) }), '三関制覇');
  assert.ok(!gone || gone.missing >= 2, '見送り後は取得不能');
});

test('宣言対象牌は1枚だけ取得できるものとして数える（2枚必要な形には使えない）', () => {
  // 自分: sin, sin, 30, 30, =1/2 … sin30=1/2 を2組作るには =1/2 があと1枚。
  // =1/2 は残り：河に2枚＋宣言対象1枚（この1枚は取れる）。2枚目は取れない。
  const v = view({ hand: ['sin', 'sin', 'sin', '30', '30', '30', '=1/2', 'cos'], rivers: [[], ['=1/2', '=1/2'], [], ['=1/2']] });
  const claim = { type: idx('=1/2'), from: 3, ron: false, chiMelds: [meld('sin', 30, '=1/2').idx] };
  const all = yakuCandidates(rules, v, { limit: 99, claim });
  for (const c of all) {
    if (c.special) continue;
    // 代表形が使う =1/2 の枚数 ≦ 手牌1枚＋宣言対象1枚
    const used = c.example.flatMap((mi) => rules.melds[mi].tiles).filter((t) => t === idx('=1/2')).length;
    assert.ok(used <= 2, `${c.name}: =1/2 を${used}枚使う形`);
  }
  // 三重同式 sin30=1/2×3 は =1/2 が3枚必要（手牌1＋対象1では足りない）→ その形は出ない
  const sj = find(all, '三重同式');
  assert.ok(!sj || !sj.example.every((mi) => mi === meld('sin', 30, '=1/2').idx));
});

test('チーでだけ取れる対象牌：チー後の鳴いた手として評価（門前限定・九角無双は出ない）', () => {
  const g = makeGame({
    hands: [['=1/2', ...junk.slice(1)], ['sin', '30', '0', '45', '60', '90', '120', '135'], junk3, harmless3],
    draws: ['=-√3'],
  });
  g.discard(0, findTileOf(g, 0, '=1/2'));
  const p = g.pending();
  assert.equal(p.seat, 1);
  assert.ok(!p.ron && p.chi.length === 1);
  const claim = claimOf(g, 1);
  assert.deepEqual(claim.chiMelds, [meld('sin', 30, '=1/2').idx]);
  const cs = yakuCandidates(rules, g.viewFor(1), { limit: 99, claim });
  for (const c of cs.filter((x) => x.via === 'chi')) {
    assert.ok(!c.special && !c.closedOnly);
    assert.ok(c.example.includes(meld('sin', 30, '=1/2').idx), 'チーした面子を含む');
  }
  assert.ok(cs.some((c) => c.via === 'chi'));
});
function findTileOf(g, seat, key) { return ids(g, seat, key); }

test('宣言権がない席・他の席が判断中・判断後は、宣言対象牌を取得可能扱いしない', () => {
  const g = kyukakuGame();
  g.discard(0, g.drawn);
  g.discard(1, g.drawn); // 180° → 自分(0)がロン判断中
  assert.ok(claimOf(g, 0));
  for (const s of [1, 2, 3]) assert.equal(claimOf(g, s), null, `seat ${s}`);
  g.respond(0, { type: 'pass' });
  assert.equal(claimOf(g, 0), null, '判断後');
  // 自分の手番（宣言ではない）
  assert.equal(claimForSeat(null, 0, () => 0), null);
  assert.equal(claimForSeat({ type: 'turn', seat: 0 }, 0, () => 0), null);
  assert.equal(claimForSeat({ type: 'claim', seat: 0, tile: 1, from: 1, ron: false, chi: [] }, 0, () => 0), null);
});

// 修正前と同じ「静的な公開情報」に対する結果：総当たりの別実装と一致
function referenceCandidates(r, v) {
  const counts = r.countsOf(v.hand.map((h) => h.type));
  const exposed = v.melds[v.seat].map((m) => m.meld);
  const closed = exposed.length === 0;
  const unseen = unseenFromView(r, v);
  const k = 3 - exposed.length;
  const best = new Map();
  const M = r.melds.length;
  const visit = (combo) => {
    const need = r.countsOf(combo.flatMap((mi) => r.melds[mi].tiles));
    let missing = 0;
    for (let t = 0; t < need.length; t++) {
      const miss = need[t] - counts[t];
      if (miss > 0) { if (unseen[t] < miss) return; missing += miss; }
    }
    const ev = r.evaluateMelds([...exposed, ...combo], closed);
    for (const y of ev.yaku) {
      const cur = best.get(y.id);
      if (!cur || missing < cur.missing || (missing === cur.missing && ev.points > cur.points)) best.set(y.id, { id: y.id, missing, points: ev.points });
    }
  };
  if (k === 3) for (let a = 0; a < M; a++) for (let b = a; b < M; b++) for (let c = b; c < M; c++) visit([a, b, c]);
  if (k === 2) for (let a = 0; a < M; a++) for (let b = a; b < M; b++) visit([a, b]);
  if (k === 1) for (let a = 0; a < M; a++) visit([a]);
  if (closed) {
    for (const sp of r.config.specialHands.filter((s) => s.enabled)) {
      let missing = 0; let ok = true;
      for (const d of sp.angles) {
        const t = r.typeByKey.get(`a:${d}`).idx;
        if (counts[t] >= 1) continue;
        if (unseen[t] < 1) { ok = false; break; }
        missing++;
      }
      if (ok) best.set(sp.id, { id: sp.id, missing, points: sp.points });
    }
  }
  return best;
}

test('静的な公開情報（宣言なし）：結果は総当たりの別実装と一致（修正前と同じ）', () => {
  const rng = createRng(31);
  let views = 0;
  for (let n = 0; n < 12; n++) {
    const g = new Game({ rules, seed: 900 + n, players: [0, 1, 2, 3].map(() => ({ kind: 'ai', personality: 'speed' })) });
    const steps = rng.int(30);
    for (let s = 0; s < steps && g.pending(); s++) { const p = g.pending(); applyAction(g, p.seat, decide(g, p.seat, 'speed', rng)); }
    if (!g.pending()) continue;
    for (let seat = 0; seat < 4; seat++) {
      const v = g.viewFor(seat);
      const ref = referenceCandidates(rules, v);
      const got = yakuCandidates(rules, v, { limit: Infinity });
      assert.deepEqual(got.map((c) => [c.id, c.missing, c.points]).sort(), [...ref.values()].map((c) => [c.id, c.missing, c.points]).sort());
      assert.deepEqual(yakuCandidates(rules, v).map((c) => c.id), got.slice(0, 3).map((c) => c.id));
      views++;
    }
  }
  assert.ok(views >= 30);
});

test('非公開情報にアクセスしない：view・claim の読み取りは公開項目だけ', () => {
  const g = kyukakuGame();
  g.discard(0, g.drawn);
  g.discard(1, g.drawn);
  const accessed = new Set();
  const track = (obj, path) => new Proxy(obj, {
    get(t, k) {
      if (typeof k === 'string' && !/^\d+$/.test(k) && !['length', 'map', 'slice', 'filter', 'lastIndexOf', 'findIndex', 'splice', 'push', 'forEach', 'flatMap', 'every', 'some', 'reduce', 'includes', 'indexOf', 'find', 'constructor', 'toJSON'].includes(k)) accessed.add(`${path}.${k}`);
      const val = t[k];
      return val && typeof val === 'object' ? track(val, `${path}.${typeof k === 'string' && /^\d+$/.test(k) ? '#' : String(k)}`) : val;
    },
  });
  const v = g.viewFor(0);
  yakuCandidates(rules, track(v, 'view'), { claim: track(claimOf(g, 0), 'claim') });
  const allowed = /^(view\.(seat|hand|melds|rivers)(\.#)*(\.(type|id|meld|tiles|from))?|claim\.(type|from|ron|chiMelds|ponMeld))$/; // ponMeld：自分のポンの選択肢（Ver.0.3）
  for (const a of accessed) assert.match(a, allowed, `想定外の参照: ${a}`);
  assert.ok(!('hands' in v) && !('wall' in v) && !('tileType' in v));
});

test('hintKey：公開情報の変化（河だけ・公開面子だけ・宣言状態）で変わり、非公開の変化では変わらない', () => {
  const g = kyukakuGame();
  const key = () => hintKey(g.viewFor(0), claimOf(g, 0));
  g.discard(0, g.drawn);
  const k0 = key();
  // 他家の手番でツモ（非公開の変化：他家の手牌と山）→ 変わらない
  assert.equal(g.pending().seat, 1);
  assert.equal(key(), k0, '他家のツモでは変わらない');
  // 他家の打牌（自分の手牌は不変、河だけ変化）＋宣言状態の発生 → 変わる
  const handBefore = g.hands[0].slice();
  g.discard(1, g.drawn);
  assert.deepEqual(g.hands[0], handBefore);
  const k1 = key();
  assert.notEqual(k1, k0);
  // 見送り → 宣言状態だけ変化 → 変わる
  g.respond(0, { type: 'pass' });
  assert.notEqual(key(), k1);
  // 河だけが変わる（宣言なし）
  const k2 = key();
  g.discard(2, g.drawn);
  if (g.pending() && g.pending().type === 'claim') g.respond(g.pending().seat, { type: 'pass' });
  assert.notEqual(key(), k2);
  // 公開面子だけが変わる：チー（chiSetup と同じ形）
  const c = makeGame({ hands: [['=1/2', 'sin', 'sin', '0', '0', '90', '=-√3', '=-√3'], ['sin', '30', 'cos', 'cos', '180', '180', '=√3', '=√3'], junk3, harmless3], draws: ['=-1/√3'] });
  c.discard(0, ids(c, 0, '=1/2'));
  c.respond(1, { type: 'pass' }); // 見送り（河に残る）
  const before = hintKey(c.viewFor(0), null);
  const view = c.viewFor(0);
  view.melds[1].push({ meld: meld('sin', 30, '=1/2').idx, tiles: [], from: 0 }); // 公開面子だけを変えた view
  assert.notEqual(hintKey(view, null), before);
});

test('warmUp：連続100回呼んでも重複して事前計算しない。完了後は再実行しない', () => {
  const r = createRules(DEFAULT_CONFIG);
  const queue = [];
  let scheduled = 0;
  const schedule = (f) => { scheduled++; queue.push(f); };
  const started = [];
  for (let i = 0; i < 100; i++) started.push(warmUp(r, [], { chunk: 2000, schedule }));
  assert.equal(started.filter(Boolean).length, 1, '開始は1回だけ');
  assert.equal(scheduled, 1, '実行中は追加の予約をしない');
  assert.equal(warmUpState(r), 'running');
  let runs = 0;
  while (queue.length) { queue.shift()(); runs++; }
  assert.equal(warmUpState(r), 'done');
  assert.equal(runs, Math.ceil(20825 / 2000));
  const after = scheduled;
  for (let i = 0; i < 100; i++) assert.equal(warmUp(r, [], { chunk: 2000, schedule }), false);
  assert.equal(scheduled, after, '完了後は予約しない');
  // 公開面子が違えば別の事前計算
  assert.equal(warmUp(r, [0], { chunk: 5000, schedule }), true);
});

test('warmUp：スケジューラーの例外・処理中の例外では状態を戻し、次回やり直せる。結果は正確', () => {
  const r = createRules(DEFAULT_CONFIG);
  assert.throws(() => warmUp(r, [], { schedule: () => { throw new Error('no scheduler'); } }), /no scheduler/);
  assert.equal(warmUpState(r), 'idle');
  // 2回目の予約で失敗（処理の途中で中断）
  let calls = 0;
  const q = [];
  const flaky = (f) => { calls++; if (calls === 2) throw new Error('interrupted'); q.push(f); };
  warmUp(r, [], { chunk: 1000, schedule: flaky });
  assert.throws(() => q.shift()(), /interrupted/);
  assert.equal(warmUpState(r), 'idle');
  // やり直し（局切替の途中でも同じ rules なら1本だけ走る）
  const q2 = [];
  assert.equal(warmUp(r, [], { chunk: 3000, schedule: (f) => q2.push(f) }), true);
  assert.equal(warmUp(r, [], { chunk: 3000, schedule: (f) => q2.push(f) }), false);
  while (q2.length) q2.shift()();
  assert.equal(warmUpState(r), 'done');
  const v = view({ hand: ['sin', 'cos', 'tan', '30', '45', '60', '=1/2', '=1'] });
  assert.deepEqual(yakuCandidates(r, v, { limit: 99 }), yakuCandidates(rules, v, { limit: 99 }));
});
