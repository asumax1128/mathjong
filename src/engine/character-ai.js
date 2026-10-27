// 数雀 Ver.0.6：キャラクター固有AI判断。公開情報と合法なpendingのみ利用。
// 配牌や山は操作しない。他家の手牌、未来ツモ、当たり牌の正解は参照しない。
// 係数は暫定。tools/simulate-characters-all.mjsで比較・調整する。
import {
  decide, chooseCall, handValue, viewCounts, unseenCounts, riichiDecision,
  valueAfterCall, minMissingAfterCall,
} from './ai.js';
import {
  advHandValue, dangerTable, WIN_COEF, WIN_COEF_V04B,
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
  // ふくやま：放銃の重み（defense）が大きい。下位では守りを緩める（終盤はさらに緩める）
  fukuyama: { style: 'speed', defense: { math1: 1.75, math2: 2.1 }, trailingDefense: 1.15, lateTrailingDefense: 0.8, callLoosen: 1.75 },
  // かおる：上級の標準。アスマが大差の4位のとき、公開情報から見たアスマへの危険を稀に甘く見る
  kaoru: { style: 'value', defense: 1.5, favorP: 0.07, favorDeficit: 20, favorWeight: 0.6 },
  // アスマ：得点重視。勝負手（bigHand）では放銃の重みを大きく下げる
  asuma: { style: 'value', defense: 1.2, bigHandDefense: 0.2, valueExp: 1.3, callLoosen: 1.25 },
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
    { id: 'fukuyama', name: 'ふくやま', age: 28, personality: 'speed', styleLabel: '守備重視の理論派' },
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
  const vals = types.map((t) => {
    counts[t]--;
    const v = advHandValue(rules, counts, exposed, unseen, style, view.wallCount);
    counts[t]++;
    return v;
  });
  const best = Math.max(...vals);
  const pTable = dangerTable(rules, view, unseen);
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
  const gain = view.dealer === seat ? 6 : 4;
  const scoresByType = types.map((t, i) => {
    const risk = pTable.reduce((s, p, other) =>
      other === seat ? s : s + p[t] * (other === view.dealer ? 6 : 4), 0);
    const ratio = best > 0 ? clamp(vals[i] / best, 0, 1) : 0;
    let utility = pWin * gain * Math.pow(ratio, P.valueExp ?? 1) - defense * risk;
    // かおる：公開情報から推定した先輩の危険牌を、ごく稀に甘く評価する。
    // 正解の当たり牌は閲覧しない。あくまで不利な癖であり順位の上昇保証なし。
    if (favorAsuma && pTable[aSeat]) utility += P.favorWeight * pTable[aSeat][t];
    return utility;
  });
  const chosen = pickByValue(rng, types.map((type, i) => ({ type, score: scoresByType[i] })), (x) => x.score);
  return view.hand.find((h) => h.type === chosen.type).id;
}

export function decideCharacter(game, seat, id, rng, info = null, seatIds = []) {
  const level = LEVEL_FOR_ID[id];
  if (!level) throw new Error('unknown character: ' + id);
  const p = game.pending();
  if (!p || p.seat !== seat) throw new Error('invalid character pending');
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
