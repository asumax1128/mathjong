// 選んだ牌を捨てた後の聴牌プレビュー（src/ui/discard-preview.js・docs/71）：聴牌／非聴牌・待ち・役あり／役なし・フリテン・
// 見えていない枚数0・未選択／不正な id／他家の番／リーチ中・同じ種類の別の牌・鳴いた手・情報の公平性・エンジンの判定との一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine/game.js';
import { applyAction, decide } from '../src/engine/ai.js';
import { decideCharacter } from '../src/engine/characters.js';
import { createRng } from '../src/engine/rng.js';
import { discardPreview, PREVIEW_TEXT } from '../src/ui/discard-preview.js';
import { tenpaiWaitsView } from '../src/ui/waits-view.js';
import { rulesFor, k } from './helpers.js';

const players = [0, 1, 2, 3].map((s) => ({ name: 'P' + s, kind: 'ai', personality: 'speed' }));
const TENPAI = ['cos', '180', '=-1', 'tan', '45', '=1', 'sin', '=1/2']; // 30°・150° 待ち
const OTHERS = [
  ['90', '90', '0', '0', '=√3', '=√3', '=-1/√3', '=-1/√3'],
  ['90', '90', '0', '0', '=√3', '=√3', '=-1/√3', '=-1/√3'],
  ['=-√3/2', '=-√3/2', '=1/√3', '=1/√3', '=-1/√2', '=-1/√2', '=1/√2', '=1/√2'],
];
function game(mode, hand, draws, ruleset = 2, others = OTHERS) {
  const hands = [hand, ...others];
  const keys = [];
  for (let i = 0; i < 8; i++) for (let s = 0; s < 4; s++) keys.push(k(hands[s][i]));
  return new Game({ rules: rulesFor(mode), seed: 1, dealer: 0, players, presetWall: [...keys, ...draws.map(k)], ruleset });
}
const keyOf = (rules, t) => rules.types[t].key;
// 画面と同じ引数（app.js の discardPreviewData と同じ組み立て）
function preview(g, selected, extra = {}) {
  const p = g.pending();
  const myTurn = !!(p && p.seat === 0 && p.type === 'turn');
  return discardPreview(g.rules, g.viewFor(0), {
    selected, myTurn, inRiichi: !!g.riichi[0], legalIds: g.hands[0].slice(),
    furitenRule: !!g.furitenRule, discardedTypes: g.discarded[0], tempFuriten: !!g.tempFuriten[0], ...extra,
  });
}
const idOf = (g, key, seat = 0) => g.hands[seat].find((id) => keyOf(g.rules, g.typeOf(id)) === key);

