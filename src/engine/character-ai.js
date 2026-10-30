// 数雀 Ver.0.6：キャラクター固有AI判断。公開情報と合法なpendingのみ利用。
// 配牌や山は操作しない。他家の手牌、未来ツモ、当たり牌の正解は参照しない。
// 係数は暫定。tools/simulate-characters-all.mjsで比較・調整する。
import {
  decide, chooseCall, handValue, viewCounts, unseenCounts, riichiDecision, ankanDecision,
  valueAfterCall, minMissingAfterCall, combosFor, missFactor, aiPoints,
} from './ai.js';
import {
  advHandValue, dangerTable, WIN_COEF, WIN_COEF_V04B, ADVANCED,
} from './ai-levels.js';
import { decideBeginnerCharacter, BEGINNER_PARAMS } from './character-ai-prototype.js';

// キャラクターごとの判断係数（Ver.0.6）。1人ずつ独立して調整できる（tools/sim-v06.mjs --tune で上書きして比較する）。
// どの係数も、公開情報（自分の手牌・全員の河と公開面子・山の残り・親・試合の持ち点）から計算する量にだけ掛かる。
export const CHARACTER_PARAMS = {
  ...BEGINNER_PARAMS,
  // おうすけ：下位（3・4位）でトップとの差が trail 点以上なら焦り、rage 点以上で暴走
  ousuke: { trail: 12, rage: 24, callP: 0.55, callPRage: 0.85, ponChance: 0.85, chiChance: 0.80, sloppyP: 0.30 },
  // なつき：門前中心。鳴きは、鳴いた後の価値が鳴かない場合の callLoosen 倍以上のときだけ
  natsuki: { callLoosen: 2.5 },
  // ゆき：下位（トップとの差 trail 点以上）では役のある鳴きを強める（判断の精度は落とさない）
  yuki: { trail: 12, callLoosen: 0.65 },
  // ふくやま：放銃の重み（defense）が大きい。下位では守りを緩める（終盤はさらに緩める）。
  //   Ver.0.6 最終調整：危険度を Ver.0.6 の当てはめ（通った牌は 0）に、攻めの見込みを和了点の期待値に、最後の局は2位以内なら守り・3位以下なら攻め。
  fukuyama: { style: 'speed', defense: { math1: 1.75, math2: 2.1 }, trailingDefense: 1.15, lateTrailingDefense: 0.8, callLoosen: 1.75,
    danger: 'v06', evPoints: { math1: 3.0, math2: 3.1 }, placement: { lateHands: 1, target: 2, safeMult: 1.6, pushMult: 0.6 } },
  // かおる：上級の標準。アスマが大差の4位のとき、公開情報から見たアスマへの危険を稀に甘く見る。
  //   Ver.0.6 最終調整：和了点の期待値で比べる。鳴きは、鳴いた後の価値が1.5倍以上になるときだけ（門前のリーチを生かす）。
  kaoru: { style: 'value', defense: 1.5, favorP: 0.07, favorDeficit: 20, favorWeight: 0.6, evPoints: { math1: 3.0, math2: 3.1 }, callLoosen: 1.5 },
  // アスマ：得点重視。勝負手（bigHand）では放銃の重みを大きく下げる。
  //   Ver.0.6 最終調整：危険度を Ver.0.6 の当てはめに、攻めの見込みを和了点の期待値に（高い手ほど押す）。
  asuma: { style: 'value', defense: 1.2, bigHandDefense: 0.2, valueExp: 1.3, callLoosen: 1.25, danger: 'v06', evPoints: { math1: 3.0, math2: 3.1 } },
};
const modeValue = (x, mode) => (x !== null && typeof x === 'object' ? (x[mode] ?? x.math2) : x);

