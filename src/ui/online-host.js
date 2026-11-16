// オンライン対戦：ホストの進行役（HostRunner・docs/79「2.4」「4」「8」）。Game と試合管理（match.js）を動かすのはホストだけ。
// ・CPU の席は既存の AI（decideCharacter）。人間の席は act で届いた行動を検証してから適用する（エンジンは変更しない）。
// ・宣言ウィンドウ：宣言できる人間全員に、打牌の直後の選択肢を同時に出して並列に集め、締めてからエンジンの順番
//   （近い席から・ロン＞ポン＞チー・アタマハネ・後続ロンによるチーの取消し）で respond() に流す。
//   集めた応答がその時点で成立しない（より近い席のポンでポン・チーが消えた）ときは見送りに直す。
//   ただし、その席にロンが残っていれば、その席にだけ再質問の窓（ロンする／見送る・15秒・時間切れは見送り）を開く。
// ・制限時間：手番45秒（時間切れはツモ切り）・宣言15秒（見送り）・局の結果20秒（全員の「次へ」かホストの操作で早める）。
//   判定はホストの時計（clock）だけで行う。時間切れの連続回数を席ごとに数える。
// ・段階3（docs/79「8」）：
//   - 離席（away）：切断（session が presence を見て10秒）・時間切れ3回連続・本人の「部屋を出る」で離席にし、中級の既定キャラクターが
//     代打ちする（代打ち用の乱数は CPU の乱数と別。CPU の判断は変わらない）。本人の「戻る」・再接続で離席を解き、連続回数を0に戻す。
//   - 行動の記録（onLog）：適用した行動を順に外へ出す（session が host/log に保存）。ホストの再読み込みでは restore(記録) で
//     局の初めから再生して同じ局面に戻る。CPU の手は decideCharacter をもう一度呼んで同じ乱数を消費し、記録と一致することを確かめる。
//   - 再戦の受付：最終結果の後、人間の「もう一戦」（act の ready）を集める（rematch）。部屋をロビーへ戻すのは session・画面の側。
// ・io：publish(pub, privBySeat)。clock：{ now, setTimeout, clearTimeout }（試験では偽の時計）。
import { Game } from '../engine/game.js';
import { applyAction } from '../engine/ai.js';
import { decideCharacter, newPublicHistory, recordPublicRound, rosterForLevel } from '../engine/characters.js';
import { matchInfo } from '../engine/ai-levels.js';
import { createRng } from '../engine/rng.js';
import { createMatch, applyRoundResult, dealerOf, handLabel, RIICHI_DEPOSIT } from '../engine/match.js';
import { MAX_ROUND } from './params.js';
import { LIMITS, PROTOCOL, publicGameState, privateState, actionOf } from './online-protocol.js';

export const RULESET = 2;
export const AWAY_AFTER_TIMEOUTS = 3;
// 代打ちの AI：中級の既定キャラクター（U7）
export const PROXY_ID = rosterForLevel('intermediate')[0].id;
const realClock = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id) };
const actionKey = (a) => JSON.stringify(a ? [a.type, a.tile ?? null, a.option ?? null, !!a.riichi, a.tileType ?? null] : null);
const plain = (a) => { const x = { type: a.type }; for (const k of ['tile', 'option', 'riichi', 'tileType']) if (a[k] !== undefined) x[k] = a[k]; return x; };

