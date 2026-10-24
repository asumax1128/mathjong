import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trigExact, toNumber, quadrantOf } from '../src/engine/exact.js';
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { rules, idx, meld } from './helpers.js';

// docs/02-tiles-and-values.md の値表をそのまま書き写したもの（正とする表）
const DOC_TABLE = `
0|0|1|0
30|1/2|√3/2|1/√3
45|1/√2|1/√2|1
60|√3/2|1/2|√3
90|1|0|定義なし
120|√3/2|−1/2|−√3
135|1/√2|−1/√2|−1
150|1/2|−√3/2|−1/√3
180|0|−1|0
210|−1/2|−√3/2|1/√3
225|−1/√2|−1/√2|1
240|−√3/2|−1/2|√3
270|−1|0|定義なし
300|−√3/2|1/2|−√3
315|−1/√2|1/√2|−1
330|−1/2|√3/2|−1/√3
360|0|1|0`;

const docRows = DOC_TABLE.trim().split('\n').map((l) => l.split('|'));
const docKey = (s) => s.replace('−', '-');

// 表記文字列から数値を求める独立パーサー（検算用）
function parseNumeric(s) {
  s = docKey(s);
  const sign = s.startsWith('-') ? -1 : 1;
  s = s.replace('-', '');
  const term = (x) => (x.startsWith('√') ? Math.sqrt(Number(x.slice(1))) : Number(x));
  const [n, d] = s.split('/');
  return sign * term(n) / (d ? term(d) : 1);
}

test('値表：エンジンの厳密値が docs/02 の表と一致し、Math.sin 等の数値とも一致する', () => {
  const fns = ['sin', 'cos', 'tan'];
  for (const [deg, ...vals] of docRows) {
    fns.forEach((fn, i) => {
      const ex = trigExact(fn, Number(deg));
      if (vals[i] === '定義なし') {
        assert.equal(ex, null, `${fn}${deg} should be undefined`);
        return;
      }
      const m = rules.meldOf(idx(fn), idx(deg), idx('=' + docKey(vals[i])));
      assert.ok(m, `${fn}${deg}=${vals[i]} should be a meld`);
      const rad = (Number(deg) * Math.PI) / 180;
      const num = { sin: Math.sin, cos: Math.cos, tan: Math.tan }[fn](rad);
      assert.ok(Math.abs(toNumber(ex) - num) < 1e-9, `${fn}${deg} numeric`);
      assert.ok(Math.abs(parseNumeric(vals[i]) - num) < 1e-9, `doc ${fn}${deg} numeric`);
    });
  }
});

test('結果牌の厳密値は表記と数値的に一致する（1/√2 = √2/2 等の正規化）', () => {
  for (const t of rules.types.filter((x) => x.kind === 'value')) {
    assert.ok(Math.abs(toNumber(t.exact) - parseNumeric(t.value)) < 1e-12, t.value);
  }
  assert.equal(rules.types.filter((x) => x.kind === 'value').length, 13);
});

test('有効な面子は49種類（360°なしなら46種類）、tan90°・tan270°は存在しない', () => {
  assert.equal(rules.melds.length, 49);
  assert.ok(!rules.melds.some((m) => m.fn === 'tan' && (m.deg === 90 || m.deg === 270)));
  const no360 = createRules(makeConfig({ disableAngles: [360] }));
  assert.equal(no360.melds.length, 46);
  assert.equal(no360.deckSize, 164);
});

test('牌構成：168枚、関数各16・角度17種各4・結果13種各4', () => {
  assert.equal(rules.deckSize, 168);
  const by = (kind) => rules.types.filter((t) => t.kind === kind);
  assert.deepEqual(by('func').map((t) => t.copies), [16, 16, 16]);
  assert.equal(by('angle').length, 17);
  assert.ok(by('angle').every((t) => t.copies === 4));
  assert.ok(by('value').every((t) => t.copies === 4));
});

test('正しい面子と不正な面子', () => {
  assert.ok(meld('sin', 30, '=1/2'));
  assert.ok(meld('cos', 60, '=1/2'));
  assert.ok(meld('tan', 225, '=1'));
  assert.ok(meld('cos', 135, '=-1/√2'));
  assert.equal(meld('sin', 30, '=√3/2'), null);
  assert.equal(meld('tan', 90, '=0'), null);
  assert.equal(meld('tan', 270, '=0'), null);
  assert.equal(meld('sin', 210, '=1/2'), null, '符号違い');
  assert.equal(meld('cos', 120, '=1/2'), null, '符号違い');
  // 牌の並び順は関係ない
  assert.equal(rules.meldOf(idx('=1/2'), idx('30'), idx('sin')).key, 'sin30=1/2');
});

test('象限の分類（軸上の角度は象限に含めない）', () => {
  assert.deepEqual([0, 30, 90, 120, 180, 225, 270, 330, 360].map(quadrantOf), [0, 1, 0, 2, 0, 3, 0, 4, 0]);
});
