// 同じ実験・同じ seed で係数だけを変えた2つの結果（tools/sim-v06.mjs --out）を、挑戦者ごとに試合単位で対にして比べる。
//   node tools/compare-v06.mjs base.json variant.json
// 差＝変種の順位 − 基準の順位（負なら変種が強い）。95% 信頼区間は対の差の標準誤差 ×1.96。
import { readFileSync } from 'node:fs';
const [a, b] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, 'utf8')));
if (a.meta.seed !== b.meta.seed || a.meta.mode !== b.meta.mode || a.meta.length !== b.meta.length) throw new Error('seed/mode/length differ');
console.log(`mode=${a.meta.mode} length=${a.meta.length} seed=${a.meta.seed} tune(variant)=${JSON.stringify(b.meta.tune)}`);
console.log('| 形式 | 挑戦者 | 基準 平均順位 | 変種 平均順位 | 差（変種−基準）±95%CI | n |\n|---|---|---|---|---|---|');
let all = [];
for (const cb of b.cases) {
  if (!cb.challenger) continue;
  const ca = a.cases.find((c) => c.kind === cb.kind && c.challenger === cb.challenger);
  if (!ca) continue;
  const d = cb.challengerRanks.map((x, i) => x - ca.challengerRanks[i]);
  all = all.concat(d);
  const n = d.length, m = d.reduce((s, x) => s + x, 0) / n, sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  console.log(`| ${cb.kind} | ${cb.challenger} | ${ca.players[ca.challenger].rank.mean} | ${cb.players[cb.challenger].rank.mean} | ${m.toFixed(3)}±${(1.96 * sd / Math.sqrt(n)).toFixed(3)} | ${n} |`);
}
