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
      melds.push({ fn: fn.fn, deg: ang.deg, value: val.value, quadrant: ang.quadrant, tiles: [fn.idx, ang.idx, val.idx] });
    }
  }
  melds.forEach((m, i) => { m.idx = i; m.key = `${m.fn}${m.deg}=${m.value}`; });
  const meldsByTile = Array.from({ length: T }, () => []);
  for (const m of melds) for (const t of m.tiles) meldsByTile[t].push(m.idx);
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
        if (tl.every((t) => c[t] > 0)) {
          for (const t of tl) c[t]--;
          cur.push(mi);
          rec();
          cur.pop();
          for (const t of tl) c[t]++;
        }
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
  };

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

  // meldIdxs: 3面子の index。closed: チーなしか。
  function evaluateMelds(meldIdxs, closed) {
    const ms = meldIdxs.map((i) => melds[i]);
    const found = [];
    for (const y of yakuDefs) {
      if (y.closedOnly && !closed) continue;
      const det = detectors[y.id];
      if (!det) throw new Error(`no detector for yaku ${y.id}`);
      if (det(ms)) found.push({ id: y.id, name: y.name, points: y.points, yakuman: !!y.yakuman });
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
  function analyzeWin(counts, exposed = []) {
    const closed = exposed.length === 0;
    const k = 3 - exposed.length;
    const candidates = [];
    for (const d of decompose(counts, k)) {
      const all = [...exposed, ...d];
      const ev = evaluateMelds(all, closed);
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
    config, types, typeByKey, T, melds, meldsByTile, meldOf,
    decompose, evaluateMelds, detectSpecial, analyzeWin, countsOf,
    deckSize: types.reduce((s, t) => s + t.copies, 0),
  };
}
