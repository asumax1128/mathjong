// 追加3人の採用済みAI。docs/38・39の初期版を移植。既存9人の係数には触れない。
import { decide, chooseCall, handValue, viewCounts, unseenCounts, riichiDecision } from './ai.js';
import { advHandValue, dangerTable, WIN_COEF } from './ai-levels.js';
import { dangerTableV06 } from './character-ai.js';

export const TRIO_PARAMS = Object.freeze({
  yujin: Object.freeze({ tripletWeight: 4, formulaWeight: 0.25 }),
  tara: Object.freeze({ minLive: 6, maxDelay: 2, minWall: 24 }),
  nocchi: Object.freeze({ defense: 1.5, ownBase: 2.5, opponentBase: 3 }),
});
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const pickBest = (xs, score, rng) => {
  const values = xs.map(score), best = Math.max(...values);
  return rng.pick(xs.filter((_, i) => values[i] >= best - 1e-10));
};

// 新AIに生のGameを渡さない。公開記録と自分の情報だけ。別席のview/宣言候補取得も拒否。
export function publicGame(game, seat) {
  const own = (s) => { if (s !== seat) throw new Error('other private seat requested'); };
  const methods = {
    pending: () => { const p = game.pending(); if (p) own(p.seat); return p; },
    viewFor: (s) => { own(s); return game.viewFor(s); },
    riichiOptions: (s) => { own(s); return game.riichiOptions(s); },
    typeOf: (id) => game.typeOf(id), waitsOf: (...a) => game.waitsOf(...a), countsOf: (...a) => game.countsOf(...a),
  };
  const getters = {
    rules: () => game.rules, riichi: () => game.riichi.map(x => x && { ...x }),
    riichiEnabled: () => game.riichiEnabled,
    drawn: () => game.pending()?.seat === seat ? game.drawn : null,
    melds: () => game.melds.map(ms => ms.map(m => ({ ...m, tiles: m.tiles.slice() }))),
    players: () => game.players.map(p => ({ kind: p.kind, name: p.name })),
    events: () => game.events.filter(e => e.type !== 'draw').map(e => ({ ...e })),
  };
  return new Proxy({}, { get(_, key) {
    if (Object.hasOwn(methods, key)) return methods[key];
    if (Object.hasOwn(getters, key)) return getters[key]();
    throw new Error('non-public Game access: ' + String(key));
  } });
}

// 3刻子の完成までの不足枚数。関数牌の同種6/9枚も扱い、物理枚数・公開残数を超えない。
export function tripletMissing(rules, counts, unseen) {
  let dp = [0, Infinity, Infinity, Infinity];
  for (const t of rules.types) {
    const next = dp.slice();
    for (let have = 0; have < 3; have++) for (let groups = 1; groups <= 3 - have; groups++) {
      const need = groups * 3;
      const miss = Math.max(0, need - counts[t.idx]);
      if (need > t.copies || miss > unseen[t.idx]) continue;
      next[have + groups] = Math.min(next[have + groups], dp[have] + miss);
    }
    dp = next;
  }
  return dp[3];
}
function formulaPotential(rules, counts) {
  let v = 0;
  for (const m of rules.melds) if (m.kind === 'formula') {
    const have = m.tiles.filter(t => counts[t] > 0).length;
    v += have === 3 ? 3 : have === 2 ? 1 : 0;
  }
  return v;
}
const taraReady = new WeakMap();
export function liveWaits(game, seat, tile) {
  const view = game.viewFor(seat), counts = viewCounts(game.rules, view);
  counts[game.typeOf(tile)]--;
  const waits = game.waitsOf(counts, view.melds[seat].map(m => m.meld));
  const unseen = unseenCounts(game.rules, view);
  return { types: waits.length, live: waits.reduce((n, t) => n + Math.max(0, unseen[t]), 0) };
}
export function opponentWeights(history = []) {
  return Array.from({ length: 4 }, (_, s) => {
    const h = history[s] || { rounds: 0, calls: 0, earlyRiichi: 0 };
    const calls = (h.calls + 1) / (h.rounds + 4);
    const early = (h.earlyRiichi + 1) / (h.rounds + 4);
    return clamp(1 + 0.45 * (calls - 0.25) + 0.25 * (early - 0.25), 0.8, 1.35);
  });
}
function nocchiDiscard(game, seat, rng, info) {
  const rules = game.rules, view = game.viewFor(seat);
  const counts = viewCounts(rules, view), unseen = unseenCounts(rules, view);
  const ex = view.melds[seat].map(m => m.meld), types = [...new Set(view.hand.map(h => h.type))];
  const weights = opponentWeights(info?.publicHistory);
  const vals = types.map(t => { counts[t]--; const v = advHandValue(rules, counts, ex, unseen, 'speed', view.wallCount); counts[t]++; return v; });
  const best = Math.max(...vals), bi = vals.indexOf(best);
  counts[types[bi]]--; const base = handValue(rules, counts, ex, unseen, 'speed'); counts[types[bi]]++;
  const wc = WIN_COEF[rules.config.mode] || WIN_COEF.math2; // ローカル旧規則のみのフォールバック
  const pWin = 1 / (1 + Math.exp(-clamp(wc[0] + wc[1] * Math.log(base + 1e-9) + wc[2] * view.wallCount + wc[3] * ex.length, -50, 50)));
  const danger = dangerTableV06(game, rules, view, unseen, seat) || dangerTable(rules, view, unseen);
  const P = TRIO_PARAMS.nocchi;
  const gain = (view.dealer === seat ? 6 : 4) * P.ownBase;
  const chosen = pickBest(types, (t) => {
    const risk = danger.reduce((n, d, o) => n + (o === seat ? 0 : d[t] * weights[o] * (o === view.dealer ? 6 : 4) * P.opponentBase), 0);
    return pWin * gain * (best > 0 ? vals[types.indexOf(t)] / best : 0) - P.defense * risk;
  }, rng);
  return view.hand.find(h => h.type === chosen).id;
}

