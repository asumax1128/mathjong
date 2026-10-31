// 研究専用（docs/69）：初級AI 4人（かなた・みつき・あおと・ゆうじん）と初心者代理モデルの「行動別」診断。
// 公開AI係数・エンジン・UI・ルールは変更しない（読み取りと集計だけ）。研究条件「弱体化」は既存の研究PR（#59〜#62）の
// easy 設定を、このプロセスの中だけで一時的に当てはめる（終了後に元へ戻す。main の係数は変えない）。
//
// 計測の原則
// ・割合の分母は「合法な選択機会」：エンジンの pending()（ロン・ツモ・チー・ポン）と riichiOptions()（リーチ）が示した機会だけを数える。
// ・聴牌・待ち・残り枚数は、その席の手牌と公開情報（viewFor）だけで計算する（判断には使わない・他家の手牌や山は使わない）。
// ・席ごとに独立した乱数列（seed と席から作る）。初心者代理の版を変えても AI の乱数列は変わらない（同じ seed・親・席順でペア比較）。
// ・初心者代理モデルは既存の研究PRの定義のまま（basic：75% 基本の残し方・25% 無作為、リーチなし・鳴きなし。smart：利用できるリーチを 85%、
//   面子を公開していないときチー 22%）。いつでも和了できれば和了。実際の人間の勝率ではない。
//
// 使い方：node tools/research-beginner-loss-diagnostics.mjs [--out file.json] [--scale 1] [--modes math1,math2] [--seed 690001]
import { writeFileSync } from 'node:fs';
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { applyAction } from '../src/engine/ai.js';
import { beginnerDiscard, matchInfo } from '../src/engine/ai-levels.js';
import { BEGINNER_PARAMS } from '../src/engine/character-ai-prototype.js';
import { decideCharacter, newPublicHistory, recordPublicRound } from '../src/engine/characters.js';
import { createMatch, applyRoundResult, dealerOf, ranks, potTotal, RIICHI_DEPOSIT } from '../src/engine/match.js';
import { unseenFromView } from '../src/engine/yakuhint.js';
import { createRng } from '../src/engine/rng.js';

export const AI4 = ['kanata', 'mitsuki', 'aoto', 'yujin'];
export const NAMES = { kanata: 'かなた', mitsuki: 'みつき', aoto: 'あおと', yujin: 'ゆうじん', 'novice-basic': '初心者代理（基本）', 'novice-keep': '初心者代理（聴牌を保つ・リーチなし）', 'novice-riichi': '初心者代理（聴牌を保つ＋リーチ）', 'novice-smart': '初心者代理（リーチ・限定チー）' };
export const NOVICE_VARIANTS = ['novice-basic', 'novice-keep', 'novice-riichi', 'novice-smart'];

// ---- 初心者代理モデル（basic・smart は研究PR #59〜#62 と同じ定義） ----
// smart の効果を分解するため、研究用に中間の2つを加える（同じ乱数の使い方）：
//   keep：聴牌になる捨て牌があれば 85% でそれを選ぶが、リーチは宣言しない（ダマ）・鳴かない
//   riichi：keep ＋ リーチを宣言・鳴かない
//   smart：riichi ＋ 面子未公開時にチー 22%
export const NOVICE = {
  basic: (g, p, rng) => novice(g, p, rng, { keep: false, riichi: false, chi: false }),
  keep: (g, p, rng) => novice(g, p, rng, { keep: true, riichi: false, chi: false }),
  riichi: (g, p, rng) => novice(g, p, rng, { keep: true, riichi: true, chi: false }),
  smart: (g, p, rng) => novice(g, p, rng, { keep: true, riichi: true, chi: true }),
};
function novice(g, p, rng, { keep, riichi, chi }) {
  if (p.type === 'claim') {
    if (p.ron) return { type: 'ron' };
    if (chi && p.chi.length && rng.next() < 0.22 && g.melds[p.seat].length === 0) return { type: 'chi', option: rng.int(p.chi.length) };
    return { type: 'pass' };
  }
  if (p.canTsumo) return { type: 'tsumo' };
  if (g.riichi[p.seat]) return { type: 'discard', tile: g.drawn };
  const view = g.viewFor(p.seat);
  if (keep && rng.next() < 0.85) {
    const opts = g.riichiOptions(p.seat);
    if (opts.length) { const t = opts[rng.int(opts.length)]; return { type: 'discard', tile: t.ids[0], riichi }; }
  }
  return { type: 'discard', tile: rng.next() < 0.25 ? rng.pick(view.hand).id : beginnerDiscard(g.rules, view, rng) };
}

