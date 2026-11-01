// 牌譜の自動記録の窓口（src/ui/paifu-recorder.js・docs/74）：app.js と同じ呼び方で試合を進め、偽の保存先で
// 保存の時点・失敗（容量不足・利用不可・競合・結果不明・例外）・途中退出・再戦・記録できない操作・対象外の試合を確かめる。
// ゲームの進行は保存の成否に依存しない（窓口は例外を外へ出さない）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine/game.js';
import { applyAction } from '../src/engine/ai.js';
import { decideCharacter } from '../src/engine/characters.js';
import { createRng } from '../src/engine/rng.js';
import { createMatch, applyRoundResult, dealerOf, RIICHI_DEPOSIT } from '../src/engine/match.js';
import { MAX_ROUND } from '../src/ui/params.js';
import { createPaifuRecorder } from '../src/ui/paifu-recorder.js';
import { verifyPaifu, encodePaifu, paifuRules, ROUND_SEED_STEP, stateDigest } from '../src/engine/paifu.js';
import { PLAYERS } from './paifu-harness.mjs';

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await flush(); };
// 偽の保存先：save の結果を順に返す（既定は成功）。保存された JSON を残す
function fakeStore(results = []) {
  const saved = [];
  const toks = new Map(); // 記録の ID ごとのトークン（本物と同じ）
  let n = 0;
  return {
    saved,
    save: async (p, opts) => {
      const r = results[n++];
      if (r === 'throw') throw new Error('boom');
      if (r && !r.ok) return r;
      assert.equal(opts.evict, true);
      if (opts.expectedToken !== (toks.get(p.id) ?? null)) return { ok: false, error: { code: 'conflict', retryable: false } };
      const json = encodePaifu(p); // 本物と同じく保存の前に検証（選択の再生）
      const tok = (n.toString(16) + 'f'.repeat(32)).slice(0, 32);
      toks.set(p.id, tok);
      saved.push(JSON.parse(json));
      return { ok: true, metadata: { id: p.id, token: tok }, evicted: 0 };
    },
  };
}
// app.js と同じ流れで試合を進める（席0は AI の方針で代わりに打つ）。hooks で途中の操作を差し込む
async function playApp(rec, { mode = 'math1', length = 1, seedBase = 321, exam = false, stopAfter = null, tamper = null } = {}) {
  let match = createMatch({ length, riichiDeposit: RIICHI_DEPOSIT, agariYame: true });
  rec.startMatch({ eligible: !exam, reason: exam ? 'exam' : null, mode, length, seedBase, players: PLAYERS, match });
  const rng = createRng(seedBase);
  const ids = ['yujin', 'aoto', 'kanata', 'mitsuki'];
  let round = 1, steps = 0;
  while (!match.over) {
    const g = new Game({ rules: paifuRules(mode), seed: seedBase + round * ROUND_SEED_STEP, dealer: dealerOf(match), players: PLAYERS, round, ruleset: 2 });
    rec.roundStarted(g, { presetWall: false });
    while (g.pending()) {
      const q = g.pending();
      const a = decideCharacter(g, q.seat, ids[q.seat], rng, null, ids);
      const before = g.events.length;
      applyAction(g, q.seat, a);
      rec.actionApplied(g, q.seat, a, q.seat ? 'ai' : 'human', before);
      steps++;
      if (tamper && steps === tamper.at) tamper.fn(g);
      if (stopAfter !== null && steps >= stopAfter) return { match, g };
    }
    match = applyRoundResult(match, g.result, { round, maxRound: MAX_ROUND, riichi: g.riichi });
    rec.roundSettled(g, match, { maxRound: MAX_ROUND });
    await settle();
    round++;
  }
  await settle();
  return { match };
}

test('通常の試合：局の精算ごとに保存し、最後は完了として保存。保存された記録は検証できる', async () => {
  const store = fakeStore();
  let changes = 0;
  const rec = createPaifuRecorder({ store, appVersion: '0.7.0', onChange: () => changes++ });
  const { match } = await playApp(rec, { mode: 'math2', length: 4, seedBase: 900 });
  const st = rec.status();
  assert.equal(st.state, 'saved');
  assert.equal(st.savedStatus, 'complete');
  assert.equal(st.dirty, false);
  const last = store.saved.at(-1);
  assert.equal(last.status, 'complete');
  assert.deepEqual(last.final.scores, match.scores);
  assert.equal(last.rounds.length, match.played);
  assert.ok(store.saved.length >= 1 && store.saved.length <= match.played, '保存は局の精算のとき（行動ごとには保存しない）');
  verifyPaifu(last);
  assert.ok(changes > 0);
});

test('途中退出（タイトルへ）：中断として保存。精算・流局を作らない。終わった試合で退出しても何もしない', async () => {
  const store = fakeStore();
  const rec = createPaifuRecorder({ store, appVersion: '0.7.0' });
  await playApp(rec, { length: 8, seedBase: 901, stopAfter: 40 });
  rec.leave('left-match');
  await settle();
  const last = store.saved.at(-1);
  assert.equal(last.status, 'aborted');
  assert.deepEqual(last.termination, { reason: 'left-match' });
  assert.equal(last.rounds.at(-1).settlement, null);
  verifyPaifu(last);
  const n = store.saved.length;
  rec.leave('left-match');
  await settle();
  assert.equal(store.saved.length, n, '2回目の退出は何もしない');
});

