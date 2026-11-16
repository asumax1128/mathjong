// オンライン対戦の通信の窓口（Transport）。docs/79「9.0①」。
// ロビーの論理（online-lobby.js）はこの窓口だけを使い、Firebase を直接は知らない。
//   uid                       … 匿名認証の uid
//   now()                     … サーバー時刻の推定（端末の時計＋.info/serverTimeOffset）
//   get(path) / set(path, v) / update(path, obj) / remove(path)
//   transaction(path, fn)     … fn(現在値) が undefined なら中止。{ committed, value }
//   onValue(path, cb)         … 値が変わるたびに cb(値)。戻り値で購読をやめる
//   onDisconnectSet(path, v)  … 接続が切れたら v を書く（presence）。cancelOnDisconnect(path) で取り消す
//   onDisconnectUpdate(path, obj) … 接続が切れたら path の下の複数の子を書く（ホストの一時停止）
//   TS                        … サーバー時刻の置き換え値（{'.sv':'timestamp'}。書き込み時にサーバー時刻になる）
//   close()
// path は games/mathjong からの相対（例：'rooms/ABC234/meta'）。
//
// ・createMemoryBus()：メモリ上の偽バス（単体試験用。ネットワークなし・決定論的）
// ・createFirebaseTransport()：Firebase（modular SDK 12.12.0）を動的 import する。オンラインに入るときだけ読み込む。
import { ROOT_PATH, FIREBASE_SDK_BASE, FB_CONFIG, EMU } from './online-config.js';

const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
export const SERVER_TS = Object.freeze({ '.sv': 'timestamp' });
// 偽バス：サーバー時刻の置き換え値を、書き込みの時刻に置き換える
const resolveTs = (v, now) => {
  if (v && typeof v === 'object') {
    if (v['.sv'] === 'timestamp') return now;
    const o = Array.isArray(v) ? [] : {};
    for (const [k, x] of Object.entries(v)) o[k] = resolveTs(x, now);
    return o;
  }
  return v;
};
const split = (p) => String(p).split('/').filter(Boolean);

// ---- メモリ上の偽バス ----
export function createMemoryBus({ now = () => Date.now() } = {}) {
  let tree = null;
  const listeners = new Set();
  const disconnectOps = new Map(); // uid → Map(path → value)
  let seq = 0;

  const read = (path) => {
    let n = tree;
    for (const k of split(path)) { if (n === null || typeof n !== 'object' || !(k in n)) return null; n = n[k]; }
    return clone(n);
  };
  const writeRaw = (path, value) => {
    const ks = split(path);
    const v = clone(resolveTs(value, now()));
    if (!ks.length) { tree = v; return; }
    if (tree === null || typeof tree !== 'object') tree = {};
    const stack = [];
    let n = tree;
    for (const k of ks.slice(0, -1)) {
      if (n[k] === null || typeof n[k] !== 'object') n[k] = {};
      stack.push([n, k]);
      n = n[k];
    }
    const last = ks[ks.length - 1];
    if (v === null) delete n[last]; else n[last] = v;
    // 空になった親を消す（RTDB と同じく空のノードは存在しない）
    for (let i = stack.length - 1; i >= 0; i--) {
      const [p, k] = stack[i];
      if (p[k] && typeof p[k] === 'object' && !Object.keys(p[k]).length) delete p[k];
    }
    if (tree && typeof tree === 'object' && !Object.keys(tree).length) tree = null;
  };
  const notify = () => {
    for (const l of [...listeners]) {
      const v = read(l.path);
      const j = JSON.stringify(v);
      if (j !== l.last) { l.last = j; l.cb(v); }
    }
  };
  const write = (path, value) => { writeRaw(path, value); notify(); };

  const bus = {
    read, write,
    dump: () => clone(tree),
    // 端末の切断を再現：その uid の onDisconnect を実行し、その uid の購読を止める
    drop(uid) {
      const ops = disconnectOps.get(uid);
      disconnectOps.delete(uid);
      if (ops) for (const [p, v] of ops) { if (p.startsWith('update:')) { for (const [k, x] of Object.entries(v)) writeRaw(`${p.slice(7)}/${k}`, x); } else writeRaw(p, v); }
      for (const l of [...listeners]) if (l.uid === uid) listeners.delete(l);
      notify();
    },
    transport(uid = `mem-${++seq}`) {
      let closed = false;
      const guard = () => { if (closed) throw Error('transport-closed'); };
      return {
        uid,
        kind: 'memory',
        now,
        TS: SERVER_TS,
        async get(path) { guard(); return read(path); },
        async set(path, v) { guard(); write(path, v); },
        async update(path, obj) {
          guard();
          for (const [k, v] of Object.entries(obj)) writeRaw(`${path}/${k}`, v);
          notify();
        },
        async remove(path) { guard(); write(path, null); },
        async transaction(path, fn) {
          guard();
          const cur = read(path);
          const nv = fn(clone(cur));
          if (nv === undefined) return { committed: false, value: cur };
          write(path, nv);
          return { committed: true, value: read(path) };
        },
        onValue(path, cb) {
          guard();
          const l = { uid, path, cb, last: undefined };
          listeners.add(l);
          queueMicrotask(() => { if (listeners.has(l)) { const v = read(path); l.last = JSON.stringify(v); cb(v); } });
          return () => listeners.delete(l);
        },
        async onDisconnectSet(path, v) {
          guard();
          if (!disconnectOps.has(uid)) disconnectOps.set(uid, new Map());
          disconnectOps.get(uid).set(path, clone(v));
        },
        async onDisconnectUpdate(path, obj) {
          guard();
          if (!disconnectOps.has(uid)) disconnectOps.set(uid, new Map());
          disconnectOps.get(uid).set(`update:${path}`, clone(obj));
        },
        async cancelOnDisconnect(path) { const m = disconnectOps.get(uid); if (m) { m.delete(path); m.delete(`update:${path}`); } },
        close() {
          closed = true;
          for (const l of [...listeners]) if (l.uid === uid) listeners.delete(l);
        },
      };
    },
  };
  return bus;
}

