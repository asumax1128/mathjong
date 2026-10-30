import { decideBeginner, decideAdvanced } from './ai-levels.js';

// AI プレイヤー。Game.viewFor() の公開情報（自分の手牌・全員の河・公開面子・山の残り枚数）だけで判断する。
//
// 評価方法：あと必要な面子数 k に対し、k 個の面子の組合せ（重複可）を全て列挙し、
//   ・手牌に足りない牌の枚数（少ないほど高評価。あと1枚の組を強く優先）
//   ・足りない牌の「見えていない残り枚数」（他家の河・公開面子で枯れた牌は低評価）
//   ・その完成形の仮得点（チー済みの手は役なし形を 0 評価 ＝ 役の成立を考慮）
// を掛け合わせた重みの総和を「手の価値」とする。打牌は価値が最大になる牌を選ぶ。
//
// Ver.0.3（刻子・ポン）：
//   ・数式面子を作る戦略を保つため、門前の手では手の内で作る刻子1組ごとに重みへ koutsuBias を掛ける。
//   ・関数一色（役満）は通常 AI に無理に追わせないため、重みの計算では対々和と同じ点数として扱う（aiPoints）。
//   ・ポン・チーは「鳴いた後の最良の手の価値」が「鳴かない場合 × しきい値」を上回るときだけ行う。
//     鳴いた手は役が必要なので、役の見込みがない形の価値は 0（＝役の見込みがなければ鳴かない）。
//     刻子を公開した後は数式系の役が付かないため、ポンは実質的に対々和の見込みで判断される。
//   ・判断材料は公開情報だけ（自分の手牌・公開面子・全員の河。他家の手牌・山の順番は使わない）。

export const PERSONALITIES = {
  speed: {
    label: '速攻型',
    chi: true, chiThreshold: 1.0, // チー後の価値が現状以上なら鳴く
    pon: true, ponThreshold: 1.0, ponTempo: 2.5,
    koutsuBias: 0.55,
    valueWeight: (pts) => 1 + 0.15 * (pts - 1),
  },
  value: {
    label: '役重視型',
    chi: true, chiThreshold: 1.35,
    pon: true, ponThreshold: 1.35, ponTempo: 1.5,
    koutsuBias: 0.5,
    valueWeight: (pts) => Math.pow(pts, 1.6),
  },
  closed: {
    label: '門前重視型',
    chi: false, chiThreshold: Infinity,
    pon: false, ponThreshold: Infinity, ponTempo: 1,
    koutsuBias: 0.5,
    valueWeight: (pts) => 1 + 0.4 * (pts - 1),
  },
};

// 調整用パラメータ（AIの強さの調整はここで行う）
export const AI_TUNING = {
  missDecay: 0.22, // 足りない牌1枚ごとの減衰
  availabilitySoftness: 3, // 残り枚数 u に対する係数 u/(u+s)
  ponMaxMissing: 2, // ポン後、役の付く完成形まで「まだ取得可能な牌」があと何枚以内ならポンを検討するか
};

const ISSHOKU = new Set(['sinIsshoku', 'cosIsshoku', 'tanIsshoku']);
// AI が重みに使う点数。関数一色は対々和（通常和了点＋対々和）と同じ扱いにして、一色を無理に狙わない。
export function aiPoints(rules, ev) {
  if (!ev.yaku.some((y) => ISSHOKU.has(y.id))) return ev.points;
  const toitoi = rules.config.yaku.find((y) => y.id === 'toitoi' && y.enabled);
  return rules.config.scoring.base + (toitoi ? toitoi.points : 0);
}

