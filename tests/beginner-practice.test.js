// 初心者の部屋の実戦形式の課題：実際の Game の固定局面・台本どおりの練習用CPU・進み具合の保存（版2・docs/67 の8段階）
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/engine/config.js';
import { createRules } from '../src/engine/rules.js';
import { settle } from '../src/engine/match.js';
import { OPPONENTS } from '../src/ui/opponents.js';
import { LESSONS, lessonById, createPractice, lessonWall, pendingOf, practiceAct, practiceSelect, practiceContinue, practiceHint, practiceHTML, HUMAN } from '../src/ui/beginner-practice.js';
import { PROGRESS_KEY, LEGACY_PROGRESS_KEY, freshProgress, parseProgress, loadProgress, saveProgress, isUnlocked, hasProgress, migrateLegacy, recordExam } from '../src/ui/beginner-progress.js';
import { createRoomState, enterStage, nextRoom, gotoStage, retryRoom, resumeRoom, restartRoom, roomPracticeAct, roomPracticeSelect, roomHTML, partsOf, checkRoom, pickRoomTile, ROOM_STAGES, stepOf, EXAM_OPPONENTS } from '../src/ui/beginner-room.js';

const rules = createRules(makeConfig({ mode: 'math1' }));
const L = Object.fromEntries(LESSONS.map((l) => [l.id, l]));
const keyOf = (g, id) => rules.types[g.typeOf(id)].key;
const handId = (p, k) => p.game.hands[HUMAN].find((id) => keyOf(p.game, id) === k);
function discard(p, k, riichi = false) {
  const id = handId(p, k);
  assert.ok(id !== undefined, `手牌に ${k} がない`);
  assert.equal(practiceSelect(p, id), true);
  return practiceAct(p, { type: 'discard', riichi });
}
// 牌の保存：全ての牌がちょうど1か所にあり、総数は数学Ⅰの124枚
function conserved(p) {
  const g = p.game;
  g.checkInvariants();
  const n = g.wall.length + (g.deadWall ? g.deadWall.allPhysical().length : 0) + g.hands.flat().length + g.rivers.flat().length + g.melds.flat().reduce((s, m) => s + m.tiles.length, 0); // 現行ルールの課題は王牌を含む
  assert.equal(n, rules.deckSize);
  assert.equal(rules.deckSize, 124);
}

test('全課題：数学Ⅰの実在する牌の固定の山・同じ局面を再現・牌の保存', () => {
  // docs/67：8段階・課題の並び（実戦形式の課題に D1・T1・F1・F2 を追加）
  assert.deepEqual(ROOM_STAGES.map((x) => x.steps.length), [2, 2, 2, 1, 2, 2, 4, 2]);
  assert.deepEqual(LESSONS.map((l) => l.id), ['D1', 'T1', '4A', '4B', '4C', '4D', '5A', '5B', '5C', 'F1', 'F2', '6']);
  for (const st of ROOM_STAGES) for (const step of st.steps) if (step.kind === 'practice') assert.ok(lessonById(step.lesson), step.lesson);
  for (const l of LESSONS) {
    const a = createPractice(rules, l);
    const b = createPractice(rules, l);
    assert.deepEqual(a.game.wall, b.game.wall, `${l.id}：山が固定`);
    assert.deepEqual(a.game.hands, b.game.hands);
    assert.equal(a.game.rules.config.mode, 'math1');
    assert.equal(a.game.players.filter((x) => x.kind === 'human').length, 1);
    assert.equal(lessonWall(l).length, 32 + l.draws.length);
    conserved(a);
    // 人名は名前欄で検査する。説明文の「〜したら」をキャラ名「たら」と誤認しない。
    const html = practiceHTML(a);
    assert.match(html, /練習用CPU/);
    const names = [...html.matchAll(/<div class="bp-name">([\s\S]*?)<\/div>/g)].map(m => m[1].replace(/<[^>]*>/g, ''));
    assert.equal(names.length, 4);
    assert.deepEqual(a.game.players.slice(1).map(p => p.name), ['練習用CPU', '練習用CPU', '練習用CPU']);
    for (const o of OPPONENTS) assert.ok(names.every(n => !n.includes(o.name)), `${l.id}：名前欄に ${o.name} を表示しない`);
  }
});

