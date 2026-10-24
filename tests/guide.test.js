// 役ガイド（src/ui/guide.js）の数式例が、既存の役判定で実際に成立することを確認
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRules } from '../src/engine/rules.js';
import { DEFAULT_CONFIG, makeConfig } from '../src/engine/config.js';
import { YAKU_GUIDE } from '../src/ui/guide.js';

const rules = createRules(DEFAULT_CONFIG);
const meldByKey = new Map(rules.melds.map((m) => [m.key, m]));

test('有効な役・特殊和了すべてにガイド（条件・数式例）がある', () => {
  for (const y of [...DEFAULT_CONFIG.yaku, ...DEFAULT_CONFIG.specialHands]) {
    const g = YAKU_GUIDE[y.id];
    assert.ok(g, `${y.name} のガイドがない`);
    assert.ok(g.condition && g.condition.length > 5, `${y.name} の条件`);
    assert.ok(g.example || g.exampleAngles, `${y.name} の数式例`);
  }
});

test('通常役・役満の数式例：既存の判定でその役が成立し、手牌として和了できる', () => {
  for (const y of DEFAULT_CONFIG.yaku) {
    const ex = YAKU_GUIDE[y.id].example.map((k) => {
      const m = meldByKey.get(k);
      assert.ok(m, `${y.name}: 面子 ${k} が存在しない（数学的に不正）`);
      return m;
    });
    assert.equal(ex.length, 3);
    const ev = rules.evaluateMelds(ex.map((m) => m.idx), true);
    assert.ok(ev.yaku.some((z) => z.id === y.id), `${y.name}: 数式例で役が成立しない（${ev.yaku.map((z) => z.name)}）`);
    const counts = rules.countsOf(ex.flatMap((m) => m.tiles));
    assert.ok(counts.every((c, t) => c <= rules.types[t].copies), `${y.name}: 牌の枚数を超える`);
    assert.ok(rules.analyzeWin(counts), `${y.name}: 和了形にならない`);
  }
});

test('特殊和了の例：九角無双は成立、裏九角無双は有効化した設定でのみ成立', () => {
  const k = YAKU_GUIDE.kyukaku.exampleAngles.map((d) => rules.typeByKey.get(`a:${d}`).idx);
  assert.equal(rules.analyzeWin(rules.countsOf(k)).yaku[0].id, 'kyukaku');
  const on = createRules(makeConfig({ enableSpecial: ['urakyukaku'] }));
  const u = YAKU_GUIDE.urakyukaku.exampleAngles.map((d) => on.typeByKey.get(`a:${d}`).idx);
  assert.equal(on.analyzeWin(on.countsOf(u)).yaku[0].id, 'urakyukaku');
  assert.equal(rules.analyzeWin(rules.countsOf(u.map((i) => i))), null);
});
