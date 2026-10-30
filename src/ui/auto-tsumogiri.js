// リーチ後のオートツモ切り（画面だけの補助。ゲームの判定・進行の規則は変えない）。tests/auto-tsumogiri.test.js で検証。
// ON のとき、自分のリーチ中の通常ツモの後、ツモ和了できなければ、その牌を自動で捨てる。
// 止まる場面（自動で操作しない）：ツモ和了できる（和了か見送りかを本人が選ぶ）・他家の打牌の宣言（ロンなど。宣言には一切応答しない）・
// リーチしていない・自分の番でない・ツモ直後でない（ツモ牌がない）。
// 設定は局ごと（既定 OFF・保存しない）。リーチは局の終わりまでなので、新しい局・再戦・タイトルへ戻ると OFF に戻る。

// いま自動でツモ切りしてよいか。g：Game、seat：自分の席、on：設定
export function autoTsumogiriDue(g, seat, on) {
  if (!on || !g) return false;
  const p = g.pending();
  if (!p || p.seat !== seat || p.type !== 'turn') return false; // 宣言（ロンの判断など）・他家の番では動かない
  if (!g.riichi[seat]) return false;
  if (p.canTsumo) return false; // ツモ和了できる：本人が選ぶ
  if (!g.justDrew || g.drawn === null || g.drawn === undefined) return false;
  return g.hands[seat].includes(g.drawn);
}

// 自動で捨てる牌（リーチ中はツモ牌だけ。エンジンも同じ条件で検査する）
export const autoTsumogiriTile = (g) => g.drawn;
