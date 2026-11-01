// 牌譜（src/engine/paifu.js・docs/74）：通常対局の記録 → 記録された選択による再現・検証（数学Ⅰ・Ⅱ × 1/4/8局戦）、
// 400点保存・供託・リーチ・ロン・ツモ・鳴き・自動パス・自動ツモ切り・途中退出、改ざん・取り違えの拒否、JSON の往復と上限。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine/game.js';
import { applyAction } from '../src/engine/ai.js';
import { createMatch, RIICHI_DEPOSIT, potTotal } from '../src/engine/match.js';
import {
  createPaifu, beginRound, appendStep, settleRound, endRecording, verifyPaifu, replayPaifuRound, encodePaifu, decodePaifu,
  stateDigest, newRoundGame, paifuRules, PaifuError, PAIFU_SCHEMA_VERSION, ROUND_SEED_STEP, PAIFU_MAX_BYTES,
} from '../src/engine/paifu.js';
import { playRecorded, PLAYERS } from './paifu-harness.mjs';

const mutable = (p) => JSON.parse(JSON.stringify(p));
const rejects = (p, re) => assert.throws(() => verifyPaifu(p), (e) => e instanceof PaifuError && (!re || re.test(e.message)), String(re));

for (const mode of ['math1', 'math2']) for (const length of [1, 4, 8]) {
  test(`${mode}・${length}局戦：記録した試合を、記録された選択だけで再現できる（各手の状態・結果・精算・400点・終了時の供託0）`, () => {
    const { record, match, counts } = playRecorded({ mode, length, seedBase: 4000 + length * 13 + (mode === 'math2' ? 7 : 0) });
    assert.equal(record.status, 'complete');
    assert.equal(record.schemaVersion, PAIFU_SCHEMA_VERSION);
    const v = verifyPaifu(record);
    assert.equal(v.rounds, match.played);
    assert.deepEqual(record.final.scores, match.scores);
    assert.equal(record.final.scores.reduce((a, b) => a + b, 0), 400);
    assert.equal(potTotal(record.rounds.at(-1).settlement.matchAfter), 0, '終了時の供託0');
    for (const r of record.rounds) {
      const m = r.settlement.matchAfter;
      assert.equal(m.scores.reduce((a, b) => a + b, 0) + potTotal(m), 400, '各局の後も持ち点＋供託＝400');
    }
    if (length === 1) assert.equal(record.rounds.length, 1);
    // 局ごとの再現：最後の手まで進めた Game の要約は、記録の最後の要約と同じ。途中の手（0手目＝配牌直後）も再現できる
    for (let i = 0; i < record.rounds.length; i++) {
      const r = record.rounds[i];
      const g = replayPaifuRound(record, i);
      assert.equal(stateDigest(g), r.steps.at(-1).digest);
      assert.equal(stateDigest(replayPaifuRound(record, i, 0)), r.startDigest);
      assert.ok(!g.pending() && g.phase === 'ended');
    }
    // JSON の往復（正規化）で同じ記録・同じ検証結果
    const json = encodePaifu(record);
    assert.deepEqual(decodePaifu(json), JSON.parse(json));
    assert.equal(encodePaifu(decodePaifu(json)), json);
    if (length >= 4) assert.ok(counts.ai > 0 && counts.human > 0);
  });
}

test('出どころ：人間の手動・チー／ポンの自動パス・リーチ後の自動ツモ切り・AI。リーチ・ロン・ツモ・チー・ポン・暗カンを含む', () => {
  const total = { human: 0, 'auto-pass': 0, 'auto-tsumogiri': 0, ai: 0, riichi: 0, chi: 0, pon: 0, ron: 0, tsumo: 0, ankan: 0 };
  for (const [mode, length, seedBase] of [['math1', 8, 1008], ['math2', 8, 2008], ['math1', 4, 3004], ['math2', 4, 5004]]) {
    const { record, counts } = playRecorded({ mode, length, seedBase });
    verifyPaifu(record);
    for (const k of Object.keys(total)) total[k] += counts[k];
    const sources = new Set(record.rounds.flatMap((r) => r.steps.map((s) => s.source)));
    for (const s of sources) assert.ok(['human', 'auto-pass', 'auto-tsumogiri', 'ai'].includes(s));
  }
  for (const k of Object.keys(total)) if (k !== 'ankan' && k !== 'pon') assert.ok(total[k] > 0, `${k} ${total[k]}`);
  assert.ok(total.pon + total.ankan > 0, 'ポンか暗カンを含む');
});

