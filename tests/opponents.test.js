// Ver.0.6 対戦相手の自由選択（src/ui/opponents.js・再現 URL の chars・混合の対局）の単体テスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { OPPONENTS, PICK_COUNT, opponentById, toggleOpponent, canStartWith, drawOpponents, assignSeats, parseChars } from '../src/ui/opponents.js';
import { validateReplay, replayQuery } from '../src/ui/replay.js';
import { CHARACTER_PARAMS, decideCharacter } from '../src/engine/character-ai.js';
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { applyAction } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { playMatch } from '../tools/sim-v06.mjs';

import { CHARACTER_ROSTER } from '../src/engine/characters.js';
const IDS = OPPONENTS.map((o) => o.id);
const OLD_ORDER = ['kanata', 'mitsuki', 'aoto', 'ousuke', 'natsuki', 'yuki', 'fukuyama', 'kaoru', 'asuma'];

const ORDER = [...OLD_ORDER, 'yujin', 'tara', 'nocchi'];

test('一覧：12人を初級→中級→上級の順に連続。名前・年齢・難易度は AI の名簿と一致し、紹介文（性格・打ち筋・一言）がある', () => {
  assert.deepEqual(IDS, ORDER);
  const roster = Object.fromEntries(Object.entries(CHARACTER_ROSTER).flatMap(([lv, xs]) => xs.map((c) => [c.id, { ...c, lv }])));
  for (const o of OPPONENTS) {
    assert.equal(o.name, roster[o.id].name);
    assert.equal(o.age, roster[o.id].age);
    assert.equal(o.level, roster[o.id].lv);
    assert.equal(o.levelLabel, { beginner: '初級', intermediate: '中級', advanced: '上級', additional: '個性型' }[o.level]);
    for (const k of ['trait', 'personality', 'style']) assert.ok(typeof o[k] === 'string' && o[k].length >= 4, `${o.id} の ${k}`);
  }
  assert.equal(PICK_COUNT, 3);
  assert.equal(opponentById('kaoru').name, 'かおる');
  assert.equal(opponentById('kanata').trait, '冷静に待ちを見る');
  assert.equal(opponentById('kaoru').trait, 'ヨイショの達人');
  assert.equal(opponentById('fukuyama').name, 'シャカ');
  assert.equal(opponentById('fukuyama').id, 'fukuyama');
  assert.equal(opponentById('nobody'), null);
});

test('選択：3人まで重複なしで選べる。4人目は加えない。選択済みを押すと外れる。0〜2人・重複・不明な ID では開始できない', () => {
  let sel = [];
  assert.equal(canStartWith(sel), false);
  for (const [id, n] of [['kanata', 1], ['yuki', 2]]) {
    const r = toggleOpponent(sel, id);
    assert.equal(r.reason, 'added'); sel = r.selected; assert.equal(sel.length, n);
    assert.equal(canStartWith(sel), false, `${n}人では開始できない`);
  }
  sel = toggleOpponent(sel, 'asuma').selected;
  assert.deepEqual(sel, ['kanata', 'yuki', 'asuma']);
  assert.equal(canStartWith(sel), true);
  const full = toggleOpponent(sel, 'kaoru');
  assert.deepEqual([full.changed, full.reason, full.selected], [false, 'full', sel], '4人目は加えない');
  const off = toggleOpponent(sel, 'yuki');
  assert.deepEqual([off.reason, off.selected], ['removed', ['kanata', 'asuma']]);
  assert.equal(toggleOpponent(sel, 'nobody').reason, 'unknown');
  assert.equal(canStartWith(['kanata', 'kanata', 'yuki']), false, '重複');
  assert.equal(canStartWith(['kanata', 'yuki', 'nobody']), false, '不明な ID');
  assert.equal(canStartWith(['kanata', 'yuki', 'asuma', 'kaoru']), false, '4人');
});

// 乱数の列をすべて列挙する（各段で m 通りの選択肢がそれぞれ同じ確率で出る乱数）
function enumerate(steps, fn) {
  const out = [];
  const rec = (vals) => {
    if (vals.length === steps.length) {
      let i = 0;
      out.push(fn(() => vals[i++]));
      return;
    }
    const m = steps[vals.length];
    for (let j = 0; j < m; j++) rec([...vals, (j + 0.5) / m]);
  };
  rec([]);
  return out;
}

test('おまかせ：9人から異なる3人。84通りの組がすべて同じ確率（乱数の列 9×8×7 通りを列挙して各組ちょうど6回）', () => {
  const draws = enumerate([9, 8, 7], (rand) => drawOpponents(rand, 3, OLD_ORDER));
  assert.equal(draws.length, 504);
  const count = new Map();
  for (const d of draws) {
    assert.equal(d.length, 3);
    assert.equal(new Set(d).size, 3, '重複なし');
    assert.deepEqual(d, OLD_ORDER.filter((id) => d.includes(id)), '一覧の順に並べる');
    const k = d.join(',');
    count.set(k, (count.get(k) || 0) + 1);
  }
  assert.equal(count.size, 84);
  for (const v of count.values()) assert.equal(v, 6);
  // 実際の乱数でも何度でも引き直せ、毎回3人（統計的にも偏りがない：84通りすべてが出る）
  const rng = createRng(2026);
  const seen = new Set();
  for (let i = 0; i < 5000; i++) { const d = drawOpponents(() => rng.next(), 3, OLD_ORDER); assert.ok(canStartWith(d)); seen.add(d.join(',')); }
  assert.equal(seen.size, 84);
});

