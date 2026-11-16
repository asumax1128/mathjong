// オンライン対戦：進行役（online-host.js）・ゲストと Transport のつなぎ（docs/79「6」「8」）。
// ・ホスト：publish で pub/state と各人間席の priv/$seat を1回のまとめ書き（update）で書く。同じ書き込みで、新しい行動の記録を
//   host/log へ足す（ホストの再読み込みからの再生用。host はホストだけが読める）。ゲストの act/$seat を購読して進行役へ渡す。
//   ホスト自身の席は通信を通さず、配信値をそのまま手元の画面へ渡し、操作も直接進行役へ渡す。
// ・段階3：
//   - ゲストの presence が10秒続けて切れていたら、その席を離席（代打ち）にし、seats/$seat/away に書く。つながり直したら戻す。
//   - ホストの切断：onDisconnect で meta.status を paused（pausedAt＝サーバー時刻）にする。ゲストはそれを見て「ホストの復帰を待っています」。
//     ホストが戻ったら（restore で再生してから）playing に戻す。
//   - act の古い記録（前の試合・切断の前）は、購読の最初の値を「既読」にして渡さない。sid も前の配信の続きから数える。
// ・ゲスト：pub/state と自分の priv/$seat を購読し、操作は act/$seat への追記だけ。
import { createHostRunner } from './online-host.js';
import { wrap, unwrap, actOf } from './online-protocol.js';