test('途中退出：未精算の局を残したまま中断として検証できる（精算・流局を作らない）。退出後は記録できない', () => {
  const { record } = playRecorded({ mode: 'math2', length: 4, seedBase: 777, stopAfterSteps: 150 });
  assert.equal(record.status, 'aborted');
  assert.deepEqual(record.termination, { reason: 'left-match' });
  assert.equal(record.final, null);
  assert.equal(record.rounds.at(-1).settlement, null);
  const v = verifyPaifu(record);
  assert.equal(v.status, 'aborted');
  assert.throws(() => endRecording(record, 'left-match'), /not recording/);
  // 配牌直後に退出（行動0）も検証できる
  const m = createMatch({ length: 1, riichiDeposit: RIICHI_DEPOSIT, agariYame: true });
  let p = createPaifu({ id: 'x', createdAt: '2026-11-01T00:00:00.000Z', appVersion: '0.7.0', mode: 'math1', length: 1, seedBase: 9, players: PLAYERS, match: m });
  p = beginRound(p, newRoundGame(p, 1, 0));
  verifyPaifu(endRecording(p, 'reset'));
});

test('記録しない局：テスト用の山（presetWall）・seed／親／局番号が標準でない・配牌直後でない', () => {
  const m = createMatch({ length: 4, riichiDeposit: RIICHI_DEPOSIT, agariYame: true });
  const p = createPaifu({ id: 'x', createdAt: '2026-11-01T00:00:00.000Z', appVersion: '0.7.0', mode: 'math1', length: 4, seedBase: 100, players: PLAYERS, match: m });
  const R = paifuRules('math1');
  const keys = R.types.flatMap((t) => Array(t.copies).fill(t.key)).reverse();
  assert.throws(() => beginRound(p, new Game({ rules: R, seed: 100 + ROUND_SEED_STEP, dealer: 0, players: PLAYERS, round: 1, ruleset: 2, presetWall: keys })), /round.setup/);
  assert.throws(() => beginRound(p, new Game({ rules: R, seed: 101, dealer: 0, players: PLAYERS, round: 1, ruleset: 2 })), /round.setup/);
  assert.throws(() => beginRound(p, new Game({ rules: R, seed: 100 + ROUND_SEED_STEP, dealer: 1, players: PLAYERS, round: 1, ruleset: 2 })), /round.setup/);
  assert.throws(() => beginRound(p, new Game({ rules: R, seed: 100 + ROUND_SEED_STEP, dealer: 0, players: PLAYERS, round: 1, ruleset: 1 })), /round.setup/);
  const g = newRoundGame(p, 1, 0);
  g.discard(0, g.drawn);
  assert.throws(() => beginRound(p, g), /round.setup/);
  // 記録していない状態の変更（行動の直前の events の数が合わない）
  const g2 = newRoundGame(p, 1, 0);
  const q = beginRound(p, g2);
  g2.discard(0, g2.drawn);
  assert.throws(() => appendStep(q, g2, { seat: 0, action: { type: 'discard', tile: 1 }, source: 'human', eventsBefore: 5 }), /unrecorded/);
  // 出どころの取り違え
  const g3 = newRoundGame(p, 1, 0), q3 = beginRound(p, g3), e0 = g3.events.length, t = g3.drawn;
  g3.discard(0, t);
  assert.throws(() => appendStep(q3, g3, { seat: 0, action: { type: 'discard', tile: t }, source: 'ai', eventsBefore: e0 }), /source/);
  assert.throws(() => appendStep(q3, g3, { seat: 0, action: { type: 'discard', tile: t }, source: 'auto-pass', eventsBefore: e0 }), /source/);
  appendStep(q3, g3, { seat: 0, action: { type: 'discard', tile: t, riichi: false }, source: 'human', eventsBefore: e0 });
});

test('対象外の試合：過去のルール・卒業試験用の設定（宣言料なし）・旧規則のモード・終わった試合からは作らない', () => {
  const base = { id: 'x', createdAt: '2026-11-01T00:00:00.000Z', appVersion: '0.7.0', mode: 'math1', length: 4, seedBase: 1, players: PLAYERS };
  assert.throws(() => createPaifu({ ...base, match: createMatch({ length: 4 }) }), /current rules/);
  assert.throws(() => createPaifu({ ...base, mode: 'legacy', match: createMatch({ length: 4, riichiDeposit: 5, agariYame: true }) }), /mode/);
  assert.throws(() => createPaifu({ ...base, length: 1, match: createMatch({ length: 4, riichiDeposit: 5, agariYame: true }) }), /new match/);
  assert.throws(() => createPaifu({ ...base, createdAt: 'yesterday', match: createMatch({ length: 4, riichiDeposit: 5, agariYame: true }) }), /createdAt/);
  assert.throws(() => createPaifu({ ...base, players: PLAYERS.map((x, i) => (i ? x : { ...x, kind: 'ai' })), match: createMatch({ length: 4, riichiDeposit: 5, agariYame: true }) }), /kind/);
});

