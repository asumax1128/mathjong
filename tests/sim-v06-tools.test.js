// Ver.0.6 監査 P3-1・P3-2・P3-3 の回帰テスト：シミュレーターの seed と対比較、同点の順位の集計、AUC の同点の扱い。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCases, filterCases, buildJobs, caseId, placeShares, fracRanks, playerSummary, playMatch, summarize } from '../tools/sim-v06.mjs';
import { pairResults } from '../tools/compare-v06.mjs';
import { aucOf, evaluate } from '../tools/calibrate-v06.mjs';
import { createRng } from '../src/engine/rng.js';

const EXPS = ['up', 'down', 'cross', 'same', 'legacy', 'ref', 'refv05', 'all'];
const ONLY = ['kaoru', 'kanata,asuma', 'advanced', 'intermediate,beginner', 'v05-advanced', 'yuki,ousuke,fukuyama'];

test('P3-1：ケースIDは一意で、配列番号・絞り込みに依存しない', () => {
  for (const exp of EXPS) {
    const cases = buildCases(exp);
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, exp);
    for (const c of cases) assert.equal(c.id, caseId({ ...c }));
  }
  // 同じケースは、どの実験に入っていても同じID
  const all = new Map(buildCases('all').map((c) => [c.id, c]));
  for (const c of buildCases('down')) assert.ok(all.has(c.id));
});

test('P3-1：--only・--exp を変えても、同じケースの seed・席の並び・標本IDは変わらない（case-id 方式）', () => {
  const opts = { mode: 'math1', length: 4, groups: 3, seed: 900001 };
  const ref = new Map();
  for (const exp of EXPS) {
    for (const only of [null, ...ONLY]) {
      const cases = filterCases(buildCases(exp), only);
      if (!cases.length) continue;
      for (const j of buildJobs({ ...opts, cases })) {
        const key = j.sample;
        const sig = `${j.seedBase}|${j.seats.join(',')}|${j.caseId}`;
        if (ref.has(key)) assert.equal(ref.get(key), sig, `${exp} --only ${only}: ${key}`);
        else ref.set(key, sig);
      }
    }
  }
  assert.ok(ref.size > 300);
  // 局数（8局戦）・seed・グループが違えば seed も違う
  const c = filterCases(buildCases('down'), 'kaoru');
  const a = buildJobs({ ...opts, cases: c })[0], b = buildJobs({ ...opts, length: 8, cases: c })[0];
  assert.notEqual(a.seedBase, b.seedBase);
  // 互換用の index 方式は、絞り込むと同じケースの seed が変わる（だから既定にしない）
  const full = buildJobs({ ...opts, cases: buildCases('down'), scheme: 'index' }).find((j) => j.caseId === c[0].id);
  const only = buildJobs({ ...opts, cases: c, scheme: 'index' })[0];
  assert.notEqual(full.seedBase, only.seedBase);
  assert.throws(() => buildJobs({ ...opts, cases: c, scheme: 'xxx' }), /seed-scheme/);
});

test('P3-1：実際の対局でも、--only の有無で同じケースの結果は同一（数学Ⅰ・1グループ）', () => {
  const opts = { mode: 'math1', length: 4, groups: 1, seed: 4242 };
  const full = buildJobs({ ...opts, cases: buildCases('down') }).filter((j) => j.caseId.startsWith('down:-:kaoru,'));
  const only = buildJobs({ ...opts, cases: filterCases(buildCases('down'), 'kaoru') });
  assert.equal(full.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.equal(full[i].sample, only[i].sample);
    const a = playMatch(full[i]), b = playMatch(only[i]);
    assert.deepEqual(a.scores, b.scores);
  }
});

