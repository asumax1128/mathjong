// 研究専用（docs/70）：あおとの改善案4条件を、同じ seed・親・席で比べるシミュレーション。
// 本番の AI・エンジン・UI は変更しない。条件は「本番のあおとの判断（decideCharacter）を先に求め、その後で研究用の規則で
// 差し替える」形で作る（乱数の使い方は本番と同じ。差し替えたときだけ行動が変わる）。統計的な採用判断はこのツールではしない。
//
//   A：現行（本番の判断そのまま）
//   B：役を狙える鳴きだけ許可。本番があおとの確率でポン・チーを選んだとき、その鳴きの後の局面で
//      鳴いた手でも成立する役（門前限定・特殊和了を除く）の候補が「あと maxMissing 枚以内」で残る場合だけ鳴く。残らなければ見送る。
//      役候補は既存の yakuhint.yakuCandidates（自分の手牌と公開情報だけ。山の中身・他家の手牌は使わない）。
//   C：聴牌を維持する打牌を優先し、それ以外の雑さは保持。本番の打牌（40% の雑な打牌を含む）が、聴牌になる捨て牌があるのに
//      聴牌を崩すときだけ、聴牌になる捨て牌のうち見えていない残り枚数（公開情報）が最も多いものに差し替える。
//      聴牌にならない局面の打牌は本番のまま（雑さを保持）。リーチの宣言は本番と同じ riichiDecision（初級）。
//   D：B と C の併用。
//
// 使い方：node tools/research-aoto-variants.mjs [--out file.json] [--scale 1] [--modes math1,math2] [--seed 700001] [--max-missing 2]
import { writeFileSync } from 'node:fs';
import { riichiDecision } from '../src/engine/ai.js';
import { decideCharacter } from '../src/engine/characters.js';
import { yakuCandidates, unseenFromView } from '../src/engine/yakuhint.js';
import { RIICHI_DEPOSIT } from '../src/engine/match.js';
import { playMatch, summarize, AI4, wilson } from './research-beginner-loss-diagnostics.mjs';

export const VARIANTS = ['A', 'B', 'C', 'D'];
export const VARIANT_LABELS = { A: '現行', B: '役を狙える鳴きだけ', C: '聴牌を維持する打牌を優先（ほかの雑さは保持）', D: 'B＋C' };
export const DEFAULT_MAX_MISSING = 2;

// ---- B：その鳴きの後に、鳴いた手で成立する役が「あと maxMissing 枚以内」で残るか（公開情報と自分の手牌だけ） ----
export function callKeepsYaku(g, seat, p, call, maxMissing = DEFAULT_MAX_MISSING) {
  const view = g.viewFor(seat);
  const type = g.typeOf(p.tile);
  const claim = call.type === 'pon'
    ? { type, from: p.from, ron: false, chiMelds: [], ponMeld: p.pon.meld }
    : { type, from: p.from, ron: false, chiMelds: [p.chi[call.option].meld], ponMeld: null };
  const cands = yakuCandidates(g.rules, view, { limit: 99, claim });
  return cands.some((c) => c.via === call.type && !c.closedOnly && !c.special && c.missing <= maxMissing);
}

// ---- C：聴牌になる捨て牌（自分の手牌だけ）。門前は riichiOptions、鳴いた手は待ちを直接計算 ----
export function tenpaiDiscardTypes(g, seat) {
  if (g.isClosed(seat)) return g.riichiOptions(seat).map((o) => ({ type: o.type, waits: o.waits }));
  const out = [];
  const counts = g.countsOf(g.hands[seat]);
  for (const t of new Set(g.hands[seat].map((id) => g.typeOf(id)))) {
    counts[t]--;
    const waits = g.waitsOf(counts, g.exposedMelds(seat), g.isClosed(seat));
    counts[t]++;
    if (waits.length) out.push({ type: t, waits });
  }
  return out;
}
export function keepTenpaiTile(g, seat, tile) {
  const opts = tenpaiDiscardTypes(g, seat);
  if (!opts.length || opts.some((o) => o.type === g.typeOf(tile))) return tile; // 聴牌にならない局面・すでに聴牌を保つ打牌はそのまま
  const unseen = unseenFromView(g.rules, g.viewFor(seat));
  const live = (o) => o.waits.reduce((n, t) => n + Math.max(0, unseen[t]), 0);
  // 残り枚数が最も多い（同じなら牌の種類の index が小さい）聴牌になる捨て牌
  const best = opts.slice().sort((a, b) => live(b) - live(a) || a.type - b.type)[0];
  return g.hands[seat].find((id) => g.typeOf(id) === best.type);
}

