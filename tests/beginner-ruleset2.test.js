// 初心者の部屋の全課題を現行ルール（ruleset 2）に統一（docs/68）。旧ルール（ruleset 0）で動く課題がないこと、
// 各課題を実際のエンジンで最初から最後まで打ち切れること、通常対局と同じ規則（関数牌のポン禁止・チーは上家だけ・鳴いた手の役・
// フリテン・宣言料5点・ドラ）が教材でも成り立つこと、牌数（王牌を含む124枚）と400点の保存。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/engine/config.js';
import { createRules } from '../src/engine/rules.js';
import { trigExact, toNumber } from '../src/engine/exact.js';
import { Game } from '../src/engine/game.js';
import { LESSONS, PRACTICE_RULESET, createPractice, lessonWall, pendingOf, practiceAct, practiceSelect, practiceContinue, practiceHTML, HUMAN } from '../src/ui/beginner-practice.js';
import { CURRENT_RULESET } from '../src/ui/replay.js';
import { validateReplay } from '../src/ui/replay.js';

const rules = createRules(makeConfig({ mode: 'math1' }));
const L = Object.fromEntries(LESSONS.map((l) => [l.id, l]));
const keyOf = (g, id) => rules.types[g.typeOf(id)].key;
const handId = (p, k) => p.game.hands[HUMAN].find((id) => keyOf(p.game, id) === k);
const sel = (p, k) => assert.equal(practiceSelect(p, handId(p, k)), true, `手牌に ${k}`);

// 各課題の正しい操作手順（教材の説明どおり）
const SOLVE = {
  D1: (p) => { sel(p, 'a:135'); practiceAct(p, { type: 'discard' }); },
  T1: (p) => { sel(p, 'a:135'); practiceAct(p, { type: 'discard' }); },
  '4A': (p) => { practiceAct(p, { type: 'chi', option: 0 }); sel(p, 'a:90'); practiceAct(p, { type: 'discard' }); },
  '4B': (p) => { practiceContinue(p); practiceContinue(p); practiceAct(p, { type: 'chi', option: 0 }); sel(p, 'a:90'); practiceAct(p, { type: 'discard' }); },
  '4C': (p) => { practiceAct(p, { type: 'pon' }); sel(p, 'a:90'); practiceAct(p, { type: 'discard' }); },
  '4D': (p) => { practiceAct(p, { type: 'chi', option: 0 }); sel(p, 'a:135'); practiceAct(p, { type: 'discard' }); practiceContinue(p); practiceAct(p, { type: 'ron' }); },
  '5A': (p) => { sel(p, 'v:-1'); practiceAct(p, { type: 'discard', riichi: true }); practiceSelect(p, p.game.drawn); practiceAct(p, { type: 'discard' }); },
  '5B': (p) => practiceAct(p, { type: 'ron' }),
  '5C': (p) => practiceAct(p, { type: 'tsumo' }),
  F1: (p) => { sel(p, 'a:30'); practiceAct(p, { type: 'discard' }); sel(p, 'a:135'); practiceAct(p, { type: 'discard' }); practiceContinue(p); practiceAct(p, { type: 'tsumo' }); },
  F2: (p) => { practiceAct(p, { type: 'pass' }); practiceContinue(p); practiceSelect(p, p.game.drawn); practiceAct(p, { type: 'discard' }); practiceAct(p, { type: 'ron' }); },
  6: (p) => { sel(p, 'a:90'); practiceAct(p, { type: 'discard', riichi: true }); practiceAct(p, { type: 'ron' }); },
};

// 牌の保存：山・王牌・手牌・河・公開面子に全124枚がちょうど1回ずつ
function conserved(g) {
  g.checkInvariants();
  const n = g.wall.length + g.deadWall.allPhysical().length + g.hands.flat().length + g.rivers.flat().length + g.melds.flat().reduce((s, m) => s + m.tiles.length, 0);
  assert.equal(n, 124);
}

// 練習の進行を1手ずつ見張る：宣言の選択肢が現行ルールに合っているか（関数牌のポンなし・チーは上家の打牌だけ・フリテン中のロンなし）
function watch(p) {
  const g = p.game;
  const pd = g.pending();
  if (pd && pd.type === 'claim') {
    const c = g.claim;
    for (const q of c.queue) {
      const t = rules.types[g.typeOf(c.tile)];
      if (q.pon) assert.notEqual(t.kind, 'func', `${p.lessonId}：関数牌 ${t.key} のポンの選択肢`);
      if (q.chi.length) assert.equal(q.seat, (c.from + 1) % 4, `${p.lessonId}：チーは打牌者の下家（＝打牌者が上家）だけ`);
      if (q.ron && q.seat === HUMAN) assert.equal(g.furitenOf(HUMAN).furiten, false, `${p.lessonId}：フリテン中のロンの選択肢`);
    }
  }
}

