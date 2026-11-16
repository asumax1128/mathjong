// オンライン対戦 段階2：ホストの進行役（HostRunner・docs/79「2.4」「4」）。Game と試合管理（match.js）を動かすのはホストだけ。
// ・CPU の席は既存の AI（decideCharacter）。人間の席は act で届いた行動を検証してから適用する（エンジンは変更しない）。
// ・宣言ウィンドウ：宣言できる人間全員に、打牌の直後の選択肢を同時に出して並列に集め、締めてからエンジンの順番
//   （近い席から・ロン＞ポン＞チー・アタマハネ・後続ロンによるチーの取消し）で respond() に流す。
//   集めた応答がその時点で成立しない（より近い席のポンでポン・チーが消えた）ときは見送りに直す。
//   ただし、その席にロンが残っていれば、その席にだけ再質問の窓（ロンする／見送る・15秒・時間切れは見送り）を開く。
// ・制限時間：手番45秒（時間切れはツモ切り）・宣言15秒（見送り）・局の結果20秒（全員の「次へ」かホストの操作で早める）。
//   判定はホストの時計（clock）だけで行う。時間切れの連続回数を席ごとに数える（離席・代打ちへの接続は段階3）。
// ・io：publish(pub, privBySeat)。clock：{ now, setTimeout, clearTimeout }（試験では偽の時計）。
import { Game } from '../engine/game.js';
import { applyAction } from '../engine/ai.js';
import { decideCharacter, newPublicHistory, recordPublicRound } from '../engine/characters.js';
import { matchInfo } from '../engine/ai-levels.js';
import { createRng } from '../engine/rng.js';
import { createMatch, applyRoundResult, dealerOf, handLabel, RIICHI_DEPOSIT } from '../engine/match.js';
import { MAX_ROUND } from './params.js';
import { LIMITS, PROTOCOL, publicGameState, privateState, actionOf } from './online-protocol.js';

export const RULESET = 2;
const realClock = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id) };

