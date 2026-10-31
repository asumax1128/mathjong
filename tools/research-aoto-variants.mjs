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
import { playMatch, summarize, AI4, NOVICE_VARIANTS } from './research-beginner-loss-diagnostics.mjs';

export const VARIANTS = ['A', 'B', 'C', 'D']; // 旧版の4条件（B・D は既定の上限 DEFAULT_MAX_MISSING）
export const VARIANT_LABELS = { A: '現行', B: '役を狙える鳴きだけ', C: '聴牌を維持する打牌を優先（ほかの雑さは保持）', D: 'B＋C' };
export const DEFAULT_MAX_MISSING = 2;

// ---- B：その鳴きだけを適用した仮想局面を独立に評価（PR #65 監査 P2-1 の修正） ----
// 旧版は yakuCandidates の claim 経路を使ったが、役ごとに通常経路・鳴き経路の最良を統合するため、同じ役が
// 通常経路で選ばれると鳴き経路の候補が消え、有効な鳴きを見送ることがあった（偽陰性）。
// 新版：対象の鳴き（その1つの選択肢）だけを適用した局面（手牌から使う2枚を除き、公開面子に追加）を作り、
// 鳴いた手として（closed=false）完成しうるすべての面子の組合せをエンジンの役判定（rules.evaluateMelds）で調べる。
// 情報：自分の手牌・公開面子・自分から見えていない枚数（viewFor の公開情報）。他家の手牌・山は使わない。
export function postCallState(g, seat, p, call) {
  const opt = call.type === 'pon' ? p.pon : p.chi[call.option];
  if (!opt) throw new Error('call option not available');
  const handIds = g.hands[seat].filter((id) => !opt.use.includes(id));
  if (handIds.length !== g.hands[seat].length - 2) throw new Error('call tiles not in hand');
  return {
    handIds, counts: g.countsOf(handIds), meld: opt.meld,
    exposed: [...g.exposedMelds(seat), opt.meld],
    unseen: unseenFromView(g.rules, g.viewFor(seat)), // 鳴いた牌・使う2枚は見えている牌のまま（数は変わらない）
  };
}
// 鳴いて1枚捨てた後、役のある和了形まで「あと何枚」か（届かなければ Infinity）と、その形で成立する役。
// 手牌は 3k 枚（k＝手牌で作る面子の数）。必要な牌がすべて手にある形でも1枚捨てるので、距離は max(1, 不足枚数)。
export function yakuDistanceAfterCall(rules, st) {
  const k = 3 - st.exposed.length;
  const melds = rules.melds;
  let best = Infinity, bestYaku = null;
  const req = new Array(rules.types.length).fill(0);
  const visit = (start, depth, chosen) => {
    if (depth === k) {
      let need = 0;
      for (let t = 0; t < req.length; t++) {
        const n = req[t] - st.counts[t];
        if (n > 0) { if (n > Math.max(0, st.unseen[t])) return; need += n; }
      }
      const dist = Math.max(1, need);
      if (dist >= best) return;
      const ev = rules.evaluateMelds([...st.exposed, ...chosen], false);
      if (ev.hasYaku) { best = dist; bestYaku = ev.yaku.map((y) => y.id); }
      return;
    }
    for (let i = start; i < melds.length; i++) {
      for (const t of melds[i].tiles) req[t]++;
      visit(i, depth + 1, [...chosen, i]);
      for (const t of melds[i].tiles) req[t]--;
    }
  };
  visit(0, 0, []);
  return { distance: best, yaku: bestYaku };
}
export function callYakuDistance(g, seat, p, call) {
  return yakuDistanceAfterCall(g.rules, postCallState(g, seat, p, call)).distance;
}
export function callKeepsYaku(g, seat, p, call, maxMissing = DEFAULT_MAX_MISSING) {
  return callYakuDistance(g, seat, p, call) <= maxMissing;
}
// 旧版（監査前）の判定。比較・回帰テスト用に残す（研究条件では使わない）
export function callKeepsYakuLegacy(g, seat, p, call, maxMissing = DEFAULT_MAX_MISSING) {
  const view = g.viewFor(seat);
  const type = g.typeOf(p.tile);
  const claim = call.type === 'pon'
    ? { type, from: p.from, ron: false, chiMelds: [], ponMeld: p.pon.meld }
    : { type, from: p.from, ron: false, chiMelds: [p.chi[call.option].meld], ponMeld: null };
  const cands = yakuCandidates(g.rules, view, { limit: 99, claim });
  return cands.some((c) => c.via === call.type && !c.closedOnly && !c.special && c.missing <= maxMissing);
}
// 検算用：鳴いた後の局面を view として独立に作り、yakuCandidates（claim なし）で最短の不足枚数を求める
export function callYakuDistanceByHint(g, seat, p, call) {
  const st = postCallState(g, seat, p, call);
  const view = g.viewFor(seat);
  const rivers = view.rivers.map((r) => r.slice());
  const ri = rivers[p.from].lastIndexOf(g.typeOf(p.tile));
  if (ri >= 0) rivers[p.from].splice(ri, 1);
  const melds = view.melds.map((ms) => ms.slice());
  melds[seat].push({ meld: st.meld, kind: g.rules.melds[st.meld].kind, call: call.type, tiles: g.rules.melds[st.meld].tiles.slice(), from: p.from });
  const v = { seat, hand: st.handIds.map((id) => ({ id, type: g.typeOf(id) })), melds, rivers, ...(view.doraIndicators ? { doraIndicators: view.doraIndicators } : {}) };
  const c = yakuCandidates(g.rules, v, { limit: 999 }).filter((x) => !x.closedOnly && !x.special);
  return c.length ? Math.max(1, Math.min(...c.map((x) => x.missing))) : Infinity;
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

// 条件の名前：A・C、B と D は不足枚数の上限つき（B1・B2・B3・D1・D2・D3）。'B'・'D' だけなら maxMissing を使う
export function parseVariant(v, maxMissing = DEFAULT_MAX_MISSING) {
  const m = /^([ABCD])([0-9]*)$/.exec(v);
  if (!m) throw new Error('unknown variant ' + v);
  const letter = m[1];
  return { letter, useB: letter === 'B' || letter === 'D', useC: letter === 'C' || letter === 'D', maxMissing: m[2] ? Number(m[2]) : maxMissing };
}
export const newStats = () => ({ callsConsidered: 0, callsBlocked: 0, legacyWouldBlock: 0, newAllowsLegacyBlocked: 0, discardsChecked: 0, discardsReplaced: 0 });

// あおとの判断（条件ごと）。stats：差し替えの回数（実装の確認用）。legacyWouldBlock：旧版の B 判定なら見送った鳴き
export function aotoPolicy(variant, { maxMissing = DEFAULT_MAX_MISSING, stats = null } = {}) {
  const V = parseVariant(variant, maxMissing);
  return (g, p, seat, rng, info, aiIds) => {
    const a = decideCharacter(g, seat, 'aoto', rng, info, aiIds); // 本番の判断（乱数の消費も本番と同じ）
    if (V.useB && p.type === 'claim' && (a.type === 'pon' || a.type === 'chi')) {
      const ok = callKeepsYaku(g, seat, p, a, V.maxMissing);
      if (stats) {
        stats.callsConsidered++;
        const legacy = callKeepsYakuLegacy(g, seat, p, a, V.maxMissing);
        if (!legacy) stats.legacyWouldBlock++;
        if (ok && !legacy) stats.newAllowsLegacyBlocked++;
      }
      if (!ok) { if (stats) stats.callsBlocked++; return { type: 'pass' }; }
    }
    if (V.useC && p.type === 'turn' && a.type === 'discard' && !g.riichi[seat]) {
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
// 条件：A（現行）・C・B と D は不足枚数の上限 1・2・3（PR #65 監査の再検証）
export const PLAN_VARIANTS = ['A', 'B1', 'B2', 'B3', 'C', 'D1', 'D2', 'D3'];
export function plan(scale = 1, modes = ['math1', 'math2']) {
  const n = (x) => Math.max(1, Math.round(x * scale));
  const P = [];
  for (const mode of modes) {
    // E1：初級AI 4人（あおとは条件ごとに差し替え）。同じ seed・親で席を4通りに回す（1 seed＝1クラスタ）
    for (const [length, seeds] of [[1, n(60)], [4, n(20)], [8, n(10)]]) P.push({ exp: 'ai4', mode, length, seeds, rotations: 4 });
    // E2：初心者代理4版＋あおとを含む初級AI 3人。同じ seed・親・相手・席（1 seed＝4版の1クラスタ）
    for (const [length, seeds] of [[1, n(48)], [4, n(16)], [8, n(8)]]) P.push({ exp: 'novice', mode, length, seeds, rotations: 1 });
  }
  return P;
}

export function lineups(cell, k) {
  if (cell.exp === 'ai4') return [0, 1, 2, 3].slice(0, cell.rotations).map((rot) => [0, 1, 2, 3].map((s) => AI4[(s + rot) % 4]));
  // あおとを必ず含む3人（かなた・みつき・ゆうじんから1人を外す）。席順は k%3 だけ回す。代理は席0
  const others = ['kanata', 'mitsuki', 'yujin'].filter((_, i) => i !== k % 3);
  const ids = ['aoto', ...others];
  const opp = [...ids.slice(k % 3), ...ids.slice(0, k % 3)];
  return NOVICE_VARIANTS.map((v) => [v, ...opp]);
}
export const cellSeed = (cell, seed0, k) => seed0 + k * 9719 + cell.length * 131 + (cell.mode === 'math2' ? 500000 : 0);

export function runCell(cell, seed0, { variants = PLAN_VARIANTS, maxMissing = DEFAULT_MAX_MISSING } = {}) {
  const out = {};
  for (const v of variants) {
    const stats = newStats();
    const policies = { aoto: aotoPolicy(v, { maxMissing, stats }) };
    const ms = [];
    for (let k = 0; k < cell.seeds; k++) {
      const seed = cellSeed(cell, seed0, k);
      for (const agents of lineups(cell, k)) ms.push({ ...playMatch({ mode: cell.mode, length: cell.length, agents, seed, startDealer: k % 4, policies }), seed, cluster: k, startDealer: k % 4 });
    }
    out[v] = { matches: ms, stats };
  }
  return out;
}

// ---- 試合ごとの記録（P3）：seed・席（担当）・親・相手・条件・順位・点 ----
export function matchRecords(cellKey, variant, matches) {
  return matches.map((m, i) => ({
    cell: cellKey, variant, index: i, cluster: m.cluster, seed: m.seed, startDealer: m.startDealer,
    seats: m.agents.slice(), ranks: m.ranks.slice(), scores: m.scores.slice(), played: m.played, endReason: m.endReason,
    aotoSeat: m.agents.indexOf('aoto'), novice: m.agents[0].startsWith('novice-') ? m.agents[0] : null,
  }));
}

// t 分布の 97.5% 点（Cornish–Fisher 近似。df ≥ 1）
export function t975(df) {
  const z = 1.959964;
  if (df <= 0) return NaN;
  const T = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262 };
  if (T[df]) return T[df];
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df * df);
}
// seed クラスタのペア差：同じ試合（seed・席・相手）の条件 V と A の差を、seed ごとに平均してから、クラスタ平均の平均と 95% CI（t, df=n−1）
// subject：'aoto'（その試合のあおとの席）または初心者代理の版（席0）。field：'ranks' | 'scores'
export function clusterPairedCI(recA, recV, subject, field) {
  const by = new Map();
  recV.forEach((r, i) => {
    const a = recA[i];
    if (a.seed !== r.seed || a.seats.join() !== r.seats.join()) throw new Error('pair mismatch');
    const seat = subject === 'aoto' ? r.aotoSeat : r.seats.indexOf(subject);
    if (seat < 0) return;
    const d = r[field][seat] - a[field][seat];
    if (!by.has(r.cluster)) by.set(r.cluster, []);
    by.get(r.cluster).push(d);
  });
  const means = [...by.values()].map((xs) => xs.reduce((x, y) => x + y, 0) / xs.length);
  const n = means.length;
  if (!n) return null;
  const mean = means.reduce((x, y) => x + y, 0) / n;
  const sd = n > 1 ? Math.sqrt(means.reduce((x, y) => x + (y - mean) ** 2, 0) / (n - 1)) : 0;
  const h = n > 1 ? t975(n - 1) * sd / Math.sqrt(n) : NaN;
  const pairs = [...by.values()].reduce((x, xs) => x + xs.length, 0);
  return { clusters: n, pairs, mean: +mean.toFixed(4), lo: +(mean - h).toFixed(4), hi: +(mean + h).toFixed(4) };
}

export function runAll({ scale = 1, seed0 = 700001, modes = ['math1', 'math2'], variants = PLAN_VARIANTS, log = () => {} } = {}) {
  const result = {
    definition: {
      tool: 'tools/research-aoto-variants.mjs', ruleset: 2, riichiDeposit: RIICHI_DEPOSIT, agariYame: true, seed0, scale, variants,
      variantLabels: VARIANT_LABELS,
      bRule: 'B・D：本番が選んだ鳴きを、その鳴きだけを適用した仮想局面で評価し、鳴いた手として役のある和了形まで（鳴いて1枚捨てた後に）あと N 枚以内なら鳴く（N は B1/B2/B3 の数字）。エンジンの rules.evaluateMelds で全組合せを列挙（PR #65 監査 P2-1 の修正）',
      seatIds: 'decideCharacter の seatIds は本番と同じ4席の配列（初心者代理の席は human）。PR #65 監査 P2-2 の修正',
      callMetrics: '鳴きは選択（chosen）と成立（made）を分ける。PR #65 監査 P2-3 の修正',
      ci: '条件Aとのペア差は、同じ seed の席替え（E1 は4席、E2 は代理4版）を1クラスタとして平均し、クラスタ平均の 95% CI（t 分布）',
      note: '研究専用。本番の判断を求めてから研究用の規則で差し替える。統計的な採用判断はしない（独立評価に委ねる）。初心者代理は研究モデルで実際の人間ではない。',
      plan: plan(scale, modes),
    },
    cells: {}, records: [],
  };
  for (const cell of plan(scale, modes)) {
    const key = `${cell.exp}:${cell.mode}:${cell.length}`;
    const out = runCell(cell, seed0, { variants });
    const entry = {};
    const recs = {};
    for (const v of variants) {
      recs[v] = matchRecords(key, v, out[v].matches);
      result.records.push(...recs[v]);
      if (cell.exp === 'ai4') entry[v] = { ...summarize(out[v].matches), stats: out[v].stats };
      else entry[v] = { ...Object.fromEntries(NOVICE_VARIANTS.map((nv) => [nv, summarize(out[v].matches.filter((m) => m.agents[0] === nv))])), all: summarize(out[v].matches), stats: out[v].stats };
    }
    // 条件A とのペア差（seed クラスタの 95% CI）。記述のみ
    entry.pairedVsA = {};
    for (const v of variants) {
      if (v === 'A') continue;
      const subjects = cell.exp === 'ai4' ? ['aoto'] : ['aoto', ...NOVICE_VARIANTS];
      entry.pairedVsA[v] = Object.fromEntries(subjects.map((sj) => [sj, { rank: clusterPairedCI(recs.A, recs[v], sj, 'ranks'), score: clusterPairedCI(recs.A, recs[v], sj, 'scores') }]));
    }
    result.cells[key] = entry;
    log(key);
  }
  return result;
}

// 試合記録の CSV（1行＝1試合×1条件）
export function recordsCSV(records) {
  const head = 'cell,variant,index,cluster,seed,startDealer,seat0,seat1,seat2,seat3,rank0,rank1,rank2,rank3,score0,score1,score2,score3,played,endReason,aotoSeat,novice';
  return [head, ...records.map((r) => [r.cell, r.variant, r.index, r.cluster, r.seed, r.startDealer, ...r.seats, ...r.ranks, ...r.scores, r.played, r.endReason, r.aotoSeat, r.novice || ''].join(','))].join('\n') + '\n';
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
    variants: opt('--variants', PLAN_VARIANTS.join(',')).split(','),
    log: (k) => process.stderr.write(`${k} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`),
  });
  result.seconds = (Date.now() - t0) / 1000;
  const outFile = opt('--out', null);
  const csvFile = opt('--csv', null);
  if (csvFile) writeFileSync(csvFile, recordsCSV(result.records));
  const json = JSON.stringify(result, null, 1);
  if (outFile) writeFileSync(outFile, json); else process.stdout.write(json + '\n');
}
