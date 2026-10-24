// AI プレイヤー。Game.viewFor() の公開情報（自分の手牌・全員の河・公開面子・山の残り枚数）だけで判断する。
//
// 評価方法：あと必要な面子数 k に対し、k 個の面子の組合せ（重複可）を全て列挙し、
//   ・手牌に足りない牌の枚数（少ないほど高評価。あと1枚の組を強く優先）
//   ・足りない牌の「見えていない残り枚数」（他家の河・公開面子で枯れた牌は低評価）
//   ・その完成形の仮得点（チー済みの手は役なし形を 0 評価 ＝ 役の成立を考慮）
// を掛け合わせた重みの総和を「手の価値」とする。打牌は価値が最大になる牌を選ぶ。

export const PERSONALITIES = {
  speed: {
    label: '速攻型',
    chi: true, chiThreshold: 1.0, // チー後の価値が現状以上なら鳴く
    valueWeight: (pts) => 1 + 0.15 * (pts - 1),
  },
  value: {
    label: '役重視型',
    chi: true, chiThreshold: 1.35,
    valueWeight: (pts) => Math.pow(pts, 1.6),
  },
  closed: {
    label: '門前重視型',
    chi: false, chiThreshold: Infinity,
    valueWeight: (pts) => 1 + 0.4 * (pts - 1),
  },
};

// 調整用パラメータ（AIの強さの調整はここで行う）
export const AI_TUNING = {
  missDecay: 0.22, // 足りない牌1枚ごとの減衰
  availabilitySoftness: 3, // 残り枚数 u に対する係数 u/(u+s)
};

// rules ごとに「k 面子の組合せ」を事前計算（型付き配列で高速化）
const comboCache = new WeakMap();
function combosFor(rules, k) {
  let byK = comboCache.get(rules);
  if (!byK) comboCache.set(rules, (byK = {}));
  if (byK[k]) return byK[k];
  const M = rules.melds.length;
  const meldList = [];
  const reqT = [];
  const reqN = [];
  const reqStart = [0];
  const rec = (start, acc) => {
    if (acc.length === k) {
      const req = new Map();
      for (const mi of acc) for (const t of rules.melds[mi].tiles) req.set(t, (req.get(t) || 0) + 1);
      for (const [t, n] of req) { reqT.push(t); reqN.push(n); }
      reqStart.push(reqT.length);
      meldList.push(acc.slice());
      return;
    }
    for (let m = start; m < M; m++) { acc.push(m); rec(m, acc); acc.pop(); }
  };
  rec(0, []);
  byK[k] = {
    n: meldList.length, melds: meldList,
    reqT: Int16Array.from(reqT), reqN: Int8Array.from(reqN), reqStart: Int32Array.from(reqStart),
  };
  return byK[k];
}

// 公開面子＋組合せ（完成形）ごとの重み（仮得点×性格）。役なしで和了できない形は 0。
const weightCache = new WeakMap();
function comboWeights(rules, exposed, personality) {
  let cache = weightCache.get(rules);
  if (!cache) weightCache.set(rules, (cache = new Map()));
  const key = personality + ':' + exposed.slice().sort((a, b) => a - b).join(',');
  let w = cache.get(key);
  if (w) return w;
  const closed = exposed.length === 0;
  const needYaku = !closed && rules.config.rules.calledHandNeedsYaku;
  const vw = PERSONALITIES[personality].valueWeight;
  const combos = combosFor(rules, 3 - exposed.length);
  w = new Float64Array(combos.n);
  for (let i = 0; i < combos.n; i++) {
    const ev = rules.evaluateMelds([...exposed, ...combos.melds[i]], closed);
    w[i] = needYaku && !ev.hasYaku ? 0 : vw(ev.points);
  }
  cache.set(key, w);
  return w;
}

// 見えていない牌の枚数（自分の手牌・全員の河・全員の公開面子を除く）
export function unseenCounts(rules, view) {
  const u = rules.types.map((t) => t.copies);
  for (const h of view.hand) u[h.type]--;
  for (const r of view.rivers) for (const t of r) u[t]--;
  for (const ms of view.melds) for (const m of ms) for (const t of m.tiles) u[t]--;
  return u;
}

