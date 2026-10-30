// 聴牌の待ちの表示（src/ui/waits-view.js・docs/65）：リーチ前の聴牌・捨てる候補を選んだ後の待ち・リーチの待ち・鳴いた手の役なし・
// フリテン中も表示・残り枚数は公開情報だけ・他家の手牌と山を参照しない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine/game.js';
import { applyAction, decide } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { tenpaiWaitsView } from '../src/ui/waits-view.js';
import { rulesFor, k } from './helpers.js';

const players = [0, 1, 2, 3].map((s) => ({ name: 'P' + s, kind: 'ai', personality: 'speed' }));
const TENPAI = ['cos', '180', '=-1', 'tan', '45', '=1', 'sin', '=1/2']; // 30°・150° 待ち（数学Ⅱは 30°・150°）
const OTHERS = [
  ['90', '90', '0', '0', '=√3', '=√3', '=-1/√3', '=-1/√3'],
  ['90', '90', '0', '0', '=√3', '=√3', '=-1/√3', '=-1/√3'],
  ['=-√3/2', '=-√3/2', '=1/√3', '=1/√3', '=-1/√2', '=-1/√2', '=1/√2', '=1/√2'],
];
function game(mode, hand, draws, ruleset = 2) {
  const hands = [hand, ...OTHERS];
  const keys = [];
  for (let i = 0; i < 8; i++) for (let s = 0; s < 4; s++) keys.push(k(hands[s][i]));
  return new Game({ rules: rulesFor(mode), seed: 1, dealer: 0, players, presetWall: [...keys, ...draws.map(k)], ruleset });
}
const keyOf = (rules, t) => rules.types[t].key;
const view = (g, opts = {}) => {
  const p = g.pending();
  return tenpaiWaitsView(g.rules, g.viewFor(0), { riichiWaits: g.riichiWaits[0], myTurn: !!(p && p.seat === 0 && p.type === 'turn'), ...opts });
};

for (const mode of ['math1', 'math2']) {
  test(`${mode}：リーチ前の聴牌は待ちを表示。自分の番は捨てる候補を選ぶとその牌を捨てた後の待ち、選ばなければ表示なし`, () => {
    const g = game(mode, TENPAI, ['=-√3', '=-√3', '=-√3', '=-√3', '=-1/2']);
    const R = g.rules;
    // 自分の番（9枚）：未選択は表示なし
    assert.equal(view(g), null);
    // ツモ牌（−√3）を選ぶ → 捨てた後は 30°・150° 待ち
    const v = view(g, { selected: g.drawn });
    assert.equal(v.kind, 'after-discard');
    assert.deepEqual(v.waits.map((w) => keyOf(R, w.type)), ['a:30', 'a:150']);
    assert.ok(v.waits.every((w) => w.winnable));
    // 聴牌にならない牌（cos）を選ぶ → 表示なし
    const cos = g.hands[0].find((id) => keyOf(R, g.typeOf(id)) === 'f:cos');
    assert.equal(view(g, { selected: cos }), null);
    // 捨てた後（他家の番、8枚）：聴牌の待ち
    g.discard(0, g.drawn);
    const t = view(g);
    assert.equal(t.kind, 'tenpai');
    assert.deepEqual(t.waits.map((w) => keyOf(R, w.type)), ['a:30', 'a:150']);
    // 残り枚数：4枚から、自分から見える枚数（手牌・河・面子・ドラ表示牌）を引いた数
    const unseen = (type) => 4 - [...g.hands[0], ...g.rivers.flat().map((r) => r.id)].filter((id) => g.typeOf(id) === type).length
      - g.doraIndicators.filter((d) => g.typeOf(d.id) === type).length;
    for (const w of t.waits) assert.equal(w.unseen, unseen(w.type));
  });

  test(`${mode}：リーチ後は確定した待ち。フリテン中も待ちを表示する（ロン不可の理由はエンジンの furitenOf）`, () => {
    // 150° をツモ（和了できる）してもリーチで捨てる → 捨て牌のフリテン
    const g = game(mode, TENPAI, ['150', '=-√3', '=-√3', '=-√3', '=-1/2']);
    g.discard(0, g.drawn, { riichi: true });
    for (let i = 0; i < 10 && g.pending() && g.pending().seat !== 0; i++) { const p = g.pending(); if (p.type === 'claim') g.respond(p.seat, { type: 'pass' }); else g.discard(p.seat, g.drawn); }
    const v = view(g);
    assert.equal(v.kind, 'riichi');
    assert.deepEqual(v.waits.map((w) => keyOf(g.rules, w.type)), ['a:30', 'a:150']);
    const f = g.furitenOf(0);
    assert.ok(f.furiten && f.reasons.includes('discard'), 'フリテン');
  });
}

