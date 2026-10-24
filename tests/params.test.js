// URL パラメータ・保存値の検証（src/ui/params.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpeed, speedDelays, intParam, isLocalHost, publicSpeedNames } from '../src/ui/params.js';

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
