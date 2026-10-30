// 再現 URL（Ver.0.4-A）：読み取り・整合性の検証・出力（URL の組み立て）を1か所にまとめる。画面から独立した純粋関数。
// tests/replay.test.js で検証。ゲームが出力する URL は、必ずここの検証を通る（出力と入力を同じ定義にそろえる）。
//
// URL の種類
//   none   ：seed がない、または seed が不正 → 再現ではない（タイトル画面から）
//   legacy ：従来形式 ?seed=S[&round=n]（hand・renchan・dealer がない）。親は (n−1) mod 4、親番は n−1（局数の範囲に丸める）。
//   replay ：新形式 ?seed&round&dealer&hand&renchan&len[&mode][&ai]（hand・renchan・dealer のどれかがある）。
//   ai（Ver.0.4-B、任意）：AI 難易度 beginner|intermediate|advanced。どちらの形式でも指定でき、不正ならエラー。
//            足りない項目は従来形式と同じ既定値で補い、組み合わせ全体を検証する。
//   chars（Ver.0.6、任意）：自由選択の対戦相手。席1〜3（下家・対面・上家）の順のキャラクターID（カンマ区切り、異なる3人）。
//            ai より優先する。不正ならエラー。ゲームが出力する URL は、自由選択の対局では chars を使う。
//   newrules（任意）：ルールの版（ruleset）。付いていない URL は従来ルール（0）。1＝新ルール初版（王牌・ドラ・暗カン・数学Ⅱ通常ツモ24回、
//            PR #44 の局）、2＝現行の新ルール（1 に加えてフリテン・関数牌のポン禁止）。それ以外の値はエラー。
//            ゲームが出力する URL は、その局の版を必ず付ける（現行の対局は newrules=2）。過去の URL はその版のまま再現する。
// 指定された項目が1つでも不正なら、別の局面として黙って始めずに ok=false（errors に理由）を返す。
import { intParam, MAX_SEED, MAX_ROUND, MAX_RENCHAN } from './params.js';
import { parseChars } from './opponents.js';

export const REPLAY_LENGTHS = [1, 4, 8];
const MODES = ['math1', 'math2'];
export const REPLAY_AI_LEVELS = ['beginner', 'intermediate', 'advanced'];
// 再現 URL の newrules の値（ルールの版）。現行の版は CURRENT_RULESET（新しく始める対局はすべてこの版）
const RULESETS = ['1', '2'];
export const CURRENT_RULESET = 2;

// params：URLSearchParams と同じ has/get を持つもの。defaultLen：URL に len がないときの局数（保存値など）
export function validateReplay(params, { defaultLen = 4 } = {}) {
  if (!params.has('seed')) return { kind: 'none', ok: true, errors: [], values: null };
  const seed = intParam(params.get('seed'), MAX_SEED);
  if (seed === null) return { kind: 'none', ok: true, errors: [], values: null };

  const errors = [];
  const bad = (key, message) => errors.push({ key, message });
  const num = (key, max, min = 0) => {
    if (!params.has(key)) return undefined;
    const v = intParam(params.get(key), max);
    if (v === null || v < min) { bad(key, `${key} が範囲外または不正な値です（${min}〜${max} の整数）`); return null; }
    return v;
  };
  const fresh = params.has('hand') || params.has('renchan') || params.has('dealer');

  let len = defaultLen;
  const lenRaw = num('len', 8);
  if (lenRaw !== undefined && lenRaw !== null) {
    if (REPLAY_LENGTHS.includes(lenRaw)) len = lenRaw; else bad('len', 'len は 1・4・8 のいずれかです');
  }
  const roundRaw = num('round', MAX_ROUND, 1);
  const handRaw = num('hand', 7);
  const renchanRaw = num('renchan', MAX_RENCHAN);
  const dealerRaw = num('dealer', 3);
  let mode = null;
  if (params.has('mode')) {
    mode = params.get('mode');
    if (!MODES.includes(mode)) { bad('mode', 'mode は math1 または math2 です'); mode = null; }
  }
  let ai = null;
  if (params.has('ai')) {
    ai = params.get('ai');
    if (!REPLAY_AI_LEVELS.includes(ai)) { bad('ai', 'ai は beginner・intermediate・advanced のいずれかです'); ai = null; }
  }

  let chars = null;
  if (params.has('chars')) {
    chars = parseChars(params.get('chars'));
    if (!chars) bad('chars', 'chars は異なる3人のキャラクターID（席1〜3の順、カンマ区切り）です');
  }

  let ruleset = 0;
  if (params.has('newrules')) {
    const v = params.get('newrules');
    if (RULESETS.includes(v)) ruleset = Number(v);
    else bad('newrules', 'newrules は 1（新ルール初版）または 2（現行の新ルール）です。従来ルールでは付けません');
  }

  const round = roundRaw ?? 1;
  const hand = handRaw ?? Math.min(round - 1, len - 1);
  const dealer = dealerRaw ?? (round - 1) % 4;
  const renchan = renchanRaw ?? 0;

  // 局状態の整合性（新形式のみ。従来形式には hand・renchan がないので適用しない）
  if (fresh && errors.length === 0) {
    if (hand > len - 1) bad('hand', `${len}局戦の親番は 0〜${len - 1} です（hand=${hand}）`);
    if (len === 1 && renchan > 0) bad('renchan', `1局戦は連荘しません（renchan=${renchan}）`);
    if (len === 1 && round > 1) bad('round', `1局戦の通し局数は 1 だけです（round=${round}）`);
    // 親番 hand に着くまでに少なくとも hand 局、その親番の連荘 renchan 局を終えている。現在の局はその次なので
    // 通し局数 round は hand + renchan + 1 以上でなければ、正規の進行では起こり得ない。
    if (round < hand + renchan + 1) bad('round', `通し局数 ${round} は、親番 ${hand} と連荘 ${renchan} の局状態に必要な ${hand + renchan + 1} 局より小さく、不可能な局状態です`);
  }
  return { kind: fresh ? 'replay' : 'legacy', ok: errors.length === 0, errors, values: { seed, round, hand, renchan, dealer, len, lenGiven: lenRaw !== undefined && lenRaw !== null, mode, ai, chars, ruleset, newRules: ruleset >= 1 } };
}

// 再現 URL のクエリ（先頭の ? 付き）。ゲームが出力する形式。mode・ai・chars が null なら省く。chars があれば ai は出さない。
// ruleset（ルールの版）が1以上なら末尾に newrules=版（従来ルールの URL は従来と同じ文字列）。newRules: true は版1（PR #44 の呼び出し）。
export function replayQuery({ seed, round, dealer, hand, renchan, len, mode = null, ai = null, chars = null, newRules = false, ruleset = newRules ? 1 : 0 }) {
  const who = chars ? `&chars=${chars.join(',')}` : ai ? `&ai=${ai}` : '';
  return `?seed=${seed}&round=${round}&dealer=${dealer}&hand=${hand}&renchan=${renchan}&len=${len}${mode ? `&mode=${mode}` : ''}${who}${ruleset ? `&newrules=${ruleset}` : ''}`;
}
