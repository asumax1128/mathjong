// 予定試合をすべて完了する。各試合を即時保存し、未使用seed評価は調整と分離する。
import { Worker } from 'node:worker_threads';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PLAN, tuningJobs, evaluationJobs, selectPolicy } from './trio-complete-plan.mjs';

const outDir = process.argv[2] || 'tools/experiments/results/complete';
mkdirSync(outDir, { recursive: true });
const sourceFiles = ['new-character-trio.mjs', 'sim-new-trio.mjs', 'trio-complete-plan.mjs', 'trio-complete-worker.mjs', 'run-trio-complete.mjs'];
const sources = Object.fromEntries(sourceFiles.map(f => [f, createHash('sha256').update(readFileSync(new URL(f, import.meta.url))).digest('hex')]));
const metadata = { plan: PLAN, sources, node: process.version, prior: '5b694ab18bd31ca9a472d40e26ec046a1e88fc95', plannedNewMatches: 2112 };
const metaPath = outDir + '/plan.json';
if (existsSync(metaPath) && JSON.stringify(JSON.parse(readFileSync(metaPath))) !== JSON.stringify(metadata)) throw new Error('plan/source changed; use a new output directory');
writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + '\n');
function readRows(path) { return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)) : []; }
async function runStage(name, jobs) {
  const path = `${outDir}/${name}.jsonl`, results = readRows(path), seen = new Set(results.map(x => x.sample));
  const byId = new Map(jobs.map(j => [j.sample, j]));
  if (seen.size !== results.length || jobs.length !== byId.size) throw new Error('duplicate sample');
  for (const row of results) {
    const job = byId.get(row.sample);
    if (!job || JSON.stringify([job.seedBase, job.seats, job.experimental]) !== JSON.stringify([row.seedBase, row.seats, row.experimental])) throw new Error('invalid resumed sample');
  }
  const todo = jobs.filter(j => !seen.has(j.sample)); let cursor = 0, count = results.length;
  const start = performance.now(), workers = [];
  const progress = done => {
    const p = { phase: name, complete: count, total: jobs.length, elapsedSeconds: (performance.now() - start) / 1000, done };
    writeFileSync(outDir + '/progress.json', JSON.stringify(p, null, 2) + '\n');
    console.log(JSON.stringify(p));
  };
  progress(false);
  try {
    await Promise.all(Array.from({ length: Math.min(PLAN.workers, todo.length) }, () => new Promise((resolve, reject) => {
      const w = new Worker(new URL('./trio-complete-worker.mjs', import.meta.url)); workers.push(w);
      const next = () => w.postMessage(cursor < todo.length ? todo[cursor++] : null);
      w.on('message', msg => {
        if (msg.error) return reject(new Error(msg.sample + '\n' + msg.error));
        appendFileSync(path, JSON.stringify(msg.result) + '\n');
        results.push(msg.result); count++;
        if (count % 32 === 0 || count === jobs.length) progress(false);
        next();
      });
      w.on('error', reject); w.on('exit', code => code ? reject(new Error('worker exit ' + code)) : resolve()); next();
    })));
  } catch (e) { await Promise.all(workers.map(w => w.terminate())); throw e; }
  if (results.length !== jobs.length) throw new Error('incomplete stage');
  progress(true); return results;
}
const tuning = await runStage('tuning', tuningJobs());
const selection = selectPolicy(tuning);
writeFileSync(outDir + '/selection.json', JSON.stringify(selection, null, 2) + '\n');
console.log(JSON.stringify({ selection }));
const evaluation = await runStage('evaluation', evaluationJobs(selection));
writeFileSync(outDir + '/finished.json', JSON.stringify({ tuning: tuning.length, evaluation: evaluation.length, total: tuning.length + evaluation.length, selected: selection.selected }, null, 2) + '\n');
console.log('COMPLETE');
