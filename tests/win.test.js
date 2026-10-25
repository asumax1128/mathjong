import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { createRng } from '../src/engine/rng.js';
import { rules, counts, meld } from './helpers.js';

const names = (a) => a.yaku.map((y) => y.name).sort();
const M = (...specs) => specs.map(([f, d, v]) => meld(f, d, v).idx);
const tilesOf = (ms) => ms.flatMap(([f, d, v]) => [f, String(d), v]);
const win = (ms, exposed = [], r = rules) => r.analyzeWin(counts(tilesOf(ms), r), exposed);

test('通常和了：門前は役なしでも和了可（基本点1）', () => {
  const a = win([['sin', 0, '=0'], ['sin', 90, '=1'], ['sin', 180, '=0']]);
  assert.ok(a);
  assert.equal(a.points, 3, '同関一色 +2'); // sanity: this one has 同関一色
  const b = win([['sin', 30, '=1/2'], ['sin', 120, '=√3/2'], ['cos', 180, '=-1']]);
  assert.ok(b);
  assert.deepEqual(names(b), []);
  assert.equal(b.points, 1);
});

test('和了でない手（8枚＋不要牌、面子不成立）', () => {
  assert.equal(rules.analyzeWin(counts(['sin', '30', '=1/2', 'cos', '60', '=1/2', 'tan', '90', '=0'])), null);
  assert.equal(rules.analyzeWin(counts(['sin', '30', '=1/2', 'cos', '60', '=1/2', 'tan', '45'])), null);
});

test('複数の分割がある場合、最初に見つかった形ではなく最高得点の形を採用する（旧30件打切り問題の再発防止）', () => {
  const tiles = ['sin', 'sin', 'cos', '0', '90', '360', '=0', '=1', '=1'];
  const all = rules.decompose(counts(tiles), 3);
  assert.equal(all.length, 2);
  const a = rules.analyzeWin(counts(tiles));
  assert.equal(a.candidateCount, 2);
  assert.deepEqual(names(a), ['余角対']);
  assert.equal(a.points, 3);
  // チー済み（sin90=1 公開）でも、役のある分割（cos0=1 + sin360=0）を見つけて和了できる
  const called = rules.analyzeWin(counts(['sin', 'cos', '0', '360', '=0', '=1']), M(['sin', 90, '=1']));
  assert.ok(called);
  assert.deepEqual(names(called), ['余角対']);
});

test('チーした手は役が必要', () => {
  const ex = M(['sin', 30, '=1/2']);
  // 役なし（sin30, sin120, cos180 → 関数2種、象限ばらばら（軸含む））
  assert.equal(rules.analyzeWin(counts(tilesOf([['sin', 120, '=√3/2'], ['cos', 180, '=-1']])), ex), null);
  // 三関制覇あり
  const a = rules.analyzeWin(counts(tilesOf([['cos', 180, '=-1'], ['tan', 45, '=1']])), ex);
  assert.ok(a);
  assert.deepEqual(names(a), ['三関制覇']);
  assert.equal(a.points, 2);
});

test('各役の判定', () => {
  assert.deepEqual(names(win([['sin', 30, '=1/2'], ['cos', 180, '=-1'], ['tan', 0, '=0']])), ['三関制覇']);
  assert.ok(names(win([['cos', 0, '=1'], ['cos', 180, '=-1'], ['cos', 90, '=0']])).includes('同関一色'));
  // 余角対 sin30 と cos60
  assert.ok(names(win([['sin', 30, '=1/2'], ['cos', 60, '=1/2'], ['sin', 180, '=0']])).includes('余角対'));
  // sin60 と cos60 は余角ではない
  assert.ok(!names(win([['sin', 60, '=√3/2'], ['cos', 60, '=1/2'], ['sin', 180, '=0']])).includes('余角対'));
  // 第2象限一色（同じ角度の重複OK）
  const q2 = win([['sin', 120, '=√3/2'], ['cos', 120, '=-1/2'], ['sin', 150, '=1/2']]);
  assert.ok(names(q2).includes('第2象限一色'));
  assert.ok(!names(q2).includes('象限三角揃い'));
  // 象限三角揃い（第4象限 300/315/330）＋第4象限一色
  const q4 = win([['sin', 300, '=-√3/2'], ['cos', 315, '=1/√2'], ['tan', 330, '=-1/√3']]);
  assert.deepEqual(names(q4), ['三関制覇', '第4象限一色', '象限三角揃い']);
  assert.equal(q4.points, 1 + 1 + 3 + 4);
  // 三象限巡り
  assert.ok(names(win([['sin', 30, '=1/2'], ['sin', 135, '=1/√2'], ['sin', 330, '=-1/2']])).includes('三象限巡り'));
  // 軸上の角度を含むと三象限巡りにならない
  assert.ok(!names(win([['sin', 30, '=1/2'], ['sin', 135, '=1/√2'], ['sin', 270, '=-1']])).includes('三象限巡り'));
  // 第1象限一色は 0°・90° を含まない
  assert.ok(!names(win([['sin', 30, '=1/2'], ['cos', 45, '=1/√2'], ['sin', 90, '=1']])).includes('第1象限一色'));
  // 同値三連（通常役）
  const dv = win([['sin', 30, '=1/2'], ['cos', 300, '=1/2'], ['sin', 150, '=1/2']]);
  assert.ok(names(dv).includes('同値三連'));
  assert.ok(!dv.yakuman);
});

