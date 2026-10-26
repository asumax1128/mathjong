// AI 難易度（Ver.0.4-B）：初級・中級・上級
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { BEGINNER, beginnerKeepScore, matchInfo, dangerTable, ADVANCED } from '../src/engine/ai-levels.js';
import { unseenCounts } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { createMatch, applyRoundResult, dealerOf } from '../src/engine/match.js';
import { rulesFor, rules as LEGACY } from './helpers.js';
import { goldenDigest } from './ai-levels-golden.mjs';
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';

const LEVELS = ['beginner', 'intermediate', 'advanced'];
const LINEUP = ['speed', 'value', 'closed', 'speed'];

// Ver.0.4-A（main 6be58ac、AI 難易度の導入前）の AI で記録した値。tests/ai-levels-golden.mjs で再計算できる。
// リーチ（Ver.0.5-A）の導入後は、リーチの規則を無効にした数学Ⅰ・Ⅱでこの値と一致すること（＝リーチ以外の判断は不変）を確かめる。
const GOLDEN_V04A = {
  legacy: '394af186ce38bccd5866242b',
  math1: '36539a5e436adea8690b5544',
  math2: '38876b39ff7db9d1a6a0294a',
};
// リーチありの規則（Ver.0.5-A）で記録した値。リーチの判断を変えたときだけ更新する（変更理由を docs に記録）。
const GOLDEN_RIICHI = {
  legacy: '394af186ce38bccd5866242b',
  math1: '6f4d59ab54dec027d22847e9',
  math2: '6d7148b1373dc92f45828d7b',
};

test('中級は従来の AI と完全一致（リーチの規則を無効にした場合。固定 seed の対局ログ：旧規則・数学Ⅰ・数学Ⅱ、1局×6＋4局戦1試合）', () => {
  assert.deepEqual(goldenDigest({ riichi: false }), GOLDEN_V04A, '難易度を省略した従来の呼び出し');
  assert.deepEqual(goldenDigest({ riichi: false, level: 'intermediate' }), GOLDEN_V04A, '中級を明示した呼び出し');
});

test('中級（リーチあり）：固定 seed の対局ログが記録値と一致（旧規則はリーチなしで従来どおり）', () => {
  assert.deepEqual(goldenDigest(), GOLDEN_RIICHI);
});

test('未知の難易度は拒否する', () => {
  const g = new Game({ rules: rulesFor('math1'), seed: 1, players: LINEUP.map((p) => ({ kind: 'ai', personality: p })) });
  assert.throws(() => decide(g, g.pending().seat, 'speed', createRng(1), 'expert'), /unknown AI level/);
});

// 全席を指定の難易度で1局進める。各判断を検査する関数 check を呼ぶ。
function play(rules, seed, levels, check = () => {}, dealer = seed % 4) {
  const g = new Game({ rules, seed, dealer, players: LINEUP.map((p) => ({ kind: 'ai', personality: p })) });
  const rng = createRng(seed ^ 0x5bd1e995);
  const log = [];
  let steps = 0;
  while (g.pending()) {
    const p = g.pending();
    const a = decide(g, p.seat, LINEUP[p.seat], rng, levels[p.seat]);
    check(g, p, a, levels[p.seat]);
    log.push([p.seat, a.type, a.tile ?? a.option ?? null]);
    applyAction(g, p.seat, a); // 不正な牌・宣言はエンジンが例外を投げる
    g.checkInvariants();
    if (++steps > 3000) throw new Error('no progress');
  }
  return { g, log };
}

