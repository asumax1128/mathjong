import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { createRules } from '../../src/engine/rules.js';
import { makeConfig } from '../../src/engine/config.js';
import { Game } from '../../src/engine/game.js';
import { createRng } from '../../src/engine/rng.js';
import { applyAction } from '../../src/engine/ai.js';
import { decideNewCharacter, publicGame } from './new-character-trio.mjs';

const report = { node: process.version, unit: 'milliseconds', concurrency: 1, meaning: 'Node単一プロセス。32個の異なる配牌、非和了の最初の手番。Safari/実ゲームの最大遅延の保証ではない。', cacheNote: '各モードでnocchi→tara→yujinの順。nocchiのfirstMsはモードの共通評価キャッシュ作成を含む。tara/yujinのfirstMsは共通キャッシュが既に温まっており、全キャラの冷起動比較ではない。', conditions: [] };
for (const mode of ['math2', 'math1']) {
  const t0 = performance.now(), rules = createRules(makeConfig({ mode })), rulesMs = performance.now() - t0;
  for (const id of ['nocchi', 'tara', 'yujin']) {
    const times = []; let firstMs = null;
    for (let seed = 915010; times.length < 32; seed++) {
      const game = new Game({ rules, seed, dealer: 0, players: [0,1,2,3].map(s => ({ kind: 'ai', name: String(s), personality: 'speed' })) }); if (game.pending().canTsumo) continue;
      const own = publicGame(game, 0), start = performance.now();
      const a = decideNewCharacter(own, 0, id, createRng(seed ^ 0x5bd1e995), { publicHistory: [0,1,2,3].map(() => ({ rounds: 5, calls: 2, earlyRiichi: 1 })) });
      const ms = performance.now() - start; if (firstMs === null) firstMs = ms; times.push(ms);
      applyAction(game, 0, a); game.checkInvariants();
    }
    const warm = times.slice(1).sort((a,b) => a-b);
    report.conditions.push({ mode, id, rulesMs, firstMs, warmMeanMs: warm.reduce((a,b) => a+b,0) / warm.length,
      warmMedianMs: warm[Math.floor(warm.length / 2)], warmP95Ms: warm[Math.floor(warm.length * .95)], warmMaxMs: Math.max(...warm) });
  }
}
writeFileSync(process.argv[2] || '/tmp/trio-benchmark.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
