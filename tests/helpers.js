import { createRules } from '../src/engine/rules.js';
import { Game } from '../src/engine/game.js';

export const rules = createRules();

// 牌種類 key の短縮表記: 'sin' / '30' / '=1/2'
export function k(s) {
  if (s.startsWith('=')) return `v:${s.slice(1)}`;
  if (/^\d+$/.test(s)) return `a:${s}`;
  return `f:${s}`;
}
export const idx = (s, r = rules) => r.typeByKey.get(k(s)).idx;
export const counts = (list, r = rules) => r.countsOf(list.map((s) => idx(s, r)));
export const meld = (fn, deg, val, r = rules) => r.meldOf(idx(fn, r), idx(String(deg), r), idx(val, r));

// 指定した手牌・ツモ順で山を作る。hands[seat] は8枚（短縮表記）、draws は配牌後に引かれる順。
// 不足分は残りの牌から自動で補充する（filler）。
export function makeGame({ hands, draws = [], dealer = 0, players, r = rules }) {
  const keys = [];
  for (let round = 0; round < 8; round++) {
    for (let j = 0; j < 4; j++) keys.push(k(hands[(dealer + j) % 4][round]));
  }
  for (const d of draws) keys.push(k(d));
  players = players || [0, 1, 2, 3].map((s) => ({ name: `P${s}`, kind: 'ai', personality: 'speed' }));
  return new Game({ rules: r, seed: 1, dealer, players, presetWall: keys });
}

export function findTile(game, seat, s) {
  const t = idx(s, game.rules);
  const id = game.hands[seat].find((x) => game.typeOf(x) === t);
  if (id === undefined) throw new Error(`seat ${seat} has no ${s}`);
  return id;
}

// 当たらない無難な手（互いに面子にならない牌の寄せ集め）
export const junk = ['sin', 'sin', 'sin', '0', '0', '90', '=-√3', '=-√3'];
export const junk2 = ['cos', 'cos', 'cos', '180', '180', '270', '=√3', '=√3'];
export const junk3 = ['tan', 'tan', 'tan', '360', '360', '90', '=-1/√2', '=-1/√2'];