test('初級：チー・ポンをしない、ロン・ツモは必ずする、打牌は自分の手牌から（数学Ⅰ・Ⅱ、各30局）', () => {
  const seen = { ron: 0, tsumo: 0, callChance: 0 };
  for (const mode of ['math1', 'math2']) {
    const r = rulesFor(mode);
    for (let i = 0; i < 30; i++) {
      // 初級2人・中級2人（席を入れ替える）
      const levels = i % 2 ? ['beginner', 'intermediate', 'beginner', 'intermediate'] : ['intermediate', 'beginner', 'intermediate', 'beginner'];
      play(r, 700 + i, levels, (g, p, a, lv) => {
        if (lv !== 'beginner') return;
        if (p.type === 'turn') {
          if (p.canTsumo) { seen.tsumo++; assert.deepEqual(a, { type: 'tsumo' }); return; }
          assert.equal(a.type, 'discard');
          assert.ok(g.hands[p.seat].includes(a.tile), '手牌の牌を捨てる');
          return;
        }
        if (p.ron) { seen.ron++; assert.deepEqual(a, { type: 'ron' }); return; }
        if (p.chi.length || p.pon) seen.callChance++;
        assert.deepEqual(a, { type: 'pass' }, 'チー・ポンをしない');
      });
    }
  }
  assert.ok(seen.ron > 0 && seen.tsumo > 0 && seen.callChance > 20, JSON.stringify(seen)); // 各局面を実際に通ったこと
});

test('初級の打牌：完成した面子の牌を残しやすい（残したい度の低い牌から選ぶ）', () => {
  const r = rulesFor('math1');
  const T = (key) => r.typeByKey.get(key).idx;
  const counts = r.countsOf(['f:sin', 'a:30', 'v:1/2', 'f:tan', 'a:90', 'v:-1'].map(T));
  // sin30=1/2 が完成：その3枚は COMPLETE 点以上。tan・90・−1 はどの面子も近くない
  assert.ok(beginnerKeepScore(r, counts, T('f:sin')) >= BEGINNER.COMPLETE);
  assert.ok(beginnerKeepScore(r, counts, T('v:1/2')) >= BEGINNER.COMPLETE);
  assert.ok(beginnerKeepScore(r, counts, T('a:90')) < BEGINNER.COMPLETE);
  assert.deepEqual(BEGINNER.PICK, [0.6, 0.25, 0.15]);
  assert.ok(Math.abs(BEGINNER.PICK.reduce((a, b) => a + b, 0) - 1) < 1e-12);
});

test('上級：ロン・ツモは必ずする。打牌・宣言は合法（数学Ⅰ・Ⅱ、各10局）', () => {
  for (const mode of ['math1', 'math2']) {
    const r = rulesFor(mode);
    for (let i = 0; i < 10; i++) {
      play(r, 900 + i, ['advanced', 'advanced', 'intermediate', 'advanced'], (g, p, a, lv) => {
        if (lv !== 'advanced') return;
        if (p.type === 'turn' && p.canTsumo) assert.deepEqual(a, { type: 'tsumo' });
        if (p.type === 'claim' && p.ron) assert.deepEqual(a, { type: 'ron' });
        if (a.type === 'chi') assert.ok(p.chi[a.option]);
        if (a.type === 'pon') assert.ok(p.pon);
      });
    }
  }
});

test('全難易度：固定 seed で再現可能（同じ seed・席・性格なら同じ対局ログ）', () => {
  for (const mode of ['math1', 'math2']) {
    const r = rulesFor(mode);
    for (const lv of [...LEVELS.map((l) => [l, l, l, l]), ['beginner', 'advanced', 'intermediate', 'advanced']]) {
      const a = play(r, 4100, lv).log;
      const b = play(r, 4100, lv).log;
      assert.deepEqual(a, b, `${mode} ${lv}`);
    }
  }
});

// 他家の手牌と山を入れ替えた（公開情報は同じ）局面を作る
function reshuffleHidden(g, seat, rng) {
  const h = Object.create(Game.prototype);
  for (const [k, v] of Object.entries(g)) h[k] = k === 'rules' || k === 'rng' || k === 'players' ? v : structuredClone(v);
  const hidden = [];
  for (let s = 0; s < 4; s++) if (s !== seat) hidden.push(...h.hands[s]);
  hidden.push(...h.wall);
  for (let i = hidden.length - 1; i > 0; i--) { const j = rng.int(i + 1); [hidden[i], hidden[j]] = [hidden[j], hidden[i]]; }
  let k = 0;
  for (let s = 0; s < 4; s++) if (s !== seat) h.hands[s] = h.hands[s].map(() => hidden[k++]);
  h.wall = h.wall.map(() => hidden[k++]);
  return h;
}