// ---- 研究条件：既存研究PRの「easy」（弱体化）設定。このプロセスの中だけで当てはめ、戻す ----
const ORIGINAL = JSON.parse(JSON.stringify(BEGINNER_PARAMS));
export const SCENARIOS = {
  baseline: () => { for (const k of Object.keys(ORIGINAL)) BEGINNER_PARAMS[k] = JSON.parse(JSON.stringify(ORIGINAL[k])); },
  // あおとの反実仮想（研究用・公開係数ではない）：鳴かない／雑な打牌をしない／両方
  aotoNoCall: () => { SCENARIOS.baseline(); Object.assign(BEGINNER_PARAMS.aoto, { pon: 0, chi: 0 }); },
  aotoNoRandom: () => { SCENARIOS.baseline(); Object.assign(BEGINNER_PARAMS.aoto, { randomDiscard: 0 }); },
  aotoNoCallNoRandom: () => { SCENARIOS.baseline(); Object.assign(BEGINNER_PARAMS.aoto, { pon: 0, chi: 0, randomDiscard: 0 }); },
  easy: () => {
    SCENARIOS.baseline();
    Object.assign(BEGINNER_PARAMS.kanata, { pick: [0.23, 0.23, 0.21, 0.18, 0.15], readyBase: 0, readyPerLive: 0, readExact: 0, readKind: 0, readPerWait: 0, readMax: 0 });
    Object.assign(BEGINNER_PARAMS.mitsuki, { pick: [0.18, 0.20, 0.22, 0.21, 0.19], sinTile: 2, sinPair: 1.5 });
    Object.assign(BEGINNER_PARAMS.aoto, { randomDiscard: 0.9, pon: 0.95, chi: 0.9 });
  },
};

// ---- 1局の計測 ----
function newSeatRound() {
  return {
    turns: 0, discards: 0, // 打牌の判断の回数
    riichiOpp: 0, riichiDeclined: 0, riichiDeclared: false, riichiTurn: null, riichiOppRound: false,
    keepTenpaiOpp: 0, keepTenpaiChosen: 0, // 聴牌を保つ（作る）打牌がある判断で、それを選んだ回数（鳴いた手を含む）
    tenpai: false, firstTenpaiTurn: null, firstWaits: null, riichiWaits: null, yakulessTenpai: false,
    // 鳴き（PR #65 監査 P2-3）：chosen＝pending の選択肢からチー・ポンを選んだ回数、made＝公開面子として実際に成立した回数
    // （局の記録 events の chi/pon）。後続の席のロン（ロン優先）・より近い席のポンで取り消された鳴きは made に含めない
    chiOpp: 0, chiChosen: 0, chiMade: 0, ponOpp: 0, ponChosen: 0, ponMade: 0, ronOpp: 0, ronTaken: 0, tsumoOpp: 0, tsumoTaken: 0,
    calls: 0, furitenBlocked: 0,
    // 鳴きの成立後の聴牌：その席に成立した鳴き（チー・ポン）があり、その後の自分の打牌の直後に聴牌（形）だった局。
    // yakulessAfterCall：その観測のどれかで、どの待ちでも役がなく和了できなかった
    tenpaiAfterCall: false, yakulessAfterCall: false,
    won: false, how: null, points: 0, dora: 0, yaku: [], dealtIn: false, dealtInWhileRiichi: false,
    tenpaiAtEnd: false, endLive: 0, endWinnable: false,
  };
}
// その席の手（8枚）の待ち：種類・見えていない残り枚数（公開情報）・役があって和了できる待ち
function waitsInfo(g, s) {
  const waits = g.shapeWaits(s);
  if (!waits || !waits.length) return null;
  const view = g.viewFor(s);
  const unseen = unseenFromView(g.rules, view);
  const counts = g.countsOf(g.hands[s]);
  const exposed = g.exposedMelds(s), closed = g.isClosed(s);
  let live = 0, winnable = 0, winnableLive = 0;
  for (const t of waits) {
    const u = Math.max(0, unseen[t]);
    live += u;
    counts[t]++;
    const ok = !!g.rules.analyzeWin(counts, exposed, { closed, ron: true });
    counts[t]--;
    if (ok) { winnable++; winnableLive += u; }
  }
  return { types: waits.length, live, winnable, winnableLive };
}
// 打牌の判断で、聴牌になる捨て牌があるか（門前は riichiOptions、鳴いた手は待ちを直接計算）
function tenpaiDiscards(g, s) {
  if (g.isClosed(s)) return new Set(g.riichiOptions(s).map((o) => o.type));
  const out = new Set();
  const counts = g.countsOf(g.hands[s]);
  for (const t of new Set(g.hands[s].map((id) => g.typeOf(id)))) {
    counts[t]--;
    if (g.waitsOf(counts, g.exposedMelds(s), g.isClosed(s)).length) out.add(t);
    counts[t]++;
  }
  return out;
}

