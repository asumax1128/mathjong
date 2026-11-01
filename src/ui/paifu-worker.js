// 牌譜の保存前の検証（記録された選択の再生）と正規化 JSON の作成を、主スレッドの外（Web Worker・module）で行う（docs/74）。
// ゲームの状態・乱数・DOM・保存には触れない。受け取った記録を検証して JSON を返すだけ。検証は省略しない。
import { encodePaifu } from '../engine/paifu.js';

self.onmessage = (e) => {
  const { id, record } = e.data || {};
  try {
    self.postMessage({ id, ok: true, json: encodePaifu(record) });
  } catch (err) {
    self.postMessage({ id, ok: false, path: err && err.path ? String(err.path) : 'record', message: String(err && err.message ? err.message : err) });
  }
};
