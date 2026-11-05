// 牌譜の機能の入口（docs/74）。app.js は起動時にこのモジュールを動的 import（import()）で読み込み、
// 読込・初期化の失敗・遅延・構文エラーでもゲーム（タイトル・通常対局・初心者の部屋）は起動・進行する（PR #69 監査 P2-3）。
// ・保存の前の検証（記録された選択の再生）は Web Worker で行い、主スレッドを止めない。Worker が使えない・失敗した
//   ときは主スレッドで分割して検証する（検証は省略しない）。
// ・削除の世代（epoch）：起動時に DB から読み、全件削除の後・別のタブからの通知（BroadcastChannel）で更新する。
//   試合の開始時に DB の現在の世代を読み直して結び付ける（src/ui/paifu-recorder.js の説明・PR #69 第2回監査 P2-A）。
//   新しい試合が始まりうる画面（タイトル・相手の選択・設定・最終結果）を開いたとき・タブに戻ったときにも読み直しておく（prefetch）。
import { createPaifuStore, PAIFU_STORAGE_DEFAULTS } from './paifu-storage.js';
import { createPaifuRecorder, describePaifuStatus } from './paifu-recorder.js';
import { encodePaifuSnapshotAsync } from '../engine/paifu.js';

const CHANNEL = 'mathjong-paifu';
const uint = (n) => Number.isSafeInteger(n) && n >= 0;
function deepFreeze(x) { if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.values(x).forEach(deepFreeze); Object.freeze(x); } return x; }

// Worker で encode する関数（入力は保存の開始時のスナップショット＝文字列）。失敗（作れない・エラー・時間切れ）したら、
// 以後は主スレッドの分割検証（fallback・同じスナップショット）を使う
export function createWorkerEncoder({ url, fallback, timeoutMs = 20000, makeWorker = (u) => new Worker(u, { type: 'module' }) }) {
  let worker = null, broken = false, seq = 0;
  const waiting = new Map();
  const giveUp = () => {
    broken = true;
    try { if (worker) worker.terminate(); } catch { /* 無視 */ }
    worker = null;
    for (const w of waiting.values()) { clearTimeout(w.timer); w.retry(); }
    waiting.clear();
  };
  function start() {
    try {
      worker = makeWorker(url);
      worker.onmessage = (e) => {
        const m = e.data || {}, w = waiting.get(m.id);
        if (!w) return;
        waiting.delete(m.id); clearTimeout(w.timer);
        if (m.ok === true && typeof m.json === 'string') w.resolve(m.json);
        else { const err = new Error(String(m.message || 'invalid')); err.path = String(m.path || 'record'); w.reject(err); }
      };
      worker.onerror = (ev) => { try { ev.preventDefault(); } catch { /* 無視 */ } giveUp(); };
      worker.onmessageerror = () => giveUp();
    } catch { broken = true; worker = null; }
  }
  const encode = (snapshot) => {
    if (!broken && !worker) start();
    if (broken) return fallback(snapshot);
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const retry = () => { fallback(snapshot).then(resolve, reject); };
      const timer = setTimeout(() => { if (waiting.has(id)) giveUp(); }, timeoutMs);
      waiting.set(id, { resolve, reject, retry, timer });
      try { worker.postMessage({ id, snapshot }); } catch { giveUp(); }
    });
  };
  encode.usingWorker = () => !broken && worker !== null;
  return encode;
}

// app.js から呼ぶ：記録の窓口・保存先・削除・件数・表示の文言
// storeHooks：テスト用（保存の途中で待つ。ローカルの検証だけ）
export function createPaifuSystem({ appVersion, onChange = () => {}, limits = {}, useWorker = true,
  workerUrl = new URL('./paifu-worker.js', import.meta.url), store: injectedStore = null, storeHooks = {} } = {}) {
  const fallback = (snapshot) => encodePaifuSnapshotAsync(snapshot); // 主スレッド：一定時間ごとにイベントループへ戻りながら検証
  const encode = useWorker && typeof Worker === 'function' ? createWorkerEncoder({ url: workerUrl, fallback }) : fallback;
  // 読込（振り返り）：本文の検証も Worker（使えなければ主スレッドで分割）で行う。検証は省略しない（docs/77）。
  // 結果は検証済みの正規化 JSON を読み直して凍結した記録（主スレッドで同期の再検証をしない＝画面を止めない）
  const decode = async (json) => deepFreeze(JSON.parse(await encode(json)));
  const store = injectedStore || createPaifuStore({ encode, decode, ...limits, hooks: storeHooks });
  let epoch = null, epochError = null;
  const learn = (n) => { if (uint(n) && (epoch === null || n > epoch)) epoch = n; };
  let bc = null;
  try {
    if (typeof BroadcastChannel === 'function') {
      bc = new BroadcastChannel(CHANNEL);
      bc.onmessage = (e) => { if (e.data && e.data.type === 'epoch') { learn(e.data.epoch); try { onChange(); } catch { /* 無視 */ } } };
    }
  } catch { bc = null; }
  async function refreshEpoch() {
    const r = await store.epoch();
    if (r.ok) { learn(r.epoch); epochError = null; } else epochError = r.error.code;
    return r;
  }
  // 試合の開始時：直前に読んだ世代（同期）と、DB の現在の世代（非同期・BroadcastChannel に依存しない）で結び付ける（P2-A）
  const recorder = createPaifuRecorder({ store, appVersion, onChange, epoch: () => ({ epoch, error: epochError }),
    readEpoch: async () => { const r = await refreshEpoch(); return r.ok ? { epoch: r.epoch, error: null } : { epoch: null, error: r.error.code }; },
    epochAt: typeof store.epochNow === 'function' ? () => store.epochNow() : null,
    onStaleEpoch: () => { refreshEpoch().catch(() => {}); } });
  try { if (typeof store.warm === 'function') store.warm(); } catch { /* 無視 */ } // 世代を読む接続を開いておく
  const ready = refreshEpoch().catch(() => ({ ok: false, error: { code: 'storage-error' } }));
  return Object.freeze({
    recorder, store, ready, refreshEpoch,
    // 全件削除：成功したら世代を覚え、別のタブへ知らせる
    async clearAll() {
      const r = await store.clearAll();
      if (r.ok) { learn(r.epoch); try { if (bc) bc.postMessage({ type: 'epoch', epoch: r.epoch }); } catch { /* 無視 */ } }
      return r;
    },
    list: () => store.list(),
    // 世代を読み直しておく（新しい試合が始まりうる画面を開いたとき）。失敗は無視（試合の開始時にも読み直す）
    prefetch() { refreshEpoch().catch(() => {}); },
    describe: (st) => describePaifuStatus(st, { limits: { ...PAIFU_STORAGE_DEFAULTS, ...limits } }),
    epochState: () => ({ epoch, error: epochError }),
    // 通知の受信をやめる（テスト・終了時）
    close() { try { if (bc) bc.close(); } catch { /* 無視 */ } bc = null; try { if (typeof store.close === 'function') store.close(); } catch { /* 無視 */ } },
    usingWorker: () => (typeof encode.usingWorker === 'function' ? encode.usingWorker() : false),
  });
}