// seats：ゲームの席0〜3（絶対）の { kind:'human'|'cpu', name, cpuId }。
export function createHostRunner({ rules, mode, length, seats, seedBase, startDealer = 0, publish, clock = realClock, limits = LIMITS, cpuDelay = { turn: 0 }, presetWalls = null, makeGame = null }) {
  // makeGame：試験だけで使う（局面を組み立てた Game を差し込む）。通常は seed から作る
  const human = (s) => seats[s].kind === 'human';
  const seatIds = seats.map((x) => (x.kind === 'cpu' ? x.cpuId : 'human'));
  const st = {
    match: createMatch({ length, startDealer, riichiDeposit: RIICHI_DEPOSIT, agariYame: true }),
    round: 1, game: null, aiRng: null, publicHistory: newPublicHistory(),
    seq: 0, sid: 0, phase: 'play', window: null, timer: null,
    timeouts: [0, 0, 0, 0], notices: [null, null, null, null],
    prevScores: null, lastRound: null, history: [], stopped: false,
    claimKey: null, responses: new Map(), reasked: new Set(),
    stats: { reask: 0, overridden: 0 },
    log: [], // 適用した行動の記録（試験・段階3の復帰用）：{ round, seat, action, src }
  };
  const queue = [];
  let draining = false;

  function startRound() {
    const seed = seedBase + st.round * 7919;
    const dealer = dealerOf(st.match);
    const presetWall = presetWalls ? presetWalls(st.round) : null;
    const params = { rules, seed, dealer, players: seats.map((x) => ({ name: x.name, kind: x.kind === 'cpu' ? 'ai' : 'human' })), round: st.round, ruleset: RULESET, ...(presetWall ? { presetWall } : {}) };
    st.game = makeGame ? makeGame(params) : new Game(params);
    st.aiRng = createRng(seed ^ 0x5bd1e995);
    st.phase = 'play';
    st.claimKey = null;
    st.notices = [null, null, null, null];
    advance();
  }

  function cpuAct(seat) {
    const g = st.game;
    const action = decideCharacter(g, seat, seats[seat].cpuId, st.aiRng, { ...matchInfo(st.match), publicHistory: st.publicHistory }, seatIds);
    applyAction(g, seat, action);
    st.log.push({ round: st.round, seat, action, src: 'cpu' });
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
      if (!human(p.seat)) {
        if (cpuDelay.turn > 0) {
          st.sid++;
          st.window = { kind: 'cpu', seats: [], deadline: null };
          publishAll();
          st.timer = clock.setTimeout(() => { st.timer = null; if (st.stopped) return; cpuAct(p.seat); advance(); }, cpuDelay.turn);
          return;
        }
        cpuAct(p.seat);
        continue;
      }
      return openWindow('turn', [p.seat], limits.turnMs);
    }
  }

  function openWindow(kind, seatList, ms) {
    st.sid++;
    st.window = { kind, seats: seatList.slice(), deadline: clock.now() + ms, sid: st.sid };
    publishAll();
    const sid = st.sid;
    clearTimer();
    st.timer = clock.setTimeout(() => { st.timer = null; onTimeout(sid); }, ms);
  }
  function clearTimer() { if (st.timer !== null) { clock.clearTimeout(st.timer); st.timer = null; } }

  // 宣言ウィンドウ：打牌ごとに1回だけ開く（claimKey＝その打牌の記録の位置）
  function openClaim() {
    const g = st.game;
    const key = `${st.round}:${g.events.length}`;
    if (st.claimKey !== key) {
      st.claimKey = key;
      st.responses = new Map();
      st.reasked = new Set();
      st.claimOffer = new Map();
      for (const c of g.claim.queue) if (human(c.seat)) st.claimOffer.set(c.seat, { ron: c.ron, chi: c.chi, pon: c.pon });
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
      if (!human(p.seat)) { cpuAct(p.seat); continue; }
      const r = st.responses.get(p.seat) || { type: 'pass' };
      if (validClaim(r, p)) { applyAction(g, p.seat, { ...r, src: undefined }); st.log.push({ round: st.round, seat: p.seat, action: r, src: r.src || 'human' }); continue; }
      // 選んだポン・チーが他家の優先で成立しない
      st.notices[p.seat] = 'overridden';
      st.stats.overridden++;
      if (p.ron && !st.reasked.has(p.seat)) {
        st.reasked.add(p.seat);
        st.responses.delete(p.seat);
        st.reaskSeat = p.seat;
        st.stats.reask++;
        return openWindow('reask', [p.seat], limits.claimMs);
      }
      applyAction(g, p.seat, { type: 'pass' });
      st.log.push({ round: st.round, seat: p.seat, action: { type: 'pass' }, src: 'overridden' });
    }
    // 選んだ鳴きが成立しなかった席（エンジンが問い直さずに飛ばした席を含む）へ知らせる
    const done = g.events.slice(before);
    for (const [seat, r] of st.responses) {
      if ((r.type === 'pon' || r.type === 'chi') && !done.some((e) => (e.type === 'pon' || e.type === 'chi') && e.seat === seat)) st.notices[seat] = 'overridden';
    }
    st.reaskSeat = null;
    return advance();
  }

  function finishRound() {
    clearTimer();
    const g = st.game;
    st.publicHistory = recordPublicRound(st.publicHistory, g.events, g.riichi);
    st.prevScores = st.match.scores.slice();
    st.lastRound = { label: handLabel(st.match), renchan: st.match.renchan, dealer: dealerOf(st.match) };
    st.match = applyRoundResult(st.match, g.result, { round: st.round, maxRound: MAX_ROUND, riichi: g.riichi });
    st.history.push({ round: st.round, result: g.result.type === 'win' ? { ...g.result, analysis: undefined } : g.result });
    st.phase = 'result';
    st.ready = new Set();
    openWindow('next', seats.map((_, s) => s).filter(human), limits.nextMs);
  }

  function nextRound() {
    clearTimer();
    if (st.match.over) {
      st.phase = 'final';
      st.window = null;
      st.sid++;
      publishAll();
      return;
    }
    st.round++;
    startRound();
  }

  function onTimeout(sid) {
    if (st.stopped || !st.window || st.window.sid !== sid) return;
    const w = st.window;
    const g = st.game;
    if (w.kind === 'turn') {
      const seat = w.seats[0];
      st.timeouts[seat]++;
      st.notices[seat] = 'timeout';
      const tile = g.drawn !== null && g.drawn !== undefined ? g.drawn : g.hands[seat][g.hands[seat].length - 1];
      applyAction(g, seat, { type: 'discard', tile });
      st.log.push({ round: st.round, seat, action: { type: 'discard', tile }, src: 'timeout' });
      return advance();
    }
    if (w.kind === 'claim' || w.kind === 'reask') {
      for (const seat of w.seats) {
        if (!st.responses.has(seat)) { st.timeouts[seat]++; st.notices[seat] = 'timeout'; st.responses.set(seat, { type: 'pass', src: 'timeout' }); }
      }
      return applyClaims();
    }
    if (w.kind === 'next') return nextRound();
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
  function receiveNow(seat, act, opts = {}) { handle(seat, act, !!opts.host); }

  function handle(seat, act, isHost) {
    if (st.stopped || !st.window) return 'no-window';
    const w = st.window;
    if (act.sid !== w.sid) return 'stale';
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
      st.log.push({ round: st.round, seat, action, src: 'human' });
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
      players: seats.map((x) => ({ name: x.name, kind: x.kind, ...(x.cpuId ? { cpuId: x.cpuId } : {}) })),
      match: st.match, prevScores: st.prevScores, lastRound: st.lastRound,
      game: publicGameState(st.game),
      // 窓の種類と締切（誰が判断しているかは手番のときだけ公開。宣言の窓は誰に選択肢があるかを出さない）
      window: w ? { kind: w.kind, deadline: w.deadline, ...(w.kind === 'turn' || w.kind === 'cpu' ? { seat: w.kind === 'turn' ? w.seats[0] : null } : {}), ...(w.kind === 'next' ? { ready: [...st.ready] } : {}) } : null,
      timeouts: st.timeouts.slice(),
    };
  }
  function publishAll() {
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
    receive, receiveNow,
    stop() { st.stopped = true; clearTimer(); },
    get state() { return st; },
    snapshot,
  };
}