for (const mode of ['math1', 'math2']) {
  test(`${mode}：選んだ牌を捨てると聴牌（待ち・役あり・見えていない枚数）／聴牌にならない牌は「別の牌なら聴牌」`, () => {
    const g = game(mode, TENPAI, ['=-√3', '=-√3', '=-√3', '=-√3', '=-1/2']);
    const R = g.rules;
    // ツモ牌（−√3）を選ぶ → 聴牌、待ち 30°・150°、どちらも役あり、フリテンなし
    const a = preview(g, g.drawn);
    assert.equal(a.tenpai, true);
    assert.deepEqual(a.waits.map((w) => keyOf(R, w.type)), ['a:30', 'a:150']);
    assert.equal(a.yaku, 'all');
    assert.deepEqual(a.furiten, { ron: false, discard: [], temporary: false });
    assert.equal(a.others, null);
    // 待ちと見えていない枚数は既存の tenpaiWaitsView と同じ
    assert.deepEqual(a.waits, tenpaiWaitsView(R, g.viewFor(0), { selected: g.drawn, myTurn: true }).waits);
    // cos を選ぶ → 聴牌にならない。ほかの牌（ツモ牌）なら聴牌になる
    const b = preview(g, idOf(g, 'f:cos'));
    assert.equal(b.tenpai, false);
    assert.deepEqual(b.waits, []);
    assert.equal(b.yaku, null);
    assert.equal(b.furiten, null);
    assert.equal(b.others, 'tenpai');
    // 選び直し（別の牌）で結果が変わる。同じ牌に戻すと同じ結果
    assert.deepEqual(preview(g, g.drawn), a);
  });

  test(`${mode}：表示しない場合（未選択・手牌にない id・捨てられない牌・他家の番・リーチ中・自分の番以外の8枚）`, () => {
    const g = game(mode, TENPAI, ['=-√3', '=-√3', '=-√3', '=-√3', '=-1/2']);
    assert.equal(preview(g, null), null);
    assert.equal(preview(g, undefined), null);
    assert.equal(preview(g, 99999), null, '手牌にない id');
    assert.equal(preview(g, g.hands[1][0]), null, '他家の牌の id');
    assert.equal(preview(g, g.drawn, { legalIds: [] }), null, '捨てられない牌（暗カンの確認中など）');
    assert.equal(preview(g, g.drawn, { inRiichi: true }), null, 'リーチ中はツモ切りだけ');
    // 打牌の確定後（他家の番）：選択は残っていても表示しない
    const drawn = g.drawn;
    g.discard(0, drawn);
    assert.equal(preview(g, g.hands[0][0]), null);
    // リーチ中の自分の番
    const g2 = game(mode, TENPAI, ['=-√3']);
    g2.discard(0, g2.drawn, { riichi: true });
    for (let i = 0; i < 20 && g2.pending() && !(g2.pending().seat === 0 && g2.pending().type === 'turn'); i++) {
      const p = g2.pending();
      if (p.type === 'claim') g2.respond(p.seat, { type: 'pass' }); else g2.discard(p.seat, g2.drawn);
    }
    assert.equal(g2.pending().seat, 0);
    assert.equal(preview(g2, g2.drawn), null, 'リーチ中');
  });

  test(`${mode}：同じ種類の別の牌（物理 id）は同じ結果`, () => {
    // −√3 を2枚持つ形：どちらの −√3 を選んでも同じ
    const g = game(mode, ['cos', '180', '=-1', 'tan', '45', '=1', 'sin', '=-√3'], ['=-√3', '=1/2', '=-√3', '=-√3', '=-1/2']);
    const ids = g.hands[0].filter((id) => keyOf(g.rules, g.typeOf(id)) === 'v:-√3');
    assert.equal(ids.length, 2);
    const [x, y] = ids.map((id) => preview(g, id));
    assert.deepEqual(x, y);
    assert.equal(x.tenpai, false);
  });

  test(`${mode}：フリテン（捨て牌に待ち・選んだ牌そのものが待ち・同巡の見逃し）はロンだけ不可`, () => {
    const g = game(mode, TENPAI, ['=-√3', '=-√3', '=-√3', '=-√3', '=-1/2']);
    const R = g.rules;
    const t30 = R.typeByKey.get('a:30').idx;
    // 自分の捨て牌に待ち（30°）がある
    const a = preview(g, g.drawn, { discardedTypes: new Set([t30]) });
    assert.equal(a.tenpai, true);
    assert.deepEqual(a.furiten, { ron: true, discard: [t30], temporary: false });
    // 同巡の見逃しが続く（鳴いた後の打牌など）
    const b = preview(g, g.drawn, { tempFuriten: true });
    assert.deepEqual(b.furiten, { ron: true, discard: [], temporary: true });
    // フリテンの規則がない（旧ルール）ならフリテンの判定をしない
    assert.equal(preview(g, g.drawn, { furitenRule: false, discardedTypes: new Set([t30]) }).furiten, null);
    // 聴牌にならないときはフリテンを出さない
    assert.equal(preview(g, idOf(g, 'f:cos'), { discardedTypes: new Set([t30]) }).furiten, null);
  });

  test(`${mode}：待ちの牌が自分から全部見えている（見えていない枚数0）でも聴牌の形は聴牌と表示`, () => {
    // 30° を他家に4枚持たせ、捨てさせて河に並べる（見えていない枚数0）
    const others = [
      ['30', '90', '0', '0', '=√3', '=√3', '=-1/√3', '=-1/√3'],
      ['30', '90', '0', '0', '=√3', '=√3', '=-1/√3', '=-1/√3'],
      ['30', '30', '=1/√3', '=1/√3', '=-1/√2', '=-1/√2', '=1/√2', '=1/√2'],
    ];
    const g = game(mode, TENPAI, ['=-√3'], 2, others);
    const R = g.rules;
    const t30 = R.typeByKey.get('a:30').idx;
    // 自分は −√3 をツモ切り、他家は 30° を捨てる（30° のロンは見送る）を繰り返して、4枚とも河へ
    let guard = 0;
    while (g.rivers.flat().filter((x) => g.typeOf(x.id) === t30).length < 4 && guard++ < 40) {
      const p = g.pending();
      if (p.type === 'claim') { g.respond(p.seat, { type: 'pass' }); continue; }
      const t30id = g.hands[p.seat].find((id) => g.typeOf(id) === t30);
      g.discard(p.seat, p.seat === 0 ? g.drawn : (t30id ?? g.drawn));
    }
    while (!(g.pending().seat === 0 && g.pending().type === 'turn') && guard++ < 80) {
      const p = g.pending();
      if (p.type === 'claim') g.respond(p.seat, { type: 'pass' }); else g.discard(p.seat, g.drawn);
    }
    assert.equal(g.rivers.flat().filter((x) => g.typeOf(x.id) === t30).length, 4, '30° が4枚とも河にある');
    const pv = preview(g, g.drawn, { tempFuriten: false });
    assert.equal(pv.tenpai, true);
    const w30 = pv.waits.find((w) => w.type === t30);
    assert.ok(w30, '30° も待ちに含む');
    assert.equal(w30.unseen, 0);
  });
}

