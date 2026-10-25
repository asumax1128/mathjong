// 対局（試合）の進行（Ver.0.4-A）：4局戦（東1〜東4局）・8局戦（東1〜南4局）、親の連荘、親子の点数精算、順位。
// 1局の中身（配牌・和了判定・役・AI）は Game が担当し、ここは局と局の間だけを扱う純粋なロジック。
// 状態はコピーして返す（入力を変更しない）。tests/match.test.js で検証。

export const START_POINTS = 100;
export const MATCH_LENGTHS = [4, 8];
const WINDS = ['東', '南'];

// length: 4 | 8、startDealer: 東1局の親の席（既定 0）
export function createMatch({ length = 4, startDealer = 0 } = {}) {
  if (!MATCH_LENGTHS.includes(length)) throw new Error(`unknown match length ${length}`);
  return {
    length,
    startDealer,
    hand: 0, // 親番の通し番号（0 = 東1局、4 = 南1局）
    renchan: 0, // この親番での連荘回数（親が和了するたびに +1、親交代で 0）
    played: 0, // 実際に終えた局数（連荘を含む）
    renchanTotal: 0, // 試合全体の連荘回数
    scores: [START_POINTS, START_POINTS, START_POINTS, START_POINTS],
    wins: [0, 0, 0, 0], // 和了回数
    best: [0, 0, 0, 0], // 1回の和了で得た最高の点（精算後の増加分）
    bestBase: [0, 0, 0, 0], // その和了の基本点 B
    over: false,
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
// 最終の親番（4局戦の東4局・8局戦の南4局）が終わったら over。最終の親の連荘中は続く。
export function applyRoundResult(m, result) {
  if (m.over) throw new Error('match is over');
  const dealer = dealerOf(m);
  const deltas = settle(result, dealer);
  const n = structuredClone(m);
  for (let s = 0; s < 4; s++) n.scores[s] += deltas[s];
  const win = result && result.type === 'win';
  if (win) {
    n.wins[result.winner]++;
    const gain = deltas[result.winner];
    if (gain > n.best[result.winner]) { n.best[result.winner] = gain; n.bestBase[result.winner] = result.points; }
  }
  const dealerKeeps = win && result.winner === dealer;
  n.log.push({ label: handLabel(m), hand: m.hand, dealer, renchan: m.renchan, result: win ? { winner: result.winner, how: result.how, from: result.from ?? null, points: result.points } : { type: 'draw' }, deltas, dealerKeeps });
  n.played++;
  if (dealerKeeps) {
    n.renchan++;
    n.renchanTotal++;
  } else {
    n.hand++;
    n.renchan = 0;
    if (n.hand >= n.length) n.over = true;
  }
  return n;
}

// 順位（同点は同順位）。戻り値は席ごとの順位 [1..4]。例：[120, 100, 100, 80] → [1, 2, 2, 4]
export function ranks(scores) {
  return scores.map((x) => 1 + scores.filter((y) => y > x).length);
}

// 再現用：試合の途中の状態を作る（URL の hand・renchan・dealer 指定）。得点は開始時のまま。
export function matchAt({ length = 4, hand = 0, renchan = 0, startDealer = 0 } = {}) {
  const m = createMatch({ length, startDealer });
  m.hand = Math.max(0, Math.min(length - 1, hand));
  m.renchan = Math.max(0, renchan);
  return m;
}
