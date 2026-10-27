// 数雀 Ver.0.6：9人のキャラクターAIの強さ・個性を測るシミュレーター（並列・再現可能）。
// 使い方（例）:
//   node tools/sim-v06.mjs --exp cross --mode math1 --length 4 --groups 32 --seed 1001 --workers 4
//   node tools/sim-v06.mjs --exp all --mode math2 --groups 64 --seed 9001 --out /tmp/r.json --csv /tmp/r.csv
// 実験（--exp）:
//   up     : 下の難易度の1人 vs 上の難易度の3人（初級1 vs 中級3、中級1 vs 上級3）
//   down   : 上の難易度の1人 vs 下の難易度の3人（中級1 vs 初級3、上級1 vs 中級3）
//   cross  : up + down
//   same   : 同じ難易度の3人 + 対照（Ver.0.5-E の同難易度AI・速攻型）1人
//   legacy : キャラ1人 vs Ver.0.5-E の同難易度AI 3人（速攻・役重視・門前）
//   all    : cross + same + legacy
// 1グループ＝4試合（全員が4つの席を1回ずつ回る。親の開始席も回る）。seed はグループ・席・局ごとに決まり、同じ引数なら同じ結果。
// 判断に使う情報は既存と同じ（Game.viewFor の公開情報・試合の持ち点・seed 付き乱数）。このツールは判断を変えず、結果を数えるだけ。
// 順位は同点を分け合う（同点2人の1位は 1.5 位ずつ）。95% 信頼区間は試合単位の標準誤差 ×1.96。
// --tune '{"kaoru":{"defense":2}}'：キャラの判断係数（CHARACTER_PARAMS）を、この実行だけ上書きする（比較実験用）。
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction, viewCounts } from '../src/engine/ai.js';
import { decideCharacter, CHARACTER_ROSTER, CHARACTER_PARAMS } from '../src/engine/character-ai.js';
import { createRng } from '../src/engine/rng.js';
import { createMatch, applyRoundResult, dealerOf, START_POINTS } from '../src/engine/match.js';

export const LEVELS = ['beginner', 'intermediate', 'advanced'];
export const IDS = Object.fromEntries(LEVELS.map((l) => [l, CHARACTER_ROSTER[l].map((c) => c.id)]));
export const LEVEL_OF = Object.fromEntries(LEVELS.flatMap((l) => IDS[l].map((id) => [id, l])));
const legacyIds = (level) => ['speed', 'value', 'closed'].map((p) => `L:${level}:${p}`);

// 実験の組み合わせ（challenger：集計の主対象。lineup：席0から並べた4人）
export function buildCases(exp) {
  const cases = [];
  const add = (kind, challenger, others) => cases.push({ kind, challenger, lineup: [challenger, ...others] });
  if (exp === 'up' || exp === 'cross' || exp === 'all') {
    for (const id of IDS.beginner) add('up', id, IDS.intermediate);
    for (const id of IDS.intermediate) add('up', id, IDS.advanced);
  }
  if (exp === 'down' || exp === 'cross' || exp === 'all') {
    for (const id of IDS.intermediate) add('down', id, IDS.beginner);
    for (const id of IDS.advanced) add('down', id, IDS.intermediate);
  }
  if (exp === 'same' || exp === 'all') {
    for (const l of LEVELS) cases.push({ kind: 'same', challenger: null, level: l, lineup: [...IDS[l], `L:${l}:speed`] });
  }
  if (exp === 'legacy' || exp === 'all') {
    for (const l of LEVELS) for (const id of IDS[l]) add('legacy', id, legacyIds(l));
  }
  if (!cases.length) throw new Error(`unknown --exp ${exp}`);
  return cases;
}

const mix = (...xs) => xs.reduce((h, x) => (Math.imul(h ^ (x >>> 0), 0x9e3779b1) + 0x7f4a7c15) >>> 0, 0x12345678);

// ---- 1試合 ----
function blank() {
  return { rounds: 0, wins: 0, ron: 0, tsumo: 0, dealIn: 0, chi: 0, pon: 0, riichi: 0, discards: 0, sinDiscards: 0,
    winPoints: 0, closedWins: 0, calledRounds: 0, calledRoundWins: 0, yakulessCalledRounds: 0, decisions: 0, decisionMs: 0, maxDecisionMs: 0,
    claimOpp: 0, claimTaken: 0, claimOppTrail: 0, claimTakenTrail: 0, claimOppLead: 0, claimTakenLead: 0,
    ronFromAoto: 0, ronFromOthers: 0, sinHeldEnd: 0, handEnd: 0, tenpaiAtDraw: 0, draws: 0 };
}
const rankOf = (scores, s) => 1 + scores.filter((x) => x > scores[s]).length;
const fracRanks = (scores) => scores.map((x) => {
  const higher = scores.filter((y) => y > x).length;
  const tied = scores.filter((y) => y === x).length;
  return higher + (tied + 1) / 2; // 同点は順位を分け合う
});

