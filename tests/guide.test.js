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

// ---- 監査 P3-1：条件文の角度表記をモードに合わせる（数学Ⅰ・旧規則は度数法、数学Ⅱは弧度法） ----
import { guideCondition, angleLabel } from '../src/ui/guide.js';

const condOf = (cfg, id) => {
  const r = createRules(cfg);
  return guideCondition(YAKU_GUIDE[id].condition, { unit: cfg.angleUnit, degs: r.types.filter((t) => t.kind === 'angle').map((t) => t.deg) });
};

test('P3-1：角度の表記（度数法・弧度法）', () => {
  assert.deepEqual([0, 30, 45, 60, 90, 180, 270, 360].map((d) => angleLabel(d, 'rad')), ['0', 'π/6', 'π/4', 'π/3', 'π/2', 'π', '3π/2', '2π']);
  assert.deepEqual([0, 30, 90, 180].map((d) => angleLabel(d, 'deg')), ['0°', '30°', '90°', '180°']);
});

test('P3-1：数学Ⅱの条件文は弧度法（度数法が残らない）、数学Ⅰ・旧規則は度数法（π が出ない）', () => {
  for (const [label, cfg] of CONFIGS) {
    for (const y of [...cfg.yaku, ...cfg.specialHands].filter((x) => x.enabled)) {
      const text = condOf(cfg, y.id);
      assert.ok(!/[{}]/.test(text), `${label} ${y.name}: 置換漏れ ${text}`);
      if (cfg.angleUnit === 'rad') assert.ok(!/°/.test(text), `${label} ${y.name}: 度数法が残る ${text}`);
      else assert.ok(!/π/.test(text), `${label} ${y.name}: 弧度法が混ざる ${text}`);
    }
  }
  const m1 = makeConfig({ mode: 'math1' });
  const m2 = makeConfig({ mode: 'math2' });
  assert.match(condOf(m2, 'yokaku'), /sin θ と cos\(π\/2−θ\) の2組を含む（0≦θ≦π\/2）/);
  assert.match(condOf(m1, 'yokaku'), /sin θ と cos\(90°−θ\) の2組を含む（0°≦θ≦90°）/);
  // docs/65：象限一色（統合）。モードにある象限だけを列挙
  assert.match(condOf(m2, 'shougen'), /第1象限（π\/6・π\/4・π\/3）／第2象限（2π\/3・3π\/4・5π\/6）／第3象限（7π\/6・5π\/4・4π\/3）／第4象限（5π\/3・7π\/4・11π\/6）/);
  assert.match(condOf(m1, 'shougen'), /第1象限（30°・45°・60°）／第2象限（120°・135°・150°）。/);
  assert.match(condOf(m1, 'shougen'), /軸上の角度（0°・90°・180°）を含むと不可/);
  assert.match(condOf(m2, 'shougen'), /軸上の角度（0・π\/2・π・3π\/2・2π）を含むと不可/);
  assert.match(condOf(m2, 'sanshougen'), /（0・π\/2・π・3π\/2・2π を含まない）/);
  assert.match(condOf(m2, 'doukaku'), /（π\/2・3π\/2 は tan がないので不可）/);
  assert.match(condOf(m1, 'doukaku'), /（90° は tan がないので不可）/, '数学Ⅰに 270° はない');
  assert.match(condOf(m2, 'kyukaku'), /0・π\/6・π\/4・π\/3・π\/2・2π\/3・3π\/4・5π\/6・π を1枚ずつ/);
  assert.match(condOf(m1, 'kyukaku'), /0°・30°・45°・60°・90°・120°・135°・150°・180° を1枚ずつ/);
});
