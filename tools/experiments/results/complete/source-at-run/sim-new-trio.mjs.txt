// 新3人の初期案専用。既存AI・ルールを変更せず、標本と各局の生データを保存する。
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createRules } from '../../src/engine/rules.js';
import { makeConfig } from '../../src/engine/config.js';
import { Game } from '../../src/engine/game.js';
import { createRng } from '../../src/engine/rng.js';
import { applyAction } from '../../src/engine/ai.js';
import { decideCharacter } from '../../src/engine/character-ai.js';
import { createMatch, dealerOf, applyRoundResult } from '../../src/engine/match.js';
import { NEW_CHARACTERS, publicGame, decideNewCharacter, liveWaits, opponentWeights } from './new-character-trio.mjs';

export const CASES = [
  ['control-low', ['kanata', 'mitsuki', 'aoto', 'ousuke']],
  ['control-mid', ['ousuke', 'natsuki', 'yuki', 'fukuyama']],
  ['control-high', ['fukuyama', 'kaoru', 'asuma', 'kanata']],
  ['yujin-low', ['yujin', 'kanata', 'mitsuki', 'aoto']],
  ['tara-mid', ['tara', 'ousuke', 'natsuki', 'yuki']],
  ['nocchi-high', ['nocchi', 'fukuyama', 'kaoru', 'asuma']],
  ['mixed', ['yujin', 'tara', 'nocchi', 'ousuke']],
  ...Object.keys(NEW_CHARACTERS).map(id => ['self-' + id, [id, id, id, id]]),
].map(([id, lineup]) => ({ id, lineup }));
const mix = (...xs) => xs.reduce((h, x) => (Math.imul(h ^ (x >>> 0), 0x9e3779b1) + 0x7f4a7c15) >>> 0, 0x12345678);
const hash = s => { let h = 0x811c9dc5; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0; return h; };
export function jobsFor({ groups = 4, seed = 206102801, only = '', modes = ['math1', 'math2'], lengths = [4, 8], cases = CASES } = {}) {
  const out = [];
  for (const c of cases.filter(c => !only || only.split(',').includes(c.id))) for (const mode of modes) for (const length of lengths) {
    for (let group = 0; group < groups; group++) for (let rot = 0; rot < (c.id.startsWith('self-') ? 1 : 4); rot++) {
      // 同じ組の4席回転は同じ山seed。4試合を独立標本として数えない。
      const seedBase = mix(seed, hash(c.id), hash(mode), length, group);
      out.push({ caseId: c.id, mode, length, group, rot, seedBase,
        sample: `${c.id}|${mode}|${length}|g${group}|r${rot}`,
        seats: c.lineup.map((_, s) => c.lineup[(s + rot) % 4]) });
    }
  }
  return out;
}
const rulesCache = new Map();
const rulesFor = mode => { if (!rulesCache.has(mode)) rulesCache.set(mode, createRules(makeConfig({ mode }))); return rulesCache.get(mode); };
function blank() { return { rounds: 0, wins: 0, ron: 0, tsumo: 0, dealIn: 0, chi: 0, pon: 0, riichi: 0,
  basePoints: 0, toitoi: 0, sanankou: 0, decisions: 0, ms: 0, maxMs: 0, discards: 0,
  readyDiscards: 0, heldRiichi: 0, declaredLive: 0, declaredCount: 0, weightSum: 0, weightN: 0, weightMin: 2, weightMax: 0 }; }
