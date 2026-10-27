// tools/sim-v06.mjs の結果から、キャラの個性に対応する指標を取り出す（同じ難易度の対局 same と、対Ver.0.5-E legacy）。
//   node tools/personality-v06.mjs result.json
import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const NAME = { kanata: 'かなた', mitsuki: 'みつき', aoto: 'あおと', ousuke: 'おうすけ', natsuki: 'なつき', yuki: 'ゆき', fukuyama: 'ふくやま', kaoru: 'かおる', asuma: 'アスマ' };
const f = (x, d = 3) => (x === null || x === undefined ? '-' : Number(x).toFixed(d));
const pc = (x) => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(1)}%`);
console.log(`mode=${r.meta.mode} length=${r.meta.length} seed=${r.meta.seed} groups=${r.meta.groups}`);
for (const c of r.cases.filter((c) => c.kind === 'same')) {
  console.log(`\n### 同じ難易度（${c.level}）：${c.lineup.map((x) => NAME[x] || x).join('・')}`);
  console.log('| 対象 | 平均順位 | 1位 | 2位以内 | 4位 | 1位+4位 | 和了/局 | 放銃/局 | 鳴き受諾率 | 下位時の鳴き率 | 1位時の鳴き率 | 鳴いた局の和了率 | 役なし鳴き局 | 門前和了率 | 和了点 | sin打牌率 | 手の中のsin率 | あおとからのロン比 | 流局時聴牌率 |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const id of c.lineup) {
    const p = c.players[id];
    console.log(`| ${NAME[id] || id} | ${f(p.rank.mean)}±${f(p.rank.ci95)} | ${pc(p.top1.mean)} | ${pc(p.top2.mean)} | ${pc(p.last.mean)} | ${pc(p.top1.mean + p.last.mean)} | ${f(p.perRound.win)} | ${f(p.perRound.dealIn)} | ${pc(p.claimRate)} | ${pc(p.claimRateTrailing)} | ${pc(p.claimRateLeading)} | ${pc(p.calledRoundWinRate)} | ${pc(p.yakulessCalledShare)} | ${pc(p.closedWinShare)} | ${f(p.avgWinPoints, 2)} | ${pc(p.sinDiscardShare)} | ${pc(p.sinHeldPerTile)} | ${pc(p.ronFromAotoShare)} | ${pc(p.tenpaiAtDraw)} |`);
  }
}