// rules ごとに「k 面子の組合せ」を事前計算（型付き配列で高速化）
const comboCache = new WeakMap();
export function combosFor(rules, k) {
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
export function comboWeights(rules, exposed, personality) {
  let cache = weightCache.get(rules);
  if (!cache) weightCache.set(rules, (cache = new Map()));
  const key = personality + ':' + exposed.slice().sort((a, b) => a - b).join(',');
  let w = cache.get(key);
  if (w) return w;
  const closed = exposed.length === 0;
  const needYaku = !closed && rules.config.rules.calledHandNeedsYaku;
  const { valueWeight: vw, koutsuBias } = PERSONALITIES[personality];
  const combos = combosFor(rules, 3 - exposed.length);
  w = new Float64Array(combos.n);
  for (let i = 0; i < combos.n; i++) {
    const ev = rules.evaluateMelds([...exposed, ...combos.melds[i]], closed);
    if (needYaku && !ev.hasYaku) { w[i] = 0; continue; }
    let wv = vw(aiPoints(rules, ev));
    // 門前の手：手の内で作る刻子1組ごとに減衰（数式面子を優先する。旧規則では刻子がないので常に1倍）。
    // 鳴いた手は役の付く形だけが残る（刻子を公開した手は対々和のみ）ので減衰しない。
    if (closed) for (const mi of combos.melds[i]) if (rules.melds[mi].kind === 'koutsu') wv *= koutsuBias;
    w[i] = wv;
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

// 不足 miss 枚の減衰 f^miss。1〜3枚は従来と同じ式（浮動小数点の演算順序も同じ＝旧規則の判断は不変）。
// 4枚以上（Ver.0.3：同じ牌の刻子を2〜3組使う完成形）は f*f*f に f を順に掛ける。
export function missFactor(f, miss) {
  if (miss === 1) return f;
  if (miss === 2) return f * f;
  let w = f * f * f;
  for (let k = 3; k < miss; k++) w *= f;
  return w;
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
      w *= missFactor(f, miss);
    }
    total += w;
  }
  return total;
}

export function viewCounts(rules, view) {
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

// 鳴くか（チー・ポン）。chiOptions: Game.chiOptions の結果、ponOption: Game.ponOption の結果（なければ null）。
// 戻り値：{ type: 'chi', option } / { type: 'pon' } / null（鳴かない）。
// 鳴いた後（打牌も含めて最良）の手の価値が、鳴かない場合の価値 × しきい値を上回る候補のうち最良のもの。
export function chooseCall(rules, view, tileType, chiOptions, ponOption, personality) {
  const p = PERSONALITIES[personality];
  const cands = [];
  if (p.chi) chiOptions.forEach((opt, i) => cands.push({ action: { type: 'chi', option: i }, meld: opt.meld, threshold: p.chiThreshold }));
  // ポンはツモを待たずに刻子が完成する（手が1巡進む）ので、その分を ponTempo として鳴いた後の価値に掛ける
  if (p.pon && ponOption) cands.push({ action: { type: 'pon' }, meld: ponOption.meld, threshold: p.ponThreshold, tempo: p.ponTempo });
  if (!cands.length) return null;
  const counts = viewCounts(rules, view);
  const exposed = view.melds[view.seat].map((m) => m.meld);
  const unseen = unseenCounts(rules, view);
  unseen[tileType]++; // 打牌は河にあるが、鳴くと自分の面子になる
  const before = handValue(rules, counts, exposed, unseen, personality);
  let best = null;
  let bestScore = 0;
  for (const c of cands) {
    // ポン：役の付く完成形（実質的に対々和）まで、見えていない牌だけで ponMaxMissing 枚以内で届かなければ鳴かない
    if (c.action.type === 'pon' && minMissingAfterCall(rules, counts, exposed, unseen, tileType, c.meld, personality) > AI_TUNING.ponMaxMissing) continue;
    const v = valueAfterCall(rules, counts, exposed, unseen, tileType, c.meld, personality) * (c.tempo || 1);
    const need = before * c.threshold;
    if (v > need && (!best || v > bestScore)) { best = c.action; bestScore = v; }
  }
  return best;
}

// 面子 meld を鳴いた後の手で、役の付く完成形（重み > 0）に足りない牌の最小枚数。
// 見えていない牌の枚数を超えて必要な形（取得不可能）は数えない。届かなければ Infinity。
export function minMissingAfterCall(rules, counts, exposed, unseen, tileType, meld, personality) {
  const after = callCounts(rules, counts, tileType, meld);
  const ex2 = [...exposed, meld];
  const un2 = unseen.slice();
  un2[tileType]--;
  const combos = combosFor(rules, 3 - ex2.length);
  const weights = comboWeights(rules, ex2, personality);
  let best = Infinity;
  for (let i = 0; i < combos.n; i++) {
    if (weights[i] === 0) continue;
    let miss = 0;
    for (let j = combos.reqStart[i], e = combos.reqStart[i + 1]; j < e; j++) {
      const t = combos.reqT[j];
      const m = combos.reqN[j] - after[t];
      if (m <= 0) continue;
      if (un2[t] < m) { miss = Infinity; break; }
      miss += m;
    }
    if (miss < best) best = miss;
  }
  return best;
}

// 面子 meld を鳴いた後の手の内（鳴いた牌は刻子でも1枚だけ）
export function callCounts(rules, counts, tileType, meld) {
  const after = counts.slice();
  let used = false;
  for (const t of rules.melds[meld].tiles) {
    if (t === tileType && !used) { used = true; continue; }
    after[t]--;
  }
  return after;
}

// 面子 meld を鳴いた後、最良の打牌をしたときの手の価値
export function valueAfterCall(rules, counts, exposed, unseen, tileType, meld, personality) {
  const after = callCounts(rules, counts, tileType, meld);
  const ex2 = [...exposed, meld];
  const un2 = unseen.slice();
  un2[tileType]--;
  let v = 0;
  for (let t = 0; t < after.length; t++) {
    if (after[t] <= 0) continue;
    after[t]--;
    v = Math.max(v, handValue(rules, after, ex2, un2, personality));
    after[t]++;
  }
  return v;
}

// チーするか（Ver.0.2 までの関数。互換のため残す）。する場合は option index、しない場合は -1。
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

// Game.pending() に対する AI の行動を決める。
// level：AI 難易度（Ver.0.4-B）'beginner' | 'intermediate' | 'advanced'。省略時は中級（Ver.0.4-A までの AI と同一）。
// info：試合の公開情報（持ち点・親番など。上級だけが使う。src/engine/ai-levels.js の matchInfo を参照）。
export function decide(game, seat, personality, rng, level = 'intermediate', info = null) {
  if (level !== 'beginner' && level !== 'intermediate' && level !== 'advanced') throw new Error(`unknown AI level ${level}`);
  // リーチ中（規則 riichi のとき）：ツモ和了できればツモ、できなければツモ切り（難易度によらない。鳴きはエンジンが出さない）
  const p = game.pending();
  if (p && p.type === 'turn' && p.ankan?.length && !p.canTsumo) return {type:'ankan',tileType:p.ankan[0].type};
  if (p && p.type === 'turn' && game.riichi && game.riichi[seat]) {
    if (p.canTsumo) return { type: 'tsumo' };
    return { type: 'discard', tile: game.drawn };
  }
  let a;
  if (level === 'beginner') a = decideBeginner(game, seat, rng);
  else if (level === 'advanced') a = decideAdvanced(game, seat, personality, rng, info);
  else a = decideIntermediate(game, seat, personality, rng);
  return a.type === 'discard' ? withRiichi(game, seat, a, level) : a;
}

// 打牌を決めた後、その打牌でリーチするか（Ver.0.5-A）。打牌の選び方は各難易度のまま変えない。
// 条件：規則 riichi・門前・未リーチ、その牌を捨てた8枚が聴牌。
//   初級：聴牌ならいつもリーチ。
//   中級・上級：待ちの牌が自分から見えていない分（＝山や他家の手にあり得る枚数）で1枚以上残っているときだけリーチ
//              （残り0枚の待ちでツモ切りに縛られるのを避ける）。
// 判断材料は自分の手牌と公開情報（unseenCounts）だけ。
export function riichiDecision(game, seat, tileId, level) {
  if (!game.riichiEnabled || game.riichi[seat] || game.melds[seat].length) return false;
  const rules = game.rules;
  const view = game.viewFor(seat);
  const counts = viewCounts(rules, view);
  counts[game.typeOf(tileId)]--;
  const waits = game.waitsOf(counts);
  if (!waits.length) return false;
  if (level === 'beginner') return true;
  const unseen = unseenCounts(rules, view);
  return waits.reduce((n, t) => n + Math.max(0, unseen[t]), 0) >= 1;
}

function withRiichi(game, seat, a, level) {
  return riichiDecision(game, seat, a.tile, level) ? { ...a, riichi: true } : a;
}

// 中級：Ver.0.4-A までの AI（判断・乱数の使い方とも変更しない）
function decideIntermediate(game, seat, personality, rng) {
  const p = game.pending();
  const rules = game.rules;
  const view = game.viewFor(seat);
  if (p.type === 'turn') {
    if (p.canTsumo) return { type: 'tsumo' };
    return { type: 'discard', tile: chooseDiscard(rules, view, personality, rng).id };
  }
  if (p.ron) return { type: 'ron' };
  if (p.chi.length || p.pon) {
    const call = chooseCall(rules, view, game.typeOf(p.tile), p.chi, p.pon || null, personality);
    if (call) return call;
  }
  return { type: 'pass' };
}

// Game に行動を適用する共通関数（UI・シミュレーター・テストで共有）
export function applyAction(game, seat, action) {
  if (action.type === 'discard') game.discard(seat, action.tile, action.riichi ? { riichi: true } : undefined);
  else if (action.type === 'tsumo') game.tsumo(seat);
  else if (action.type === 'ankan') game.ankan(seat, action.tileType);
  else game.respond(seat, action);
}
