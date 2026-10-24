// URL パラメータと保存値の検証（画面から独立した純粋関数。tests/params.test.js で検査）

// 公開サイトで選べる AI の速さ [手番の待ち, 鳴き判断の待ち]（ミリ秒）
const PUBLIC_SPEEDS = new Map([
  ['fast', [250, 120]],
  ['normal', [700, 350]],
  ['slow', [1200, 600]],
]);
// ローカル開発環境の自動テスト専用
const TEST_SPEED = ['test', [0, 0]];

export const DEFAULT_SPEED = 'normal';

export function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

// 選べる速さの一覧（Map なので Object.prototype 由来の名前は含まれない）
export function speedTable(isLocal) {
  return isLocal ? new Map([...PUBLIC_SPEEDS, TEST_SPEED]) : new Map(PUBLIC_SPEEDS);
}

export const publicSpeedNames = () => [...PUBLIC_SPEEDS.keys()];

// URL の ?speed= → 保存値 → 既定値 の順に、許可された名前だけを採用する。
// 'test' は URL 指定かつローカル環境のときだけ有効（保存値としては受け付けない）。
export function resolveSpeed(query, saved, isLocal) {
  const table = speedTable(isLocal);
  if (typeof query === 'string' && table.has(query)) return query;
  if (typeof saved === 'string' && PUBLIC_SPEEDS.has(saved)) return saved;
  return DEFAULT_SPEED;
}

// 速さの名前 → 待ち時間。未知の名前は既定値の待ち時間。
export function speedDelays(name, isLocal) {
  const table = speedTable(isLocal);
  return table.get(name) || table.get(DEFAULT_SPEED);
}

// 0〜max の整数（先頭ゼロ可・最大9桁）。それ以外は null。
export function intParam(value, max) {
  return typeof value === 'string' && /^\d{1,9}$/.test(value) && Number(value) <= max ? Number(value) : null;
}
