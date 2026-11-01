// 牌譜の機能の入口（docs/74）。app.js は起動時にこのモジュールを動的 import（import()）で読み込み、
// 読込・初期化の失敗・遅延・構文エラーでもゲーム（タイトル・通常対局・初心者の部屋）は起動・進行する（PR #69 監査 P2-3）。
// ・保存の前の検証（記録された選択の再生）は Web Worker で行い、主スレッドを止めない。Worker が使えない・失敗した
//   ときは主スレッドで分割して検証する（検証は省略しない）。
// ・削除の世代（epoch）：起動時に DB から読み、全件削除の後・別のタブからの通知（BroadcastChannel）で更新する。
//   試合の開始時の世代が分からないとき（読込前・保存できない端末）は、その試合を記録しない。
import { createPaifuStore, PAIFU_STORAGE_DEFAULTS } from './paifu-storage.js';
import { createPaifuRecorder, describePaifuStatus } from './paifu-recorder.js';
import { encodePaifuAsync } from '../engine/paifu.js';

const CHANNEL = 'mathjong-paifu';
const uint = (n) => Number.isSafeInteger(n) && n >= 0;

// Worker で encode する関数。失敗（作れない・エラー・時間切れ）したら、以後は主スレッドの分割検証（fallback）を使う
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
  const encode = (p) => {
    if (!broken && !worker) start();
    if (broken) return fallback(p);
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const retry = () => { fallback(p).then(resolve, reject); };
      const timer = setTimeout(() => { if (waiting.has(id)) giveUp(); }, timeoutMs);
      waiting.set(id, { resolve, reject, retry, timer });
      try { worker.postMessage({ id, record: p }); } catch { giveUp(); }
    });
  };
  encode.usingWorker = () => !broken && worker !== null;
  return encode;
}

// app.js から呼ぶ：記録の窓口・保存先・削除・件数・表示の文言
export function createPaifuSystem({ appVersion, onChange = () => {}, limits = {}, useWorker = true,
  workerUrl = new URL('./paifu-worker.js', import.meta.url), store: injectedStore = null } = {}) {
  const fallback = (p) => encodePaifuAsync(p); // 主スレッド：一定時間ごとにイベントループへ戻りながら検証
  const encode = useWorker && typeof Worker === 'function' ? createWorkerEncoder({ url: workerUrl, fallback }) : fallback;
  const store = injectedStore || createPaifuStore({ encode, ...limits });
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
  const recorder = createPaifuRecorder({ store, appVersion, onChange, epoch: () => ({ epoch, error: epochError }),
    onStaleEpoch: () => { refreshEpoch().catch(() => {}); } });
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
    describe: (st) => describePaifuStatus(st, { limits: { ...PAIFU_STORAGE_DEFAULTS, ...limits } }),
    epochState: () => ({ epoch, error: epochError }),
    // 通知の受信をやめる（テスト・終了時）
    close() { try { if (bc) bc.close(); } catch { /* 無視 */ } bc = null; },
    usingWorker: () => (typeof encode.usingWorker === 'function' ? encode.usingWorker() : false),
  });
}
