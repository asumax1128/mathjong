// オンライン対戦 段階2（docs/79「2.5」「6」「7.2」）：配信する状態の形と、ゲスト側の表示用モデル RemoteTable。
// ・pub（公開状態）と priv/$seat（その席の非公開）は、ホストが「絶対の席番号」で作る。
//   RTDB は空の配列・null を保存しないので、中身は JSON 文字列で包む（{ seq, s }）。
// ・ゲストは自分の席を0に回して読み替え、Game と同じ読み取り口を持つ RemoteTable を作る（既存の描画をそのまま使う）。
//   他家の手牌は枚数だけ（中身は -1）。山の並び・seed・他家の選択肢は配信しない。局の終わりには全員の手牌を公開する（局の結果の表示用）。
// エンジン（src/engine）は変更しない。RemoteTable は Game.prototype を使い、自分の手牌から求まる読み取り（聴牌・リーチ候補・フリテン）は
// エンジンと同じ計算をその場で行う。判断の選択肢（pending）は priv の値を使う。
import { Game } from '../engine/game.js';

export const PROTOCOL = 1;
export const LIMITS = Object.freeze({ turnMs: 45000, claimMs: 15000, nextMs: 20000 });
export const ACT_KINDS = Object.freeze(['discard', 'tsumo', 'ankan', 'ron', 'pon', 'chi', 'pass', 'ready']);

export const wrap = (seq, obj) => ({ seq, s: JSON.stringify(obj) });
export const unwrap = (w) => (w && typeof w.s === 'string' ? JSON.parse(w.s) : null);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ---- ホスト側：公開・非公開の射影 ----
export function publicGameState(g) {
  return {
    dealer: g.dealer, round: g.round, current: g.current, phase: g.phase,
    handCounts: g.hands.map((h) => h.length),
    melds: clone(g.melds), rivers: clone(g.rivers), riichi: clone(g.riichi), events: clone(g.events),
    wallCount: g.wall.length, normalDraws: g.normalDraws.slice(), turnCount: g.turnCount,
    dora: g.deadWall ? clone(g.deadWall.indicators) : [],
    claim: g.phase === 'claim' && g.claim ? { tile: g.claim.tile, from: g.claim.from } : null,
    result: g.result ? clone(g.result) : null,
    // 局の終わり：全員の手牌を公開（結果画面の「全員の手牌を見る」用。局の途中では出さない）
    revealed: g.phase === 'ended' ? g.hands.map((h) => h.slice()) : null,
  };
}

// その席の本人だけが読む情報。pending：その席がいま判断する選択肢（窓が開いているときだけ）
export function privateState(g, seat, { pending = null, sid = 0, deadline = null, notice = null } = {}) {
  const mine = g.phase === 'turn' && g.current === seat;
  return {
    seat, hand: g.hands[seat].slice(),
    drawn: mine ? (g.drawn ?? null) : null, justDrew: mine ? !!g.justDrew : false,
    riichiWaits: g.riichiWaits ? clone(g.riichiWaits[seat]) : null,
    tempFuriten: g.tempFuriten ? !!g.tempFuriten[seat] : false,
    riichiFuriten: g.riichiFuriten ? !!g.riichiFuriten[seat] : false,
    discarded: g.discarded ? [...g.discarded[seat]] : [],
    ronBlocked: g.ronBlocked ? clone(g.ronBlocked[seat]) : null,
    pending, sid, deadline, notice,
  };
}

// 画面からの行動（ai.js の applyAction の形）⇔ act の記録
export function actOf(action, sid, at) {
  const a = { k: action.type, sid, at };
  if (action.tile !== undefined) a.tile = action.tile;
  if (action.riichi) a.riichi = true;
  if (action.option !== undefined) a.option = action.option;
  if (action.tileType !== undefined) a.tileType = action.tileType;
  return a;
}
export function actionOf(a) {
  if (!a || !ACT_KINDS.includes(a.k)) return null;
  const x = { type: a.k };
  if (a.k === 'discard') { if (!Number.isInteger(a.tile)) return null; x.tile = a.tile; if (a.riichi === true) x.riichi = true; }
  if (a.k === 'chi') { if (!Number.isInteger(a.option)) return null; x.option = a.option; }
  if (a.k === 'ankan') { if (!Number.isInteger(a.tileType)) return null; x.tileType = a.tileType; }
  return x;
}

// ---- ゲスト側：席の回転と RemoteTable ----
export const rotOf = (me) => (s) => (s === null || s === undefined || s < 0 ? s : (s - me + 4) % 4);
const permOf = (me) => (arr) => [0, 1, 2, 3].map((l) => arr[(l + me) % 4]);

function rotEvent(e, rot) {
  const o = { ...e };
  if ('seat' in o) o.seat = rot(o.seat);
  if ('from' in o) o.from = rot(o.from);
  return o;
}

