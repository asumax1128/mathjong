import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { playMatch } from '../sim-v06.mjs';
const src = process.argv[2], bytes = readFileSync(src);
const rows = (src.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString().trim().split('\n').map(x => JSON.parse(x));
const chosen = rows.filter(r => r.variant === 'final' && r.caseId.startsWith('control-') && r.group === 0 && r.rot === 0);
let rounds = 0;
for (const row of chosen) {
  const old = playMatch(row); assert.deepEqual(old.scores, row.scores); assert.deepEqual(old.ranks, row.ranks); assert.deepEqual(old.shares, row.shares);
  for (let s = 0; s < 4; s++) for (const key of ['rounds','wins','ron','tsumo','dealIn','chi','pon','riichi','discards']) assert.equal(old.stats[s][key], row.stats[s][key], `${row.sample} ${s} ${key}`);
  rounds += row.played;
}
assert.equal(chosen.length, 12);
const report = { matches: chosen.length, rounds, modes: ['math1','math2'], lengths: [4,8], opponents: '既存9人。各層の対照3卓、group0/rot0。元のsim-v06.playMatchを直接実行し、最終点・順位持分・行動集計を照合。' };
writeFileSync(process.argv[3] || '/tmp/trio-controls-verification.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
