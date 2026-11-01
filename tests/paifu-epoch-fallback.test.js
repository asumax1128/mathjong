// PR #69 第3回監査 P2：DB の接続がないとき（開始の瞬間の世代を読めない＝代替の経路）に、行動0件の試合が
// 全件削除の後の世代へ結び付いて、削除の前の試合が復活する反例の恒久テスト。
// 本物の入口（createPaifuSystem：記録の窓口・世代の管理・BroadcastChannel）に、2つのタブで共有する偽の DB を渡す。
// 偽の DB は本物の契約どおり：全件削除で世代を進め、保存はトランザクションの中で世代とトークンを照合する。
// 接続を閉じると epochNow() は null（本物と同じ）、世代の読込（epoch()）は保留できる。
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine/game.js';
import { applyAction } from '../src/engine/ai.js';
import { decideCharacter } from '../src/engine/characters.js';
import { createRng } from '../src/engine/rng.js';
import { createMatch, applyRoundResult, dealerOf, RIICHI_DEPOSIT } from '../src/engine/match.js';
import { MAX_ROUND } from '../src/ui/params.js';
import { createPaifuSystem } from '../src/ui/paifu-system.js';
import { encodePaifu, verifyPaifu, paifuRules, ROUND_SEED_STEP } from '../src/engine/paifu.js';
import { PLAYERS } from './paifu-harness.mjs';

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await flush(); };

// 2つのタブで共有する DB。tab() は各タブの保存先（接続はタブごと）
function sharedDB() {
  const db = { epoch: 0, rows: new Map(), saves: [] };
  db.tab = () => {
    let live = true, reopen = true, gate = null, n = 0;
    const t = {
      // 接続を閉じる（reopen=false の間は開き直さない）。epochNow() は null を返し、記録は代替の経路（非同期の読込）になる
      dropConnection: () => { live = false; },
      close: () => {}, // createPaifuSystem().close() から呼ばれる（何もしない）
      blockReopen: (b) => { reopen = !b; },
      // 次の世代の読込を保留する。release() で完了させる（読む値は完了の時点の DB の世代）
      holdEpoch: () => { let release; gate = new Promise((r) => { release = r; }); return () => { gate = null; release(); }; },
      warm: () => { if (reopen) live = true; },
      epochNow: () => {
        if (!live) { if (reopen) queueMicrotask(() => { live = true; }); return null; }
        const e = db.epoch; // 本物は読取りのトランザクションをここで同期に作る
        return Promise.resolve({ ok: true, epoch: e });
      },
      epoch: async () => { const g = gate; if (g) await g; return { ok: true, epoch: db.epoch }; },
      clearAll: async () => { db.epoch++; db.rows.clear(); return { ok: true, cleared: true, epoch: db.epoch }; },
      list: async () => ({ ok: true, count: db.rows.size, unreadable: 0 }),
      save: async (p, { expectedToken = null, epoch } = {}) => {
        const json = encodePaifu(p); // 本物と同じく保存の前に検証
        if (epoch !== db.epoch) return { ok: false, error: { code: 'stale-epoch', retryable: false } };
        const old = db.rows.get(p.id);
        if ((old ? old.token : null) !== expectedToken) return { ok: false, error: { code: 'conflict', retryable: false } };
        const token = (++n).toString(16).padStart(32, '0');
        db.rows.set(p.id, { token, epoch, rec: JSON.parse(json) });
        db.saves.push({ id: p.id, epoch });
        return { ok: true, metadata: { id: p.id, token } };
      },
    };
    return t;
  };
  return db;
}

// 失敗したテストでも BroadcastChannel を閉じる（開いたままだとプロセスが終わらない）
const opened = [];
afterEach(() => { while (opened.length) { try { opened.pop().close(); } catch { /* 無視 */ } } });
function makeTab(db, { bc }) {
  const store = db.tab();
  const saved = globalThis.BroadcastChannel;
  if (!bc) globalThis.BroadcastChannel = undefined;
  try {
    const sys = createPaifuSystem({ appVersion: '0.7.0', store, useWorker: false });
    opened.push(sys);
    return { sys, store, rec: sys.recorder };
  } finally { globalThis.BroadcastChannel = saved; }
}