// presetWall：テスト用の固定の山（既定は seed の山）
export function playRound({ rules, seed, dealer, agents, decideFor, info, presetWall = null }) {
  const players = agents.map((a) => ({ name: a, kind: 'ai', personality: 'speed' }));
  const g = new Game({ rules, seed, dealer, players, ruleset: 2, presetWall });
  const rngs = [0, 1, 2, 3].map((s) => createRng(((seed * 4 + s) ^ 0x5bd1e995) >>> 0)); // 席ごとの乱数列
  const R = [0, 1, 2, 3].map(newSeatRound);
  for (let step = 0; g.pending(); step++) {
    if (step > 2000) throw new Error('step cap');
    const p = g.pending(), s = p.seat, r = R[s];
    const before = g.ronBlocked.map((b) => b && b.at);
    const a = decideFor(g, p, s, rngs[s], info);
    if (p.type === 'turn') {
      if (p.canTsumo) { r.tsumoOpp++; if (a.type === 'tsumo') r.tsumoTaken++; }
      if (a.type === 'discard') {
        r.turns++; r.discards++;
        if (!g.riichi[s]) {
          const opts = g.riichiOptions(s);
          if (opts.length) {
            r.riichiOpp++; r.riichiOppRound = true;
            if (!a.riichi) r.riichiDeclined++;
          }
          const td = tenpaiDiscards(g, s);
          if (td.size) { r.keepTenpaiOpp++; if (td.has(g.typeOf(a.tile))) r.keepTenpaiChosen++; }
        }
      }
    } else {
      if (p.ron) { r.ronOpp++; if (a.type === 'ron') r.ronTaken++; }
      if (p.chi && p.chi.length) { r.chiOpp++; if (a.type === 'chi') r.chiChosen++; }
      if (p.pon) { r.ponOpp++; if (a.type === 'pon') r.ponChosen++; }
    }
    applyAction(g, s, a);
    g.checkInvariants();
    g.ronBlocked.forEach((b, i) => { if (b && b.at !== before[i]) R[i].furitenBlocked++; });
    // 打牌の後：その席の聴牌（初めての聴牌の巡目・待ち）とリーチ時の待ち
    if (a.type === 'discard' && g.phase !== 'ended' && !(g.current === s && g.phase === 'turn')) {
      const w = waitsInfo(g, s);
      if (w) {
        if (!r.tenpai) { r.tenpai = true; r.firstTenpaiTurn = r.turns; r.firstWaits = w; }
        if (!w.winnable) r.yakulessTenpai = true;
        if (g.melds[s].some((m) => m.call === 'chi' || m.call === 'pon')) { r.tenpaiAfterCall = true; if (!w.winnable) r.yakulessAfterCall = true; }
        if (a.riichi && !r.riichiWaits) r.riichiWaits = w;
      }
      if (a.riichi) { r.riichiDeclared = true; r.riichiTurn = r.turns; }
    }
  }
  const res = g.result;
  for (const e of g.events) {
    if (e.type === 'chi') R[e.seat].chiMade++;
    if (e.type === 'pon') R[e.seat].ponMade++;
  }
  for (const r of R) r.calls = r.chiMade + r.ponMade;
  for (let s = 0; s < 4; s++) {
    const w = g.phase === 'ended' && (res.type !== 'win' || res.winner !== s) ? waitsInfo(g, s) : null;
    R[s].tenpaiAtEnd = !!w; R[s].endLive = w ? w.live : 0; R[s].endWinnable = !!(w && w.winnable);
  }
  if (res.type === 'win') {
    const w = R[res.winner];
    Object.assign(w, { won: true, how: res.how, points: res.points, dora: res.analysis.doraBonus || 0, yaku: res.analysis.yaku.map((y) => y.id) });
    if (res.how === 'ron') { R[res.from].dealtIn = true; R[res.from].dealtInWhileRiichi = !!g.riichi[res.from]; }
  }
  return {
    g, seats: R,
    round: {
      type: res.type, reason: res.reason || (res.type === 'draw' ? (g.wall.length ? 'cap' : 'wall') : null),
      winner: res.winner ?? null, how: res.how || null, points: res.points || 0, turns: g.turnCount,
      riichiCount: g.riichi.filter(Boolean).length, calls: R.reduce((n, x) => n + x.calls, 0),
      tenpaiAtEnd: R.filter((x) => x.tenpaiAtEnd).length, wallLeft: g.wall.length,
    },
  };
}

