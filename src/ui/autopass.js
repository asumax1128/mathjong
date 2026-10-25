// チー・ポンのオートパス（Ver.0.2-B チー、Ver.0.4-B でポンを追加）。画面だけの設定で、ゲームエンジンのルール・優先順位
// （ロン＞ポン＞チー）は変えない。すべて純粋関数（入力は変更しない）。tests/autopass.test.js で検証。
//
// 設定 settings は { chi: boolean, pon: boolean }。互換のため boolean だけを渡した場合は「チーのオートパス」の値として扱う
// （ポンは OFF）。
//   ・チー ON：チーの選択肢を表示しない（チーだけの宣言は自動で見送る）。
//   ・ポン ON：ポンの選択肢を表示しない（ポンだけの宣言は自動で見送る）。
//   ・表示する選択肢（ロン・表示するチー／ポン）が1つもなければ、宣言全体を自動で見送る。
//   ・ロンは決して隠さず、自動で見送らない（「ロンしない」で見送る）。ツモ（手番）は対象外。

export const CHI_AUTOPASS_KEY = 'mj-chi-autopass';
export const PON_AUTOPASS_KEY = 'mj-pon-autopass';

// 保存値：厳密に '1' のときだけ ON。未保存・異常値・読込失敗（null）はすべて OFF。
export function parseChiAutoPass(saved) {
  return saved === '1';
}
export const parsePonAutoPass = parseChiAutoPass;

// 設定の正規化：{ chi, pon }（どちらも厳密に true のときだけ ON）。boolean は従来のチー設定。
export function autoPassSettings(s) {
  if (typeof s === 'boolean' || s === undefined || s === null) return { chi: s === true, pon: false };
  return { chi: s.chi === true, pon: s.pon === true };
}

const isClaim = (p) => !!p && p.type === 'claim';
const hasChi = (p) => Array.isArray(p.chi) && p.chi.length > 0;

// 設定で隠す（＝見送る）鳴き：{ chi, pon }。その宣言で可能かつ設定 ON の鳴きを隠す。
// ただし隠すと表示する選択肢が何も残らない場合（ロン不可で、可能な鳴きがすべて ON）は、その宣言は自動パスの対象で、
// 画面に出るのは自動パスに失敗したときだけなので、通常の宣言操作へ戻すために何も隠さない。
export function hiddenCalls(p, settings) {
  const s = autoPassSettings(settings);
  if (!isClaim(p)) return { chi: false, pon: false };
  const h = { chi: s.chi && hasChi(p), pon: s.pon && !!p.pon };
  const left = !!p.ron || (hasChi(p) && !h.chi) || (!!p.pon && !h.pon);
  return left ? h : { chi: false, pon: false };
}

// 自動で見送る条件：その席の宣言待ち・ロン不可・チーかポンが可能・可能な鳴きがすべて設定で隠れる。
// ツモ（type 'turn'）・ロンが可能な宣言・終局（null）・他の席の宣言は決して対象にしない。
export function shouldAutoPass(p, seat, settings) {
  if (!isClaim(p) || p.seat !== seat || p.ron !== false) return false;
  const s = autoPassSettings(settings);
  const can = { chi: hasChi(p), pon: !!p.pon };
  if (!can.chi && !can.pon) return false;
  return (!can.chi || s.chi) && (!can.pon || s.pon);
}

// 互換（Ver.0.2-B）：チーのオートパスだけの判定
export function shouldAutoPassChi(p, seat, enabled) {
  return shouldAutoPass(p, seat, { chi: enabled === true, pon: false });
}

// 自動で見送った鳴きの種類（通知用。自動パスした宣言で可能だった鳴き）：'chi' | 'pon' | 'both' | null
export function autoPassedKind(p) {
  if (!isClaim(p)) return null;
  const chi = hasChi(p);
  const pon = !!p.pon;
  return chi && pon ? 'both' : chi ? 'chi' : pon ? 'pon' : null;
}

// 種類をまとめる（同じ手番までに複数回見送った場合）
export function mergeKind(a, b) {
  if (!a) return b || null;
  if (!b || a === b) return a;
  return 'both';
}

export function autoPassNotice(kind) {
  return { chi: 'チーを自動で見送りました', pon: 'ポンを自動で見送りました', both: 'チー・ポンを自動で見送りました' }[kind] || null;
}

// 宣言 UI に表示する選択肢。chi の index はエンジンの候補番号（respond の option）のまま。宣言待ちでなければ null。
export function visibleClaimActions(p, settings) {
  if (!isClaim(p)) return null;
  const h = hiddenCalls(p, settings);
  const chi = h.chi ? [] : p.chi.map((o, index) => ({ index, meld: o.meld }));
  const pon = p.pon && !h.pon ? { meld: p.pon.meld } : null;
  const note = h.chi && h.pon ? 'チー・ポンも見送ります' : h.chi ? 'チーも見送ります' : h.pon ? 'ポンも見送ります' : null;
  return {
    ron: !!p.ron,
    pon,
    chi,
    passLabel: p.ron ? 'ロンしない' : '見送る',
    passNote: note,
  };
}

// 役候補ヒントに渡す宣言待ち：画面に出す選択肢と同じ経路だけにする（表示しないチー・ポンは含めない）
export function claimPendingForHint(p, settings) {
  if (!isClaim(p)) return p;
  const h = hiddenCalls(p, settings);
  if (!h.chi && !h.pon) return p;
  return { ...p, chi: h.chi ? [] : p.chi, pon: h.pon ? null : p.pon };
}

// 宣言待ち1件ごとの表示方針。同じ宣言（key）の間は最初に決めた方針を保ち、
// 新しい宣言（別の key）ではその時点の設定から作り直す（古い key が新しい宣言を拒否しない）。
//   chi・pon:  この宣言に適用する設定（宣言の発生時点で固定）
//   autoPass:  互換（チーの設定と同じ値）
//   tried:     この宣言で自動パスを試みたか（同じ宣言で2回目は行わない）
export function claimPolicy(prev, key, settings) {
  if (prev && prev.key === key) return prev;
  const s = autoPassSettings(settings);
  return { key, chi: s.chi, pon: s.pon, autoPass: s.chi, tried: false };
}

// 方針の設定（hiddenCalls などに渡す形）
export const policySettings = (policy) => (policy ? { chi: policy.chi === true, pon: policy.pon === true } : { chi: false, pon: false });

// この宣言で、いま自動パスを実行するか（方針・未実行・条件の三つを満たすときだけ）
export function autoPassDue(policy, p, seat) {
  return !!policy && !policy.tried && shouldAutoPass(p, seat, policySettings(policy));
}