export const CHARACTER_ROSTER = Object.freeze({
  beginner: Object.freeze([
    { id: 'kanata', name: 'かなた', age: 10, personality: 'speed', styleLabel: '冷静な観察型' },
    { id: 'mitsuki', name: 'みつき', age: 8, personality: 'value', styleLabel: 'sin好きの役狙い' },
    { id: 'aoto', name: 'あおと', age: 9, personality: 'closed', styleLabel: '自由奔放な鳴き型' },
  ]),
  intermediate: Object.freeze([
    { id: 'ousuke', name: 'おうすけ', age: 17, personality: 'speed', styleLabel: '負けず嫌いの速攻型' },
    { id: 'natsuki', name: 'なつき', age: 20, personality: 'value', styleLabel: '幸運の門前型' },
    { id: 'yuki', name: 'ゆき', age: 18, personality: 'closed', styleLabel: '逆転の切替型' },
  ]),
  advanced: Object.freeze([
    { id: 'fukuyama', name: 'シャカ', age: 28, personality: 'speed', styleLabel: '守備重視の理論派' },
    { id: 'kaoru', name: 'かおる', age: 27, personality: 'value', styleLabel: 'お調子者の実力派' },
    { id: 'asuma', name: 'アスマ', age: 28, personality: 'closed', styleLabel: '高得点の勝負師' },
  ]),
});
const LEVEL_FOR_ID = Object.fromEntries(
  Object.entries(CHARACTER_ROSTER).flatMap(([level, xs]) => xs.map((c) => [c.id, level])),
);
export const rosterForLevel = (level) => CHARACTER_ROSTER[level] || CHARACTER_ROSTER.intermediate;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sigmoid = (x) => 1 / (1 + Math.exp(-clamp(x, -50, 50)));
const rank = (scores, seat) => scores ? 1 + scores.filter((x) => x > scores[seat]).length : 2;
function deficit(scores, seat) {
  return scores ? Math.max(...scores) - scores[seat] : 0;
}
function needRecovery(scores, seat, points = 12) {
  return !!scores && rank(scores, seat) >= 3 && deficit(scores, seat) >= points;
}
function pickByValue(rng, arr, scorer) {
  const items = arr.map((item) => ({ item, score: scorer(item) }));
  const best = Math.max(...items.map((x) => x.score));
  const tol = Math.abs(best) * 1e-9 + 1e-12;
  return rng.pick(items.filter((x) => x.score >= best - tol).map((x) => x.item));
}
function randomDiscard(game, seat, rng) {
  const h = game.viewFor(seat).hand;
  return { type: 'discard', tile: rng.pick(h).id };
}
function legalCall(p, rng, { ponChance = 0.5, chiChance = 0.5 } = {}) {
  if (p.pon && rng.next() < ponChance) return { type: 'pon' };
  if (p.chi.length && rng.next() < chiChance) return { type: 'chi', option: rng.int(p.chi.length) };
  return { type: 'pass' };
}

// 公開牌に基づいた通常の役・和了評価を利用して鳴きを決める。
// 実際の合法選択肢のみ返し、鳴いた後の役が成立し得ない候補を除外する。
function viableCall(game, seat, rng, personality, loosen = 1) {
  const p = game.pending();
  const rules = game.rules, view = game.viewFor(seat);
  const counts = viewCounts(rules, view);
  const exp = view.melds[seat].map((m) => m.meld);
  const unseen = unseenCounts(rules, view);
  const tile = game.typeOf(p.tile);
  unseen[tile]++;
  const before = handValue(rules, counts, exp, unseen, personality);
  const opts = [];
  if (p.pon) opts.push({ action: { type: 'pon' }, meld: p.pon.meld });
  p.chi.forEach((x, i) => opts.push({ action: { type: 'chi', option: i }, meld: x.meld }));
  let max = 0, cand = [];
  for (const x of opts) {
    // 既存AIと同じ「鳴いた後に捨て牌を1枚選ぶ」評価を使う。
    // 役のある完成形が遠すぎるとき、無理に鳴かない。
    const missing = minMissingAfterCall(rules, counts, exp, unseen, tile, x.meld, personality);
    if (missing > 3) continue;
    const val = valueAfterCall(rules, counts, exp, unseen, tile, x.meld, personality);
    if (!(val > 0)) continue;
    if (val < before * loosen) continue;
    if (val > max * (1 + 1e-9)) { max = val; cand = [x.action]; }
    else if (Math.abs(val - max) <= Math.abs(max) * 1e-9) cand.push(x.action);
  }
  return cand.length ? rng.pick(cand) : { type: 'pass' };
}

