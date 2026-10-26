// 上級 AI の判断の要約（Ver.0.5-A の P2 修正の回帰用）。モジュールの置き場所（dir）を指定して、旧版（Ver.0.4-B の main cd37c62）と
// 現在のコードを同じ入力・同じ RNG 状態で比べられる。各局面で上級・中級・初級の判断を記録して SHA-256 にまとめる。
// 使い方：node tests/ai-advanced-digest.mjs [dir]（dir 省略時は現在のコード。リーチ無効 / 有効の両方を表示）
import { createHash } from 'node:crypto';

const LINEUP = ['speed', 'value', 'closed', 'speed'];

// riichi: undefined = 設定を変えない（旧版にはこの設定がない）、false = 無効、true = 有効
export async function advancedDigest(dir, { riichi, seeds = 8, steps = 70 } = {}) {
  const m = { rules: await import(dir + 'rules.js'), cfg: await import(dir + 'config.js'), game: await import(dir + 'game.js'), ai: await import(dir + 'ai.js'), rng: await import(dir + 'rng.js') };
  const out = {};
  for (const mode of ['math1', 'math2']) {
    const rules = m.rules.createRules(m.cfg.makeConfig(riichi === undefined ? { mode } : { mode, rules: { riichi } }));
    const rec = [];
    for (let s = 1; s <= seeds; s++) {
      const g = new m.game.Game({ rules, seed: s, dealer: s % 4, players: LINEUP.map((p) => ({ kind: 'ai', personality: p })) });
      const rng = m.rng.createRng(s ^ 0x5bd1e995);
      for (let i = 0; i < steps && g.pending(); i++) {
        const p = g.pending();
        // 局面は中級 AI で進める。各局面で、いま判断する席の上級・中級・初級の判断を、別々の固定 RNG で記録する
        for (const [lv, rs] of [['advanced', 91], ['advanced', 7], ['intermediate', 91], ['beginner', 91]]) {
          rec.push(JSON.stringify(m.ai.decide(g, p.seat, LINEUP[p.seat], m.rng.createRng(rs), lv, null)));
        }
        m.ai.applyAction(g, p.seat, m.ai.decide(g, p.seat, LINEUP[p.seat], rng, 'intermediate'));
      }
    }
    out[mode] = { n: rec.length, sha: createHash('sha256').update(rec.join('\n')).digest('hex').slice(0, 24) };
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (dir) console.log(JSON.stringify(await advancedDigest(dir, {})));
  else {
    const here = new URL('../src/engine/', import.meta.url).pathname;
    console.log('riichi無効', JSON.stringify(await advancedDigest(here, { riichi: false })));
    console.log('riichi有効', JSON.stringify(await advancedDigest(here, { riichi: true })));
  }
}
