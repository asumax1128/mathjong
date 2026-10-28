// tools/sim-v06.mjs の JSON 出力を、Markdown の表にまとめる。
//   node tools/summarize-v06.mjs result.json [result2.json ...]
import { readFileSync } from 'node:fs';

const NAME = { kanata: 'かなた', mitsuki: 'みつき', aoto: 'あおと', ousuke: 'おうすけ', natsuki: 'なつき', yuki: 'ゆき', fukuyama: 'ふくやま', kaoru: 'かおる', asuma: 'アスマ' };
const nm = (id) => NAME[id] || id.replace(/^L:/, 'v0.5E:');
const ci = (x) => (x && x.mean !== null ? `${x.mean.toFixed(3)}±${x.ci95.toFixed(3)}` : '-');
const pct = (x) => (x && x.mean !== null ? `${(x.mean * 100).toFixed(1)}%` : '-');
const f = (x, d = 3) => (x === null || x === undefined ? '-' : Number(x).toFixed(d));

for (const file of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(file, 'utf8'));
  const m = r.meta;
  console.log(`\n## ${file}\nmode=${m.mode} length=${m.length} groups=${m.groups} seed=${m.seed} matches=${m.matches} seconds=${m.seconds}\n`);
  if (r.levelAgg) {
    console.log('| 形式 | 難易度（挑戦者） | 平均順位±95%CI | 1位率 | n |\n|---|---|---|---|---|');
    for (const [kind, ls] of Object.entries(r.levelAgg)) for (const [l, v] of Object.entries(ls)) console.log(`| ${kind} | ${l} | ${ci(v.rank)} | ${pct(v.top1)} | ${v.n} |`);
  }
  console.log('\n| 形式 | 対象 | 平均順位±95%CI | 1位 | 2位以内 | 4位 | 平均点 | 和了/局 | 放銃/局 | チー/局 | ポン/局 | リーチ/局 | 和了点 | 門前和了率 | ms/判断 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of r.cases) {
    const ids = c.challenger ? [c.challenger] : c.lineup;
    for (const id of ids) {
      const p = c.players[id];
      const vs = c.challenger ? ` vs ${c.lineup.slice(1).map(nm).join('・')}` : '';
      console.log(`| ${c.kind}${vs} | ${nm(id)} | ${ci(p.rank)} | ${pct(p.top1)} | ${pct(p.top2)} | ${pct(p.last)} | ${f(p.points.mean, 1)} | ${f(p.perRound.win)} | ${f(p.perRound.dealIn)} | ${f(p.perRound.chi)} | ${f(p.perRound.pon)} | ${f(p.perRound.riichi)} | ${f(p.avgWinPoints, 2)} | ${f(p.closedWinShare)} | ${f(p.msPerDecision, 2)} |`);
    }
  }
}