test('4-A：上家の =1/2 でチー（ボタンは実際の選択肢だけ）、見送るは練習では止める、チー後はツモなしで打牌', () => {
  const p = createPractice(rules, L['4A']);
  const pd = pendingOf(p);
  assert.equal(pd.type, 'claim');
  assert.equal(pd.from, 3, '上家の打牌');
  assert.equal(keyOf(p.game, pd.tile), 'v:1/2');
  assert.equal(pd.chi.length, 1);
  assert.equal(rules.melds[pd.chi[0].meld].key, 'sin30=1/2');
  assert.equal(pd.pon, null);
  assert.equal(pd.ron, false);
  let html = practiceHTML(p);
  assert.equal((html.match(/data-action="bp-chi"/g) || []).length, 1);
  assert.ok(!html.includes('data-action="bp-pon"') && !html.includes('data-action="bp-ron"'));
  // 見送る：実行しない（局面はそのまま）
  const before = p.game.events.length;
  assert.equal(practiceAct(p, { type: 'pass' }), false);
  assert.match(p.message, /チー/);
  assert.equal(p.game.events.length, before);
  // 画面にない宣言は受け付けない
  assert.equal(practiceAct(p, { type: 'pon' }), false);
  assert.equal(practiceAct(p, { type: 'chi', option: 1 }), false);
  assert.equal(practiceAct(p, { type: 'chi', option: 0 }), true);
  assert.equal(p.game.melds[HUMAN].length, 1);
  assert.equal(p.game.melds[HUMAN][0].call, 'chi');
  assert.equal(p.game.melds[HUMAN][0].from, 3);
  const t = pendingOf(p);
  assert.equal(t.type, 'turn');
  assert.equal(t.canTsumo, false);
  assert.equal(p.game.drawn, null, '鳴いた後はツモしない');
  assert.equal(p.game.hands[HUMAN].length, 6);
  assert.match(practiceHTML(p), /鳴いた後はツモをしないで/);
  conserved(p);
  assert.equal(discard(p, 'a:90'), true);
  assert.equal(p.done, true);
  assert.equal(p.game.hands[HUMAN].length, 5);
  conserved(p);
});

test('4-B：下家・対面の =1/2 ではチーの選択肢がない（エンジンが聞かない）、上家ならチーできる', () => {
  const p = createPractice(rules, L['4B']);
  assert.match(p.pause, /下家/);
  assert.equal(pendingOf(p), null);
  const ev = p.game.events.filter((e) => e.type === 'discard');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].seat, 1);
  assert.equal(keyOf(p.game, ev[0].tile), 'v:1/2');
  // あなた（席0）は宣言の待ち行列にいない
  assert.ok(!(p.game.claim && p.game.claim.queue.some((q) => q.seat === HUMAN)));
  assert.ok(!practiceHTML(p).includes('data-action="bp-chi"'), '偽のチーボタンを出さない');
  assert.match(practiceHTML(p), /data-action="bp-continue"/);
  assert.equal(practiceAct(p, { type: 'chi', option: 0 }), false);
  practiceContinue(p);
  assert.match(p.pause, /対面/);
  assert.ok(!(p.game.claim && p.game.claim.queue.some((q) => q.seat === HUMAN)));
  assert.ok(!practiceHTML(p).includes('data-action="bp-chi"'));
  practiceContinue(p);
  const pd = pendingOf(p);
  assert.equal(pd.type, 'claim');
  assert.equal(pd.from, 3);
  assert.equal(pd.chi.length, 1);
  practiceAct(p, { type: 'chi', option: 0 });
  discard(p, 'a:90');
  assert.equal(p.done, true);
  conserved(p);
});

test('4-C：現行ルールの対面45°でポン（関数牌禁止）、刻子を公開して打牌', () => {
  const p = createPractice(rules, L['4C']);
  assert.equal(p.game.ruleset, 2, '通常対局と同じ関数牌ポン禁止ルール');
  const pd = pendingOf(p);
  assert.equal(pd.from, 2);
  assert.ok(pd.pon);
  assert.equal(pd.chi.length, 0, '対面からはチーできない');
  assert.equal(practiceAct(p, { type: 'pass' }), false);
  assert.equal(practiceAct(p, { type: 'pon' }), true);
  const m = p.game.melds[HUMAN][0];
  assert.equal(m.call, 'pon');
  assert.equal(m.kind, 'koutsu');
  assert.ok(m.tiles.every((id) => keyOf(p.game, id) === 'a:45'));
  assert.equal(p.game.drawn, null);
  discard(p, 'a:90');
  assert.equal(p.done, true);
  conserved(p);
});

test('4-C：教材で関数牌のポンを許可しない。説明も現行ルールに一致', () => {
  const p = createPractice(rules, L['4C']);
  assert.equal(p.game.ruleset, 2);
  assert.match(L['4C'].lead, /関数牌はポンできない/);
  assert.ok(!L['4C'].hand.filter((x) => x === 'sin').length || L['4C'].hand.filter((x) => x === 'sin').length < 2);
  assert.equal(keyOf(p.game, pendingOf(p).tile), 'a:45');
});