test('非公開情報を参照しない：他家の手牌・山の並びを入れ替えても判断は同じ（全難易度、数学Ⅰ・Ⅱ）', () => {
  let compared = 0;
  let changedHidden = 0;
  for (const mode of ['math1', 'math2']) {
    const r = rulesFor(mode);
    for (let i = 0; i < 3; i++) {
      const shuf = createRng(31 + i);
      play(r, 5200 + i, ['advanced', 'beginner', 'intermediate', 'advanced'], (g, p) => {
        // 自分の判断に必要な選択肢（pending）は自分の手牌だけで決まる。手番は全員、宣言は自分の選択肢だけで比べる。
        const h = reshuffleHidden(g, p.seat, shuf);
        if (h.hands.some((x, s) => s !== p.seat && x.join() !== g.hands[s].join())) changedHidden++;
        assert.deepEqual(h.viewFor(p.seat), g.viewFor(p.seat), '公開情報は同じ');
        assert.deepEqual(h.pending(), g.pending());
        for (const lv of LEVELS) {
          const a = decide(g, p.seat, LINEUP[p.seat], createRng(77), lv, null);
          const b = decide(h, p.seat, LINEUP[p.seat], createRng(77), lv, null);
          assert.deepEqual(b, a, `${mode} ${lv}`);
          compared++;
        }
      });
    }
  }
  assert.ok(compared > 150 && changedHidden > 50, `${compared} ${changedHidden}`);
});

test('上級の危険度は確率（0〜1）で、自分の席は 0。上級は守りの評価を使う', () => {
  const r = rulesFor('math2');
  const { g } = play(r, 6100, ['intermediate', 'intermediate', 'intermediate', 'intermediate'], () => {}, 0);
  const view = g.viewFor(1);
  const P = dangerTable(r, view, unseenCounts(r, view));
  for (let o = 0; o < 4; o++) for (const x of P[o]) assert.ok(x >= 0 && x <= 1 && Number.isFinite(x));
  assert.ok(P[1].every((x) => x === 0));
  assert.ok(ADVANCED.defense > 0, '上級は守りの評価を使う');
});

test('試合の公開情報（matchInfo）は持ち点・親・親番・局数・連荘だけ', () => {
  let m = createMatch({ length: 4 });
  assert.equal(matchInfo(null), null);
  const info = matchInfo(m);
  assert.deepEqual(Object.keys(info).sort(), ['dealer', 'hand', 'length', 'renchan', 'scores']);
  assert.equal(info.dealer, dealerOf(m));
  info.scores[0] = 0;
  assert.equal(m.scores[0], 100, 'コピーを返す');
  m = applyRoundResult(m, { type: 'draw' });
  assert.equal(matchInfo(m).hand, 1);
});

test('全難易度：4局戦の試合が止まらず完走する（数学Ⅰ・Ⅱ・旧規則の1局）', () => {
  for (const mode of ['math1', 'math2']) {
    const r = rulesFor(mode);
    for (const lv of LEVELS) {
      let m = createMatch({ length: 4 });
      let n = 0;
      while (!m.over) {
        n++;
        const { g } = play(r, 8000 + n * 7919, [lv, lv, lv, lv], () => {}, dealerOf(m));
        m = applyRoundResult(m, g.result);
        assert.ok(n < 200);
      }
      assert.equal(m.scores.reduce((a, b) => a + b, 0), 400);
    }
  }
  for (const lv of LEVELS) play(LEGACY, 12, [lv, lv, lv, lv]);
});

