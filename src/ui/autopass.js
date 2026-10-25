// チーのオートパス（Ver.0.2-B、Ver.0.3-A でポンに対応）。画面だけの設定で、ゲームエンジンのルール・優先順位は変えない。
// すべて純粋関数（入力は変更しない）。tests/autopass.test.js で検証。

export const CHI_AUTOPASS_KEY = 'mj-chi-autopass';

// 保存値：厳密に '1' のときだけ ON。未保存・異常値・読込失敗（null）はすべて OFF。
export function parseChiAutoPass(saved) {
  return saved === '1';
}

// 自動で見送る条件：設定 ON・その席の宣言待ち・ロン不可・ポン不可・チー候補1件以上（＝チーだけができる）。
// ツモ（type 'turn'）・ロンやポンが可能な宣言・終局（null）・他の席の宣言は決して対象にしない。
export function shouldAutoPassChi(p, seat, enabled) {
  return enabled === true && !!p && p.type === 'claim' && p.seat === seat
    && p.ron === false && !p.pon && Array.isArray(p.chi) && p.chi.length > 0;
}

// ON のとき、ロンまたはポンも可能な宣言ではチーを表示しない（見送り対象。「ロンしない／見送る」でチーも見送る）
const hidesChi = (p, enabled) => enabled === true && (!!p.ron || !!p.pon);

// 宣言 UI に表示する選択肢。chi の index はエンジンの候補番号（respond の option）のまま。宣言待ちでなければ null。
export function visibleClaimActions(p, enabled) {
  if (!p || p.type !== 'claim') return null;
  const hideChi = hidesChi(p, enabled);
  const chi = hideChi ? [] : p.chi.map((o, index) => ({ index, meld: o.meld }));
  return {
    ron: !!p.ron,
    pon: p.pon ? { meld: p.pon.meld } : null,
    chi,
    passLabel: p.ron ? 'ロンしない' : '見送る',
    passNote: hideChi && p.chi.length > 0 ? 'チーも見送ります' : null,
  };
}

// 役候補ヒントに渡す宣言待ち：画面に出す選択肢と同じ経路だけにする（表示しないチーは含めない）
export function claimPendingForHint(p, enabled) {
  if (!p || p.type !== 'claim' || !hidesChi(p, enabled) || !p.chi.length) return p;
  return { ...p, chi: [] };
}

// 宣言待ち1件ごとの表示方針。同じ宣言（key）の間は最初に決めた方針を保ち、
// 新しい宣言（別の key）ではその時点の設定から作り直す（古い key が新しい宣言を拒否しない）。
//   autoPass: この宣言に適用する設定（宣言の発生時点で固定）
//   tried:    この宣言で自動パスを試みたか（同じ宣言で2回目は行わない）
export function claimPolicy(prev, key, enabled) {
  if (prev && prev.key === key) return prev;
  return { key, autoPass: enabled === true, tried: false };
}

// この宣言で、いま自動パスを実行するか（方針・未実行・条件の三つを満たすときだけ）
export function autoPassDue(policy, p, seat) {
  return !!policy && policy.autoPass && !policy.tried && shouldAutoPassChi(p, seat, true);
}
