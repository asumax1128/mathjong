// 初心者の部屋 第4〜6段階：実際の Game の固定局面・台本どおりの練習用CPU・進み具合の保存
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/engine/config.js';
import { createRules } from '../src/engine/rules.js';
import { settle } from '../src/engine/match.js';
import { OPPONENTS } from '../src/ui/opponents.js';
import { LESSONS, STAGE_PARTS, createPractice, lessonWall, pendingOf, practiceAct, practiceSelect, practiceContinue, practiceHint, practiceHTML, HUMAN } from '../src/ui/beginner-practice.js';
import { PROGRESS_KEY, freshProgress, parseProgress, loadProgress, saveProgress, isUnlocked, hasProgress } from '../src/ui/beginner-progress.js';
import { createRoomState, enterStage, nextRoom, gotoStage, retryRoom, resumeRoom, roomPracticeAct, roomPracticeSelect, roomHTML, partsOf, checkRoom, pickRoomTile } from '../src/ui/beginner-room.js';

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
  const n = g.wall.length + g.hands.flat().length + g.rivers.flat().length + g.melds.flat().reduce((s, m) => s + m.tiles.length, 0);
  assert.equal(n, rules.deckSize);
  assert.equal(rules.deckSize, 124);
}

test('全課題：数学Ⅰの実在する牌の固定の山・同じ局面を再現・牌の保存', () => {
  assert.deepEqual(STAGE_PARTS, [0, 0, 0, 4, 3, 1]);
  assert.deepEqual(LESSONS.map((l) => l.id), ['4A', '4B', '4C', '4D', '5A', '5B', '5C', '6']);
  for (const l of LESSONS) {
    const a = createPractice(rules, l);
    const b = createPractice(rules, l);
    assert.deepEqual(a.game.wall, b.game.wall, `${l.id}：山が固定`);
    assert.deepEqual(a.game.hands, b.game.hands);
    assert.equal(a.game.rules.config.mode, 'math1');
    assert.equal(a.game.players.filter((x) => x.kind === 'human').length, 1);
    assert.equal(lessonWall(l).length, 32 + l.draws.length);
    conserved(a);
    // 9人のキャラクター名を使わない（練習用CPU）
    const html = practiceHTML(a);
    assert.match(html, /練習用CPU/);
    for (const o of OPPONENTS) assert.ok(!html.includes(o.name), `${l.id}：${o.name} を表示しない`);
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

test('4-C：対面の sin でポン（上家以外からも可）、刻子を公開して打牌', () => {
  const p = createPractice(rules, L['4C']);
  const pd = pendingOf(p);
  assert.equal(pd.from, 2);
  assert.ok(pd.pon);
  assert.equal(pd.chi.length, 0, '対面からはチーできない');
  assert.equal(practiceAct(p, { type: 'pass' }), false);
  assert.equal(practiceAct(p, { type: 'pon' }), true);
  const m = p.game.melds[HUMAN][0];
  assert.equal(m.call, 'pon');
  assert.equal(m.kind, 'koutsu');
  assert.ok(m.tiles.every((id) => keyOf(p.game, id) === 'f:sin'));
  assert.equal(p.game.drawn, null);
  discard(p, 'a:90');
  assert.equal(p.done, true);
  conserved(p);
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
  assert.ok(r.analysis.yaku.some((y) => y.id === 'shougen1'));
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
  assert.deepEqual(p.settlement.deltas, settle(r, p.game.dealer));
  assert.equal(p.settlement.deltas.reduce((a, b) => a + b, 0), 0);
  conserved(p);
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

test('進み具合：版つきの専用キー・壊れた値は初期化・保存できない環境でも動く', () => {
  assert.equal(PROGRESS_KEY, 'mj-beginner-room-v1');
  const fresh = freshProgress();
  assert.deepEqual(parseProgress(null, partsOf), fresh);
  assert.deepEqual(parseProgress('{bad', partsOf), fresh);
  assert.deepEqual(parseProgress(JSON.stringify({ v: 2, cleared: [true, true, true, true, true, true] }), partsOf), fresh);
  assert.deepEqual(parseProgress(JSON.stringify({ v: 1, cleared: [true] }), partsOf), fresh);
  // まだ開いていない段階の続きは無効
  const p = parseProgress(JSON.stringify({ v: 1, cleared: [true, false, false, false, false, false], resume: { stage: 4, part: 1 } }), partsOf);
  assert.deepEqual(p.resume, { stage: 0, part: 0 });
  const q = parseProgress(JSON.stringify({ v: 1, cleared: [true, true, true, false, false, false], resume: { stage: 3, part: 9 } }), partsOf);
  assert.deepEqual(q.resume, { stage: 3, part: 0 }, '課題番号の範囲外は0');
  const r = parseProgress(JSON.stringify({ v: 1, cleared: [true, true, true, false, false, false], resume: { stage: 3, part: 2 } }), partsOf);
  assert.deepEqual(r.resume, { stage: 3, part: 2 });
  assert.equal(isUnlocked(r, 3), true);
  assert.equal(isUnlocked(r, 4), false);
  assert.equal(hasProgress(fresh), false);
  assert.equal(hasProgress(r), true);
  // 保存できない（例外）
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(loadProgress(broken, partsOf), fresh);
  assert.equal(saveProgress(broken, r), false);
  assert.equal(saveProgress(null, r), false);
  assert.deepEqual(loadProgress(null, partsOf), fresh);
  // 専用キーだけを書く
  const mem = new Map([['mj-mode', 'math2'], ['mj-length', '8']]);
  const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  assert.equal(saveProgress(st, r), true);
  assert.deepEqual([...mem.keys()].sort(), ['mj-beginner-room-v1', 'mj-length', 'mj-mode']);
  assert.equal(mem.get('mj-mode'), 'math2');
  assert.deepEqual(loadProgress(st, partsOf), r);
});

test('部屋の流れ：第1段階から卒業試験まで続けて進み、クリアと続きを記録する', () => {
  const s = createRoomState();
  enterStage(s, rules, 0);
  const pick = (xs) => xs.forEach((i) => pickRoomTile(s, rules, i));
  pick([3, 4, 1]); checkRoom(s, rules);
  assert.equal(s.progress.cleared[0], true);
  nextRoom(s, rules);
  for (const g of [[3, 5, 2], [0, 8, 7], [6, 1, 4]]) { pick(g); checkRoom(s, rules); }
  nextRoom(s, rules);
  pick([5]); checkRoom(s, rules);
  nextRoom(s, rules);
  assert.deepEqual([s.stage, s.part, s.practice.lessonId], [3, 0, '4A']);
  assert.deepEqual(s.progress.resume, { stage: 3, part: 0 });
  // やり直し：同じ課題の最初の局面
  roomPracticeAct(s, { type: 'chi', option: 0 });
  retryRoom(s, rules);
  assert.equal(s.practice.game.melds[HUMAN].length, 0);
  assert.equal(pendingOf(s.practice).type, 'claim');
  const solve = {
    '4A': () => { roomPracticeAct(s, { type: 'chi', option: 0 }); sel('a:90'); roomPracticeAct(s, { type: 'discard' }); },
    '4B': () => { practiceContinue(s.practice); practiceContinue(s.practice); roomPracticeAct(s, { type: 'chi', option: 0 }); sel('a:90'); roomPracticeAct(s, { type: 'discard' }); },
    '4C': () => { roomPracticeAct(s, { type: 'pon' }); sel('a:90'); roomPracticeAct(s, { type: 'discard' }); },
    '4D': () => { roomPracticeAct(s, { type: 'chi', option: 0 }); sel('a:135'); roomPracticeAct(s, { type: 'discard' }); practiceContinue(s.practice); roomPracticeAct(s, { type: 'ron' }); },
    '5A': () => { sel('v:-1'); roomPracticeAct(s, { type: 'discard', riichi: true }); roomPracticeSelect(s, s.practice.game.drawn); roomPracticeAct(s, { type: 'discard' }); },
    '5B': () => roomPracticeAct(s, { type: 'ron' }),
    '5C': () => roomPracticeAct(s, { type: 'tsumo' }),
    6: () => { sel('a:90'); roomPracticeAct(s, { type: 'discard', riichi: true }); roomPracticeAct(s, { type: 'ron' }); },
  };
  function sel(k) { assert.equal(roomPracticeSelect(s, handId(s.practice, k)), true); }
  for (const id of ['4A', '4B', '4C', '4D', '5A', '5B', '5C', '6']) {
    assert.equal(s.practice.lessonId, id);
    solve[id]();
    assert.equal(s.done, true, `${id} 完了`);
    conserved(s.practice);
    if (id === '4D') assert.equal(s.progress.cleared[3], true);
    if (id === '4C') assert.equal(s.progress.cleared[3], false, '途中の課題ではまだクリアにしない');
    if (id === '6') break;
    assert.equal(nextRoom(s, rules), true);
  }
  assert.deepEqual(s.progress.cleared, [true, true, true, true, true, true]);
  const html = roomHTML(s, rules);
  assert.match(html, /初心者の部屋 修了/);
  assert.match(html, /data-action="br-challenge"[^>]*>実際の対局に挑戦する/);
  assert.equal(nextRoom(s, rules), false, '卒業試験の後は次がない');
});

test('部屋の一覧：開いていない段階は選べない・クリアした段階はもう一度遊べる・途中から再開', () => {
  const s = createRoomState(parseProgress(JSON.stringify({ v: 1, cleared: [true, true, true, false, false, false], resume: { stage: 3, part: 2 } }), partsOf));
  assert.equal(gotoStage(s, rules, 5), false);
  assert.equal(gotoStage(s, rules, 4), false);
  s.view = 'list';
  const html = roomHTML(s, rules);
  assert.match(html, /data-stage="4" disabled/);
  assert.match(html, /途中（課題3\/4）/);
  resumeRoom(s, rules);
  assert.deepEqual([s.stage, s.part, s.practice.lessonId], [3, 2, '4C']);
  assert.equal(gotoStage(s, rules, 0), true);
  assert.equal(s.stage, 0);
  assert.equal(s.practice, null);
  assert.equal(gotoStage(s, rules, 3), true);
  assert.equal(s.practice.lessonId, '4A', '続きの記録が別の段階なら、その段階の最初の課題から');
});