// seats：ゲームの席0〜3（絶対）の { kind:'human'|'cpu', name, cpuId }。
// onLog(entry)：行動を1つ適用するたびに { r: 局の通し番号, s: 席, a: 行動, src } を渡す（再生の中では呼ばない）
// onAway(seat, away, reason)：離席の状態が変わったとき
export function createHostRunner({ rules, mode, length, seats, seedBase, startDealer = 0, publish, clock = realClock, limits = LIMITS, cpuDelay = { turn: 0 }, presetWalls = null, makeGame = null, onLog = null, onAway = null }) {
  // makeGame：試験だけで使う（局面を組み立てた Game を差し込む）。通常は seed から作る
  const human = (s) => seats[s].kind === 'human';
  const seatIds = seats.map((x) => (x.kind === 'cpu' ? x.cpuId : 'human'));
  const st = {
    match: createMatch({ length, startDealer, riichiDeposit: RIICHI_DEPOSIT, agariYame: true }),
    round: 1, game: null, aiRng: null, proxyRng: null, publicHistory: newPublicHistory(),
    seq: 0, sid: 0, phase: 'play', window: null, timer: null,
    timeouts: [0, 0, 0, 0], notices: [null, null, null, null], away: [false, false, false, false],
    prevScores: null, lastRound: null, history: [], stopped: false, replaying: false,
    claimKey: null, responses: new Map(), reasked: new Set(), ready: new Set(), rematch: new Set(),
    stats: { reask: 0, overridden: 0, proxy: 0, replayed: 0, replayMismatch: 0 },
    log: [], // 適用した行動の記録：{ r, s, a, src }
  };
  const queue = [];
  let draining = false;
  // 席が今どう判断するか：'cpu'（CPU）・'proxy'（離席中の人間の代打ち）・'human'
  const actor = (s) => (!human(s) ? 'cpu' : st.away[s] ? 'proxy' : 'human');
  const activeHumans = () => [0, 1, 2, 3].filter((s) => actor(s) === 'human');

  function record(s, a, src) {
    const e = { r: st.round, s, a: plain(a), src };
    st.log.push(e);
    if (!st.replaying && onLog) onLog(e, st.log.length - 1);
  }

  function newGame() {
    const seed = seedBase + st.round * 7919;
    const dealer = dealerOf(st.match);
    const presetWall = presetWalls ? presetWalls(st.round) : null;
    const params = { rules, seed, dealer, players: seats.map((x) => ({ name: x.name, kind: x.kind === 'cpu' ? 'ai' : 'human' })), round: st.round, ruleset: RULESET, ...(presetWall ? { presetWall } : {}) };
    st.game = makeGame ? makeGame(params) : new Game(params);
    st.aiRng = createRng(seed ^ 0x5bd1e995);
    st.proxyRng = [0, 1, 2, 3].map((s) => createRng((seed ^ 0x2c1b3c6d ^ (s * 0x9e3779b9)) >>> 0));
    st.phase = 'play';
    st.claimKey = null;
    st.notices = [null, null, null, null];
  }
  function startRound() { newGame(); advance(); }

  const info = () => ({ ...matchInfo(st.match), publicHistory: st.publicHistory });
  function cpuDecide(seat) { return decideCharacter(st.game, seat, seats[seat].cpuId, st.aiRng, info(), seatIds); }
  function aiAct(seat) {
    const g = st.game;
    if (actor(seat) === 'cpu') {
      const action = cpuDecide(seat);
      applyAction(g, seat, action);
      record(seat, action, 'cpu');
      return;
    }
    // 代打ち（中級の既定キャラクター・専用の乱数）
    const action = decideCharacter(g, seat, PROXY_ID, st.proxyRng[seat], info(), seatIds);
    applyAction(g, seat, action);
    st.stats.proxy++;
    record(seat, action, 'proxy');
  }

  // 次の判断まで進める。人間の判断・CPU の待ち時間・局の終わりで止まる
  function advance() {
    clearTimer();
    st.window = null;
    for (;;) {
      if (st.stopped) return;
      const g = st.game;
      const p = g.pending();
      if (!p) return finishRound();
      if (p.type === 'claim') return openClaim();
      if (actor(p.seat) !== 'human') {
        if (cpuDelay.turn > 0) {
          st.sid++;
          st.window = { kind: 'cpu', seats: [], seat: p.seat, deadline: null, sid: st.sid };
          publishAll();
          const sid = st.sid;
          st.timer = clock.setTimeout(() => { st.timer = null; if (st.stopped || !st.window || st.window.sid !== sid) return; aiAct(p.seat); advance(); }, cpuDelay.turn);
          return;
        }
        aiAct(p.seat);
        continue;
      }
      return openWindow('turn', [p.seat], limits.turnMs);
    }
  }

  function openWindow(kind, seatList, ms) {
    st.sid++;
    st.window = { kind, seats: seatList.slice(), deadline: ms === null ? null : clock.now() + ms, sid: st.sid };
    publishAll();
    const sid = st.sid;
    clearTimer();
    if (ms !== null) st.timer = clock.setTimeout(() => { st.timer = null; onTimeout(sid); }, ms);
  }
  function clearTimer() { if (st.timer !== null) { clock.clearTimeout(st.timer); st.timer = null; } }

  // 宣言ウィンドウ：打牌ごとに1回だけ開く（claimKey＝その打牌の記録の位置）。離席中の人間には出さない（締めるときに代打ち）
  function openClaim() {
    const g = st.game;
    const key = `${st.round}:${g.events.length}`;
    if (st.claimKey !== key) {
      st.claimKey = key;
      st.responses = new Map();
      st.reasked = new Set();
      st.claimOffer = new Map();
      for (const c of g.claim.queue) if (actor(c.seat) === 'human') st.claimOffer.set(c.seat, { ron: c.ron, chi: c.chi, pon: c.pon });
      if (st.claimOffer.size) return openWindow('claim', [...st.claimOffer.keys()], limits.claimMs);
    }
    return applyClaims();
  }

  const validClaim = (r, p) => (r.type === 'pass') || (r.type === 'ron' && p.ron) || (r.type === 'pon' && !!p.pon)
    || (r.type === 'chi' && Array.isArray(p.chi) && !!p.chi[r.option]);

  // 集めた応答をエンジンの順番で流す
  function applyClaims() {
    const g = st.game;
    const before = g.events.length;
    for (;;) {
      const p = g.pending();
      if (!p || p.type !== 'claim') break;
      if (actor(p.seat) !== 'human' && !st.responses.has(p.seat)) { aiAct(p.seat); continue; }
      const r = st.responses.get(p.seat) || { type: 'pass', src: 'timeout' };
      if (validClaim(r, p)) { applyAction(g, p.seat, plain(r)); record(p.seat, r, r.src || 'human'); continue; }
      // 選んだポン・チーが他家の優先で成立しない
      st.notices[p.seat] = 'overridden';
      st.stats.overridden++;
      if (p.ron && !st.reasked.has(p.seat) && actor(p.seat) === 'human') {
        st.reasked.add(p.seat);
        st.responses.delete(p.seat);
        st.reaskSeat = p.seat;
        st.stats.reask++;
        return openWindow('reask', [p.seat], limits.claimMs);
      }
      applyAction(g, p.seat, { type: 'pass' });
      record(p.seat, { type: 'pass' }, 'overridden');
    }
    // 選んだ鳴きが成立しなかった席（エンジンが問い直さずに飛ばした席を含む）へ知らせる
    const done = g.events.slice(before);
    for (const [seat, r] of st.responses) {
      if ((r.type === 'pon' || r.type === 'chi') && !done.some((e) => (e.type === 'pon' || e.type === 'chi') && e.seat === seat)) st.notices[seat] = 'overridden';
    }
    st.reaskSeat = null;
    return advance();
  }

  // 局の精算（状態だけ）。窓を開くのは finishRound
  function settleRound() {
    const g = st.game;
    st.publicHistory = recordPublicRound(st.publicHistory, g.events, g.riichi);
    st.prevScores = st.match.scores.slice();
    st.lastRound = { label: handLabel(st.match), renchan: st.match.renchan, dealer: dealerOf(st.match) };
    st.match = applyRoundResult(st.match, g.result, { round: st.round, maxRound: MAX_ROUND, riichi: g.riichi });
    st.history.push({ round: st.round, result: g.result.type === 'win' ? { ...g.result, analysis: undefined } : g.result });
    st.phase = 'result';
    st.ready = new Set();
  }
  function finishRound() {
    clearTimer();
    settleRound();
    openWindow('next', activeHumans(), limits.nextMs);
  }

  function nextRound() {
    clearTimer();
    if (st.match.over) {
      st.phase = 'final';
      st.rematch = new Set();
      // 最終結果：もう一戦の受付（締切なし。ホストが部屋をロビーへ戻すときに、押した人だけが残る）
      openWindow('rematch', seats.map((_, s) => s).filter(human), null);
      return;
    }
    st.round++;
    startRound();
  }

  function timeoutOf(seat) {
    st.timeouts[seat]++;
    st.notices[seat] = 'timeout';
  }
  function onTimeout(sid) {
    if (st.stopped || !st.window || st.window.sid !== sid) return;
    const w = st.window;
    const g = st.game;
    if (w.kind === 'turn') {
      const seat = w.seats[0];
      timeoutOf(seat);
      const tile = g.drawn !== null && g.drawn !== undefined ? g.drawn : g.hands[seat][g.hands[seat].length - 1];
      applyAction(g, seat, { type: 'discard', tile });
      record(seat, { type: 'discard', tile }, 'timeout');
      if (st.timeouts[seat] >= AWAY_AFTER_TIMEOUTS) markAway(seat, 'timeouts');
      return advance();
    }
    if (w.kind === 'claim' || w.kind === 'reask') {
      const late = [];
      for (const seat of w.seats) {
        if (!st.responses.has(seat)) { timeoutOf(seat); st.responses.set(seat, { type: 'pass', src: 'timeout' }); late.push(seat); }
      }
      for (const seat of late) if (st.timeouts[seat] >= AWAY_AFTER_TIMEOUTS) markAway(seat, 'timeouts');
      return applyClaims();
    }
    if (w.kind === 'next') return nextRound();
  }

  // ---- 離席（away）と復帰（back） ----
  function markAway(seat, reason) {
    if (!human(seat) || st.away[seat]) return;
    st.away[seat] = true;
    st.notices[seat] = 'away';
    if (onAway && !st.replaying) onAway(seat, true, reason);
  }
  // 窓の途中で離席になった席：手番なら代打ちがすぐ打つ。宣言・再質問はその席を待たない（締めるときに代打ち）。次局の待ちからも外す
  function setAway(seat, away, reason = 'request') {
    if (!human(seat) || st.stopped) return false;
    if (!away) {
      if (!st.away[seat] && st.timeouts[seat] === 0) return false;
      st.away[seat] = false;
      st.timeouts[seat] = 0;
      st.notices[seat] = null;
      if (onAway) onAway(seat, false, reason);
      if (st.window) { st.seq++; publishAll(); }
      return true;
    }
    if (st.away[seat]) return false;
    markAway(seat, reason);
    const w = st.window;
    if (!w) return true;
    if (w.kind === 'turn' && w.seats[0] === seat) { advance(); return true; }
    if ((w.kind === 'claim' || w.kind === 'reask') && w.seats.includes(seat)) {
      w.seats = w.seats.filter((s) => s !== seat);
      if (w.seats.every((s) => st.responses.has(s))) { clearTimer(); applyClaims(); return true; }
    }
    if (w.kind === 'next' && w.seats.includes(seat)) {
      w.seats = w.seats.filter((s) => s !== seat);
      if (w.seats.length && w.seats.every((s) => st.ready.has(s))) { nextRound(); return true; }
    }
    st.seq++;
    publishAll();
    return true;
  }

  // ---- 人間の行動（act）：検証してから適用。古い局面への応答（sid の違い）・窓の外の行動は捨てる ----
  function receive(seat, act, { host = false } = {}) {
    queue.push({ seat, act, host });
    if (!draining) { draining = true; Promise.resolve().then(drain); }
  }
  function drain() {
    while (queue.length) { const x = queue.shift(); try { handle(x.seat, x.act, x.host); } catch (e) { st.lastError = String(e && e.message); } }
    draining = false;
  }
  // 試験用：待たずにすぐ処理
  function receiveNow(seat, act, opts = {}) { return handle(seat, act, !!opts.host); }

  function handle(seat, act, isHost) {
    if (st.stopped || !act) return 'no-window';
    // 離席・復帰は局面によらない（本人の「部屋を出る」「対局に戻る」）
    if (act.k === 'away') return setAway(seat, true, 'leave') ? 'ok' : 'noop';
    if (act.k === 'back') return setAway(seat, false, 'back') ? 'ok' : 'noop';
    if (!st.window) return 'no-window';
    const w = st.window;
    if (act.sid !== w.sid) return 'stale';
    if (w.kind === 'rematch') {
      if (act.k !== 'ready' || !human(seat)) return 'bad';
      st.rematch.add(seat);
      st.seq++;
      publishAll();
      return 'ok';
    }
    if (!w.seats.includes(seat)) return 'not-yours';
    if (w.kind === 'next') {
      if (act.k !== 'ready') return 'bad';
      st.ready.add(seat);
      if (isHost || w.seats.every((s) => st.ready.has(s))) return nextRound(), 'ok';
      st.seq++;
      publishAll();
      return 'ok';
    }
    const action = actionOf(act);
    if (!action || action.type === 'ready') return 'bad';
    const g = st.game;
    if (w.kind === 'turn') {
      if (!['discard', 'tsumo', 'ankan'].includes(action.type)) return 'bad';
      try { applyAction(g, seat, action); } catch {
        st.notices[seat] = 'rejected'; st.seq++; publishAll(); return 'rejected';
      }
      st.timeouts[seat] = 0;
      st.notices[seat] = null;
      record(seat, action, 'human');
      advance();
      return 'ok';
    }
    // 宣言・再質問：締めるまで集めるだけ（適用は applyClaims）
    if (!['ron', 'pon', 'chi', 'pass'].includes(action.type)) return 'bad';
    if (st.responses.has(seat)) return 'dup';
    if (w.kind === 'reask' && !['ron', 'pass'].includes(action.type)) return 'bad';
    const offer = w.kind === 'reask' ? { ron: true, chi: [], pon: null } : st.claimOffer.get(seat);
    if (!validClaim(action, offer)) return 'bad';
    st.responses.set(seat, action);
    st.timeouts[seat] = 0;
    if (w.seats.every((s) => st.responses.has(s))) { clearTimer(); applyClaims(); return 'ok'; }
    st.seq++;
    publishAll();
    return 'ok';
  }

  // ---- 再生（ホストの再読み込みからの復帰・docs/79「8.3」）----
  // entries：onLog で保存した記録（順番どおり）。base：{ sid, seq }（前の配信の番号。古い act を新しい窓と取り違えないよう、その先から続ける）、
  // away：席ごとの離席（seats に保存した値）。CPU の手は decideCharacter をもう一度呼び、記録と一致するかを数える（不一致なら記録を採る）
  function restore(entries, { sid = 0, seq = 0, away = null } = {}) {
    st.replaying = true;
    st.sid = sid;
    st.seq = seq;
    let i = 0;
    newGame();
    for (let guard = 0; guard < 100000; guard++) {
      const g = st.game;
      const p = g.pending();
      if (!p) {
        settleRound();
        // 記録が次の局へ続いていれば、次の局から（試合が終わっていれば最終へ）
        if (i < entries.length && entries[i].r > st.round && !st.match.over) { st.round++; newGame(); continue; }
        break;
      }
      const e = entries[i];
      if (!e) break;
      if (e.s !== p.seat || e.r !== st.round) { st.stats.replayMismatch++; break; }
      if (actor(p.seat) === 'cpu') {
        const mine = cpuDecide(p.seat);
        if (actionKey(plain(mine)) !== actionKey(e.a)) st.stats.replayMismatch++;
      }
      applyAction(g, p.seat, e.a);
      st.log.push({ ...e });
      st.stats.replayed++;
      // 連続の時間切れを記録から数え直す
      if (human(p.seat)) {
        if (e.src === 'timeout') st.timeouts[p.seat]++;
        else if (e.src === 'human') st.timeouts[p.seat] = 0;
      }
      i++;
    }
    if (away) for (let s = 0; s < 4; s++) st.away[s] = human(s) && !!away[s];
    st.replaying = false;
    if (!st.game.pending()) {
      // 局の終わりで止まっていた：結果の待ち（試合が終わっていれば、次へで最終結果）
      clearTimer();
      openWindow('next', activeHumans(), limits.nextMs);
    } else advance();
    return { replayed: st.stats.replayed, mismatch: st.stats.replayMismatch, rest: entries.length - i };
  }

  // ---- 配信 ----
  function pendingFor(seat) {
    const w = st.window;
    if (!w || !w.seats.includes(seat) || st.phase !== 'play') return null;
    const g = st.game;
    if (w.kind === 'turn') { const p = g.pending(); return { type: 'turn', canTsumo: p.canTsumo, ankan: p.ankan || [] }; }
    if (st.responses.has(seat)) return null; // 応答済み
    if (w.kind === 'claim') { const o = st.claimOffer.get(seat); return { type: 'claim', tile: g.claim.tile, from: g.claim.from, ron: o.ron, chi: o.chi, pon: o.pon }; }
    if (w.kind === 'reask') return { type: 'claim', tile: g.claim.tile, from: g.claim.from, ron: true, chi: [], pon: null, reask: true };
    return null;
  }
  function snapshot() {
    const w = st.window;
    return {
      v: PROTOCOL, seq: st.seq, sid: st.sid, phase: st.phase, round: st.round, mode, length,
      players: seats.map((x, s) => ({ name: x.name, kind: x.kind, ...(x.cpuId ? { cpuId: x.cpuId } : {}), ...(st.away[s] ? { away: true } : {}) })),
      match: st.match, prevScores: st.prevScores, lastRound: st.lastRound,
      game: publicGameState(st.game),
      // 窓の種類と締切（誰が判断しているかは手番のときだけ公開。宣言の窓は誰に選択肢があるかを出さない）
      window: w ? {
        kind: w.kind, deadline: w.deadline,
        ...(w.kind === 'turn' ? { seat: w.seats[0] } : w.kind === 'cpu' ? { seat: w.seat } : {}),
        ...(w.kind === 'next' ? { ready: [...st.ready] } : {}),
        ...(w.kind === 'rematch' ? { ready: [...st.rematch] } : {}),
      } : null,
      timeouts: st.timeouts.slice(),
    };
  }
  function publishAll() {
    if (st.replaying) return;
    st.seq++;
    const pub = snapshot();
    const privs = {};
    for (let s = 0; s < 4; s++) {
      if (!human(s)) continue;
      privs[s] = privateState(st.game, s, { pending: pendingFor(s), sid: st.sid, deadline: st.window ? st.window.deadline : null, notice: st.notices[s] });
    }
    publish(pub, privs);
  }

  return {
    start() { startRound(); },
    restore,
    receive, receiveNow,
    setAway: (seat, away, reason) => setAway(seat, away, reason),
    stop() { st.stopped = true; clearTimer(); },
    get state() { return st; },
    snapshot,
  };
}