export function simulate(job) {
  const { mode, length, seats, seedBase } = job, rules = rulesFor(mode);
  let match = createMatch({ length });
  const stats = seats.map(blank), logs = [], history = seats.map(() => ({ rounds: 0, calls: 0, earlyRiichi: 0 }));
  while (!match.over) {
    const round = match.played + 1;
    if (round > 200) throw new Error('round cap ' + job.sample);
    const gameSeed = (seedBase + round * 7919) >>> 0;
    const game = new Game({ rules, seed: gameSeed, dealer: dealerOf(match), players: seats.map(name => ({ name, kind: 'ai', personality: 'speed' })) });
    const facades = seats.map((_, s) => publicGame(game, s));
    const rng = createRng((gameSeed ^ 0x5bd1e995) >>> 0);
    const info = { scores: match.scores.slice(), hand: match.hand, length, dealer: dealerOf(match), renchan: match.renchan,
      publicHistory: history.map(h => ({ ...h })), experimental: job.experimental || null };
    let actions = 0;
    while (game.pending()) {
      const p = game.pending(), s = p.seat, id = seats[s], st = stats[s];
      const t = performance.now();
      const a = NEW_CHARACTERS[id] ? decideNewCharacter(facades[s], s, id, rng, info) : decideCharacter(game, s, id, rng, info, seats);
      const dt = performance.now() - t;
      st.decisions++; st.ms += dt; st.maxMs = Math.max(st.maxMs, dt);
      if (p.canTsumo && a.type !== 'tsumo' || p.ron && a.type !== 'ron') throw new Error('missed win ' + id);
      if (id === 'yujin' && ['chi', 'pon'].includes(a.type)) throw new Error('yujin called');
      if (a.type === 'discard') {
        st.discards++;
        if (id === 'tara' && game.riichiOptions(s).length) {
          const wait = liveWaits(facades[s], s, a.tile);
          st.readyDiscards++;
          if (!a.riichi && wait.live > 0) st.heldRiichi++;
        }
        if (a.riichi) { st.riichi++; const wait = liveWaits(facades[s], s, a.tile); st.declaredLive += wait.live; st.declaredCount++; }
        if (id === 'nocchi') for (const [o, w] of opponentWeights(info.experimental?.nocchi?.adaptive === false ? [] : info.publicHistory).entries()) if (o !== s) {
          st.weightSum += w; st.weightN++; st.weightMin = Math.min(st.weightMin, w); st.weightMax = Math.max(st.weightMax, w);
        }
      }
      const before = game.events.length;
      const ok = applyAction(game, s, a);
      if (ok === false || game.events.length === before && game.pending()?.seat === s && game.pending()?.type === p.type) {
        // 見送りはイベントを増やさないことがあるが、宣言待ちの席は進む。
        throw new Error('action did not advance ' + JSON.stringify({ sample: job.sample, a, p }));
      }
      game.checkInvariants();
      if (++actions > 4000) throw new Error('action cap');
    }
    const result = game.result;
    for (const [s, st] of stats.entries()) {
      st.rounds++; history[s].rounds++;
      for (const ev of game.events.filter(e => e.seat === s)) {
        if (ev.type === 'chi' || ev.type === 'pon') { st[ev.type]++; history[s].calls++; }
        if (ev.type === 'riichi' && game.riichi[s].turn <= 6) history[s].earlyRiichi++;
      }
    }
    if (result.type === 'win') {
      const st = stats[result.winner]; st.wins++; st[result.how]++; st.basePoints += result.points;
      if (result.how === 'ron') stats[result.from].dealIn++;
      for (const y of result.analysis.yaku) if (y.id === 'toitoi' || y.id === 'sanankou') st[y.id]++;
    }
    const old = match;
    match = applyRoundResult(match, result);
    if (match.scores.reduce((a, b) => a + b, 0) !== 400) throw new Error('score conservation');
    logs.push({ round, gameSeed, dealer: dealerOf(old), hand: old.hand, renchan: old.renchan, result,
      scores: match.scores, actions, events: game.events });
  }
  if (match.played !== length + match.renchanTotal) throw new Error('round conservation');
  const shares = match.scores.map(x => { const h = match.scores.filter(y => y > x).length, t = match.scores.filter(y => y === x).length;
    return [0, 1, 2, 3].map(k => k >= h && k < h + t ? 1 / t : 0); });
  return { ...job, scores: match.scores, shares, ranks: shares.map(xs => xs.reduce((s, x, i) => s + x * (i + 1), 0)), stats,
    played: match.played, renchan: match.renchanTotal, logs };
}

if (!isMainThread && workerData?.newTrio) {
  for (const j of workerData.jobs) parentPort.postMessage({ result: simulate(j) });
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
  const config = { groups: +arg('groups', 4), seed: +arg('seed', 206102801), only: arg('only', ''),
    modes: arg('mode', 'math1,math2').split(','), lengths: arg('length', '4,8').split(',').map(Number) };
  const jobs = jobsFor(config), workers = Math.min(+arg('workers', 4), jobs.length), out = arg('out', '/tmp/new-trio.jsonl');
  if (!jobs.length || !Number.isInteger(config.groups) || config.groups < 1 || workers < 1) throw new Error('invalid arguments');
  const results = [], start = performance.now();
  console.log(JSON.stringify({ config, matches: jobs.length, workers, out }));
  await Promise.all(Array.from({ length: workers }, (_, i) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { newTrio: true, jobs: jobs.filter((_, j) => j % workers === i) } });
    worker.on('message', m => { results.push(m.result); if (results.length % 8 === 0) console.log(`${results.length}/${jobs.length} ${(performance.now() - start).toFixed(0)}ms`); });
    worker.on('error', reject); worker.on('exit', c => c ? reject(new Error('worker exit ' + c)) : resolve());
  })));
  results.sort((a, b) => a.sample.localeCompare(b.sample));
  if (results.length !== jobs.length || new Set(results.map(x => x.sample)).size !== jobs.length) throw new Error('missing/duplicate results');
  writeFileSync(out, results.map(x => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(out + '.meta.json', JSON.stringify({ config, matches: jobs.length, workers, seconds: (performance.now() - start) / 1000, node: process.version }, null, 2));
  console.log(JSON.stringify({ complete: results.length, seconds: (performance.now() - start) / 1000 }));
}
