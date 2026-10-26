// AI 難易度の強さ比較（Ver.0.4-B）。異なる難易度の AI を同じ試合に参加させ、席・親・性格・seed を入れ替えて比べる。
// 使い方:
//   node tools/simulate-levels.mjs --a advanced --b intermediate --format 1v3 --groups 100 --mode math1 --length 4 [--seed 1] [--jobs 4]
//   node tools/simulate-levels.mjs --a beginner --b intermediate --format 2v2 ...
//   node tools/simulate-levels.mjs --a intermediate --b intermediate --format same ...（4人とも同じ難易度：--a の難易度だけ）
// 公平化：1つの「組」（group）では同じ seed 系列で複数の試合を行い、難易度の席を入れ替える。
//   1v3：A を席0〜3に1人ずつ置いた4試合（残りは B）／2v2：AABB・ABAB・ABBA・BBAA・BABA・BAAB の6試合／same：1試合。
//   性格は組ごとに席を回す（speed・value・closed・speed）。親は東1局が席0から、試合ごとに A の席が変わるので親の位置も入れ替わる。
// 統計の単位は組（同じ seed の試合をまとめた平均）。組ごとの差の平均と標準誤差（SE）、95% 信頼区間（±1.96 SE）を出す。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { createMatch, applyRoundResult, dealerOf, ranks } from '../src/engine/match.js';
import { matchInfo, ADVANCED } from '../src/engine/ai-levels.js';

// 調整用：環境変数 MJ_ADV（JSON）で上級の係数を上書きする（ゲーム本体には影響しない）
if (process.env.MJ_ADV) Object.assign(ADVANCED, JSON.parse(process.env.MJ_ADV));

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const A = opt('--a', 'advanced');
const B = opt('--b', 'intermediate');
const FORMAT = opt('--format', '1v3');
const GROUPS = Number(opt('--groups', 20));
const MODE = opt('--mode', 'math1');
const LENGTH = Number(opt('--length', 4));
const SEED = Number(opt('--seed', 1));
const JOBS = Number(opt('--jobs', 1));
const PART = opt('--part', null); // 内部用 "i/J"
const lineup = ['speed', 'value', 'closed', 'speed'];
const PATTERNS = {
  '1v3': ['ABBB', 'BABB', 'BBAB', 'BBBA'],
  '2v2': ['AABB', 'ABAB', 'ABBA', 'BBAA', 'BABA', 'BAAB'],
  same: ['AAAA'],
};

function emptyStat() {
  return { seats: 0, rankSum: 0, top: 0, last: 0, scoreSum: 0, wins: 0, ron: 0, tsumo: 0, dealIn: 0, chi: 0, pon: 0, riichi: 0, riichiWins: 0, decisions: 0, ms: 0, maxMs: 0, turnDecisions: 0, turnMs: 0 };
}

function runGroups(from, to) {
  const rules = createRules(makeConfig({ mode: MODE }));
  const stat = { [A]: emptyStat(), [B]: emptyStat() };
  const groups = []; // 組ごと：A・B の平均順位・平均得点
  let rounds = 0;
  let draws = 0;
  let matches = 0;
  for (let k = from; k < to; k++) {
    const pers = lineup.map((_, s) => lineup[(s + k) % 4]);
    const seedBase = SEED * 1000003 + k * 7777;
    const g = { A: { rank: 0, score: 0, n: 0 }, B: { rank: 0, score: 0, n: 0 } };
    for (const pat of PATTERNS[FORMAT]) {
      const lv = [...pat].map((c) => (c === 'A' ? A : B));
      let m = createMatch({ length: LENGTH });
      let n = 0;
      while (!m.over) {
        n++;
        const seed = seedBase + n * 7919;
        const dealer = dealerOf(m);
        const game = new Game({ rules, seed, dealer, players: pers.map((p) => ({ kind: 'ai', personality: p })) });
        const rng = createRng(seed ^ 0x5bd1e995);
        const info = matchInfo(m);
        let steps = 0;
        while (game.pending()) {
          const p = game.pending();
          const t0 = performance.now();
          const a = decide(game, p.seat, pers[p.seat], rng, lv[p.seat], info);
          const dt = performance.now() - t0;
          const st = stat[lv[p.seat]];
          st.decisions++; st.ms += dt; if (dt > st.maxMs) st.maxMs = dt;
          if (p.type === 'turn') { st.turnDecisions++; st.turnMs += dt; }
          if (a.type === 'chi') st.chi++;
          if (a.type === 'pon') st.pon++;
          if (a.riichi) st.riichi++;
          applyAction(game, p.seat, a);
          if (++steps > 3000) throw new Error('no progress');
        }
        game.checkInvariants();
        const r = game.result;
        rounds++;
        if (r.type === 'draw') draws++;
        else {
          const w = stat[lv[r.winner]];
          w.wins++; w[r.how]++;
          if (r.analysis && r.analysis.riichi) w.riichiWins++;
          if (r.how === 'ron') stat[lv[r.from]].dealIn++;
        }
        m = applyRoundResult(m, r);
      }
      // 鳴きの回数は「宣言した」回数ではなく成立した回数を数えたいが、宣言はロンに取り消されることがある。
      // ここでは宣言の回数（AI の判断）を数える（成立回数との差は小さい）。
      matches++;
      const rk = ranks(m.scores);
      for (let s = 0; s < 4; s++) {
        const st = stat[lv[s]];
        st.seats++; st.rankSum += rk[s]; st.scoreSum += m.scores[s];
        if (rk[s] === 1) st.top++;
        if (rk[s] === 4) st.last++;
        const gg = g[pat[s]];
        gg.rank += rk[s]; gg.score += m.scores[s]; gg.n++;
      }
    }
    groups.push({ k, A: { rank: g.A.rank / g.A.n, score: g.A.score / g.A.n }, B: g.B.n ? { rank: g.B.rank / g.B.n, score: g.B.score / g.B.n } : null });
  }
  return { stat, groups, rounds, draws, matches };
}