test('鳴いた手：役のない待ち（yaku none）・役のある待ち（all）を区別。門前の同じ形は役あり', () => {
  const R = rulesFor('math1');
  const T = (x) => R.typeByKey.get(k(x)).idx;
  // 鳴いた後の打牌番：公開面子1つ＋手の内6枚（1枚捨てて5枚）
  const mkView = (meld, hand, call = 'chi') => ({
    seat: 0, drawn: null,
    hand: hand.map((x, i) => ({ id: 100 + i, type: T(x) })),
    melds: [[{ meld: R.meldOf(...meld.map(T)).idx, kind: 'formula', call, tiles: meld.map(T), from: 3 }], [], [], []],
    rivers: [[], [], [], []],
  });
  const opts = (sel) => ({ selected: sel, myTurn: true, furitenRule: true, discardedTypes: new Set(), tempFuriten: false });
  // sin 30 = 1/2（チー）＋ cos 180 = −1 と tan・45、余り 0 → 0 を捨てると待ち =1（三関制覇）
  const a = discardPreview(R, mkView(['sin', '30', '=1/2'], ['cos', '180', '=-1', 'tan', '45', '0']), opts(105));
  assert.equal(a.tenpai, true);
  assert.deepEqual(a.waits.map((w) => [w.type, w.winnable]), [[T('=1'), true]]);
  assert.equal(a.yaku, 'all');
  // sin 30 = 1/2（チー）＋ sin 90 = 1・180・=−1、余り 0 → 0 を捨てると待ち cos：役なし
  const b = discardPreview(R, mkView(['sin', '30', '=1/2'], ['sin', '90', '=1', '180', '=-1', '0']), opts(105));
  assert.equal(b.tenpai, true);
  assert.deepEqual(b.waits.map((w) => [w.type, w.winnable]), [[T('cos'), false]]);
  assert.equal(b.yaku, 'none');
  // 余りでなく形の牌（sin）を捨てると聴牌にならない。ほかの牌（0）なら聴牌
  const c = discardPreview(R, mkView(['sin', '30', '=1/2'], ['sin', '90', '=1', '180', '=-1', '0']), opts(100));
  assert.equal(c.tenpai, false);
  assert.equal(c.others, 'tenpai');
  // 暗カンだけの手は門前（役の判定は門前の扱い）。エンジンの isClosed と同じ
  const d = tenpaiWaitsView(R, { ...mkView(['sin', '30', '=1/2'], ['sin', '90', '=1', '180', '=-1', '0'], 'ankan') }, { selected: 105, myTurn: true });
  const e = discardPreview(R, mkView(['sin', '30', '=1/2'], ['sin', '90', '=1', '180', '=-1', '0'], 'ankan'), opts(105));
  assert.deepEqual(e.waits, d.waits);
});