// ---- Firebase（modular SDK）----
// load：SDK のモジュールを返す関数（試験で npm の firebase を渡せるように差し替え可能）。既定は gstatic から動的 import。
export async function loadFirebaseSdk(base = FIREBASE_SDK_BASE) {
  const [app, auth, db] = await Promise.all([
    import(/* @vite-ignore */ `${base}firebase-app.js`),
    import(/* @vite-ignore */ `${base}firebase-auth.js`),
    import(/* @vite-ignore */ `${base}firebase-database.js`),
  ]);
  return { app, auth, db };
}

// emulator：true ならエミュレータ（demo- プロジェクト）へ。false なら FB_CONFIG（本番。段階4まで使わない）
// 匿名認証の uid は「アプリ名」ごとに端末へ保存されるので、アプリ名は固定する（入り直しで自分の席に戻れるように・docs/79「8.2」）。
// 同じページで入口に入り直すときは、同じアプリを使い回して接続だけをつなぎ直す。
const apps = new Map();
export async function createFirebaseTransport({ emulator = false, load = loadFirebaseSdk, appName = emulator ? 'mathjong-online-emu' : 'mathjong-online' } = {}) {
  const sdk = await load();
  let entry = apps.get(appName);
  if (entry && entry.sdk !== sdk) entry = null; // 試験で SDK を差し替えたとき
  if (!entry) {
    const config = emulator
      ? { apiKey: 'demo-key', projectId: EMU.projectId, databaseURL: `http://${EMU.dbHost}:${EMU.dbPort}?ns=${EMU.projectId}-default-rtdb` }
      : FB_CONFIG;
    const app = sdk.app.getApps().find((a) => a.name === appName) || sdk.app.initializeApp(config, appName);
    const auth = sdk.auth.getAuth(app);
    const db = sdk.db.getDatabase(app);
    if (emulator) {
      sdk.auth.connectAuthEmulator(auth, `http://${EMU.authHost}:${EMU.authPort}`, { disableWarnings: true });
      sdk.db.connectDatabaseEmulator(db, EMU.dbHost, EMU.dbPort);
    }
    entry = { sdk, app, auth, db };
    apps.set(appName, entry);
  } else sdk.db.goOnline(entry.db);
  const { auth, db } = entry;
  const cred = await sdk.auth.signInAnonymously(auth);
  const uid = cred.user.uid;
  const D = sdk.db;
  const r = (path) => D.ref(db, `${ROOT_PATH}/${path}`);
  let offset = 0;
  const offUnsub = D.onValue(D.ref(db, '.info/serverTimeOffset'), (s) => { offset = Number(s.val()) || 0; });
  const subs = new Set();
  let closed = false;
  return {
    uid,
    kind: emulator ? 'emulator' : 'firebase',
    now: () => Date.now() + offset,
    TS: SERVER_TS,
    async get(path) { return (await D.get(r(path))).val(); },
    set: (path, v) => D.set(r(path), v),
    update: (path, obj) => D.update(r(path), obj),
    remove: (path) => D.remove(r(path)),
    async transaction(path, fn) {
      const res = await D.runTransaction(r(path), (cur) => fn(cur), { applyLocally: false });
      return { committed: res.committed, value: res.snapshot.val() };
    },
    onValue(path, cb, onError) {
      const un = D.onValue(r(path), (s) => cb(s.val()), (e) => { if (onError) onError(e); });
      subs.add(un);
      return () => { subs.delete(un); un(); };
    },
    onDisconnectSet: (path, v) => D.onDisconnect(r(path)).set(v),
    onDisconnectUpdate: (path, obj) => D.onDisconnect(r(path)).update(obj),
    cancelOnDisconnect: (path) => D.onDisconnect(r(path)).cancel(),
    close() {
      if (closed) return;
      closed = true;
      for (const un of subs) un();
      subs.clear();
      offUnsub();
      try { D.goOffline(db); } catch { /* 閉じるだけ（切断で onDisconnect が働く） */ }
    },
  };
}