test('現在の12人も同じ関数で一様（12×11×10 通りを列挙して 220 通りの組が各6回）', () => {
  const ids12 = ORDER;
  const draws = enumerate([12, 11, 10], (rand) => drawOpponents(rand, 3, ids12));
  const count = new Map();
  for (const d of draws) count.set(d.join(','), (count.get(d.join(',')) || 0) + 1);
  assert.equal(count.size, 220);
  for (const v of count.values()) assert.equal(v, 6);
});

test('おまかせの後に1人だけ入れ替えられる（残りの2人はそのまま）', () => {
  const rng = createRng(7);
  for (let i = 0; i < 30; i++) {
    const d = drawOpponents(() => rng.next());
    const out = d[i % 3];
    const inn = ORDER.find((id) => !d.includes(id));
    let sel = toggleOpponent(d, out).selected;
    assert.equal(sel.length, 2);
    sel = toggleOpponent(sel, inn).selected;
    assert.ok(canStartWith(sel));
    assert.deepEqual(sel.filter((id) => id !== inn).sort(), d.filter((id) => id !== out).sort());
  }
});

test('座席：選んだ3人を席1〜3へ。6通りの並びがすべて同じ確率（3×2 通りを列挙して各1回）。人間の席0は含まない', () => {
  const chosen = ['kanata', 'yuki', 'asuma'];
  const seats = enumerate([3, 2], (rand) => assignSeats(chosen, rand));
  const set = new Set(seats.map((x) => x.join(',')));
  assert.equal(seats.length, 6);
  assert.equal(set.size, 6);
  for (const s of seats) assert.deepEqual(s.slice().sort(), chosen.slice().sort());
  assert.deepEqual(chosen, ['kanata', 'yuki', 'asuma'], '元の配列は変えない');
});

test('再現 URL：chars（席1〜3の順）を検証・出力する。不正・重複はエラー。従来の ai も使える', () => {
  const q = (s) => validateReplay(new URLSearchParams(s));
  const ok = q('?seed=5&round=2&dealer=1&hand=1&renchan=0&len=4&mode=math1&chars=asuma,kanata,yuki');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.values.chars, ['asuma', 'kanata', 'yuki']);
  for (const bad of ['kanata,kanata,yuki', 'kanata,yuki', 'kanata,yuki,asuma,kaoru', 'kanata,yuki,nobody', '']) {
    const r = q(`?seed=5&chars=${bad}`);
    assert.equal(r.ok, false, bad);
    assert.equal(r.errors[0].key, 'chars');
  }
  const legacy = q('?seed=5&round=1&ai=advanced');
  assert.deepEqual([legacy.ok, legacy.values.ai, legacy.values.chars], [true, 'advanced', null]);
  const url = replayQuery({ seed: 9, round: 3, dealer: 2, hand: 2, renchan: 0, len: 8, mode: 'math2', chars: ['yuki', 'kaoru', 'aoto'] });
  assert.equal(url, '?seed=9&round=3&dealer=2&hand=2&renchan=0&len=8&mode=math2&chars=yuki,kaoru,aoto');
  assert.deepEqual(q(url).values.chars, ['yuki', 'kaoru', 'aoto']);
  assert.equal(parseChars('aoto,mitsuki,natsuki').length, 3);
  assert.equal(parseChars(null), null);
});

test('混合難易度の対局：ランダムな3人・ランダムな座席で、数学Ⅰ・Ⅱ、4局・8局を完走し、得点の総和 400・牌の保存・決定論', () => {
  const rng = createRng(606);
  for (const mode of ['math1', 'math2']) {
    for (const length of [4, 8]) {
      for (let k = 0; k < (mode === 'math1' ? 3 : 1); k++) {
        const chosen = drawOpponents(() => rng.next());
        const seats = ['L:intermediate:speed', ...assignSeats(chosen, () => rng.next())];
        const seedBase = 70000 + k * 31 + length;
        const a = playMatch({ mode, length, seats, seedBase });
        const b = playMatch({ mode, length, seats, seedBase });
        assert.deepEqual(a.scores, b.scores, '同じ seed なら同じ結果');
        assert.equal(a.scores.reduce((x, y) => x + y, 0), 400);
        for (let s = 1; s < 4; s++) assert.ok(a.stats[s].decisions > 0, `${seats[s]} が判断した`);
      }
    }
  }
});

