// AI 難易度（Ver.0.4-B）：初級・上級の判断。中級は src/engine/ai.js の従来の AI（変更なし）。
// 性格（speed / value / closed）と難易度は別の軸。どの難易度でも判断材料は Game.viewFor() の公開情報
// （自分の手牌・全員の河・全員の公開面子・山の残り枚数・親）と、試合の公開情報（持ち点・親番）だけ。
// 他家の手牌・山の並び・未来のツモ・乱数の内部状態は使わない。乱数は呼び出し元の seed 付き RNG だけを使う。
import { dealerOf } from './match.js';
import { unseenCounts, viewCounts, chooseCall, combosFor, comboWeights, missFactor, handValue, PERSONALITIES, aiPoints, AI_TUNING, valueAfterCall, minMissingAfterCall } from './ai.js';

// ---------------- 初級 ----------------
// ・チー・ポンをしない。ロン・ツモはできれば必ずする（見逃しで弱くしない）。
// ・打牌は「残したい度」の単純な評価だけ：手の中で完成している面子に含まれる牌は COMPLETE 点、
//   あと1枚で完成する面子に含まれる牌は PARTIAL 点（面子ごとに加算）。山の残り・他家の河・役・点数は見ない。
// ・残したい度の低い順に並べ（同点は乱数で並べ替え）、下位から PICK の確率で選ぶ（いつも最善とは限らない）。
export const BEGINNER = {
  COMPLETE: 4,
  PARTIAL: 1,
  PICK: [0.6, 0.25, 0.15], // 残したい度が最も低い牌・2番目・3番目を選ぶ確率
};

// 牌種類 t の残したい度
export function beginnerKeepScore(rules, counts, t) {
  let score = 0;
  for (const mi of rules.meldsByTile[t]) {
    const need = new Map();
    for (const x of rules.melds[mi].tiles) need.set(x, (need.get(x) || 0) + 1);
    let missing = 0;
    for (const [x, n] of need) missing += Math.max(0, n - counts[x]);
    if (missing === 0) score += BEGINNER.COMPLETE;
    else if (missing === 1) score += BEGINNER.PARTIAL;
  }
  return score;
}

export function beginnerDiscard(rules, view, rng) {
  const counts = viewCounts(rules, view);
  const types = [];
  for (const h of view.hand) if (!types.includes(h.type)) types.push(h.type);
  // 同点の並びを乱数で決める（Fisher–Yates）→ 残したい度の昇順に安定ソート
  for (let i = types.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [types[i], types[j]] = [types[j], types[i]];
  }
  const scored = types.map((t) => ({ t, s: beginnerKeepScore(rules, counts, t) })).sort((a, b) => a.s - b.s);
  const probs = BEGINNER.PICK.slice(0, scored.length);
  const total = probs.reduce((a, b) => a + b, 0);
  let x = rng.next() * total;
  let k = 0;
  while (k < probs.length - 1 && x >= probs[k]) { x -= probs[k]; k++; }
  const t = scored[k].t;
  return view.hand.find((h) => h.type === t).id;
}

export function decideBeginner(game, seat, rng) {
  const p = game.pending();
  if (p.type === 'turn') {
    if (p.canTsumo) return { type: 'tsumo' };
    return { type: 'discard', tile: beginnerDiscard(game.rules, game.viewFor(seat), rng) };
  }
  if (p.ron) return { type: 'ron' };
  return { type: 'pass' }; // チー・ポンはしない
}

// ---------------- 上級 ----------------
// 中級の「手の価値」（攻め）を改良し、公開情報だけから見積もる「放銃の危険度」（守り）を加えて打牌を選ぶ。
// 詳細は docs/17-ver0.4-b-ai-autopass.md。係数は tools/simulate-levels.mjs の対戦結果で調整した。
export const ADVANCED = {
  missDecay: 0.15, // 足りない牌1枚ごとの減衰（中級は 0.22。対戦結果から 0.15 に調整）
  softness: 3, // 残り枚数 u の係数 u/(u+s)
  valueExp: null, // 完成形の重み：null＝性格の重み、数値 e＝点数^e
  koutsuBias: null, // null＝性格の値
  wallScale: 0, // 山の残りが少ないほど遠い形を減衰（0＝しない）
  defense: 1.5, // 放銃の見込み（点）の重み（0＝守らない。対戦結果から 1.5 に調整：数学Ⅰ・Ⅱとも 1.0 より良く、2.0 と同程度）
  callScale: 1, // 鳴きのしきい値の倍率（1＝中級と同じ）。calls: false で鳴かない
  calls: true,
};