test('役満：同角三関・三重同式（通常役は加算しない）', () => {
  const dk = win([['sin', 225, '=-1/√2'], ['cos', 225, '=-1/√2'], ['tan', 225, '=1']]);
  assert.deepEqual(names(dk), ['同角三関']);
  assert.equal(dk.points, 16);
  assert.ok(dk.yakuman);
  const sj = win([['sin', 30, '=1/2'], ['sin', 30, '=1/2'], ['sin', 30, '=1/2']]);
  assert.deepEqual(names(sj), ['三重同式']);
  assert.equal(sj.points, 16);
  // 牌が2組分しかなければ成立しない（同じ牌を重複利用しない）
  assert.equal(rules.analyzeWin(counts(['sin', 'sin', 'sin', '30', '30', '30', '=1/2', '=1/2', '=√3/2'])), null);
  // 同角三関は 90° では不可能（tan90 なし）
  assert.equal(rules.analyzeWin(counts(['sin', 'cos', 'tan', '90', '90', '90', '=1', '=0', '=0'])), null);
});

test('九角無双：門前のみ・通常面子とは別判定', () => {
  const nine = ['0', '30', '45', '60', '90', '120', '135', '150', '180'];
  const a = rules.analyzeWin(counts(nine));
  assert.equal(a.kind, 'special');
  assert.deepEqual(names(a), ['九角無双']);
  assert.equal(a.points, 16);
  // 1枚違えば不成立
  assert.equal(rules.analyzeWin(counts([...nine.slice(0, 8), '210'])), null);
  assert.equal(rules.analyzeWin(counts([...nine.slice(0, 8), '0'])), null);
  // チー済み（手の内6枚）では成立しない
  assert.equal(rules.analyzeWin(counts(nine.slice(0, 6)), M(['sin', 30, '=1/2'])), null);
});

test('裏九角無双：初期設定では無効、設定で有効化可能、360°無効なら成立不能', () => {
  const ura = ['180', '210', '225', '240', '270', '300', '315', '330', '360'];
  assert.equal(rules.analyzeWin(counts(ura)), null);
  const on = createRules(makeConfig({ legacy: true, enableSpecial: ['urakyukaku'] }));
  assert.deepEqual(names(on.analyzeWin(counts(ura, on))), ['裏九角無双']);
  const no360 = createRules(makeConfig({ legacy: true, enableSpecial: ['urakyukaku'], disableAngles: [360] }));
  assert.equal(no360.detectSpecial(new Array(no360.T).fill(0), true).length, 0);
});

test('得点設定はデータで変更できる', () => {
  const r = createRules(makeConfig({ legacy: true, yakuPoints: { sankan: 5 } }));
  const tiles = tilesOf([['sin', 30, '=1/2'], ['cos', 180, '=-1'], ['tan', 0, '=0']]);
  assert.equal(r.analyzeWin(counts(tiles, r)).points, 6);
});

// 全探索の検算：9枚を3枚ずつ3組に分ける全280通りを総当たりし、analyzeWin の最高得点と一致するか
function bruteForce(tileTypes, r = rules) {
  let best = null;
  const n = tileTypes.length;
  const used = new Array(n).fill(false);
  const groups = [];
  (function rec() {
    const first = used.indexOf(false);
    if (first < 0) {
      const ev = r.evaluateMelds(groups.map((g) => g.idx), true);
      if (!best || ev.points > best) best = ev.points;
      return;
    }
    used[first] = true;
    for (let i = first + 1; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      for (let j = i + 1; j < n; j++) {
        if (used[j]) continue;
        const m = r.meldOf(tileTypes[first], tileTypes[i], tileTypes[j]);
        if (!m) continue;
        used[j] = true; groups.push(m);
        rec();
        groups.pop(); used[j] = false;
      }
      used[i] = false;
    }
    used[first] = false;
  })();
  return best;
}

test('ランダムな完成形2000件で、和了判定・最高得点が総当たり検算と一致', () => {
  const rng = createRng(42);
  let multi = 0;
  for (let n = 0; n < 2000; n++) {
    const ms = [0, 1, 2].map(() => rules.melds[rng.int(rules.melds.length)]);
    let tiles = ms.flatMap((m) => m.tiles);
    if (n % 3 === 0) tiles[rng.int(9)] = rng.int(rules.T); // 一部は崩して不和了も検証
    const c = rules.countsOf(tiles);
    if (c.some((x, i) => x > rules.types[i].copies)) continue;
    const a = rules.analyzeWin(c);
    const b = bruteForce(tiles);
    if (a && a.kind === 'special') continue;
    assert.equal(a ? a.points : null, b, `tiles ${tiles}`);
    if (a && a.candidateCount > 1) multi++;
  }
  assert.ok(multi > 0, '複数分割のケースも含まれている');
});