test('全課題が現行ルール（ruleset 2）で動く：旧ルール（0）の課題はない', () => {
  assert.equal(PRACTICE_RULESET, 2);
  assert.equal(PRACTICE_RULESET, CURRENT_RULESET, '通常対局と同じ版');
  for (const l of LESSONS) {
    assert.equal('ruleset' in l, false, `${l.id}：課題ごとに版を変えない`);
    const p = createPractice(rules, l);
    const g = p.game;
    assert.deepEqual([g.ruleset, g.newRules, g.furitenRule, g.funcPonBan, g.fourRiichiRule], [2, true, true, true, true], l.id);
    assert.ok(g.deadWall && g.doraIndicators.length === 1, `${l.id}：王牌とドラ表示牌`);
    assert.match(practiceHTML(p), /ドラ表示牌/, `${l.id}：ドラを表示`);
    conserved(g);
  }
});

test('全課題を実際のエンジンで最初から最後まで打ち切る：牌数124枚・400点・和了点の内訳＝表示・数式と和了判定が一致', () => {
  const wins = [];
  for (const l of LESSONS) {
    const p = createPractice(rules, l);
    // エンジンへのすべての操作（あなた・練習用CPU）の直前と直後に、選択肢が現行ルールに合っているかを見張る
    let steps = 0;
    for (const fn of ['discard', 'respond', 'tsumo']) {
      const orig = p.game[fn].bind(p.game);
      p.game[fn] = (...args) => { watch(p); const r = orig(...args); watch(p); conserved(p.game); steps++; return r; };
    }
    watch(p);
    SOLVE[l.id](p);
    assert.ok(steps > 0);
    assert.equal(p.done, true, `${l.id} 完了`);
    const g = p.game;
    conserved(g);
    if (g.result && g.result.type === 'win') {
      const r = g.result, a = r.analysis;
      wins.push(l.id);
      // 和了判定：最終の9枚（公開面子を含む）をエンジンで判定し直しても和了で、同じ点
      const again = rules.analyzeWin(g.countsOf(g.hands[r.winner]), g.exposedMelds(r.winner), { closed: g.isClosed(r.winner), ron: r.how === 'ron' });
      assert.ok(again, `${l.id}：和了形`);
      // 数式面子は正しい等式（関数(角度) = 結果）。刻子は同じ牌3枚
      for (const mi of a.melds) {
        const m = rules.melds[mi];
        if (m.kind === 'formula') {
          const [f, ang, val] = m.tiles.map((t) => rules.types[t]);
          const [vp, vq, vr] = rules.config.values.find((v) => `v:${v.key}` === val.key).exact; // 結果牌の厳密値 (p/q)·√r
          assert.ok(Math.abs(toNumber(trigExact(f.fn, ang.deg)) - (vp / vq) * Math.sqrt(vr)) < 1e-12, `${l.id}：${m.key}`);
        } else assert.equal(new Set(m.tiles).size, 1);
      }
      // 鳴いた手は役が必要
      if (!g.isClosed(r.winner)) assert.ok(a.yaku.some((y) => !y.riichi), `${l.id}：鳴いた手の役`);
      // 和了点＝通常和了＋役（リーチを含む）＋ドラ。結果画面の内訳の合計と一致
      assert.equal(r.points, (a.yakuman ? 0 : rules.config.scoring.base) + a.yaku.reduce((s, y) => s + y.points, 0) + (a.doraBonus || 0), l.id);
      // 精算：持ち点の合計400（供託は和了者が得て0）
      assert.equal(p.settlement.scores.reduce((x, y) => x + y, 0), 400, l.id);
      assert.equal(p.settlement.deltas.reduce((x, y) => x + y, 0), 0, l.id);
    }
  }
  assert.deepEqual(wins, ['4D', '5B', '5C', 'F1', 'F2', '6']);
});

test('関数牌（sin・cos・tan）のポン禁止：同じ関数牌を2枚持っていてもポンの選択肢が出ない（旧7-Cの局面でも）。7-C は角度牌 45° のポン', () => {
  // 旧7-C（ruleset 0 では sin のポンができた局面）を現行ルールで作る
  for (const fn of ['sin', 'cos', 'tan']) {
    const lesson = { ...L['4C'], id: `pon-${fn}`, hand: [fn, fn, 'cos', '0', '=1', 'tan', '45', '90'].map((x, i) => (i > 1 && x === fn ? '60' : x)), draws: [fn] };
    const g = new Game({ rules, seed: 1, dealer: lesson.dealer, players: [0, 1, 2, 3].map(() => ({ kind: 'ai' })), presetWall: lessonWall(lesson), ruleset: 2 });
    // 対面（親）が fn を捨てる
    g.discard(g.current, g.drawn);
    const pd = g.pending();
    assert.ok(!pd || pd.seat !== HUMAN || !pd.pon, `${fn} のポンの選択肢がない`);
    assert.equal(g.ponOption(HUMAN, g.rivers[lesson.dealer].at(-1).id), null);
  }
  const p = createPractice(rules, L['4C']);
  const pd = pendingOf(p);
  assert.equal(keyOf(p.game, pd.tile), 'a:45');
  assert.ok(pd.pon);
  assert.match(L['4C'].lead, /関数牌はポンできない/);
  // 教材の文に関数牌のポンを教える記述がない
  for (const l of LESSONS) for (const txt of [l.lead, l.hint || '', ...Object.values(l.pauses || {})]) assert.doesNotMatch(txt, /(sin|cos|tan)\s*(を|の)?\s*(2枚|×3).*ポン|ポン.*(sin|cos|tan)×3/, l.id);
});