test('どの牌を捨てても聴牌にならない局面は「まだ聴牌にはなりません」（others none）', () => {
  const R = rulesFor('math1');
  const T = (x) => R.typeByKey.get(k(x)).idx;
  const hand = ['90', '90', '0', '0', '=√3', '=√3', '=-1/√3', '=-1/√3', '=-√3/2'];
  const view = { seat: 0, drawn: 108, hand: hand.map((x, i) => ({ id: 100 + i, type: T(x) })), melds: [[], [], [], []], rivers: [[], [], [], []] };
  for (const sel of [100, 108]) {
    const pv = discardPreview(R, view, { selected: sel, myTurn: true });
    if (pv.tenpai) continue; // 念のため：この配牌が聴牌になる牌を含む場合は検査しない
    assert.equal(pv.others, 'none');
  }
  // どの牌も聴牌にならないことを直接確認
  assert.ok(hand.every((_, i) => !tenpaiWaitsView(R, view, { selected: 100 + i, myTurn: true })));
  assert.equal(discardPreview(R, view, { selected: 100, myTurn: true }).others, 'none');
});

test('文言：確定文例を使い、「正解」「不正解」「必ず」「山に」と言わない', () => {
  assert.equal(PREVIEW_TEXT.tenpai, 'この牌を捨てると聴牌です');
  assert.equal(PREVIEW_TEXT.notTenpai, 'この牌を捨てると聴牌にはなりません');
  assert.equal(PREVIEW_TEXT.noYaku, '和了の形ですが、役がありません');
  assert.equal(PREVIEW_TEXT.furiten, 'フリテンのためロンできません（ツモは別判定）');
  for (const s of Object.values(PREVIEW_TEXT)) assert.doesNotMatch(s, /正解|不正解|必ず/);
  assert.doesNotMatch(Object.values(PREVIEW_TEXT).filter((s) => s !== PREVIEW_TEXT.unseenNote).join(), /山に/);
  assert.match(PREVIEW_TEXT.unseenNote, /山に残っている数ではありません/);
});

