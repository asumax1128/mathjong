// Ver.0.7 麻雀卓の配置の計算（画面専用の純粋関数。ゲームの状態は変更しない）。tests/table-layout.test.js で検査。
// 席：0 自分（下）・1 下家（右）・2 対面（上）・3 上家（左）。

export const SEAT_AREA = Object.freeze(['me', 'right', 'top', 'left']);
// 席の向き：その席の人から見た向きのまとまり（河・公開面子・裏向きの手牌）を、この角度だけ回転して置く
export const SEAT_ROT = Object.freeze([0, -90, 180, 90]);
export const RIVER_ROW = 6;
export const TILE_RATIO = 30 / 22; // 牌の高さ／幅

const isSide = (seat) => seat === 1 || seat === 3;

// 河の行（捨てた順の位置 [始め, 終わり) の配列）。行は卓の中央に近い順。
// 自分・対面は6枚ごとに折り返す（19枚目以降は4行目以降）。左右は卓の幅に限りがあるため、
// 実際の麻雀と同じく3行目を延長する（1〜6・7〜12・13枚目以降）。
export function riverRows(seat, n) {
  const rows = [];
  for (let i = 0; i < n; i += RIVER_ROW) {
    if (isSide(seat) && i >= 2 * RIVER_ROW) { rows.push([i, n]); break; }
    rows.push([i, Math.min(n, i + RIVER_ROW)]);
  }
  return rows;
}

// 卓の大きさ（牌の枚数の単位）。lengths：席ごとの河の枚数。
// top / bottom：対面・自分の河の行数（最低3）。lenLeft / lenRight：左右の河の最も長い行の枚数（最低6）。
// 左右の河の3行目の延長は、まずその席の右手側の角（上家は左下、下家は右上）へ入り、
// 角の高さに入りきらない分だけ卓の中央を縦に伸ばす（side：中央の縦の長さ）。
export function boardShape(lengths) {
  const top = Math.max(3, Math.ceil(lengths[2] / RIVER_ROW));
  const bottom = Math.max(3, Math.ceil(lengths[0] / RIVER_ROW));
  const len = (s) => Math.max(RIVER_ROW, lengths[s] - 2 * RIVER_ROW);
  const capLeft = Math.floor(bottom * TILE_RATIO);
  const capRight = Math.floor(top * TILE_RATIO);
  return { top, bottom, lenLeft: len(3), lenRight: len(1), side: Math.max(RIVER_ROW, len(3) - capLeft, len(1) - capRight) };
}