// あおとの判断（条件ごと）。stats：差し替えの回数（実装の確認用）
export function aotoPolicy(variant, { maxMissing = DEFAULT_MAX_MISSING, stats = null } = {}) {
  const useB = variant === 'B' || variant === 'D', useC = variant === 'C' || variant === 'D';
  return (g, p, seat, rng, info, aiIds) => {
    const a = decideCharacter(g, seat, 'aoto', rng, info, aiIds); // 本番の判断（乱数の消費も本番と同じ）
    if (useB && p.type === 'claim' && (a.type === 'pon' || a.type === 'chi')) {
      if (stats) stats.callsConsidered++;
      if (!callKeepsYaku(g, seat, p, a, maxMissing)) { if (stats) stats.callsBlocked++; return { type: 'pass' }; }
    }
    if (useC && p.type === 'turn' && a.type === 'discard' && !g.riichi[seat]) {
      if (stats) stats.discardsChecked++;
      const tile = keepTenpaiTile(g, seat, a.tile);
      if (tile !== a.tile) {
        if (stats) stats.discardsReplaced++;
        return { type: 'discard', tile, ...(riichiDecision(g, seat, tile, 'beginner') ? { riichi: true } : {}) };
      }
    }
    return a;
  };
}

// ---- 実験計画（サンプル数は事前に宣言） ----
export function plan(scale = 1, modes = ['math1', 'math2']) {
  const n = (x) => Math.max(1, Math.round(x * scale));
  const P = [];
  for (const mode of modes) {
    // E1：初級AI 4人（あおとは条件ごとに差し替え）。同じ seed・親で席を4通りに回す
    for (const [length, seeds] of [[1, n(60)], [4, n(20)], [8, n(10)]]) P.push({ exp: 'ai4', mode, length, seeds, rotations: 4 });
    // E2：初心者代理（基本・スマート）＋あおとを含む初級AI 3人。同じ seed・親・相手・席
    for (const [length, seeds] of [[1, n(48)], [4, n(16)], [8, n(8)]]) P.push({ exp: 'novice', mode, length, seeds, rotations: 1 });
  }
  return P;
}

function lineups(cell, k) {
  if (cell.exp === 'ai4') return [0, 1, 2, 3].slice(0, cell.rotations).map((rot) => [0, 1, 2, 3].map((s) => AI4[(s + rot) % 4]));
  // あおとを必ず含む3人（かなた・みつき・ゆうじんから1人を外す）。席順は k%3 だけ回す
  const others = ['kanata', 'mitsuki', 'yujin'].filter((_, i) => i !== k % 3);
  const ids = ['aoto', ...others];
  const opp = [...ids.slice(k % 3), ...ids.slice(0, k % 3)];
  return ['novice-basic', 'novice-smart'].map((v) => [v, ...opp]);
}

export function runCell(cell, seed0, { variants = VARIANTS, maxMissing = DEFAULT_MAX_MISSING } = {}) {
  const out = {};
  for (const v of variants) {
    const stats = { callsConsidered: 0, callsBlocked: 0, discardsChecked: 0, discardsReplaced: 0 };
    const policies = { aoto: aotoPolicy(v, { maxMissing, stats }) };
    const ms = [];
    for (let k = 0; k < cell.seeds; k++) {
      const seed = seed0 + k * 9719 + cell.length * 131 + (cell.mode === 'math2' ? 500000 : 0);
      for (const agents of lineups(cell, k)) ms.push({ ...playMatch({ mode: cell.mode, length: cell.length, agents, seed, startDealer: k % 4, policies }), seed });
    }
    out[v] = { matches: ms, stats };
  }
  return out;
}

