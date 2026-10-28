import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRng } from '../../src/engine/rng.js';
import { createRules } from '../../src/engine/rules.js';
import { makeConfig } from '../../src/engine/config.js';
export const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
export function interval(values) {
  const n = values.length, center = mean(values);
  if (n < 2) return { mean: center, n, low: null, high: null, half: null };
  const t = [null, null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
    2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074,
    2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045][n] ?? 2.045;
  const half = t * Math.sqrt(values.reduce((s, x) => s + (x - center) ** 2, 0) / (n - 1) / n);
  return { mean: center, n, low: center - half, high: center + half, half };
}
const group = (xs, key) => { const out = new Map(); for (const x of xs) { const k = key(x); if (!out.has(k)) out.set(k, []); out.get(k).push(x); } return out; };
const rulesCache = new Map();
export function winningShapes(rows, id) {
  const concealedTriplets = [0, 0, 0, 0]; let wins = 0, closed = 0;
  for (const row of rows) {
    if (!rulesCache.has(row.mode)) rulesCache.set(row.mode, createRules(makeConfig({ mode: row.mode })));
    const rules = rulesCache.get(row.mode);
    for (const log of row.logs) {
      const r = log.result; if (r.type !== 'win' || row.seats[r.winner] !== id) continue;
      const analysis = r.analysis;
      const n = (analysis.concealedMelds || []).filter(m => rules.melds[m].kind === 'koutsu').length;
      concealedTriplets[n]++; wins++; if (!(analysis.exposedMelds || []).length) closed++;
    }
  }
  return { wins, closed, concealedTriplets, atLeastOne: wins ? (wins - concealedTriplets[0]) / wins : null,
    meaning: '実際に採用された最高得点の和了分解に含まれる門前刻子の組数。和了に至らない手や別分解は含めない。' };
}
export function samplesFor(rows, id) {
  return rows.flatMap(r => r.seats.flatMap((name, s) => name === id ? [{ ...r, seat: s, rank: r.ranks[s], points: r.scores[s], top: r.shares[s][0], last: r.shares[s][3], stats: r.stats[s] }] : []));
}
export function totals(xs) {
  const sum = k => xs.reduce((s, x) => s + x.stats[k], 0), rounds = sum('rounds'), wins = sum('wins');
  return { matches: new Set(xs.map(x => x.sample)).size, seatSamples: xs.length, rounds, wins, winRate: wins / rounds,
    dealIn: sum('dealIn'), dealInRate: sum('dealIn') / rounds, chi: sum('chi'), pon: sum('pon'), riichi: sum('riichi'),
    meanBasePoints: wins ? sum('basePoints') / wins : null, sanankou: sum('sanankou'), toitoi: sum('toitoi'),
    rank: mean(xs.map(x => x.rank)), points: mean(xs.map(x => x.points)), topRate: mean(xs.map(x => x.top)), lastRate: mean(xs.map(x => x.last)),
    ready: sum('readyDiscards'), held: sum('heldRiichi'), meanDeclaredLive: sum('declaredCount') ? sum('declaredLive') / sum('declaredCount') : null,
    decisions: sum('decisions'), meanDecisionMs: sum('ms') / sum('decisions'), maxDecisionMs: Math.max(...xs.map(x => x.stats.maxMs)) };
}
// 固定されたモード/局数/相手層の各層内で、4席を一巡した組を復元抽出する。
export function stratifiedRankCI(xs, seed = 2851028, repetitions = 10000) {
  xs = xs.slice().sort((a, b) => `${a.mode}|${a.length}|${a.caseId}`.localeCompare(`${b.mode}|${b.length}|${b.caseId}`) || a.group - b.group || a.rot - b.rot);
  const strata = [...group(xs, x => `${x.mode}|${x.length}|${x.caseId}`).values()].map(rs => [...group(rs, x => x.group).values()].map(gs => mean(gs.map(x => x.rank))));
  const rng = createRng(seed), values = [];
  for (let b = 0; b < repetitions; b++) values.push(mean(strata.map(gs => mean(gs.map(() => rng.pick(gs))))));
  values.sort((a, b) => a - b);
  return { mean: mean(strata.map(mean)), low: values[Math.floor(repetitions * 0.025)], high: values[Math.floor(repetitions * 0.975)], strata: strata.length,
    groups: strata.reduce((s, xs) => s + xs.length, 0), repetitions, seed, method: 'stratified cluster percentile bootstrap; nominal exploratory 95%, not adjusted for multiple comparisons' };
}
export function paired(rows, id) {
  rows = rows.slice().sort((a, b) => a.sample.localeCompare(b.sample));
  const final = samplesFor(rows.filter(r => r.variant === 'final'), id), alternate = samplesFor(rows.filter(r => r.variant === 'ablate-' + id), id);
  const fm = new Map(final.map(x => [x.pair, x]));
  if (new Set(alternate.map(x => x.pair)).size !== alternate.length) throw new Error('duplicate alternate pair');
  const pairs = alternate.map(a => {
    const b = fm.get(a.pair);
    if (!b || JSON.stringify([a.seedBase, a.seats, a.mode, a.length, a.group, a.rot]) !== JSON.stringify([b.seedBase, b.seats, b.mode, b.length, b.group, b.rot])) throw new Error('pair mismatch');
    return { a, b, delta: b.rank - a.rank, pointDelta: b.points - a.points };
  });
  const sections = [...group(pairs, x => `${x.a.mode}|${x.a.length}`).entries()].map(([condition, ps]) => {
    const gs = [...group(ps, x => x.a.group).values()];
    return { condition, matches: ps.length, rankDelta: interval(gs.map(xs => mean(xs.map(x => x.delta)))), pointDelta: interval(gs.map(xs => mean(xs.map(x => x.pointDelta)))), final: totals(ps.map(x => x.b)), alternate: totals(ps.map(x => x.a)) };
  });
  const groups = [...group(pairs, x => `${x.a.mode}|${x.a.length}|${x.a.group}`).values()];
  return { id, pairs: pairs.length, rankDelta: interval(groups.map(xs => mean(xs.map(x => x.delta)))), pointDelta: interval(groups.map(xs => mean(xs.map(x => x.pointDelta)))), sections };
}
export function analyze(rows) {
  rows = rows.slice().sort((a, b) => a.sample.localeCompare(b.sample));
  const final = rows.filter(r => r.variant === 'final'), ids = ['yujin', 'tara', 'nocchi'];
  if (new Set(rows.map(r => r.sample)).size !== rows.length) throw new Error('duplicate samples');
  for (const r of rows) {
    if (r.scores.reduce((a, b) => a + b, 0) !== 400 || r.played !== r.length + r.renchan) throw new Error('invalid match');
    for (const l of r.logs) if (l.scores.reduce((a, b) => a + b, 0) !== 400) throw new Error('invalid round');
  }
  const peer = final.filter(r => ids.some(id => r.caseId.startsWith(id + '-')));
  const people = Object.fromEntries(ids.map(id => {
    const ownPeers = samplesFor(peer.filter(r => r.caseId.startsWith(id + '-')), id), mixed = samplesFor(final.filter(r => r.caseId === 'mixed'), id);
    const byCondition = [...group(ownPeers, x => `${x.mode}|${x.length}`).entries()].map(([condition, xs]) => ({ condition, ...totals(xs), rankCI: stratifiedRankCI(xs) }));
    const byOpponent = [...group(ownPeers, x => `${x.mode}|${x.length}|${x.caseId}`).entries()].map(([condition, xs]) => ({ condition, ...totals(xs), rankCI: interval([...group(xs, x => x.group).values()].map(gs => mean(gs.map(x => x.rank)))) }));
    return [id, { peers: { ...totals(ownPeers), rankCI: stratifiedRankCI(ownPeers) }, byCondition, byOpponent,
      mixed: { ...totals(mixed), rankCI: stratifiedRankCI(mixed) }, allHeterogeneous: totals([...ownPeers, ...mixed]),
      shapes: winningShapes(final.filter(r => !r.caseId.startsWith('self-')), id),
      self: totals(samplesFor(final.filter(r => r.caseId === 'self-' + id), id)) }];
  }));
  return { evaluationMatches: rows.length, finalMatches: final.length, rounds: rows.reduce((s, r) => s + r.played, 0),
    decisions: rows.reduce((s, r) => s + r.stats.reduce((n, x) => n + x.decisions, 0), 0), draws: rows.reduce((s, r) => s + r.logs.filter(l => l.result.type === 'draw').length, 0),
    people, paired: ids.map(id => paired(rows, id)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = process.argv[2], bytes = readFileSync(src), text = (src.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8');
  const result = analyze(text.trim().split('\n').map(x => JSON.parse(x)));
  writeFileSync(process.argv[3] || '/tmp/trio-complete-analysis.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ matches: result.evaluationMatches, rounds: result.rounds, decisions: result.decisions, draws: result.draws }));
}
