// 牌譜の IndexedDB 保存（Ver.0.8 第1段階・docs/74）。PR #37 の src/ui/paifu-storage.js から移植し、現行の記録形式
// （schemaVersion 2・通常対局・1/4/8局戦・数学Ⅰ/Ⅱ）に合わせた。
// DOM・localStorage・AI・ネットワーク・ゲームの状態は使わない。全ての操作は {ok:true,...} か {ok:false,error} を返し、例外で止めない。
// 既存の localStorage の保存キーとは別の専用データベース（mathjong-paifu-records）だけを使う。
// ・上限（件数・バイト数）に達したら保存は失敗（capacity-exceeded）。既存の牌譜は自動で削除しない（PR #69 監査 P2-1）。
// ・削除の世代（epoch）：全件削除は同じトランザクションで世代を1つ進める。保存は「どの世代の試合の記録か」を受け取り、
//   トランザクションの中で現在の世代と照合して、違えば stale-epoch で拒否する。複数タブで共有（DB の中）。
//   全件削除の前に始まった試合の保存要求（初回の保存前・要約の計算中・DB 待ち・保存の後の次の保存）が、
//   削除の後に牌譜を復活させない（PR #69 監査 P2-2）。
import { encodePaifuAsync, decodePaifu, PAIFU_MAX_BYTES, PAIFU_SCHEMA_VERSION } from '../engine/paifu.js';

// PR #37 の試作（schemaVersion 1・DB名 mathjong-paifu）の開発用データと混ざらないよう、別の名前にする
export const PAIFU_DB_NAME = 'mathjong-paifu-records';
export const PAIFU_DB_VERSION = 2; // 2：削除の世代の表（meta）を追加
export const PAIFU_STORAGE_VERSION = 1;
export const PAIFU_STORAGE_DEFAULTS = Object.freeze({ maxRecords:100, maxBytes:32 * 1024 * 1024, timeoutMs:5000 });
const STORES = ['records', 'index', 'meta'];
const EPOCH_KEY = 'epoch';
const MAX_EPOCH = Number.MAX_SAFE_INTEGER;
const INDEX_KEYS = ['storageVersion','id','token','revision','bytes','digest','savedAt','schemaVersion','visibility','mode','length','status','rounds'];
const ROW_KEYS = ['storageVersion','id','token','revision','bytes','digest','json'];
const sizeOf = s => new TextEncoder().encode(s).length;
// 索引の行が読める（この版の形式）か。読めない行（壊れた行・将来の版の行）は一覧・容量計算で除外し、自動では削除しない
const readable = x => { try { indexCheck(x); return true; } catch { return false; } };
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 128;
const uint = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
const exactKeys = (o, names) => o && typeof o === 'object' && !Array.isArray(o)
  && Object.keys(o).sort().join('|') === names.slice().sort().join('|');
class StoreError extends Error { constructor(code) { super(code); this.code = code; } }
function check(ok, code) { if (!ok) throw new StoreError(code); }
function failure(e, fallback = 'storage-error') {
  let code = e instanceof StoreError ? e.code : fallback;
  if (['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'].includes(e?.name)) code = 'quota-exceeded';
  if (['SecurityError', 'NotAllowedError', 'NotSupportedError'].includes(e?.name)) code = 'unavailable';
  if (e?.name === 'VersionError') code = 'unsupported-version';
  if (['AbortError', 'InvalidStateError'].includes(e?.name)) code = 'interrupted';
  return { ok:false, error:{ code, retryable:['quota-exceeded','unavailable','blocked','timeout','interrupted','storage-error'].includes(code) } };
}
function schemaError(e) {
  return ['schemaVersion','engineVersion','visibility','settings.mode','settings.ruleset'].includes(e?.path)
    ? new StoreError('unsupported-version') : new StoreError('corrupt');
}
function token() {
  // Does not use Math.random or any game/AI RNG. Works without crypto.randomUUID on older Safari.
  check(globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function', 'unavailable');
  const a = new Uint8Array(16);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, n => n.toString(16).padStart(2,'0')).join('');
}
function indexCheck(x) {
  check(x && x.storageVersion === PAIFU_STORAGE_VERSION && x.schemaVersion === PAIFU_SCHEMA_VERSION, 'unsupported-version');
  check(exactKeys(x, INDEX_KEYS) && validId(x.id) && /^[0-9a-f]{32}$/.test(x.token)
    && uint(x.revision,1) && uint(x.bytes,1) && x.bytes <= PAIFU_MAX_BYTES && uint(x.savedAt) && /^[0-9a-f]{64}$/.test(x.digest)
    && x.visibility === 'private-full' && ['math1','math2'].includes(x.mode)
    && [1,4,8].includes(x.length) && ['recording','complete','aborted'].includes(x.status) && uint(x.rounds), 'corrupt');
}
function pairCheck(row, meta, id) {
  check(row !== undefined && meta !== undefined, 'corrupt');
  indexCheck(meta);
  check(row.storageVersion === PAIFU_STORAGE_VERSION, 'unsupported-version');
  check(exactKeys(row,ROW_KEYS) && row.id === id && meta.id === id && row.token === meta.token
    && row.revision === meta.revision && row.bytes === meta.bytes && row.digest === meta.digest && typeof row.json === 'string'
    && row.json.length <= PAIFU_MAX_BYTES && sizeOf(row.json) === row.bytes, 'corrupt');
}
function summary(p, common) {
  return { storageVersion:PAIFU_STORAGE_VERSION, ...common, schemaVersion:p.schemaVersion,
    visibility:'private-full', mode:p.settings.mode, length:p.settings.length, status:p.status, rounds:p.rounds.length };
}
function decodeRow(row, meta, id) {
  let p; try { p = decodePaifu(row.json); } catch (e) { throw schemaError(e); }
  check(p.id === id, 'corrupt');
  const expected = summary(p, { id, token:meta.token, revision:meta.revision, bytes:meta.bytes, digest:meta.digest, savedAt:meta.savedAt });
  check(JSON.stringify(Object.entries(expected).sort()) === JSON.stringify(Object.entries(meta).sort()), 'corrupt');
  return p;
}