// app.js と同じ流れ：試合の開始 → 局の開始 → 行動（actions 件で止める。null なら最後まで）
const IDS = ['yujin', 'aoto', 'kanata', 'mitsuki'];
async function play(rec, { seedBase, length = 1, actions = null }) {
  let match = createMatch({ length, riichiDeposit: RIICHI_DEPOSIT, agariYame: true });
  rec.startMatch({ eligible: true, mode: 'math1', length, seedBase, players: PLAYERS, match });
  const rng = createRng(seedBase);
  let round = 1, steps = 0;
  while (!match.over) {
    if (actions === 0) return { steps };
    const g = new Game({ rules: paifuRules('math1'), seed: seedBase + round * ROUND_SEED_STEP, dealer: dealerOf(match), players: PLAYERS, round, ruleset: 2 });
    rec.roundStarted(g, { presetWall: false });
    while (g.pending()) {
      const q = g.pending();
      const a = decideCharacter(g, q.seat, IDS[q.seat], rng, null, IDS);
      const before = g.events.length;
      applyAction(g, q.seat, a);
      rec.actionApplied(g, q.seat, a, q.seat ? 'ai' : 'human', before);
      if (actions !== null && ++steps >= actions) return { steps, g, match };
    }
    match = applyRoundResult(match, g.result, { round, maxRound: MAX_ROUND, riichi: g.riichi });
    rec.roundSettled(g, match, { maxRound: MAX_ROUND });
    await settle();
    round++;
  }
  await settle();
  return { steps };
}

// Codex の固定反例（第3回監査）そのまま：
// 1 A が世代 0 を取得 → 2 A の接続を閉じる → 3 次の世代の取得を保留 → 4 A で通常対局を開始（行動0件）
// → 5 pagehide の保存を要求 → 6 B で全件削除（世代 1）→ 7 A の世代の取得を完了
test('Codex 固定反例：接続なし・行動0件・pagehide → 別のタブで全件削除 → 世代の取得の完了。旧試合は保存されず、件数は0件', async () => {
  const db = sharedDB();
  const A = makeTab(db, { bc: false }), B = makeTab(db, { bc: false });
  await A.sys.ready; await B.sys.ready;
  assert.equal(A.sys.epochState().epoch, 0, '1：A は世代 0 を取得');
  A.store.dropConnection(); A.store.blockReopen(true); // 2
  const release = A.store.holdEpoch(); // 3
  await play(A.rec, { seedBase: 1301, actions: 0 }); // 4
  const oldId = A.rec.privateRecord().id;
  A.rec.flush(); // 5
  await settle();
  assert.equal(db.saves.length, 0, '世代が決まる前は保存しない');
  await B.sys.clearAll(); // 6
  assert.equal(db.epoch, 1);
  release(); // 7
  await settle();
  assert.equal(db.rows.size, 0, '削除の後の牌譜の件数は0件');
  assert.ok(!db.saves.some((x) => x.id === oldId), '旧試合は一度も保存されない');
  assert.deepEqual([A.rec.status().state, A.rec.status().reason, A.rec.status().bound], ['off', 'epoch-changed', false]);
  A.rec.flush(); A.rec.leave('left-match'); await settle();
  assert.equal(db.rows.size, 0, 'その後の pagehide・途中退出でも保存しない');
  A.sys.close(); B.sys.close();
});