function merge(parts) {
  const out = { stat: {}, groups: [], rounds: 0, draws: 0, matches: 0 };
  for (const p of parts) {
    out.rounds += p.rounds; out.draws += p.draws; out.matches += p.matches;
    out.groups.push(...p.groups);
    for (const [lv, st] of Object.entries(p.stat)) {
      const o = (out.stat[lv] = out.stat[lv] || emptyStat());
      for (const key of Object.keys(st)) o[key] = key === 'maxMs' ? Math.max(o[key], st[key]) : o[key] + st[key];
    }
  }
  return out;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const se = (a) => { const mu = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / (a.length - 1) / a.length); };
const r3 = (x) => +x.toFixed(3);

function report(res, seconds) {
  const lv = {};
  for (const [name, st] of Object.entries(res.stat)) {
    if (!st.seats) continue;
    lv[name] = {
      seats: st.seats, meanRank: r3(st.rankSum / st.seats), topRate: r3(st.top / st.seats), lastRate: r3(st.last / st.seats), meanScore: +(st.scoreSum / st.seats).toFixed(2),
      winsPerMatch: r3(st.wins / st.seats), ronPerMatch: r3(st.ron / st.seats), tsumoPerMatch: r3(st.tsumo / st.seats), dealInPerMatch: r3(st.dealIn / st.seats),
      chiPerMatch: r3(st.chi / st.seats), ponPerMatch: r3(st.pon / st.seats), riichiPerMatch: r3(st.riichi / st.seats), riichiWinsPerMatch: r3(st.riichiWins / st.seats),
      msPerDecision: r3(st.ms / st.decisions), msPerDiscard: r3(st.turnMs / st.turnDecisions), maxMsDecision: +st.maxMs.toFixed(1),
    };
  }
  const out = {
    mode: MODE, length: LENGTH, format: FORMAT, a: A, b: B, seed: SEED, advanced: { ...ADVANCED }, groups: res.groups.length, matches: res.matches, rounds: res.rounds,
    drawRate: r3(res.draws / res.rounds), roundsPerMatch: r3(res.rounds / res.matches), seconds: +seconds.toFixed(1), levels: lv,
  };
  if (FORMAT !== 'same') {
    const dRank = res.groups.map((g) => g.A.rank - g.B.rank);
    const dScore = res.groups.map((g) => g.A.score - g.B.score);
    out.diff = {
      note: 'A − B（組ごとの平均の差）。順位は負なら A が上位、得点は正なら A が多い。95%CI = 平均 ± 1.96 SE',
      rank: { mean: r3(mean(dRank)), se: r3(se(dRank)), ci95: [r3(mean(dRank) - 1.96 * se(dRank)), r3(mean(dRank) + 1.96 * se(dRank))] },
      score: { mean: r3(mean(dScore)), se: r3(se(dScore)), ci95: [r3(mean(dScore) - 1.96 * se(dScore)), r3(mean(dScore) + 1.96 * se(dScore))] },
    };
  }
  return out;
}

if (PART) {
  const [i, J] = PART.split('/').map(Number);
  const from = Math.floor((GROUPS * i) / J);
  const to = Math.floor((GROUPS * (i + 1)) / J);
  process.stdout.write(JSON.stringify(runGroups(from, to)));
} else if (JOBS > 1) {
  const t0 = Date.now();
  const self = fileURLToPath(import.meta.url);
  const parts = await Promise.all(Array.from({ length: JOBS }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [self, ...args, '--part', `${i}/${JOBS}`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(buf)) : reject(new Error(`part ${i} exit ${code}`))));
  })));
  console.log(JSON.stringify(report(merge(parts), (Date.now() - t0) / 1000), null, 1));
} else {
  const t0 = Date.now();
  console.log(JSON.stringify(report(runGroups(0, GROUPS), (Date.now() - t0) / 1000), null, 1));
}
