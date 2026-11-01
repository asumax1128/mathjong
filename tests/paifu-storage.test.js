// 牌譜の保存（src/ui/paifu-storage.js・docs/74）：失敗の契約（例外で止めず {ok:false,error} を返す）。
// PR #37 の tests/paifu-storage.test.js から、現行の形式に合わせて移植。実際の IndexedDB の保存・読込・原子性・自動削除は
// Chromium の E2E（tests/e2e/play.mjs の v15Paifu*）で確認する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaifuStore, PAIFU_DB_NAME, PAIFU_DB_VERSION, PAIFU_STORAGE_DEFAULTS } from '../src/ui/paifu-storage.js';
import { playRecorded } from './paifu-harness.mjs';

const { record: p } = playRecorded({ mode: 'math1', length: 1, seedBase: 4242, id: 'storage-unit' });
const code = (r, c) => { assert.equal(r.ok, false); assert.equal(r.error.code, c); assert.equal('record' in r, false); };
const operations = (s) => [() => s.save(p, { epoch: 0 }), () => s.loadPrivate('storage-unit'), () => s.verify('storage-unit'), () => s.list(), () => s.remove('storage-unit'), () => s.clearAll(), () => s.epoch()];
function failedOpen(name) { return { open(db, version) { assert.equal(db, PAIFU_DB_NAME); assert.equal(version, PAIFU_DB_VERSION); const r = { error: new DOMException('injected', name) }; queueMicrotask(() => r.onerror()); return r; } }; }

test('保存：作成しただけでは DB を開かない。専用の名前空間（既存の localStorage のキー・PR #37 の試作の DB とは別）', () => {
  let opened = 0;
  const s = createPaifuStore({ getIndexedDB() { opened++; throw Error('must be lazy'); } });
  assert.equal(opened, 0);
  assert.ok(Object.isFrozen(s));
  assert.equal(PAIFU_DB_NAME, 'mathjong-paifu-records');
  assert.notEqual(PAIFU_DB_NAME, 'mathjong-paifu');
  assert.equal(PAIFU_DB_VERSION, 2, '2：削除の世代の表（meta）');
  assert.deepEqual(PAIFU_STORAGE_DEFAULTS, { maxRecords: 100, maxBytes: 32 * 1024 * 1024, timeoutMs: 5000 });
  assert.deepEqual(Object.keys(s).sort(), ['clearAll', 'epoch', 'list', 'loadPrivate', 'remove', 'save', 'verify']);
});

for (const mode of ['missing', 'getter-security', 'open-security']) {
  test(`保存：${mode}（IndexedDB がない・プライベートモードなど）でも全操作が例外にならず「利用不可」を返す`, async () => {
    const s = createPaifuStore({ getIndexedDB: () => {
      if (mode === 'missing') return undefined;
      if (mode === 'getter-security') throw new DOMException('Safari-like denial', 'SecurityError');
      return { open() { throw new DOMException('denied', 'SecurityError'); } };
    } });
    for (const op of operations(s)) code(await op(), 'unavailable');
  });
}

for (const [name, expected] of [['QuotaExceededError', 'quota-exceeded'], ['NS_ERROR_DOM_QUOTA_REACHED', 'quota-exceeded'], ['VersionError', 'unsupported-version'], ['AbortError', 'interrupted'], ['UnknownError', 'storage-error']]) {
  test(`保存：DB を開くときの ${name} を分類して返す（容量不足を含む）`, async () => {
    const s = createPaifuStore({ getIndexedDB: () => failedOpen(name) });
    code(await s.loadPrivate('x'), expected);
    code(await s.save(p, { epoch: 0 }), expected);
  });
}

test('保存：blocked の後の遅い成功は接続を閉じ、書き込まない', async () => {
  let req, closed = 0, transactions = 0;
  const db = { close() { closed++; }, transaction() { transactions++; throw Error('late transaction'); } };
  const s = createPaifuStore({ getIndexedDB: () => ({ open() { req = {}; queueMicrotask(() => req.onblocked()); return req; } }) });
  code(await s.loadPrivate('x'), 'blocked');
  req.result = db; req.onsuccess();
  assert.equal(closed, 1);
  assert.equal(transactions, 0);
});

test('保存：開くときのタイムアウトの後の upgrade は中断し、成功の通知も閉じる', async () => {
  let req, closed = 0, aborted = 0;
  const s = createPaifuStore({ timeoutMs: 5, getIndexedDB: () => ({ open() { req = {}; return req; } }) });
  code(await s.loadPrivate('x'), 'timeout');
  req.transaction = { abort() { aborted++; } }; req.onupgradeneeded({ oldVersion: 0 });
  req.result = { close() { closed++; } }; req.onsuccess();
  assert.equal(aborted, 1);
  assert.equal(closed, 1);
});

