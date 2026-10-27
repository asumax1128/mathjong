// Ver.0.6 初級キャラクター仮AI。実験専用：本番の decide() / app.js からは未接続。
// 判断根拠は Game.viewFor(seat) と pending() と seed付きrng。配牌、山、他家手牌は読まない。
import { beginnerKeepScore, beginnerDiscard } from './ai-levels.js';
import { unseenCounts, viewCounts } from './ai.js';

export const BEGINNER_CHARACTERS = Object.freeze({
  kanata: Object.freeze({ id: 'kanata', name: 'かなた', age: 10, personality: 'speed' }),
  mitsuki: Object.freeze({ id: 'mitsuki', name: 'みつき', age: 8, personality: 'value' }),
  aoto: Object.freeze({ id: 'aoto', name: 'あおと', age: 9, personality: 'closed' }),
});

// 重みつきの同点解消。選ばれた牌種のうち物理牌は手牌の最初の同種を選択。
function rankedDiscard(game, seat, rng, weights, scoreFn) {
  const view = game.viewFor(seat);
  const counts = viewCounts(game.rules, view);
  const types = [...new Set(view.hand.map((h) => h.type))];
  const ranks = types.map((type) => ({
    type,
    score: scoreFn(type, view, counts),
    tie: rng.next(),
  })).sort((a, b) => a.score - b.score || a.tie - b.tie);
  const n = Math.min(weights.length, ranks.length);
  const w = weights.slice(0, n);
  let x = rng.next() * w.reduce((a, b) => a + b, 0);
  let idx = 0;
  while (idx < n - 1 && x >= w[idx]) x -= w[idx++];
  const picked = ranks[idx].type;
  return view.hand.find((h) => h.type === picked).id;
}

// あおとの公開された過去の捨て牌に多いカテゴリを参照する。「真の次牌」は参照不可。
// 同種牌を複数捨てているほど、また近い捨て牌ほどわずかに加点する。
function aotoReadScore(rules, view, waits, aotoSeat, unseen) {
  if (!Number.isInteger(aotoSeat) || aotoSeat === view.seat || aotoSeat < 0 || aotoSeat > 3) return 0;
  const river = view.rivers[aotoSeat].slice(-6);
  if (!river.length) return 0;
  let bonus = 0;
  for (const t of waits) {
    if (unseen[t] <= 0) continue;
    const key = rules.types[t].key;
    const kind = rules.types[t].kind;
    const exact = river.filter((r) => rules.types[r].key === key).length;
    const sameKind = river.filter((r) => rules.types[r].kind === kind).length;
    bonus += Math.min(0.3, 0.12 * exact + 0.03 * sameKind);
  }
  return Math.min(0.5, bonus);
}

// かなた：聴牌を見つけるが上級の危険度や相手の手牌は見ない。
function kanataScore(game, seat, type, view, counts, aotoSeat) {
  const score = beginnerKeepScore(game.rules, counts, type);
  const unseen = unseenCounts(game.rules, view);
  const after = counts.slice();
  after[type]--;
  const waits = game.waitsOf(after, view.melds[seat].map((m) => m.meld))
    .filter((t) => unseen[t] > 0);
  const live = waits.reduce((s, t) => s + unseen[t], 0);
  const readyBonus = live ? 1.3 + Math.min(live, 6) * 0.12 : 0;
  return score - readyBonus - aotoReadScore(game.rules, view, waits, aotoSeat, unseen);
}

// みつき：本来の残したい牌評価を基礎に、sin牌とsinで作れそうな2枚組を強く保持。
function mitsukiScore(rules, type, counts) {
  let keep = beginnerKeepScore(rules, counts, type);
  if (rules.types[type].key === 'f:sin') keep += 3;
  for (const mi of rules.meldsByTile[type]) {
    const m = rules.melds[mi];
    if (m.kind !== 'formula' || m.fn !== 'sin') continue;
    const others = m.tiles.slice();
    const ix = others.indexOf(type);
    others.splice(ix, 1);
    const tmp = counts.slice();
    tmp[type]--;
    let held = 0;
    for (const o of others) if (tmp[o]-- > 0) held++;
    if (held === 2) keep += 2.5;
    else if (held === 1) keep += 0.3;
  }
  return keep;
}

export function decideBeginnerCharacter(game, seat, characterId, rng, { seatIds = [] } = {}) {
  if (!BEGINNER_CHARACTERS[characterId]) throw new Error('unknown beginner character: ' + characterId);
  const pending = game.pending();
  if (!pending || pending.seat !== seat) throw new Error('invalid pending seat');

  if (pending.type === 'turn') {
    if (pending.canTsumo) return { type: 'tsumo' };
    // リーチ中は必ずツモ切り：本番 decide() の不変条件と同一。
    if (game.riichi[seat]) return { type: 'discard', tile: game.viewFor(seat).drawn };
    if (characterId === 'aoto') {
      const view = game.viewFor(seat);
      const tile = rng.next() < 0.40 ? rng.pick(view.hand).id : beginnerDiscard(game.rules, view, rng);
      return { type: 'discard', tile };
    }
    if (characterId === 'mitsuki') {
      return { type: 'discard', tile: rankedDiscard(game, seat, rng, [0.45, 0.35, 0.20],
        (t, view, counts) => mitsukiScore(game.rules, t, counts)) };
    }
    const aotoSeat = seatIds.indexOf('aoto');
    return { type: 'discard', tile: rankedDiscard(game, seat, rng, [0.75, 0.20, 0.05],
      (t, view, counts) => kanataScore(game, seat, t, view, counts, aotoSeat)) };
  }

  if (pending.ron) return { type: 'ron' };
  if (characterId !== 'aoto') return { type: 'pass' };
  if (pending.pon && rng.next() < 0.85) return { type: 'pon' };
  if (pending.chi.length && rng.next() < 0.75) return { type: 'chi', option: rng.int(pending.chi.length) };
  return { type: 'pass' };
}
