// ロン後半の演出の E2E 判定（tests/e2e/play.mjs の v05eCutin (3) で使う。単体テスト：tests/e2e-ron-late.test.js）。
// ロン演出（2.2 秒）の CSS：中央の表示は 1.10〜1.28 秒で消え、最上部の帯は 1.28〜2.02 秒に不透明。
// 演出の開始から上限（帯が消え始める前の 2.0 秒）までに、中央が消えて帯に替わった状態を観測できれば成功。
// 上限を過ぎた観測は、表示の条件を満たしていても失敗（上限の後に初めて条件を満たした場合を合格にしない）。
export const RON_LATE_LIMIT_MS = 2000;

// 表示の条件：中央の不透明度 < 0.05、帯の不透明度 > 0.95、帯が画面上部（上端 0 以上・下端 70px 以下）
export function ronLateShown(obs) {
  const { card, banner } = obs;
  return !!card && !!banner && card.op < 0.05 && banner.op > 0.95 && banner.t >= 0 && banner.b <= 70;
}

// 1回の観測 { elapsed（演出の開始からの ms）, card, banner } を判定する。
// 'ok'：上限以内に条件を満たした／'fail'：上限を過ぎた（条件を満たしていても失敗）／'wait'：まだ（もう一度観測する）
export function judgeRonLate(obs, limit = RON_LATE_LIMIT_MS) {
  if (!(obs.elapsed <= limit)) return 'fail';
  return ronLateShown(obs) ? 'ok' : 'wait';
}