// 1試合：agents は席0〜3の担当（AI の id または 'novice-basic' / 'novice-smart'）
// policies（研究用・任意）：{ id: (g, p, seat, rng, info, aiIds) => action } その担当の判断を差し替える（例：あおとの改善案の研究）
export function playMatch({ mode, length, agents, seed, startDealer, policies = null }) {
  const rules = createRules(makeConfig({ mode }));
  let m = createMatch({ length, startDealer, riichiDeposit: RIICHI_DEPOSIT, agariYame: true });
  let history = newPublicHistory();
  // 席ID（PR #65 監査 P2-2）：本番（app.js）と同じく4席の配列で席順を保つ。AI 以外（初心者代理）の席は 'human'
  // （本番の人の席と同じ識別子）。かなたは seatIds.indexOf('aoto') で、実際のあおとの席の公開河を読む
  const aiIds = agents.map((a) => (AI4.includes(a) ? a : 'human'));
  const decideFor = (g, p, s, rng, info) => {
    const id = agents[s];
    if (policies && policies[id]) return policies[id](g, p, s, rng, info, aiIds);
    if (id.startsWith('novice-')) return NOVICE[id.slice(7)](g, p, rng);
    return decideCharacter(g, s, id, rng, info, aiIds);
  };
  const rounds = [];
  for (let n = 0; !m.over; n++) {
    if (n > 40) throw new Error('round cap');
    const info = { ...matchInfo(m), publicHistory: history };
    const out = playRound({ rules, seed: seed * 101 + n * 7919, dealer: dealerOf(m), agents, decideFor, info });
    history = recordPublicRound(history, out.g.events, out.g.riichi);
    const before = m.scores.slice();
    m = applyRoundResult(m, out.g.result, { round: n + 1, maxRound: 40, riichi: out.g.riichi });
    if (m.scores.reduce((a, b) => a + b, 0) + potTotal(m) !== 400) throw new Error('400-point conservation');
    rounds.push({ ...out.round, dealer: m.log.at(-1).dealer, deltas: m.scores.map((x, i) => x - before[i]), seats: out.seats });
  }
  if (potTotal(m)) throw new Error('unreturned deposit');
  return { agents, scores: m.scores.slice(), ranks: ranks(m.scores), rounds, played: m.played, endReason: m.endReason };
}

// ---- 集計 ----
// 95% Wilson 区間
export function wilson(k, n) {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return { k, n, rate: +p.toFixed(4), lo: +(c - h).toFixed(4), hi: +(c + h).toFixed(4) };
}
const meanCI = (xs) => {
  if (!xs.length) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
  return { n: xs.length, mean: +m.toFixed(3), lo: +(m - 1.96 * sd / Math.sqrt(xs.length)).toFixed(3), hi: +(m + 1.96 * sd / Math.sqrt(xs.length)).toFixed(3) };
};