// 対比較用の小さな結果（試合ごとの記録つき）
function fakeReport({ seedBase = (s) => s.length, scheme = 'case-id', drop = false, seatsSwap = false, withMatches = true } = {}) {
  const c = buildCases('down')[0];
  const samples = [0, 1].map((g) => `${c.id}|g${g}|r0`);
  const ranks = [1.5, 3];
  const r = {
    meta: { seed: 1, mode: 'math1', length: 4, seedScheme: scheme },
    cases: [{ id: c.id, kind: c.kind, challenger: c.challenger, level: null, players: { [c.challenger]: { rank: { mean: 2.25 } } }, challengerRanks: ranks, challengerSamples: drop ? samples.slice(0, 1) : samples }],
    matches: samples.map((s, i) => ({ caseId: c.id, sample: s, seedBase: seedBase(s), seats: seatsSwap ? [...c.lineup].reverse() : c.lineup, scores: [100, 100, 100, 100], ranks: [ranks[i], 2, 2, 2] })),
  };
  if (!withMatches) delete r.matches;
  return r;
}

test('P3-1：対比較は標本ID・seed・席の並びが一致する試合だけを対にし、一致しなければエラー', () => {
  const { rows } = pairResults(fakeReport(), fakeReport());
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].diffs, [0, 0]);
  assert.throws(() => pairResults(fakeReport(), fakeReport({ seedBase: (s) => s.length + 1 })), /seed が一致しない/);
  assert.throws(() => pairResults(fakeReport(), fakeReport({ seatsSwap: true })), /席の並びが一致しない/);
  assert.throws(() => pairResults(fakeReport(), fakeReport({ drop: true })), /標本の集合/);
  assert.throws(() => pairResults(fakeReport(), fakeReport({ scheme: 'index' })), /seed scheme/);
  assert.throws(() => pairResults(fakeReport({ withMatches: false }), fakeReport()), /旧形式/);
  const other = fakeReport(); other.meta.seed = 2;
  assert.throws(() => pairResults(fakeReport(), other), /seed differ/);
});

test('P3-2：同点の順位の持分（全員同点・3人同点・2人同点）と平均順位の整合', () => {
  const cases = [
    [[100, 100, 100, 100], [[0.25, 0.25, 0.25, 0.25], [0.25, 0.25, 0.25, 0.25], [0.25, 0.25, 0.25, 0.25], [0.25, 0.25, 0.25, 0.25]]],
    [[110, 110, 110, 70], [[1 / 3, 1 / 3, 1 / 3, 0], [1 / 3, 1 / 3, 1 / 3, 0], [1 / 3, 1 / 3, 1 / 3, 0], [0, 0, 0, 1]]],
    [[130, 90, 90, 90], [[1, 0, 0, 0], [0, 1 / 3, 1 / 3, 1 / 3], [0, 1 / 3, 1 / 3, 1 / 3], [0, 1 / 3, 1 / 3, 1 / 3]]],
    [[120, 120, 80, 80], [[0.5, 0.5, 0, 0], [0.5, 0.5, 0, 0], [0, 0, 0.5, 0.5], [0, 0, 0.5, 0.5]]],
    [[110, 100, 100, 90], [[1, 0, 0, 0], [0, 0.5, 0.5, 0], [0, 0.5, 0.5, 0], [0, 0, 0, 1]]],
  ];
  for (const [scores, want] of cases) {
    const sh = placeShares(scores);
    const fr = fracRanks(scores);
    sh.forEach((row, s) => {
      row.forEach((x, k) => assert.ok(Math.abs(x - want[s][k]) < 1e-12, `${scores} 席${s} ${k + 1}位`));
      assert.ok(Math.abs(row.reduce((a, b) => a + b, 0) - 1) < 1e-12);
      assert.ok(Math.abs(row.reduce((a, x, k) => a + (k + 1) * x, 0) - fr[s]) < 1e-12, '平均順位＝Σ順位×持分');
    });
    for (let k = 0; k < 4; k++) assert.ok(Math.abs(sh.reduce((a, r) => a + r[k], 0) - 1) < 1e-12, '各順位の持分の和は1');
  }
  // ランダムな得点でも整合
  const rng = createRng(9);
  for (let i = 0; i < 500; i++) {
    const scores = [0, 1, 2, 3].map(() => 90 + Math.floor(rng.next() * 4) * 5);
    const sh = placeShares(scores), fr = fracRanks(scores);
    sh.forEach((row, s) => assert.ok(Math.abs(row.reduce((a, x, k) => a + (k + 1) * x, 0) - fr[s]) < 1e-12));
  }
});