test('4-D：鳴いた手は役が必要（形が完成しても役なしならロンの選択肢が出ない）、役があればロン', () => {
  const p = createPractice(rules, L['4D']);
  practiceAct(p, { type: 'chi', option: 0 });
  // 練習の流れに合わない打牌は止める
  assert.equal(discard(p, 'f:tan'), false);
  assert.match(p.message, /135/);
  assert.equal(p.game.hands[HUMAN].length, 6);
  assert.equal(discard(p, 'a:135'), true);
  assert.match(p.pause, /役がない/);
  const g = p.game;
  const t120 = g.events.filter((e) => e.type === 'discard').at(-1).tile;
  assert.equal(keyOf(g, t120), 'a:120');
  // 形（数式面子2組）は完成するが、鳴いた手で役がないので和了にならない
  const counts = g.countsOf([...g.hands[HUMAN], t120]);
  assert.ok(rules.decompose(counts, 2).length > 0, '形は完成');
  assert.equal(g.ronAnalysis(HUMAN, t120), null, '役なし→ロン不可');
  assert.ok(!(g.claim && g.claim.queue.some((q) => q.seat === HUMAN)));
  assert.equal(g.maxCalls, 2, 'チー・ポンは合計2回まで');
  practiceContinue(p);
  const pd = pendingOf(p);
  assert.equal(pd.ron, true);
  assert.equal(pd.from, 2);
  assert.equal(practiceAct(p, { type: 'pass' }), false);
  practiceAct(p, { type: 'ron' });
  assert.equal(p.done, true);
  const r = g.result;
  assert.equal(r.how, 'ron');
  assert.ok(r.analysis.yaku.some((y) => y.id === 'shougen'));
  assert.equal(r.analysis.closed, false);
  assert.deepEqual(p.settlement.deltas, settle(r, g.dealer));
  assert.equal(p.settlement.scores.reduce((a, b) => a + b, 0), 400);
  assert.match(practiceHTML(p), /ロン ＞ ポン ＞ チー/);
  conserved(p);
});

test('5-A：聴牌になる牌でリーチ、リーチ後はツモ切りだけ（画面とエンジンの両方）', () => {
  const p = createPractice(rules, L['5A']);
  const g = p.game;
  assert.equal(pendingOf(p).type, 'turn');
  // リーチしない打牌は練習では止める
  assert.equal(discard(p, 'v:-1'), false);
  assert.match(p.message, /リーチ/);
  // 聴牌にならない牌ではリーチできない（エンジンの riichiOptions）
  assert.equal(discard(p, 'f:sin', true), false);
  assert.match(p.message, /聴牌/);
  assert.equal(g.riichi[HUMAN], null);
  assert.equal(discard(p, 'v:-1', true), true);
  assert.ok(g.riichi[HUMAN]);
  assert.deepEqual(g.waitsOf(g.countsOf(g.hands[HUMAN].filter((id) => id !== g.drawn))).map((t) => rules.types[t].key), ['v:1'], '=1 待ち');
  // 次のツモ：ツモした牌以外は選べない
  const pd = pendingOf(p);
  assert.equal(pd.type, 'turn');
  const other = g.hands[HUMAN].find((id) => id !== g.drawn);
  assert.equal(practiceSelect(p, other), false);
  assert.match(p.message, /ツモした牌/);
  assert.match(practiceHTML(p), /class="br-pick bp-tile[^"]*locked"/);
  assert.equal(practiceSelect(p, g.drawn), true);
  assert.equal(practiceAct(p, { type: 'discard' }), true);
  assert.equal(p.done, true);
  assert.equal(g.rivers[HUMAN].at(-1).tsumogiri, true);
  conserved(p);
});

test('5-A：エンジン自体がリーチ後のツモ切り以外を拒否する', () => {
  const p = createPractice(rules, L['5A']);
  discard(p, 'v:-1', true);
  const g = p.game;
  const other = g.hands[HUMAN].find((id) => id !== g.drawn);
  assert.throws(() => g.discard(HUMAN, other), /tsumogiri only/);
  assert.throws(() => g.respond(HUMAN, { type: 'chi', option: 0 }));
});

test('5-B：ロン（エンジンの和了判定と精算）', () => {
  const p = createPractice(rules, L['5B']);
  const pd = pendingOf(p);
  assert.equal(pd.ron, true);
  assert.equal(pd.from, 1);
  assert.equal(keyOf(p.game, pd.tile), 'v:1');
  assert.ok(p.game.ronAnalysis(HUMAN, pd.tile));
  assert.equal(practiceAct(p, { type: 'pass' }), false);
  assert.equal(practiceAct(p, { type: 'ron' }), true);
  const r = p.game.result;
  assert.equal(r.how, 'ron');
  assert.equal(r.from, 1);
  assert.equal(r.points, 2);
  assert.deepEqual(p.settlement.deltas, [8, -8, 0, 0]);
  assert.match(practiceHTML(p), /ロン和了/);
  conserved(p);
});