test('チーは上家の打牌だけ：下家・対面の同じ牌ではチーの選択肢がなく、上家ならできる（7-B）', () => {
  const p = createPractice(rules, L['4B']);
  for (const from of [1, 2]) {
    assert.ok(p.pause);
    assert.equal(p.last.seat, from);
    assert.equal(p.game.chiOptions(HUMAN, p.last.tile).length > 0, true, '形としては面子になる');
    assert.equal(pendingOf(p), null, '選択肢は出ない');
    practiceContinue(p);
  }
  const pd = pendingOf(p);
  assert.equal(pd.from, 3);
  assert.equal(pd.chi.length, 1);
});

test('役なしロンの禁止（7-D）とフリテン（6-A・6-B・8-A）は現行ルールのエンジンで判定', () => {
  // 7-D：鳴いた手で 120°（役なし）はロンの選択肢なし、60°（象限一色）はロン
  const d = createPractice(rules, L['4D']);
  practiceAct(d, { type: 'chi', option: 0 });
  sel(d, 'a:135'); practiceAct(d, { type: 'discard' });
  assert.match(d.pause, /役がない/);
  assert.equal(keyOf(d.game, d.last.tile), 'a:120');
  assert.ok(d.game.shapeWaits(HUMAN).includes(rules.typeByKey.get('a:120').idx), '形としては待ち');
  assert.equal(d.game.ronAnalysis(HUMAN, d.last.tile), null, '役がないので和了にならない');
  assert.equal(d.game.ronBlocked[HUMAN], null, '役なしはフリテンの見送りではない');
  practiceContinue(d);
  assert.equal(pendingOf(d).ron, true);
  // 8-A：リーチ後にロンを見送ると、その局はロンできない（下家の =−1 は宣言なし）。ツモはできる
  const e = createPractice(rules, L['6']);
  sel(e, 'a:90'); practiceAct(e, { type: 'discard', riichi: true });
  practiceAct(e, { type: 'pass' });
  assert.ok(e.game.riichiFuriten[HUMAN]);
  practiceSelect(e, e.game.drawn); practiceAct(e, { type: 'discard' });
  assert.equal(pendingOf(e).type, 'turn', '下家の =−1 ではロンの宣言がない');
  assert.ok(e.game.ronBlocked[HUMAN]);
  assert.equal(pendingOf(e).canTsumo, true);
});

test('リーチ宣言料5点：リーチして和了すると供託5点を出して取り戻す（8-A）。リーチの課題（4-A）は和了しないので精算なし', () => {
  const p = createPractice(rules, L['6']);
  SOLVE[6](p);
  const st = p.settlement;
  assert.deepEqual([st.riichi, st.potWon], [[HUMAN], 5]);
  assert.deepEqual(st.deltas, st.payments, '宣言料と供託の差し引き0');
  assert.match(practiceHTML(p), /リーチ宣言料：あなた 各−5点（供託へ）/);
  const r = createPractice(rules, L['5A']);
  SOLVE['5A'](r);
  assert.ok(r.game.riichi[HUMAN]);
  assert.equal(r.settlement, null);
  assert.match(L['5A'].lead, /宣言料5点/);
});

test('旧ルールの対局の再現URL（newrules なし・=1）は従来どおり受け付ける（互換を削除しない）', () => {
  const P = (q) => new URLSearchParams(q);
  assert.equal(validateReplay(P('seed=5&round=1&dealer=0&hand=0&renchan=0&len=4')).values.ruleset, 0);
  assert.equal(validateReplay(P('seed=5&round=1&dealer=0&hand=0&renchan=0&len=4&newrules=1')).values.ruleset, 1);
  const g0 = new Game({ rules, seed: 5, dealer: 0, players: [0, 1, 2, 3].map(() => ({ kind: 'ai' })), ruleset: 0 });
  assert.deepEqual([g0.ruleset, g0.funcPonBan, g0.furitenRule], [0, false, false]);
});
