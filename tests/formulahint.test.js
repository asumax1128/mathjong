// Ver.0.3-B：数式ヒント（src/engine/formulahint.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFormulas, initialSelection, assignColors, exposedSummary } from '../src/engine/formulahint.js';
import { createRng } from '../src/engine/rng.js';
import { Game } from '../src/engine/game.js';
import { decide, applyAction } from '../src/engine/ai.js';
import { rulesFor, k } from './helpers.js';

const M1 = rulesFor('math1');
const M2 = rulesFor('math2');
const hand = (r, list) => list.map((s, i) => ({ id: 100 + i, type: r.typeByKey.get(k(s)).idx }));
const keyOf = (r, mi) => r.melds[mi].key;
const keys = (r, a) => a.formulas.map((f) => keyOf(r, f.meld));

// ---------------- A. 数式検出 ----------------

test('A：sin×3 だけなら0通り（刻子は数式に含めない）', () => {
  for (const r of [M1, M2]) {
    const a = analyzeFormulas(r, hand(r, ['sin', 'sin', 'sin']));
    assert.deepEqual(a.formulas, []);
    assert.equal(a.max, 0);
    assert.equal(initialSelection(r, a), null);
  }
});

test('A：sin30°=1/2 は1通り・最大1組（数学Ⅰ・Ⅱ）', () => {
  for (const r of [M1, M2]) {
    const a = analyzeFormulas(r, hand(r, ['sin', '30', '=1/2', 'cos', '0']));
    assert.deepEqual(keys(r, a), ['sin30=1/2']);
    assert.equal(a.max, 1);
  }
});

test('A：sin45°・cos45°（45°・1/√2 が1枚ずつ）は2通り・同時に最大1組', () => {
  const r = M1;
  const a = analyzeFormulas(r, hand(r, ['sin', 'cos', '45', '=1/√2']));
  assert.deepEqual(keys(r, a), ['sin45=1/√2', 'cos45=1/√2']);
  assert.equal(a.max, 1);
});

test('A：sin30°=1/2・cos30°=√3/2（30°が2枚）は2通り・同時に最大2組', () => {
  const r = M2;
  const a = analyzeFormulas(r, hand(r, ['sin', 'cos', '30', '30', '=1/2', '=√3/2']));
  assert.deepEqual(keys(r, a), ['sin30=1/2', 'cos30=√3/2']);
  assert.equal(a.max, 2);
});

test('A：sin30°=1/2 を3組作れる9枚は1通り・同時に最大3組（copies 3）', () => {
  const r = M1;
  const a = analyzeFormulas(r, hand(r, ['sin', 'sin', 'sin', '30', '30', '30', '=1/2', '=1/2', '=1/2']));
  assert.deepEqual(keys(r, a), ['sin30=1/2']);
  assert.equal(a.formulas[0].copies, 3);
  assert.equal(a.max, 3);
  assert.deepEqual(a.optimal.map((s) => s.map((mi) => keyOf(r, mi))), [['sin30=1/2', 'sin30=1/2', 'sin30=1/2']]);
});

test('A：同じ数式を作る牌が複数枚あっても1通り（重複除去）', () => {
  const r = M1;
  const a = analyzeFormulas(r, hand(r, ['sin', 'sin', '30', '30', '=1/2', '=1/2', 'cos']));
  assert.deepEqual(keys(r, a), ['sin30=1/2']);
  assert.equal(a.formulas[0].copies, 2);
  assert.equal(a.max, 2);
});

test('A：3通り以上を網羅（数学Ⅱ・角度の小さい順 → sin・cos・tan）、候補は多いが同時は1組', () => {
  const r = M2;
  // sin・cos・tan と 45°・225°、値 1/√2・−1/√2・1：sin45 cos45 tan45 sin225? (−1/√2) cos225 (−1/√2) tan225 (1)
  const a = analyzeFormulas(r, hand(r, ['sin', 'cos', 'tan', '45', '225', '=1/√2', '=-1/√2', '=1']));
  assert.deepEqual(keys(r, a), ['sin45=1/√2', 'cos45=1/√2', 'tan45=1', 'sin225=-1/√2', 'cos225=-1/√2', 'tan225=1']);
  assert.equal(a.max, 2, '関数牌3枚・角度2枚：同時に2組（例：sin45 と cos225）');
  assert.ok(a.optimal.length > 1, '最大組数を実現する組合せが複数');
});