export function summarize(matches) {
  const by = {};
  const get = (id) => by[id] || (by[id] = { matches: 0, ranks: [], scores: [], rounds: 0, R: [], dealIns: 0, dealInPts: [] });
  for (const mt of matches) {
    mt.agents.forEach((id, s) => { const a = get(id); a.matches++; a.ranks.push(mt.ranks[s]); a.scores.push(mt.scores[s]); });
    for (const rd of mt.rounds) mt.agents.forEach((id, s) => {
      const a = get(id); a.rounds++; a.R.push(rd.seats[s]);
      if (rd.seats[s].dealtIn) { a.dealIns++; a.dealInPts.push(-rd.deltas[s]); }
    });
  }
  const out = {};
  for (const [id, a] of Object.entries(by)) {
    const R = a.R, sum = (f) => R.reduce((n, r) => n + f(r), 0);
    const wins = R.filter((r) => r.won), tenpaiR = R.filter((r) => r.tenpai);
    const firstWaits = tenpaiR.map((r) => r.firstWaits);
    const riichiR = R.filter((r) => r.riichiDeclared), calledR = R.filter((r) => r.calls > 0), closedR = R.filter((r) => r.calls === 0);
    out[id] = {
      name: NAMES[id] || id, matches: a.matches, rounds: a.rounds,
      result: {
        top: wilson(a.ranks.filter((x) => x === 1).length, a.matches), last: wilson(a.ranks.filter((x) => x === 4).length, a.matches),
        meanRank: meanCI(a.ranks), meanScore: meanCI(a.scores),
      },
      win: {
        rate: wilson(wins.length, a.rounds), ron: wins.filter((r) => r.how === 'ron').length, tsumo: wins.filter((r) => r.how === 'tsumo').length,
        meanPoints: meanCI(wins.map((r) => r.points)), meanDora: meanCI(wins.map((r) => r.dora)),
        yaku: Object.fromEntries(Object.entries(wins.flatMap((r) => r.yaku).reduce((m, y) => ((m[y] = (m[y] || 0) + 1), m), {})).sort((x, y) => y[1] - x[1])),
      },
      dealIn: { rate: wilson(a.dealIns, a.rounds), meanPaid: meanCI(a.dealInPts), whileRiichi: sum((r) => r.dealtIn && r.dealtInWhileRiichi ? 1 : 0) },
      discards: sum((r) => r.discards),
      tenpai: {
        roundRate: wilson(tenpaiR.length, a.rounds), meanFirstTurn: meanCI(tenpaiR.map((r) => r.firstTenpaiTurn)),
        firstWaitTypes: meanCI(firstWaits.map((w) => w.types)), firstLive: meanCI(firstWaits.map((w) => w.live)),
        yakulessRounds: wilson(sum((r) => (r.yakulessTenpai ? 1 : 0)), Math.max(1, tenpaiR.length)),
        winFromTenpai: wilson(tenpaiR.filter((r) => r.won).length, tenpaiR.length),
        // 聴牌を保つ（作る）打牌がある判断で、それを選んだ割合（分母＝その判断の回数）
        keepTenpai: wilson(sum((r) => r.keepTenpaiChosen), sum((r) => r.keepTenpaiOpp)),
      },
      riichi: {
        oppTurns: sum((r) => r.riichiOpp), declinedTurns: sum((r) => r.riichiDeclined),
        declareRateByTurn: wilson(sum((r) => r.riichiOpp) - sum((r) => r.riichiDeclined), sum((r) => r.riichiOpp)),
        oppRounds: sum((r) => (r.riichiOppRound ? 1 : 0)), declaredRounds: riichiR.length,
        declareRateByRound: wilson(riichiR.length, sum((r) => (r.riichiOppRound ? 1 : 0))),
        winAfterRiichi: wilson(riichiR.filter((r) => r.won).length, riichiR.length),
        riichiWaitTypes: meanCI(riichiR.filter((r) => r.riichiWaits).map((r) => r.riichiWaits.types)),
        riichiLive: meanCI(riichiR.filter((r) => r.riichiWaits).map((r) => r.riichiWaits.live)),
      },
      calls: {
        chi: wilson(sum((r) => r.chiChosen), sum((r) => r.chiOpp)), pon: wilson(sum((r) => r.ponChosen), sum((r) => r.ponOpp)),
        chiMade: wilson(sum((r) => r.chiMade), sum((r) => r.chiOpp)), ponMade: wilson(sum((r) => r.ponMade), sum((r) => r.ponOpp)),
        chosen: sum((r) => r.chiChosen + r.ponChosen), made: sum((r) => r.chiMade + r.ponMade),
        cancelled: sum((r) => r.chiChosen + r.ponChosen) - sum((r) => r.chiMade + r.ponMade), // ロン優先・ポン優先で取り消された鳴き
        roundsWithCalls: wilson(calledR.length, a.rounds),
        winRateCalled: wilson(calledR.filter((r) => r.won).length, calledR.length), winRateClosed: wilson(closedR.filter((r) => r.won).length, closedR.length),
        tenpaiRateCalled: wilson(calledR.filter((r) => r.tenpai).length, calledR.length), tenpaiRateClosed: wilson(closedR.filter((r) => r.tenpai).length, closedR.length),
        // 分母：鳴きが成立した局のうち、成立後の自分の打牌の直後に聴牌（形）になった局。分子：そのうち役のない聴牌を観測した局
        yakulessTenpaiCalled: wilson(calledR.filter((r) => r.yakulessAfterCall).length, calledR.filter((r) => r.tenpaiAfterCall).length),
      },
      claims: { ron: wilson(sum((r) => r.ronTaken), sum((r) => r.ronOpp)), tsumo: wilson(sum((r) => r.tsumoTaken), sum((r) => r.tsumoOpp)), furitenBlocked: sum((r) => r.furitenBlocked) },
      draws: { tenpaiAtDraw: sum((r) => (r.tenpaiAtEnd ? 1 : 0)) },
    };
  }
  const rounds = matches.flatMap((m) => m.rounds);
  const draws = rounds.filter((r) => r.type === 'draw');
  const meanOf = (xs, f) => meanCI(xs.map(f));
  const table = {
    matches: matches.length, rounds: rounds.length,
    winRate: wilson(rounds.length - draws.length, rounds.length), drawRate: wilson(draws.length, rounds.length),
    drawReasons: draws.reduce((m, r) => ((m[r.reason] = (m[r.reason] || 0) + 1), m), {}),
    tenpaiPlayersAtDraw: meanOf(draws, (r) => r.tenpaiAtEnd), riichiPerRound: meanOf(rounds, (r) => r.riichiCount),
    callsPerRound: meanOf(rounds, (r) => r.calls), turnsPerRound: meanOf(rounds, (r) => r.turns), winTurns: meanOf(rounds.filter((r) => r.type === 'win'), (r) => r.turns),
  };
  return { agents: out, table };
}