// 試合の公開情報（app.js・シミュレーターが渡す）。null でもよい（1局だけの対局）。
// 画面に表示されている持ち点・親・親番・局数・連荘だけ（他家の手牌などは含まない）。
export function matchInfo(m) {
  if (!m) return null;
  return { scores: m.scores.slice(), dealer: dealerOf(m), hand: m.hand, length: m.length, renchan: m.renchan };
}

export function decideAdvanced(game, seat, personality, rng, info = null) {
  const p = game.pending();
  const rules = game.rules;
  const view = game.viewFor(seat);
  if (p.type === 'turn') {
    if (p.canTsumo) return { type: 'tsumo' };
    return { type: 'discard', tile: advancedDiscard(rules, view, personality, rng, info) };
  }
  if (p.ron) return { type: 'ron' };
  if (ADVANCED.calls && (p.chi.length || p.pon)) {
    const call = ADVANCED.callScale === 1 ? chooseCall(rules, view, game.typeOf(p.tile), p.chi, p.pon || null, personality)
      : advancedCall(rules, view, game.typeOf(p.tile), p.chi, p.pon || null, personality);
    if (call) return call;
  }
  return { type: 'pass' };
}

// 鳴きの判断（中級の chooseCall と同じ評価で、しきい値だけを callScale 倍）
function advancedCall(rules, view, tileType, chiOptions, ponOption, personality) {
  const P = PERSONALITIES[personality];
  const cands = [];
  if (P.chi) chiOptions.forEach((opt, i) => cands.push({ action: { type: 'chi', option: i }, meld: opt.meld, threshold: P.chiThreshold * ADVANCED.callScale }));
  if (P.pon && ponOption) cands.push({ action: { type: 'pon' }, meld: ponOption.meld, threshold: P.ponThreshold * ADVANCED.callScale, tempo: P.ponTempo });
  if (!cands.length) return null;
  const counts = viewCounts(rules, view);
  const exposed = view.melds[view.seat].map((m) => m.meld);
  const unseen = unseenCounts(rules, view);
  unseen[tileType]++;
  const before = handValue(rules, counts, exposed, unseen, personality);
  let best = null;
  let bestScore = 0;
  for (const c of cands) {
    if (c.action.type === 'pon' && minMissingAfterCall(rules, counts, exposed, unseen, tileType, c.meld, personality) > AI_TUNING.ponMaxMissing) continue;
    const v = valueAfterCall(rules, counts, exposed, unseen, tileType, c.meld, personality) * (c.tempo || 1);
    if (v > before * c.threshold && (!best || v > bestScore)) { best = c.action; bestScore = v; }
  }
  return best;
}

// 完成形ごとの重み（上級用）。役のない鳴き手は 0。
const advWeightCache = new WeakMap();
function advWeights(rules, exposed, personality) {
  let cache = advWeightCache.get(rules);
  if (!cache) advWeightCache.set(rules, (cache = new Map()));
  const key = `${personality}:${ADVANCED.valueExp}:${ADVANCED.koutsuBias}:` + exposed.slice().sort((a, b) => a - b).join(',');
  let w = cache.get(key);
  if (w) return w;
  if (ADVANCED.valueExp === null && ADVANCED.koutsuBias === null) {
    w = comboWeights(rules, exposed, personality);
  } else {
    const closed = exposed.length === 0;
    const needYaku = !closed && rules.config.rules.calledHandNeedsYaku;
    const P = PERSONALITIES[personality];
    const kb = ADVANCED.koutsuBias ?? P.koutsuBias;
    const combos = combosFor(rules, 3 - exposed.length);
    w = new Float64Array(combos.n);
    for (let i = 0; i < combos.n; i++) {
      const ev = rules.evaluateMelds([...exposed, ...combos.melds[i]], closed);
      if (needYaku && !ev.hasYaku) continue;
      const pts = aiPoints(rules, ev);
      let wv = ADVANCED.valueExp === null ? P.valueWeight(pts) : Math.pow(pts, ADVANCED.valueExp);
      if (closed) for (const mi of combos.melds[i]) if (rules.melds[mi].kind === 'koutsu') wv *= kb;
      w[i] = wv;
    }
  }
  cache.set(key, w);
  return w;
}

