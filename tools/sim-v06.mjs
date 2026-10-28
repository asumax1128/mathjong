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
//   ref    : 基準の打ち手（Ver.0.5-E の中級AI 速攻・役重視・門前、上級AI 速攻）1人 vs 各難易度のキャラ3人
//            （人間から見た難易度：基準の打ち手の平均順位が、初級 < 中級 < 上級 の順に悪くなるか）
//   all    : cross + same + legacy
//   mixed  : 自由選択（Ver.0.6）の全組み合わせ：9人から3人の 84 通り × 基準の打ち手（Ver.0.5-E 中級・速攻、人の席の代わり）1人。
//            --human challenger と合わせると、基準の打ち手の席を人間の席として扱う
// 1グループ＝4試合（全員が4つの席を1回ずつ回る。親の開始席も回る）。seed はグループ・席・局ごとに決まり、同じ引数なら同じ結果。
// 対局の seed は「ケースの一意ID（形式・相手の難易度・席の並び）」から作る（--seed-scheme case-id、既定）。ケースの配列番号には
// 依存しないので、--only や --exp で絞り込んでも、同じケースの対局条件（seed・席の並び）は変わらない。
// 試合ごとに標本ID（ケースID|グループ|回転）・seed・席の並び・最終得点・順位を出力し、tools/compare-v06.mjs はこれが一致する試合だけを対にする。
// --seed-scheme index：監査前（Ver.0.6 docs/28）の seed（絞り込み後の配列番号を使う）を再現するためだけの互換用。--only と併用すると
// 同じケースでも seed が変わるので、比較の基準には使わない。
// 判断に使う情報は既存と同じ（Game.viewFor の公開情報・試合の持ち点・seed 付き乱数）。このツールは判断を変えず、結果を数えるだけ。
// 順位は同点を分け合う（同点2人の1位は 1.5 位ずつ）。1位率・2位以内率・4位率も、最終得点と同点者数から持分で数える
// （例：4人とも100点なら各人の1位・4位はそれぞれ 0.25）。95% 信頼区間は試合単位の標準誤差 ×1.96。
// --tune '{"kaoru":{"defense":2}}'：キャラの判断係数（CHARACTER_PARAMS）を、この実行だけ上書きする（比較実験用）。
// --human challenger：挑戦者の席を「人間の席」（kind: 'human'）として扱う測定用。打ち方は AI のままだが、他の AI は
//   その席の見送りから安全を推定しない（通った牌を使わない）。人間を相手にしたときの上級の強さの目安（監査 P2-1）。
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
  if (exp === 'ref' || exp === 'refv05') {
    // refv05：比較のため、Ver.0.5-E の同難易度AI（速攻・役重視・門前）3人の卓も測る（v05-<level>）
    const tables = exp === 'ref' ? LEVELS.map((l) => [l, IDS[l]]) : LEVELS.map((l) => [`v05-${l}`, legacyIds(l)]);
    for (const [l, opp] of tables) for (const r of ['L:intermediate:speed', 'L:intermediate:value', 'L:intermediate:closed', 'L:advanced:speed']) {
      cases.push({ kind: 'ref', challenger: r, level: l, lineup: [r, ...opp] });
    }
  }
  if (exp === 'mixed') {
    const all = LEVELS.flatMap((l) => IDS[l]);
    for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) for (let c = b + 1; c < all.length; c++) {
      const trio = [all[a], all[b], all[c]];
      cases.push({ kind: 'mixed', challenger: 'L:intermediate:speed', level: trio.join('+'), lineup: ['L:intermediate:speed', ...trio] });
    }
  }
  if (exp === 'legacy' || exp === 'all') {
    for (const l of LEVELS) for (const id of IDS[l]) add('legacy', id, legacyIds(l));
  }
  if (!cases.length) throw new Error(`unknown --exp ${exp}`);
  for (const c of cases) c.id = caseId(c);
  if (new Set(cases.map((c) => c.id)).size !== cases.length) throw new Error('duplicate case id');
  return cases;
}

