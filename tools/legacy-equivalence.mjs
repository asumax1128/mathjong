// 旧ルール（newRules なし）の同値性の確認：指定したチェックアウトのエンジンで、同じ seed・同じ AI（3難易度×3性格・12人）を
// 数学Ⅰ・Ⅱで最後まで打ち、AI の全行動・全イベント・結果・公開ビューのハッシュを出す。main と比べて一致すれば旧ルールは不変。
// 使い方：node tools/legacy-equivalence.mjs <チェックアウトのパス>（既定：このリポジトリ）
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const ROOT = pathToFileURL(resolve(process.argv[2] || new URL('..', import.meta.url).pathname)).href;
const { makeConfig } = await import(ROOT + '/src/engine/config.js');
const { createRules } = await import(ROOT + '/src/engine/rules.js');
const { Game } = await import(ROOT + '/src/engine/game.js');
const { decide, applyAction } = await import(ROOT + '/src/engine/ai.js');
const { decideCharacter, CHARACTER_ROSTER, newPublicHistory } = await import(ROOT + '/src/engine/characters.js');
const { createRng } = await import(ROOT + '/src/engine/rng.js');
const ids = Object.values(CHARACTER_ROSTER).flat().map((c) => c.id);
const h = createHash('sha256');
let games = 0, events = 0, ankanKeys = 0;
for (const mode of ['math1', 'math2']) {
  const rules = createRules(makeConfig({ mode }));
  for (let seed = 1; seed <= 150; seed++) {
    const players = [0, 1, 2, 3].map((s) => ({ name: 'P' + s, kind: 'ai', personality: 'speed' }));
    const g = new Game({ rules, seed, dealer: seed % 4, players });
    const rng = createRng(seed * 31 + 7);
    const seats = [0, 1, 2, 3].map((s) => (seed % 3 === 0 ? ids[(seed + s * 5) % 12] : `L:${['beginner', 'intermediate', 'advanced'][(seed + s) % 3]}:${['speed', 'value', 'closed'][(seed + 2 * s) % 3]}`));
    const info = { scores: [100, 100, 100, 100], hand: 0, length: 4, dealer: seed % 4, renchan: 0, publicHistory: newPublicHistory() };
    while (g.pending()) {
      const p = g.pending();
      if ('ankan' in p) ankanKeys++;
      const id = seats[p.seat];
      const a = id.startsWith('L:') ? decide(g, p.seat, id.split(':')[2], rng, id.split(':')[1], info) : decideCharacter(g, p.seat, id, rng, info, seats.slice(1));
      h.update(JSON.stringify(a));
      applyAction(g, p.seat, a);
    }
    h.update(JSON.stringify(g.events)); h.update(JSON.stringify(g.result)); h.update(JSON.stringify(g.viewFor(0)));
    games++; events += g.events.length;
  }
}
console.log(JSON.stringify({ games, events, ankanKeys, sha256: h.digest('hex') }));
