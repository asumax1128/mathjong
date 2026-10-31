// 研究専用（docs/70）：research-aoto-variants.mjs の JSON（複数可）から比較表（Markdown）を作る。採用判断はしない。
// 使い方：node tools/research-aoto-variants-report.mjs <result.json>... [--out out.md]
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const oi = argv.indexOf('--out');
const outFile = oi >= 0 ? argv[oi + 1] : null;
const files = argv.filter((a, i) => oi < 0 || (i !== oi && i !== oi + 1));
const MODE = { math1: '数学Ⅰ', math2: '数学Ⅱ' };
const NV = { 'novice-basic': '基本', 'novice-keep': '聴牌を保つ', 'novice-riichi': '＋リーチ', 'novice-smart': 'スマート' };
const pct = (r) => (r ? `${(r.rate * 100).toFixed(1)}%` : '—');
const num = (m, f = 2) => (m && m.mean != null ? m.mean.toFixed(f) : '—');
const ci = (p, f = 2) => (p ? `${p.mean >= 0 ? '+' : ''}${p.mean.toFixed(f)}（${p.lo == null ? '—' : p.lo.toFixed(f)}〜${p.hi == null ? '—' : p.hi.toFixed(f)}）` : '—');
const lines = [];
const P = (s = '') => lines.push(s);

P('# あおと改善案の比較表（研究専用・採用判断なし）');
P();
P('順位差・点差は条件A とのペア差（同じ seed の席替え／代理4版を1クラスタとした 95% CI）。順位差は負なら条件A より上位。');
P();
let total = 0;
for (const f of files) {
  const d = JSON.parse(readFileSync(f, 'utf8'));
  const variants = d.definition.variants;
  const n = d.records.length;
  total += n;
  const modes = [...new Set(Object.keys(d.cells).map((k) => k.split(':')[1]))];
  P(`## \`${f}\`（seed0 ${d.definition.seed0}・scale ${d.definition.scale}・${modes.map((m) => MODE[m]).join('・')}・${n} 試合×条件・${Math.round(d.seconds || 0)}秒）`);
  P();
  for (const [key, c] of Object.entries(d.cells)) {
    const [exp, mode, len] = key.split(':');
    P(`### ${exp === 'ai4' ? 'E1 初級AI 4人' : 'E2 初心者代理＋初級AI 3人'}・${MODE[mode]}・${len}局戦`);
    P('| 条件 | あおと 1位率 | 4位率 | 平均順位 | 順位差 vs A | 点差 vs A | 鳴き 選択/成立/取消 | 鳴いた局 | 鳴き聴牌の役なし | 鳴き 検討→見送り | 打牌 確認→差替 | 流局率 |');
    P('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const v of variants) {
      const s = exp === 'ai4' ? c[v] : c[v].all;
      const a = s.agents.aoto;
      const pv = c.pairedVsA[v]?.aoto;
      const st = c[v].stats;
      P(`| ${v} | ${pct(a.result.top)} | ${pct(a.result.last)} | ${num(a.result.meanRank)} | ${v === 'A' ? '—' : ci(pv.rank)} | ${v === 'A' ? '—' : ci(pv.score, 1)} | ${a.calls.chosen}/${a.calls.made}/${a.calls.cancelled} | ${pct(a.calls.roundsWithCalls)} | ${pct(a.calls.yakulessTenpaiCalled)} | ${st.callsConsidered}→${st.callsBlocked} | ${st.discardsChecked}→${st.discardsReplaced} | ${pct(s.table.drawRate)} |`);
    }
    P();
    if (exp === 'novice') {
      P('| 条件 | ' + Object.values(NV).map((x) => `${x} 1位率／順位差 vs A`).join(' | ') + ' |');
      P('|---|' + Object.keys(NV).map(() => '---|').join(''));
      for (const v of variants) {
        P(`| ${v} | ${Object.keys(NV).map((nv) => `${pct(c[v][nv].agents[nv].result.top)}／${v === 'A' ? '—' : ci(c.pairedVsA[v][nv].rank)}`).join(' | ')} |`);
      }
      P();
    }
  }
}
P(`合計：${total} 試合×条件。`);
const md = lines.join('\n') + '\n';
if (outFile) writeFileSync(outFile, md); else process.stdout.write(md);