test('改ざん・取り違えの拒否：行動・席・出どころ・要約・seed・精算・持ち点（400点）・状態・終了・形式・版・未知のキー', () => {
  const { record } = playRecorded({ mode: 'math1', length: 4, seedBase: 6060 });
  verifyPaifu(record);
  const step = record.rounds[0].steps.findIndex((s) => s.action.type === 'discard' && s.seat === 0);
  const cases = [
    ['action', (p) => { const s = p.rounds[0].steps[step]; s.action.tile = s.action.tile === 0 ? 1 : 0; }, /steps|action/],
    ['seat', (p) => { p.rounds[0].steps[step].seat = 1; }, /steps/],
    ['source', (p) => { p.rounds[0].steps[step].source = 'ai'; }, /source/],
    ['digest', (p) => { p.rounds[0].steps[3].digest = '0000000000000000'; }, /digest/],
    ['steps removed', (p) => { p.rounds[0].steps.splice(2, 1); }, /steps/],
    ['seed', (p) => { p.rounds[0].seed += 1; }, /seed/],
    ['seedBase', (p) => { p.settings.seedBase += 1; }, /seed/],
    ['startDigest', (p) => { p.rounds[0].startDigest = 'ffffffffffffffff'; }, /startDigest/],
    ['matchAfter', (p) => { p.rounds[0].settlement.matchAfter.scores[0] += 1; p.rounds[0].settlement.matchAfter.scores[1] -= 1; }, /matchAfter/],
    ['400', (p) => { p.initialMatch.scores[0] = 101; }, /400|initialMatch/],
    ['deltas', (p) => { p.rounds[0].settlement.deltas[0] += 1; }, /deltas/],
    ['result', (p) => { p.rounds[0].result = { type: 'draw', reason: null }; }, /result/],
    ['final', (p) => { p.final.ranks = [1, 1, 1, 1]; }, /final/],
    ['status', (p) => { p.status = 'aborted'; p.termination = { reason: 'left-match' }; }, /status/],
    ['format', (p) => { p.format = 'other'; }, /schemaVersion/],
    ['schema', (p) => { p.schemaVersion = 1; }, /schemaVersion/],
    ['ruleset', (p) => { p.settings.ruleset = 1; }, /ruleset/],
    ['unknown key', (p) => { p.extra = 1; }, /keys/],
    ['round order', (p) => { [p.rounds[0], p.rounds[1]] = [p.rounds[1], p.rounds[0]]; }, /round|matchBefore/],
  ];
  for (const [name, mutate, re] of cases) {
    const p = mutable(record);
    mutate(p);
    rejects(p, re);
    assert.ok(name);
  }
});

test('JSON：不正な JSON・危険なキー・数値以外・上限を超える大きさは読まない', () => {
  const { record } = playRecorded({ mode: 'math2', length: 1, seedBase: 31 });
  const json = encodePaifu(record);
  assert.throws(() => decodePaifu('{'), /invalid JSON/);
  assert.throws(() => decodePaifu(json.replace('"format"', '"__proto__":{},"format"')), /unsafe key|keys/);
  assert.throws(() => decodePaifu('x'.repeat(PAIFU_MAX_BYTES + 1)), /byte limit/);
  assert.throws(() => decodePaifu(JSON.stringify({ ...JSON.parse(json), id: 7 })), /id|invalid/);
  assert.throws(() => encodePaifu({ ...record, appVersion: Infinity }), /non-finite|appVersion/);
});

test('ゲームの状態・乱数を変えない：記録と検証の前後で、実際の対局の Game は同じ', () => {
  const m = createMatch({ length: 4, riichiDeposit: RIICHI_DEPOSIT, agariYame: true });
  let p = createPaifu({ id: 'x', createdAt: '2026-11-01T00:00:00.000Z', appVersion: '0.7.0', mode: 'math2', length: 4, seedBase: 55, players: PLAYERS, match: m });
  const g = newRoundGame(p, 1, 0);
  const before = stateDigest(g);
  p = beginRound(p, g);
  assert.equal(stateDigest(g), before);
  const e0 = g.events.length, t = g.drawn;
  applyAction(g, 0, { type: 'discard', tile: t });
  const mid = stateDigest(g);
  p = appendStep(p, g, { seat: 0, action: { type: 'discard', tile: t }, source: 'human', eventsBefore: e0 });
  verifyPaifu(p);
  replayPaifuRound(p, 0, 1);
  assert.equal(stateDigest(g), mid);
  // 記録は不変（凍結）
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.rounds[0].steps[0]));
});