test('保存：不正な記録・ID・オプションは DB に触らず拒否（記録の検証＝選択の再生に失敗した記録は保存しない）', async () => {
  let opened = 0;
  const s = createPaifuStore({ getIndexedDB: () => { opened++; throw Error('unexpected DB access'); } });
  code(await s.save({ ...p, schemaVersion: 999 }, { epoch: 0 }), 'invalid-record');
  const broken = JSON.parse(JSON.stringify(p));
  broken.rounds[0].steps[0].digest = '0000000000000000';
  code(await s.save(broken, { epoch: 0 }), 'invalid-record');
  for (const id of ['', null, 1, {}, 'x'.repeat(129)]) {
    code(await s.loadPrivate(id), 'invalid-argument'); code(await s.verify(id), 'invalid-argument'); code(await s.remove(id), 'invalid-argument');
  }
  // 自動削除（evict）の指定は受け付けない（PR #69 監査 P2-1）。削除の世代（epoch）は必須
  for (const options of [null, [], { overwrite: true }, { expectedToken: 'invalid', epoch: 0 }, { evict: true, epoch: 0 }, { evict: false, epoch: 0 }, {}, { epoch: -1 }, { epoch: 1.5 }, { epoch: '0' }]) code(await s.save(p, options), 'invalid-argument');
  assert.equal(opened, 0);
});

test('保存：不正な容量・時間の設定でも、操作は例外にならず invalid-argument を返す', async () => {
  for (const options of [{ maxRecords: 0 }, { maxBytes: 0 }, { maxBytes: Infinity }, { timeoutMs: 0 }, { timeoutMs: 60001 }, { getIndexedDB: 1 }]) {
    const s = createPaifuStore(options);
    for (const op of operations(s)) code(await op(), 'invalid-argument');
  }
});

test('保存：形の違う DB を勝手に作り直さない（閉じて corrupt を返す）', async () => {
  let closed = 0;
  const s = createPaifuStore({ getIndexedDB: () => ({ open() { const r = { result: { version: 2, objectStoreNames: [], close() { closed++; } } }; queueMicrotask(() => r.onsuccess()); return r; } }) });
  code(await s.list(), 'corrupt');
  assert.equal(closed, 1);
});

test('保存：確定の途中で中止できないときは、保存されなかったと断定せず outcome-unknown を返す', async () => {
  let tx, closed = 0, clears = 0;
  const db = { version: 2, objectStoreNames: ['records', 'index', 'meta'], close() { closed++; }, transaction() {
    tx = { error: null, objectStore() { return { keyPath: 'id', autoIncrement: false, clear() { clears++; }, put() {}, get() { const r = {}; queueMicrotask(() => r.onsuccess && r.onsuccess()); return r; } }; }, abort() { throw new DOMException('already committing', 'InvalidStateError'); } };
    return tx;
  } };
  const s = createPaifuStore({ timeoutMs: 5, getIndexedDB: () => ({ open() { const r = { result: db }; queueMicrotask(() => r.onsuccess()); return r; } }) });
  const r = await s.clearAll();
  code(r, 'outcome-unknown');
  assert.equal(r.error.retryable, false);
  assert.equal(closed, 1);
  assert.equal(clears, 2, '牌譜の2つの表だけを消す（世代の表は消さない）');
  tx.oncomplete();
  assert.equal(r.error.code, 'outcome-unknown');
});

test('保存：古い版（1）の DB は世代の表だけを足して使う（既存の牌譜の表はそのまま）。知らない版・形は作り直さない', async () => {
  let created = [], aborted = 0;
  const upgrade = (oldVersion, have) => createPaifuStore({ getIndexedDB: () => ({ open() {
    const r = { transaction: { abort() { aborted++; } }, result: { objectStoreNames: have, createObjectStore(n) { created.push(n); } } };
    queueMicrotask(() => { r.onupgradeneeded({ oldVersion }); queueMicrotask(() => r.onerror && r.onerror()); });
    return r;
  } }) });
  await upgrade(1, ['records', 'index']).list();
  assert.deepEqual(created, ['meta']);
  created = [];
  await upgrade(0, []).list();
  assert.deepEqual(created, ['records', 'index', 'meta']);
  created = []; aborted = 0;
  code(await upgrade(5, ['records', 'index']).list(), 'unsupported-version');
  assert.deepEqual(created, []);
  assert.equal(aborted, 1);
});
