// 対局（試合）の進行（Ver.0.4-A）：1局戦（東1局のみ・連荘なし）・4局戦（東1〜東4局）・8局戦（東1〜南4局）、親の連荘、親子の点数精算、順位。
// 1局の中身（配牌・和了判定・役・AI）は Game が担当し、ここは局と局の間だけを扱う純粋なロジック。
// 状態はコピーして返す（入力を変更しない）。tests/match.test.js で検証。

export const START_POINTS = 100;
export const MATCH_LENGTHS = [1, 4, 8];
const WINDS = ['東', '南'];

// 現行ルール（ruleset 2・docs/65）のリーチ宣言料
export const RIICHI_DEPOSIT = 5;

// length: 1 | 4 | 8、startDealer: 東1局の親の席（既定 0）
// riichiDeposit：リーチ宣言料（0＝なし。現行ルールは RIICHI_DEPOSIT）。agariYame：オーラスのアガリやめ（現行ルール）。
// どちらも既定はなし（従来の試合・過去の再現と同じ精算）。
export function createMatch({ length = 4, startDealer = 0, riichiDeposit = 0, agariYame = false } = {}) {
  if (!MATCH_LENGTHS.includes(length)) throw new Error(`unknown match length ${length}`);
  return {
    length,
    startDealer,
    riichiDeposit,
    agariYame,
    // 供託（場に出ているリーチ宣言料）：{ seat: 宣言者, label: 局名, hand, renchan, played: 何局目（0始まり）, points }。
    // 持ち点の合計＋供託の合計は常に 400（START_POINTS×4）
    pot: [],
    hand: 0, // 親番の通し番号（0 = 東1局、4 = 南1局）
    renchan: 0, // この親番での連荘回数（親が和了するたびに +1、親交代で 0）
    played: 0, // 実際に終えた局数（連荘を含む）
    renchanTotal: 0, // 試合全体の連荘回数
    scores: [START_POINTS, START_POINTS, START_POINTS, START_POINTS],
    wins: [0, 0, 0, 0], // 和了回数
    best: [0, 0, 0, 0], // 1回の和了で得た最高の点（精算後の増加分）
    bestBase: [0, 0, 0, 0], // その和了の基本点 B
    over: false,
    endReason: null, // 終了の理由：null（続行中）／'normal'（最終の親番が終わった通常終了）／'agari-yame'（オーラスの親が単独1位で終了）／'round-limit'（通し局数の上限で打ち切り）
    log: [], // 各局の記録 { label, dealer, renchan, result, deltas, dealerKeeps }
  };
}

// 親番 hand の親の席
export const dealerOf = (m, hand = m.hand) => (m.startDealer + hand) % 4;
// 局の表示名：東1局〜南4局
export const handLabel = (m, hand = m.hand) => `${WINDS[Math.floor(hand / 4)]}${(hand % 4) + 1}局`;

// 親子の点数精算。result: Game.result（{type:'win', winner, how, from, points} または {type:'draw'}）。
// B = 和了点（既存の役・役満の計算結果）。
//   子ロン：和了者 +4B、放銃者 −4B ／ 親ロン：和了者 +6B、放銃者 −6B
//   子ツモ：和了者 +4B、親 −2B、ほかの子 各 −B ／ 親ツモ：和了者 +6B、子3人 各 −2B
//   流局：移動なし
// 合計は常に 0（4人の持ち点の合計は変わらない）。
export function settle(result, dealer) {
  const d = [0, 0, 0, 0];
  if (!result || result.type !== 'win') return d;
  const B = result.points;
  const w = result.winner;
  const isDealer = w === dealer;
  if (result.how === 'ron') {
    const pay = (isDealer ? 6 : 4) * B;
    d[w] += pay;
    d[result.from] -= pay;
    return d;
  }
  for (let s = 0; s < 4; s++) {
    if (s === w) continue;
    const pay = isDealer ? 2 * B : s === dealer ? 2 * B : B;
    d[s] -= pay;
    d[w] += pay;
  }
  return d;
}

