// URL パラメータ・保存値の検証（src/ui/params.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpeed, speedDelays, intParam, isLocalHost, publicSpeedNames, MAX_SEED, MAX_ROUND, MAX_RENCHAN } from '../src/ui/params.js';

const BAD = ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', 'unknown', '', ' fast', 'FAST', 'test '];

test('公開サイトで許可する speed は fast / normal / slow のみ', () => {
  assert.deepEqual(publicSpeedNames(), ['fast', 'normal', 'slow']);
  for (const s of ['fast', 'normal', 'slow']) assert.equal(resolveSpeed(s, null, false), s);
});

test('Object.prototype 由来の名前・未知の値・空文字列は既定値（normal）に戻る', () => {
  for (const isLocal of [false, true]) {
    for (const q of [...BAD, null, undefined]) {
      assert.equal(resolveSpeed(q, null, isLocal), 'normal', `query ${JSON.stringify(q)}`);
      const d = speedDelays(resolveSpeed(q, null, isLocal), isLocal);
      assert.ok(Array.isArray(d) && d.length === 2 && d.every(Number.isFinite), 'delays are numbers');
    }
  }
});

test('localStorage の保存値も検証する（不正値は無視、test は保存値として不可）', () => {
  for (const saved of [...BAD, 'test', null]) assert.equal(resolveSpeed(null, saved, true), 'normal', `saved ${saved}`);
  assert.equal(resolveSpeed(null, 'slow', false), 'slow');
  // URL の正しい値は保存値より優先、URL が不正なら保存値
  assert.equal(resolveSpeed('fast', 'slow', false), 'fast');
  assert.equal(resolveSpeed('constructor', 'slow', false), 'slow');
});

test('test 速度はローカル環境の URL 指定でのみ有効', () => {
  assert.equal(resolveSpeed('test', null, false), 'normal');
  assert.equal(resolveSpeed('test', null, true), 'test');
  assert.deepEqual(speedDelays('test', true), [0, 0]);
  assert.deepEqual(speedDelays('test', false), speedDelays('normal', false));
  for (const name of BAD) assert.deepEqual(speedDelays(name, true), speedDelays('normal', true));
});

test('ローカル判定は localhost / 127.0.0.1 / [::1] のみ', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]']) assert.ok(isLocalHost(h));
  for (const h of ['asumax1128.github.io', 'mathjong.test', '127.0.0.2', '192.168.1.5', '', 'localhost.evil.example']) assert.ok(!isLocalHost(h), h);
});

test('seed / round の整数パラメータ', () => {
  assert.equal(intParam('0', 999999999), 0);
  assert.equal(intParam('123', 999999999), 123);
  assert.equal(intParam('999999999', 999999999), 999999999);
  assert.equal(intParam('3', 999), 3);
  for (const v of ['1000', '-1', '1.5', 'abc', '', '1e3', ' 1', '0x10', '1234567890', null, undefined, 'constructor']) {
    assert.equal(intParam(v, 999), null, `${v}`);
  }
});

// ---- 監査 P2-2：再現 URL の範囲（出力する値と読み取る値を同じ定数にそろえる） ----
test('再現 URL の範囲：連荘99→100・局番号999→1000・上限まで受け付け、上限を超える値・不正な値は拒否', () => {
  assert.equal(MAX_RENCHAN, MAX_ROUND - 1, '連荘回数は通し局数より小さい');
  for (const v of [99, 100, 101, 999, 1000, 1001, 12345, MAX_ROUND]) assert.equal(intParam(String(v), MAX_ROUND), v, `round ${v}`);
  for (const v of [99, 100, 101, 5000, MAX_RENCHAN]) assert.equal(intParam(String(v), MAX_RENCHAN), v, `renchan ${v}`);
  assert.equal(intParam(String(MAX_ROUND + 1), MAX_ROUND), null);
  assert.equal(intParam(String(MAX_RENCHAN + 1), MAX_RENCHAN), null);
  for (const bad of ['-1', '1.5', '1e3', '0x10', ' 5', '5 ', '', 'abc', '१२', '1000000000000', '99999999999999999999', 'Infinity', 'NaN', '+5', null, undefined]) {
    assert.equal(intParam(bad, MAX_ROUND), null, `不正な値 ${JSON.stringify(bad)}`);
  }
  assert.equal(intParam('007', MAX_ROUND), 7, '先頭の0は数値として読む（従来どおり）');
});

test('山の seed（seedBase + round × 7919）は上限でも JavaScript の安全な整数の範囲内で、局ごとに異なる', () => {
  const max = MAX_SEED + MAX_ROUND * 7919;
  assert.ok(Number.isSafeInteger(max) && max < 2 ** 53);
  const seen = new Set();
  for (const r of [1, 2, 99, 100, 999, 1000, 1001, 5000, MAX_ROUND]) seen.add(MAX_SEED + r * 7919);
  assert.equal(seen.size, 9);
});
