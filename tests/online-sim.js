// オンライン対戦の試験用の共通部品（偽の時計・方針つきの自動プレイヤー・ローカルの逐次の参照実装）。
import { Game } from '../src/engine/game.js';
import { applyAction } from '../src/engine/ai.js';
import { decideCharacter } from '../src/engine/characters.js';
import { createRng } from '../src/engine/rng.js';

export function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  const timers = [];
  let seq = 0;
  return {
    now: () => now,
    setTimeout(f, ms) { const id = ++seq; timers.push({ id, at: now + ms, f }); return id; },
    clearTimeout(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    pendingCount: () => timers.length,
    // 最も早い時刻の予定を1つ実行する
    fireNext() {
      if (!timers.length) return false;
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = timers.shift();
      now = Math.max(now, t.at);
      t.f();
      return true;
    },
    advance(ms) { now += ms; },
  };
}

// 宣言の方針：好みの順（例 ['pon','ron','chi','pass']）で、選べる最初のもの。チーは option 0
export function prefChoice(pref, o) {
  for (const k of pref) {
    if (k === 'ron' && o.ron) return { type: 'ron' };
    if (k === 'pon' && o.pon) return { type: 'pon' };
    if (k === 'chi' && o.chi && o.chi.length) return { type: 'chi', option: 0 };
    if (k === 'pass') return { type: 'pass' };
  }
  return { type: 'pass' };
}
export const PREFS = [
  ['ron', 'pon', 'chi', 'pass'],
  ['pon', 'ron', 'chi', 'pass'],
  ['chi', 'pon', 'ron', 'pass'],
  ['pon', 'chi', 'ron', 'pass'],
  ['ron', 'chi', 'pon', 'pass'],
  ['pon', 'pass', 'ron', 'chi'],
];
export const prefsFor = (seedBase) => [0, 1, 2, 3].map((s) => PREFS[(seedBase + s * 7) % PREFS.length]);
const AI_IDS = ['aoto', 'yujin', 'natsuki', 'ousuke'];

// 手番の判断：AI（中級相当）の打牌。リーチ・暗カン・ツモもその判断どおり。席ごとの乱数で決定論的
export function turnDecider(seed) {
  const rngs = [0, 1, 2, 3].map((s) => createRng((seed ^ (0x9e37 * (s + 1))) >>> 0));
  return (g, seat) => decideCharacter(g, seat, AI_IDS[seat], rngs[seat], null, AI_IDS);
}

// ローカルの逐次の参照実装：エンジンの pending() を1席ずつ回し、その時点の選択肢で方針を当てる
export function runLocalRound({ rules, seed, dealer, prefs }) {
  const g = new Game({ rules, seed, dealer, players: [0, 1, 2, 3].map(() => ({ kind: 'human' })), round: 1, ruleset: 2 });
  const turn = turnDecider(seed);
  for (let i = 0; i < 2000; i++) {
    const p = g.pending();
    if (!p) break;
    const a = p.type === 'turn' ? turn(g, p.seat) : prefChoice(prefs[p.seat], p);
    applyAction(g, p.seat, a);
  }
  return g;
}