// 手の価値（上級用）。中級の handValue と同じ形で、減衰・残り枚数・山の残りの扱いを ADVANCED で変えられる。
export function advHandValue(rules, counts, exposed, unseen, personality, wallCount) {
  const combos = combosFor(rules, 3 - exposed.length);
  const weights = advWeights(rules, exposed, personality);
  const s = ADVANCED.softness;
  const scale = ADVANCED.wallScale > 0 ? Math.min(1, wallCount / ADVANCED.wallScale) : 1;
  const T = counts.length;
  const f1 = new Float64Array(T);
  for (let t = 0; t < T; t++) f1[t] = unseen[t] > 0 ? ADVANCED.missDecay * scale * (unseen[t] / (unseen[t] + s)) : 0;
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
      w *= missFactor(f1[t], miss);
    }
    total += w;
  }
  return total;
}

// 上級の打牌：期待値（点）で比べる。
//   攻め：自分の和了の見込み Pwin(t) × 和了の得点の見込み（自分が親なら 6B、子なら 4B。B は平均的な和了点）
//         Pwin(t) は最善の打牌の Pwin（WIN_COEF）に、手の価値の比 v(t)/v(最善) を掛けて見積もる。
//   守り：Σ 他家 o のロンの確率 P[o][t] × 支払い（o が親なら 6B、子なら 4B）× ADVANCED.defense
// 牌の残りや役の見込みは中級と同じ「手の価値」で評価する（性格の打ち方を保つ）。
export function advancedDiscard(rules, view, personality, rng, info) {
  const counts = viewCounts(rules, view);
  const exposed = view.melds[view.seat].map((m) => m.meld);
  const unseen = unseenCounts(rules, view);
  const types = [];
  for (const h of view.hand) if (!types.includes(h.type)) types.push(h.type);
  const vals = types.map((t) => {
    counts[t]--;
    const v = advHandValue(rules, counts, exposed, unseen, personality, view.wallCount);
    counts[t]++;
    return v;
  });
  const iBest = vals.indexOf(Math.max(...vals));
  const vBest = vals[iBest];
  let score;
  if (ADVANCED.defense > 0 && vBest > 0) {
    const P = dangerTable(rules, view, unseen);
    // 和了の見込みは性格によらない重み（速攻型）の手の価値で見積もる
    counts[types[iBest]]--;
    const vN = handValue(rules, counts, exposed, unseen, 'speed');
    counts[types[iBest]]++;
    const wc = (rules.config.rules.riichi ? WIN_COEF : WIN_COEF_V04B)[rules.config.mode] || (rules.config.rules.riichi ? WIN_COEF : WIN_COEF_V04B).math2;
    const pWin = sigmoid(wc[0] + wc[1] * Math.log(vN + 1e-9) + wc[2] * view.wallCount + wc[3] * exposed.length);
    const gain = view.dealer === view.seat ? 6 : 4;
    score = types.map((t, i) => {
      let loss = 0;
      for (let o = 0; o < 4; o++) if (o !== view.seat) loss += P[o][t] * (view.dealer === o ? 6 : 4);
      return pWin * gain * (vals[i] / vBest) - ADVANCED.defense * loss;
    });
  } else {
    score = vals;
  }
  const best = Math.max(...score);
  const tol = Math.abs(best) * 1e-9;
  const cands = types.filter((_, i) => score[i] >= best - tol);
  const t = rng.pick(cands);
  return view.hand.find((h) => h.type === t).id;
}

// ---- 放銃の見込み（危険度） ----
// 他家 o が牌 t でロンできる確率を、公開情報だけからロジスティック回帰で見積もる。特徴量：
//   w      ：t で完成する面子（o の公開面子と合わせて役の条件を満たすもの）について、残りの2枚を o が持っている見込みの和
//            （自分から見えていない枚数 u と o の手牌の枚数 h から u·h/U で近似。U は見えていない牌の総数）
//   turns  ：o の捨て牌の枚数＋鳴いた回数（巡目の目安。聴牌の見込みは巡目とともに上がる）
//   melds  ：o の鳴いた回数（1回・2回）
//   inRiver：o 自身が t を捨てているか（捨てた牌で待つことは少ない。フリテンはないので 0 にはならない）
// 係数は中級 AI どうしの対局（数学Ⅰ 300局・数学Ⅱ 200局、seed 9000〜）で、他家の実際の手牌から求めた「その牌でロンできたか」に
// 当てはめた値（node tools/calibrate-advanced.mjs --mode math1|math2 で再計算できる）。実際の対局では他家の手牌は一切見ない。
// 係数はリーチの規則の有無で切り替える（riichi: false では Ver.0.4-B の係数＝旧挙動をそのまま再現する）。
// 旧係数は main cd37c62（Ver.0.4-B）の値そのまま。リーチの特徴量（9番目）は新係数だけが持つ。
export const DANGER_COEF_V04B = {
  math1: [-6.982, 0.679, 0.554, 0.988, 2.007, -2.886, -0.264, 1.53],
  math2: [-9.945, 0.106, 0.309, 0.45, 2.205, -2.194, -0.081, 4.555],
};
export const WIN_COEF_V04B = {
  math1: [-2.816, 0.883, 0.03, 0.653],
  math2: [-3.673, 0.79, 0.02, 1.297],
};
export const DANGER_COEF = {
  //        [定数, log(w+0.001), turns, melds=1, melds=2, inRiver, min(turns,12)^2/10, w>0, riichi]
  // Ver.0.5-A：リーチ（公開情報）を特徴量に加え、リーチのある対局で当てはめ直した（AUC 0.916）。
  math1: [-8.079, 0.561, 0.072, 4.25, 5.568, -2.995, -0.004, 1.107, 4.334],
  math2: [-10.466, 0.376, 0.03, 3.677, 6.208, -2.579, 0.022, 3.455, 4.261],
};