// 1局を回し、各判断で「関係者の席を名前で探す」AI に渡す席の並び（seatIds）を2通り試して、判断が変わる場面があるかを数える
function relationDiff(mode, seatIds, who, partner, seed) {
  const rules = createRules(makeConfig({ mode }));
  const g = new Game({ rules, seed, dealer: seed % 4, players: seatIds.map((id) => ({ name: id, kind: 'ai', personality: 'speed' })) });
  const rng = createRng(seed);
  // 相手（partner）の席を最下位（トップと 40 点差）にする：かおるの甘さはアスマが4位のときだけ
  const scores = seatIds.map((id) => (id === partner ? 70 : 110));
  scores[0] = 100;
  const info = { scores, hand: 3, length: 4, dealer: seed % 4, renchan: 0 };
  const blind = seatIds.map((id) => (id === partner ? 'human' : id)); // 相手の席がわからない場合
  let diff = 0;
  for (let n = 0; g.pending() && n < 3000; n++) {
    const p = g.pending();
    const id = seatIds[p.seat];
    if (id === who && p.type === 'turn' && !p.canTsumo) {
      const st = rng.state ? rng.state() : null;
      const a = decideCharacter(g, p.seat, id, createRng(seed + n), info, seatIds);
      const b = decideCharacter(g, p.seat, id, createRng(seed + n), info, blind);
      if (a.tile !== b.tile) diff++;
      void st;
    }
    applyAction(g, p.seat, decideCharacter(g, p.seat, id === 'human' ? 'yuki' : id, rng, info, seatIds));
  }
  return diff;
}

test('かなた→あおと：あおとがどの席にいても、その席の公開された捨て牌を読む（判断の関数に公開情報だけの局面を渡して確認）', () => {
  const rules = createRules(makeConfig({ mode: 'math1' }));
  const key = (k) => rules.typeByKey.get(k).idx;
  // 手牌は互いに関係のない2枚 A・B（残したい度は同じ）。A を残すと待ちは W1（数値の牌）、B を残すと W2（角度の牌）
  const [A, B, W1, W2] = [key('v:√3'), key('a:150'), key('v:-1/2'), key('a:45')];
  assert.notEqual(rules.types[W1].kind, rules.types[W2].kind);
  for (let pos = 1; pos < 4; pos++) {
    const view = { seat: 0, hand: [{ id: 1, type: A }, { id: 2, type: B }], drawn: null, melds: [[], [], [], []], rivers: [[], [], [], []],
      handCounts: [2, 8, 8, 8], wallCount: 60, dealer: 0, riichi: [false, false, false, false] };
    view.rivers[pos] = [W1, W1]; // あおと（席 pos）が W1 を2枚捨てている
    const stub = { rules, riichi: [null, null, null, null], pending: () => ({ seat: 0, type: 'turn', canTsumo: false }), viewFor: () => view,
      waitsOf: (c) => (c[A] > 0 ? [W1] : [W2]) };
    const rng = () => ({ next: () => 0, int: () => 0, pick: (xs) => xs[0] });
    const seatIds = ['kanata', 'mitsuki', 'yuki', 'ousuke'];
    seatIds[pos] = 'aoto';
    const withAoto = decideCharacter(stub, 0, 'kanata', rng(), null, seatIds);
    const blind = decideCharacter(stub, 0, 'kanata', rng(), null, seatIds.map((x) => (x === 'aoto' ? 'yuki' : x)));
    assert.deepEqual(withAoto, { type: 'discard', tile: 2 }, `席${pos}のあおとの捨て牌（W1）を読み、W1 待ちを残す（B を捨てる）`);
    assert.deepEqual(blind, { type: 'discard', tile: 1 }, 'あおとがいなければ読みはない（同点は手牌の順）');
  }
});

test('かおる→アスマ：アスマがどの席にいても、その席の名前から探して働く（甘さが必ず出る係数で確認）', () => {
  const saved = { ...CHARACTER_PARAMS.kaoru };
  CHARACTER_PARAMS.kaoru.favorP = 1; CHARACTER_PARAMS.kaoru.favorDeficit = 0; CHARACTER_PARAMS.kaoru.favorWeight = 50; // 甘さが必ず出て効く係数（テストの中だけ。後で戻す）
  try {
    for (const [who, partner, others] of [['kaoru', 'asuma', ['fukuyama', 'ousuke']]]) {
      for (let pos = 1; pos < 4; pos++) {
        // who は席0。partner を席 pos に置き、残りの席に others
        const seatIds = [who, null, null, null];
        seatIds[pos] = partner;
        let k = 0;
        for (let s = 1; s < 4; s++) if (!seatIds[s]) seatIds[s] = others[k++];
        let diff = 0;
        for (let seed = 1; seed <= 12 && diff === 0; seed++) diff += relationDiff('math1', seatIds, who, partner, 8000 + seed * 7 + pos);
        assert.ok(diff > 0, `${who} は席${pos}の ${partner} を参照する`);
      }
    }
  } finally {
    Object.assign(CHARACTER_PARAMS.kaoru, saved);
  }
});