// 組合せ：行動 0／1 件 × pagehide あり／なし × 新しい対局／再戦 × BroadcastChannel あり／なし
for (const actions of [0, 1]) for (const pagehide of [true, false]) for (const how of ['新しい対局', '再戦']) for (const bc of [true, false]) {
  const name = `行動${actions}件・pagehide${pagehide ? 'あり' : 'なし'}・${how}・BroadcastChannel${bc ? 'あり' : 'なし'}`;
  test(`接続なしで始めた試合の後に別のタブで全件削除：${name} → 旧試合は保存されない・削除の後の新しい試合は保存できる`, async () => {
    const db = sharedDB();
    const A = makeTab(db, { bc }), B = makeTab(db, { bc });
    await A.sys.ready; await B.sys.ready;
    let prevId = null;
    if (how === '再戦') {
      // 前の試合（1局戦）を最後まで打って保存（接続あり・ちょうどの結び付け）。再戦はその後に始める
      await play(A.rec, { seedBase: 1400 + actions });
      prevId = A.rec.privateRecord().id;
      assert.equal(db.rows.get(prevId).rec.status, 'complete');
    }
    A.store.dropConnection(); A.store.blockReopen(true);
    const release = A.store.holdEpoch();
    await play(A.rec, { seedBase: 1410 + actions * 2 + (pagehide ? 1 : 0), length: 4, actions });
    const oldId = A.rec.privateRecord().id;
    if (pagehide) A.rec.flush();
    await settle();
    await B.sys.clearAll();
    release();
    await settle();
    // 削除の前に始まった試合：行動の数・pagehide・通知に関係なく記録しない
    assert.deepEqual([A.rec.status().state, A.rec.status().reason], ['off', 'epoch-changed'], name);
    A.rec.flush(); A.rec.leave('left-match'); await settle();
    assert.equal(db.rows.size, 0, '削除の後は0件（前の試合も旧試合も戻らない）');
    assert.ok(!db.saves.some((x) => x.id === oldId), '旧試合は一度も保存されない');
    if (prevId) assert.ok(!db.saves.some((x) => x.id === prevId && x.epoch === 1), '前の試合を新しい世代で保存しない');
    // 削除の後の新しい試合：(a) 接続がないまま（読込で覚えた世代＝DB の世代なので結び付く）
    await play(A.rec, { seedBase: 1420 });
    await settle();
    assert.deepEqual([A.rec.status().state, A.rec.status().epoch], ['saved', 1], '接続なしでも、削除の後の新しい試合は保存');
    // (b) 接続を開き直した後（開始の時点の読取りでちょうど結び付く）
    A.store.blockReopen(false); A.store.warm();
    await play(A.rec, { seedBase: 1421 });
    await settle();
    assert.deepEqual([A.rec.status().state, A.rec.status().epoch], ['saved', 1]);
    assert.equal(db.rows.size, 2, '削除の後の2試合だけ');
    for (const r of db.rows.values()) { assert.equal(r.epoch, 1); assert.equal(r.rec.status, 'complete'); verifyPaifu(r.rec); }
    A.sys.close(); B.sys.close();
  });
}

test('接続なし・削除なし：開始の前の世代と読んだ世代が同じなら、行動0件でも1件以上でも記録・保存する（ゲームは待たない）', async () => {
  for (const actions of [0, 5]) {
    const db = sharedDB();
    const A = makeTab(db, { bc: false });
    await A.sys.ready;
    A.store.dropConnection(); A.store.blockReopen(true);
    const release = A.store.holdEpoch();
    const r = await play(A.rec, { seedBase: 1500 + actions, length: 4, actions });
    assert.equal(r.steps, actions, 'ゲームは世代の読込を待たずに進む');
    A.rec.flush();
    await settle();
    assert.equal(db.saves.length, 0);
    release();
    await settle();
    assert.equal(A.rec.status().bound, true);
    if (actions === 0) assert.equal(db.rows.size, 0, '局が始まる前の pagehide は保存するものがない');
    else {
      assert.equal(db.rows.size, 1, '待っていた保存（pagehide）を結び付けの後に行う');
      assert.equal([...db.rows.values()][0].rec.status, 'recording');
    }
    // 続けて最後まで打たなくても、途中退出で中断として保存できる（結び付いた世代 0 のまま）
    A.rec.leave('left-match');
    await settle();
    if (actions > 0) assert.equal([...db.rows.values()][0].rec.status, 'aborted');
    A.sys.close();
  }
});

test('開始の前の世代が分からない（起動時の読込に失敗）とき：接続なしでは、新しい世代に無理に結び付けず記録しない', async () => {
  const db = sharedDB();
  const store = db.tab();
  let fail = true;
  const epoch = store.epoch;
  store.epoch = async () => (fail ? { ok: false, error: { code: 'storage-error', retryable: true } } : epoch());
  const sys = createPaifuSystem({ appVersion: '0.7.0', store, useWorker: false });
  opened.push(sys);
  await sys.ready;
  assert.equal(sys.epochState().epoch, null);
  store.dropConnection(); store.blockReopen(true);
  fail = false;
  await play(sys.recorder, { seedBase: 1600, actions: 0 });
  sys.recorder.flush();
  await settle();
  assert.deepEqual([sys.recorder.status().state, sys.recorder.status().reason], ['off', 'not-ready']);
  assert.equal(db.rows.size, 0);
  sys.close();
});
