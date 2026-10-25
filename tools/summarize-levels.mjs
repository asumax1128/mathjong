// tools/validate-levels.sh の結果（JSON）を Markdown の表にまとめる（Ver.0.4-B）
// 使い方: node tools/summarize-levels.mjs OUTDIR
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
// 実行中（空）のファイルは除く
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && readFileSync(join(dir, f), 'utf8').trim()).sort();
const rs = files.map((f) => ({ name: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
const LV = { beginner: '初級', intermediate: '中級', advanced: '上級' };
const f2 = (x) => (x >= 0 ? `+${x.toFixed(2)}` : x.toFixed(2));

console.log('### 異なる難易度の対戦（A − B、組ごとの平均の差、±は標準誤差、[ ] は95%信頼区間）\n');
console.log('| モード | 局数 | 形式 | A | B | 組／試合 | 平均順位の差 | 平均得点の差 | A 平均順位 | B 平均順位 | A 1位率 | B 1位率 | A 平均得点 | B 平均得点 |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rs.filter((x) => x.format !== 'same')) {
  const a = r.levels[r.a];
  const b = r.levels[r.b];
  console.log(`| ${r.mode === 'math1' ? '数学Ⅰ' : '数学Ⅱ'} | ${r.length} | ${r.format} | ${LV[r.a]} | ${LV[r.b]} | ${r.groups}／${r.matches} | ${f2(r.diff.rank.mean)}±${r.diff.rank.se.toFixed(3)} [${r.diff.rank.ci95.map((x) => x.toFixed(2)).join(', ')}] | ${f2(r.diff.score.mean)}±${r.diff.score.se.toFixed(2)} | ${a.meanRank} | ${b.meanRank} | ${a.topRate} | ${b.topRate} | ${a.meanScore} | ${b.meanScore} |`);
}
console.log('\n### 1人あたりの行動（1試合あたり）と判断時間（異なる難易度の対戦）\n');
console.log('| モード | 局数 | 対戦 | 難易度 | 和了 | ロン | ツモ | 放銃 | チー | ポン | 判断の平均 ms | 打牌の平均 ms | 最大 ms |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rs.filter((x) => x.format !== 'same')) {
  for (const lv of [r.a, r.b]) {
    const s = r.levels[lv];
    console.log(`| ${r.mode === 'math1' ? '数学Ⅰ' : '数学Ⅱ'} | ${r.length} | ${LV[r.a]} vs ${LV[r.b]} | ${LV[lv]} | ${s.winsPerMatch} | ${s.ronPerMatch} | ${s.tsumoPerMatch} | ${s.dealInPerMatch} | ${s.chiPerMatch} | ${s.ponPerMatch} | ${s.msPerDecision} | ${s.msPerDiscard} | ${s.maxMsDecision} |`);
  }
}
console.log('\n### 4人とも同じ難易度（試合の様子）\n');
console.log('| モード | 局数 | 難易度 | 試合 | 1試合の局数 | 流局率 | 1人の和了 | ロン | ツモ | チー | ポン | 判断の平均 ms | 打牌の平均 ms | 最大 ms |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rs.filter((x) => x.format === 'same')) {
  const s = r.levels[r.a];
  console.log(`| ${r.mode === 'math1' ? '数学Ⅰ' : '数学Ⅱ'} | ${r.length} | ${LV[r.a]} | ${r.matches} | ${r.roundsPerMatch} | ${r.drawRate} | ${s.winsPerMatch} | ${s.ronPerMatch} | ${s.tsumoPerMatch} | ${s.chiPerMatch} | ${s.ponPerMatch} | ${s.msPerDecision} | ${s.msPerDiscard} | ${s.maxMsDecision} |`);
}
const secs = rs.reduce((t, r) => t + r.seconds, 0);
console.log(`\n実行時間の合計：${(secs / 60).toFixed(1)} 分（4プロセス並列）。seed：${[...new Set(rs.map((r) => r.seed))].join(', ')}`);