// 自分の手の和了点の見込み（上級の任意の係数 evPoints）：届く見込みのある完成形の点数を、足りない牌の数と残り枚数で重み付けして平均する。
// 材料は自分の手牌・公開面子・見えていない牌の枚数（公開情報）だけ。門前ならリーチの加点を見込む。
const ptsCache = new WeakMap();
function comboPoints(rules, exposed) {
  let c = ptsCache.get(rules); if (!c) ptsCache.set(rules, (c = new Map()));
  const key = exposed.slice().sort((a, b) => a - b).join(',');
  let pts = c.get(key);
  if (pts) return pts;
  const closed = exposed.length === 0;
  const needYaku = !closed && rules.config.rules.calledHandNeedsYaku;
  const combos = combosFor(rules, 3 - exposed.length);
  pts = new Float64Array(combos.n);
  for (let i = 0; i < combos.n; i++) {
    const ev = rules.evaluateMelds([...exposed, ...combos.melds[i]], closed);
    pts[i] = needYaku && !ev.hasYaku ? 0 : aiPoints(rules, ev);
  }
  c.set(key, pts);
  return pts;
}
export function expectedPoints(rules, counts, exposed, unseen) {
  const combos = combosFor(rules, 3 - exposed.length);
  const pts = comboPoints(rules, exposed);
  const s = ADVANCED.softness;
  const f1 = unseen.map((u) => (u > 0 ? ADVANCED.missDecay * (u / (u + s)) : 0));
  const { reqT, reqN, reqStart, n } = combos;
  let sw = 0, sp = 0;
  for (let i = 0; i < n; i++) {
    if (pts[i] === 0) continue;
    let w = 1;
    for (let j = reqStart[i], e = reqStart[i + 1]; j < e; j++) {
      const t = reqT[j];
      const miss = reqN[j] - counts[t];
      if (miss <= 0) continue;
      if (unseen[t] < miss) { w = 0; break; }
      w *= missFactor(f1[t], miss);
    }
    sw += w; sp += w * pts[i];
  }
  const bonus = exposed.length === 0 && rules.config.rules.riichi ? (rules.config.rules.riichiBonus ?? 1) : 0;
  return sw > 0 ? sp / sw + bonus : 0;
}

// 席 o が「宣言できるロン・ツモを必ず宣言する」と保証されているか。保証されるのは AI の席（kind: 'ai'）だけ
// （9人のキャラ AI と Ver.0.5-E の AI はロン・ツモを見逃さない。tests/character-ai-v06.test.js で確認）。
// 人間はロン・ツモを見送れる（フリテンの規則はない）ので、見送った牌が後で当たりになりうる。種類が不明な席も保証しない。
// 席が人間か AI かは画面に出ている公開情報（他家の手牌・山・待ちは使わない）。
export function ronGuaranteed(game, o) {
  return game.players?.[o]?.kind === 'ai';
}

// 通った牌（上級の任意の係数 passedSafe と危険度 v06 で使う）：公開された打牌の順序（ゲームの記録）から、他家 o が今の手で
// ロンしなかった牌の種類を集める。
// ・o がリーチしている：リーチ後は手が変わらないので、リーチ後に誰かが捨てた牌（o 自身のツモ切りを含む）はすべて o の当たりではない。
// ・o がリーチしていない：o の最後の打牌の後に他家が捨てた牌は、o の今の手では当たりではない。
// 宣言できるロン・ツモは見逃さない、という前提の推定なので、その前提が保証された席（ronGuaranteed＝AI の席）だけを対象にする。
// 人間の席は常に空（見送りから安全を断定しない）。他家の手牌や山は見ない。
export function passedTiles(game, seat) {
  const ev = game.events;
  const out = [new Set(), new Set(), new Set(), new Set()];
  for (let o = 0; o < 4; o++) {
    if (o === seat || !ronGuaranteed(game, o)) continue;
    let from = -1;
    let riichi = false;
    for (let i = ev.length - 1; i >= 0; i--) {
      const e = ev[i];
      if (e.type === 'riichi' && e.seat === o) { from = i; riichi = true; break; }
    }
    if (!riichi) {
      for (let i = ev.length - 1; i >= 0; i--) {
        const e = ev[i];
        if (e.seat === o && (e.type === 'discard' || e.type === 'chi' || e.type === 'pon')) { from = i; break; }
      }
    }
    if (from < 0) continue;
    for (let i = from + 1; i < ev.length; i++) {
      const e = ev[i];
      if (e.type === 'discard' && (riichi || e.seat !== o)) out[o].add(game.typeOf(e.tile));
    }
  }
  return out;
}

