// Ver.0.6 キャラクターAI（最終調整）の単体テスト：係数の独立性・公開情報だけの判断・通った牌の正しさ・
// ロン／ツモの受諾・決定論・牌と得点の保存（シミュレーターの1試合）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { applyAction, viewCounts, unseenCounts } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { createMatch, dealerOf } from '../src/engine/match.js';
import {
  CHARACTER_ROSTER, CHARACTER_PARAMS, decideCharacter, passedTiles, expectedPoints, DANGER_COEF_V06, dangerFeaturesV06,
} from '../src/engine/character-ai.js';
import { playMatch } from '../tools/sim-v06.mjs';

const ALL = Object.values(CHARACTER_ROSTER).flat().map((c) => c.id);
const rulesOf = { math1: createRules(makeConfig({ mode: 'math1' })), math2: createRules(makeConfig({ mode: 'math2' })) };

test('判断係数：9人それぞれが独立した係数の表を持つ（共有の参照がなく、1人の変更が他に及ばない）', () => {
  assert.deepEqual(Object.keys(CHARACTER_PARAMS).sort(), [...ALL].sort());
  const objs = ALL.map((id) => CHARACTER_PARAMS[id]);
  assert.equal(new Set(objs).size, 9);
  const before = JSON.stringify(CHARACTER_PARAMS.kaoru);
  const saved = CHARACTER_PARAMS.asuma.defense;
  CHARACTER_PARAMS.asuma.defense = 99;
  assert.equal(JSON.stringify(CHARACTER_PARAMS.kaoru), before);
  CHARACTER_PARAMS.asuma.defense = saved;
  // 数値の係数は有限
  const walk = (x) => { if (typeof x === 'number') assert.ok(Number.isFinite(x)); else if (x && typeof x === 'object') Object.values(x).forEach(walk); };
  walk(CHARACTER_PARAMS);
  for (const m of ['math1', 'math2']) assert.equal(DANGER_COEF_V06[m].length, 12);
});

// 1局を回し、各判断でコールバックを呼ぶ
function playRound(mode, seats, seed, onDecision) {
  const rules = rulesOf[mode];
  const g = new Game({ rules, seed, dealer: seed % 4, players: seats.map((id) => ({ name: id, kind: 'ai', personality: 'speed' })) });
  const rng = createRng(seed ^ 0x5bd1e995);
  const info = { scores: [100, 92, 108, 100], hand: 3, length: 4, dealer: seed % 4, renchan: 0 };
  let n = 0;
  while (g.pending()) {
    const p = g.pending();
    const a = decideCharacter(g, p.seat, seats[p.seat], rng, info, seats);
    if (onDecision) onDecision(g, p, a);
    applyAction(g, p.seat, a);
    if (++n > 4000) throw new Error('no progress');
  }
  g.checkInvariants();
  return g;
}

test('通った牌：他家 o の「今の手で当たらない牌」として集めた牌は、実際の手牌（検証のためだけに参照）で見ても当たりではない', () => {
  let checked = 0;
  for (const mode of ['math1', 'math2']) {
    for (let k = 0; k < (mode === 'math1' ? 6 : 3); k++) {
      playRound(mode, ['fukuyama', 'kaoru', 'asuma', 'ousuke'], 7100 + k, (g, p) => {
        if (p.type !== 'turn') return;
        const passed = passedTiles(g, p.seat);
        for (let o = 0; o < 4; o++) {
          if (o === p.seat) continue;
          const waits = new Set(g.waitsOf(g.countsOf(g.hands[o]), g.melds[o].map((m) => m.meld)));
          for (const t of passed[o]) { assert.ok(!waits.has(t), `${mode} 席${o} の当たり ${t} を「通った牌」にした`); checked++; }
        }
      });
    }
  }
  assert.ok(checked > 200, `確認した通った牌 ${checked}`);
});

