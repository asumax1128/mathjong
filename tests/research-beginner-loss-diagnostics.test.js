// 研究ツール（docs/69）の再現性と計測の正しさ。公開AI係数を変えないこと（研究条件は実行後に元へ戻る）も確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BEGINNER_PARAMS } from '../src/engine/character-ai-prototype.js';
import { plan, runCell, summarize, playMatch, wilson, pairedNovice, AI4, SCENARIOS } from '../tools/research-beginner-loss-diagnostics.mjs';

const hash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');

test('再現性：同じ seed・計画なら結果は完全一致（2回実行）', () => {
  const cell = { exp: 'ai4', scenario: 'baseline', mode: 'math1', length: 4, seeds: 2, rotations: 4 };
  const a = summarize(runCell(cell, 690001).ai4), b = summarize(runCell(cell, 690001).ai4);
  assert.equal(hash(a), hash(b));
  const c = summarize(runCell(cell, 690002).ai4);
  assert.notEqual(hash(a), hash(c), 'seed が違えば結果も変わる');
});

test('ペア比較：初心者代理の版を変えても、相手の AI の乱数列と山は同じ（席ごとの乱数）', () => {
  const cell = { exp: 'novice', scenario: 'baseline', mode: 'math1', length: 1, seeds: 6, rotations: 1 };
  const out = runCell(cell, 690001);
  assert.equal(out['novice-basic'].length, 6);
  for (let i = 0; i < 6; i++) {
    const b = out['novice-basic'][i], s = out['novice-smart'][i];
    assert.deepEqual(b.agents.slice(1), s.agents.slice(1), '同じ相手・席');
    assert.equal(b.rounds[0].dealer, s.rounds[0].dealer, '同じ親');
  }
  const p = pairedNovice(out['novice-basic'], out['novice-smart']);
  assert.equal(p.pairs, 6);
  assert.equal(p.smartBetter + p.smartWorse + p.same, 6);
});

test('席の回し方：E1 は各キャラが各席に1回ずつ。試合ごとに400点・供託0・終局', () => {
  const ms = runCell({ exp: 'ai4', scenario: 'baseline', mode: 'math2', length: 1, seeds: 3, rotations: 4 }, 690001).ai4;
  assert.equal(ms.length, 12);
  for (let k = 0; k < 3; k++) {
    const seats = ms.slice(k * 4, k * 4 + 4).map((m) => m.agents);
    for (let s = 0; s < 4; s++) assert.deepEqual(seats.map((a) => a[s]).sort(), [...AI4].sort());
  }
  for (const m of ms) assert.equal(m.scores.reduce((a, b) => a + b, 0), 400);
});

test('分母は合法な選択機会：選んだ回数は機会の回数以下、和了・放銃・流局の整合', () => {
  const ms = runCell({ exp: 'novice', scenario: 'baseline', mode: 'math1', length: 4, seeds: 3, rotations: 1 }, 690001);
  assert.deepEqual(Object.keys(ms), ['novice-basic', 'novice-keep', 'novice-riichi', 'novice-smart']);
  for (const v of Object.keys(ms)) {
    const sum = summarize(ms[v]);
    for (const a of Object.values(sum.agents)) {
      for (const r of [a.calls.chi, a.calls.pon, a.claims.ron, a.claims.tsumo, a.tenpai.keepTenpai, a.riichi.declareRateByTurn]) if (r) assert.ok(r.k <= r.n && r.rate >= 0 && r.rate <= 1);
      assert.ok(a.riichi.declinedTurns <= a.riichi.oppTurns);
      const k = (r) => (r ? r.k : 0); // 機会が0回なら区間は null
      assert.equal(k(a.claims.ron) + k(a.claims.tsumo), a.win.ron + a.win.tsumo, '和了＝実行したロン・ツモ');
    }
    // 基本・聴牌を保つ（ダマ）はリーチしない。基本・ダマ・リーチは鳴かない
    const ag = summarize(ms[v]).agents[v];
    if (v === 'novice-basic' || v === 'novice-keep') assert.equal(ag.riichi.declaredRounds, 0);
    if (v !== 'novice-smart') assert.equal(ag.calls.chi ? ag.calls.chi.k : 0, 0);
    const rounds = ms[v].flatMap((m) => m.rounds);
    const wins = rounds.filter((r) => r.type === 'win').length;
    assert.equal(sum.table.rounds, rounds.length);
    assert.equal(sum.table.winRate.k, wins);
    // 放銃の数＝ロン和了の数
    const dealIns = Object.values(sum.agents).reduce((n, a) => n + (a.dealIn.rate ? a.dealIn.rate.k : 0), 0);
    assert.equal(dealIns, rounds.filter((r) => r.how === 'ron').length);
  }
});

test('研究条件（easy）は一時的：実行後に公開の係数（BEGINNER_PARAMS）は元のまま', () => {
  const before = JSON.stringify(BEGINNER_PARAMS);
  runCell({ exp: 'ai4', scenario: 'easy', mode: 'math1', length: 1, seeds: 1, rotations: 1 }, 690001);
  assert.equal(JSON.stringify(BEGINNER_PARAMS), before);
  SCENARIOS.easy();
  assert.notEqual(JSON.stringify(BEGINNER_PARAMS), before);
  SCENARIOS.baseline();
  assert.equal(JSON.stringify(BEGINNER_PARAMS), before);
});

test('計画と区間：事前に宣言したサンプル数・Wilson 区間', () => {
  const p = plan(1);
  assert.equal(p.length, 20); // 1モードあたり E1×3・E2×3・E3・E4×3
  assert.deepEqual(p.filter((c) => c.exp === 'ai4' && c.scenario === 'baseline' && c.mode === 'math1').map((c) => [c.length, c.seeds * c.rotations]), [[1, 240], [4, 80], [8, 40]]);
  const w = wilson(5, 10);
  assert.ok(w.lo < 0.5 && w.hi > 0.5 && w.rate === 0.5);
  assert.equal(wilson(0, 0), null);
  const m = playMatch({ mode: 'math1', length: 1, agents: AI4, seed: 1, startDealer: 0 });
  assert.equal(m.played, 1);
});
