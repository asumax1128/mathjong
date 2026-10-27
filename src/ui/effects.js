// 宣言の視覚演出（Ver.0.5-B〜E）。画面だけの機能で、ゲームのルール・判定・得点・進行には一切関わらない。
// このファイルは純粋関数だけ（DOM・タイマーを持たない）。表示は src/ui/app.js の演出レイヤーが担当する。
// ゲームの記録（Game.events）を読んで、どの演出をいつ出すかを決める。ゲーム状態は読むだけで変更しない。
// tests/effects.test.js で検証。

// 演出の仕様（ms：演出の長さ。minMs：後ろに演出が待っているとき、最低限見せる時間。prio：優先度。ロン・ツモ ＞ リーチ ＞ ポン ＞ チー）
// ツモ（Ver.0.5-C）：ロンと同格の派手さ。青白〜金で、ロン（赤金）と見分ける。
// リーチ（Ver.0.5-D）：紫〜金・白銀の鋭い閃光と宣言牌の強調。
// Ver.0.5-E：カットイン演出に合わせて長くした（チー 1.0秒・ポン 1.2秒・ロン 2.2秒・ツモ 2.0秒・リーチ 0.9秒）。
//   登場を引き伸ばすのではなく、中央で文字・宣言者・牌を読める静止時間を取る。ロン・ツモは冒頭を強く、後半は落ち着いた表示にする。
//   ロン・ツモは短くしない（minMs＝ms）。チー・ポン・リーチは、後ろに演出が待っているときだけ minMs まで短くして順番に見せる。
export const EFFECTS = {
  ron: { text: 'ロン！', ms: 2200, minMs: 2200, prio: 3 },
  tsumo: { text: 'ツモ！', ms: 2000, minMs: 2000, prio: 3 },
  riichi: { text: 'リーチ！', ms: 900, minMs: 650, prio: 2.5 },
  pon: { text: 'ポン！', ms: 1200, minMs: 800, prio: 2 },
  chi: { text: 'チー！', ms: 1000, minMs: 700, prio: 1 },
};
export const isWinEffect = (kind) => kind === 'ron' || kind === 'tsumo';

// 演出キュー（Ver.0.5-E）：宣言が続いたとき、後の演出で前の演出がすぐ消されないよう、待たせて順番に見せる。
//   FX_QUEUE_MAX：待たせる演出の最大数（これを超えたら古いものから捨てる。無制限に溜めない）。
//   FX_QUEUE_STALE_MS：待っている間にこれより古くなった演出は出さない（場面とずれるため）。
export const FX_QUEUE_MAX = 2;
export const FX_QUEUE_STALE_MS = 2500;
// 退出の時間（Ver.0.5-E 監査 P3-A）：後ろに演出が待っていて最低表示時間で切り替えるとき、急に消さずに短く退出させる。
export const FX_EXIT_MS = 180;

export const EFFECT_MODE_KEY = 'mj-effects';
export const EFFECT_MODES = ['full', 'lite'];
// 保存値：'lite'（簡易）のときだけ簡易。未保存・異常値・読込失敗は通常（full）。
export const parseEffectMode = (saved) => (saved === 'lite' ? 'lite' : 'full');

// 記録1件 → 演出の種類（演出のない記録は null）。流局・打牌・牌を引く記録は対象外。
// リーチの記録は、エンジンが宣言を受け付けた（リーチが成立した）ときにだけ残る。ボタンを押しただけ・宣言牌の選択をやめた場合には記録がないので、演出も出ない。
export function effectKindOf(event) {
  if (!event) return null;
  if (event.type === 'chi') return 'chi';
  if (event.type === 'pon') return 'pon';
  if (event.type === 'riichi') return 'riichi';
  if (event.type === 'win' && event.how === 'ron') return 'ron';
  if (event.type === 'win' && event.how === 'tsumo') return 'tsumo';
  return null;
}

// 新しく増えた記録（from 以降）の宣言を、すべて記録の順に集める（Ver.0.5-E 監査 P2-A）。
// 以前は最も優先度の高い1件だけを選んでいたため、同じ回に増えた別の宣言（チー → ポン、ポン → リーチ）が演出キューに入る前に消えていた。
// 戻り値：{ offers, dropped, next }
//   offers：演出キューに渡す宣言（記録の順）。dropped：出さないと決めた宣言（明示的な破棄。音・声も鳴らさない）。
//   next：次回の from（宣言がなくても進める）。events が from より短ければ（別の局）先頭から数え直す。
//   同じ回にロン・ツモがあれば、和了だけをすぐ渡し、それより前の通常の宣言は破棄する（表示も音もなし）。
export function scanEffects(events, from) {
  const start = from > events.length ? 0 : from;
  const items = [];
  for (let i = start; i < events.length; i++) {
    const kind = effectKindOf(events[i]);
    if (kind) items.push({ kind, event: events[i], index: i });
  }
  const wins = items.filter((it) => isWinEffect(it.kind));
  if (wins.length) {
    const win = wins[wins.length - 1];
    return { offers: [win], dropped: items.filter((it) => it !== win), next: events.length };
  }
  return { offers: items, dropped: [], next: events.length };
}