test('P3-2：集計の1位率・2位以内率・4位率は持分から数える（4人とも100点なら各 0.25・0.5・0.25）', () => {
  const template = playMatch({ mode: 'math1', length: 4, seats: ['kanata', 'mitsuki', 'aoto', 'kanata'], seedBase: 11 }).stats[0];
  const mk = (scores, s) => ({ rank: fracRanks(scores)[s], share: placeShares(scores)[s], score: scores[s], stats: template });
  const all = playerSummary([mk([100, 100, 100, 100], 0)]);
  assert.deepEqual([all.rank.mean, all.top1.mean, all.top2.mean, all.last.mean], [2.5, 0.25, 0.5, 0.25]);
  const three = playerSummary([mk([110, 110, 110, 70], 1)]);
  assert.deepEqual([three.rank.mean, three.top1.mean, three.top2.mean, three.last.mean], [2, 0.333, 0.667, 0]);
  const low3 = playerSummary([mk([130, 90, 90, 90], 3)]);
  assert.deepEqual([low3.rank.mean, low3.top1.mean, low3.top2.mean, low3.last.mean], [3, 0, 0.333, 0.333]);
  // 平均順位 = 1·p1 + 2·p2 + 3·p3 + 4·p4（多数の行でも）
  const rows = [[100, 100, 100, 100], [110, 110, 110, 70], [130, 90, 90, 90], [120, 120, 80, 80], [140, 100, 90, 70]].flatMap((sc) => [0, 1, 2, 3].map((s) => mk(sc, s)));
  const sum = playerSummary(rows);
  const p = [0, 1, 2, 3].map((k) => rows.reduce((a, r) => a + r.share[k], 0) / rows.length);
  assert.ok(Math.abs(sum.rank.mean - (p[0] + 2 * p[1] + 3 * p[2] + 4 * p[3])) < 1e-3);
  assert.ok(Math.abs(sum.top1.mean - 0.25) < 1e-3 && Math.abs(sum.last.mean - 0.25) < 1e-3, '4人分を合わせると1位・4位の持分は 0.25');
});

test('P3-2：シミュレーターの集計（summarize）も持分を使う', () => {
  const cases = filterCases(buildCases('down'), 'kaoru');
  const jobs = buildJobs({ cases, mode: 'math1', length: 4, groups: 1, seed: 1 });
  const template = playMatch({ mode: 'math1', length: 4, seats: ['kanata', 'mitsuki', 'aoto', 'kanata'], seedBase: 11 }).stats;
  const results = jobs.map((job) => ({ job, res: { scores: [100, 100, 100, 100], ranks: fracRanks([100, 100, 100, 100]), shares: placeShares([100, 100, 100, 100]), stats: template } }));
  const rep = summarize({ exp: 'down', mode: 'math1', length: 4, groups: 1, seed: 1, tune: {}, cases, results, seconds: 0 });
  const p = rep.cases[0].players.kaoru;
  assert.deepEqual([p.rank.mean, p.top1.mean, p.top2.mean, p.last.mean], [2.5, 0.25, 0.5, 0.25]);
  assert.equal(rep.levelAgg.down.advanced.top1.mean, 0.25);
  assert.equal(rep.matches.length, 4);
  assert.deepEqual(Object.keys(rep.matches[0]).sort(), ['caseId', 'g', 'ranks', 'rot', 'sample', 'scores', 'seats', 'seedBase'].sort());
});