test('A：数式面子と刻子が混在する手（刻子は数えず、数式だけ）', () => {
  const r = M1;
  const a = analyzeFormulas(r, hand(r, ['sin', '30', '=1/2', '45', '45', '45', '=0', '=0', '=0']));
  assert.deepEqual(keys(r, a), ['sin30=1/2']);
  assert.equal(a.max, 1);
});

test('A：公開面子は別に数える（数式面子・刻子の組数）', () => {
  const r = M1;
  const chi = r.melds.find((m) => m.key === 'sin30=1/2').idx;
  const pon = r.koutsuOf(r.typeByKey.get('v:0').idx).idx;
  assert.deepEqual(exposedSummary(r, [{ meld: chi }, { meld: pon }]), { formula: 1, koutsu: 1 });
  assert.deepEqual(exposedSummary(r, []), { formula: 0, koutsu: 0 });
});

// 総当たりの別実装：物理牌 id の3枚組を全部試し、数式（rules.meldOf が kind formula）を数える
function brute(r, h) {
  const distinct = new Set();
  for (let i = 0; i < h.length; i++) for (let j = i + 1; j < h.length; j++) for (let l = j + 1; l < h.length; l++) {
    const m = r.meldOf(h[i].type, h[j].type, h[l].type);
    if (m && m.kind === 'formula') distinct.add(m.idx);
  }
  let max = 0;
  const optimal = new Set();
  (function rec(pool, acc) {
    if (acc.length > max) { max = acc.length; optimal.clear(); }
    if (acc.length === max && max > 0) optimal.add(acc.slice().sort((a, b) => a - b).join(','));
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) for (let l = j + 1; l < pool.length; l++) {
      const m = r.meldOf(pool[i].type, pool[j].type, pool[l].type);
      if (!m || m.kind !== 'formula') continue;
      rec(pool.filter((_, x) => x !== i && x !== j && x !== l), [...acc, m.idx]);
    }
  })(h, []);
  return { distinct, max, optimal };
}

function randomHand(r, rng, n) {
  // 数式が出やすいよう、関数・角度・値をほぼ同数ずつ。物理牌の枚数は超えない
  const pool = [];
  r.types.forEach((t) => { for (let c = 0; c < t.copies; c++) pool.push(t.idx); });
  const pick = [];
  const left = pool.slice();
  const kinds = ['func', 'angle', 'value'];
  for (let i = 0; i < n; i++) {
    const want = kinds[Math.floor(rng.next() * 3)];
    const cand = left.map((t, x) => [t, x]).filter(([t]) => r.types[t].kind === want);
    const [t, x] = cand[Math.floor(rng.next() * cand.length)];
    pick.push(t);
    left.splice(x, 1);
  }
  return pick.map((t, i) => ({ id: 7 * i + 3, type: t }));
}

test('A：総当たりの別実装と一致（数学Ⅰ・Ⅱ、2〜9枚のランダム手牌 各800）', () => {
  for (const r of [M1, M2]) {
    const rng = createRng(r === M1 ? 11 : 22);
    for (let n = 0; n < 800; n++) {
      const size = [2, 3, 5, 6, 8, 9][n % 6];
      const h = randomHand(r, rng, size);
      const a = analyzeFormulas(r, h);
      const b = brute(r, h);
      assert.deepEqual(a.formulas.map((f) => f.meld).sort((x, y) => x - y), [...b.distinct].sort((x, y) => x - y));
      assert.equal(a.max, b.max);
      assert.deepEqual(new Set(a.optimal.map((s) => s.slice().sort((x, y) => x - y).join(','))), b.optimal);
      assert.equal(new Set(a.formulas.map((f) => f.meld)).size, a.formulas.length, '候補の重複なし');
    }
  }
});

// ---------------- B. 色割り当て ----------------

// 色の割り当てが「その数式を sets 組、物理牌の重複なしに作れる」ことを確かめる
function checkColor(r, h, a, sel, res) {
  const typeOf = new Map(h.map((x) => [x.id, x.type]));
  for (const [slot, color] of [['a', 'red'], ['b', 'blue']]) {
    const mi = sel[slot];
    if (mi === null || mi === undefined || !res.sets[slot]) continue;
    const ids = [...res.colors].filter(([, c]) => c.includes(color) || (color === 'red' && c.includes('yellow'))).map(([id]) => id);
    const got = ids.map((id) => typeOf.get(id)).sort((x, y) => x - y);
    const want = [];
    for (let n = 0; n < res.sets[slot]; n++) want.push(...r.melds[mi].tiles);
    assert.deepEqual(got, want.sort((x, y) => x - y), `${slot}: ${res.sets[slot]}組ぶんの牌`);
  }
  for (const [id] of res.colors) assert.ok(typeOf.has(id), '手牌の牌だけ');
}