// pub：unwrap 済みの公開状態。priv：その席の非公開（null 可）。me：自分の絶対席。
// 戻り値は Game と同じ読み取り口を持つ（自分が席0）。sent：応答を送った後（次の配信まで選択肢を出さない）
export function buildRemoteTable(rules, pub, priv, me, { sent = false } = {}) {
  const gs = pub.game;
  const rot = rotOf(me);
  const perm = permOf(me);
  const t = Object.create(Game.prototype);
  const ruleset = 2;
  const tileType = [];
  for (const ty of rules.types) for (let c = 0; c < ty.copies; c++) tileType.push(ty.idx);
  const handsAbs = [0, 1, 2, 3].map((s) => {
    if (gs.revealed) return gs.revealed[s].slice();
    if (s === me && priv) return priv.hand.slice();
    return new Array(gs.handCounts[s]).fill(-1);
  });
  const result = gs.result ? { ...gs.result, winner: rot(gs.result.winner), from: rot(gs.result.from ?? null) } : null;
  if (result && gs.result.from === undefined) delete result.from;
  Object.assign(t, {
    rules, ruleset, newRules: true, furitenRule: true, funcPonBan: true, fourRiichiRule: true,
    tsumoIppatsuRule: true, round2YakuRule: true, // ホストの Game（ruleset 2・既定）と同じ。ゲスト側の待ち・役ヒントの判定に使う
    seed: 0, dealer: rot(gs.dealer), round: gs.round,
    players: perm(pub.players || [{}, {}, {}, {}]),
    tileType,
    wall: new Array(gs.wallCount).fill(-1),
    hands: perm(handsAbs),
    melds: perm(gs.melds).map((ms) => ms.map((m) => ({ ...m, from: m.from === null || m.from === undefined ? m.from : rot(m.from) }))),
    rivers: perm(gs.rivers),
    events: gs.events.map((e) => rotEvent(e, rot)),
    result,
    turnCount: gs.turnCount,
    riichi: perm(gs.riichi),
    _riichiMemo: null,
    riichiWaits: [priv ? priv.riichiWaits : null, null, null, null],
    discarded: [new Set(priv ? priv.discarded : []), new Set(), new Set(), new Set()],
    tempFuriten: [!!(priv && priv.tempFuriten), false, false, false],
    riichiFuriten: [!!(priv && priv.riichiFuriten), false, false, false],
    ronBlocked: [priv && priv.ronBlocked ? { ...priv.ronBlocked, from: rot(priv.ronBlocked.from) } : null, null, null, null],
    current: rot(gs.current), phase: gs.phase,
    claim: gs.claim ? { tile: gs.claim.tile, from: rot(gs.claim.from) } : null,
    drawn: priv ? priv.drawn : null, justDrew: priv ? !!priv.justDrew : false,
    normalDraws: perm(gs.normalDraws),
    deadWall: { indicators: gs.dora || [], rinshan: [] },
    online: { me, sid: pub.sid, seq: pub.seq, sent },
  });
  // 判断の選択肢：自分の窓が開いていて、まだ応答していないときだけ priv の値。それ以外は「待っている」表示用の値
  const mineOpen = !!(priv && priv.pending && priv.sid === pub.sid && !sent);
  const myPending = mineOpen ? { ...priv.pending, seat: 0, ...(priv.pending.from !== undefined ? { from: rot(priv.pending.from) } : {}) } : null;
  t.pending = function pending() {
    if (this.phase === 'ended') return null;
    if (myPending) return myPending;
    const waitText = sent ? '送信しました…' : null;
    if (this.phase === 'turn') {
      if (this.current === 0) return { seat: -1, type: 'turn', canTsumo: false, ankan: [], waitText: waitText || 'あなたの番を準備しています…' };
      return { seat: this.current, type: 'turn', canTsumo: false, ankan: [], ...(waitText ? { waitText } : {}) };
    }
    return { seat: -1, type: 'claim', tile: this.claim ? this.claim.tile : null, from: this.claim ? this.claim.from : null, ron: false, chi: [], pon: null, waitText: waitText || '宣言を待っています…' };
  };
  return t;
}

// 公開状態の match（絶対席）を、自分を席0にした表示用へ。scores・wins・best・log の席を回す
export function rotateMatch(m, me) {
  if (!m) return m;
  const perm = permOf(me);
  const rot = rotOf(me);
  const n = clone(m);
  for (const k of ['scores', 'wins', 'best', 'bestBase']) if (Array.isArray(n[k])) n[k] = perm(n[k]);
  n.startDealer = rot(n.startDealer);
  n.pot = (n.pot || []).map((e) => ({ ...e, seat: rot(e.seat) }));
  n.log = (n.log || []).map((e) => {
    const o = { ...e, dealer: rot(e.dealer), deltas: perm(e.deltas) };
    if (e.result && e.result.winner !== undefined) o.result = { ...e.result, winner: rot(e.result.winner), from: rot(e.result.from) };
    for (const k of ['payments', 'refunded', 'potReturned']) if (Array.isArray(e[k])) o[k] = perm(e[k]);
    if (Array.isArray(e.riichi)) o.riichi = e.riichi.map(rot);
    return o;
  });
  return n;
}