// ---- Ver.0.6 の危険度（上級の任意の係数 danger: 'v06'）----
// 他家 o が牌 t でロンできる確率を、公開情報だけからロジスティック回帰で見積もる（tools/calibrate-v06.mjs で当てはめ）。
// 特徴量：[定数, log(w+0.001), 巡目, 鳴き1回, 鳴き2回, o が t を捨てている, min(巡目,12)^2/10, w>0, リーチ,
//          log(w2+0.001), w2>0, リーチ後の o の打牌数]
//   w ：t で完成する面子（鳴いた o は役の付く面子だけ）について、残りの牌を o が持っている見込みの和（従来と同じ）
//   w2：w のうち、o が残りの牌（相方）を自分で捨てていない面子だけの和（相方を捨てた面子では待ちにくい）
// 「通った牌」（passedTiles、AI の席だけ）は確率 0。人間の席は通過の履歴に関係なく回帰式の確率。係数がないモードは従来の dangerTable を使う。
// 当てはめ：tools/calibrate-v06.mjs（数学Ⅰ 160試合 seed 50001・338,161件、数学Ⅱ 80試合 seed 50002・200,209件。AUC 0.933／0.933）。
// 「通った牌」は数学Ⅰ 21,701件・数学Ⅱ 12,935件でロン 0件（確率 0 の扱いを確認）。
export const DANGER_COEF_V06 = {
  math1: [-9.191, 0.81, 0.072, 4.075, 6.601, -2.07, -0.008, 2.051, 4.664, -0.053, 0.008, 0.049],
  math2: [-10.044, 0.49, 0.12, 3.825, 6.104, -1.526, -0.021, 2.823, 4.535, 0.111, -0.151, 0.055],
};
const finalCacheV06 = new WeakMap();
function finalMelds(rules, ex) {
  if (!ex.length || !rules.config.rules.calledHandNeedsYaku) return null;
  let c = finalCacheV06.get(rules); if (!c) finalCacheV06.set(rules, (c = new Map()));
  const key = ex.slice().sort((a, b) => a - b).join(',');
  let set = c.get(key);
  if (set) return set;
  set = new Set();
  const M = rules.melds.length;
  for (let m = 0; m < M; m++) {
    if (ex.length >= 2) { if (rules.evaluateMelds([...ex, m], false).hasYaku) set.add(m); } else for (let x = 0; x < M; x++) if (rules.evaluateMelds([...ex, m, x], false).hasYaku) { set.add(m); break; }
  }
  c.set(key, set);
  return set;
}
// リーチ後に o が捨てた枚数（公開された打牌の順序から）
export function riichiDiscardCounts(game) {
  const out = [0, 0, 0, 0];
  const on = [false, false, false, false];
  for (const e of game.events) {
    if (e.type === 'riichi') on[e.seat] = true;
    else if (e.type === 'discard' && on[e.seat]) out[e.seat]++;
  }
  return out;
}
export function dangerFeaturesV06(rules, view, unseen, o, rdc = null) {
  const T = unseen.length;
  const U = unseen.reduce((a, b) => a + Math.max(0, b), 0) || 1;
  const hs = view.handCounts[o];
  const ex = view.melds[o].map((m) => m.meld);
  const valid = finalMelds(rules, ex);
  const turns = view.rivers[o].length + view.melds[o].length;
  const river = new Set(view.rivers[o]);
  const riichi = view.riichi && view.riichi[o] ? 1 : 0;
  const out = [];
  for (let t = 0; t < T; t++) {
    let w = 0, w2 = 0;
    for (const mi of rules.meldsByTile[t]) {
      if (valid && !valid.has(mi)) continue;
      const need = new Map();
      let skipped = false;
      for (const x of rules.melds[mi].tiles) {
        if (x === t && !skipped) { skipped = true; continue; }
        need.set(x, (need.get(x) || 0) + 1);
      }
      let q = 1;
      let partnerOut = false;
      for (const [x, n] of need) {
        if (river.has(x)) partnerOut = true;
        for (let j = 0; j < n; j++) q *= (Math.max(0, unseen[x] - j) * hs) / U / (j + 1);
      }
      w += q;
      if (!partnerOut) w2 += q;
    }
    out.push([1, Math.log(w + 1e-3), turns, ex.length === 1 ? 1 : 0, ex.length >= 2 ? 1 : 0, river.has(t) ? 1 : 0, Math.min(turns, 12) ** 2 / 10, w > 0 ? 1 : 0, riichi,
      Math.log(w2 + 1e-3), w2 > 0 ? 1 : 0, riichi && rdc ? Math.max(0, rdc[o] - 1) : 0]);
  }
  return out;
}
export function dangerTableV06(game, rules, view, unseen, seat) {
  const coef = DANGER_COEF_V06[rules.config.mode];
  if (!coef || !rules.config.rules.riichi) return null;
  const passed = passedTiles(game, seat);
  const rdc = riichiDiscardCounts(game);
  const out = [];
  for (let o = 0; o < 4; o++) {
    const P = new Float64Array(unseen.length);
    out.push(P);
    if (o === seat) continue;
    const feats = dangerFeaturesV06(rules, view, unseen, o, rdc);
    for (let t = 0; t < unseen.length; t++) {
      if (passed[o].has(t)) continue;
      let z = 0;
      for (let j = 0; j < coef.length; j++) z += coef[j] * feats[t][j];
      P[t] = sigmoid(z);
    }
  }
  return out;
}

