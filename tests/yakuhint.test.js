// 役候補ヒント（src/engine/yakuhint.js）の検証
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRules } from '../src/engine/rules.js';
import { DEFAULT_CONFIG } from '../src/engine/config.js';
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
