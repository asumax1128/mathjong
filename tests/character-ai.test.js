import test from 'node:test';
import assert from 'node:assert/strict';
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { applyAction } from '../src/engine/ai.js';
import { createRng } from '../src/engine/rng.js';
import { createMatch } from '../src/engine/match.js';
import { CHARACTER_ROSTER, rosterForLevel, decideCharacter } from '../src/engine/character-ai.js';

test('character roster contains 9 unique names and correct ages', () => {
  assert.deepEqual(Object.keys(CHARACTER_ROSTER), ['beginner', 'intermediate', 'advanced']);
  const all = Object.values(CHARACTER_ROSTER).flat();
  assert.equal(all.length, 9);
  assert.equal(new Set(all.map((x) => x.id)).size, 9);
  assert.deepEqual(all.map((x) => x.name), ['かなた','みつき','あおと','おうすけ','なつき','ゆき','ふくやま','かおる','アスマ']);
  assert.deepEqual(all.map((x) => x.age), [10,8,9,17,20,18,28,27,28]);
  assert.equal(rosterForLevel('advanced')[2].name, 'アスマ');
});

function playOne(mode, level, seed) {
  const roster = rosterForLevel(level);
  const chars = [{ id:'human-test', name:'あなた', personality:'speed' }, ...roster];
  const rules = createRules(makeConfig({ mode }));
  const m = createMatch({ length: 4 });
  const g = new Game({ rules, seed, dealer: 0,
    players: chars.map((c) => ({ name:c.name, kind:'ai', personality:c.personality })) });
  const rng = createRng(seed ^ 0x5bd1e995);
  const events = [];
  let n = 0;
  while (g.pending()) {
    const p = g.pending();
    const a = p.seat === 0
      ? { type: p.type === 'turn' ? (p.canTsumo ? 'tsumo' : 'discard') : p.ron ? 'ron' : 'pass',
        ...(p.type === 'turn' && !p.canTsumo ? { tile: g.viewFor(0).hand[0].id } : {}) }
      : decideCharacter(g, p.seat, chars[p.seat].id, rng,
        { scores:m.scores, dealer:0, hand:0, length:4, renchan:0 },
        chars.map((c) => c.id));
    if (a.type === 'discard') assert.ok(g.viewFor(p.seat).hand.some((h) => h.id === a.tile));
    applyAction(g, p.seat, a);
    if (++n > 2000) throw Error('no progress');
  }
  g.checkInvariants();
  assert.ok(g.result);
  return { result:g.result.type, events:g.events.map((e) => [e.type,e.seat,e.tile,e.meld]) };
}

for (const mode of ['math1','math2']) {
  for (const level of ['beginner','intermediate','advanced']) {
    test(mode + ' ' + level + ' candidate actions legal, complete, replay stable', () => {
      const a = playOne(mode,level,333399);
      const b = playOne(mode,level,333399);
      assert.deepEqual(a,b);
    });
  }
}

test('unknown character is rejected', () => {
  assert.throws(() => decideCharacter({},0,'nobody',createRng(1)), /unknown character/);
});