test('5-C：ツモ（引いた牌で和了）。捨てる操作は練習では止める', () => {
  const p = createPractice(rules, L['5C']);
  const pd = pendingOf(p);
  assert.equal(pd.type, 'turn');
  assert.equal(pd.canTsumo, true);
  assert.equal(keyOf(p.game, p.game.drawn), 'v:1');
  assert.match(practiceHTML(p), /data-action="bp-tsumo"/);
  assert.equal(discard(p, 'v:1'), false);
  assert.match(p.message, /ツモ/);
  assert.equal(practiceAct(p, { type: 'tsumo' }), true);
  const r = p.game.result;
  assert.equal(r.how, 'tsumo');
  assert.equal(r.points, 2);
  assert.deepEqual(p.settlement.deltas, [8, -2, -2, -4], '子ツモ：親（席3）が4点、ほかの子2人が2点ずつ支払う');
  assert.deepEqual(p.settlement.deltas, settle(r, p.game.dealer));
  assert.equal(p.settlement.deltas.reduce((a, b) => a + b, 0), 0);
  assert.equal(p.settlement.scores.reduce((a, b) => a + b, 0), 400);
  conserved(p);
});

test('5-C：ツモ可能ならツモだけを案内し、どの牌を選んでもリーチ・打牌を表示しない', () => {
  const p = createPractice(rules, L['5C']);
  const g = p.game;
  const before = g.events.length;
  assert.ok(g.riichiOptions(HUMAN).length > 0, 'エンジンの合法手は残し、教材側だけで表示を絞る');
  const checkActions = () => {
    const html = practiceHTML(p);
    assert.match(html, /ツモで和了しよう/);
    assert.match(html, /class="primary bp-decl" data-action="bp-tsumo"/);
    assert.ok(!html.includes('data-action="bp-riichi"'));
    assert.ok(!html.includes('data-action="bp-discard"'));
    assert.ok(!html.includes('捨てる牌を選ぼう'));
  };
  checkActions();
  for (const id of g.hands[HUMAN]) {
    assert.equal(practiceSelect(p, id), true);
    checkActions();
  }
  assert.equal(practiceAct(p, { type: 'discard', riichi: true }), false, '表示外からの操作も従来どおり拒否');
  assert.equal(g.events.length, before);
  assert.equal(g.riichi[HUMAN], null);
  assert.equal(practiceAct(p, { type: 'tsumo' }), true);
  assert.equal(p.done, true);
  conserved(p);
});

test('5-Cの表示制限は教材内だけ：通常のエンジン操作ではツモを見送り打牌・リーチできる', () => {
  for (const riichi of [false, true]) {
    const g = createPractice(rules, L['5C']).game;
    const id = g.drawn;
    assert.ok(g.tsumoAnalysis(HUMAN));
    assert.ok(g.riichiOptions(HUMAN).some((o) => o.type === g.typeOf(id)));
    g.discard(HUMAN, id, { riichi });
    assert.equal(g.rivers[HUMAN].at(-1).id, id);
    assert.equal(!!g.riichi[HUMAN], riichi);
    assert.ok(!g.hands[HUMAN].includes(id));
    g.checkInvariants();
  }
});

test('ロンとツモの違い：ロン以外の課題でロンボタンを出さない・ツモの課題でロンボタンを出さない', () => {
  const p = createPractice(rules, L['5C']);
  assert.ok(!practiceHTML(p).includes('bp-ron'));
  const q = createPractice(rules, L['5B']);
  assert.ok(!practiceHTML(q).includes('bp-tsumo'));
});

test('卒業試験：リーチ→ロンで1局が終わり、試合の精算（合計400点）', () => {
  const p = createPractice(rules, L['6']);
  const g = p.game;
  assert.equal(g.dealer, HUMAN);
  assert.match(practiceHint(p), /90° を捨てると =−1 待ち/);
  discard(p, 'a:90', true);
  assert.equal(p.warn, '');
  const pd = pendingOf(p);
  assert.equal(pd.ron, true);
  practiceAct(p, { type: 'ron' });
  assert.equal(p.done, true);
  assert.equal(g.result.how, 'ron');
  assert.ok(g.result.analysis.riichi);
  assert.equal(p.settlement.scores.reduce((a, b) => a + b, 0), 400);
  assert.deepEqual(p.settlement.deltas, settle(g.result, g.dealer));
  conserved(p);
});