// ランダムな対局（AI 4人。席0はよく鳴く初級AI あおと＝鳴いた手・役なしの待ちも出る）：席0の打牌番ごとに、全ての手牌についてプレビューを求め、
// ①AI が実際に捨てた牌のプレビュー（聴牌・待ち・フリテン）が、捨てた直後のエンジンの shapeWaits・furitenOf と一致し、
// ②待ちの役の有無がエンジンの ronAnalysis（その待ちの牌でロンしたとき）と一致し、
// ③他家の手牌と山を入れ替えてもプレビューが同じ（情報の公平性）、④プレビューの計算で対局の状態が変わらない。
const SEATS = ['aoto', 'mitsuki', 'kanata', 'yujin'];
for (const mode of ['math1', 'math2']) {
  test(`${mode}：ランダムな対局でエンジンの判定と一致・情報の公平性・状態を変えない`, () => {
    const R = rulesFor(mode);
    let checkedTurns = 0, tenpaiSeen = 0, furitenSeen = 0, noYakuSeen = 0, calledSeen = 0;
    for (let seed = 1; seed <= (mode === 'math1' ? 60 : 50); seed++) {
      const g = new Game({ rules: R, seed, dealer: seed % 4, players, ruleset: 2 });
      const rng = createRng(seed);
      for (let step = 0; step < 400 && g.pending(); step++) {
        const p = g.pending();
        if (p.seat === 0 && p.type === 'turn' && !g.riichi[0]) {
          const snap = JSON.stringify({ h: g.hands, w: g.wall, r: g.rivers, m: g.melds, e: g.events.length, d: [...g.discarded[0]], t: g.tempFuriten });
          const all = new Map(g.hands[0].map((id) => [id, preview(g, id)]));
          // ③ 他家の手牌（同じ枚数どうし）と山の並びを入れ替える
          const saved = { hands: g.hands.map((h) => h.slice()), wall: g.wall.slice() };
          if (g.hands[1].length === g.hands[2].length) [g.hands[1], g.hands[2]] = [g.hands[2], g.hands[1]];
          g.wall.reverse();
          for (const [id, pv] of all) assert.deepEqual(preview(g, id), pv, `公平性 seed ${seed} step ${step}`);
          g.hands = saved.hands; g.wall = saved.wall;
          assert.equal(JSON.stringify({ h: g.hands, w: g.wall, r: g.rivers, m: g.melds, e: g.events.length, d: [...g.discarded[0]], t: g.tempFuriten }), snap, '状態を変えない');
          if (g.melds[0].length) calledSeen++;
          // ① AI の打牌を実行して、捨てた直後のエンジンの判定と比べる
          const a = decideCharacter(g, 0, SEATS[0], rng, null, SEATS);
          if (a.type === 'discard') { // リーチの宣言を伴う打牌も、捨てた後の待ち・フリテンは同じ
            const pv = all.get(a.tile);
            const isClosed = g.isClosed(0);
            const exposed = g.exposedMelds(0);
            applyAction(g, 0, a);
            const sw = g.shapeWaits(0);
            assert.deepEqual(pv.waits.map((w) => w.type), sw, `待ち seed ${seed} step ${step}`);
            assert.equal(pv.tenpai, sw.length > 0);
            if (pv.tenpai) {
              tenpaiSeen++;
              const f = g.furitenOf(0);
              assert.equal(pv.furiten.ron, f.furiten, `フリテン seed ${seed} step ${step}`);
              assert.deepEqual(pv.furiten.discard, f.inRiver);
              if (pv.furiten.ron) furitenSeen++;
              // ② 役の有無：待ちの牌を加えた形をエンジンと同じ条件（ロン・門前かどうか）で判定
              const counts = g.countsOf(g.hands[0]);
              for (const w of pv.waits) {
                counts[w.type]++;
                assert.equal(w.winnable, !!R.analyzeWin(counts, exposed, { ron: true, closed: isClosed }));
                counts[w.type]--;
                if (!w.winnable) noYakuSeen++;
              }
            }
            checkedTurns++;
            continue;
          }
          applyAction(g, 0, a);
          continue;
        }
        applyAction(g, p.seat, decideCharacter(g, p.seat, SEATS[p.seat], rng, null, SEATS));
      }
    }
    assert.ok(checkedTurns > 100, `${checkedTurns} 手番`);
    assert.ok(tenpaiSeen > 5, `聴牌 ${tenpaiSeen}`);
    assert.ok(calledSeen > 10 && noYakuSeen > 0, `鳴いた手 ${calledSeen}・役なしの待ち ${noYakuSeen}`);
    console.log(`${mode}: turns ${checkedTurns} tenpai ${tenpaiSeen} furiten ${furitenSeen} noYaku ${noYakuSeen} called ${calledSeen}`);
  });
}
