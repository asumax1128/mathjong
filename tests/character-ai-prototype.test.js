import test from 'node:test';
import assert from 'node:assert/strict';
import { BEGINNER_CHARACTERS, decideBeginnerCharacter } from '../src/engine/character-ai-prototype.js';
import { createRules } from '../src/engine/rules.js';
import { makeConfig } from '../src/engine/config.js';
import { Game } from '../src/engine/game.js';
import { createRng } from '../src/engine/rng.js';
import { applyAction } from '../src/engine/ai.js';

const players = ['kanata', 'mitsuki', 'aoto', 'baseline'].map((name) => ({
  name, kind: 'ai', personality: 'speed',
}));
const fixed = () => new Game({
  rules: createRules(makeConfig({ mode: 'math1' })),
  seed: 61351, dealer: 0, players,
});

test('character catalog: all three beginner characters are distinct', () => {
  assert.deepEqual(Object.keys(BEGINNER_CHARACTERS), ['kanata', 'mitsuki', 'aoto']);
});

test('aoto may choose legal pon, chi, pass without touching game state', () => {
  const rng = { next: () => 0, int: () => 0 };
  const stub = { pending: () => ({
    seat: 3, type: 'claim', ron: false, pon: { meld: 1 }, chi: [{ meld: 2 }],
  }) };
  assert.deepEqual(decideBeginnerCharacter(stub, 3, 'aoto', rng), { type: 'pon' });
  const chiOnly = { pending: () => ({
    seat: 3, type: 'claim', ron: false, pon: null, chi: [{ meld: 2 }],
  }) };
  assert.deepEqual(decideBeginnerCharacter(chiOnly, 3, 'aoto', rng), { type: 'chi', option: 0 });
  const pass = { pending: () => ({
    seat: 3, type: 'claim', ron: false, pon: null, chi: [],
  }) };
  assert.deepEqual(decideBeginnerCharacter(pass, 3, 'aoto', rng), { type: 'pass' });
});

test('legal ron is always taken even for aoto', () => {
  const game = { pending: () => ({ seat: 3, type: 'claim', ron: true, pon: {}, chi: [{}] }) };
  assert.deepEqual(decideBeginnerCharacter(game, 3, 'aoto', {}, {}), { type: 'ron' });
});

test('first candidate action is deterministic with same seed and no hidden state', () => {
  const a = fixed(), b = fixed();
  const r1 = createRng(777), r2 = createRng(777);
  const seatIds = ['kanata', 'mitsuki', 'aoto', 'baseline'];
  const x = decideBeginnerCharacter(a, 0, 'kanata', r1, { seatIds });
  const y = decideBeginnerCharacter(b, 0, 'kanata', r2, { seatIds });
  assert.deepEqual(x, y);
  applyAction(a, 0, x);
  a.checkInvariants();
});

test('beginner candidate cannot inspect game wall in its turn decision', () => {
  const game = fixed();
  // A defensive proxy prevents accidental use of the hidden wall in the prototype.
  const wrapped = new Proxy(game, {
    get(target, name, receiver) {
      if (name === 'wall' || name === 'hands') throw new Error('hidden game data touched');
      return Reflect.get(target, name, receiver);
    },
  });
  // game.waitsOf is a public method; it only computes legal waits from provided public counts.
  const rng = createRng(332211);
  const a = decideBeginnerCharacter(wrapped, 0, 'kanata', rng, {
    seatIds: ['kanata', 'mitsuki', 'aoto', 'baseline'],
  });
  assert.equal(a.type, 'discard');
  assert.ok(game.hands[0].includes(a.tile));
});