// ---------------- Ver.0.5-A P2 修正：リーチ無効時の上級 AI は Ver.0.4-B と同じ判断 ----------------
import { advancedDigest } from './ai-advanced-digest.mjs';
import { DANGER_COEF, DANGER_COEF_V04B, WIN_COEF, WIN_COEF_V04B } from '../src/engine/ai-levels.js';

const ENGINE_DIR = new URL('../src/engine/', import.meta.url).pathname;
// Ver.0.4-B（main cd37c62）のコードで記録した値（数学Ⅰ 8局面系列 1,052 判断・数学Ⅱ 948 判断。上級2種・中級・初級の判断）。
// tests/ai-advanced-digest.mjs を cd37c62 の src/engine に向けて実行すると再計算できる。
const DIGEST_V04B = { math1: { n: 1052, sha: '7ec5c1eebfc140959c1fad81' }, math2: { n: 948, sha: 'd5cd1d9fe34f790f1bf245c8' } };
// リーチ有効の規則で記録した値（P2 修正の前後で判断が変わっていないこと＝新しい係数のまま）
const DIGEST_RIICHI_ON = { math1: { n: 972, sha: '835f266250c04daa0b23c636' }, math2: { n: 892, sha: 'c4d549c49237f7e253387f43' } };

test('P2：リーチ無効の数学Ⅰ・Ⅱで、上級（と中級・初級）の判断が Ver.0.4-B と一致（複数 seed・複数局面）', async () => {
  assert.deepEqual(await advancedDigest(ENGINE_DIR, { riichi: false }), DIGEST_V04B);
});

test('P2：リーチ有効のときは新しい係数を使い、判断は修正前（e780f5a）から変わらない', async () => {
  assert.deepEqual(await advancedDigest(ENGINE_DIR, { riichi: true }), DIGEST_RIICHI_ON);
});

test('P2：係数セット：旧係数は Ver.0.4-B の値そのまま（リーチの特徴量なし）。新係数はリーチの項を持つ', () => {
  assert.deepEqual(DANGER_COEF_V04B.math1, [-6.982, 0.679, 0.554, 0.988, 2.007, -2.886, -0.264, 1.53]);
  assert.deepEqual(DANGER_COEF_V04B.math2, [-9.945, 0.106, 0.309, 0.45, 2.205, -2.194, -0.081, 4.555]);
  assert.deepEqual(WIN_COEF_V04B.math1, [-2.816, 0.883, 0.03, 0.653]);
  assert.deepEqual(WIN_COEF_V04B.math2, [-3.673, 0.79, 0.02, 1.297]);
  for (const mode of ['math1', 'math2']) {
    assert.equal(DANGER_COEF_V04B[mode].length, 8);
    assert.equal(DANGER_COEF[mode].length, 9, 'リーチの特徴量（9番目）');
    assert.notDeepEqual(WIN_COEF[mode], WIN_COEF_V04B[mode]);
  }
});

test('P2：リーチ無効の規則では、他家のリーチ（公開情報）があっても危険度は旧版と同じ（リーチの項を加えない）', async () => {
  const { dangerTable } = await import('../src/engine/ai-levels.js');
  const { unseenCounts } = await import('../src/engine/ai.js');
  const r = rulesFor('math1');
  const off = createRules(makeConfig({ mode: 'math1', rules: { riichi: false } }));
  const g = new Game({ rules: off, seed: 3, dealer: 0, players: LINEUP.map((p) => ({ kind: 'ai', personality: p })) });
  const v = g.viewFor(0);
  const base = dangerTable(off, v, unseenCounts(off, v));
  const fake = { ...v, riichi: [false, true, true, true] }; // 他家がリーチしている公開情報
  const withFlag = dangerTable(off, fake, unseenCounts(off, fake));
  assert.deepEqual(withFlag.map((a) => [...a]), base.map((a) => [...a]), 'リーチ無効では riichi の特徴量を使わない');
  void r;
});
