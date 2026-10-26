// ロン・ポン・チーの視覚演出（Ver.0.5-B）。画面だけの機能で、ゲームのルール・判定・得点・進行には一切関わらない。
// このファイルは純粋関数だけ（DOM・タイマーを持たない）。表示は src/ui/app.js の演出レイヤーが担当する。
// ゲームの記録（Game.events）を読んで、どの演出をいつ出すかを決める。ゲーム状態は読むだけで変更しない。
// tests/effects.test.js で検証。

// 演出の仕様（ms：演出の長さ。prio：重なったときの優先度。ロン・ツモ ＞ リーチ ＞ ポン ＞ チー。ロンとツモは同じ局に同時には起きない）
// ツモ（Ver.0.5-C）：ロンと同格の派手さ。青白〜金で、ロン（赤金）と見分ける。自力で引き当てた達成感・神秘感（光の輪）を出す。
// ロン（Ver.0.5-D）：800ms → 1100ms に延長し、迫力を強化した。
// リーチ（Ver.0.5-D）：紫〜金・白銀の鋭い閃光と宣言牌の強調。ロン・ツモより短く（0.7秒）、ポン・チーより特別感を出す。
export const EFFECTS = {
  ron: { text: 'ロン！', ms: 1100, prio: 3 },
  tsumo: { text: 'ツモ！', ms: 1000, prio: 3 },
  riichi: { text: 'リーチ！', ms: 700, prio: 2.5 },
  pon: { text: 'ポン！', ms: 520, prio: 2 },
  chi: { text: 'チー！', ms: 420, prio: 1 },
};

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

// 新しく増えた記録（from 以降）から、出す演出を1つ選ぶ。優先度が最も高いもの（同じなら後のもの）。
// 戻り値：{ kind, event, index, next }（next：次回の from。演出がなくても進める）。events が from より短ければ（別の局）先頭から数え直す。
export function pickEffect(events, from) {
  const start = from > events.length ? 0 : from;
  let best = null;
  for (let i = start; i < events.length; i++) {
    const kind = effectKindOf(events[i]);
    if (!kind) continue;
    if (!best || EFFECTS[kind].prio >= EFFECTS[best.kind].prio) best = { kind, event: events[i], index: i };
  }
  return { ...(best || { kind: null, event: null, index: -1 }), next: events.length };
}

// いま表示中の演出 current（{ kind, startedAt }）がある間に、新しい演出 kind が来たとき表示を入れ替えるか。
// 終わっている／優先度が同じか高いなら入れ替える。表示中のロンを、後から来たポン・チーで潰さない。
export function shouldReplace(current, kind, now) {
  if (!current) return true;
  if (now - current.startedAt >= EFFECTS[current.kind].ms) return true;
  return EFFECTS[kind].prio >= EFFECTS[current.kind].prio;
}

// 演出の経過：再描画で作り直された要素のアニメーションを、続きから再生するための値。
export function fxProgress(current, now) {
  if (!current) return { active: false, elapsed: 0 };
  const elapsed = now - current.startedAt;
  return { active: elapsed >= 0 && elapsed < EFFECTS[current.kind].ms, elapsed: Math.max(0, elapsed) };
}

// 簡易表示（lite）または視差の少ない設定（reduced motion）では、文字だけ（揺れ・フラッシュ・発光なし）。
export const isLiteEffect = (mode, reducedMotion) => mode === 'lite' || reducedMotion === true;