// ---- 演出キュー（純粋関数。状態 { current, queue } を受け取り、新しい状態を返す。元の状態は変更しない）----
// current：表示中の演出 { kind, event, startedAt }（なければ null）。queue：待っている演出 [{ kind, event, at }]（at：届いた時刻）。
// 戻り値：{ current, queue, shown, dropped }。shown：current を今から表示する（効果音・声もこの時に鳴らす）。dropped：出さずに捨てた演出。
const isActive = (cur, now) => !!cur && now - cur.startedAt < EFFECTS[cur.kind].ms;

// 待っている演出を、古くなったものを捨てながら先頭から1つ取り出して表示する。なければ current は null。
export function fxAdvance(st, now) {
  const queue = st.queue.slice();
  const dropped = [];
  while (queue.length) {
    const it = queue.shift();
    if (now - it.at > FX_QUEUE_STALE_MS) { dropped.push(it); continue; }
    return { current: { kind: it.kind, event: it.event, startedAt: now }, queue, shown: true, dropped };
  }
  return { current: null, queue: [], shown: false, dropped };
}

// 新しい演出 item（{ kind, event }）が届いたとき。
//   ・ロン・ツモ：最優先。待っている演出をすべて捨て、表示中の演出を置き換えて、すぐ表示する。
//   ・表示中がロン・ツモ：後から来た低い演出は出さない（ロン・ツモを潰さない）。
//   ・それ以外：表示中の演出があれば待たせる（上限を超えたら古いものから捨てる）。なければすぐ表示する。
export function fxOffer(st, item, now) {
  const active = isActive(st.current, now);
  if (isWinEffect(item.kind)) {
    return { current: { kind: item.kind, event: item.event, startedAt: now }, queue: [], shown: true, dropped: st.queue.slice() };
  }
  if (active && isWinEffect(st.current.kind)) return { current: st.current, queue: st.queue.slice(), shown: false, dropped: [item] };
  const queue = [...st.queue, { kind: item.kind, event: item.event, at: now }];
  const dropped = [];
  while (queue.length > FX_QUEUE_MAX) dropped.push(queue.shift());
  if (active) return { current: st.current, queue, shown: false, dropped };
  const r = fxAdvance({ current: null, queue }, now);
  return { ...r, dropped: [...dropped, ...r.dropped] };
}

// 表示中の演出の時刻（now：いまの時刻）。{ leaveAt, endAt } または null（演出なし）。
//   endAt：表示を終えて次へ進む（または消す）時刻。
//   leaveAt：退出（P3-A）を始める時刻。後ろに演出が待っているときだけ。最低表示時間（minMs）を満たしてから退出し、FX_EXIT_MS 後に次へ。
//            退出を始めた後は current.leaveAt の時刻で固定する（後から演出が届いても延びない）。
//   待つ演出がない・ロン／ツモ・本来の終わりまでに退出が収まらないときは、本来の長さ（ms）で終える（CSS の終わりの消え方を使う）。
export function fxTimes(st, now) {
  if (!st.current) return null;
  const e = EFFECTS[st.current.kind];
  const s0 = st.current.startedAt;
  const natural = s0 + e.ms;
  if (!st.queue.length || isWinEffect(st.current.kind)) return { leaveAt: null, endAt: natural };
  const leaveAt = st.current.leaveAt ?? Math.max(now, s0 + e.minMs);
  if (leaveAt + FX_EXIT_MS >= natural) return { leaveAt: null, endAt: natural };
  return { leaveAt, endAt: leaveAt + FX_EXIT_MS };
}

// 演出の経過：再描画で作り直された要素のアニメーションを、続きから再生するための値。
export function fxProgress(current, now) {
  if (!current) return { active: false, elapsed: 0 };
  const elapsed = now - current.startedAt;
  return { active: elapsed >= 0 && elapsed < EFFECTS[current.kind].ms, elapsed: Math.max(0, elapsed) };
}

// 簡易表示（lite）または視差の少ない設定（reduced motion）では、文字だけ（揺れ・フラッシュ・発光なし）。
export const isLiteEffect = (mode, reducedMotion) => mode === 'lite' || reducedMotion === true;
