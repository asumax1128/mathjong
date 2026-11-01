// 牌譜の保存前の検証（記録された選択の再生）と正規化 JSON の作成を、主スレッドの外（Web Worker・module）で行う（docs/74）。
// ゲームの状態・乱数・DOM・保存には触れない。受け取った記録を検証して JSON を返すだけ。検証は省略しない。
import { encodePaifuSnapshot } from '../engine/paifu.js';

self.onmessage = (e) => {
  // snapshot：保存の開始時に主スレッドで作った、変更できない文字列（PR #69 第2回監査 P2-B）
  const { id, snapshot } = e.data || {};
  try {
    self.postMessage({ id, ok: true, json: encodePaifuSnapshot(snapshot) });
  } catch (err) {
    self.postMessage({ id, ok: false, path: err && err.path ? String(err.path) : 'record', message: String(err && err.message ? err.message : err) });
  }
};
