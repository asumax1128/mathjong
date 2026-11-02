// 牌譜の振り返り（第2段階・docs/76・docs/77）：検証済みの牌譜（private-full）から、各時点の「自分の視点」だけを作る純粋なモジュール。
// DOM・保存・AI・ゲーム本体の状態（app.js の S）は使わない。
//
// 情報の境界（docs/76「再生APIと安全の契約」）：
// ・private-full の記録は createReviewSession の閉包の中だけで持ち、外へは返さない（戻り値に記録・Game・牌の id を含めない）。
// ・各時点の表示用の値（frame）は、その時点の Game から「自分の手牌」と「全員の公開情報」だけを射影する：
//   河（牌の種類・ツモ切り・リーチ宣言牌）、公開面子（鳴き・暗カン）、各席の手牌の枚数、親、リーチ宣言、ドラ表示牌、
//   残り枚数・通常ツモ回数、持ち点・供託、公開された出来事（打牌・鳴き・暗カン・和了・流局）。
//   他家の手牌の中身・山の並び・王牌の未公開の牌・他家の待ち・フリテン・AI の判断の候補は含めない。
// ・他家の「見送り」や、まだ確定していない鳴き（後続のロンの判断を待つポン・チー）は、実際の対局でも見えないので、
//   独立した時点にしない。時点は「安定した点」（誰かの手番・自分の判断・局の終わり）だけで、他家の鳴き・ロンの判断待ちの
//   間に起きた出来事は次の安定した点へまとめる（他家が鳴けたかどうかで時点の数・区切り・表示が変わらない）。
// ・局の終わりの時点だけ、局の結果（和了者・和了の形・役・点数・精算）を加える。和了者以外の手牌は出さない。
// ・後の時点の情報を前の時点へ出さない：frame は、その時点までの行動を適用した Game だけから作る。
//
// 再生：記録された行動を、記録と同じ設定の独立した Game に順に適用し、各行動の後の digest を記録と照合する
// （読込時の検証 decode/verify に加えて、表示する状態が検証された状態と同じであることを確かめる）。
import { newRoundGame, stateDigest, paifuRules, PaifuError } from '../engine/paifu.js';
import { handLabel, potTotal, ranks } from '../engine/match.js';