export function decideTrioCharacter(game, seat, id, rng, info = null) {
  if (!TRIO_PARAMS[id]) throw new Error('unknown trio character: ' + id);
  const p = game.pending();
  if (!p || p.seat !== seat) throw new Error('invalid pending');
  if (p.type === 'turn' && p.canTsumo) return { type: 'tsumo' };
  if (p.type === 'claim' && p.ron) return { type: 'ron' };
  if (game.riichi[seat]) return p.type === 'turn' ? { type: 'discard', tile: game.drawn } : { type: 'pass' };
  const rules = game.rules, view = game.viewFor(seat);
  if (p.type === 'claim') {
    if (id === 'yujin') return { type: 'pass' };
    return chooseCall(rules, view, game.typeOf(p.tile), p.chi, p.pon || null, 'speed') || { type: 'pass' };
  }
  if (id === 'yujin') {
    const counts = viewCounts(rules, view), unseen = unseenCounts(rules, view);
    const types = [...new Set(view.hand.map(h => h.type))], P = TRIO_PARAMS.yujin;
    const t = pickBest(types, (t) => {
      counts[t]--;
      const miss = tripletMissing(rules, counts, unseen);
      const val = -P.tripletWeight * (Number.isFinite(miss) ? miss : 10) + P.formulaWeight * formulaPotential(rules, counts);
      counts[t]++; return val;
    }, rng);
    const tile = view.hand.find(h => h.type === t).id;
    return { type: 'discard', tile, riichi: riichiDecision(game, seat, tile, 'beginner') };
  }
  if (id === 'tara') {
    const opts = game.riichiOptions(seat), P = TRIO_PARAMS.tara;
    if (opts.length) {
      const candidates = opts.map(o => ({ tile: o.ids[0], ...liveWaits(game, seat, o.ids[0]) }));
      const best = pickBest(candidates, o => o.live + o.types * 0.01, rng);
      if (!taraReady.has(game)) taraReady.set(game, view.rivers[seat].length);
      const waited = view.rivers[seat].length - taraReady.get(game);
      const hold = best.live < P.minLive && waited < P.maxDelay && view.wallCount > P.minWall && !game.riichi.some(Boolean);
      return { type: 'discard', tile: best.tile, riichi: best.live > 0 && !hold };
    }
    taraReady.delete(game);
    return decide(game, seat, 'speed', rng, 'intermediate', info);
  }
  const tile = nocchiDiscard(game, seat, rng, info);
  return { type: 'discard', tile, riichi: riichiDecision(game, seat, tile, 'advanced') };
}