// 順位判断（上級の任意の係数 placement）：終盤（最後の lateHands 局）に、目標の順位（target 位以内）にいれば守りを強め
// （safeMult 倍）、届いていなければ守りを緩める（pushMult 倍）。持ち点と局数は画面に出ている公開情報。
function placementFactor(P, info, seat) {
  const pl = P.placement;
  if (!pl || !info || !info.scores) return 1;
  if (info.hand < info.length - (pl.lateHands ?? 1)) return 1;
  return rank(info.scores, seat) <= (pl.target ?? 1) ? pl.safeMult ?? 1 : pl.pushMult ?? 1;
}

// リーチの方針（上級の任意の係数）：riichiMinLive＝待ちの残り（自分から見えていない枚数）がこれ以上のときだけリーチ。
// damaWhenSafe＝終盤に目標の順位にいるときはリーチしない（ツモ切りに縛られず、守りに回れるようにする）。
function advancedRiichi(game, seat, tile, P, info) {
  if (P.noRiichi) return false;
  if (!riichiDecision(game, seat, tile, 'advanced')) return false;
  if (P.riichiMinLive) {
    const view = game.viewFor(seat);
    const counts = viewCounts(game.rules, view);
    counts[game.typeOf(tile)]--;
    const unseen = unseenCounts(game.rules, view);
    const live = game.waitsOf(counts).reduce((n, t) => n + Math.max(0, unseen[t]), 0);
    if (live < P.riichiMinLive) return false;
  }
  if (P.damaWhenSafe && placementFactor({ placement: { ...P.placement, safeMult: 0, pushMult: 1 } }, info, seat) === 0) return false;
  return true;
}