test('P3-3：AUC は同点の予測を 0.5 と数え、行の順序に依存しない', () => {
  assert.equal(aucOf([0.5, 0.5], [1, 0]), 0.5);
  assert.equal(aucOf([0.1, 0.9], [0, 1]), 1);
  assert.equal(aucOf([0.9, 0.1], [0, 1]), 0);
  assert.equal(aucOf([0.2, 0.2, 0.2, 0.8], [0, 1, 0, 1]), (0.5 + 0.5 + 1 + 1) / 4);
  assert.equal(aucOf([0.3, 0.3], [1, 1]), null, '正例か負例がなければ定義しない');
  // 同点の多いデータを並べ替えても同じ
  const rng = createRng(5);
  const scores = Array.from({ length: 400 }, () => Math.floor(rng.next() * 5) / 5);
  const labels = scores.map((s) => (rng.next() < s ? 1 : 0));
  const base = aucOf(scores, labels);
  for (let t = 0; t < 20; t++) {
    const idx = scores.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    assert.ok(Math.abs(aucOf(idx.map((i) => scores[i]), idx.map((i) => labels[i])) - base) < 1e-12);
  }
  // 素朴な対の数え上げと一致
  let num = 0, den = 0;
  for (let i = 0; i < scores.length; i++) for (let j = 0; j < scores.length; j++) {
    if (labels[i] === 1 && labels[j] === 0) { den++; num += scores[i] > scores[j] ? 1 : scores[i] === scores[j] ? 0.5 : 0; }
  }
  assert.ok(Math.abs(base - num / den) < 1e-12);
});

test('P3-3：評価（Brier・確率帯）は行の順序に依存せず、確率帯の件数の和は行数', () => {
  const coef = [-2, 1];
  const rows = [[1, 0, 0], [1, 0, 1], [1, 2, 1], [1, 2, 0], [1, 4, 1], [1, -3, 0]];
  const a = evaluate(rows, coef), b = evaluate([...rows].reverse(), coef);
  assert.deepEqual(a, b);
  assert.equal(a.bins.reduce((s, x) => s + x.n, 0), rows.length);
  assert.ok(a.brier >= 0 && a.brier <= 1);
});

test('P3（再監査）：evaluate の境界：空データ・正例だけ・負例だけでも例外にならず、定義できない指標は null', () => {
  const coef = [-2, 0.8, -0.3];
  assert.deepEqual(evaluate([], coef), { rows: 0, ronRate: null, auc: null, brier: null, brierBaseline: null, bins: [] });
  const feats = [[1, 0, 0], [1, 2, 1], [1, -3, 2], [1, 4, 0]];
  for (const y of [1, 0]) {
    const r = evaluate(feats.map((f) => [...f, y]), coef);
    assert.equal(r.rows, 4);
    assert.equal(r.auc, null, '正例か負例だけでは AUC は定義できない');
    assert.equal(r.ronRate, y);
    assert.equal(r.brierBaseline, 0, '基準率だけの予測は全件正解');
    const p = feats.map((f) => 1 / (1 + Math.exp(-(coef[0] + coef[1] * f[1] + coef[2] * f[2]))));
    assert.equal(r.brier, +(p.reduce((s, x) => s + (x - y) ** 2, 0) / 4).toFixed(5), 'Brier は計算する');
    assert.equal(r.bins.reduce((s, b) => s + b.n, 0), 4);
    for (const b of r.bins) assert.equal(b.observed, y);
  }
  // 1件だけ
  const one = evaluate([[1, 0, 0, 1]], coef);
  assert.equal(one.auc, null);
  assert.equal(one.rows, 1);
});

test('P3（再監査）：通常データの AUC・Brier・確率帯は修正前（eb9a43b）と同じ値', () => {
  const coef = [-2, 0.8, -0.3];
  const rows = [];
  let x = 7;
  const next = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0);
  for (let i = 0; i < 300; i++) { const a = (next() % 9) - 3; const b = next() % 4; rows.push([1, a, b, (next() % 100) < 10 + a * 6 ? 1 : 0]); }
  // 修正前の evaluate() で求めた値（同じデータ）
  assert.deepEqual(evaluate(rows, coef), {
    rows: 300, ronRate: 0.1467, auc: 0.7326, brier: 0.16899, brierBaseline: 0.12516,
    bins: [
      { range: '0.003–0.01', n: 30, predicted: 0.0066, observed: 0 },
      { range: '0.01–0.03', n: 36, predicted: 0.0181, observed: 0 },
      { range: '0.03–0.1', n: 52, predicted: 0.057, observed: 0.0769 },
      { range: '0.1–0.3', n: 79, predicted: 0.1781, observed: 0.1646 },
      { range: '0.3–1', n: 103, predicted: 0.6238, observed: 0.2621 },
    ],
  });
});