test('再戦・新しい対局：前の試合が記録中なら「新しい対局」による中断として保存し、新しい記録（別の ID）を始める', async () => {
  const store = fakeStore();
  const rec = createPaifuRecorder({ store, appVersion: '0.7.0' });
  await playApp(rec, { length: 8, seedBase: 902, stopAfter: 40 });
  const id1 = rec.privateRecord().id;
  await playApp(rec, { length: 1, seedBase: 903 });
  const ids = new Set(store.saved.map((x) => x.id));
  assert.equal(ids.size, 2, '2つの記録');
  const first = store.saved.find((x) => x.id === id1 && x.status === 'aborted');
  assert.deepEqual(first.termination, { reason: 'reset' });
  assert.equal(store.saved.at(-1).status, 'complete');
});

test('対象外の試合（卒業試験など）は記録しない（保存しない・状態は off）', async () => {
  const store = fakeStore();
  const rec = createPaifuRecorder({ store, appVersion: '0.7.0' });
  await playApp(rec, { length: 1, seedBase: 904, exam: true });
  assert.equal(store.saved.length, 0);
  assert.deepEqual([rec.status().state, rec.status().reason], ['off', 'exam']);
});

for (const [name, result, state] of [
  ['容量不足', { ok: false, error: { code: 'quota-exceeded', retryable: true } }, 'failed'],
  ['上限（自動削除でも足りない）', { ok: false, error: { code: 'capacity-exceeded', retryable: true } }, 'failed'],
  ['利用不可（プライベートモードなど）', { ok: false, error: { code: 'unavailable', retryable: true } }, 'failed'],
  ['競合（別のタブ・削除）', { ok: false, error: { code: 'conflict', retryable: false } }, 'failed'],
  ['結果不明', { ok: false, error: { code: 'outcome-unknown', retryable: false } }, 'failed'],
  ['保存先の例外', 'throw', 'failed'],
]) {
  test(`保存の失敗（${name}）：試合は最後まで進み、状態は「保存できませんでした」。窓口は例外を出さない`, async () => {
    const store = fakeStore([result, result, result, result, result, result, result, result, result, result]);
    const rec = createPaifuRecorder({ store, appVersion: '0.7.0' });
    const { match } = await playApp(rec, { length: 4, seedBase: 905 });
    assert.ok(match.over, '試合は最後まで');
    assert.equal(rec.status().state, state);
    assert.ok(rec.status().saveError);
  });
}

test('一時的な失敗の後に成功すれば保存済みになる（容量不足 → 次の局で成功）', async () => {
  const store = fakeStore([{ ok: false, error: { code: 'quota-exceeded', retryable: true } }]);
  const rec = createPaifuRecorder({ store, appVersion: '0.7.0' });
  await playApp(rec, { length: 4, seedBase: 906 });
  assert.equal(rec.status().state, 'saved');
  assert.equal(store.saved.at(-1).status, 'complete');
});

test('記録できない操作（記録していない状態の変更・別の Game）：記録をやめ、それまでの検証済みの部分を「記録の失敗」として保存。試合は続く', async () => {
  const store = fakeStore();
  const rec = createPaifuRecorder({ store, appVersion: '0.7.0' });
  // 2局目の途中で、記録を通さずにエンジンを操作する（テスト用のフックによる局面の差し替えなど）
  const { match } = await playApp(rec, { length: 4, seedBase: 907, tamper: { at: 80, fn: (g) => { const q = g.pending(); if (q && q.type === 'turn') g.discard(q.seat, g.hands[q.seat][0]); else if (q) g.respond(q.seat, { type: 'pass' }); } } });
  assert.ok(match.over, '試合は最後まで');
  assert.equal(rec.status().state, 'error');
  const last = store.saved.at(-1);
  assert.ok(last, '検証済みの部分を保存');
  assert.equal(last.status, 'aborted');
  assert.deepEqual(last.termination, { reason: 'recording-error' });
  verifyPaifu(last);
  // 別の Game への行動
  const rec2 = createPaifuRecorder({ store: fakeStore(), appVersion: '0.7.0' });
  const m = createMatch({ length: 1, riichiDeposit: RIICHI_DEPOSIT, agariYame: true });
  rec2.startMatch({ eligible: true, mode: 'math1', length: 1, seedBase: 10, players: PLAYERS, match: m });
  const g = new Game({ rules: paifuRules('math1'), seed: 10 + ROUND_SEED_STEP, dealer: 0, players: PLAYERS, round: 1, ruleset: 2 });
  rec2.roundStarted(g);
  const other = new Game({ rules: paifuRules('math1'), seed: 10 + ROUND_SEED_STEP, dealer: 0, players: PLAYERS, round: 1, ruleset: 2 });
  const b = other.events.length; other.discard(0, other.drawn);
  assert.doesNotThrow(() => rec2.actionApplied(other, 0, { type: 'discard', tile: other.rivers[0][0].id }, 'human', b));
  assert.equal(rec2.status().state, 'error');
});

