// 数雀 Ver.0.6：キャラクター固有AI判断。公開情報と合法なpendingのみ利用。
// 配牌や山は操作しない。他家の手牌、未来ツモ、当たり牌の正解は参照しない。
// 係数は暫定。tools/simulate-characters-all.mjsで比較・調整する。
import {
  decide, chooseCall, handValue, viewCounts, unseenCounts, riichiDecision,
} from './ai.js';
import {
  advHandValue, dangerTable, WIN_COEF, WIN_COEF_V04B,
} from './ai-levels.js';
import { decideBeginnerCharacter } from './character-ai-prototype.js';

export const CHARACTER_ROSTER = Object.freeze({
  beginner: Object.freeze([
    { id: 'kanata', name: 'かなた', age: 10, personality: 'speed' },
    { id: 'mitsuki', name: 'みつき', age: 8, personality: 'value' },
    { id: 'aoto', name: 'あおと', age: 9, personality: 'closed' },
  ]),
  intermediate: Object.freeze([
    { id: 'ousuke', name: 'おうすけ', age: 17, personality: 'speed' },
    { id: 'natsuki', name: 'なつき', age: 20, personality: 'value' },
    { id: 'yuki', name: 'ゆき', age: 18, personality: 'closed' },
  ]),
  advanced: Object.freeze([
    { id: 'fukuyama', name: 'ふくやま', age: 28, personality: 'speed' },
    { id: 'kaoru', name: 'かおる', age: 27, personality: 'value' },
    { id: 'asuma', name: 'アスマ', age: 28, personality: 'closed' },
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
    // 対応する面子を公開すると役が作れないなら値0。valueAfterCallは既存ロジックと同じ。
    const remaining = counts.slice();
    const used = rules.melds[x.meld].tiles.slice();
    const ix = used.indexOf(tile);
    if (ix < 0) continue;
    used.splice(ix, 1);
    let legal = true;
    for (const t of used) if (--remaining[t] < 0) legal = false;
    if (!legal) continue;
    const exposed = [...exp, x.meld];
    const free = unseen.slice();
    free[tile]--;
    // 一巡後までの候補。役なしの鳴き手が続かないよう、少なくとも一つの有効完成形を要求。
    const val = handValue(rules, remaining, exposed, free, personality);
    if (!(val > 0)) continue;
    if (val < before * loosen) continue;
    if (val > max * (1 + 1e-9)) { max = val; cand = [x.action]; }
    else if (Math.abs(val - max) <= Math.abs(max) * 1e-9) cand.push(x.action);
  }
  return cand.length ? rng.pick(cand) : { type: 'pass' };
}

// 上級：既存のadvHandValue・公開放銃確率を流用。キャラごとの防御率と
// 役重みを変える。比較は現在の合法手牌種類間だけで行う。
export function characterAdvancedDiscard(game, seat, characterId, rng, info, seatIds) {
  const rules = game.rules, view = game.viewFor(seat);
  const counts = viewCounts(rules, view), unseen = unseenCounts(rules, view);
  const exposed = view.melds[seat].map((m) => m.meld);
  const types = [...new Set(view.hand.map((h) => h.type))];
  const style = characterId === 'asuma' ? 'value' : characterId === 'kaoru' ? 'value' : 'speed';
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
  let defense = 1.5;
  if (characterId === 'fukuyama') {
    defense = 2.4;
    if (scores && rank(scores, seat) >= 3 && info.hand >= info.length - 2) defense = 1.3;
  }
  if (characterId === 'asuma') {
    defense = best > 0 ? 0.2 : 1.2;
  }
  const aSeat = seatIds.indexOf('asuma');
  const favorAsuma = characterId === 'kaoru' && aSeat >= 0 && aSeat !== seat &&
    scores && rank(scores, aSeat) === 4 && Math.max(...scores) - scores[aSeat] >= 20 &&
    rng.next() < 0.07;
  const gain = view.dealer === seat ? 6 : 4;
  const scoresByType = types.map((t, i) => {
    const risk = pTable.reduce((s, p, other) =>
      other === seat ? s : s + p[t] * (other === view.dealer ? 6 : 4), 0);
    const ratio = best > 0 ? clamp(vals[i] / best, 0, 1) : 0;
    let utility = pWin * gain * Math.pow(ratio, characterId === 'asuma' ? 1.3 : 1) - defense * risk;
    // かおる：公開情報から推定した先輩の危険牌を、ごく稀に甘く評価する。
    // 正解の当たり牌は閲覧しない。あくまで不利な癖であり順位の上昇保証なし。
    if (favorAsuma && pTable[aSeat]) utility += 0.6 * pTable[aSeat][t];
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
      const d = deficit(scores, seat);
      if (p.type === 'claim' && needRecovery(scores, seat) && rng.next() < (d >= 24 ? 0.85 : 0.55)) {
        const a = legalCall(p, rng, { ponChance: 0.85, chiChance: 0.80 });
        if (a.type !== 'pass') return a;
      }
      if (p.type === 'turn' && needRecovery(scores, seat, 24) && rng.next() < 0.30) {
        const a = randomDiscard(game, seat, rng);
        return riichiDecision(game, seat, a.tile, 'intermediate') ? { ...a, riichi: true } : a;
      }
      return decide(game, seat, 'speed', rng, 'intermediate', info);
    }
    if (id === 'natsuki') {
      if (p.type === 'claim') return viableCall(game, seat, rng, 'value', 2.5);
      return decide(game, seat, 'value', rng, 'intermediate', info);
    }
    // ゆき：上位の安全な門前、下位の積極的な役つき鳴き。
    if (p.type === 'claim') {
      if (needRecovery(scores, seat)) return viableCall(game, seat, rng, 'speed', 0.65);
      return { type: 'pass' };
    }
    if (p.type === 'turn' && needRecovery(scores, seat)) return decide(game, seat, 'speed', rng, 'intermediate', info);
    return decide(game, seat, 'closed', rng, 'intermediate', info);
  }

  // 上級（合法なツモ・ロンは上の分岐で常に取る）
  if (p.type === 'turn') {
    const tile = characterAdvancedDiscard(game, seat, id, rng, info, seatIds);
    return riichiDecision(game, seat, tile, 'advanced')
      ? { type: 'discard', tile, riichi: true }
      : { type: 'discard', tile };
  }
  if (id === 'fukuyama') return viableCall(game, seat, rng, 'speed', 1.75);
  if (id === 'kaoru') return chooseCall(game.rules, game.viewFor(seat),
    game.typeOf(p.tile), p.chi, p.pon || null, 'value') || { type: 'pass' };
  return viableCall(game, seat, rng, 'value', 1.25);
}