// 上級：既存のadvHandValue・公開放銃確率を流用。キャラごとの防御率と
// 役重みを変える。比較は現在の合法手牌種類間だけで行う。
export function characterAdvancedDiscard(game, seat, characterId, rng, info, seatIds) {
  const rules = game.rules, view = game.viewFor(seat);
  const counts = viewCounts(rules, view), unseen = unseenCounts(rules, view);
  const exposed = view.melds[seat].map((m) => m.meld);
  const types = [...new Set(view.hand.map((h) => h.type))];
  const P = CHARACTER_PARAMS[characterId];
  const style = P.style;
  // 足りない牌1枚ごとの減衰（任意の係数 missDecay。既定は上級の共通値）
  const savedDecay = ADVANCED.missDecay;
  if (P.missDecay != null) ADVANCED.missDecay = P.missDecay;
  try {
  const vals = types.map((t) => {
    counts[t]--;
    const v = advHandValue(rules, counts, exposed, unseen, style, view.wallCount);
    counts[t]++;
    return v;
  });
  const best = Math.max(...vals);
  const pTable = (P.danger === 'v06' && dangerTableV06(game, rules, view, unseen, seat)) || dangerTable(rules, view, unseen);
  if (P.passedSafe) {
    const passed = passedTiles(game, seat);
    for (let o = 0; o < 4; o++) for (const t of passed[o]) pTable[o][t] = 0;
  }
  const bestIndex = vals.indexOf(best);
  counts[types[bestIndex]]--;
  const base = handValue(rules, counts, exposed, unseen, 'speed');
  counts[types[bestIndex]]++;
  const wc = (rules.config.rules.riichi ? WIN_COEF : WIN_COEF_V04B)[rules.config.mode] ||
    (rules.config.rules.riichi ? WIN_COEF : WIN_COEF_V04B).math2;
  const pWin = sigmoid(wc[0] + wc[1] * Math.log(base + 1e-9) + wc[2] * view.wallCount + wc[3] * exposed.length);
  const scores = info?.scores || null;
  let defense = modeValue(P.defense, rules.config.mode);
  if (characterId === 'fukuyama') {
    if (scores && rank(scores, seat) >= 3) defense = info.hand >= info.length - 2 ? P.lateTrailingDefense : P.trailingDefense;
  }
  if (characterId === 'asuma') {
    // 勝負手：既定は「和了の見込みがある」こと。bigHandRatio を指定すると、役重視の手の価値が速攻の手の価値の何倍か
    // （＝高い役の完成形の比重）で判定する。どちらも自分の手牌と公開情報だけから計算する。
    let big = best > 0;
    if (big && P.bigHandRatio != null) {
      counts[types[bestIndex]]--;
      const vSpeed = advHandValue(rules, counts, exposed, unseen, 'speed', view.wallCount);
      counts[types[bestIndex]]++;
      big = vSpeed > 0 && best / vSpeed >= P.bigHandRatio;
    }
    defense = big ? P.bigHandDefense : P.defense;
  }
  defense *= placementFactor(P, info, seat);
  const aSeat = seatIds.indexOf('asuma');
  const favorAsuma = characterId === 'kaoru' && aSeat >= 0 && aSeat !== seat &&
    scores && rank(scores, aSeat) === 4 && Math.max(...scores) - scores[aSeat] >= P.favorDeficit &&
    rng.next() < P.favorP;
  let gain = view.dealer === seat ? 6 : 4;
  let oppPts = 1;
  if (P.evPoints) {
    // 期待値を点で比べる：攻めは自分の手の和了点の見込み、守りは他家の平均的な和了点（係数）
    counts[types[bestIndex]]--;
    gain *= expectedPoints(rules, counts, exposed, unseen);
    counts[types[bestIndex]]++;
    oppPts = modeValue(P.evPoints, rules.config.mode);
  }
  const scoresByType = types.map((t, i) => {
    const risk = oppPts * pTable.reduce((s, p, other) =>
      other === seat ? s : s + p[t] * (other === view.dealer ? 6 : 4), 0);
    const ratio = best > 0 ? clamp(vals[i] / best, 0, 1) : 0;
    let utility = pWin * gain * Math.pow(ratio, P.valueExp ?? 1) - defense * risk;
    // 聴牌を取る打牌への加点（任意の係数 tenpaiBonus）：捨てた後の手が、自分から見えていない待ちの牌のある聴牌なら加点する。
    // 門前の聴牌はリーチ（＋1点）につながる。材料は自分の手牌と見えている牌の枚数だけ。
    if (P.tenpaiBonus) {
      counts[t]--;
      const live = game.waitsOf(counts, exposed).reduce((n, w) => n + Math.max(0, unseen[w]), 0);
      counts[t]++;
      if (live > 0) utility += P.tenpaiBonus * (exposed.length ? P.tenpaiCalledScale ?? 1 : 1) * Math.min(1, live / (P.tenpaiLiveFull ?? 1));
    }
    // かおる：公開情報から推定した先輩の危険牌を、ごく稀に甘く評価する。
    // 正解の当たり牌は閲覧しない。あくまで不利な癖であり順位の上昇保証なし。
    if (favorAsuma && pTable[aSeat]) utility += P.favorWeight * pTable[aSeat][t];
    return utility;
  });
  const chosen = pickByValue(rng, types.map((type, i) => ({ type, score: scoresByType[i] })), (x) => x.score);
  return view.hand.find((h) => h.type === chosen.type).id;
  } finally { ADVANCED.missDecay = savedDecay; }
}

