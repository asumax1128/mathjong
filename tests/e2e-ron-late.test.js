// ロン後半の演出の E2E 判定（tests/e2e/ron-late.mjs）の境界。成功は「表示の条件」と「経過時間 ≤ 上限」の両方が必要。
import test from 'node:test';
import assert from 'node:assert/strict';
import { RON_LATE_LIMIT_MS, judgeRonLate, ronLateShown } from './e2e/ron-late.mjs';

const SHOWN = { card: { t: 304, b: 523, op: 0 }, banner: { t: 6, b: 44, op: 1 } };
const HIDDEN = { card: { t: 304, b: 523, op: 0.74 }, banner: { t: -6, b: 32, op: 0.15 } };

test('上限は 2000ms（ロン演出の帯が消え始める 2.02 秒より前）', () => {
  assert.equal(RON_LATE_LIMIT_MS, 2000);
});

test('上限直前・上限ちょうどで表示の条件を満たせば成功', () => {
  for (const elapsed of [1290, 1999, 1999.9, 2000]) assert.equal(judgeRonLate({ elapsed, ...SHOWN }), 'ok', `${elapsed}ms`);
});

test('上限を過ぎた観測は、表示の条件を満たしていても失敗', () => {
  for (const elapsed of [2000.1, 2001, 2100, 5000]) {
    assert.ok(ronLateShown({ elapsed, ...SHOWN }), '表示の条件は満たしている');
    assert.equal(judgeRonLate({ elapsed, ...SHOWN }), 'fail', `${elapsed}ms`);
  }
});

test('上限以内で条件を満たさなければ待つ。上限を過ぎて満たさなければ失敗', () => {
  assert.equal(judgeRonLate({ elapsed: 1209, ...HIDDEN }), 'wait');
  assert.equal(judgeRonLate({ elapsed: 2000, ...HIDDEN }), 'wait');
  assert.equal(judgeRonLate({ elapsed: 2001, ...HIDDEN }), 'fail');
  // 上限を引数で変えても同じ規則（診断の確認に使った 1200ms）
  assert.equal(judgeRonLate({ elapsed: 1209, ...SHOWN }, 1200), 'fail');
  assert.equal(judgeRonLate({ elapsed: 1200, ...SHOWN }, 1200), 'ok');
});

test('表示の条件の境界：中央 < 0.05、帯 > 0.95、帯は上端 0 以上・下端 70px 以下、要素がなければ満たさない', () => {
  const at = (card, banner) => judgeRonLate({ elapsed: 1500, card, banner });
  assert.equal(at({ ...SHOWN.card, op: 0.049 }, SHOWN.banner), 'ok');
  assert.equal(at({ ...SHOWN.card, op: 0.05 }, SHOWN.banner), 'wait');
  assert.equal(at(SHOWN.card, { ...SHOWN.banner, op: 0.951 }), 'ok');
  assert.equal(at(SHOWN.card, { ...SHOWN.banner, op: 0.95 }), 'wait');
  assert.equal(at(SHOWN.card, { ...SHOWN.banner, t: -1 }), 'wait');
  assert.equal(at(SHOWN.card, { ...SHOWN.banner, b: 70 }), 'ok');
  assert.equal(at(SHOWN.card, { ...SHOWN.banner, b: 71 }), 'wait');
  assert.equal(at(null, SHOWN.banner), 'wait');
  assert.equal(at(SHOWN.card, null), 'wait');
  // 経過時間が数でなければ失敗（観測の誤りを合格にしない）
  assert.equal(judgeRonLate({ elapsed: NaN, ...SHOWN }), 'fail');
  assert.equal(judgeRonLate({ ...SHOWN }), 'fail');
});
