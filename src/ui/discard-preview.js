// 選んだ牌を捨てた後の聴牌プレビュー（docs/71）：画面だけの補助。対局の状態は変えない。
// 計算に使う情報：自分の view（自分の手牌・全員の河・公開面子・ドラ表示牌）と、自分だけが知る情報
// （自分が捨てた牌の種類＝鳴かれて河から移った牌も含む、自分の同巡の見逃し）。他家の手牌・山の並び・未来の牌は参照しない。
// 待ちの計算は既存の tenpaiWaitsView（src/ui/waits-view.js）を再利用する。tests/discard-preview.test.js で検証。
import { tenpaiWaitsView } from './waits-view.js';

// opts：
//   selected：選んだ牌の id（自分の手牌）
//   myTurn：自分の通常の打牌番か（ロン・ポン・チーの判断中や他家の番は false）
//   inRiichi：自分がリーチ中か（ツモ切りだけなのでプレビューしない。待ちは既存の表示）
//   legalIds：いま捨てられる牌の id（画面の打牌条件と同じ。暗カンの確認中などは空）
//   furitenRule：フリテンの規則が有効か（ruleset 2）
//   discardedTypes：自分がこの局に捨てた牌の種類（Set。鳴かれた牌も含む。エンジンの discarded と同じ）
//   tempFuriten：自分の同巡の見逃し（エンジンの tempFuriten。自分の次の通常ツモまで続く）
// 戻り値：null（表示しない）または
//   { selectedType, tenpai, waits: [{ type, winnable, unseen }], yaku: 'all' | 'some' | 'none' | null,
//     furiten: { ron: boolean, discard: [type…], temporary: boolean } | null, others: 'tenpai' | 'none' | null }
//   ・tenpai：その牌を捨てた後の手が聴牌（和了の形になる牌がある。役の有無は問わない＝エンジンの待ちと同じ）
//   ・yaku：待ちのうち役があって和了できるもの（all：全部、some：一部、none：どれも役なし）
//   ・furiten：捨てた後にロンできないか（discard：捨てた牌の種類に待ちがある＝選んだ牌を含む。temporary：同巡の見逃しが続く）
//   ・others：聴牌にならない場合だけ、ほかの捨てられる牌（種類）で聴牌になるものがあるか（どの牌かは返さない）
export function discardPreview(rules, view, {
  selected = null, myTurn = false, inRiichi = false, legalIds = null,
  furitenRule = false, discardedTypes = null, tempFuriten = false,
} = {}) {
  if (!myTurn || inRiichi || selected === null || selected === undefined) return null;
  const sel = view.hand.find((h) => h.id === selected);
  if (!sel) return null;
  const legal = legalIds ? new Set(legalIds) : new Set(view.hand.map((h) => h.id));
  if (!legal.has(selected)) return null;
  const tw = tenpaiWaitsView(rules, view, { selected, myTurn: true });
  const waits = tw ? tw.waits : [];
  const tenpai = waits.length > 0;
  let yaku = null;
  let furiten = null;
  let others = null;
  if (tenpai) {
    const n = waits.filter((w) => w.winnable).length;
    yaku = n === waits.length ? 'all' : n > 0 ? 'some' : 'none';
    if (furitenRule) {
      const river = new Set(discardedTypes || []);
      river.add(sel.type); // 選んだ牌は捨てた後に自分の捨て牌になる
      const discard = waits.map((w) => w.type).filter((t) => river.has(t));
      const temporary = !!tempFuriten;
      furiten = { ron: discard.length > 0 || temporary, discard, temporary };
    }
  } else {
    // 比較は最小限：選んだ牌と違う種類の牌を、種類ごとに1枚だけ調べ、聴牌になる牌が見つかった時点でやめる
    others = 'none';
    const seen = new Set([sel.type]);
    for (const h of view.hand) {
      if (seen.has(h.type) || !legal.has(h.id)) continue;
      seen.add(h.type);
      if (tenpaiWaitsView(rules, view, { selected: h.id, myTurn: true })) { others = 'tenpai'; break; }
    }
  }
  return { selectedType: sel.type, tenpai, waits, yaku, furiten, others };
}

// 表示の文言（docs/71 の確定文例）。「正解」「不正解」「必ず和了できる」「山に N 枚ある」とは言わない。
export const PREVIEW_TEXT = {
  tenpai: 'この牌を捨てると聴牌です',
  notTenpai: 'この牌を捨てると聴牌にはなりません',
  othersTenpai: '別の牌なら聴牌にできます',
  othersNone: 'どの牌を捨てても、まだ聴牌にはなりません',
  noYaku: '和了の形ですが、役がありません',
  someNoYaku: '一部の待ちは和了の形ですが、役がありません',
  furiten: 'フリテンのためロンできません（ツモは別判定）',
  unseenNote: '見えていない牌の数は、山に残っている数ではありません（他家の手牌にある場合もあります）',
};
