// 牌の種類・面子・和了・役の判定。画面や手番進行から独立した純粋ロジック。
import { DEFAULT_CONFIG } from './config.js';
import { exact, key as exactKey, trigExact, quadrantOf } from './exact.js';

const QUADRANT_ANGLES = { 1: [30, 45, 60], 2: [120, 135, 150], 3: [210, 225, 240], 4: [300, 315, 330] };

export function createRules(config = DEFAULT_CONFIG) {
  // ---- 牌の種類（type）。0..T-1 の整数で管理 ----
  const types = [];
  for (const f of config.functions) {
    types.push({ kind: 'func', fn: f.key, key: `f:${f.key}`, copies: f.copies });
  }
  for (const a of config.angles) {
    if (!a.enabled) continue;
    types.push({ kind: 'angle', deg: a.deg, key: `a:${a.deg}`, copies: a.copies, quadrant: quadrantOf(a.deg) });
  }
  for (const v of config.values) {
    const ex = exact(...v.exact);
    types.push({ kind: 'value', value: v.key, key: `v:${v.key}`, copies: v.copies, exact: ex, display: v.display });
  }
  types.forEach((t, i) => { t.idx = i; });
  const typeByKey = new Map(types.map((t) => [t.key, t]));
  const T = types.length;
  const valueByExact = new Map(types.filter((t) => t.kind === 'value').map((t) => [exactKey(t.exact), t]));

  // ---- 有効な面子（関数・角度・結果の3種）を値表から生成 ----
  const melds = [];
  for (const ang of types.filter((t) => t.kind === 'angle')) {
    for (const fn of types.filter((t) => t.kind === 'func')) {
      const v = trigExact(fn.fn, ang.deg);
      if (v === null) continue; // tan90°, tan270° は定義なし
      const val = valueByExact.get(exactKey(v));
      if (!val) throw new Error(`no value tile for ${fn.fn}${ang.deg}`);
      melds.push({ kind: 'formula', fn: fn.fn, deg: ang.deg, value: val.value, quadrant: ang.quadrant, tiles: [fn.idx, ang.idx, val.idx] });
    }
  }
  melds.forEach((m, i) => { m.idx = i; m.key = `${m.fn}${m.deg}=${m.value}`; });
  const formulaCount = melds.length;
  // ---- 刻子（Ver.0.3）：同じ種類の牌3枚。数式面子の後ろに追加する（数式面子の index は従来と同じ） ----
  // 刻子には fn / deg / value を持たせない（数式系の役の判定で誤って使われないように）。牌の種類は type。
  if (config.rules.koutsu) {
    for (const t of types) {
      if (t.copies < 3) continue;
      melds.push({ kind: 'koutsu', type: t.idx, tiles: [t.idx, t.idx, t.idx], idx: melds.length, key: `${t.key}×3` });
    }
  }
  const meldsByTile = Array.from({ length: T }, () => []);
  for (const m of melds) for (const t of new Set(m.tiles)) meldsByTile[t].push(m.idx);
  const koutsuByType = new Array(T).fill(null);
  for (const m of melds) if (m.kind === 'koutsu') koutsuByType[m.type] = m;
  const meldByTriple = new Map(melds.map((m) => [[...m.tiles].sort((a, b) => a - b).join(','), m]));

  // 3枚の牌種類から面子を引く（順不同）。不正なら null。
  function meldOf(t1, t2, t3) {
    return meldByTriple.get([t1, t2, t3].sort((a, b) => a - b).join(',')) || null;
  }

  // ---- 手牌を k 面子へ分割する全パターン（打切りなし・重複なし） ----
  function decompose(counts, k) {
    const total = counts.reduce((s, c) => s + c, 0);
    if (total !== 3 * k) return [];
    const out = new Map();
    const c = counts.slice();
    const cur = [];
    (function rec() {
      let first = -1;
      for (let i = 0; i < T; i++) if (c[i] > 0) { first = i; break; }
      if (first < 0) {
        const s = cur.slice().sort((a, b) => a - b);
        out.set(s.join(','), s);
        return;
      }
      for (const mi of meldsByTile[first]) {
        const tl = melds[mi].tiles;
        // 刻子は同じ牌を3枚使うので、1枚ずつ減らして枚数を確かめる
        let j = 0;
        for (; j < tl.length; j++) {
          if (c[tl[j]] <= 0) break;
          c[tl[j]]--;
        }
        if (j === tl.length) {
          cur.push(mi);
          rec();
          cur.pop();
        }
        for (let x = 0; x < j; x++) c[tl[x]]++;
      }
    })();
    return [...out.values()];
  }

  // ---- 役判定（完成した3面子に対して） ----
  const yakuDefs = config.yaku.filter((y) => y.enabled);
  const detectors = {
    sankan: (ms) => new Set(ms.map((m) => m.fn)).size === 3,
    doukan: (ms) => new Set(ms.map((m) => m.fn)).size === 1,
    // sinθ と cos(90°−θ)（0≤θ≤90）の2面子を含む。値が一致することも厳密値で確認。
    yokaku: (ms) => ms.some((a, i) => ms.some((b, j) => i !== j && a.fn === 'sin' && b.fn === 'cos'
      && a.deg >= 0 && b.deg >= 0 && a.deg + b.deg === 90 && a.value === b.value)),
    sanshougen: (ms) => ms.every((m) => m.quadrant > 0) && new Set(ms.map((m) => m.quadrant)).size === 3,
    shougen1: (ms) => ms.every((m) => m.quadrant === 1),
    shougen2: (ms) => ms.every((m) => m.quadrant === 2),
    shougen3: (ms) => ms.every((m) => m.quadrant === 3),
    shougen4: (ms) => ms.every((m) => m.quadrant === 4),
    shougenSankaku: (ms) => {
      const degs = ms.map((m) => m.deg).sort((a, b) => a - b).join(',');
      return Object.values(QUADRANT_ANGLES).some((q) => q.join(',') === degs);
    },
    douchi: (ms) => new Set(ms.map((m) => m.value)).size === 1,
    doukaku: (ms) => new Set(ms.map((m) => m.deg)).size === 1 && new Set(ms.map((m) => m.fn)).size === 3,
    sanjuu: (ms) => new Set(ms.map((m) => m.key)).size === 1,
    // ---- 刻子系（Ver.0.3） ----
    toitoi: (ms) => ms.every((m) => m.kind === 'koutsu'),
    // 門前限定（closedOnly）。ロンで完成した刻子を暗刻に数えるかは設定で切り替える
    sanankou: (ms, ctx) => ms.every((m) => m.kind === 'koutsu') && (!ctx.ron || config.rules.sanankouRonCounts !== false),
    sinIsshoku: (ms) => isshoku(ms, 'sin'),
    cosIsshoku: (ms) => isshoku(ms, 'cos'),
    tanIsshoku: (ms) => isshoku(ms, 'tan'),
  };
  // 関数一色：9枚すべて同じ関数牌（＝その関数牌の刻子3組）
  function isshoku(ms, fn) {
    return ms.every((m) => m.kind === 'koutsu' && types[m.type].kind === 'func' && types[m.type].fn === fn);
  }

  function scoreYaku(list) {
    const yakuman = list.filter((y) => y.yakuman);
    if (yakuman.length && config.scoring.yakumanOverridesNormal) {
      const pts = config.scoring.yakumanStack
        ? yakuman.reduce((s, y) => s + y.points, 0)
        : Math.max(...yakuman.map((y) => y.points));
      return { yaku: yakuman, points: pts, yakuman: true };
    }
    return { yaku: list, points: config.scoring.base + list.reduce((s, y) => s + y.points, 0), yakuman: yakuman.length > 0 };
  }

  // meldIdxs: 3面子の index。closed: チー・ポンなしか。ron: ロン和了か（三暗刻の暫定規則で使う）。
  // 数式系の役（formulaOnly）は3組とも数式面子のときだけ評価する（刻子を含む混合形には付かない）。
  function evaluateMelds(meldIdxs, closed, { ron = false } = {}) {
    const ms = meldIdxs.map((i) => melds[i]);
    const allFormula = ms.every((m) => m.kind === 'formula');
    const ctx = { closed, ron };
    const found = [];
    for (const y of yakuDefs) {
      if (y.closedOnly && !closed) continue;
      if (y.formulaOnly && !allFormula) continue;
      const det = detectors[y.id];
      if (!det) throw new Error(`no detector for yaku ${y.id}`);
      if (det(ms, ctx)) found.push({ id: y.id, name: y.name, points: y.points, yakuman: !!y.yakuman });
    }
    return { ...scoreYaku(found), hasYaku: found.length > 0 };
  }

  // ---- 特殊和了 ----
  const specials = config.specialHands.filter((s) => s.enabled).map((s) => {
    const idxs = s.angles.map((d) => typeByKey.get(`a:${d}`));
    return { ...s, typeIdxs: idxs.every(Boolean) ? idxs.map((t) => t.idx) : null };
  });

  function detectSpecial(counts, closed) {
    const res = [];
    for (const s of specials) {
      if (!s.typeIdxs) continue; // 必要な角度牌が無効（例: 360°なし）
      if (s.closedOnly && !closed) continue;
      const want = new Array(T).fill(0);
      for (const t of s.typeIdxs) want[t]++;
      if (want.every((w, i) => counts[i] === w)) {
        res.push({ id: s.id, name: s.name, points: s.points, yakuman: !!s.yakuman });
      }
    }
    return res;
  }

  // ---- 和了判定 ----
  // counts: 手の内の牌（和了牌を含む） / exposed: 公開面子 index 配列
  // 合法な全和了形を評価し、最高得点の形を返す。和了不可なら null。
  // opts.ron: ロン和了の判定か（三暗刻の暫定規則）。
  function analyzeWin(counts, exposed = [], { ron = false } = {}) {
    const closed = exposed.length === 0;
    const k = 3 - exposed.length;
    const candidates = [];
    for (const d of decompose(counts, k)) {
      const all = [...exposed, ...d];
      const ev = evaluateMelds(all, closed, { ron });
      if (!closed && config.rules.calledHandNeedsYaku && !ev.hasYaku) continue;
      candidates.push({ kind: 'normal', melds: all, concealedMelds: d, exposedMelds: exposed.slice(), ...ev });
    }
    for (const sp of detectSpecial(counts, closed)) {
      candidates.push({ kind: 'special', special: sp.id, melds: [], ...scoreYaku([sp]), hasYaku: true });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.points - a.points || b.yaku.length - a.yaku.length);
    return { ...candidates[0], candidateCount: candidates.length, closed };
  }

  function countsOf(typeIdxs) {
    const c = new Array(T).fill(0);
    for (const t of typeIdxs) c[t]++;
    return c;
  }

  return {
    config, types, typeByKey, T, melds, meldsByTile, meldOf, formulaCount,
    koutsuOf: (t) => koutsuByType[t] || null, // その牌種類の刻子（刻子なしの規則・3枚未満の牌は null）
    decompose, evaluateMelds, detectSpecial, analyzeWin, countsOf,
    deckSize: types.reduce((s, t) => s + t.copies, 0),
  };
}