test('卒業試験：自由に打てる。誤りはヒントで知らせ、和了のチャンスは4回ある', () => {
  // 聴牌をくずす打牌
  let p = createPractice(rules, L['6']);
  discard(p, 'a:135');
  assert.match(p.warn, /聴牌/);
  conserved(p);
  // リーチしない聴牌
  p = createPractice(rules, L['6']);
  discard(p, 'a:90');
  assert.match(p.warn, /リーチはしなかった/);
  // ロンを見送る→ツモのチャンス→見送る→ロンのチャンス→見送る→ツモのチャンス
  p = createPractice(rules, L['6']);
  discard(p, 'a:90', true);
  const chances = [];
  for (let i = 0; i < 4; i++) {
    const pd = pendingOf(p);
    if (pd.type === 'claim') {
      assert.equal(pd.ron, true);
      chances.push('ron');
      if (i < 3) { practiceAct(p, { type: 'pass' }); assert.match(p.warn, /見送った/); }
    } else {
      assert.equal(pd.canTsumo, true);
      chances.push('tsumo');
      if (i < 3) { practiceSelect(p, p.game.drawn); practiceAct(p, { type: 'discard' }); assert.match(p.warn, /ツモで和了できた/); }
    }
    conserved(p);
  }
  assert.deepEqual(chances, ['ron', 'tsumo', 'ron', 'tsumo']);
  practiceAct(p, { type: 'tsumo' });
  assert.equal(p.done, true);
  assert.equal(p.game.result.how, 'tsumo');
  assert.equal(p.settlement.scores.reduce((a, b) => a + b, 0), 400);
});

test('卒業試験：最後まで和了しなくても流局で終わり、やり直しを案内する（CPUは和了しない）', () => {
  const p = createPractice(rules, L['6']);
  for (let guard = 0; guard < 500 && !p.game.result; guard++) {
    const pd = pendingOf(p);
    if (!pd) { practiceContinue(p); continue; }
    if (pd.type === 'claim') practiceAct(p, { type: 'pass' });
    else { practiceSelect(p, p.game.drawn ?? p.game.hands[HUMAN][0]); practiceAct(p, { type: 'discard' }); }
  }
  assert.equal(p.game.result.type, 'draw');
  assert.equal(p.done, false);
  assert.match(p.warn, /流局/);
  conserved(p);
});


// ---- docs/67：新しい課題（実際のエンジン・ruleset 2） ----
test('2-B 捨てる牌を選ぶ：完成面子・あと1枚の組をくずす牌は止め、理由を出す。使い道のない牌で完了', () => {
  const p = createPractice(rules, L.D1);
  assert.equal(p.game.ruleset, 2);
  for (const [k, re] of [['a:30', /完成している/], ['f:cos', /あと1枚/]]) {
    assert.equal(discard(p, k), false);
    assert.match(p.message, re);
  }
  assert.equal(discard(p, 'a:135'), true);
  assert.equal(p.done, true);
  conserved(p);
});

test('3-A 聴牌：牌を選ぶとその牌を捨てた後の待ちを表示（エンジンの待ちと一致）、聴牌にならない牌は止める', () => {
  const p = createPractice(rules, L.T1);
  const g = p.game;
  // 選択前は待ちの表示なし。135° を選ぶと =1 待ち、45° を選ぶと =−1 待ち
  assert.doesNotMatch(practiceHTML(p), /bp-waits/);
  practiceSelect(p, handId(p, 'a:135'));
  assert.match(practiceHTML(p), /この牌を捨てると待ち/);
  practiceSelect(p, handId(p, 'f:tan'));
  assert.match(practiceHTML(p), /聴牌にならない/);
  assert.equal(practiceAct(p, { type: 'discard' }), false);
  assert.match(p.message, /聴牌にならない/);
  for (const [k, w] of [['a:135', 'v:1'], ['a:45', 'v:-1']]) {
    const q = createPractice(rules, L.T1);
    assert.equal(discard(q, k), true);
    assert.equal(q.done, true);
    assert.deepEqual(q.game.shapeWaits(HUMAN).map((t) => rules.types[t].key), [w]);
    assert.match(practiceHTML(q), /聴牌 待ち/);
  }
  conserved(p);
});