// ケースの一意ID：形式・相手の難易度（ref・same）・席0からの並び。配列番号や絞り込みに依存しない。
export const caseId = (c) => `${c.kind}:${c.level || '-'}:${c.lineup.join(',')}`;
// --only の絞り込み（挑戦者のID、ref は相手の難易度、same は難易度）
export function filterCases(cases, only) {
  if (!only) return cases;
  const keys = only.split(',');
  return cases.filter((c) => keys.includes(c.kind === 'ref' ? c.level : c.challenger || c.level));
}
// 文字列の 32bit ハッシュ（FNV-1a）
const fnv1a = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h; };
export const SEED_SCHEMES = ['case-id', 'index'];
// 試合（ジョブ）の一覧。seedBase は scheme が case-id ならケースIDから作る（配列番号 ci は集計の並びにだけ使う）。
export function buildJobs({ cases, mode, length, groups, seed, scheme = 'case-id', human = null }) {
  if (!SEED_SCHEMES.includes(scheme)) throw new Error(`unknown --seed-scheme ${scheme}`);
  const jobs = [];
  cases.forEach((c, ci) => {
    const id = c.id || caseId(c);
    for (let g = 0; g < groups; g++) for (let rot = 0; rot < 4; rot++) {
      const seats = c.lineup.map((_, s) => c.lineup[(s + rot) % 4]);
      const seedBase = scheme === 'case-id' ? mix(seed, fnv1a(id), g, rot, length) : mix(seed, ci, g, rot, length);
      const humanIds = human === 'challenger' && c.challenger ? [c.challenger] : [];
      jobs.push({ mode, length, seats, seedBase, ci, g, rot, caseId: id, sample: `${id}|g${g}|r${rot}`, humanIds });
    }
  });
  return jobs;
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
// 順位の持分：席ごとに [1位, 2位, 3位, 4位] の持分（和は1）。上に h 人・自分を含めて t 人が同点なら、h+1〜h+t 位を 1/t ずつ。
// 平均順位（fracRanks）は Σ k·持分 と一致する。
export function placeShares(scores) {
  return scores.map((x) => {
    const h = scores.filter((y) => y > x).length;
    const t = scores.filter((y) => y === x).length;
    return [0, 1, 2, 3].map((k) => (k >= h && k < h + t ? 1 / t : 0));
  });
}
export { fracRanks };

// 判断係数の上書き（キャラごとに浅く結合。入れ子のオブジェクトは丸ごと置き換え）
export function applyTune(tune) {
  for (const [id, over] of Object.entries(tune || {})) {
    if (!CHARACTER_PARAMS[id]) throw new Error(`unknown character in --tune: ${id}`);
    Object.assign(CHARACTER_PARAMS[id], over);
  }
}

export function playMatch({ mode, length, seats, seedBase, humanIds = [] }) {
  const rules = getRules(mode);
  const sinKey = 'f:sin';
  let m = createMatch({ length });
  const st = seats.map(() => blank());
  let round = 0;
  while (!m.over) {
    round++;
    if (round > 200) throw new Error('round cap');
    const gameSeed = (seedBase + round * 7919) >>> 0;
    const players = seats.map((id) => ({ name: id, kind: humanIds.includes(id) ? 'human' : 'ai', personality: id.startsWith('L:') ? id.split(':')[2] : 'speed' }));
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
  return { scores: m.scores, ranks: fracRanks(m.scores), shares: placeShares(m.scores), stats: st };
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
  if (results.length !== jobs.length) throw new Error(`results ${results.length} / jobs ${jobs.length}`);
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
  // rows: [{ rank, share: [1位..4位の持分], score, stats }]
  const sum = (k) => rows.reduce((a, r) => a + r.stats[k], 0);
  const rounds = sum('rounds');
  const per = (k) => r3(sum(k) / rounds);
  return {
    matches: rows.length,
    rank: meanCI(rows.map((r) => r.rank)),
    top1: meanCI(rows.map((r) => r.share[0])),
    top2: meanCI(rows.map((r) => r.share[0] + r.share[1])),
    last: meanCI(rows.map((r) => r.share[3])),
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

export function summarize({ exp, mode, length, groups, seed, tune, cases, results, seconds, scheme = 'case-id', only = null, human = null }) {
  const byCase = cases.map(() => []);
  for (const { job, res } of results) byCase[job.ci].push({ seats: job.seats, res, sample: job.sample });
  const caseReports = cases.map((c, ci) => {
    const per = {};
    for (const { seats, res } of byCase[ci]) seats.forEach((id, s) => (per[id] ||= []).push({ rank: res.ranks[s], share: res.shares[s], score: res.scores[s], stats: res.stats[s] }));
    const players = Object.fromEntries(Object.entries(per).map(([id, rows]) => [id, playerSummary(rows)]));
    // 挑戦者の試合ごとの順位（グループ・席の順。同じ seed の別実行と対にして比べるため）
    const challengerRanks = c.challenger ? byCase[ci].map(({ seats, res }) => res.ranks[seats.indexOf(c.challenger)]) : null;
    const challengerSamples = c.challenger ? byCase[ci].map(({ sample }) => sample) : null;
    return { id: c.id, kind: c.kind, challenger: c.challenger, level: c.level || null, lineup: c.lineup, players, challengerRanks, challengerSamples };
  });
  // 難易度ごとのまとめ（up/down：挑戦者の順位を難易度で集める）
  const levelAgg = {};
  for (const kind of ['up', 'down', 'legacy']) {
    for (const l of LEVELS) {
      const rows = [];
      cases.forEach((c, ci) => {
        if (c.kind !== kind || LEVEL_OF[c.challenger] !== l) return;
        for (const { seats, res } of byCase[ci]) { const s = seats.indexOf(c.challenger); rows.push({ rank: res.ranks[s], share: res.shares[s] }); }
      });
      if (rows.length) (levelAgg[kind] ||= {})[l] = { rank: meanCI(rows.map((r) => r.rank)), top1: meanCI(rows.map((r) => r.share[0])), n: rows.length };
    }
  }
  // ref：基準の打ち手の順位を、相手の難易度ごとに集める
  for (const l of [...new Set(cases.filter((c) => c.kind === 'ref').map((c) => c.level))]) {
    const rows = [];
    cases.forEach((c, ci) => {
      if (c.kind !== 'ref' || c.level !== l) return;
      for (const { seats, res } of byCase[ci]) { const s = seats.indexOf(c.challenger); rows.push({ rank: res.ranks[s], share: res.shares[s] }); }
    });
    if (rows.length) (levelAgg.ref ||= {})[l] = { rank: meanCI(rows.map((r) => r.rank)), top1: meanCI(rows.map((r) => r.share[0])), n: rows.length };
  }
  const brief = { exp, mode, length, groups, seed, matches: results.length, seconds: r3(seconds), levelAgg,
    cases: caseReports.map((c) => ({ kind: c.kind, who: c.challenger || c.level, rank: c.challenger ? c.players[c.challenger].rank : Object.fromEntries(Object.entries(c.players).map(([k, v]) => [k, v.rank.mean])) })) };
  // 試合ごとの記録（標本ID・seed・席の並び・最終得点・順位）。対比較はこれで試合を対応付ける
  const matches = results.map(({ job, res }) => ({ caseId: job.caseId, sample: job.sample, g: job.g, rot: job.rot, seedBase: job.seedBase, seats: job.seats, scores: res.scores, ranks: res.ranks }));
  return { brief, cases: caseReports, levelAgg, matches, meta: { exp, mode, length, groups, seed, seedScheme: scheme, only, human, tune, matches: results.length, seconds: r3(seconds) } };
}

function toCsv(cases, results) {
  const head = ['caseId', 'sample', 'seedBase', 'kind', 'group', 'rotation', 'seat', 'player', 'rank', 'top1', 'top2', 'last', 'points', 'rounds', 'wins', 'ron', 'tsumo', 'dealIn', 'chi', 'pon', 'riichi', 'winPoints'];
  const lines = [head.join(',')];
  for (const { job, res } of results) {
    job.seats.forEach((id, s) => {
      const t = res.stats[s];
      const sh = res.shares[s];
      lines.push([`"${job.caseId}"`, `"${job.sample}"`, job.seedBase, cases[job.ci].kind, job.g, job.rot, s, id, res.ranks[s], r3(sh[0]), r3(sh[0] + sh[1]), r3(sh[3]), res.scores[s], t.rounds, t.wins, t.ron, t.tsumo, t.dealIn, t.chi, t.pon, t.riichi, t.winPoints].join(','));
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
  const only = opt('--only', null); // 挑戦者を絞る（例：--only kaoru,asuma）。絞っても同じケースの seed は変わらない
  const scheme = opt('--seed-scheme', 'case-id');
  const human = opt('--human', null);
  if (human !== null && human !== 'challenger') throw new Error('--human は challenger だけ');
  if (!['math1', 'math2'].includes(mode) || ![4, 8].includes(length) || !Number.isInteger(groups) || groups < 1 || !Number.isInteger(seed)) throw new Error('bad options');
  const cases = filterCases(buildCases(exp), only);
  if (!cases.length) throw new Error(`--only ${only}: no case`);
  if (scheme === 'index' && only) console.error('警告：--seed-scheme index と --only の併用は、同じケースでも seed が変わる（監査前の結果の再現専用）');
  const jobs = buildJobs({ cases, mode, length, groups, seed, scheme, human });
  const t0 = Date.now();
  const results = await runPool(jobs, workers, tune);
  const report = summarize({ exp, mode, length, groups, seed, tune, cases, results, seconds: (Date.now() - t0) / 1000, scheme, only, human });
  const out = opt('--out', null);
  if (out) writeFileSync(out, JSON.stringify(report, null, 1));
  const csv = opt('--csv', null);
  if (csv) writeFileSync(csv, toCsv(cases, results));
  console.log(JSON.stringify(report.brief, null, 1));
}