// 判断係数の上書き（キャラごとに浅く結合。入れ子のオブジェクトは丸ごと置き換え）
export function applyTune(tune) {
  for (const [id, over] of Object.entries(tune || {})) {
    if (!CHARACTER_PARAMS[id]) throw new Error(`unknown character in --tune: ${id}`);
    Object.assign(CHARACTER_PARAMS[id], over);
  }
}

export function playMatch({ mode, length, seats, seedBase }) {
  const rules = getRules(mode);
  const sinKey = 'f:sin';
  let m = createMatch({ length });
  const st = seats.map(() => blank());
  let round = 0;
  while (!m.over) {
    round++;
    if (round > 200) throw new Error('round cap');
    const gameSeed = (seedBase + round * 7919) >>> 0;
    const players = seats.map((id) => ({ name: id, kind: 'ai', personality: id.startsWith('L:') ? id.split(':')[2] : 'speed' }));
    const g = new Game({ rules, seed: gameSeed, dealer: dealerOf(m), players });
    const rng = createRng((gameSeed ^ 0x5bd1e995) >>> 0);
    const info = { scores: m.scores.slice(), hand: m.hand, length: m.length, dealer: dealerOf(m), renchan: m.renchan };
    let steps = 0;
    while (g.pending()) {
      const p = g.pending();
      const id = seats[p.seat];
      const t0 = performance.now();
      const a = id.startsWith('L:')
        ? decide(g, p.seat, id.split(':')[2], rng, id.split(':')[1], info)
        : decideCharacter(g, p.seat, id, rng, info, seats);
      const dt = performance.now() - t0;
      const s = st[p.seat];
      s.decisions++; s.decisionMs += dt; if (dt > s.maxDecisionMs) s.maxDecisionMs = dt;
      if (p.type === 'claim' && (p.chi.length || p.pon)) {
        s.claimOpp++;
        const took = a.type === 'chi' || a.type === 'pon';
        if (took) s.claimTaken++;
        const r = rankOf(info.scores, p.seat), def = Math.max(...info.scores) - info.scores[p.seat];
        if (r >= 3 && def >= 12) { s.claimOppTrail++; if (took) s.claimTakenTrail++; }
        if (r === 1) { s.claimOppLead++; if (took) s.claimTakenLead++; }
      }
      if (a.type === 'discard') {
        s.discards++;
        if (rules.types[g.typeOf(a.tile)].key === sinKey) s.sinDiscards++;
        if (a.riichi) s.riichi++;
      }
      applyAction(g, p.seat, a);
      if (++steps > 4000) throw new Error('decision cap');
    }
    g.checkInvariants();
    for (const ev of g.events) if (ev.type === 'chi' || ev.type === 'pon') st[ev.seat][ev.type]++;
    const r = g.result;
    for (let s = 0; s < 4; s++) {
      const S = st[s];
      S.rounds++;
      const called = g.melds[s].length > 0;
      if (called) S.calledRounds++;
      // 手牌に残った sin（関数牌）の枚数（みつきの sin 保持の指標）
      const hand = g.hands[s];
      S.handEnd += hand.length;
      S.sinHeldEnd += hand.filter((id) => rules.types[g.typeOf(id)].key === sinKey).length;
      if (r.type !== 'win') {
        S.draws++;
        const counts = viewCounts(rules, g.viewFor(s));
        if (g.waitsOf(counts, g.melds[s].map((x) => x.meld)).length) S.tenpaiAtDraw++;
      }
      // 鳴いたのに役の見込みがない（公開面子だけで、どの最後の面子を足しても役がない）局：あおとの「役なし鳴き」
      if (called && rules.config.rules.calledHandNeedsYaku && !(r.type === 'win' && r.winner === s)) {
        const ex = g.melds[s].map((x) => x.meld);
        if (!yakuReachable(rules, ex)) S.yakulessCalledRounds++;
      }
    }
    if (r.type === 'win') {
      const W = st[r.winner];
      W.wins++; W[r.how]++; W.winPoints += r.points;
      if (!g.melds[r.winner].length) W.closedWins++;
      if (g.melds[r.winner].length) W.calledRoundWins++;
      if (r.how === 'ron') {
        st[r.from].dealIn++;
        if (seats[r.from] === 'aoto') W.ronFromAoto++; else W.ronFromOthers++;
      }
    }
    m = applyRoundResult(m, r);
    if (m.scores.reduce((a, b) => a + b, 0) !== 4 * START_POINTS) throw new Error('score conservation');
  }
  return { scores: m.scores, ranks: fracRanks(m.scores), stats: st };
}