// encode：記録 → 検証済みの正規化 JSON（既定は主スレッドで分割して検証する encodePaifuAsync。Worker の版を渡せる）。
// hooks：テスト用（afterEncode・afterDigest：保存の途中の各時点で待てる）
export function createPaifuStore({ getIndexedDB = () => globalThis.indexedDB,
  maxRecords = PAIFU_STORAGE_DEFAULTS.maxRecords, maxBytes = PAIFU_STORAGE_DEFAULTS.maxBytes,
  timeoutMs = PAIFU_STORAGE_DEFAULTS.timeoutMs, encode = (p) => encodePaifuAsync(p), hooks = {} } = {}) {
  // Invalid configuration also becomes a result on use, rather than an import/startup failure.
  const configOK = uint(maxRecords,1) && maxRecords <= 10000 && uint(maxBytes,1)
    && maxBytes <= 256 * 1024 * 1024 && uint(timeoutMs,1) && timeoutMs <= 60000 && typeof getIndexedDB === 'function'
    && typeof encode === 'function' && hooks && typeof hooks === 'object';
  const hook = async (name, ...args) => { if (typeof hooks[name] === 'function') await hooks[name](...args); };
  const safe = async fn => {
    try { check(configOK, 'invalid-argument'); return { ok:true, ...await fn() }; }
    catch (e) { return failure(e); }
  };
  async function digest(json) {
    check(globalThis.crypto?.subtle && typeof globalThis.crypto.subtle.digest === 'function', 'unavailable');
    let timer;
    try {
      const hash = await Promise.race([
        globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(json)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new StoreError('timeout')), timeoutMs); }),
      ]);
      return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2,'0')).join('');
    } finally { clearTimeout(timer); }
  }

  function open() {
    return new Promise((resolve, reject) => {
      let done = false, request, timer;
      const finish = (error, db) => {
        if (done) { if (db) db.close(); return; }
        done = true; clearTimeout(timer);
        if (error) reject(error); else resolve(db);
      };
      timer = setTimeout(() => finish(new StoreError('timeout')), timeoutMs);
      try {
        const idb = getIndexedDB(); check(idb && typeof idb.open === 'function', 'unavailable');
        request = idb.open(PAIFU_DB_NAME, PAIFU_DB_VERSION);
        request.onblocked = () => finish(new StoreError('blocked'));
        request.onupgradeneeded = event => {
          if (done) { try { request.transaction.abort(); } catch { /* already aborted */ } return; }
          try {
            // 0（新規）：全部の表を作る。1（世代の表がない版）：meta だけを足す（既存の牌譜はそのまま）
            check(event.oldVersion === 0 || event.oldVersion === 1, 'unsupported-version');
            const have = Array.from(request.result.objectStoreNames);
            check(event.oldVersion === 0 ? have.length === 0 : ['index', 'records'].every(n => have.includes(n)), 'corrupt');
            for (const name of STORES) if (!have.includes(name)) request.result.createObjectStore(name, { keyPath:'id' });
          } catch (e) {
            try { request.transaction.abort(); } catch { /* already aborted */ }
            finish(e);
          }
        };
        request.onerror = () => finish(request.error || new StoreError('unavailable'));
        request.onsuccess = () => {
          const db = request.result;
          if (done) { db.close(); return; }
          if (db.version !== PAIFU_DB_VERSION || Array.from(db.objectStoreNames).sort().join('|') !== STORES.slice().sort().join('|')) {
            db.close(); finish(new StoreError(db.version !== PAIFU_DB_VERSION ? 'unsupported-version' : 'corrupt')); return;
          }
          finish(null, db);
        };
      } catch (e) { finish(e); }
    });
  }

  async function transact(mode, body) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        let tx, timer, result, done = false, reason;
        const finish = error => {
          if (done) return; done = true; clearTimeout(timer);
          db.onversionchange = null; db.onclose = null;
          if (error) reject(error); else resolve(result);
        };
        const stop = error => {
          if (done) return;
          reason = reason || error;
          if (tx) {
            try { tx.abort(); }
            catch {
              // Commit may already have started. Never promise rollback in this ambiguous case.
              // The caller must reload, not retry blindly; CAS still protects a later replacement.
              if (mode === 'readwrite' && result !== undefined && !tx.error && error?.name !== 'AbortError') reason = new StoreError('outcome-unknown');
            }
          }
          finish(reason);
        };
        try {
          if (mode === 'readwrite') {
            try { tx = db.transaction(STORES, mode, { durability:'strict' }); }
            catch (e) { if (e.name !== 'TypeError') throw e; tx = db.transaction(STORES, mode); }
          } else tx = db.transaction(STORES, mode);
          tx.oncomplete = () => finish(); // Never acknowledge merely because put().onsuccess fired.
          tx.onabort = () => finish(reason || tx.error || new StoreError('interrupted'));
          tx.onerror = event => stop(event.target?.error || tx.error || new StoreError('storage-error'));
          db.onversionchange = () => { stop(new StoreError('interrupted')); db.close(); };
          db.onclose = () => stop(new StoreError('interrupted'));
          timer = setTimeout(() => stop(new StoreError('timeout')), timeoutMs);
          for (const name of STORES) {
            const s = tx.objectStore(name);
            check(s.keyPath === 'id' && s.autoIncrement === false, 'corrupt');
          }
          // Callbacks enqueue writes synchronously inside the native transaction's active task.
          // No encode/decode, await, network, or other asynchronous work is allowed here.
          body(tx, value => { result = value; }, stop);
        } catch (e) { stop(e); }
      });
    } finally { db.close(); }
  }
  function requests(tx, specs, next, stop) {
    const values = [], count = specs.length;
    let remaining = count;
    specs.forEach(([store, method, arg], i) => {
      const request = tx.objectStore(store)[method](arg);
      request.onsuccess = () => {
        values[i] = request.result;
        if (--remaining === 0) { try { next(...values); } catch (e) { stop(e); } }
      };
    });
  }
  // 現在の削除の世代（meta の行。なければ 0）
  const epochOf = row => {
    if (row === undefined) return 0;
    check(exactKeys(row, ['id', 'epoch']) && row.id === EPOCH_KEY && uint(row.epoch) && row.epoch <= MAX_EPOCH, 'corrupt');
    return row.epoch;
  };
  async function readPrivate(id) {
    check(validId(id), 'invalid-argument');
    const { row, meta } = await transact('readonly', (tx, set, stop) => {
      requests(tx, [['records','get',id],['index','get',id]], (row, meta) => set({ row, meta }), stop);
    });
    check(row !== undefined || meta !== undefined, 'not-found');
    pairCheck(row, meta, id);
    check(await digest(row.json) === row.digest, 'corrupt');
    const record = decodeRow(row, meta, id); // Outside the IDB transaction.
    return { record, metadata:Object.freeze(meta) };
  }

  return Object.freeze({
    // New IDs are create-only. Replacements require the token returned by the last load/save.
    // A new random token on every write also prevents stale writes after delete/recreate (ABA).
    // epoch：この記録の試合が始まったときの削除の世代（必須）。現在の世代と違えば stale-epoch（削除の後に復活させない）
    save: (p, options = {}) => safe(async () => {
      check(options && typeof options === 'object' && !Array.isArray(options) && Object.keys(options).every(k => k === 'expectedToken' || k === 'epoch'), 'invalid-argument');
      const expectedToken = options.expectedToken ?? null, epoch = options.epoch;
      check(expectedToken === null || (typeof expectedToken === 'string' && /^[0-9a-f]{32}$/.test(expectedToken)), 'invalid-argument');
      check(uint(epoch) && epoch <= MAX_EPOCH, 'invalid-argument');
      let json; try { json = await encode(p); } catch (e) {
        throw new StoreError(e?.path === 'json' && String(e.message).includes('byte limit') ? 'record-too-large' : 'invalid-record');
      }
      check(typeof json === 'string' && json.length <= PAIFU_MAX_BYTES, 'record-too-large');
      await hook('afterEncode', p.id);
      const bytes = sizeOf(json), freshToken = token(), savedAt = Date.now();
      check(uint(savedAt), 'storage-error');
      // Snapshot from the validated JSON BEFORE awaiting. Later caller mutations cannot alter metadata.
      const snapshot = JSON.parse(json), id = snapshot.id;
      check(id === p.id && snapshot.status === p.status && snapshot.rounds.length === p.rounds.length, 'invalid-record');
      const base = summary(snapshot, { id, token:freshToken, bytes, savedAt, digest:await digest(json) });
      await hook('afterDigest', p.id);
      return transact('readwrite', (tx, set, stop) => {
        requests(tx, [['meta','get',EPOCH_KEY],['index','getAll',undefined],['records','count',undefined],['records','get',id]], (epochRow, all, count, old) => {
          // 削除の世代の照合（同じトランザクション）：全件削除の後に、削除の前の試合の記録を書かない
          check(epochOf(epochRow) === epoch, 'stale-epoch');
          check(count === all.length, 'corrupt');
          const entries = all.filter(readable), unreadable = all.length - entries.length;
          const prior = entries.find(e => e.id === id);
          if (prior || old !== undefined) pairCheck(old, prior, id);
          check(prior ? expectedToken === prior.token : expectedToken === null, 'conflict');
          const used = entries.reduce((n, e) => n + e.bytes, 0) - (prior?.bytes || 0) + bytes;
          const total = entries.length + unreadable + (prior ? 0 : 1);
          // 上限を超えるなら保存しない（既存の牌譜は削除しない・変更しない）
          check(used <= maxBytes && total <= maxRecords, 'capacity-exceeded');
          const meta = { ...base, revision:(prior?.revision || 0) + 1 };
          check(uint(meta.revision,1), 'storage-error');
          tx.objectStore('records').put({ storageVersion:PAIFU_STORAGE_VERSION, id, token:freshToken, revision:meta.revision, bytes, digest:base.digest, json });
          tx.objectStore('index').put(meta);
          set({ metadata:Object.freeze(meta) });
        }, stop);
      });
    }),
    // 現在の削除の世代
    epoch: () => safe(() => transact('readonly', (tx, set, stop) => {
      requests(tx, [['meta','get',EPOCH_KEY]], (row) => set({ epoch:epochOf(row) }), stop);
    })),
    loadPrivate: id => safe(() => readPrivate(id)),
    verify: id => safe(async () => {
      const { metadata } = await readPrivate(id);
      return { valid:true, metadata }; // No wall/hands/payload in this result.
    }),
    list: () => safe(() => transact('readonly', (tx, set, stop) => {
      requests(tx, [['index','getAll',undefined],['records','count',undefined]], (all, count) => {
        check(count === all.length, 'corrupt');
        const entries = all.filter(readable);
        entries.sort((a,b) => b.savedAt - a.savedAt || a.id.localeCompare(b.id));
        set({ entries:Object.freeze(entries.map(Object.freeze)), bytes:entries.reduce((n,e) => n + e.bytes,0), unreadable:all.length - entries.length });
      }, stop);
    })),
    remove: (id, options = {}) => safe(() => {
      check(validId(id) && options && typeof options === 'object' && !Array.isArray(options) && Object.keys(options).every(k => k === 'expectedToken'), 'invalid-argument');
      const expectedToken = options.expectedToken ?? null;
      check(expectedToken === null || (typeof expectedToken === 'string' && /^[0-9a-f]{32}$/.test(expectedToken)), 'invalid-argument');
      return transact('readwrite', (tx, set, stop) => {
        requests(tx, [['records','get',id],['index','get',id]], (row, meta) => {
          if (expectedToken !== null) { check(meta !== undefined, 'conflict'); indexCheck(meta); check(meta.token === expectedToken, 'conflict'); }
          tx.objectStore('records').delete(id); tx.objectStore('index').delete(id);
          set({ removed:row !== undefined || meta !== undefined });
        }, stop);
      });
    }),
    // 全件削除：牌譜の2つの表を消し、同じトランザクションで削除の世代を1つ進める（他の DB・localStorage は消さない）
    clearAll: () => safe(() => transact('readwrite', (tx, set, stop) => {
      requests(tx, [['meta','get',EPOCH_KEY]], (row) => {
        const next = epochOf(row) + 1;
        check(next <= MAX_EPOCH, 'storage-error');
        tx.objectStore('records').clear(); tx.objectStore('index').clear();
        tx.objectStore('meta').put({ id:EPOCH_KEY, epoch:next });
        set({ cleared:true, epoch:next });
      }, stop);
    })),
  });
}