test('B：1通りは黄色。同じ数式を複数組作れるなら使える牌すべて（同色）', () => {
  const r = M1;
  const h = hand(r, ['sin', 'sin', 'sin', '30', '30', '30', '=1/2', '=1/2', 'cos']);
  const a = analyzeFormulas(r, h);
  const sel = initialSelection(r, a);
  const res = assignColors(r, h, a, sel, { single: true });
  assert.equal(res.sets.a, 2, '1/2 が2枚なので2組');
  assert.equal(res.colors.size, 6);
  assert.ok([...res.colors.values()].every((c) => c.length === 1 && c[0] === 'yellow'));
  // 3枚目の sin・30° は使えない（強調しない）
  assert.ok(!res.colors.has(102) && !res.colors.has(105));
  checkColor(r, h, a, sel, res);
});

test('B：異なる2通りは赤・青。30°が2枚なら1枚ずつ別々に（共有しない）', () => {
  const r = M2;
  const h = hand(r, ['sin', 'cos', '30', '30', '=1/2', '=√3/2']);
  const a = analyzeFormulas(r, h);
  const sel = initialSelection(r, a);
  assert.deepEqual([keyOf(r, sel.a), keyOf(r, sel.b)], ['sin30=1/2', 'cos30=√3/2']);
  const res = assignColors(r, h, a, sel);
  assert.equal(res.shared, false);
  assert.deepEqual(res.sets, { a: 1, b: 1 });
  assert.deepEqual(res.colors.get(102), ['red']);
  assert.deepEqual(res.colors.get(103), ['blue']);
  assert.ok([...res.colors.values()].every((c) => c.length === 1));
  checkColor(r, h, a, sel, res);
});

test('B：牌を共有する2式（45°・1/√2 が1枚）：sin 赤・cos 青、45° と 1/√2 は2色（共有）', () => {
  const r = M1;
  const h = hand(r, ['sin', 'cos', '45', '=1/√2']);
  const a = analyzeFormulas(r, h);
  const sel = initialSelection(r, a);
  assert.deepEqual([keyOf(r, sel.a), keyOf(r, sel.b)], ['sin45=1/√2', 'cos45=1/√2']);
  const res = assignColors(r, h, a, sel);
  assert.equal(res.shared, true);
  assert.deepEqual(res.colors.get(100), ['red']);
  assert.deepEqual(res.colors.get(101), ['blue']);
  assert.deepEqual(res.colors.get(102), ['red', 'blue']);
  assert.deepEqual(res.colors.get(103), ['red', 'blue']);
});

test('B：枚数が足りる種類は共有しない（45° が2枚・1/√2 が1枚なら 1/√2 だけ共有）', () => {
  const r = M1;
  const h = hand(r, ['sin', 'cos', '45', '45', '=1/√2']);
  const a = analyzeFormulas(r, h);
  const res = assignColors(r, h, a, initialSelection(r, a));
  assert.equal(res.shared, true);
  assert.deepEqual(res.colors.get(102), ['red']);
  assert.deepEqual(res.colors.get(103), ['blue']);
  assert.deepEqual(res.colors.get(104), ['red', 'blue']);
});

test('B：3通り以上でも色は最大2色。表示切替（赤だけ・青だけ・別の数式）で割り当てを再計算', () => {
  const r = M2;
  const h = hand(r, ['sin', 'cos', 'tan', '45', '225', '=1/√2', '=-1/√2', '=1']);
  const a = analyzeFormulas(r, h);
  const sel = initialSelection(r, a);
  // 初期選択：最大2組を実現する組合せに含まれる2式（並び順で最初：sin45 と cos225）
  assert.deepEqual([keyOf(r, sel.a), keyOf(r, sel.b)], ['sin45=1/√2', 'cos225=-1/√2']);
  const both = assignColors(r, h, a, sel);
  assert.equal(both.shared, false);
  const all = new Set([...both.colors.values()].flat());
  assert.ok([...all].every((c) => c === 'red' || c === 'blue'));
  checkColor(r, h, a, sel, both);
  const onlyA = assignColors(r, h, a, sel, { mode: 'a' });
  assert.ok([...onlyA.colors.values()].every((c) => c.length === 1 && c[0] === 'red'));
  assert.equal(onlyA.colors.size, 3);
  const onlyB = assignColors(r, h, a, sel, { mode: 'b' });
  assert.ok([...onlyB.colors.values()].every((c) => c.length === 1 && c[0] === 'blue'));
  // 別の数式に切り替え（sin45 と tan45：45°が1枚なので共有）
  const tan45 = r.melds.find((m) => m.key === 'tan45=1').idx;
  const sw = assignColors(r, h, a, { a: sel.a, b: tan45 });
  assert.equal(sw.shared, true);
  assert.deepEqual(sw.colors.get(h.find((x) => r.types[x.type].key === 'a:45').id), ['red', 'blue']);
});

