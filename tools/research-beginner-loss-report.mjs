// 研究専用（docs/69）：research-beginner-loss-diagnostics.mjs の JSON から、キャラクター別の比較表（Markdown）を作る。
// 使い方：node tools/research-beginner-loss-report.mjs <result.json> [out.md]
import { readFileSync, writeFileSync } from 'node:fs';

const [file, outFile] = process.argv.slice(2);
const d = JSON.parse(readFileSync(file, 'utf8'));
const pct = (r) => (r ? `${(r.rate * 100).toFixed(1)}%` : '—');
const ci = (r) => (r ? `${(r.rate * 100).toFixed(1)}% (${(r.lo * 100).toFixed(1)}–${(r.hi * 100).toFixed(1)})` : '—');
const num = (m, f = 2) => (m ? m.mean.toFixed(f) : '—');
const MODE = { math1: '数学Ⅰ', math2: '数学Ⅱ' };
const lines = [];
const P = (s = '') => lines.push(s);

P('# 初級AI・初心者代理の行動別診断：比較表');
P();
P(`生成元：\`${file}\`（seed0 ${d.definition.seed0}・scale ${d.definition.scale}・${d.seconds ? `${Math.round(d.seconds)}秒` : ''}）。現行ルール（ruleset 2・宣言料${d.definition.riichiDeposit}点・アガリやめ）。`);
P(`割合の分母は合法な選択機会。括弧は95% Wilson 区間。初心者代理は研究モデルで、実際の人間の勝率ではない。`);
P();

function agentTable(sum, ids) {
  P('| 担当 | 試合 | 1位率 | 4位率 | 平均順位 | 平均点 | 局 | 和了率 | 平均和了点 | ロン/ツモ | 放銃率 | 聴牌到達率 | 初聴牌巡 | 初聴牌の残り枚数 | 聴牌を保つ打牌の選択率 | リーチ（機会局→宣言） | リーチ後和了 | 鳴いた局 | 和了率 鳴き/門前 | 鳴き聴牌の役なし |');
  P('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const id of ids) {
    const a = sum.agents[id];
    if (!a) continue;
    P(`| ${a.name} | ${a.matches} | ${ci(a.result.top)} | ${pct(a.result.last)} | ${num(a.result.meanRank)} | ${num(a.result.meanScore, 1)} | ${a.rounds} | ${ci(a.win.rate)} | ${num(a.win.meanPoints)} | ${a.win.ron}/${a.win.tsumo} | ${pct(a.dealIn.rate)} | ${pct(a.tenpai.roundRate)} | ${num(a.tenpai.meanFirstTurn, 1)} | ${num(a.tenpai.firstLive, 1)} | ${pct(a.tenpai.keepTenpai)} | ${a.riichi.oppRounds}→${a.riichi.declaredRounds}（${pct(a.riichi.declareRateByRound)}） | ${pct(a.riichi.winAfterRiichi)} | ${pct(a.calls.roundsWithCalls)} | ${pct(a.calls.winRateCalled)} / ${pct(a.calls.winRateClosed)} | ${pct(a.calls.yakulessTenpaiCalled)} |`);
  }
  P();
}
function roundTable(rows) {
  P('| 条件 | 局 | 和了率 | 流局率 | 流局の内訳 | 流局時の聴牌人数 | 1局のリーチ | 1局の鳴き | 1局の手番数 |');
  P('|---|---|---|---|---|---|---|---|---|');
  for (const [label, t] of rows) P(`| ${label} | ${t.rounds} | ${pct(t.winRate)} | ${ci(t.drawRate)} | ${Object.entries(t.drawReasons).map(([k, v]) => `${k}:${v}`).join(' ') || '—'} | ${num(t.tenpaiPlayersAtDraw)} | ${num(t.riichiPerRound)} | ${num(t.callsPerRound)} | ${num(t.turnsPerRound, 1)} |`);
  P();
}

P('## 1. 初級AI 4人（同じ seed・親で席を4通りに回す）');
for (const mode of ['math1', 'math2']) for (const len of [1, 4, 8]) {
  const c = d.cells[`ai4:baseline:${mode}:${len}`];
  if (!c) continue;
  P(`### ${MODE[mode]}・${len}局戦`);
  agentTable(c.ai4, ['kanata', 'mitsuki', 'aoto', 'yujin']);
}