// ---- 実験計画（サンプル数は事前に宣言。--scale で全体を倍率変更） ----
export function plan(scale = 1, modes = ['math1', 'math2']) {
  const n = (x) => Math.max(1, Math.round(x * scale));
  const P = [];
  for (const mode of modes) {
    // E1：初級AI 4人。同じ seed・親で席を4通りに回す（各キャラが各席に1回ずつ）
    for (const [length, seeds] of [[1, n(60)], [4, n(20)], [8, n(10)]]) P.push({ exp: 'ai4', scenario: 'baseline', mode, length, seeds, rotations: 4 });
    // E2：初心者代理（基本・リーチ＋限定チー）＋初級AI 3人。同じ seed・親・相手・席でペア比較
    for (const [length, seeds] of [[1, n(96)], [4, n(32)], [8, n(16)]]) P.push({ exp: 'novice', scenario: 'baseline', mode, length, seeds, rotations: 1 });
    // E3：流局の原因（研究条件 easy＝既存研究PRの弱体化設定）。E1 の4局戦と同じ seed で比較
    P.push({ exp: 'ai4', scenario: 'easy', mode, length: 4, seeds: n(20), rotations: 4 });
    // E4：あおとの反実仮想（研究用）。E1 の4局戦と同じ seed で、鳴き・雑な打牌のどちらが敗因かを切り分ける
    for (const scenario of ['aotoNoCall', 'aotoNoRandom', 'aotoNoCallNoRandom']) P.push({ exp: 'ai4', scenario, mode, length: 4, seeds: n(20), rotations: 4 });
  }
  return P;
}