// 手の価値。counts: 手の内の牌, exposed: 自分の公開面子, unseen: 見えていない牌
export function handValue(rules, counts, exposed, unseen, personality) {
  const combos = combosFor(rules, 3 - exposed.length);
  const weights = comboWeights(rules, exposed, personality);
  const { missDecay, availabilitySoftness: s } = AI_TUNING;
  // 牌種類ごと・不足枚数ごとの係数を先に計算
  const T = counts.length;
  const f1 = new Float64Array(T);
  for (let t = 0; t < T; t++) f1[t] = unseen[t] > 0 ? missDecay * (unseen[t] / (unseen[t] + s)) : 0;
  const { reqT, reqN, reqStart, n } = combos;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const wv = weights[i];
    if (wv === 0) continue;
    let w = wv;
    for (let j = reqStart[i], e = reqStart[i + 1]; j < e; j++) {
      const t = reqT[j];
      const miss = reqN[j] - counts[t];
      if (miss <= 0) continue;
      if (unseen[t] < miss) { w = 0; break; }
      const f = f1[t];
      w *= miss === 1 ? f : miss === 2 ? f * f : f * f * f;
    }
    total += w;
  }
  return total;
}

function viewCounts(rules, view) {
  return rules.countsOf(view.hand.map((h) => h.type));
}

// 最良の打牌（牌 id）を選ぶ
export function chooseDiscard(rules, view, personality, rng) {
  const counts = viewCounts(rules, view);
  const exposed = view.melds[view.seat].map((m) => m.meld);
  const unseen = unseenCounts(rules, view);
  let best = -1;
  let cands = [];
  const tried = new Set();
  for (const h of view.hand) {
    if (tried.has(h.type)) continue;
    tried.add(h.type);
    counts[h.type]--;
    const v = handValue(rules, counts, exposed, unseen, personality);
    counts[h.type]++;
    if (v > best * (1 + 1e-9)) { best = v; cands = [h]; }
    else if (Math.abs(v - best) <= best * 1e-9) cands.push(h);
  }
  const pick = rng ? rng.pick(cands) : cands[0];
  return { id: pick.id, value: best };
}

// チーするか。options: Game.chiOptions の結果。する場合は option index、しない場合は -1。
export function chooseChi(rules, view, tileType, options, personality) {
  const p = PERSONALITIES[personality];
  if (!p.chi || !options.length) return -1;
  const counts = viewCounts(rules, view);
  const exposed = view.melds[view.seat].map((m) => m.meld);
  const unseen = unseenCounts(rules, view);
  unseen[tileType]++; // 打牌は河にあるが、チーすると自分の面子になる
  const before = handValue(rules, counts, exposed, unseen, personality);
  let bestIdx = -1;
  let bestVal = before * p.chiThreshold;
  options.forEach((opt, i) => {
    const after = counts.slice();
    for (const t of rules.melds[opt.meld].tiles) if (t !== tileType) after[t]--;
    const ex2 = [...exposed, opt.meld];
    const un2 = unseen.slice();
    un2[tileType]--;
    // チー後に打牌する牌も含めて最良値を評価
    let v = 0;
    const tried = new Set();
    for (let t = 0; t < after.length; t++) {
      if (after[t] <= 0 || tried.has(t)) continue;
      tried.add(t);
      after[t]--;
      v = Math.max(v, handValue(rules, after, ex2, un2, personality));
      after[t]++;
    }
    if (v > bestVal) { bestVal = v; bestIdx = i; }
  });
  return bestIdx;
}

// Game.pending() に対する AI の行動を決める
export function decide(game, seat, personality, rng) {
  const p = game.pending();
  const rules = game.rules;
  const view = game.viewFor(seat);
  if (p.type === 'turn') {
    if (p.canTsumo) return { type: 'tsumo' };
    return { type: 'discard', tile: chooseDiscard(rules, view, personality, rng).id };
  }
  if (p.ron) return { type: 'ron' };
  if (p.chi.length) {
    const i = chooseChi(rules, view, game.typeOf(p.tile), p.chi, personality);
    if (i >= 0) return { type: 'chi', option: i };
  }
  return { type: 'pass' };
}

// Game に行動を適用する共通関数（UI・シミュレーター・テストで共有）
export function applyAction(game, seat, action) {
  if (action.type === 'discard') game.discard(seat, action.tile);
  else if (action.type === 'tsumo') game.tsumo(seat);
  else game.respond(seat, action);
}
