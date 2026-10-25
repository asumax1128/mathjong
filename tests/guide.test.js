// 役ガイド（src/ui/guide.js）の数式例が、既存の役判定で実際に成立することを確認
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRules } from '../src/engine/rules.js';
import { DEFAULT_CONFIG, makeConfig } from '../src/engine/config.js';
import { YAKU_GUIDE } from '../src/ui/guide.js';

const rules = createRules(makeConfig({ legacy: true }));
const meldByKey = new Map(rules.melds.map((m) => [m.key, m]));

// Ver.0.2.1 の規則（互換）と Ver.0.3 の数学Ⅰ・Ⅱの3設定すべてで確認する
const CONFIGS = [['旧規則', makeConfig({ legacy: true })], ['数学Ⅰ', makeConfig({ mode: 'math1' })], ['数学Ⅱ', makeConfig({ mode: 'math2' })]];

test('有効な役・特殊和了すべてにガイド（条件・数式例）がある（各モード）', () => {
  for (const [label, cfg] of CONFIGS) {
    for (const y of [...cfg.yaku, ...cfg.specialHands].filter((x) => x.enabled)) {
      const g = YAKU_GUIDE[y.id];
      assert.ok(g, `${label} ${y.name} のガイドがない`);
      assert.ok(g.condition && g.condition.length > 5, `${y.name} の条件`);
      assert.ok(g.example || g.exampleAngles, `${y.name} の数式例`);
    }
  }
});

test('通常役・役満の数式例：そのモードの判定で役が成立し、手牌として和了できる（各モード）', () => {
  for (const [label, cfg] of CONFIGS) {
    const r = createRules(cfg);
    const byKey = new Map(r.melds.map((m) => [m.key, m]));
    for (const y of cfg.yaku.filter((x) => x.enabled)) {
      const g = YAKU_GUIDE[y.id];
      const keys = (g.examples && g.examples[cfg.mode]) || g.example;
      const ex = keys.map((key) => {
        const m = byKey.get(key);
        assert.ok(m, `${label} ${y.name}: 面子 ${key} が存在しない（数学的に不正、またはこのモードに無い角度）`);
        return m;
      });
      assert.equal(ex.length, 3);
      const ev = r.evaluateMelds(ex.map((m) => m.idx), true);
      assert.ok(ev.yaku.some((z) => z.id === y.id), `${label} ${y.name}: 数式例で役が成立しない（${ev.yaku.map((z) => z.name)}）`);
      const counts = r.countsOf(ex.flatMap((m) => m.tiles));
      assert.ok(counts.every((c, t) => c <= r.types[t].copies), `${label} ${y.name}: 牌の枚数を超える`);
      assert.ok(r.analyzeWin(counts), `${label} ${y.name}: 和了形にならない`);
    }
  }
});

test('特殊和了の例：九角無双は成立、裏九角無双は有効化した設定でのみ成立', () => {
  const k = YAKU_GUIDE.kyukaku.exampleAngles.map((d) => rules.typeByKey.get(`a:${d}`).idx);
  assert.equal(rules.analyzeWin(rules.countsOf(k)).yaku[0].id, 'kyukaku');
  const on = createRules(makeConfig({ legacy: true, enableSpecial: ['urakyukaku'] }));
  const u = YAKU_GUIDE.urakyukaku.exampleAngles.map((d) => on.typeByKey.get(`a:${d}`).idx);
  assert.equal(on.analyzeWin(on.countsOf(u)).yaku[0].id, 'urakyukaku');
  assert.equal(rules.analyzeWin(rules.countsOf(u.map((i) => i))), null);
});