test('公開情報だけ：上級・中級・初級の判断は、他家の手牌・山を直接読まない（読むと例外）。Math.random を使わない', () => {
  const rnd = Math.random;
  Math.random = () => { throw new Error('Math.random は判断に使わない'); };
  try {
    for (const mode of ['math1', 'math2']) {
      for (const seats of [['fukuyama', 'kaoru', 'asuma', 'yuki'], ['ousuke', 'natsuki', 'yuki', 'kaoru'], ['kanata', 'mitsuki', 'aoto', 'kanata']]) {
        const rules = rulesOf[mode];
        const g = new Game({ rules, seed: 8800, dealer: 0, players: seats.map((id) => ({ name: id, kind: 'ai', personality: 'speed' })) });
        const rng = createRng(8800);
        const info = { scores: [100, 100, 100, 100], hand: 0, length: 4, dealer: 0, renchan: 0 };
        // AI に渡す Game：手牌・山などの非公開の配列への直接のアクセスを禁止（メソッドは内部で本物を使う）
        const guard = new Proxy(g, {
          get(target, prop) {
            if (prop === 'hands' || prop === 'wall' || prop === 'tileType') throw new Error(`非公開の ${String(prop)} を読んだ`);
            const v = Reflect.get(target, prop);
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
        let n = 0;
        while (g.pending()) {
          const p = g.pending();
          const a = decideCharacter(guard, p.seat, seats[p.seat], rng, info, seats);
          applyAction(g, p.seat, a);
          if (++n > 4000) throw new Error('no progress');
        }
      }
    }
  } finally { Math.random = rnd; }
});

test('ロン・ツモ：9人とも、宣言できるロン・ツモは必ず宣言する（見逃さない）', () => {
  let rons = 0, tsumos = 0;
  for (const mode of ['math1', 'math2']) {
    for (const seats of [['fukuyama', 'kaoru', 'asuma', 'ousuke'], ['natsuki', 'yuki', 'kanata', 'mitsuki'], ['aoto', 'asuma', 'kanata', 'yuki']]) {
      for (let k = 0; k < (mode === 'math1' ? 6 : 2); k++) {
        playRound(mode, seats, 9100 + k * 13, (g, p, a) => {
          if (p.type === 'turn' && p.canTsumo) { assert.equal(a.type, 'tsumo', seats[p.seat]); tsumos++; }
          if (p.type === 'claim' && p.ron) { assert.equal(a.type, 'ron', seats[p.seat]); rons++; }
          if (p.type === 'turn' && g.riichi[p.seat] && !p.canTsumo) assert.equal(a.tile, g.drawn, 'リーチ中はツモ切り');
          if (a.type === 'chi' || a.type === 'pon') assert.ok(g.melds[p.seat].length < 2, '鳴きは2回まで');
        });
      }
    }
  }
  assert.ok(rons + tsumos > 10, `ロン ${rons}・ツモ ${tsumos}`);
});

test('和了点の見込み：0 以上で、その手の最高点＋リーチの加点を超えない', () => {
  const g = playRound('math1', ['fukuyama', 'kaoru', 'asuma', 'yuki'], 4242, (gg, p) => {
    if (p.type !== 'turn') return;
    const view = gg.viewFor(p.seat);
    const counts = viewCounts(gg.rules, view);
    counts[view.hand[0].type]--;
    const e = expectedPoints(gg.rules, counts, view.melds[p.seat].map((m) => m.meld), unseenCounts(gg.rules, view));
    assert.ok(e >= 0 && e < 60, `見込み ${e}`);
  });
  assert.ok(g.result);
});

test('危険度の特徴量は公開情報（view）だけから作る（12個・有限）', () => {
  const rules = rulesOf.math2;
  const g = new Game({ rules, seed: 5, dealer: 0, players: [0, 1, 2, 3].map(() => ({ kind: 'ai', personality: 'speed' })) });
  const view = g.viewFor(0);
  const f = dangerFeaturesV06(rules, view, unseenCounts(rules, view), 2, [0, 0, 0, 0]);
  assert.equal(f.length, rules.types.length);
  for (const row of f) { assert.equal(row.length, 12); assert.ok(row.every(Number.isFinite)); }
});

test('シミュレーターの1試合：牌の保存・得点の総和（400点）を確認し、同じ seed なら同じ結果（数学Ⅰ・Ⅱ、全難易度）', () => {
  for (const mode of ['math1', 'math2']) {
    for (const seats of [['kanata', 'ousuke', 'natsuki', 'yuki'], ['ousuke', 'fukuyama', 'kaoru', 'asuma'], ['L:intermediate:speed', 'kaoru', 'mitsuki', 'aoto']]) {
      const a = playMatch({ mode, length: 4, seats, seedBase: 31337 });
      const b = playMatch({ mode, length: 4, seats, seedBase: 31337 });
      assert.deepEqual(a.scores, b.scores);
      assert.equal(a.scores.reduce((x, y) => x + y, 0), 400);
      assert.equal(a.ranks.reduce((x, y) => x + y, 0), 10, '同点を分け合う順位の和は 10');
    }
  }
});