P('## 2. 初心者代理（基本／リーチ＋限定チー）＋初級AI 3人（同じ seed・親・相手・席のペア）');
for (const mode of ['math1', 'math2']) for (const len of [1, 4, 8]) {
  const c = d.cells[`novice:baseline:${mode}:${len}`];
  if (!c) continue;
  P(`### ${MODE[mode]}・${len}局戦`);
  P('**初心者代理の4つの版（同じ seed・相手・席）**');
  agentTable({ agents: Object.fromEntries(['novice-basic', 'novice-keep', 'novice-riichi', 'novice-smart'].map((v) => [v, c[v].agents[v]])) }, ['novice-basic', 'novice-keep', 'novice-riichi', 'novice-smart']);
  P('**相手（初級AI）：基本の代理と対戦したとき**');
  agentTable(c['novice-basic'], ['kanata', 'mitsuki', 'aoto', 'yujin']);
  P('| 段階のペア比較 | 組 | 上／下／同じ | 順位差の平均（95%） | 点差の平均（95%） |');
  P('|---|---|---|---|---|');
  const pr = (label, p) => P(`| ${label} | ${p.pairs} | ${p.smartBetter}／${p.smartWorse}／${p.same} | ${num(p.meanRankDiff)}（${p.meanRankDiff.lo}〜${p.meanRankDiff.hi}） | ${num(p.meanScoreDiff, 1)}（${p.meanScoreDiff.lo}〜${p.meanScoreDiff.hi}） |`);
  pr('聴牌を保つ vs 基本', c.steps.keepVsBasic);
  pr('＋リーチ vs 聴牌を保つ', c.steps.riichiVsKeep);
  pr('＋チー vs ＋リーチ', c.steps.chiVsRiichi);
  pr('スマート vs 基本（全体）', c.paired);
  P('順位差は負なら後者が上。点差は正なら後者が多い。');
  P();
}

P('## 3. 局の結果と流局（現行の係数 vs 研究条件 easy＝既存研究PRの弱体化設定、同じ seed）');
const rows = [];
for (const mode of ['math1', 'math2']) {
  for (const len of [1, 4, 8]) { const c = d.cells[`ai4:baseline:${mode}:${len}`]; if (c) rows.push([`${MODE[mode]}・${len}局戦・初級4人・現行`, c.ai4.table]); }
  const e = d.cells[`ai4:easy:${mode}:4`]; if (e) rows.push([`${MODE[mode]}・4局戦・初級4人・**easy**`, e.ai4.table]);
  for (const len of [1, 4, 8]) { const c = d.cells[`novice:baseline:${mode}:${len}`]; if (c) for (const v of ['novice-basic', 'novice-keep', 'novice-riichi', 'novice-smart']) rows.push([`${MODE[mode]}・${len}局戦・${c[v].agents[v].name}`, c[v].table]); }
}
roundTable(rows);
P('### easy（研究条件）のキャラクター別（4局戦）');
for (const mode of ['math1', 'math2']) { const e = d.cells[`ai4:easy:${mode}:4`]; if (e) { P(`#### ${MODE[mode]}`); agentTable(e.ai4, ['kanata', 'mitsuki', 'aoto', 'yujin']); } }

P('## 4. あおとの反実仮想（研究用・公開係数ではない）：4局戦、同じ seed・席の回し方');
P('| 条件 | 数学 | あおと 1位率 | 4位率 | 平均順位 | 和了率 | 放銃率 | 聴牌到達率 | 鳴いた局 | 和了率 鳴き/門前 | かなた 1位率 | みつき 1位率 | ゆうじん 1位率 | 流局率 |');
P('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const mode of ['math1', 'math2']) for (const [sc, label] of [['baseline', '現行'], ['aotoNoCall', '鳴かない'], ['aotoNoRandom', '雑な打牌なし'], ['aotoNoCallNoRandom', '両方なし']]) {
  const c = d.cells[`ai4:${sc}:${mode}:4`];
  if (!c) continue;
  const A = c.ai4.agents, a = A.aoto;
  P(`| ${label} | ${MODE[mode]} | ${ci(a.result.top)} | ${pct(a.result.last)} | ${num(a.result.meanRank)} | ${ci(a.win.rate)} | ${pct(a.dealIn.rate)} | ${pct(a.tenpai.roundRate)} | ${pct(a.calls.roundsWithCalls)} | ${pct(a.calls.winRateCalled)} / ${pct(a.calls.winRateClosed)} | ${pct(A.kanata.result.top)} | ${pct(A.mitsuki.result.top)} | ${pct(A.yujin.result.top)} | ${pct(c.ai4.table.drawRate)} |`);
}
P();

const md = lines.join('\n') + '\n';
if (outFile) writeFileSync(outFile, md); else process.stdout.write(md);
