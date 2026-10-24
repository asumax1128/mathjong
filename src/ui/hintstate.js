// ヒント表示中の自動更新の判定（Ver.0.2-A）。
// 役候補が参照する公開情報（自分の手牌・全員の河・全員の公開面子・現在の宣言対象牌と宣言状態）から
// キーを作り、キーが変わったときだけ再計算する（不要な連続再計算をしない）。
// view は Game.viewFor(seat)、claim は claimForSeat() の値（どちらも公開情報と自分の情報だけ）。
export function hintKey(view, claim) {
  return JSON.stringify({
    hand: view.hand.map((h) => h.id).sort((a, b) => a - b),
    rivers: view.rivers,
    melds: view.melds.map((ms) => ms.map((m) => [m.meld, m.from])),
    claim: claim ? [claim.type, claim.from, claim.ron, claim.chiMelds] : null,
  });
}