test('4-A リーチ：ボタンの強調・金の印（聴牌になる牌だけ）・宣言前の待ちの確認・宣言料5点の表示', () => {
  const p = createPractice(rules, L['5A']);
  const g = p.game;
  const html = practiceHTML(p);
  const marked = [...html.matchAll(/class="br-pick bp-tile[^"]*riichi-cand[^"]*" type="button" data-action="bp-tile" data-id="(\d+)"/g)].map((m) => keyOf(g, Number(m[1])));
  assert.deepEqual([...new Set(marked)], g.riichiOptions(HUMAN).map((o) => rules.types[o.type].key), '印はエンジンのリーチの選択肢と一致');
  assert.match(html, /riichi-ready" data-action="bp-riichi" disabled>リーチして捨てる<small>宣言料5点<\/small>/);
  assert.match(html, /リーチできるよ/);
  practiceSelect(p, handId(p, 'v:-1'));
  const h2 = practiceHTML(p);
  assert.match(h2, /この牌を捨てると待ち/);
  assert.match(h2, /data-action="bp-riichi">リーチして捨てる/, '聴牌になる牌を選ぶと押せる');
  assert.match(L['5A'].lead, /宣言料5点/);
});

test('6-A 捨て牌のフリテン：待ちの 30° を先に捨てた → 150° でロンできない（理由の表示）→ 30° のツモで和了', () => {
  const p = createPractice(rules, L.F1);
  const g = p.game;
  assert.equal(discard(p, 'a:135'), false, 'まず 30°');
  assert.equal(discard(p, 'a:30'), true);
  assert.equal(discard(p, 'a:135'), true);
  assert.deepEqual(g.shapeWaits(HUMAN).map((t) => rules.types[t].key), ['a:30', 'a:150']);
  assert.match(p.pause, /フリテン/);
  assert.equal(g.ronBlocked[HUMAN] !== null, true, '150° はフリテンでロンできなかった');
  assert.match(practiceHTML(p), /フリテン<\/b>ロン不可：自分の捨て牌に待ちがある/);
  practiceContinue(p);
  const pd = pendingOf(p);
  assert.equal(pd.canTsumo, true);
  assert.equal(discard(p, 'a:30'), false);
  assert.match(p.message, /ツモ/);
  assert.equal(practiceAct(p, { type: 'tsumo' }), true);
  assert.equal(p.done, true);
  conserved(p);
});

test('6-B 見逃しのフリテン：30° を見送る → 150° でロンなし（同巡）→ 自分のツモで解除 → 30° でロン', () => {
  const p = createPractice(rules, L.F2);
  let pd = pendingOf(p);
  assert.deepEqual([pd.type, pd.ron], ['claim', true]);
  assert.equal(practiceAct(p, { type: 'ron' }), false, 'まずは見送る');
  assert.equal(practiceAct(p, { type: 'pass' }), true);
  assert.match(p.pause, /次のツモまで/);
  assert.match(practiceHTML(p), /見逃した/);
  practiceContinue(p);
  pd = pendingOf(p);
  assert.equal(pd.type, 'turn');
  assert.equal(discard(p, 'f:sin'), false, '聴牌をくずさない');
  assert.equal(practiceSelect(p, p.game.drawn), true);
  assert.equal(practiceAct(p, { type: 'discard' }), true);
  pd = pendingOf(p);
  assert.deepEqual([pd.type, pd.ron], ['claim', true]);
  assert.equal(p.game.furitenOf(HUMAN).furiten, false, '自分のツモで解除');
  assert.equal(practiceAct(p, { type: 'ron' }), true);
  assert.equal(p.done, true);
  conserved(p);
});

test('待ちの表示は公開情報と自分の手牌だけ：練習用CPUの手牌・山を入れ替えても同じ', () => {
  for (const id of ['T1', '5A', 'F1', 'F2']) {
    const p = createPractice(rules, L[id]);
    if (pendingOf(p) && pendingOf(p).type === 'turn') practiceSelect(p, p.game.hands[HUMAN][0]);
    const before = practiceHTML(p).match(/<div class="bp-info"[\s\S]*?<\/div>/);
    const g = p.game;
    const t = g.hands[1][0]; g.hands[1][0] = g.wall[0]; g.wall[0] = t;
    const after = practiceHTML(p).match(/<div class="bp-info"[\s\S]*?<\/div>/);
    assert.deepEqual(after && after[0], before && before[0], id);
  }
});

test('進み具合（版2）：専用キー・壊れた値は初期化・保存できない環境でも動く・版1のキーは消さない', () => {
  assert.equal(PROGRESS_KEY, 'mj-beginner-room-v2');
  assert.equal(LEGACY_PROGRESS_KEY, 'mj-beginner-room-v1');
  const fresh = freshProgress();
  assert.deepEqual(parseProgress(null, partsOf), fresh);
  assert.deepEqual(parseProgress('{bad', partsOf), fresh);
  assert.deepEqual(parseProgress(JSON.stringify({ v: 2, cleared: [true] }), partsOf), fresh);
  const p = parseProgress(JSON.stringify({ v: 2, cleared: [true, false, false, false, false, false, false, false], resume: { stage: 5, part: 1 } }), partsOf);
  assert.deepEqual(p.resume, { stage: 0, part: 0 }, 'まだ開いていない段階の続きは無効');
  const r = parseProgress(JSON.stringify({ v: 2, cleared: [true, true, false, false, false, false, false, false], resume: { stage: 2, part: 9 } }), partsOf);
  assert.deepEqual(r.resume, { stage: 2, part: 0 }, '課題番号の範囲外は0');
  assert.equal(isUnlocked(r, 2), true);
  assert.equal(isUnlocked(r, 3), false);
  assert.equal(hasProgress(fresh), false);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(loadProgress(broken, partsOf), fresh);
  assert.equal(saveProgress(broken, r), false);
  // 版2のキーだけを書く（版1・通常対局のキーはそのまま）
  const v1 = JSON.stringify({ v: 1, cleared: [true, true, true, false, false, false], resume: { stage: 3, part: 2 } });
  const mem = new Map([['mj-mode', 'math2'], ['mj-length', '8'], ['mj-beginner-room-v1', v1]]);
  const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  const loaded = loadProgress(st, partsOf);
  assert.equal(loaded.migratedFrom, 1);
  assert.equal(saveProgress(st, loaded), true);
  assert.deepEqual([...mem.keys()].sort(), ['mj-beginner-room-v1', 'mj-beginner-room-v2', 'mj-length', 'mj-mode']);
  assert.equal(mem.get('mj-beginner-room-v1'), v1, '版1の値は書き換えない');
  assert.deepEqual(loadProgress(st, partsOf), loaded, '次からは版2を読む');
});

test('版1からの引き継ぎ：クリアした内容を新しい段階へ対応づけ、続きの位置も移す。修了者は全段階を受け直せる', () => {
  const mig = (cleared, resume = { stage: 0, part: 0 }) => migrateLegacy(JSON.stringify({ v: 1, cleared, resume }), partsOf);
  // 旧1〜3（数式・面子・打牌）→ 新1・2、旧4（鳴き）途中
  let p = mig([true, true, true, false, false, false], { stage: 3, part: 2 });
  assert.deepEqual(p.cleared, [true, true, false, false, false, false, false, false]);
  assert.deepEqual(p.resume, { stage: 0, part: 0 }, '鳴き（新7）はまだ開いていないので続きは最初から');
  // 旧1〜5（リーチ・ロン・ツモまで）→ 新1〜5・7。新6（フリテン）が次
  p = mig([true, true, true, true, true, false], { stage: 4, part: 2 });
  assert.deepEqual(p.cleared, [true, true, true, true, true, false, true, false]);
  assert.deepEqual(p.resume, { stage: 4, part: 1 }, '旧5-C（ツモ）→ 新5の2つ目');
  assert.equal(isUnlocked(p, 5), true);
  assert.equal(isUnlocked(p, 7), false);
  // 修了者：卒業済み・全段階を選べる（新しいフリテンも受けられる）
  p = mig([true, true, true, true, true, true], { stage: 5, part: 0 });
  assert.deepEqual([p.graduated, p.cleared[7], p.cleared[5]], [true, true, false]);
  for (let st = 0; st < 8; st++) assert.equal(isUnlocked(p, st), true);
  // 壊れた版1は引き継がない
  assert.equal(migrateLegacy('{x', partsOf), null);
  assert.equal(migrateLegacy(JSON.stringify({ v: 1, cleared: [true] }), partsOf), null);
});

test('卒業試験の記録：最後まで打てば修了（順位に関係なく）、1位の回数・最高順位', () => {
  const p = freshProgress();
  recordExam(p, 3, 'math1');
  assert.deepEqual([p.graduated, p.cleared[7], p.exam.plays, p.exam.firsts, p.exam.best, p.exam.lastMode], [true, true, 1, 0, 3, 'math1']);
  recordExam(p, 1, 'math2');
  assert.deepEqual([p.exam.plays, p.exam.firsts, p.exam.best, p.exam.lastRank], [2, 1, 1, 1]);
  const back = parseProgress(JSON.stringify({ v: 2, cleared: p.cleared, resume: p.resume, graduated: true, exam: p.exam }), partsOf);
  assert.deepEqual(back.exam, p.exam);
  assert.deepEqual(EXAM_OPPONENTS, ['kanata', 'mitsuki', 'aoto']);
});

test('部屋の流れ：第1段階から卒業試験まで続けて進み、クリアと続きを記録する', () => {
  const s = createRoomState();
  enterStage(s, rules, 0);
  const pick = (xs) => xs.forEach((i) => pickRoomTile(s, rules, i));
  function sel(k) { assert.equal(roomPracticeSelect(s, handId(s.practice, k)), true); }
  const solve = {
    'bank:0': () => { pick([3, 4, 1]); checkRoom(s, rules); },
    'bank:1': () => { for (const g of [[3, 5, 2], [0, 8, 7], [6, 1, 4]]) { pick(g); checkRoom(s, rules); } },
    'bank:2': () => { pick([5]); checkRoom(s, rules); },
    D1: () => { sel('a:135'); roomPracticeAct(s, { type: 'discard' }); },
    T1: () => { sel('a:135'); roomPracticeAct(s, { type: 'discard' }); },
    'quiz:0': () => { pick([1]); assert.equal(checkRoom(s, rules), false); assert.match(s.message, /あと1種類/); pick([7]); checkRoom(s, rules); },
    '5A': () => { sel('v:-1'); roomPracticeAct(s, { type: 'discard', riichi: true }); roomPracticeSelect(s, s.practice.game.drawn); roomPracticeAct(s, { type: 'discard' }); },
    '5B': () => roomPracticeAct(s, { type: 'ron' }),
    '5C': () => roomPracticeAct(s, { type: 'tsumo' }),
    F1: () => { sel('a:30'); roomPracticeAct(s, { type: 'discard' }); sel('a:135'); roomPracticeAct(s, { type: 'discard' }); practiceContinue(s.practice); roomPracticeAct(s, { type: 'tsumo' }); },
    F2: () => { roomPracticeAct(s, { type: 'pass' }); practiceContinue(s.practice); roomPracticeSelect(s, s.practice.game.drawn); roomPracticeAct(s, { type: 'discard' }); roomPracticeAct(s, { type: 'ron' }); },
    '4A': () => { roomPracticeAct(s, { type: 'chi', option: 0 }); sel('a:90'); roomPracticeAct(s, { type: 'discard' }); },
    '4B': () => { practiceContinue(s.practice); practiceContinue(s.practice); roomPracticeAct(s, { type: 'chi', option: 0 }); sel('a:90'); roomPracticeAct(s, { type: 'discard' }); },
    '4C': () => { roomPracticeAct(s, { type: 'pon' }); sel('a:90'); roomPracticeAct(s, { type: 'discard' }); },
    '4D': () => { roomPracticeAct(s, { type: 'chi', option: 0 }); sel('a:135'); roomPracticeAct(s, { type: 'discard' }); practiceContinue(s.practice); roomPracticeAct(s, { type: 'ron' }); },
    6: () => { sel('a:90'); roomPracticeAct(s, { type: 'discard', riichi: true }); roomPracticeAct(s, { type: 'ron' }); },
  };
  const seen = [];
  for (;;) {
    const step = s.step;
    const id = step.kind === 'practice' ? step.lesson : step.kind === 'bank' ? `bank:${step.bank}` : step.kind === 'quiz' ? `quiz:${step.quiz}` : 'exam';
    seen.push(id);
    if (id === 'exam') break;
    solve[id]();
    assert.equal(s.done, true, `${id} 完了`);
    if (s.practice) conserved(s.practice);
    if (s.part === partsOf(s.stage) - 1) assert.equal(s.progress.cleared[s.stage], true, `第${s.stage + 1}段階クリア`);
    else assert.equal(s.progress.cleared[s.stage], false, '途中の課題ではまだクリアにしない');
    assert.equal(nextRoom(s, rules), true);
    assert.deepEqual(s.progress.resume, { stage: s.stage, part: s.part });
  }
  assert.deepEqual(seen, ['bank:0', 'bank:1', 'bank:2', 'D1', 'T1', 'quiz:0', '5A', '5B', '5C', 'F1', 'F2', '4A', '4B', '4C', '4D', '6', 'exam']);
  assert.deepEqual(s.progress.cleared, [true, true, true, true, true, true, true, false], '卒業試験は1局戦を打つまでクリアにしない');
  const html = roomHTML(s, rules);
  assert.match(html, /data-action="br-exam" data-mode="math1">数学Ⅰで受ける/);
  assert.match(html, /data-action="br-exam" data-mode="math2">数学Ⅱで受ける/);
  assert.equal(nextRoom(s, rules), false);
  // 受け直し：記録は残したまま最初から
  recordExam(s.progress, 2, 'math1');
  restartRoom(s, rules);
  assert.deepEqual([s.stage, s.part, s.progress.graduated, s.progress.cleared.every(Boolean)], [0, 0, true, true]);
});

test('部屋の一覧：開いていない段階は選べない・クリアした段階はもう一度遊べる・途中から再開・修了者の受け直し', () => {
  const s = createRoomState(parseProgress(JSON.stringify({ v: 2, cleared: [true, true, true, false, false, false, false, false], resume: { stage: 3, part: 0 } }), partsOf));
  assert.equal(gotoStage(s, rules, 5), false);
  assert.equal(gotoStage(s, rules, 4), false);
  s.view = 'list';
  let html = roomHTML(s, rules);
  assert.match(html, /data-stage="4" disabled/);
  assert.match(html, /data-action="br-restart">最初から受け直す/);
  resumeRoom(s, rules);
  assert.deepEqual([s.stage, s.part, s.practice.lessonId], [3, 0, '5A']);
  assert.equal(gotoStage(s, rules, 0), true);
  assert.equal(s.practice, null);
  // 修了者（版1から）：すべての段階を選べる
  const g = createRoomState(migrateLegacy(JSON.stringify({ v: 1, cleared: [true, true, true, true, true, true], resume: { stage: 5, part: 0 } }), partsOf));
  g.view = 'list';
  html = roomHTML(g, rules);
  assert.doesNotMatch(html, /disabled/);
  assert.match(html, /修了済み/);
  assert.match(html, /引き継ぎました/);
  assert.equal(gotoStage(g, rules, 5), true);
  assert.equal(g.practice.lessonId, 'F1');
});
