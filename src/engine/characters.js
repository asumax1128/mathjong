// 12人の窓口。新3人の年齢・表示難易度はUI設定であり、AI係数やRNGには影響させない。
import { CHARACTER_ROSTER as ORIGINAL_ROSTER, rosterForLevel, decideCharacter as originalDecision } from './character-ai.js';
import { TRIO_PARAMS, publicGame, decideTrioCharacter } from './character-ai-trio.js';

export { rosterForLevel }; // ?ai= の既定3人は従来のまま（4人へ増やさない）
export const TRIO_ROSTER = Object.freeze([
  Object.freeze({ id: 'yujin', name: 'ゆうじん', age: 26, level: 'beginner', personality: 'closed', styleLabel: '鳴かずに刻子を育てる' }),
  Object.freeze({ id: 'tara', name: 'たら', age: 25, level: 'intermediate', personality: 'speed', styleLabel: '待ちを育てる保留型' }),
  Object.freeze({ id: 'nocchi', name: 'のっち', age: 28, level: 'advanced', personality: 'speed', styleLabel: '公開行動への適応型' }),
]);
export const CHARACTER_ROSTER = Object.freeze({ ...ORIGINAL_ROSTER, additional: TRIO_ROSTER });
const views = new WeakMap();
export function decideCharacter(game, seat, id, rng, info = null, seatIds = []) {
  if (!Object.hasOwn(TRIO_PARAMS, id)) return originalDecision(game, seat, id, rng, info, seatIds);
  let own = views.get(game);
  if (!own) views.set(game, (own = []));
  if (!own[seat]) own[seat] = publicGame(game, seat);
  return decideTrioCharacter(own[seat], seat, id, rng, info);
}

export const newPublicHistory = () => Array.from({ length: 4 }, () => ({ rounds: 0, calls: 0, earlyRiichi: 0 }));
// 完了局の公開イベントだけを記録。各席の6巡ではなく、全体通しの6ツモ番以内。
// 純粋関数。試合開始で初期化、1局の精算ガード内で1回だけ呼ぶ。
export function recordPublicRound(history, events, riichi) {
  return history.map((h, seat) => ({
    rounds: h.rounds + 1,
    calls: h.calls + events.filter(e => e.seat === seat && (e.type === 'chi' || e.type === 'pon')).length,
    earlyRiichi: h.earlyRiichi + events.filter(e => e.seat === seat && e.type === 'riichi' && riichi[seat]?.turn <= 6).length,
  }));
}
