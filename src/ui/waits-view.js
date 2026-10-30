// 聴牌の待ちの表示（docs/65）：画面だけの補助。公開情報（自分の view：自分の手牌・全員の河・公開面子・ドラ表示牌）だけで計算し、
// 他家の手牌・山の並びは参照しない。tests/waits-view.test.js で検証。
//   ・リーチ中：リーチ確定時の待ち（riichiWaits）
//   ・自分の番（9枚）：捨てる候補の牌（selected）を選ぶと、その牌を捨てた後の待ち。選んでいなければ表示しない
//   ・それ以外（8枚）：いまの手の待ち（聴牌でなければ表示しない）
// 各待ちには「役があって和了できるか」（鳴いた手は役が必要）と、自分から見えていない残り枚数を付ける。
import { unseenFromView } from '../engine/yakuhint.js';

// view：Game.viewFor(seat)。opts：{ selected：捨てる候補の牌の id（自分の番だけ）、riichiWaits：リーチの待ち（その席の非公開情報）、myTurn }
// 戻り値：null（表示なし）または { kind: 'riichi' | 'tenpai' | 'after-discard', waits: [{ type, winnable, unseen }] }
export function tenpaiWaitsView(rules, view, { selected = null, riichiWaits = null, myTurn = false } = {}) {
  const seat = view.seat;
  const own = view.melds[seat];
  const exposed = own.map((m) => m.meld);
  const closed = own.every((m) => m.call === 'ankan');
  let kind, hand;
  if (riichiWaits) kind = 'riichi';
  else if (myTurn) {
    if (selected === null || selected === undefined) return null;
    if (!view.hand.some((h) => h.id === selected)) return null;
    kind = 'after-discard';
    hand = view.hand.filter((h) => h.id !== selected);
  } else {
    kind = 'tenpai';
    hand = view.hand;
  }
  const counts = rules.types.map(() => 0);
  const handOf = hand || view.hand.filter((h) => !myTurn || h.id !== view.drawn);
  for (const h of handOf) counts[h.type]++;
  let types = riichiWaits;
  if (!types) {
    types = [];
    for (let t = 0; t < counts.length; t++) {
      if (counts[t] >= rules.types[t].copies) continue;
      counts[t]++;
      // 和了の形（役の有無は問わない）。待ちの判定はエンジンの waitsOf と同じ
      if (rules.analyzeWin(counts, exposed, { closed: true })) types.push(t);
      counts[t]--;
    }
  }
  if (!types.length) return null;
  const unseen = unseenFromView(rules, view);
  const waits = types.map((t) => {
    counts[t]++;
    // 実際に和了できるか：鳴いた手は役が必要（ロンで判定。ツモでも役の条件は同じ）
    const winnable = !!rules.analyzeWin(counts, exposed, { closed, ron: true });
    counts[t]--;
    return { type: t, winnable, unseen: Math.max(0, unseen[t]) };
  });
  return { kind, waits };
}