export function runCell(cell, seed0) {
  SCENARIOS[cell.scenario]();
  const variants = cell.exp === 'novice' ? NOVICE_VARIANTS : [null];
  const out = Object.fromEntries(variants.map((v) => [v || 'ai4', []]));
  for (let k = 0; k < cell.seeds; k++) {
    const seed = seed0 + k * 9719 + cell.length * 131 + (cell.mode === 'math2' ? 500000 : 0);
    const startDealer = k % 4;
    if (cell.exp === 'ai4') {
      for (let rot = 0; rot < cell.rotations; rot++) {
        const agents = [0, 1, 2, 3].map((s) => AI4[(s + rot) % 4]);
        out.ai4.push(playMatch({ mode: cell.mode, length: cell.length, agents, seed, startDealer }));
      }
    } else {
      // 相手：4人のうち k%4 番目を外した3人、席順は k%3 だけ回す
      const ids = AI4.filter((_, i) => i !== k % 4);
      const opp = [...ids.slice(k % 3), ...ids.slice(0, k % 3)];
      for (const v of variants) out[v].push(playMatch({ mode: cell.mode, length: cell.length, agents: [v, ...opp], seed, startDealer }));
    }
  }
  SCENARIOS.baseline();
  return out;
}

// ペア比較（同じ seed・親・相手・席）：初心者代理の基本とスマートの順位差
export function pairedNovice(basic, smart) {
  const d = basic.map((m, i) => smart[i].ranks[0] - m.ranks[0]);
  const better = d.filter((x) => x < 0).length, worse = d.filter((x) => x > 0).length;
  const s = basic.map((m, i) => smart[i].scores[0] - m.scores[0]);
  return { pairs: d.length, smartBetter: better, smartWorse: worse, same: d.length - better - worse, meanRankDiff: meanCI(d), meanScoreDiff: meanCI(s) };
}

// ---- CLI ----
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const scale = Number(opt('--scale', 1)), seed0 = Number(opt('--seed', 690001)), outFile = opt('--out', null);
  const modes = opt('--modes', 'math1,math2').split(',');
  const t0 = Date.now();
  const result = { definition: { tool: 'tools/research-beginner-loss-diagnostics.mjs', ruleset: 2, riichiDeposit: RIICHI_DEPOSIT, agariYame: true, seed0, scale,
    novice: 'basic：75%基本の残し方・25%無作為の打牌、リーチなし・鳴きなし。smart：利用できるリーチを85%で宣言、面子未公開時にチー22%。和了はいつでもする。実際の人間ではない。',
    denominators: '割合の分母は合法な選択機会（pending の ron/tsumo/chi/pon、riichiOptions のリーチ、聴牌を保つ打牌の有無）。区間は95% Wilson（平均は±1.96SE）。鳴きは選択（chosen）と成立（made：公開面子になった）を分ける。鳴いた局＝成立した鳴きのある局。鳴いた手の役なし聴牌＝成立後の自分の打牌の直後に聴牌（形）を観測した局のうち、役のない聴牌を観測した局の割合。',
    plan: plan(scale, modes) }, cells: {} };
  for (const cell of plan(scale, modes)) {
    const key = `${cell.exp}:${cell.scenario}:${cell.mode}:${cell.length}`;
    const out = runCell(cell, seed0);
    result.cells[key] = Object.fromEntries(Object.entries(out).map(([v, ms]) => [v, summarize(ms)]));
    if (cell.exp === 'novice') {
      // 段階ごとのペア比較：基本→聴牌を保つ→＋リーチ→＋チー（同じ seed・相手・席）
      result.cells[key].paired = pairedNovice(out['novice-basic'], out['novice-smart']);
      result.cells[key].steps = {
        keepVsBasic: pairedNovice(out['novice-basic'], out['novice-keep']),
        riichiVsKeep: pairedNovice(out['novice-keep'], out['novice-riichi']),
        chiVsRiichi: pairedNovice(out['novice-riichi'], out['novice-smart']),
      };
    }
    process.stderr.write(`${key} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
  }
  result.seconds = (Date.now() - t0) / 1000;
  const json = JSON.stringify(result, null, 1);
  if (outFile) writeFileSync(outFile, json); else process.stdout.write(json + '\n');
}