const freeze = (x) => { if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const fail = (path, message) => { throw new PaifuError(path, message); };

// 保存設定を正とする：人間の席（現行の記録では席0。将来の記録でも設定から求める）
export function humanSeatOf(p) {
  const me = p.settings.players.findIndex((x) => x.kind === 'human');
  if (me < 0) fail('settings.players', 'no human seat');
  return me;
}

// 一覧の行（索引のメタデータだけ）：記録の本文を読まずに出せる項目
export function entryFromIndex(meta) {
  return freeze({ id: meta.id, savedAt: meta.savedAt, mode: meta.mode, length: meta.length, status: meta.status, rounds: meta.rounds });
}

// 一覧の詳細（検証済みの記録から公開してよい要約だけ）：相手の名前・開始日時・自分の順位と最終点（完走）・中断の理由
export function publicSummary(p) {
  const me = humanSeatOf(p);
  const f = p.final;
  return freeze({
    id: p.id, createdAt: p.createdAt, mode: p.settings.mode, length: p.settings.length, status: p.status,
    termination: p.termination ? p.termination.reason : null, rounds: p.rounds.length,
    lastSettled: p.rounds.length ? p.rounds.at(-1).settlement !== null : null,
    me, players: p.settings.players.map((x, seat) => ({ seat, name: x.name, human: seat === me })),
    final: f ? { scores: f.scores.slice(), ranks: f.ranks.slice(), myRank: f.ranks[me], myScore: f.scores[me], endReason: f.endReason, played: f.played } : null,
  });
}

// エンジンの入口（engine/paifu.js の検証と同じ分岐）
function perform(g, seat, a) {
  if (a.type === 'discard') g.discard(seat, a.tile, a.riichi ? { riichi: true } : undefined);
  else if (a.type === 'tsumo') g.tsumo(seat);
  else if (a.type === 'ankan') g.ankan(seat, a.tileType);
  else g.respond(seat, a);
}

// 公開された出来事（Game.events）の射影：牌の id ではなく種類だけ。ツモは席だけ（自分のツモの牌は手牌に出る）
function publicEvent(g, e) {
  const t = (id) => g.typeOf(id);
  switch (e.type) {
    case 'draw': return { type: 'draw', seat: e.seat };
    case 'discard': {
      const r = g.rivers[e.seat].find((x) => x.id === e.tile);
      return { type: 'discard', seat: e.seat, tile: t(e.tile), tsumogiri: r ? !!r.tsumogiri : null, riichi: !!(r && r.riichi) };
    }
    case 'riichi': return { type: 'riichi', seat: e.seat, tile: t(e.tile) };
    case 'chi': case 'pon': return { type: e.type, seat: e.seat, from: e.from, tile: t(e.tile), meld: e.meld };
    case 'ankan': return { type: 'ankan', seat: e.seat, tile: t(e.tiles[0]) };
    case 'rinshan': return { type: 'rinshan', seat: e.seat };
    case 'dora': return { type: 'dora', indicator: t(e.indicator) };
    case 'win': return { type: 'win', seat: e.seat, how: e.how, from: e.from ?? null };
    case 'exhaustive-draw': return { type: 'exhaustive-draw' };
    case 'abortive-draw': return { type: 'abortive-draw', reason: e.reason };
    default: return fail('events', `unknown event ${e.type}`);
  }
}

// その時点の自分の視点（Game を読むだけ。変更しない）
// ctx：{ me, matchBefore, deposit }。mine：直前の自分の行動（なければ null）。events：前の時点からの公開の出来事
function project(g, ctx, { index, mine = null, events = [] }) {
  const { me } = ctx;
  const p = g.pending();
  const view = g.viewFor(me); // 自分の手牌＋公開情報（AI に渡すのと同じ境界）
  const drawn = view.drawn !== null && view.drawn !== undefined && p && p.seat === me && p.type === 'turn' ? g.typeOf(view.drawn) : null;
  const handTypes = view.hand.map((x) => x.type).sort((a, b) => a - b);
  if (drawn !== null) handTypes.splice(handTypes.indexOf(drawn), 1); // ツモの牌は右に分けて出す
  // 現在の判断者：手番（公開）と自分の判断だけ。他家の鳴き・ロンの判断待ちは出さない（その席が鳴けることを示してしまう）
  let pending = null;
  if (p && p.type === 'turn') pending = { seat: p.seat, type: 'turn' };
  else if (p && p.seat === me) pending = { seat: me, type: 'claim', tile: g.typeOf(p.tile), from: p.from, ron: !!p.ron, chi: p.chi.length > 0, pon: !!p.pon };
  const D = ctx.deposit;
  const declared = g.riichi.map((x) => !!x);
  const scores = ctx.matchBefore.scores.map((s, seat) => s - (declared[seat] ? D : 0));
  const pot = potTotal(ctx.matchBefore) + declared.filter(Boolean).length * D;
  const furiten = g.furitenRule ? g.furitenOf(me) : null;
  return {
    index, mine, events,
    pending,
    hand: handTypes, drawn,
    handCounts: view.handCounts.slice(),
    melds: g.melds.map((ms) => ms.map((m) => ({ call: m.call, meld: m.meld, tiles: m.tiles.map((id) => g.typeOf(id)),
      claimed: m.claimed === null || m.claimed === undefined ? -1 : m.tiles.indexOf(m.claimed), from: m.from ?? null }))),
    rivers: g.rivers.map((r) => r.map((x) => ({ tile: g.typeOf(x.id), tsumogiri: !!x.tsumogiri, riichi: !!x.riichi }))),
    riichi: declared,
    dealer: g.dealer,
    wallCount: view.wallCount,
    dora: (view.doraIndicators || []).map((d) => ({ type: d.type, doraType: d.doraType })),
    normalDraws: view.normalDraws ? view.normalDraws.slice() : null,
    scores, pot,
    // 自分だけの情報（実際の対局でも自分には見える）：フリテンの理由・リーチの待ち
    self: { closed: g.isClosed(me), furiten: furiten ? furiten.reasons.slice() : [], waits: g.riichiWaits[me] ? g.riichiWaits[me].slice() : null },
    result: null,
  };
}

// 局の終わりの時点に加える結果（和了者の和了の形・役・点数、流局の理由、精算）。和了者以外の手牌は出さない
function roundResult(g, r, ctx) {
  const s = r.settlement;
  const out = { deltas: s.deltas.slice(), scoresAfter: s.matchAfter.scores.slice(), potAfter: potTotal(s.matchAfter),
    potBefore: potTotal(r.matchBefore), over: s.matchAfter.over, endReason: s.matchAfter.endReason,
    next: s.matchAfter.over ? null : { label: handLabel(s.matchAfter), renchan: s.matchAfter.renchan, dealer: (s.matchAfter.startDealer + s.matchAfter.hand) % 4 } };
  const log = s.matchAfter.log.at(-1);
  if (log && 'potWon' in log) Object.assign(out, { riichiPaid: log.riichi.slice(), potWon: log.potWon, refunded: log.refunded.slice(), potReturned: log.potReturned ? log.potReturned.slice() : null });
  if (log && log.agariYame) out.agariYame = true;
  const res = g.result;
  if (res.type === 'win') {
    const a = res.analysis;
    const w = res.winner;
    out.win = { winner: w, how: res.how, from: res.from ?? null, points: res.points, tile: g.typeOf(res.tile),
      yakuman: !!a.yakuman, kind: a.kind, special: a.special ?? null, yaku: a.yaku.map((y) => ({ name: y.name, points: y.points, yakuman: !!y.yakuman })),
      doraBonus: a.doraBonus || 0, riichi: !!a.riichi, riichiBonus: a.riichiBonus || 0, base: a.yakuman ? 0 : ctx.rules.config.scoring.base,
      melds: a.kind === 'special' ? [] : a.melds.slice(), exposed: a.kind === 'special' ? 0 : a.exposedMelds.length,
      hand: g.hands[w].map((id) => g.typeOf(id)).sort((x, y) => x - y) };
  } else {
    out.draw = { reason: res.reason ?? null, wallLeft: g.wall.length, math2Cap: g.newRules && ctx.rules.config.mode === 'math2' && g.wall.length > 0 };
  }
  return out;
}

// 1局ぶんの時点の列を作る（生成関数：途中で区切れる）。frame は凍結した値
function* roundFrames(p, ri, me) {
  const r = p.rounds[ri];
  const g = newRoundGame(p, r.round, r.dealer);
  if (stateDigest(g) !== r.startDigest) fail(`rounds.${ri}.startDigest`, 'mismatch');
  const ctx = { me, matchBefore: r.matchBefore, deposit: r.matchBefore.riichiDeposit || 0, rules: paifuRules(p.settings.mode) };
  const frames = [freeze(project(g, ctx, { index: 0 }))];
  let seen = g.events.length, mine = null;
  for (let i = 0; i < r.steps.length; i++) {
    const s = r.steps[i];
    const q = g.pending();
    if (!q || q.seat !== s.seat) fail(`rounds.${ri}.steps.${i}.seat`, 'not this seat\'s decision');
    perform(g, s.seat, s.action);
    if (g.events.length !== s.events || stateDigest(g) !== s.digest) fail(`rounds.${ri}.steps.${i}.digest`, 'mismatch');
    if (s.seat === me) mine = { type: s.action.type, source: s.source, riichi: !!s.action.riichi,
      tile: s.action.type === 'discard' ? g.typeOf(s.action.tile) : s.action.type === 'ankan' ? s.action.tileType : null };
    // 時点にするのは「安定した点」だけ：局の終わり・誰かの手番（公開）・自分の判断。他家の鳴き・ロンの判断待ちの間は
    // 時点を作らず、出来事を次の安定した点へまとめる（他家が鳴けたかどうかで時点の数・区切りが変わらないように）
    const p2 = g.pending();
    const stable = !p2 || p2.type === 'turn' || p2.seat === me;
    if (stable && (mine || g.events.length > seen)) {
      frames.push(freeze(project(g, ctx, { index: frames.length, mine, events: g.events.slice(seen).map((e) => publicEvent(g, e)) })));
      seen = g.events.length; mine = null;
    }
    if ((i + 1) % 16 === 0) yield;
  }
  // 記録が他家の判断待ちの途中で終わった（中断・記録途中）：その後ろの出来事は時点にしない（他家が鳴けたことを示さない）
  if (r.settlement !== null) {
    const last = frames.at(-1);
    frames[frames.length - 1] = freeze({ ...last, result: roundResult(g, r, ctx) });
  }
  return frames;
}

// 振り返りの窓口。p：読込時に検証済み（store.loadPrivate／decodePaifu）の記録。閉包の外へは記録を出さない。
export function createReviewSession(p, { cacheRounds = 3 } = {}) {
  const me = humanSeatOf(p);
  const info = freeze({
    ...publicSummary(p),
    roundList: p.rounds.map((r, i) => ({ index: i, label: handLabel(r.matchBefore), renchan: r.matchBefore.renchan, dealer: r.dealer,
      settled: r.settlement !== null })), // 行動の数は出さない（他家の見送りの数が分かってしまう）
  });
  const cache = new Map(); // 局 → frames（直近 cacheRounds 局だけ）
  const remember = (ri, frames) => { cache.delete(ri); cache.set(ri, frames); while (cache.size > cacheRounds) cache.delete(cache.keys().next().value); return frames; };
  const check = (ri) => { if (!Number.isSafeInteger(ri) || ri < 0 || ri >= p.rounds.length) fail('roundIndex', 'out of range'); };
  return Object.freeze({
    info,
    // 同期（テスト・小さい局）
    frames(ri) {
      check(ri);
      if (cache.has(ri)) return remember(ri, cache.get(ri));
      const gen = roundFrames(p, ri, me);
      let x = gen.next();
      while (!x.done) x = gen.next();
      return remember(ri, freeze(x.value));
    },
    // 非同期：budgetMs ごとにイベントループへ戻る。isCancelled() が真になったら null（古い画面へ描かない）
    async framesAsync(ri, { budgetMs = 8, pause = () => new Promise((r) => setTimeout(r, 0)), now = () => Date.now(), isCancelled = () => false } = {}) {
      check(ri);
      if (cache.has(ri)) return remember(ri, cache.get(ri));
      const gen = roundFrames(p, ri, me);
      let t0 = now();
      for (let x = gen.next(); ; x = gen.next()) {
        if (x.done) return isCancelled() ? null : remember(ri, freeze(x.value));
        if (now() - t0 >= budgetMs) { await pause(); if (isCancelled()) return null; t0 = now(); }
      }
    },
  });
}

// 表示用の補助：手番の席の呼び方（自分＝あなた）
export const SEAT_POS = ['自分', '下家', '対面', '上家'];
// 自分から見た相対の位置（自分の席が0でない記録にも対応）
export const relSeat = (seat, me) => (seat - me + 4) % 4;
export { ranks };
// テスト用（その時点の Game から自分の視点を作る。表示の境界の検証に使う）
export const projectForTest = (g, me, matchBefore, rulesMode) => project(g, { me, matchBefore, deposit: matchBefore.riichiDeposit || 0, rules: paifuRules(rulesMode) }, { index: 0 });