test('テスト用の山（presetWall）の局・作成に失敗する設定：記録しない（例外を出さない）', async () => {
  const store = fakeStore();
  const rec = createPaifuRecorder({ store, appVersion: '0.7.0' });
  const m = createMatch({ length: 1, riichiDeposit: RIICHI_DEPOSIT, agariYame: true });
  rec.startMatch({ eligible: true, mode: 'math1', length: 1, seedBase: 11, players: PLAYERS, match: m });
  const g = new Game({ rules: paifuRules('math1'), seed: 11 + ROUND_SEED_STEP, dealer: 0, players: PLAYERS, round: 1, ruleset: 2 });
  assert.doesNotThrow(() => rec.roundStarted(g, { presetWall: true }));
  assert.equal(rec.status().state, 'error');
  await settle();
  assert.equal(store.saved.length, 0, '局が1つもないので保存しない');
  // 不正な seedBase（範囲外）・保存先なし
  const rec2 = createPaifuRecorder({ store, appVersion: '0.7.0' });
  assert.doesNotThrow(() => rec2.startMatch({ eligible: true, mode: 'math1', length: 1, seedBase: 1e12, players: PLAYERS, match: m }));
  assert.equal(rec2.status().state, 'error');
  const rec3 = createPaifuRecorder({ store: null, appVersion: '0.7.0' });
  assert.doesNotThrow(() => rec3.startMatch({ eligible: true, mode: 'math1', length: 1, seedBase: 1, players: PLAYERS, match: m }));
  assert.equal(rec3.status().state, 'error');
});

test('ページを離れる（pagehide）：記録中の局を含めて保存しておく（精算前の局は未精算のまま）', async () => {
  const store = fakeStore();
  const rec = createPaifuRecorder({ store, appVersion: '0.7.0' });
  await playApp(rec, { length: 4, seedBase: 908, stopAfter: 40 });
  rec.flush();
  await settle();
  const last = store.saved.at(-1);
  assert.equal(last.status, 'recording');
  assert.equal(last.rounds.at(-1).settlement, null);
  verifyPaifu(last);
});

test('ゲームの進行に影響しない：記録あり／なしで、同じ seed・同じ選択の対局の状態は同じ', async () => {
  const run = async (withRec) => {
    const rec = createPaifuRecorder({ store: fakeStore(), appVersion: '0.7.0' });
    let match = createMatch({ length: 4, riichiDeposit: RIICHI_DEPOSIT, agariYame: true });
    if (withRec) rec.startMatch({ eligible: true, mode: 'math1', length: 4, seedBase: 909, players: PLAYERS, match });
    const rng = createRng(909), ids = ['yujin', 'aoto', 'kanata', 'mitsuki'], digests = [];
    let round = 1;
    while (!match.over) {
      const g = new Game({ rules: paifuRules('math1'), seed: 909 + round * ROUND_SEED_STEP, dealer: dealerOf(match), players: PLAYERS, round, ruleset: 2 });
      if (withRec) rec.roundStarted(g);
      while (g.pending()) {
        const q = g.pending(), a = decideCharacter(g, q.seat, ids[q.seat], rng, null, ids), b = g.events.length;
        applyAction(g, q.seat, a);
        if (withRec) rec.actionApplied(g, q.seat, a, q.seat ? 'ai' : 'human', b);
      }
      digests.push(stateDigest(g));
      match = applyRoundResult(match, g.result, { round, maxRound: MAX_ROUND, riichi: g.riichi });
      if (withRec) rec.roundSettled(g, match, { maxRound: MAX_ROUND });
      round++;
    }
    await settle();
    return { digests, scores: match.scores, next: rng.next() };
  };
  assert.deepEqual(await run(true), await run(false));
});

test('前の試合の保存が終わる前に新しい試合を始めても、前の試合の最後の保存（中断）はその試合のトークンで行われる', async () => {
  const inner = fakeStore();
  let release;
  const gate = new Promise((r) => { release = r; });
  const store = { saved: inner.saved, save: async (p, o) => { await gate; return inner.save(p, o); } }; // 保存を遅らせる
  const rec = createPaifuRecorder({ store, appVersion: '0.7.0' });
  // 1局目を精算（保存は遅れて保留）→ 2局目の途中で新しい試合
  const { match } = await playApp(rec, { length: 8, seedBase: 910, stopAfter: 200 });
  assert.ok(!match.over && match.played >= 1);
  const id1 = rec.privateRecord().id;
  await playApp(rec, { length: 1, seedBase: 911 });
  release();
  await settle(); await settle();
  const first = inner.saved.filter((x) => x.id === id1);
  assert.ok(first.length >= 2, '前の試合：精算時の保存と中断の保存');
  assert.equal(first.at(-1).status, 'aborted');
  assert.deepEqual(first.at(-1).termination, { reason: 'reset' });
  assert.equal(inner.saved.filter((x) => x.id !== id1).at(-1).status, 'complete', '新しい試合は完了まで保存');
  assert.equal(rec.status().state, 'saved', '表示はいまの試合の状態');
});