const room = (code, p = '') => `rooms/${code}${p ? `/${p}` : ''}`;
let keySeq = 0;
const actKey = (t) => `${Math.floor(t.now()).toString(36)}-${(++keySeq).toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
const logKey = (i) => `e${String(i).padStart(6, '0')}`;
export const AWAY_AFTER_MS = 10000; // 切断から離席（代打ち）までの時間
export const HOST_GRACE_MS = 90000; // ホストの復帰の猶予（U3）
const realClock = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id) };

// ホストの復帰の待ち：meta.status が paused なら { deadline, expired }。それ以外は null
export function hostWaitState(meta, now, graceMs = HOST_GRACE_MS) {
  if (!meta || meta.status !== 'paused') return null;
  const deadline = (typeof meta.pausedAt === 'number' ? meta.pausedAt : now) + graceMs;
  return { deadline, expired: now > deadline };
}

// seats：ゲームの席の並び（{ kind, name, cpuId, uid, away }）。mySeat：ホストの席。onView(pub, priv)：ホストの画面へ
// restore：{ entries, sid, seq, away }（ホストの再読み込みからの復帰。loadResume の戻り値）
export function createHostSession(t, code, { rules, mode, length, seats, seedBase, startDealer, mySeat, onView, clock = realClock, limits, cpuDelay, onError, presetWalls, restore = null, awayMs = AWAY_AFTER_MS }) {
  let last = null;
  let pendingLog = [];
  let stopped = false;
  const fail = (e) => { if (onError) onError(e); };
  const runner = createHostRunner({
    rules, mode, length, seats, seedBase, startDealer, clock, limits, cpuDelay, presetWalls,
    onLog: (e, i) => pendingLog.push([i, e]),
    onAway: (seat, away) => { if (!stopped) Promise.resolve(t.update(room(code), { [`seats/${seat}/away`]: away ? true : null })).catch(fail); },
    publish(pub, privs) {
      last = { pub, priv: privs[mySeat] || null };
      if (stopped) return;
      const upd = { 'pub/state': wrap(pub.seq, pub) };
      for (const [s, p] of Object.entries(privs)) if (Number(s) !== mySeat) upd[`priv/${s}`] = wrap(pub.seq, p);
      for (const [i, e] of pendingLog) upd[`host/log/${logKey(i)}`] = JSON.stringify(e);
      pendingLog = [];
      Promise.resolve(t.update(room(code), upd)).catch(fail);
      if (onView) onView(pub, last.priv);
    },
  });
  const seen = new Set();
  const uns = [];
  // ゲストの行動：購読の最初の値は前の試合・切断の前の記録なので既読にする
  for (let s = 0; s < 4; s++) {
    if (s === mySeat || seats[s].kind !== 'human') continue;
    let primed = false;
    uns.push(t.onValue(room(code, `act/${s}`), (v) => {
      const keys = v ? Object.keys(v).sort() : [];
      if (!primed) { primed = true; for (const k of keys) seen.add(`${s}/${k}`); return; }
      for (const k of keys) {
        const id = `${s}/${k}`;
        if (seen.has(id)) continue;
        seen.add(id);
        runner.receive(s, v[k]);
      }
    }));
  }
  // ゲストの接続：10秒続けて切れていたら離席（代打ち）。つながり直したら戻す
  const offTimers = [null, null, null, null];
  const wasOnline = [null, null, null, null];
  function watchPresence(presence) {
    for (let s = 0; s < 4; s++) {
      if (s === mySeat || seats[s].kind !== 'human' || !seats[s].uid) continue;
      const p = presence && presence[seats[s].uid];
      const online = !!(p && p.online);
      if (online) {
        if (offTimers[s] !== null) { clock.clearTimeout(offTimers[s]); offTimers[s] = null; }
        if (wasOnline[s] === false && runner.state.away[s]) runner.setAway(s, false, 'reconnect');
      } else if (offTimers[s] === null && !runner.state.away[s]) {
        offTimers[s] = clock.setTimeout(() => { offTimers[s] = null; if (!stopped) runner.setAway(s, true, 'disconnect'); }, awayMs);
      }
      wasOnline[s] = online;
    }
  }
  return {
    runner,
    async start() {
      // ホストの切断に備える：切れたら一時停止（pausedAt はサーバー時刻）。戻ったら playing
      try {
        await t.onDisconnectUpdate(room(code, 'meta'), { status: 'paused', pausedAt: t.TS });
        await t.update(room(code, 'meta'), { status: 'playing', pausedAt: null });
      } catch (e) { fail(e); }
      if (stopped) return;
      if (restore) runner.restore(restore.entries, restore);
      else runner.start();
      uns.push(t.onValue(room(code, 'presence'), (v) => { if (!stopped) watchPresence(v); }));
      // 見張り：古い接続の切断が遅れて届き paused になっても、動いているホストが playing に戻す
      uns.push(t.onValue(room(code, 'meta/status'), (v) => { if (!stopped && v === 'paused') Promise.resolve(t.update(room(code, 'meta'), { status: 'playing', pausedAt: null })).catch(fail); }));
    },
    send(action) { const sid = last ? last.pub.sid : 0; runner.receive(mySeat, actOf(action, sid, Math.floor(t.now())), { host: true }); },
    get last() { return last; },
    async stop({ keepPause = false } = {}) {
      stopped = true;
      runner.stop();
      uns.forEach((u) => u());
      offTimers.forEach((x) => { if (x !== null) clock.clearTimeout(x); });
      if (!keepPause) { try { await t.cancelOnDisconnect(room(code, 'meta')); } catch { /* 閉じるだけ */ } }
    },
  };
}

// ホストの再読み込みからの復帰に要るもの：席・seedBase・最初の親・行動の記録・前の配信の番号・離席
export async function loadResume(t, code) {
  const [meta, seatsObj, secret, pubW] = await Promise.all([t.get(room(code, 'meta')), t.get(room(code, 'seats')), t.get(room(code, 'host')), t.get(room(code, 'pub/state'))]);
  if (!meta || !secret || !seatsObj) return null;
  const seats = [0, 1, 2, 3].map((i) => {
    const x = seatsObj[i] || {};
    return x.kind === 'cpu' ? { kind: 'cpu', name: x.name, cpuId: x.cpuId } : { kind: 'human', name: x.name, uid: x.uid, ...(x.away ? { away: true } : {}) };
  });
  const log = secret.log || {};
  const entries = Object.keys(log).sort().map((k) => JSON.parse(log[k]));
  const pub = unwrap(pubW);
  return {
    meta, seats, seedBase: secret.seedBase, startDealer: secret.startDealer, entries,
    sid: pub ? pub.sid : 0, seq: pub ? pub.seq : 0, away: seats.map((x) => !!x.away), lastPub: pub,
  };
}

// onView(pub, priv)：配信を受けるたび（pub と priv の両方が揃ってから。priv は pub と同じ seq 以上のものを使う）
export function createGuestSession(t, code, mySeat, { onView }) {
  let pub = null;
  let priv = null;
  // 自分の手牌（priv）が届くまでは描かない（他家と同じ「枚数だけ」の手牌にならないように）。sid が違う priv は選択肢を出さない
  const emit = () => { if (pub && priv) onView(pub, priv.sid === pub.sid ? priv : { ...priv, pending: null }); };
  const uns = [
    t.onValue(room(code, 'pub/state'), (v) => { const x = unwrap(v); if (x && (!pub || x.seq >= pub.seq || x.sid > pub.sid)) { pub = x; emit(); } }),
    t.onValue(room(code, `priv/${mySeat}`), (v) => { const x = unwrap(v); if (x) { priv = x; emit(); } }),
  ];
  return {
    send(action) {
      const sid = pub ? pub.sid : 0;
      return t.set(room(code, `act/${mySeat}/${actKey(t)}`), actOf(action, sid, Math.floor(t.now())));
    },
    get pub() { return pub; },
    get priv() { return priv; },
    stop() { uns.forEach((u) => u()); },
  };
}