// 1局の結果を反映して次の状態を返す。親が和了すれば連荘（同じ親番）、子の和了・流局は親交代。
// 1局戦は連荘しない：親の和了・子の和了・流局（山切れ・四家立直）のどれでも、この1局で終わる。
// 最終の親番（4局戦の東4局・8局戦の南4局）が終わったら over（endReason 'normal'）。最終の親の連荘中は続く。
// アガリやめ（m.agariYame）：最終の親番で親が和了し、精算（供託を含む）後に単独1位なら連荘せずに終了（endReason 'agari-yame'）。
//   2位以下・同点の1位なら従来どおり連荘。
// opts：{ round, maxRound } 通し局数の上限。今の局の通し番号 round が maxRound に達したら、続くはずでも試合を終える
// （endReason 'round-limit'。連荘もここで終わる）。同じ局で通常の終了条件も満たすなら 'normal' を優先する
// （上限がなくても終わる試合なので、上限による打ち切りとは言わない）。精算は1回だけ行う。
// opts.riichi：その局のリーチ（Game.riichi：席ごとに null または { tile }）。リーチ宣言料（m.riichiDeposit）があるときだけ使う：
//   ・宣言牌がロンされなかったリーチは成立し、宣言料を供託に出す（宣言牌でロンされたら不成立で、宣言料は出さない）
//   ・和了者は供託（持ち越し分を含む）をすべて得る ／ 山切れ・24回の流局は次の局へ持ち越す
//   ・四家立直はその局の宣言料を宣言者へ返し、前の局からの持ち越しは残す ／ 試合終了時に残った供託は元の宣言者へ返す
export function applyRoundResult(m, result, { round = null, maxRound = null, riichi = null } = {}) {
  if (m.over) throw new Error('match is over');
  const dealer = dealerOf(m);
  const payments = settle(result, dealer);
  const deltas = payments.slice();
  const n = structuredClone(m);
  if (!n.pot) n.pot = [];
  const win = result && result.type === 'win';
  // リーチ宣言料：成立したリーチの席（宣言牌でロンされた宣言者は不成立）
  const D = m.riichiDeposit || 0;
  const declared = D && riichi ? [0, 1, 2, 3].filter((s) => riichi[s] && !(win && result.how === 'ron' && result.from === s && riichi[s].tile === result.tile)) : [];
  const potBefore = n.pot.reduce((a, e) => a + e.points, 0);
  for (const s of declared) {
    deltas[s] -= D;
    n.pot.push({ seat: s, label: handLabel(m), hand: m.hand, renchan: m.renchan, played: m.played, points: D });
  }
  let potWon = 0;
  const refunded = [0, 0, 0, 0]; // 四家立直の返還・試合終了時の返還
  if (win) {
    potWon = n.pot.reduce((a, e) => a + e.points, 0);
    deltas[result.winner] += potWon;
    n.pot = [];
  } else if (result && result.reason === 'four-riichi') {
    for (const e of n.pot.filter((e) => e.played === m.played)) { refunded[e.seat] += e.points; deltas[e.seat] += e.points; }
    n.pot = n.pot.filter((e) => e.played !== m.played);
  }
  for (let s = 0; s < 4; s++) n.scores[s] += deltas[s];
  if (win) {
    n.wins[result.winner]++;
    const gain = payments[result.winner];
    if (gain > n.best[result.winner]) { n.best[result.winner] = gain; n.bestBase[result.winner] = result.points; }
  }
  let dealerKeeps = win && result.winner === dealer && m.length !== 1;
  // アガリやめ：最終の親番（4局戦の東4局・8局戦の南4局）で親が和了し、精算後に単独1位
  const agariYame = !!(dealerKeeps && m.agariYame && m.hand === m.length - 1 && n.scores.every((x, s) => s === dealer || n.scores[dealer] > x));
  if (agariYame) dealerKeeps = false;
  const draw = result && result.reason ? { type: 'draw', reason: result.reason } : { type: 'draw' }; // 四家立直は reason を残す（山切れは従来の形）
  const entry = { label: handLabel(m), hand: m.hand, dealer, renchan: m.renchan, result: win ? { winner: result.winner, how: result.how, from: result.from ?? null, points: result.points } : draw, deltas, dealerKeeps };
  if (D) Object.assign(entry, { payments, riichi: declared, potBefore, potWon, potAfter: n.pot.reduce((a, e) => a + e.points, 0), refunded });
  if (agariYame) entry.agariYame = true;
  n.log.push(entry);
  n.played++;
  if (dealerKeeps) {
    n.renchan++;
    n.renchanTotal++;
  } else {
    n.hand++;
    n.renchan = 0;
    if (n.hand >= n.length) n.over = true;
  }
  if (n.over) n.endReason = agariYame ? 'agari-yame' : 'normal';
  else if (maxRound !== null && round !== null && round >= maxRound) { n.over = true; n.endReason = 'round-limit'; }
  // 試合終了：残った供託を元の宣言者へ返す
  if (n.over && n.pot.length) {
    const back = [0, 0, 0, 0];
    for (const e of n.pot) { back[e.seat] += e.points; n.scores[e.seat] += e.points; }
    entry.potReturned = back;
    n.pot = [];
  }
  return n;
}

// 供託の合計
export const potTotal = (m) => (m.pot || []).reduce((a, e) => a + e.points, 0);

// 順位（同点は同順位）。戻り値は席ごとの順位 [1..4]。例：[120, 100, 100, 80] → [1, 2, 2, 4]
export function ranks(scores) {
  return scores.map((x) => 1 + scores.filter((y) => y > x).length);
}

// 再現用：試合の途中の状態を作る（URL の hand・renchan・dealer 指定）。得点は開始時のまま。
// 供託は復元しない（再現 URL には持ち点・供託を含めない。開始時と同じ 0）。
export function matchAt({ length = 4, hand = 0, renchan = 0, startDealer = 0, riichiDeposit = 0, agariYame = false } = {}) {
  const m = createMatch({ length, startDealer, riichiDeposit, agariYame });
  m.hand = Math.max(0, Math.min(length - 1, hand));
  m.renchan = Math.max(0, renchan);
  return m;
}