test('B：色は物理牌 id に対応し、手牌の並び順（配列の順番）では変わらない', () => {
  const r = M2;
  const h = hand(r, ['sin', 'cos', '30', '30', '=1/2', '=√3/2', 'sin', '=1/2']);
  const a1 = analyzeFormulas(r, h);
  const r1 = assignColors(r, h, a1, initialSelection(r, a1));
  for (let s = 1; s <= 5; s++) {
    const rng = createRng(s);
    const shuffled = h.slice().sort(() => rng.next() - 0.5);
    const a2 = analyzeFormulas(r, shuffled);
    const r2 = assignColors(r, shuffled, a2, initialSelection(r, a2));
    assert.deepEqual([...r2.colors].sort((x, y) => x[0] - y[0]), [...r1.colors].sort((x, y) => x[0] - y[0]));
  }
});

test('B：ランダム手牌（数学Ⅰ・Ⅱ 各800）で色の割り当てに矛盾がない（二重利用なし・共有は最小・2色まで）', () => {
  for (const r of [M1, M2]) {
    const rng = createRng(r === M1 ? 33 : 44);
    for (let n = 0; n < 800; n++) {
      const h = randomHand(r, rng, [6, 8, 9][n % 3]);
      const a = analyzeFormulas(r, h);
      const sel = initialSelection(r, a);
      if (!sel) { assert.equal(a.formulas.length, 0); continue; }
      const single = a.formulas.length === 1;
      const res = assignColors(r, h, a, sel, { single });
      const cs = [...res.colors.values()];
      assert.ok(cs.every((c) => c.length >= 1 && c.length <= 2));
      if (single) {
        assert.equal(sel.b, null);
        assert.equal(res.sets.a, a.formulas[0].copies);
      } else {
        assert.notEqual(sel.a, sel.b, '異なる2種類');
      }
      if (!res.shared) {
        assert.ok(cs.every((c) => c.length === 1), '共有でなければ1枚1色');
        checkColor(r, h, a, sel, res);
      } else {
        // 共有するのは「両方の式に必要で、その種類の牌が足りない」ものだけ
        const counts = a.counts;
        const need = new Map();
        for (const t of [...r.melds[sel.a].tiles, ...r.melds[sel.b].tiles]) need.set(t, (need.get(t) || 0) + 1);
        const minShared = [...need].reduce((s, [t, x]) => s + Math.max(0, x - counts[t]), 0);
        assert.equal(cs.filter((c) => c.length === 2).length, minShared);
        assert.ok(minShared > 0);
      }
      // 初期選択（例外C）：最大組数を実現する組合せに2式が含まれる組があるなら、それを選ぶ
      if (!single) {
        const inOpt = (x, y) => a.optimal.some((s) => s.includes(x) && s.includes(y));
        const exists = a.formulas.some((f, i) => a.formulas.some((g, j) => j > i && inOpt(f.meld, g.meld)));
        if (exists) assert.ok(inOpt(sel.a, sel.b));
      }
    }
  }
});

// ---------------- チー・ポン後・ゲーム中の手牌 ----------------

test('チー・ポン後の手牌（公開面子を除く）でも正しい。AI 対局の全局面で総当たりと一致（両モード）', () => {
  let called = 0;
  for (const r of [M1, M2]) {
    const lineup = ['speed', 'value', 'closed', 'speed'];
    let checked = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const g = new Game({ rules: r, seed, players: lineup.map((p) => ({ kind: 'ai', personality: p })) });
      const rng = createRng(seed);
      while (g.pending()) {
        for (let s = 0; s < 4; s++) {
          const h = g.hands[s].map((id) => ({ id, type: g.typeOf(id) }));
          const a = analyzeFormulas(r, h);
          const b = brute(r, h);
          assert.equal(a.max, b.max);
          assert.equal(a.formulas.length, b.distinct.size);
          if (g.melds[s].length) called++;
          checked++;
        }
        const p = g.pending();
        applyAction(g, p.seat, decide(g, p.seat, lineup[p.seat], rng));
      }
    }
    assert.ok(checked > 100);
  }
  assert.ok(called > 0, '鳴いた手を含む');
});
