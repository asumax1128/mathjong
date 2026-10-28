import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { evaluationJobs, tuningJobs, selectPolicy } from './trio-complete-plan.mjs';
const dir = process.argv[2] || 'tools/experiments/results/complete', testLog = readFileSync(process.argv[3] || '/tmp/trio-complete-tests-final.log', 'utf8');
const read = name => JSON.parse(readFileSync(`${dir}/${name}`));
const rows = name => gunzipSync(readFileSync(`${dir}/${name}.jsonl.gz`)).toString().trim().split('\n').map(x => JSON.parse(x));
const tuning = rows('tuning'), evaluation = rows('evaluation'), selection = read('selection.json'), plan = read('plan.json');
assert.deepEqual(selectPolicy(tuning), selection, '丸め修正によって今回の選択が変化した');
for (const [rs, jobs] of [[tuning, tuningJobs()], [evaluation, evaluationJobs(selection)]]) {
  assert.equal(rs.length, jobs.length); assert.equal(new Set(rs.map(x => x.sample)).size, jobs.length);
  const by = new Map(jobs.map(x => [x.sample, x]));
  for (const r of rs) { const j = by.get(r.sample); assert.ok(j); assert.deepEqual([r.seedBase, r.seats, r.experimental], [j.seedBase, j.seats, j.experimental]); }
}
for (const [file, expected] of Object.entries(plan.sources)) {
  assert.equal(createHash('sha256').update(readFileSync(`${dir}/source-at-run/${file}.txt`)).digest('hex'), expected);
  if (file !== 'trio-complete-plan.mjs') assert.equal(createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex'), expected);
}
const ts = new Set(tuning.map(x => x.seedBase)), es = new Set(evaluation.map(x => x.seedBase));
const tr = new Set(tuning.flatMap(x => x.logs.map(l => l.gameSeed))), er = new Set(evaluation.flatMap(x => x.logs.map(l => l.gameSeed)));
const overlap = { rootSeeds: [...ts].filter(x => es.has(x)).length, roundSeeds: [...tr].filter(x => er.has(x)).length };
assert.deepEqual(overlap, { rootSeeds: 0, roundSeeds: 0 });
const pass = +(testLog.match(/ℹ pass (\d+)/)?.[1] ?? NaN), fail = +(testLog.match(/ℹ fail (\d+)/)?.[1] ?? NaN), skip = +(testLog.match(/ℹ skipped (\d+)/)?.[1] ?? NaN);
assert.equal(pass, 391); assert.equal(fail, 0); assert.equal(skip, 0);
const result = { unitTests: { pass, fail, skip }, seedOverlap: overlap, replay: read('replay.json'), controls: read('controls.json'), benchmark: read('benchmark.json'),
  counts: { tuningMatches: tuning.length, evaluationMatches: evaluation.length, totalMatches: tuning.length + evaluation.length,
    tuningRounds: tuning.reduce((s, x) => s + x.played, 0), evaluationRounds: evaluation.reduce((s, x) => s + x.played, 0),
    tuningDecisions: tuning.reduce((s, r) => s + r.stats.reduce((n, x) => n + x.decisions, 0), 0) },
  recordedSourcesHashMatch: true, originalSelectionAndAllJobsMatchAfterRoundingFix: true };
writeFileSync(`${dir}/validation.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ unitTests: result.unitTests, counts: result.counts, seedOverlap: result.seedOverlap }));