test('鳴いた手：役のない待ちは「和了できない」と区別する（門前なら同じ待ちで和了できる）', () => {
  const R = rulesFor('math1');
  // 公開面子 sin 30 = 1/2（チー）＋ 手の内 cos 180 = −1 と tan・45 → 待ち =1（tan 45 = 1）は三関制覇で和了可
  const T = (x) => R.typeByKey.get(k(x)).idx;
  const mkView = (meld, hand) => ({
    seat: 0, drawn: null,
    hand: hand.map((x, i) => ({ id: 100 + i, type: T(x) })),
    melds: [[{ meld: R.meldOf(...meld.map(T)).idx, kind: 'formula', call: 'chi', tiles: meld.map(T), from: 3 }], [], [], []],
    rivers: [[], [], [], []],
  });
  const a = tenpaiWaitsView(R, mkView(['sin', '30', '=1/2'], ['cos', '180', '=-1', 'tan', '45']));
  assert.deepEqual(a.waits.map((w) => [w.type, w.winnable]), [[T('=1'), true]], '三関制覇');
  // 公開 sin 30 = 1/2 ＋ 手の内 sin 90 = 1・180・=−1 → 待ち cos（cos 180 = −1）：sin・sin・cos で役なし
  const b = tenpaiWaitsView(R, mkView(['sin', '30', '=1/2'], ['sin', '90', '=1', '180', '=-1']));
  const cosW = b.waits.find((w) => w.type === T('cos'));
  assert.ok(cosW && cosW.winnable === false, '鳴いた手で役なし');
  // 同じ9枚でも門前（公開面子なし）なら役なしで和了できる
  const c = tenpaiWaitsView(R, { seat: 0, drawn: null, hand: ['sin', '30', '=1/2', 'sin', '90', '=1', '180', '=-1'].map((x, i) => ({ id: 200 + i, type: T(x) })), melds: [[], [], [], []], rivers: [[], [], [], []] });
  assert.ok(c.waits.find((w) => w.type === T('cos')).winnable, '門前は役なしでも和了可');
});

test('公開情報だけ：他家の手牌・山の並びを変えても結果は同じ。view のうち参照するのは自分の手牌・面子・河・ドラ表示牌だけ', () => {
  for (const mode of ['math1', 'math2']) {
    const rules = rulesFor(mode);
    for (let seed = 1; seed <= 30; seed++) {
      const g = new Game({ rules, seed, dealer: seed % 4, players, ruleset: 2 });
      const rng = createRng(seed);
      for (let i = 0; i < 40 && g.pending(); i++) {
        const p = g.pending();
        if (p.seat === 0 && p.type !== 'turn') {
          const before = JSON.stringify(view(g));
          // 他家の手牌と山を入れ替える（自分の view は変わらない）
          const save = [g.hands[1].slice(), g.wall.slice()];
          const swap = g.hands[1][0]; g.hands[1][0] = g.wall[0]; g.wall[0] = swap;
          assert.equal(JSON.stringify(view(g)), before, `seed ${seed}`);
          [g.hands[1], g.wall] = save;
          // 参照するキー
          const used = new Set();
          const v = g.viewFor(0);
          const proxy = new Proxy(v, { get(t, key) { used.add(String(key)); return t[key]; } });
          tenpaiWaitsView(rules, proxy, { riichiWaits: g.riichiWaits[0] });
          for (const key of used) assert.ok(['seat', 'hand', 'melds', 'rivers', 'doraIndicators', 'drawn'].includes(key), key);
        }
        applyAction(g, p.seat, decide(g, p.seat, 'speed', rng, 'intermediate'));
      }
    }
  }
});

test('エンジンの待ち（riichiOptions・shapeWaits）と一致する', () => {
  for (const mode of ['math1', 'math2']) {
    const rules = rulesFor(mode);
    let checked = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const g = new Game({ rules, seed, dealer: 0, players, ruleset: 2 });
      const rng = createRng(seed);
      for (let i = 0; i < 80 && g.pending(); i++) {
        const p = g.pending();
        if (p.seat === 0 && p.type === 'turn' && g.isClosed(0) && !g.riichi[0]) {
          for (const o of g.riichiOptions(0)) {
            const v = view(g, { selected: o.ids[0] });
            assert.deepEqual(v.waits.map((w) => w.type), o.waits, `seed ${seed}`);
            checked++;
          }
        }
        if (p.seat !== 0 || p.type !== 'turn') {
          const sw = g.shapeWaits(0);
          const v = view(g);
          assert.deepEqual(v ? v.waits.map((w) => w.type) : [], sw || []);
        }
        applyAction(g, p.seat, decide(g, p.seat, 'speed', rng, 'intermediate'));
      }
    }
    assert.ok(checked > 10, `${mode} ${checked}`);
  }
});