// 公開面子 ex（1〜2つ）に、何か面子を足して役が成立し得るか
const yakuCache = new WeakMap();
function yakuReachable(rules, ex) {
  let c = yakuCache.get(rules); if (!c) yakuCache.set(rules, (c = new Map()));
  const key = ex.slice().sort((a, b) => a - b).join(',');
  if (c.has(key)) return c.get(key);
  const M = rules.melds.length;
  let ok = false;
  if (ex.length >= 3) ok = rules.evaluateMelds(ex, false).hasYaku;
  else if (ex.length === 2) { for (let x = 0; x < M && !ok; x++) ok = rules.evaluateMelds([...ex, x], false).hasYaku; }
  else for (let x = 0; x < M && !ok; x++) for (let y = x; y < M && !ok; y++) ok = rules.evaluateMelds([...ex, x, y], false).hasYaku;
  c.set(key, ok);
  return ok;
}
const rulesCache = {};
function getRules(mode) { return rulesCache[mode] || (rulesCache[mode] = createRules(makeConfig({ mode }))); }

async function runPool(jobs, n, tune) {
  const chunks = Array.from({ length: n }, () => []);
  jobs.forEach((j, i) => chunks[i % n].push(j));
  const results = [];
  await Promise.all(chunks.filter((c) => c.length).map((chunk) => new Promise((resolve, reject) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { jobs: chunk, tune } });
    w.on('message', (m) => results.push(m));
    w.on('error', reject);
    w.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exit ${code}`))));
  })));
  results.sort((a, b) => a.job.ci - b.job.ci || a.job.g - b.job.g || a.job.rot - b.job.rot);
  return results;
}

// ---- 集計 ----
const r3 = (x) => (x === null || Number.isNaN(x) ? null : +x.toFixed(3));
function meanCI(xs) {
  const n = xs.length;
  if (!n) return { mean: null, ci95: null, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { mean: r3(mean), ci95: r3(1.96 * sd / Math.sqrt(n)), n };
}
export function playerSummary(rows) {
  // rows: [{ rank, score, stats }]
  const sum = (k) => rows.reduce((a, r) => a + r.stats[k], 0);
  const rounds = sum('rounds');
  const per = (k) => r3(sum(k) / rounds);
  return {
    matches: rows.length,
    rank: meanCI(rows.map((r) => r.rank)),
    top1: meanCI(rows.map((r) => (r.rank <= 1.0001 ? 1 : r.rank < 2 ? 0.5 : 0))),
    top2: meanCI(rows.map((r) => (r.rank <= 2.0001 ? 1 : r.rank < 3 ? 0.5 : 0))),
    last: meanCI(rows.map((r) => (r.rank >= 3.9999 ? 1 : r.rank > 3 ? 0.5 : 0))),
    points: meanCI(rows.map((r) => r.score)),
    perRound: { win: per('wins'), ron: per('ron'), tsumo: per('tsumo'), dealIn: per('dealIn'), chi: per('chi'), pon: per('pon'), riichi: per('riichi'), called: per('calledRounds') },
    avgWinPoints: r3(sum('winPoints') / Math.max(1, sum('wins'))),
    closedWinShare: r3(sum('closedWins') / Math.max(1, sum('wins'))),
    claimRate: r3(sum('claimTaken') / Math.max(1, sum('claimOpp'))),
    claimRateTrailing: sum('claimOppTrail') ? r3(sum('claimTakenTrail') / sum('claimOppTrail')) : null,
    claimRateLeading: sum('claimOppLead') ? r3(sum('claimTakenLead') / sum('claimOppLead')) : null,
    calledRoundWinRate: r3(sum('calledRoundWins') / Math.max(1, sum('calledRounds'))),
    yakulessCalledShare: r3(sum('yakulessCalledRounds') / Math.max(1, sum('calledRounds'))),
    sinDiscardShare: r3(sum('sinDiscards') / Math.max(1, sum('discards'))),
    sinHeldPerTile: r3(sum('sinHeldEnd') / Math.max(1, sum('handEnd'))),
    ronFromAotoShare: sum('ronFromAoto') + sum('ronFromOthers') ? r3(sum('ronFromAoto') / (sum('ronFromAoto') + sum('ronFromOthers'))) : null,
    tenpaiAtDraw: sum('draws') ? r3(sum('tenpaiAtDraw') / sum('draws')) : null,
    msPerDecision: r3(sum('decisionMs') / Math.max(1, sum('decisions'))),
    maxMsPerDecision: r3(Math.max(...rows.map((r) => r.stats.maxDecisionMs))),
  };
}

function summarize({ exp, mode, length, groups, seed, tune, cases, results, seconds }) {
  const byCase = cases.map(() => []);
  for (const { job, res } of results) byCase[job.ci].push({ seats: job.seats, res });
  const caseReports = cases.map((c, ci) => {
    const per = {};
    for (const { seats, res } of byCase[ci]) seats.forEach((id, s) => (per[id] ||= []).push({ rank: res.ranks[s], score: res.scores[s], stats: res.stats[s] }));
    const players = Object.fromEntries(Object.entries(per).map(([id, rows]) => [id, playerSummary(rows)]));
    // 挑戦者の試合ごとの順位（グループ・席の順。同じ seed の別実行と対にして比べるため）
    const challengerRanks = c.challenger ? byCase[ci].map(({ seats, res }) => res.ranks[seats.indexOf(c.challenger)]) : null;
    return { kind: c.kind, challenger: c.challenger, level: c.level || null, lineup: c.lineup, players, challengerRanks };
  });
  // 難易度ごとのまとめ（up/down：挑戦者の順位を難易度で集める）
  const levelAgg = {};
  for (const kind of ['up', 'down', 'legacy']) {
    for (const l of LEVELS) {
      const rows = [];
      cases.forEach((c, ci) => {
        if (c.kind !== kind || LEVEL_OF[c.challenger] !== l) return;
        for (const { seats, res } of byCase[ci]) { const s = seats.indexOf(c.challenger); rows.push({ rank: res.ranks[s], score: res.scores[s], stats: res.stats[s] }); }
      });
      if (rows.length) (levelAgg[kind] ||= {})[l] = { rank: meanCI(rows.map((r) => r.rank)), top1: meanCI(rows.map((r) => (r.rank <= 1.0001 ? 1 : r.rank < 2 ? 0.5 : 0))), n: rows.length };
    }
  }
  const brief = { exp, mode, length, groups, seed, matches: results.length, seconds: r3(seconds), levelAgg,
    cases: caseReports.map((c) => ({ kind: c.kind, who: c.challenger || c.level, rank: c.challenger ? c.players[c.challenger].rank : Object.fromEntries(Object.entries(c.players).map(([k, v]) => [k, v.rank.mean])) })) };
  return { brief, cases: caseReports, levelAgg, meta: { exp, mode, length, groups, seed, tune, matches: results.length, seconds: r3(seconds) } };
}

function toCsv(cases, results) {
  const head = ['case', 'kind', 'group', 'rotation', 'seat', 'player', 'rank', 'points', 'rounds', 'wins', 'ron', 'tsumo', 'dealIn', 'chi', 'pon', 'riichi', 'winPoints'];
  const lines = [head.join(',')];
  for (const { job, res } of results) {
    job.seats.forEach((id, s) => {
      const t = res.stats[s];
      lines.push([job.ci, cases[job.ci].kind, job.g, job.rot, s, id, res.ranks[s], res.scores[s], t.rounds, t.wins, t.ron, t.tsumo, t.dealIn, t.chi, t.pon, t.riichi, t.winPoints].join(','));
    });
  }
  return lines.join('\n') + '\n';
}

// ---- 並列実行 ----
if (!isMainThread) {
  applyTune(workerData.tune);
  for (const job of workerData.jobs) {
    const res = playMatch(job);
    parentPort.postMessage({ job, res });
  }
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const exp = opt('--exp', 'cross');
  const mode = opt('--mode', 'math1');
  const length = Number(opt('--length', 4));
  const groups = Number(opt('--groups', 4));
  const seed = Number(opt('--seed', 1));
  const workers = Math.max(1, Number(opt('--workers', 4)));
  const tune = JSON.parse(opt('--tune', '{}'));
  applyTune(tune); // 不正なキャラ名をここで検出
  const only = opt('--only', null); // 挑戦者を絞る（例：--only kaoru,asuma）
  if (!['math1', 'math2'].includes(mode) || ![4, 8].includes(length) || !Number.isInteger(groups) || groups < 1 || !Number.isInteger(seed)) throw new Error('bad options');
  const cases = buildCases(exp).filter((c) => !only || only.split(',').includes(c.challenger || c.level));
  const jobs = [];
  cases.forEach((c, ci) => {
    for (let g = 0; g < groups; g++) for (let rot = 0; rot < 4; rot++) {
      const seats = c.lineup.map((_, s) => c.lineup[(s + rot) % 4]);
      jobs.push({ mode, length, seats, seedBase: mix(seed, ci, g, rot, length), ci, g, rot });
    }
  });
  const t0 = Date.now();
  const results = await runPool(jobs, workers, tune);
  const report = summarize({ exp, mode, length, groups, seed, tune, cases, results, seconds: (Date.now() - t0) / 1000 });
  const out = opt('--out', null);
  if (out) writeFileSync(out, JSON.stringify(report, null, 1));
  const csv = opt('--csv', null);
  if (csv) writeFileSync(csv, toCsv(cases, results));
  console.log(JSON.stringify(report.brief, null, 1));
}
