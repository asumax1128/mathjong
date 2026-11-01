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
import { createPaifuRecorder, describePaifuStatus } from '../src/ui/paifu-recorder.js';
import { verifyPaifu, encodePaifu, paifuRules, ROUND_SEED_STEP, stateDigest } from '../src/engine/paifu.js';
import { PLAYERS } from './paifu-harness.mjs';

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await flush(); };
// 偽の保存先：save の結果を順に返す（既定は成功）。保存された JSON を残す
function fakeStore(results = []) {
  const saved = [];
  const toks = new Map(); // 記録の ID ごとのトークン（本物と同じ）
  let n = 0, epoch = 0;
  const store = {
    saved,
    get epochValue() { return epoch; },
    // 本物と同じ：全件削除で世代を進め、保存はその世代の試合だけを受け付ける
    clearAll: async () => { epoch++; toks.clear(); saved.length = 0; return { ok: true, cleared: true, epoch }; },
    epoch: async () => ({ ok: true, epoch }),
    save: async (p, opts) => {
      const r = results[n++];
      if (r === 'throw') throw new Error('boom');
      if (r && !r.ok) return r;
      assert.deepEqual(Object.keys(opts).sort(), ['epoch', 'expectedToken'], '自動削除（evict）は指定しない');
      if (opts.epoch !== epoch) return { ok: false, error: { code: 'stale-epoch', retryable: false } };
      if (opts.expectedToken !== (toks.get(p.id) ?? null)) return { ok: false, error: { code: 'conflict', retryable: false } };
      const json = encodePaifu(p); // 本物と同じく保存の前に検証（選択の再生）
      const tok = (n.toString(16) + 'f'.repeat(32)).slice(0, 32);
      toks.set(p.id, tok);
      saved.push(JSON.parse(json));
      return { ok: true, metadata: { id: p.id, token: tok } };
    },
  };
  return store;
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

// ---- PR #69 監査 P2-2：全件削除と、削除の前に始まった試合の保存（削除の世代 epoch）----
const epochOf = (store) => () => ({ epoch: store.epochValue, error: null });
test('P2-2 保存の後に全件削除：削除の前の試合の次の保存は stale-epoch で拒否（復活しない）。削除の後の新しい試合は保存できる', async () => {
  const store = fakeStore();
  let known = 0; // アプリが知っている世代（全件削除・通知で更新される）
  const rec = createPaifuRecorder({ store, appVersion: '0.7.0', epoch: () => ({ epoch: known, error: null }) });
  await playApp(rec, { length: 8, seedBase: 920, stopAfter: 120 }); // 1局目を精算して保存済み
  assert.ok(store.saved.length >= 1);
  const r = await store.clearAll(); known = r.epoch; // 全件削除（世代 1）
  await playApp(rec, { length: 1, seedBase: 921 }); // 新しい試合（前の試合は reset として中断の保存を試みる → 拒否）
  const ids = new Set(store.saved.map((x) => x.id));
  assert.equal(ids.size, 1, '削除の後に残るのは新しい試合の記録だけ');
  assert.equal(store.saved.at(-1).status, 'complete');
  assert.equal(rec.status().state, 'saved');
});

test('P2-2 初回の保存の前に全件削除：その試合は1回も保存されず、状態は「削除されたため保存しません」', async () => {
  const store = fakeStore();
  const rec = createPaifuRecorder({ store, appVersion: '0.7.0', epoch: () => ({ epoch: 0, error: null }) }); // 削除を知らないタブ
  const m = createMatch({ length: 4, riichiDeposit: RIICHI_DEPOSIT, agariYame: true });
  rec.startMatch({ eligible: true, mode: 'math1', length: 4, seedBase: 922, players: PLAYERS, match: m });
  await store.clearAll(); // 別のタブで全件削除（このタブはまだ知らない）
  let stale = 0;
  const rec2 = createPaifuRecorder({ store, appVersion: '0.7.0', epoch: () => ({ epoch: 0, error: null }), onStaleEpoch: () => stale++ });
  await playApp(rec2, { length: 4, seedBase: 923 });
  assert.equal(store.saved.length, 0, '削除の前の世代の記録は保存しない');
  assert.equal(rec2.status().state, 'failed');
  assert.equal(rec2.status().saveError, 'stale-epoch');
  assert.ok(stale >= 1, '世代を読み直す');
  assert.match(describePaifuStatus(rec2.status()).text, /すべて削除されたため、この試合は保存しません/);
  assert.ok(rec);
});

// ---- PR #69 監査 P2-3：準備ができる前に始まった試合は記録しない ----
test('P2-3 世代が分からない（読込前）・保存できない端末：その試合は記録しない（途中から記録しない）。skipMatch で記録をやめる', async () => {
  const store = fakeStore();
  const rec = createPaifuRecorder({ store, appVersion: '0.7.0', epoch: () => ({ epoch: null, error: null }) });
  await playApp(rec, { length: 1, seedBase: 924 });
  assert.equal(store.saved.length, 0);
  assert.deepEqual([rec.status().state, rec.status().reason], ['off', 'not-ready']);
  assert.match(describePaifuStatus(rec.status()).text, /準備ができる前に始まった対局/);
  const rec2 = createPaifuRecorder({ store, appVersion: '0.7.0', epoch: () => ({ epoch: null, error: 'unavailable' }) });
  await playApp(rec2, { length: 1, seedBase: 925 });
  assert.deepEqual([rec2.status().state, rec2.status().reason], ['off', 'storage-unavailable']);
  assert.equal(store.saved.length, 0);
  // 記録中の試合で skipMatch：以後は記録しない（中断として保存を試みる）
  const rec3 = createPaifuRecorder({ store, appVersion: '0.7.0', epoch: epochOf(store) });
  await playApp(rec3, { length: 8, seedBase: 926, stopAfter: 10 });
  rec3.skipMatch('not-ready');
  assert.deepEqual([rec3.status().state, rec3.status().reason], ['off', 'not-ready']);
});

// ---- PR #69 監査 P3-1：保存状態の表示 ----
test('P3-1 表示：記録中・未保存／保存処理中／保存済み／保存失敗／記録対象外を別の文で示す', async () => {
  const D = (st) => describePaifuStatus({ dirty: false, inFlight: false, everSaved: false, saveError: null, savedStatus: null, reason: null, ...st });
  const cases = {
    recordingUnsaved: D({ state: 'recording', dirty: true }),
    recordingAfterSave: D({ state: 'saved', dirty: true, everSaved: true, savedStatus: 'recording' }),
    saving: D({ state: 'saving', dirty: true, inFlight: true }),
    savedPartial: D({ state: 'saved', everSaved: true, savedStatus: 'recording' }),
    savedComplete: D({ state: 'saved', everSaved: true, savedStatus: 'complete' }),
    savedAborted: D({ state: 'saved', everSaved: true, savedStatus: 'aborted' }),
    failedCapacity: D({ state: 'failed', dirty: true, saveError: 'capacity-exceeded' }),
    failedStale: D({ state: 'failed', saveError: 'stale-epoch' }),
    failedUnavailable: D({ state: 'failed', saveError: 'unavailable' }),
    failedOther: D({ state: 'failed', saveError: 'timeout' }),
    excluded: D({ state: 'off', reason: 'exam' }),
    notReady: D({ state: 'off', reason: 'not-ready' }),
    error: D({ state: 'error' }),
  };
  const kinds = Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, v.kind]));
  assert.deepEqual(kinds, { recordingUnsaved: 'recording', recordingAfterSave: 'recording', saving: 'saving', savedPartial: 'saved', savedComplete: 'saved',
    savedAborted: 'saved', failedCapacity: 'failed', failedStale: 'failed', failedUnavailable: 'failed', failedOther: 'failed', excluded: 'excluded', notReady: 'not-recorded', error: 'error' });
  const texts = Object.values(cases).map((c) => c.text);
  assert.equal(new Set(texts).size, texts.length, 'すべて別の文');
  assert.match(cases.recordingUnsaved.text, /記録中（まだ保存していません/);
  assert.match(cases.recordingAfterSave.text, /前の局までは保存済み/);
  assert.doesNotMatch(cases.recordingUnsaved.text, /保存しています/, '未保存を「保存中」と言わない');
  assert.match(cases.saving.text, /保存しています/);
  assert.match(cases.savedComplete.text, /この試合をこの端末に保存しました/);
  assert.match(cases.failedCapacity.text, /上限（100件・32MB）.*既存の牌譜は削除していません/);
  assert.match(cases.excluded.text, /対象外/);
  // 実際の流れ：保存中（in flight）だけが「保存中」、終われば保存済み、次の行動で「記録中（前の局までは保存済み）」
  let release;
  const gate = new Promise((r) => { release = r; });
  const inner = fakeStore();
  const store = { ...inner, save: async (p, o) => { await gate; return inner.save(p, o); } };
  const rec = createPaifuRecorder({ store, appVersion: '0.7.0' });
  const m = createMatch({ length: 4, riichiDeposit: RIICHI_DEPOSIT, agariYame: true });
  rec.startMatch({ eligible: true, mode: 'math1', length: 4, seedBase: 927, players: PLAYERS, match: m });
  assert.equal(describePaifuStatus(rec.status()).kind, 'recording');
  await playApp(rec, { length: 4, seedBase: 927, stopAfter: 150 }); // 1局目の精算で保存要求（保留中）
  await flush();
  assert.equal(describePaifuStatus(rec.status()).kind, 'saving');
  release();
  await settle();
  const k = describePaifuStatus(rec.status());
  assert.ok(k.kind === 'recording' || k.kind === 'saved', k.kind);
  assert.equal(rec.status().everSaved, true);
});
