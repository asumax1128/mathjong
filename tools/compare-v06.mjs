// 同じ実験・同じ seed で係数だけを変えた2つの結果（tools/sim-v06.mjs --out）を、挑戦者ごとに試合単位で対にして比べる。
//   node tools/compare-v06.mjs base.json variant.json
// 差＝変種の順位 − 基準の順位（負なら変種が強い）。95% 信頼区間は対の差の標準誤差 ×1.96。
// 試合の対応付けは、試合ごとの記録（matches：標本ID・seed・席の並び）で行う。両方にある同じケースID の試合だけを対にし、
// そのケースの標本の集合・各標本の seed・席の並びが一致しなければエラー（--only の違いで同じケースの条件が変わった場合などを検出）。
// 片方にしかないケースは比べない（一覧を表示）。試合ごとの記録がない旧形式の結果はエラー。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function pairResults(a, b) {
  for (const k of ['seed', 'mode', 'length']) if (a.meta[k] !== b.meta[k]) throw new Error(`${k} differ: ${a.meta[k]} / ${b.meta[k]}`);
  if ((a.meta.human || null) !== (b.meta.human || null)) throw new Error(`human differ: ${a.meta.human} / ${b.meta.human}`);
  const sa = a.meta.seedScheme || 'index', sb = b.meta.seedScheme || 'index';
  if (sa !== sb) throw new Error(`seed scheme differ: ${sa} / ${sb}`);
  if (!Array.isArray(a.matches) || !Array.isArray(b.matches)) throw new Error('試合ごとの記録（matches）がない旧形式の結果は対にできない');
  const index = (r) => {
    const m = new Map();
    for (const x of r.matches) {
      if (m.has(x.sample)) throw new Error(`duplicate sample ${x.sample}`);
      m.set(x.sample, x);
    }
    return m;
  };
  const ma = index(a), mb = index(b);
  const rows = [], skipped = [];
  for (const cb of b.cases) {
    if (!cb.challenger) continue;
    const ca = a.cases.find((c) => c.id === cb.id);
    if (!ca) { skipped.push(cb.id); continue; }
    const samples = cb.challengerSamples;
    const sA = new Set(ca.challengerSamples), sB = new Set(samples);
    if (sA.size !== sB.size || [...sB].some((x) => !sA.has(x))) throw new Error(`case ${cb.id}: 標本の集合が一致しない（groups などが違う）`);
    const diffs = samples.map((smp) => {
      const x = ma.get(smp), y = mb.get(smp);
      if (!x || !y) throw new Error(`sample ${smp}: 試合の記録がない`);
      if (x.seedBase !== y.seedBase) throw new Error(`sample ${smp}: seed が一致しない（${x.seedBase} / ${y.seedBase}）`);
      if (x.seats.join(',') !== y.seats.join(',')) throw new Error(`sample ${smp}: 席の並びが一致しない`);
      const s = y.seats.indexOf(cb.challenger);
      return y.ranks[s] - x.ranks[s];
    });
    rows.push({ id: cb.id, kind: cb.kind, level: cb.level, challenger: cb.challenger, base: ca.players[ca.challenger].rank.mean, variant: cb.players[cb.challenger].rank.mean, diffs });
  }
  for (const ca of a.cases) if (ca.challenger && !b.cases.some((c) => c.id === ca.id)) skipped.push(ca.id);
  return { rows, skipped };
}

const stat = (d) => {
  const n = d.length, m = d.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)) : 0;
  return `${m.toFixed(3)}±${(1.96 * sd / Math.sqrt(n)).toFixed(3)}`;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [a, b] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const { rows, skipped } = pairResults(a, b);
  console.log(`mode=${a.meta.mode} length=${a.meta.length} seed=${a.meta.seed} seedScheme=${a.meta.seedScheme || 'index'} tune(variant)=${JSON.stringify(b.meta.tune)}`);
  console.log('| 形式 | 挑戦者 | 基準 平均順位 | 変種 平均順位 | 差（変種−基準）±95%CI | n |\n|---|---|---|---|---|---|');
  let all = [];
  for (const r of rows) {
    all = all.concat(r.diffs);
    console.log(`| ${r.kind}${r.level ? `(vs ${r.level})` : ''} | ${r.challenger} | ${r.base} | ${r.variant} | ${stat(r.diffs)} | ${r.diffs.length} |`);
  }
  if (all.length) console.log(`| 全体 | （対にした全試合） | | | ${stat(all)} | ${all.length} |`);
  if (skipped.length) console.log(`\n片方にしかないケース（比べない）：${skipped.join(' / ')}`);
}