// 自分の和了の見込み（同じ対局データで当てはめ）：logit = a + b·log(手の価値) + c·山の残り + d·鳴いた回数
export const WIN_COEF = {
  math1: [-2.862, 0.967, 0.032, 0.877],
  math2: [-4.105, 0.812, 0.023, 1.368],
};

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// 牌種類ごと・他家ごとのロンの確率 P[o][t]（o === 自分 は 0）
export function dangerTable(rules, view, unseen) {
  const T = unseen.length;
  const riichiRule = rules.config.rules.riichi === true;
  const table = riichiRule ? DANGER_COEF : DANGER_COEF_V04B;
  const coef = table[rules.config.mode] || table.math2;
  const U = unseen.reduce((a, b) => a + Math.max(0, b), 0) || 1;
  const out = [];
  for (let o = 0; o < 4; o++) {
    const P = new Float64Array(T);
    out.push(P);
    if (o === view.seat) continue;
    const hs = view.handCounts[o];
    const ex = view.melds[o].map((m) => m.meld);
    const valid = finalMeldFilter(rules, ex);
    const turns = view.rivers[o].length + view.melds[o].length;
    const inRiver = new Set(view.rivers[o]);
    let base = coef[0] + coef[2] * turns + (ex.length === 1 ? coef[3] : 0) + (ex.length >= 2 ? coef[4] : 0) + coef[6] * Math.min(turns, 12) ** 2 / 10;
    // リーチした他家は聴牌している（公開情報）。リーチの規則がないときは加えない（旧版と同じ計算順序・同じ値）
    if (riichiRule && view.riichi && view.riichi[o]) base += coef[8];
    for (let t = 0; t < T; t++) {
      let w = 0;
      for (const mi of rules.meldsByTile[t]) {
        if (valid && !valid.has(mi)) continue;
        const need = new Map();
        let skipped = false;
        for (const x of rules.melds[mi].tiles) {
          if (x === t && !skipped) { skipped = true; continue; }
          need.set(x, (need.get(x) || 0) + 1);
        }
        let q = 1;
        for (const [x, n] of need) for (let j = 0; j < n; j++) q *= (Math.max(0, unseen[x] - j) * hs) / U / (j + 1);
        w += q;
      }
      P[t] = sigmoid(base + coef[1] * Math.log(w + 1e-3) + (inRiver.has(t) ? coef[5] : 0) + (w > 0 ? coef[7] : 0));
    }
  }
  return out;
}

// 公開面子 ex を持つ他家が最後に完成させる面子の候補（鳴いた手は役が必要）。門前（ex が空）なら null（制限なし）。
const finalCache = new WeakMap();
function finalMeldFilter(rules, ex) {
  if (!ex.length || !rules.config.rules.calledHandNeedsYaku) return null;
  let cache = finalCache.get(rules);
  if (!cache) finalCache.set(rules, (cache = new Map()));
  const key = ex.slice().sort((a, b) => a - b).join(',');
  let set = cache.get(key);
  if (set) return set;
  set = new Set();
  const M = rules.melds.length;
  for (let m = 0; m < M; m++) {
    if (ex.length >= 2) {
      if (rules.evaluateMelds([...ex, m], false).hasYaku) set.add(m);
    } else {
      for (let x = 0; x < M; x++) if (rules.evaluateMelds([...ex, m, x], false).hasYaku) { set.add(m); break; }
    }
  }
  cache.set(key, set);
  return set;
}