export function decideCharacter(game, seat, id, rng, info = null, seatIds = []) {
  const level = LEVEL_FOR_ID[id];
  if (!level) throw new Error('unknown character: ' + id);
  const p = game.pending();
  if (!p || p.seat !== seat) throw new Error('invalid character pending');
  // 新ルールの暗カン：全員共通の基準戦略（乱数を使わない。旧ルールでは選択肢がなく常に null）。個性の係数は変更しない
  const kan = ankanDecision(game, seat);
  if (kan) return kan;
  const scores = info?.scores || null;
  if (level === 'beginner') {
    const result = decideBeginnerCharacter(game, seat, id, rng, { seatIds });
    if (result.type === 'discard' && riichiDecision(game, seat, result.tile, 'beginner')) {
      return { ...result, riichi: true };
    }
    return result;
  }
  if (p.type === 'turn' && p.canTsumo) return { type: 'tsumo' };
  if (p.type === 'claim' && p.ron) return { type: 'ron' };
  if (game.riichi[seat]) return decide(game, seat, 'speed', rng, level, info);

  if (level === 'intermediate') {
    if (id === 'ousuke') {
      const P = CHARACTER_PARAMS.ousuke;
      const d = deficit(scores, seat);
      if (p.type === 'claim' && needRecovery(scores, seat, P.trail) && rng.next() < (d >= P.rage ? P.callPRage : P.callP)) {
        const a = legalCall(p, rng, { ponChance: P.ponChance, chiChance: P.chiChance });
        if (a.type !== 'pass') return a;
      }
      if (p.type === 'turn' && needRecovery(scores, seat, P.rage) && rng.next() < P.sloppyP) {
        const a = randomDiscard(game, seat, rng);
        return riichiDecision(game, seat, a.tile, 'intermediate') ? { ...a, riichi: true } : a;
      }
      return decide(game, seat, 'speed', rng, 'intermediate', info);
    }
    if (id === 'natsuki') {
      if (p.type === 'claim') return viableCall(game, seat, rng, 'value', CHARACTER_PARAMS.natsuki.callLoosen);
      return decide(game, seat, 'value', rng, 'intermediate', info);
    }
    // ゆき：上位の安全な門前、下位の積極的な役つき鳴き。
    const Y = CHARACTER_PARAMS.yuki;
    if (p.type === 'claim') {
      if (needRecovery(scores, seat, Y.trail)) return viableCall(game, seat, rng, 'speed', Y.callLoosen);
      return { type: 'pass' };
    }
    if (p.type === 'turn' && needRecovery(scores, seat, Y.trail)) return decide(game, seat, 'speed', rng, 'intermediate', info);
    return decide(game, seat, 'closed', rng, 'intermediate', info);
  }

  // 上級（合法なツモ・ロンは上の分岐で常に取る）
  if (p.type === 'turn') {
    const tile = characterAdvancedDiscard(game, seat, id, rng, info, seatIds);
    return advancedRiichi(game, seat, tile, CHARACTER_PARAMS[id], info)
      ? { type: 'discard', tile, riichi: true }
      : { type: 'discard', tile };
  }
  if (id === 'fukuyama') return viableCall(game, seat, rng, 'speed', CHARACTER_PARAMS.fukuyama.callLoosen);
  if (id === 'kaoru') {
    if (CHARACTER_PARAMS.kaoru.callLoosen != null) return viableCall(game, seat, rng, 'value', CHARACTER_PARAMS.kaoru.callLoosen);
    return chooseCall(game.rules, game.viewFor(seat), game.typeOf(p.tile), p.chi, p.pon || null, 'value') || { type: 'pass' };
  }
  return viableCall(game, seat, rng, 'value', CHARACTER_PARAMS.asuma.callLoosen);
}