// 同じ試合（seed・席）どうしの対応：A と各条件のあおとの順位・点の差（記述のみ。採用判断はしない）
function pairedVsA(byVariant, id = 'aoto') {
  const A = byVariant.A.matches;
  const res = {};
  for (const v of Object.keys(byVariant)) {
    if (v === 'A') continue;
    const M = byVariant[v].matches;
    const dr = [], ds = [];
    M.forEach((m, i) => { const s = m.agents.indexOf(id); if (s < 0) return; dr.push(m.ranks[s] - A[i].ranks[s]); ds.push(m.scores[s] - A[i].scores[s]); });
    const mean = (xs) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : null);
    res[v] = { pairs: dr.length, meanRankDiff: mean(dr), meanScoreDiff: mean(ds), better: dr.filter((x) => x < 0).length, worse: dr.filter((x) => x > 0).length };
  }
  return res;
}

export function runAll({ scale = 1, seed0 = 700001, modes = ['math1', 'math2'], maxMissing = DEFAULT_MAX_MISSING, log = () => {} } = {}) {
  const result = {
    definition: {
      tool: 'tools/research-aoto-variants.mjs', ruleset: 2, riichiDeposit: RIICHI_DEPOSIT, agariYame: true, seed0, scale, maxMissing,
      variants: VARIANT_LABELS,
      note: '研究専用。本番の判断を求めてから研究用の規則で差し替える。統計的な採用判断はしない（独立評価に委ねる）。初心者代理は研究モデルで実際の人間ではない。',
      plan: plan(scale, modes),
    },
    cells: {},
  };
  for (const cell of plan(scale, modes)) {
    const key = `${cell.exp}:${cell.mode}:${cell.length}`;
    const out = runCell(cell, seed0, { maxMissing });
    const entry = {};
    for (const v of VARIANTS) {
      if (cell.exp === 'ai4') entry[v] = { ...summarize(out[v].matches), stats: out[v].stats };
      else entry[v] = {
        'novice-basic': summarize(out[v].matches.filter((m) => m.agents[0] === 'novice-basic')),
        'novice-smart': summarize(out[v].matches.filter((m) => m.agents[0] === 'novice-smart')),
        stats: out[v].stats,
      };
    }
    entry.pairedVsA = { aoto: pairedVsA(out, 'aoto') };
    if (cell.exp === 'novice') {
      const sub = (v, who) => ({ matches: out[v].matches.filter((m) => m.agents[0] === who) });
      for (const who of ['novice-basic', 'novice-smart']) entry.pairedVsA[who] = pairedVsA(Object.fromEntries(VARIANTS.map((v) => [v, sub(v, who)])), who);
    }
    result.cells[key] = entry;
    log(key);
  }
  return result;
}

// 1つの条件の要約（あおと）。表の作成とテストで使う
export function aotoRow(sum) {
  const a = sum.agents.aoto;
  return {
    top: a.result.top, last: a.result.last, meanRank: a.result.meanRank, win: a.win.rate, dealIn: a.dealIn.rate,
    tenpai: a.tenpai.roundRate, keepTenpai: a.tenpai.keepTenpai, callRounds: a.calls.roundsWithCalls,
    winCalled: a.calls.winRateCalled, winClosed: a.calls.winRateClosed, yakulessCalled: a.calls.yakulessTenpaiCalled,
    riichiByRound: a.riichi.declareRateByRound, drawRate: sum.table.drawRate,
  };
}

// ---- CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const t0 = Date.now();
  const result = runAll({
    scale: Number(opt('--scale', 1)), seed0: Number(opt('--seed', 700001)), modes: opt('--modes', 'math1,math2').split(','),
    maxMissing: Number(opt('--max-missing', DEFAULT_MAX_MISSING)), log: (k) => process.stderr.write(`${k} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`),
  });
  result.seconds = (Date.now() - t0) / 1000;
  const outFile = opt('--out', null);
  const json = JSON.stringify(result, null, 1);
  if (outFile) writeFileSync(outFile, json); else process.stdout.write(json + '\n');
}
void wilson;
